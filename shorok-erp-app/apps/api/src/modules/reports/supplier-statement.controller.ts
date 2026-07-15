import { Controller, Get, Param, Query } from "@nestjs/common";
import { StatementQuerySchema, type StatementQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import { PrismaService } from "../../prisma/prisma.service";
import { StatementService } from "../accounting-statements/statement.service";

/**
 * GET /reports/supplier-statement/:id?from=&to=
 *
 * Supplier statement derived from the General Ledger only — AP_CONTROL journal
 * lines with partyType=SUPPLIER, partyId=:id. Credit increases the payable
 * (purchase invoice), debit reduces it (payment); reversals show as the real
 * opposite movement. Never reads factory_ledger / legacy payments. A supplier
 * with no movements returns 200 with an empty statement.
 */
@Controller("reports")
export class SupplierStatementController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: StatementService,
  ) {}

  @Get("supplier-statement/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async statement(
    @Param("id") supplierId: string,
    @Query(new ZodValidationPipe(StatementQuerySchema)) query: StatementQuery,
  ) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundError({ reason: "supplier_not_found", supplierId });

    const result = await this.statements.compute(
      { account: { systemRole: "AP_CONTROL" }, partyType: "SUPPLIER", partyId: supplierId },
      "CREDIT",
      query.from,
      query.to,
    );

    return {
      supplier: { id: supplier.id, nameAr: supplier.nameAr, nameEn: supplier.nameEn },
      openingBalance: result.openingBalance,
      periodDebit: result.periodDebit,
      periodCredit: result.periodCredit,
      endingBalance: result.endingBalance,
      rows: result.rows,
      // backward-compatible aliases
      totalPurchases: result.periodCredit,
      totalPaid: result.periodDebit,
      closingBalance: result.endingBalance,
    };
  }
}
