import { Injectable } from "@nestjs/common";
import type { AuditAction } from "@shorok/shared";
import { Prisma } from "../../prisma/prisma.service";

export interface AuditWriteInput {
  /** The transactional client. MUST be the same tx as the action being audited. */
  tx: Prisma.TransactionClient;
  /** Authenticated actor; null for system events (e.g. import jobs). */
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
  /** Human-readable summaries — both locales required by Constitution Principle III. */
  summaryAr: string;
  summaryEn: string;
}

/**
 * Writes audit_logs rows. By design, this service has no methods that mutate
 * outside an explicit `tx` argument — every state-changing handler MUST pass
 * the same Prisma transaction client. If the handler's action commits, the
 * audit row commits with it; if anything in the transaction fails, both roll
 * back together (Constitution Principle III: Audit-Everything).
 */
@Injectable()
export class AuditService {
  async write(input: AuditWriteInput): Promise<void> {
    await input.tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeSnapshot:
          input.beforeSnapshot === undefined
            ? Prisma.JsonNull
            : (input.beforeSnapshot as Prisma.InputJsonValue),
        afterSnapshot:
          input.afterSnapshot === undefined
            ? Prisma.JsonNull
            : (input.afterSnapshot as Prisma.InputJsonValue),
        humanReadableSummaryAr: input.summaryAr,
        humanReadableSummaryEn: input.summaryEn,
      },
    });
  }
}
