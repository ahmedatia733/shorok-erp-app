import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import {
  CreateUserRequestSchema,
  PasswordResetRequestSchema,
  UpdateUserRequestSchema,
  type CreateUserRequest,
  type PasswordResetRequest,
  type UpdateUserRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ConflictError, ForbiddenError, NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { normalizePhoneE164 } from "../auth/phone-normalize";
import { PrismaService } from "../../prisma/prisma.service";

const BCRYPT_COST = 12;

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  branchAccesses: { select: { branchId: true } },
} as const;

function shapeUser(user: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  branchAccesses: { branchId: string }[];
}) {
  const { branchAccesses, ...rest } = user;
  return { ...rest, allowedBranches: branchAccesses.map((b) => b.branchId) };
}

@Controller("users")
@Roles("OWNER")
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const users = await this.prisma.user.findMany({
      select: PUBLIC_FIELDS,
      orderBy: { createdAt: "desc" },
    });
    return users.map(shapeUser);
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!user) throw new NotFoundError({ id });
    return shapeUser(user);
  }

  @Post()
  async create(
    @Body(new ZodValidationPipe(CreateUserRequestSchema)) body: CreateUserRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const phone = normalizePhoneE164(body.phone);
    if (!phone) throw new ConflictError("errors.validation_failed", { field: "phone" });

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) throw new ConflictError("errors.conflict", { field: "phone" });

    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);

    return this.prisma.runInTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: body.name,
          phone,
          email: body.email ?? null,
          passwordHash,
          role: body.role,
          status: "ACTIVE",
          branchAccesses: {
            create: body.allowedBranches.map((branchId) => ({ branchId })),
          },
        },
        select: PUBLIC_FIELDS,
      });
      await this.audit.write({
        tx,
        actorId: actor.id,
        action: "CREATE",
        entityType: "user",
        entityId: user.id,
        afterSnapshot: shapeUser(user),
        summaryAr: `أنشأ المالك المستخدم «${user.name}» بدور ${user.role}.`,
        summaryEn: `Owner created user "${user.name}" with role ${user.role}.`,
      });
      return shapeUser(user);
    });
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (id === actor.id && body.role && body.role !== actor.role) {
      throw new ForbiddenError({ reason: "cannot_change_own_role" });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
      if (!before) throw new NotFoundError({ id });

      const phone = body.phone ? normalizePhoneE164(body.phone) : undefined;
      if (body.phone && !phone) {
        throw new ConflictError("errors.validation_failed", { field: "phone" });
      }

      const after = await tx.user.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(phone ? { phone } : {}),
          ...(body.email !== undefined ? { email: body.email ?? null } : {}),
          ...(body.role ? { role: body.role } : {}),
          ...(body.allowedBranches
            ? {
                branchAccesses: {
                  deleteMany: {},
                  create: body.allowedBranches.map((branchId) => ({ branchId })),
                },
              }
            : {}),
        },
        select: PUBLIC_FIELDS,
      });

      await this.audit.write({
        tx,
        actorId: actor.id,
        action: "UPDATE",
        entityType: "user",
        entityId: id,
        beforeSnapshot: shapeUser(before),
        afterSnapshot: shapeUser(after),
        summaryAr: `حدّث المالك بيانات المستخدم «${after.name}».`,
        summaryEn: `Owner updated user "${after.name}".`,
      });
      return shapeUser(after);
    });
  }

  @Post(":id/disable")
  @HttpCode(204)
  async disable(@Param("id") id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.toggle(id, "DISABLED", actor);
  }

  @Post(":id/enable")
  @HttpCode(204)
  async enable(@Param("id") id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.toggle(id, "ACTIVE", actor);
  }

  @Post(":id/password-reset")
  @HttpCode(204)
  async passwordReset(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PasswordResetRequestSchema)) body: PasswordResetRequest,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
    await this.prisma.runInTransaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      await tx.user.update({ where: { id }, data: { passwordHash } });
      // Revoke all refresh tokens so the user is signed out everywhere.
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.write({
        tx,
        actorId: actor.id,
        action: "UPDATE",
        entityType: "user",
        entityId: id,
        summaryAr: `أعاد المالك ضبط كلمة مرور المستخدم «${before.name}».`,
        summaryEn: `Owner reset password for user "${before.name}".`,
      });
    });
  }

  private async toggle(
    id: string,
    status: "ACTIVE" | "DISABLED",
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      await tx.user.update({ where: { id }, data: { status } });
      if (status === "DISABLED") {
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.write({
        tx,
        actorId: actor.id,
        action: "UPDATE",
        entityType: "user",
        entityId: id,
        beforeSnapshot: { status: before.status },
        afterSnapshot: { status },
        summaryAr:
          status === "ACTIVE"
            ? `فعّل المالك المستخدم «${before.name}».`
            : `أوقف المالك المستخدم «${before.name}».`,
        summaryEn:
          status === "ACTIVE"
            ? `Owner enabled user "${before.name}".`
            : `Owner disabled user "${before.name}".`,
      });
    });
  }
}
