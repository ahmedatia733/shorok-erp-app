import { Body, Controller, Post } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { ReceiptRequestSchema, type ReceiptRequest } from "@shorok/shared";
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

@Controller("inventory/receipts")
@Roles("OWNER", "BRANCH_MANAGER", "WAREHOUSE")
export class ReceiptsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: InventoryEngine,
    private readonly summary: InventorySummaryBuilder,
  ) {}

  @Post()
  async receive(
    @Body(new ZodValidationPipe(ReceiptRequestSchema)) body: ReceiptRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const boards = new Decimal(body.boardsQuantity);
    if (boards.lte(0)) {
      throw new InvalidMovementError({ reason: "boards_must_be_positive" });
    }

    const ctx = await this.loadContext(body.productVariantId, body.branchId);

    const summaries = await this.summary.build({
      movementType: "RECEIPT",
      boardsDelta: boards.toFixed(4),
      metersDelta: boards.times(new Decimal(ctx.variant.sizeMetersPerBoard.toString())).toFixed(4),
      actorName: user.name,
      productLabelAr: ctx.productLabelAr,
      productLabelEn: ctx.productLabelEn,
      branchNameAr: ctx.branch.nameAr,
      branchNameEn: ctx.branch.nameEn,
    });

    return this.engine.apply({
      branchId: body.branchId,
      productVariantId: body.productVariantId,
      movementType: "RECEIPT",
      boardsDelta: boards.toFixed(4),
      reference: { type: "receipt" },
      actor: user,
      summaryAr: summaries.ar,
      summaryEn: summaries.en,
      humanReadableNote: body.note ?? null,
    });
  }

  private async loadContext(productVariantId: string, branchId: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: productVariantId },
      include: { sku: true },
    });
    if (!variant) throw new NotFoundError({ productVariantId });
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundError({ branchId });
    const productLabelAr = `${variant.sku.colorNameAr} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} م)`;
    const productLabelEn = `${variant.sku.colorNameEn} (${variant.sku.code} · ${variant.sizeMetersPerBoard.toString()} m)`;
    return { variant, branch, productLabelAr, productLabelEn };
  }
}
