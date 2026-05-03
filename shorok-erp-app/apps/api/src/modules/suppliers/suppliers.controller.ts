import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import {
  CreateSupplierRequestSchema,
  UpdateSupplierRequestSchema,
  type CreateSupplierRequest,
  type UpdateSupplierRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";

@Controller("suppliers")
export class SuppliersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.prisma.supplier.findMany({ orderBy: { nameEn: "asc" } });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundError({ id });
    return supplier;
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateSupplierRequestSchema)) body: CreateSupplierRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const supplier = await tx.supplier.create({ data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "supplier",
        entityId: supplier.id,
        afterSnapshot: supplier,
        summaryAr: `أنشأ ${user.name} المورد «${supplier.nameAr}».`,
        summaryEn: `${user.name} created supplier "${supplier.nameEn}".`,
      });
      return supplier;
    });
  }

  @Patch(":id")
  @Roles("OWNER")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSupplierRequestSchema)) body: UpdateSupplierRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.supplier.findUnique({ where: { id } });
      if (!before) throw new NotFoundError({ id });
      const after = await tx.supplier.update({ where: { id }, data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "supplier",
        entityId: id,
        beforeSnapshot: before,
        afterSnapshot: after,
        summaryAr: `حدّث ${user.name} بيانات المورد «${after.nameAr}».`,
        summaryEn: `${user.name} updated supplier "${after.nameEn}".`,
      });
      return after;
    });
  }
}
