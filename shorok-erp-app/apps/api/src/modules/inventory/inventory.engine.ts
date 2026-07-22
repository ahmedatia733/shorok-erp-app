import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type { MovementType } from "@shorok/shared";
import { AuditService } from "../audit/audit.service";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import {
  InsufficientStockError,
  InvalidMovementError,
  NotFoundError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";

export interface InventoryApplyInput {
  branchId: string;
  productVariantId: string;
  movementType: MovementType;
  /** Signed; positive for stock in, negative for stock out. */
  boardsDelta: string | number | Decimal;
  /**
   * Signed effective meters moved (same sign as boardsDelta). When provided —
   * e.g. a purchase/sales invoice line with a chosen كبير/صغير/custom area — it
   * is the EXACT total meters for this movement and drives both the movement's
   * metersDelta and the balance. When omitted (receipts, adjustments, counts,
   * opening), it falls back to boardsDelta × the variant's sizeMetersPerBoard,
   * preserving the previous behavior exactly.
   */
  metersDelta?: string | number | Decimal;
  reference?: { type: string; id?: string | null } | null;
  actor: AuthenticatedUser;
  /** Both summaries are required so the audit row carries pre-localized text. */
  summaryAr: string;
  summaryEn: string;
  /** Optional human-readable note stored on the movement row itself. */
  humanReadableNote?: string | null;
  /** Optional: provide a pre-existing transactional client to run inside an outer tx. */
  tx?: Prisma.TransactionClient;
  /** Optional back-dated timestamp for data import migration. */
  createdAt?: Date;
}

export interface InventoryApplyResult {
  movementId: string;
  boardsOnHand: string;
  metersOnHand: string;
  boardsDelta: string;
  metersDelta: string;
}

/**
 * The single application-level path for every write that changes a
 * BranchInventoryBalance row. Every operation runs inside a Prisma
 * transaction with a row-level lock on the balance row, so concurrent
 * operations against the same (branch, variant) pair serialize.
 *
 * Constitution Principle I (Data Correctness): branch on-hand stock MUST
 * never go negative. This engine throws InsufficientStockError BEFORE
 * touching any data when a delta would drive the balance below zero;
 * the DB-level CHECK constraint is the belt-and-braces backstop.
 *
 * Constitution Principle III (Audit-Everything): the AuditService.write
 * call is part of the SAME transaction as the balance update + movement
 * insert, so an action and its audit row commit (or roll back) together.
 */
@Injectable()
export class InventoryEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async apply(input: InventoryApplyInput): Promise<InventoryApplyResult> {
    if (input.tx) {
      return this.applyInTx(input.tx, input);
    }
    return this.prisma.runInTransaction((tx) => this.applyInTx(tx, input));
  }

  private async applyInTx(
    tx: Prisma.TransactionClient,
    input: InventoryApplyInput,
  ): Promise<InventoryApplyResult> {
    // Verify variant exists and grab size_meters_per_board for derived meters.
    const variant = await tx.productVariant.findUnique({
      where: { id: input.productVariantId },
      select: { id: true, sizeMetersPerBoard: true },
    });
    if (!variant) {
      throw new NotFoundError({ productVariantId: input.productVariantId });
    }

    // Verify branch exists (cheap; cleaner errors than FK violation later).
    const branch = await tx.branch.findUnique({
      where: { id: input.branchId },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundError({ branchId: input.branchId });
    }

    const sizePerBoard = new Decimal(variant.sizeMetersPerBoard.toString());
    const boardsDelta = new Decimal(input.boardsDelta as string);
    if (boardsDelta.isZero()) {
      // Engine refuses no-op writes — guards against silent ledger pollution.
      throw new InvalidMovementError({ reason: "zero_delta" });
    }
    // Effective meters: caller-supplied (invoice line's chosen area) or, by
    // default, boards × the variant's size. The caller's value must carry the
    // same sign as the boards delta so stock-in adds and stock-out removes.
    const metersDelta =
      input.metersDelta != null
        ? new Decimal(input.metersDelta as string)
        : boardsDelta.times(sizePerBoard);
    if (!metersDelta.isZero() && metersDelta.isNegative() !== boardsDelta.isNegative()) {
      throw new InvalidMovementError({ reason: "meters_sign_mismatch" });
    }

    // Ensure the balance row exists, then take a row-level lock on it.
    // ON CONFLICT DO NOTHING keeps the upsert idempotent and avoids the
    // race where two concurrent first-touches both try to insert.
    await tx.$executeRaw`
      INSERT INTO branch_inventory_balances
        (branch_id, product_variant_id, boards_on_hand, meters_on_hand, updated_at)
      VALUES
        (${input.branchId}::uuid, ${input.productVariantId}::uuid, 0, 0, NOW())
      ON CONFLICT (branch_id, product_variant_id) DO NOTHING
    `;

    const locked = await tx.$queryRaw<
      Array<{ boards_on_hand: Prisma.Decimal; meters_on_hand: Prisma.Decimal }>
    >`
      SELECT boards_on_hand, meters_on_hand
      FROM branch_inventory_balances
      WHERE branch_id = ${input.branchId}::uuid
        AND product_variant_id = ${input.productVariantId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      // Should be impossible right after the upsert above, but fail loudly.
      throw new NotFoundError({ branchId: input.branchId, productVariantId: input.productVariantId });
    }

    const currentBoards = new Decimal(locked[0]!.boards_on_hand.toString());
    const currentMeters = new Decimal(locked[0]!.meters_on_hand.toString());
    const newBoards = currentBoards.plus(boardsDelta);
    if (newBoards.isNegative()) {
      throw new InsufficientStockError({
        branchId: input.branchId,
        productVariantId: input.productVariantId,
        currentBoards: currentBoards.toFixed(4),
        requestedDelta: boardsDelta.toFixed(4),
      });
    }
    // Meters accumulate the exact effective meters moved (so mixed كبير/صغير/
    // custom lines stay correct and a later variant-size edit never rewrites the
    // balance). For standard lines this equals newBoards × size, matching the
    // prior behavior on the (verified consistent) existing data.
    const newMeters = currentMeters.plus(metersDelta);
    if (newMeters.isNegative()) {
      throw new InsufficientStockError({
        branchId: input.branchId,
        productVariantId: input.productVariantId,
        currentMeters: currentMeters.toFixed(4),
        requestedMetersDelta: metersDelta.toFixed(4),
      });
    }

    await tx.branchInventoryBalance.update({
      where: {
        branchId_productVariantId: {
          branchId: input.branchId,
          productVariantId: input.productVariantId,
        },
      },
      data: {
        boardsOnHand: newBoards.toFixed(4),
        metersOnHand: newMeters.toFixed(4),
        ...(input.movementType === "COUNT_CORRECTION" ? { lastCountedAt: new Date() } : {}),
      },
    });

    const movement = await tx.inventoryMovement.create({
      data: {
        branchId: input.branchId,
        productVariantId: input.productVariantId,
        movementType: input.movementType,
        boardsQuantity: boardsDelta.toFixed(4),
        metersQuantity: metersDelta.toFixed(4),
        referenceType: input.reference?.type ?? null,
        referenceId: input.reference?.id ?? null,
        createdBy: input.actor.id,
        humanReadableNote: input.humanReadableNote ?? null,
        createdAt: input.createdAt,
      },
    });

    await this.audit.write({
      tx,
      actorId: input.actor.id,
      action: "CREATE",
      entityType: "inventory_movement",
      entityId: movement.id,
      afterSnapshot: {
        movementType: input.movementType,
        boardsDelta: boardsDelta.toFixed(4),
        metersDelta: metersDelta.toFixed(4),
        branchId: input.branchId,
        productVariantId: input.productVariantId,
        boardsOnHand: newBoards.toFixed(4),
        metersOnHand: newMeters.toFixed(4),
      },
      summaryAr: input.summaryAr,
      summaryEn: input.summaryEn,
      createdAt: input.createdAt,
    });

    return {
      movementId: movement.id,
      boardsOnHand: newBoards.toFixed(4),
      metersOnHand: newMeters.toFixed(4),
      boardsDelta: boardsDelta.toFixed(4),
      metersDelta: metersDelta.toFixed(4),
    };
  }
}
