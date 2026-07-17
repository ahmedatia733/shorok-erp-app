import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateSalesRepresentativeSchema,
  SalesRepresentativeQuerySchema,
  SalesRepresentativeStatementQuerySchema,
  UpdateSalesRepresentativeSchema,
  type CreateSalesRepresentative,
  type SalesRepresentativeQuery,
  type SalesRepresentativeStatementQuery,
  type UpdateSalesRepresentative,
} from "@shorok/shared";
import { Prisma } from "@prisma/client";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DuplicateRepresentativeCodeError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SalesRepresentativesService } from "./sales-representatives.service";

type RepRow = {
  id: string; code: string; nameAr: string; nameEn: string | null; phone: string | null;
  address: string | null; notes: string | null; active: boolean; createdAt: Date; updatedAt: Date;
};

@Controller("sales-representatives")
export class SalesRepresentativesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reps: SalesRepresentativesService,
  ) {}

  private format(r: RepRow) {
    return {
      id: r.id, code: r.code, nameAr: r.nameAr, nameEn: r.nameEn ?? null, phone: r.phone ?? null,
      address: r.address ?? null, notes: r.notes ?? null, active: r.active,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  @Get()
  async list(@Query(new ZodValidationPipe(SalesRepresentativeQuerySchema)) query: SalesRepresentativeQuery) {
    const search = query.search?.trim();
    const reps = await this.prisma.salesRepresentative.findMany({
      where: {
        ...(query.status === "active" ? { active: true } : query.status === "inactive" ? { active: false } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { nameAr: { contains: search, mode: "insensitive" } },
                { nameEn: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { code: "asc" },
    });
    return reps.map((r) => this.format(r));
  }

  @Get(":id")
  async getOne(@Param("id") id: string) {
    const rep = await this.reps.require(id);
    // Summary cards for the details page — draft vs confirmed counts and totals.
    const grouped = await this.prisma.salesInvoice.groupBy({
      by: ["status"], where: { salesRepresentativeId: id }, _count: { _all: true }, _sum: { grandTotal: true },
    });
    const draftCount = grouped.filter((g) => g.status === "DRAFT").reduce((a, g) => a + g._count._all, 0);
    const confirmedCount = grouped
      .filter((g) => g.status === "CONFIRMED" || g.status === "PAID")
      .reduce((a, g) => a + g._count._all, 0);
    const confirmedSalesTotal = grouped
      .filter((g) => g.status === "CONFIRMED" || g.status === "PAID")
      .reduce((a, g) => a.add(g._sum.grandTotal ?? 0), new Prisma.Decimal(0));

    return {
      ...this.format(rep),
      summary: {
        draftInvoiceCount: draftCount,
        confirmedInvoiceCount: confirmedCount,
        confirmedSalesTotal: confirmedSalesTotal.toFixed(2),
      },
    };
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateSalesRepresentativeSchema)) body: CreateSalesRepresentative,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const explicitCode = body.code?.trim();
    // Retry once on a code race when auto-generating; surface a typed error when
    // the user supplied a duplicate code.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.runInTransaction(async (tx) => {
          const code = explicitCode || (await this.reps.nextCode(tx));
          const rep = await tx.salesRepresentative.create({
            data: {
              code,
              nameAr: body.nameAr,
              nameEn: body.nameEn ?? null,
              phone: body.phone ?? null,
              address: body.address ?? null,
              notes: body.notes ?? null,
              ...(body.active !== undefined ? { active: body.active } : {}),
            },
          });
          await this.audit.write({
            tx, actorId: user.id, action: "CREATE",
            entityType: "sales_representative", entityId: rep.id,
            afterSnapshot: { code: rep.code, nameAr: rep.nameAr },
            summaryAr: `${user.name} أنشأ المندوب «${rep.nameAr}» برقم ${rep.code}`,
            summaryEn: `${user.name} created sales representative "${rep.nameAr}" code ${rep.code}`,
          });
          return this.format(rep);
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          if (explicitCode) throw new DuplicateRepresentativeCodeError({ code: explicitCode });
          if (attempt < 3) continue; // auto-gen race — recompute and retry
          throw new DuplicateRepresentativeCodeError();
        }
        throw e;
      }
    }
  }

  @Patch(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSalesRepresentativeSchema)) body: UpdateSalesRepresentative,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const before = await this.reps.require(id);
    return this.prisma.runInTransaction(async (tx) => {
      const after = await tx.salesRepresentative.update({
        where: { id },
        data: {
          ...(body.nameAr !== undefined ? { nameAr: body.nameAr } : {}),
          ...(body.nameEn !== undefined ? { nameEn: body.nameEn } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });
      const activeChanged = body.active !== undefined && body.active !== before.active;
      await this.audit.write({
        tx, actorId: user.id, action: "UPDATE",
        entityType: "sales_representative", entityId: id,
        beforeSnapshot: { nameAr: before.nameAr, active: before.active },
        afterSnapshot: { nameAr: after.nameAr, active: after.active },
        summaryAr: activeChanged
          ? `${user.name} ${after.active ? "فعّل" : "أوقف"} المندوب «${after.nameAr}»`
          : `${user.name} حدّث بيانات المندوب «${after.nameAr}»`,
        summaryEn: activeChanged
          ? `${user.name} ${after.active ? "reactivated" : "deactivated"} sales representative "${after.nameAr}"`
          : `${user.name} updated sales representative "${after.nameAr}"`,
      });
      return this.format(after);
    });
  }

  @Get(":id/statement")
  @Roles("OWNER", "ACCOUNTANT")
  async statement(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(SalesRepresentativeStatementQuerySchema)) query: SalesRepresentativeStatementQuery,
  ) {
    return this.reps.buildStatement(id, query);
  }
}
