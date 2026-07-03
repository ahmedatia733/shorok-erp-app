import { Body, Controller, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { I18nService } from "nestjs-i18n";
import {
  CreateFactoryPaymentRequestSchema,
  type CreateFactoryPaymentRequest,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { FactoryLedgerRecompute } from "./recompute.sql";
import { serializeEntry } from "./serializer";

/**
 * T101 — POST /factory-ledger/payments
 *
 * Payment-only row: shrinks the supplier's running balance. No variant,
 * no boards, no price, total_amount = 0. paid_amount must be > 0.
 */
@Controller("factory-ledger")
export class FactoryLedgerPaymentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recompute: FactoryLedgerRecompute,
    private readonly i18n: I18nService,
  ) {}

  @Post("payments")
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateFactoryPaymentRequestSchema))
    body: CreateFactoryPaymentRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: body.supplierId },
    });
    if (!supplier) throw new NotFoundError({ supplierId: body.supplierId });
    if (!supplier.active) {
      throw new ValidationError({ reason: "supplier_inactive", supplierId: supplier.id });
    }

    // decimal.js treats 0 as positive; require strictly > 0 for payments.
    const paidAmount = new Decimal(body.paidAmount);
    if (!paidAmount.gt(0)) {
      throw new ValidationError({ reason: "paid_must_be_positive" });
    }

    return this.prisma.runInTransaction(async (tx) => {
      // Auto-post GL journal entry: Dr AP(Suppliers) / Cr Cash if both accounts provided
      let journalEntryId: string | null = null;

      const entry = await tx.factoryLedgerEntry.create({
        data: {
          supplierId: body.supplierId,
          orderDate: new Date(body.orderDate),
          productVariantId: null,
          boardsQuantity: null,
          metersQuantity: null,
          purchasePricePerMeter: null,
          totalAmount: "0.00",
          paidAmount: paidAmount.toFixed(2),
          notes: body.notes ?? null,
          debitAccountId:  body.debitAccountId  ?? null,
          creditAccountId: body.creditAccountId ?? null,
          journalEntryId:  null,
          createdBy: user.id,
        },
      });

      if (body.debitAccountId && body.creditAccountId) {
        const je = await tx.journalEntry.create({
          data: {
            entryType:     "JOURNAL",
            entryDate:     new Date(body.orderDate),
            description:   `دفعة للمورد ${supplier.nameAr} — ${paidAmount.toFixed(2)} ج.م`,
            referenceType: "factory_ledger_payment",
            referenceId:   entry.id,
            createdBy:     user.id,
            lines: {
              create: [
                { accountId: body.debitAccountId,  debit: paidAmount.toFixed(2), credit: "0.00",
                  note: `تسوية موردون — ${supplier.nameAr}` },
                { accountId: body.creditAccountId, debit: "0.00", credit: paidAmount.toFixed(2),
                  note: `دفع نقدي/بنكي — ${supplier.nameAr}` },
              ],
            },
          },
        });
        journalEntryId = je.id;
        await tx.factoryLedgerEntry.update({
          where: { id: entry.id },
          data:  { journalEntryId: je.id },
        });
      }

      await this.recompute.run(tx, body.supplierId);

      const argsCommon = { actor: user.name, paid: paidAmount.toFixed(2) };
      const summaryAr = (await this.i18n.translate(
        "factory-ledger.summary.payment_recorded",
        { lang: "ar", args: { ...argsCommon, supplier: supplier.nameAr } },
      )) as string;
      const summaryEn = (await this.i18n.translate(
        "factory-ledger.summary.payment_recorded",
        { lang: "en", args: { ...argsCommon, supplier: supplier.nameEn } },
      )) as string;

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "factory_ledger_entry",
        entityId: entry.id,
        afterSnapshot: {
          supplierId: body.supplierId,
          orderDate: body.orderDate,
          paidAmount: paidAmount.toFixed(2),
          kind: "payment",
        },
        summaryAr,
        summaryEn,
      });

      const refreshed = await tx.factoryLedgerEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      return serializeEntry(refreshed);
    });
  }
}
