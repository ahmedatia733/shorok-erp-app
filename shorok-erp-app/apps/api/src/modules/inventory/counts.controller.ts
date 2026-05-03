import { Body, Controller, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { CountRequestSchema, type CountRequest } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "./inventory.engine";
import { InventorySummaryBuilder } from "./inventory.summary";

interface CountLineResult {
  productVariantId: string;
  delta: string;
  boardsOnHand: string;
  metersOnHand: string;
  movementId: string | null;
}

@Controller("inventory/counts")
@Roles("OWNER", "BRANCH_MANAGER", "WAREHOUSE")
export class CountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: InventoryEngine,
    private readonly summary: InventorySummaryBuilder,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records a daily stock count. The whole batch runs in ONE transaction:
   * either all per-line COUNT_CORRECTION movements + audit rows commit,
   * or the entire count is rolled back.
   *
   * For each line we MUST take the FOR UPDATE row lock BEFORE reading the
   * current balance — otherwise a concurrent receipt/sale between the read
   * and the engine's locked write would leave the post-condition
   * `boards_on_hand == countedBoards` violated. With the lock taken first,
   * the delta is computed against the same balance the engine then writes
   * to, so the count's absolute target is honored under contention.
   *
   * Lines with zero variance still produce an audit row (so we always have
   * a record of who counted what and when).
   */
  @Post()
  async count(
    @Body(new ZodValidationPipe(CountRequestSchema)) body: CountRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const branch = await this.prisma.branch.findUnique({ where: { id: body.branchId } });
    if (!branch) throw new NotFoundError({ branchId: body.branchId });

    return this.prisma.runInTransaction(async (tx) => {
      const results: CountLineResult[] = [];

      for (const line of body.lines) {
        const variant = await tx.productVariant.findUnique({
          where: { id: line.productVariantId },
          include: { sku: true },
        });
        if (!variant) {
          throw new NotFoundError({ productVariantId: line.productVariantId });
        }

        // 1. Make sure the balance row exists. ON CONFLICT DO NOTHING is
        //    idempotent and safe under concurrency (the loser waits on the
        //    winner's tuple lock and then reads the committed row).
        await tx.$executeRaw`
          INSERT INTO branch_inventory_balances
            (branch_id, product_variant_id, boards_on_hand, meters_on_hand, updated_at)
          VALUES
            (${body.branchId}::uuid, ${line.productVariantId}::uuid, 0, 0, NOW())
          ON CONFLICT (branch_id, product_variant_id) DO NOTHING
        `;

        // 2. Take the row-level lock BEFORE reading current. This closes
        //    the TOCTOU window between read and engine-apply.
        const locked = await tx.$queryRaw<
          Array<{ boards_on_hand: Prisma.Decimal; meters_on_hand: Prisma.Decimal }>
        >`
          SELECT boards_on_hand, meters_on_hand
          FROM branch_inventory_balances
          WHERE branch_id = ${body.branchId}::uuid
            AND product_variant_id = ${line.productVariantId}::uuid
          FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new NotFoundError({
            branchId: body.branchId,
            productVariantId: line.productVariantId,
          });
        }

        const currentBoards = new Decimal(locked[0]!.boards_on_hand.toString());
        const currentMeters = new Decimal(locked[0]!.meters_on_hand.toString());
        const counted = new Decimal(line.countedBoards);
        const delta = counted.minus(currentBoards);
        const sizePerBoard = new Decimal(variant.sizeMetersPerBoard.toString());

        const productLabelAr = `${variant.sku.colorNameAr} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} م)`;
        const productLabelEn = `${variant.sku.colorNameEn} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} m)`;

        if (delta.isZero()) {
          // No-variance line: stamp last_counted_at on the LOCKED row and
          // audit "no variance" via AuditService (Constitution III: every
          // audit write goes through the same service).
          await tx.branchInventoryBalance.update({
            where: {
              branchId_productVariantId: {
                branchId: body.branchId,
                productVariantId: line.productVariantId,
              },
            },
            data: { lastCountedAt: new Date() },
          });

          const summaries = await this.summary.build({
            movementType: "COUNT_CORRECTION",
            boardsDelta: "0",
            metersDelta: "0",
            actorName: user.name,
            productLabelAr,
            productLabelEn,
            branchNameAr: branch.nameAr,
            branchNameEn: branch.nameEn,
          });

          await this.audit.write({
            tx,
            actorId: user.id,
            action: "CREATE",
            entityType: "inventory_count",
            entityId: null,
            afterSnapshot: {
              branchId: body.branchId,
              productVariantId: line.productVariantId,
              countedBoards: counted.toFixed(4),
              variance: "0",
            },
            summaryAr: summaries.ar,
            summaryEn: summaries.en,
          });

          results.push({
            productVariantId: line.productVariantId,
            delta: "0.0000",
            boardsOnHand: currentBoards.toFixed(4),
            metersOnHand: currentMeters.toFixed(4),
            movementId: null,
          });
          continue;
        }

        // Real variance: hand off to the engine. Because the lock is
        // already held by THIS transaction, the engine's own SELECT FOR
        // UPDATE is a no-op (re-acquiring a held lock returns immediately).
        const metersDelta = delta.times(sizePerBoard);
        const summaries = await this.summary.build({
          movementType: "COUNT_CORRECTION",
          boardsDelta: delta.toFixed(4),
          metersDelta: metersDelta.toFixed(4),
          actorName: user.name,
          productLabelAr,
          productLabelEn,
          branchNameAr: branch.nameAr,
          branchNameEn: branch.nameEn,
        });
        const result = await this.engine.apply({
          branchId: body.branchId,
          productVariantId: line.productVariantId,
          movementType: "COUNT_CORRECTION",
          boardsDelta: delta.toFixed(4),
          reference: { type: "count" },
          actor: user,
          summaryAr: summaries.ar,
          summaryEn: summaries.en,
          tx,
        });

        results.push({
          productVariantId: line.productVariantId,
          delta: result.boardsDelta,
          boardsOnHand: result.boardsOnHand,
          metersOnHand: result.metersOnHand,
          movementId: result.movementId,
        });
      }

      return { lines: results };
    });
  }
}
