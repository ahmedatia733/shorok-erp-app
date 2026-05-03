import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  CreateBranchRequestSchema,
  UpdateBranchRequestSchema,
  type CreateBranchRequest,
  type UpdateBranchRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("branches")
export class BranchesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.prisma.branch.findMany({ orderBy: { nameEn: "asc" } });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundError({ id });
    return branch;
  }

  @Post()
  @Roles("OWNER")
  async create(
    @Body(new ZodValidationPipe(CreateBranchRequestSchema)) body: CreateBranchRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const branch = await tx.branch.create({
        data: { nameAr: body.nameAr, nameEn: body.nameEn, location: body.location ?? null },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "branch",
        entityId: branch.id,
        afterSnapshot: branch,
        summaryAr: `أنشأ المستخدم ${user.name} الفرع «${branch.nameAr}».`,
        summaryEn: `${user.name} created branch "${branch.nameEn}".`,
      });
      return branch;
    });
  }

  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateBranchRequestSchema)) body: UpdateBranchRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.branch.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      const after = await tx.branch.update({
        where: { id },
        data: {
          ...(body.nameAr !== undefined ? { nameAr: body.nameAr } : {}),
          ...(body.nameEn !== undefined ? { nameEn: body.nameEn } : {}),
          ...(body.location !== undefined ? { location: body.location } : {}),
        },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "branch",
        entityId: id,
        beforeSnapshot: before,
        afterSnapshot: after,
        summaryAr: `حدّث المستخدم ${user.name} الفرع «${after.nameAr}».`,
        summaryEn: `${user.name} updated branch "${after.nameEn}".`,
      });
      return after;
    });
  }

  @Post(":id/deactivate")
  @HttpCode(204)
  @Roles("OWNER")
  async deactivate(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.prisma.runInTransaction(async (tx) => {
      const before = await tx.branch.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      await tx.branch.update({ where: { id }, data: { active: false } });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "branch",
        entityId: id,
        beforeSnapshot: { active: before.active },
        afterSnapshot: { active: false },
        summaryAr: `أوقف المستخدم ${user.name} الفرع «${before.nameAr}».`,
        summaryEn: `${user.name} deactivated branch "${before.nameEn}".`,
      });
    });
  }
}
