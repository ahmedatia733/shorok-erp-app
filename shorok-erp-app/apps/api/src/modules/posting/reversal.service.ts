import { Injectable } from "@nestjs/common";
import type { PostingResult } from "@shorok/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import { NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PostingEngine } from "./posting.engine";

export interface ReverseInput {
  entryId: string;
  reason: string;
  reversalDate?: string; // ISO date; defaults to today
  actor: AuthenticatedUser;
}

/**
 * Corrections happen by reversal, never by editing/deleting a posted entry
 * (Constitution VII — Posted-Record Immutability). A reversal is a mirrored
 * entry (debit/credit swapped) created THROUGH the PostingEngine, linked to
 * the original via reversal_of_id, with the original marked REVERSED. The
 * whole thing is one transaction; the deterministic idempotency key makes a
 * double-reverse a no-op.
 */
@Injectable()
export class ReversalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: PostingEngine,
    private readonly audit: AuditService,
  ) {}

  async reverse(input: ReverseInput): Promise<PostingResult> {
    return this.prisma.runInTransaction(async (tx) => {
      const original = await tx.journalEntry.findUnique({
        where: { id: input.entryId },
        include: { lines: true },
      });
      if (!original) throw new NotFoundError({ entryId: input.entryId });
      if (original.status !== "POSTED") {
        throw new ValidationError({ reason: "entry_not_reversible", status: original.status });
      }

      const reversalDate = input.reversalDate ?? new Date().toISOString().slice(0, 10);

      // Mirror every line: debit ↔ credit, keep account/party/branch dims.
      const mirroredLines = original.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.credit.toString(),
        credit: l.debit.toString(),
        note: l.note ?? undefined,
        partyType: (l.partyType ?? undefined) as "CUSTOMER" | "SUPPLIER" | undefined,
        partyId: l.partyId ?? undefined,
        branchId: l.branchId ?? undefined,
      }));

      const result = await this.engine.post({
        tx,
        actor: input.actor,
        sourceType: original.sourceType ?? "MANUAL",
        sourceId: original.sourceId ?? undefined,
        entryDate: reversalDate,
        entryType: original.entryType,
        reference: original.reference ?? undefined,
        description: `عكس قيد #${Number(original.entryNumber)} — ${input.reason}`,
        idempotencyKey: `reversal:${original.id}`,
        lines: mirroredLines,
      });

      // If this key already produced a reversal, the engine returned it as
      // idempotent — do not re-link or re-mark.
      if (result.idempotent) return result;

      // Link the reversal to the original and mark the original REVERSED.
      await tx.journalEntry.update({
        where: { id: result.journalEntryId },
        data: { reversalOfId: original.id },
      });
      await tx.journalEntry.update({
        where: { id: original.id },
        data: { status: "REVERSED" },
      });

      await this.audit.write({
        tx,
        actorId: input.actor.id,
        action: "CANCEL",
        entityType: "journal_entry",
        entityId: original.id,
        beforeSnapshot: { status: "POSTED", entryNumber: Number(original.entryNumber) },
        afterSnapshot: { status: "REVERSED", reversalEntryId: result.journalEntryId, reason: input.reason },
        summaryAr: `${input.actor.name} عكس قيد #${Number(original.entryNumber)} — ${input.reason}`,
        summaryEn: `${input.actor.name} reversed entry #${Number(original.entryNumber)} — ${input.reason}`,
      });

      return result;
    });
  }
}
