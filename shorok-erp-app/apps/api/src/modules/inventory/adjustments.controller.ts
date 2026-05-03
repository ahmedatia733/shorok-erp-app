import { Body, Controller, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { AdjustmentRequestSchema, type AdjustmentRequest } from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  InvalidMovementError,
  NotFoundError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { InventoryEngine } from "./inventory.engine";
import { InventorySummaryBuilder } from "./inventory.summary";

@Controller("inventory/adjustments")
@Roles("OWNER", "BRANCH_MANAGER", "WAREHOUSE")
export class AdjustmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: InventoryEngine,
    private readonly summary: InventorySummaryBuilder,
  ) {}

  @Post()
  async adjust(
    @Body(new ZodValidationPipe(AdjustmentRequestSchema)) body: AdjustmentRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const delta = new Decimal(body.boardsDelta);
    if (delta.isZero()) {
      throw new InvalidMovementError({ reason: "delta_must_be_nonzero" });
    }

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: body.productVariantId },
      include: { sku: true },
    });
    if (!variant) throw new NotFoundError({ productVariantId: body.productVariantId });
    const branch = await this.prisma.branch.findUnique({ where: { id: body.branchId } });
    if (!branch) throw new NotFoundError({ branchId: body.branchId });

    const productLabelAr = `${variant.sku.colorNameAr} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} م)`;
    const productLabelEn = `${variant.sku.colorNameEn} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} m)`;
    const meters = delta.times(new Decimal(variant.sizeMetersPerBoard.toString()));

    const summaries = await this.summary.build({
      movementType: "ADJUSTMENT",
      boardsDelta: delta.toFixed(4),
      metersDelta: meters.toFixed(4),
      actorName: user.name,
      productLabelAr,
      productLabelEn,
      branchNameAr: branch.nameAr,
      branchNameEn: branch.nameEn,
    });

    return this.engine.apply({
      branchId: body.branchId,
      productVariantId: body.productVariantId,
      movementType: "ADJUSTMENT",
      boardsDelta: delta.toFixed(4),
      reference: { type: "adjustment" },
      actor: user,
      summaryAr: summaries.ar,
      summaryEn: summaries.en,
      humanReadableNote: body.note,
    });
  }
}
