import { Controller, Get, Query } from "@nestjs/common";
import {
  ACCOUNT_CATEGORIES,
  ConsolidatedStatementQuerySchema,
  type ConsolidatedStatementQuery,
} from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../prisma/prisma.service";
import { ConsolidatedStatementService } from "./consolidated-statement.service";

/**
 * Unified Account Statement API.
 *
 * Read-only and GL-derived. The negative-treasury guard deliberately lives in
 * the posting flows (PostingEngine), not here — reading a statement must never
 * be able to block or warn.
 */
@Controller("statements")
export class StatementsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consolidated: ConsolidatedStatementService,
  ) {}

  /**
   * Everything the two-stage selector needs: the shared category list plus the
   * active leaf accounts and the parties that can be selected within them.
   */
  @Get("options")
  @Roles("OWNER", "ACCOUNTANT")
  async options() {
    const [accounts, customers, suppliers] = await Promise.all([
      this.prisma.account.findMany({
        where: { isLeaf: true, active: true },
        select: {
          id: true, code: true, nameAr: true, nameEn: true, category: true, accountType: true,
          systemRole: true, isCashOrBank: true, treasuryType: true, isLeaf: true, active: true, parentId: true,
        },
        orderBy: { code: "asc" },
      }),
      this.prisma.customer.findMany({
        where: { active: true },
        select: { id: true, code: true, nameAr: true },
        orderBy: { code: "asc" },
      }),
      this.prisma.supplier.findMany({
        where: { active: true },
        select: { id: true, nameAr: true, nameEn: true },
        orderBy: { nameAr: "asc" },
      }),
    ]);

    return {
      categories: ACCOUNT_CATEGORIES.map((c) => ({
        id: c.id,
        label: c.label,
        allLabel: c.allLabel,
        kind: c.kind,
      })),
      accounts,
      customers,
      suppliers,
    };
  }

  /** Consolidated ("الكل") or specific statement for a category. */
  @Get("consolidated")
  @Roles("OWNER", "ACCOUNTANT")
  async consolidatedStatement(
    @Query(new ZodValidationPipe(ConsolidatedStatementQuerySchema)) query: ConsolidatedStatementQuery,
  ) {
    return this.consolidated.build({
      category: query.category,
      entityId: query.entityId,
      from: query.from,
      to: query.to,
      includeZero: query.includeZero,
    });
  }
}
