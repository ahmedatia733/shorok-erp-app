import { Body, Controller, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { CountRequestSchema, type CountRequest } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
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
  ) {}

  /**
   * Records a daily stock count. The whole batch runs in ONE transaction:
   * either all per-line COUNT_CORRECTION movements + audit rows commit,
   * or the entire count is rolled back. Lines with zero variance still
   * produce an audit row (so we always have a record of who counted what).
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

        // Make sure a balance row exists; engine.apply also handles this,
        // but for COUNT we need the CURRENT on-hand to compute the delta.
        await tx.$executeRaw`
          INSERT INTO branch_inventory_balances
            (branch_id, product_variant_id, boards_on_hand, meters_on_hand, updated_at)
          VALUES
            (${body.branchId}::uuid, ${line.productVariantId}::uuid, 0, 0, NOW())
          ON CONFLICT (branch_id, product_variant_id) DO NOTHING
        `;

        const balance = await tx.branchInventoryBalance.findUniqueOrThrow({
          where: {
            branchId_productVariantId: {
              branchId: body.branchId,
              productVariantId: line.productVariantId,
            },
          },
        });

        const counted = new Decimal(line.countedBoards);
        const current = new Decimal(balance.boardsOnHand.toString());
        const delta = counted.minus(current);

        if (delta.isZero()) {
          // No-variance line: stamp last_counted_at and audit "no variance".
          await tx.branchInventoryBalance.update({
            where: {
              branchId_productVariantId: {
                branchId: body.branchId,
                productVariantId: line.productVariantId,
              },
            },
            data: { lastCountedAt: new Date() },
          });

          const productLabelAr = `${variant.sku.colorNameAr} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} م)`;
          const productLabelEn = `${variant.sku.colorNameEn} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} m)`;
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
          await tx.auditLog.create({
            data: {
              actorId: user.id,
              action: "CREATE",
              entityType: "inventory_count",
              entityId: null,
              humanReadableSummaryAr: summaries.ar,
              humanReadableSummaryEn: summaries.en,
              afterSnapshot: {
                branchId: body.branchId,
                productVariantId: line.productVariantId,
                countedBoards: counted.toFixed(4),
                variance: "0",
              },
            },
          });

          results.push({
            productVariantId: line.productVariantId,
            delta: "0.0000",
            boardsOnHand: balance.boardsOnHand.toString(),
            metersOnHand: balance.metersOnHand.toString(),
            movementId: null,
          });
          continue;
        }

        // Real variance: post a COUNT_CORRECTION movement via the engine.
        const productLabelAr = `${variant.sku.colorNameAr} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} م)`;
        const productLabelEn = `${variant.sku.colorNameEn} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} m)`;
        const meters = delta.times(new Decimal(variant.sizeMetersPerBoard.toString()));
        const summaries = await this.summary.build({
          movementType: "COUNT_CORRECTION",
          boardsDelta: delta.toFixed(4),
          metersDelta: meters.toFixed(4),
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
