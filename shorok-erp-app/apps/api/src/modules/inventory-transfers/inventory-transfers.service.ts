import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { createHash } from "node:crypto";
import type {
  CancelInventoryTransfer,
  ConfirmInventoryTransfer,
  CreateInventoryTransfer,
  InventoryTransferIssue,
  InventoryTransferPreview,
  InventoryTransferPreviewLine,
  InventoryTransferQuery,
  SourceProductsQuery,
  SourceProductsResponse,
  SourceSizeOption,
  SourceSizeOptionsQuery,
  SourceSizeOptionsResponse,
  UpdateInventoryTransfer,
} from "@shorok/shared";
import {
  BranchForbiddenError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
// Value imports, NOT `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time — the code would compile and then fail to inject.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { AuditService } from "../audit/audit.service";
import { Prisma, PrismaService } from "../../prisma/prisma.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { InventoryAvailabilityService } from "../inventory/inventory-availability.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import {
  assertPairConserves,
  computeLine,
  formatTransferNumber,
  money,
  qty,
  rate,
  TransferMathError,
} from "./transfer-math";
import { decideSourceAvailability, tryClassifyTransferSizeOption } from "./size-classification";

type Tx = Prisma.TransactionClient;

const D = (v: Prisma.Decimal | Decimal | string | number | null | undefined): Decimal =>
  new Decimal((v ?? 0).toString());

function issue(
  code: string,
  messageAr: string,
  context?: Record<string, string | number | null>,
): InventoryTransferIssue {
  return { code, messageAr, ...(context ? { context } : {}) };
}

type DecimalLike = Prisma.Decimal | Decimal | string | number;
type ActorRef = { id: string; name: string } | null;

/**
 * What the formatter and the audit writer actually read, stated structurally
 * instead of as a Prisma payload generic. Queries can then select only the
 * columns they need — which is why no actor row here carries a password hash —
 * and still satisfy these shapes.
 */
interface FormattableLine {
  id: string;
  productVariantId: string;
  skuCode: string;
  productNameAr: string;
  productNameEn: string | null;
  boardSizeMeters: DecimalLike;
  boardQuantity: DecimalLike;
  meterQuantity: DecimalLike;
  costPerMeter: DecimalLike;
  totalValue: DecimalLike;
  lineIndex: number;
  sourceMovementId: string | null;
  destinationMovementId: string | null;
  cancelSourceMovementId: string | null;
  cancelDestinationMovementId: string | null;
}

interface FormattableTransfer {
  id: string;
  transferNumber: bigint;
  status: "DRAFT" | "CONFIRMED" | "CANCELLED";
  transferDate: Date;
  sourceBranch: { id: string; nameAr: string };
  destinationBranch: { id: string; nameAr: string };
  purpose: string | null;
  notes: string | null;
  version: number;
  creator: ActorRef;
  updater: ActorRef;
  confirmer: ActorRef;
  canceller: ActorRef;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  lines: FormattableLine[];
}

interface AuditableTransfer {
  id: string;
  transferNumber: bigint;
  status: string;
  sourceBranchId: string;
  destinationBranchId: string;
  lines: Array<{
    productVariantId: string;
    boardQuantity: DecimalLike;
    meterQuantity: DecimalLike;
  }>;
}

/**
 * Inter-branch inventory transfer.
 *
 * Moving stock between two branches of the same company changes where the goods
 * sit and nothing else. So the whole service is organised around one promise
 * that is asserted rather than assumed: for every variant it touches, the
 * company's total boards, total metres, total inventory value and the shared
 * weighted-average cost are identical before and after.
 *
 * That is also why it posts no journal. The chart of accounts has exactly one
 * inventory control account for the whole company — `AccountSystemRole` even
 * declares `systemRole` unique — so a branch-to-branch move would be
 * Dr X / Cr X on the same account: a guaranteed no-op. Inventory receipts,
 * adjustments, counts and confirmed customer orders already move stock without
 * touching the ledger; this follows them rather than inventing a journal to
 * look thorough.
 *
 * The costing side is deliberately inert. Purchases and returns recompute the
 * shared WAC because they change what the company paid; a transfer does not, so
 * it reads the current WAC, carries it on both legs, and writes it back
 * nowhere.
 */
@Injectable()
export class InventoryTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryEngine,
    private readonly availability: InventoryAvailabilityService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async list(query: InventoryTransferQuery, user: AuthenticatedUser) {
    // A non-OWNER only sees transfers touching a branch they may access, on
    // either leg — the same branch-scope rule the invoice lists apply.
    const scope =
      user.role === "OWNER"
        ? {}
        : {
            OR: [
              { sourceBranchId: { in: user.allowedBranches } },
              { destinationBranchId: { in: user.allowedBranches } },
            ],
          };
    const q = query.q?.trim();
    const where: Prisma.InventoryTransferWhereInput = {
      ...scope,
      ...(query.status ? { status: query.status } : {}),
      ...(query.sourceBranchId ? { sourceBranchId: query.sourceBranchId } : {}),
      ...(query.destinationBranchId ? { destinationBranchId: query.destinationBranchId } : {}),
      ...(query.productVariantId
        ? { lines: { some: { productVariantId: query.productVariantId } } }
        : {}),
      ...(query.from || query.to
        ? {
            transferDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              ...(/^\d+$/.test(q) ? [{ transferNumber: BigInt(q) }] : []),
              { lines: { some: { skuCode: { contains: q, mode: "insensitive" as const } } } },
              { lines: { some: { productNameAr: { contains: q, mode: "insensitive" as const } } } },
              { notes: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.inventoryTransfer.findMany({
      where,
      orderBy: [{ transferDate: "desc" }, { transferNumber: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        sourceBranch: { select: { id: true, nameAr: true } },
        destinationBranch: { select: { id: true, nameAr: true } },
        creator: { select: { id: true, name: true } },
        confirmer: { select: { id: true, name: true } },
        lines: { select: { boardQuantity: true, meterQuantity: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: data.map((t) => ({
        id: t.id,
        transferNumber: formatTransferNumber(t.transferNumber),
        transferDate: t.transferDate,
        status: t.status,
        sourceBranch: t.sourceBranch,
        destinationBranch: t.destinationBranch,
        lineCount: t.lines.length,
        totalBoards: qty(t.lines.reduce((a, l) => a.plus(D(l.boardQuantity)), new Decimal(0))),
        totalMeters: qty(t.lines.reduce((a, l) => a.plus(D(l.meterQuantity)), new Decimal(0))),
        createdByName: t.creator?.name ?? null,
        confirmedByName: t.confirmer?.name ?? null,
        createdAt: t.createdAt,
      })),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    };
  }

  async getOne(id: string, user: AuthenticatedUser) {
    const t = await this.prisma.inventoryTransfer.findUnique({
      where: { id },
      include: {
        sourceBranch: { select: { id: true, nameAr: true, nameEn: true } },
        destinationBranch: { select: { id: true, nameAr: true, nameEn: true } },
        creator: { select: { id: true, name: true } },
        updater: { select: { id: true, name: true } },
        confirmer: { select: { id: true, name: true } },
        canceller: { select: { id: true, name: true } },
        lines: { orderBy: { lineIndex: "asc" } },
      },
    });
    if (!t) throw new NotFoundError({ id });
    this.assertBranchScope(t, user);
    return this.format(t);
  }

  private assertBranchScope(
    t: { sourceBranchId: string; destinationBranchId: string; id: string },
    user: AuthenticatedUser,
  ) {
    if (user.role === "OWNER") return;
    const ok =
      user.allowedBranches.includes(t.sourceBranchId) ||
      user.allowedBranches.includes(t.destinationBranchId);
    // 404 rather than 403 so a foreign id cannot be probed for existence.
    if (!ok) throw new NotFoundError({ id: t.id });
  }

  private format(t: FormattableTransfer) {
    const boards = t.lines.reduce((a, l) => a.plus(D(l.boardQuantity)), new Decimal(0));
    const meters = t.lines.reduce((a, l) => a.plus(D(l.meterQuantity)), new Decimal(0));
    const value = t.lines.reduce((a, l) => a.plus(D(l.totalValue)), new Decimal(0));
    return {
      id: t.id,
      transferNumber: formatTransferNumber(t.transferNumber),
      status: t.status,
      transferDate: t.transferDate,
      sourceBranch: { id: t.sourceBranch.id, nameAr: t.sourceBranch.nameAr },
      destinationBranch: { id: t.destinationBranch.id, nameAr: t.destinationBranch.nameAr },
      purpose: t.purpose,
      notes: t.notes,
      version: t.version,
      createdByName: t.creator?.name ?? null,
      createdAt: t.createdAt,
      updatedByName: t.updater?.name ?? null,
      updatedAt: t.updatedAt,
      confirmedByName: t.confirmer?.name ?? null,
      confirmedAt: t.confirmedAt,
      cancelledByName: t.canceller?.name ?? null,
      cancelledAt: t.cancelledAt,
      cancellationReason: t.cancellationReason,
      totals: {
        lineCount: t.lines.length,
        boards: qty(boards),
        meters: qty(meters),
        value: money(value),
      },
      lines: t.lines.map((l) => ({
        id: l.id,
        productVariantId: l.productVariantId,
        skuCode: l.skuCode,
        productNameAr: l.productNameAr,
        productNameEn: l.productNameEn,
        boardSizeMeters: rate(D(l.boardSizeMeters)),
        boardQuantity: qty(D(l.boardQuantity)),
        meterQuantity: qty(D(l.meterQuantity)),
        costPerMeter: rate(D(l.costPerMeter)),
        totalValue: money(D(l.totalValue)),
        lineIndex: l.lineIndex,
        sourceMovementId: l.sourceMovementId,
        destinationMovementId: l.destinationMovementId,
        cancelSourceMovementId: l.cancelSourceMovementId,
        cancelDestinationMovementId: l.cancelDestinationMovementId,
      })),
    };
  }

  // ── source-warehouse product picker (read-only) ──────────────────────────

  /**
   * The products that can actually be transferred out of one branch.
   *
   * A product qualifies when at least one of its variants is available here,
   * judged by `decideSourceAvailability` — the very same function the size
   * cards use. That shared call is the whole point: the picker can never offer
   * a product whose every size then turns out to be greyed out.
   *
   * Each product appears exactly once no matter how many of its sizes qualify;
   * choosing between those sizes is the next step's job, not this one's.
   *
   * Deliberately one database round trip. The obvious implementation — list the
   * catalogue, then ask the size endpoint about each SKU in turn — would put
   * one request per product on a live server every time someone opens the
   * dropdown. Here the branch's balances are attached to the variants by a
   * filtered relation, so the answer costs a single query regardless of
   * catalogue size.
   *
   * Nothing about cost, price or the destination branch appears in the result:
   * none of it belongs in a picker, and the destination must have no influence
   * on what can be sent.
   */
  async sourceProducts(
    query: SourceProductsQuery,
    user: AuthenticatedUser,
  ): Promise<SourceProductsResponse> {
    // `sourceBranchId` is not the literal `branchId` the global BranchScopeGuard
    // looks for, so authorization is enforced here rather than assumed.
    if (user.role !== "OWNER" && !user.allowedBranches.includes(query.sourceBranchId)) {
      throw new BranchForbiddenError({
        reason: "UNAUTHORIZED_BRANCH_ACCESS",
        branchId: query.sourceBranchId,
      });
    }

    const branch = await this.prisma.branch.findUnique({
      where: { id: query.sourceBranchId },
      select: { id: true, nameAr: true, active: true },
    });
    if (!branch) {
      throw new NotFoundError({ reason: "SOURCE_BRANCH_NOT_FOUND", branchId: query.sourceBranchId });
    }
    if (!branch.active) {
      throw new ValidationError({
        reason: "SOURCE_BRANCH_INACTIVE",
        messageAr: `المخزن «${branch.nameAr}» غير نشط.`,
      });
    }

    // Delegated: the stock-adjustment picker asks the very same question, and
    // one definition of "this product exists in this branch" is the only way
    // the two screens can be guaranteed to agree.
    const found = await this.availability.productsInBranch(branch.id);

    return {
      sourceBranchId: branch.id,
      sourceBranchNameAr: branch.nameAr,
      products: found.map((p) => ({
        productSkuId: p.productSkuId,
        code: p.code,
        nameAr: p.nameAr,
        nameEn: p.nameEn,
        enabledSizeCount: p.availableSizeCount,
      })),
      committedChanges: 0,
    };
  }

  // ── source-stock size options (read-only) ────────────────────────────────

  /**
   * The sizes of one product that actually exist in one branch, as selectable
   * options.
   *
   * The list starts from the product's variants rather than from the balance
   * rows, because a standard ك or ص board with no stock still has to appear —
   * shown and disabled — so the user learns it is unavailable here instead of
   * wondering why it vanished. A variant with no balance row at all is simply a
   * variant at zero.
   *
   * Nothing is merged. Two custom variants that both wear the «م/خ» badge stay
   * two separate options, because the badge is a label and the variant is the
   * identity. Every option carries the exact `productVariantId` a transfer will
   * be posted against.
   *
   * This method only reads. It takes no lock and reserves nothing: availability
   * shown here is a snapshot, and the preview and confirmation re-read it under
   * lock before any stock moves.
   */
  async sourceSizeOptions(
    query: SourceSizeOptionsQuery,
    user: AuthenticatedUser,
  ): Promise<SourceSizeOptionsResponse> {
    // The global BranchScopeGuard only recognises a parameter literally named
    // `branchId`, so branch authorization for `sourceBranchId` is enforced here
    // rather than assumed.
    if (user.role !== "OWNER" && !user.allowedBranches.includes(query.sourceBranchId)) {
      throw new BranchForbiddenError({
        reason: "UNAUTHORIZED_BRANCH_ACCESS",
        branchId: query.sourceBranchId,
      });
    }

    const [branch, sku] = await Promise.all([
      this.prisma.branch.findUnique({
        where: { id: query.sourceBranchId },
        select: { id: true, nameAr: true, active: true },
      }),
      this.prisma.productSku.findUnique({
        where: { id: query.productSkuId },
        select: { id: true, code: true, colorNameAr: true, colorNameEn: true, active: true },
      }),
    ]);

    if (!branch) {
      throw new NotFoundError({ reason: "SOURCE_BRANCH_NOT_FOUND", branchId: query.sourceBranchId });
    }
    if (!branch.active) {
      throw new ValidationError({
        reason: "SOURCE_BRANCH_INACTIVE",
        messageAr: `المخزن «${branch.nameAr}» غير نشط.`,
      });
    }
    if (!sku) {
      throw new NotFoundError({ reason: "PRODUCT_NOT_FOUND", productSkuId: query.productSkuId });
    }
    if (!sku.active) {
      throw new ValidationError({
        reason: "PRODUCT_INACTIVE",
        messageAr: `الصنف «${sku.code}» غير نشط.`,
      });
    }

    const variants = await this.prisma.productVariant.findMany({
      where: { skuId: sku.id },
      select: { id: true, sizeMetersPerBoard: true, active: true },
    });

    const balances = variants.length
      ? await this.prisma.branchInventoryBalance.findMany({
          where: {
            branchId: branch.id,
            productVariantId: { in: variants.map((v) => v.id) },
          },
          select: { productVariantId: true, boardsOnHand: true, metersOnHand: true },
        })
      : [];
    const balanceByVariant = new Map(balances.map((b) => [b.productVariantId, b]));

    const options: SourceSizeOption[] = [];
    for (const variant of variants) {
      // A size that cannot be classified cannot be offered — but it also must
      // not take the whole list down with it.
      const display = tryClassifyTransferSizeOption({ sizeMetersPerBoard: variant.sizeMetersPerBoard });
      if (!display) continue;

      const balance = balanceByVariant.get(variant.id);
      const boards = D(balance?.boardsOnHand);
      const metres = D(balance?.metersOnHand);

      // The one shared definition of availability — the product picker asks the
      // very same question, so the two screens cannot drift apart.
      const { enabled, disabledReason, disabledReasonAr } = decideSourceAvailability({
        variantActive: variant.active,
        boards,
        metres,
      });

      options.push({
        productVariantId: variant.id,
        sizeBadge: display.badge,
        sizeBadgeAr: display.badgeAr,
        sizeBadgeEn: display.badgeEn,
        dimensionsLabelAr: display.dimensionsLabelAr,
        dimensionsLabelEn: display.dimensionsLabelEn,
        boardSizeMeters: display.boardSizeMeters,
        widthMeters: display.widthMeters,
        boardsAvailable: qty(boards),
        metersAvailable: qty(metres),
        enabled,
        disabledReason,
        disabledReasonAr,
        variantCode: sku.code,
        variantDisplayNameAr: `${sku.code} — ${sku.colorNameAr} — ${display.labelAr}`,
        variantDisplayNameEn: sku.colorNameEn ? `${sku.code} — ${sku.colorNameEn} — ${display.labelEn}` : null,
      });
    }

    // ك first, then ص, then the custom sizes ascending — the order a
    // storekeeper expects to scan, not database order.
    const rank: Record<string, number> = { LARGE: 0, SMALL: 1, CUSTOM: 2 };
    options.sort((a, b) => {
      const byBadge = (rank[a.sizeBadge] ?? 9) - (rank[b.sizeBadge] ?? 9);
      if (byBadge !== 0) return byBadge;
      return new Decimal(a.boardSizeMeters).comparedTo(new Decimal(b.boardSizeMeters));
    });

    return {
      sourceBranchId: branch.id,
      sourceBranchNameAr: branch.nameAr,
      productSkuId: sku.id,
      productCode: sku.code,
      productNameAr: sku.colorNameAr,
      productNameEn: sku.colorNameEn ?? null,
      options,
      committedChanges: 0,
    };
  }

  // ── draft lifecycle ──────────────────────────────────────────────────────

  /**
   * Codes that describe a moment rather than a mistake. A draft may be saved
   * while the source is short of stock — someone is planning a transfer for
   * later, and availability is re-read under a lock at confirmation anyway.
   * Saving them here and refusing them there is deliberate: the draft is a
   * plan, the confirmation is the authority.
   */
  private static readonly POINT_IN_TIME_CODES = new Set([
    "insufficient_source_stock",
    "inconsistent_source_balance",
    "INVENTORY_TRANSFER_WAC_UNAVAILABLE",
  ]);

  /**
   * A draft is refused only for things that will still be wrong tomorrow: an
   * unknown or inactive variant, an inactive branch, a duplicate line, a
   * quantity that is not a whole positive number of boards.
   */
  private assertDraftValid(resolved: {
    blocking: InventoryTransferIssue[];
    lines: Array<{ blocking: InventoryTransferIssue[] }>;
  }) {
    const all = [...resolved.blocking, ...resolved.lines.flatMap((l) => l.blocking)];
    const structural = all.filter(
      (i) => !InventoryTransfersService.POINT_IN_TIME_CODES.has(i.code),
    );
    if (structural.length) {
      throw new ValidationError({
        reason: "inventory_transfer_invalid",
        issues: structural.map((b) => b.code),
        messages: structural.map((b) => b.messageAr),
      });
    }
  }

  async create(body: CreateInventoryTransfer, user: AuthenticatedUser) {
    const resolved = await this.resolveLines(
      this.prisma,
      body.sourceBranchId,
      body.destinationBranchId,
      body.lines,
    );
    this.assertDraftValid(resolved);
    return this.prisma.runInTransaction(async (tx) => {
      const t = await tx.inventoryTransfer.create({
        data: {
          transferDate: new Date(body.transferDate),
          sourceBranchId: body.sourceBranchId,
          destinationBranchId: body.destinationBranchId,
          purpose: body.purpose ?? null,
          notes: body.notes ?? null,
          createdById: user.id,
          lines: {
            create: resolved.lines.map((l, i) => ({
              productVariantId: l.productVariantId,
              skuCode: l.skuCode,
              productNameAr: l.productNameAr,
              productNameEn: l.productNameEn,
              boardSizeMeters: rate(l.boardSize),
              boardQuantity: qty(l.boards),
              meterQuantity: qty(l.metres),
              // A draft carries no cost: the WAC that matters is the one at
              // confirmation, and pinning it earlier would be a lie the
              // document tells about when the stock actually moved.
              costPerMeter: "0",
              totalValue: "0",
              lineIndex: i,
            })),
          },
        },
        include: this.fullInclude(),
      });
      await this.writeAudit(
        tx,
        user,
        "CREATE",
        t,
        `أنشأ ${user.name} إذن تحويل مخزون ${formatTransferNumber(t.transferNumber)} كمسودة`,
      );
      return this.format(t);
    });
  }

  async update(id: string, body: UpdateInventoryTransfer, user: AuthenticatedUser) {
    const existing = await this.prisma.inventoryTransfer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranchScope(existing, user);
    if (existing.status !== "DRAFT") {
      throw new ValidationError({
        reason: "inventory_transfer_not_draft",
        status: existing.status,
      });
    }
    if (existing.version !== body.expectedVersion) {
      throw new ConflictError("errors.inventory_transfer_version_stale", {
        reason: "inventory_transfer_version_stale",
        expected: body.expectedVersion,
        actual: existing.version,
      });
    }
    const resolved = await this.resolveLines(
      this.prisma,
      body.sourceBranchId,
      body.destinationBranchId,
      body.lines,
    );
    this.assertDraftValid(resolved);
    return this.prisma.runInTransaction(async (tx) => {
      await tx.inventoryTransferLine.deleteMany({ where: { transferId: id } });
      const t = await tx.inventoryTransfer.update({
        where: { id },
        data: {
          transferDate: new Date(body.transferDate),
          sourceBranchId: body.sourceBranchId,
          destinationBranchId: body.destinationBranchId,
          purpose: body.purpose ?? null,
          notes: body.notes ?? null,
          updatedById: user.id,
          version: { increment: 1 },
          lines: {
            create: resolved.lines.map((l, i) => ({
              productVariantId: l.productVariantId,
              skuCode: l.skuCode,
              productNameAr: l.productNameAr,
              productNameEn: l.productNameEn,
              boardSizeMeters: rate(l.boardSize),
              boardQuantity: qty(l.boards),
              meterQuantity: qty(l.metres),
              costPerMeter: "0",
              totalValue: "0",
              lineIndex: i,
            })),
          },
        },
        include: this.fullInclude(),
      });
      await this.writeAudit(
        tx,
        user,
        "UPDATE",
        t,
        `عدّل ${user.name} مسودة إذن تحويل المخزون ${formatTransferNumber(t.transferNumber)}`,
      );
      return this.format(t);
    });
  }

  async remove(id: string, user: AuthenticatedUser) {
    const existing = await this.prisma.inventoryTransfer.findUnique({
      where: { id },
      include: this.fullInclude(),
    });
    if (!existing) throw new NotFoundError({ id });
    this.assertBranchScope(existing, user);
    if (existing.status !== "DRAFT") {
      throw new ValidationError({
        reason: "inventory_transfer_not_draft",
        status: existing.status,
      });
    }
    await this.prisma.runInTransaction(async (tx) => {
      await this.writeAudit(
        tx,
        user,
        "DELETE",
        existing,
        `حذف ${user.name} مسودة إذن تحويل المخزون ${formatTransferNumber(existing.transferNumber)}`,
      );
      await tx.inventoryTransfer.delete({ where: { id } });
    });
  }

  // ── preview (zero write) ─────────────────────────────────────────────────

  /** Preview for a payload that has not been saved. */
  async previewPayload(
    body: CreateInventoryTransfer,
    user: AuthenticatedUser,
  ): Promise<InventoryTransferPreview> {
    return this.buildPreview(this.prisma, {
      operation: "CONFIRM",
      transferId: null,
      transferNumber: null,
      status: null,
      transferDate: body.transferDate,
      sourceBranchId: body.sourceBranchId,
      destinationBranchId: body.destinationBranchId,
      lines: body.lines,
      actorId: user.id,
    });
  }

  /** Preview of confirming a saved draft. */
  async previewConfirm(id: string, user: AuthenticatedUser): Promise<InventoryTransferPreview> {
    const t = await this.loadForPreview(id, user);
    if (t.status !== "DRAFT") {
      throw new ValidationError({ reason: "inventory_transfer_not_draft", status: t.status });
    }
    return this.buildPreview(this.prisma, {
      operation: "CONFIRM",
      transferId: t.id,
      transferNumber: formatTransferNumber(t.transferNumber),
      status: t.status,
      version: t.version,
      transferDate: t.transferDate.toISOString().slice(0, 10),
      sourceBranchId: t.sourceBranchId,
      destinationBranchId: t.destinationBranchId,
      lines: t.lines.map((l) => ({
        productVariantId: l.productVariantId,
        boardQuantity: qty(D(l.boardQuantity)),
      })),
      quantitySource: "stored" as const,
      actorId: user.id,
    });
  }

  /**
   * Preview of cancelling a confirmed transfer. The direction is reversed: the
   * destination gives the stock back, so availability is checked THERE.
   */
  async previewCancel(id: string, user: AuthenticatedUser): Promise<InventoryTransferPreview> {
    const t = await this.loadForPreview(id, user);
    if (t.status !== "CONFIRMED") {
      throw new ValidationError({ reason: "inventory_transfer_not_confirmed", status: t.status });
    }
    return this.buildPreview(this.prisma, {
      operation: "CANCEL",
      transferId: t.id,
      transferNumber: formatTransferNumber(t.transferNumber),
      status: t.status,
      version: t.version,
      transferDate: t.transferDate.toISOString().slice(0, 10),
      // reversed on purpose
      sourceBranchId: t.destinationBranchId,
      destinationBranchId: t.sourceBranchId,
      lines: t.lines.map((l) => ({
        productVariantId: l.productVariantId,
        boardQuantity: qty(D(l.boardQuantity)),
      })),
      quantitySource: "stored" as const,
      actorId: user.id,
      // a cancellation returns the goods at the cost they left at
      frozenCost: new Map(t.lines.map((l) => [l.productVariantId, D(l.costPerMeter)])),
    });
  }

  private async loadForPreview(id: string, user: AuthenticatedUser) {
    const t = await this.prisma.inventoryTransfer.findUnique({
      where: { id },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });
    if (!t) throw new NotFoundError({ id });
    this.assertBranchScope(t, user);
    return t;
  }

  private async buildPreview(
    db: Tx | PrismaService,
    input: {
      operation: "CONFIRM" | "CANCEL";
      transferId: string | null;
      transferNumber: string | null;
      status: "DRAFT" | "CONFIRMED" | "CANCELLED" | null;
      version?: number;
      transferDate: string;
      sourceBranchId: string;
      destinationBranchId: string;
      lines: Array<{ productVariantId: string; boardQuantity: string }>;
      actorId: string;
      frozenCost?: Map<string, Decimal>;
      /** Stored quantities carry the column's trailing zeros; typed ones must not. */
      quantitySource?: "typed" | "stored";
    },
  ): Promise<InventoryTransferPreview> {
    const resolved = await this.resolveLines(
      db,
      input.sourceBranchId,
      input.destinationBranchId,
      input.lines,
      input.frozenCost,
      input.quantitySource ?? "typed",
    );
    const { source, destination } = resolved;

    const previewLines: InventoryTransferPreviewLine[] = resolved.lines.map((l) => {
      const srcBoardsAfter = l.sourceBoards.minus(l.boards);
      const srcMetresAfter = l.sourceMetres.minus(l.metres);
      const dstBoardsAfter = l.destinationBoards.plus(l.boards);
      const dstMetresAfter = l.destinationMetres.plus(l.metres);
      const globalValue = l.globalMetres.times(l.costPerMetre);
      return {
        productVariantId: l.productVariantId,
        skuCode: l.skuCode,
        productNameAr: l.productNameAr,
        productNameEn: l.productNameEn,
        boardSizeMeters: rate(l.boardSize),
        boardQuantity: qty(l.boards),
        meterQuantity: qty(l.metres),
        costPerMeter: rate(l.costPerMetre),
        totalValue: money(l.value),
        sourceBoardsBefore: qty(l.sourceBoards),
        sourceMetersBefore: qty(l.sourceMetres),
        sourceBoardsAfter: qty(srcBoardsAfter),
        sourceMetersAfter: qty(srcMetresAfter),
        destinationBoardsBefore: qty(l.destinationBoards),
        destinationMetersBefore: qty(l.destinationMetres),
        destinationBoardsAfter: qty(dstBoardsAfter),
        destinationMetersAfter: qty(dstMetresAfter),
        // Identical by construction — the transfer only moves stock between the
        // two branches, so the global figures are shown precisely so a reader
        // can see that they do not move.
        globalBoardsBefore: qty(l.globalBoards),
        globalBoardsAfter: qty(l.globalBoards),
        globalMetersBefore: qty(l.globalMetres),
        globalMetersAfter: qty(l.globalMetres),
        globalValueBefore: money(globalValue),
        globalValueAfter: money(globalValue),
        blocking: l.blocking,
      };
    });

    const totals = {
      lineCount: previewLines.length,
      boards: qty(resolved.lines.reduce((a, l) => a.plus(l.boards), new Decimal(0))),
      meters: qty(resolved.lines.reduce((a, l) => a.plus(l.metres), new Decimal(0))),
      value: money(resolved.lines.reduce((a, l) => a.plus(l.value), new Decimal(0))),
      globalBoardsBefore: qty(
        resolved.lines.reduce((a, l) => a.plus(l.globalBoards), new Decimal(0)),
      ),
      globalBoardsAfter: qty(
        resolved.lines.reduce((a, l) => a.plus(l.globalBoards), new Decimal(0)),
      ),
      globalMetersBefore: qty(
        resolved.lines.reduce((a, l) => a.plus(l.globalMetres), new Decimal(0)),
      ),
      globalMetersAfter: qty(
        resolved.lines.reduce((a, l) => a.plus(l.globalMetres), new Decimal(0)),
      ),
      globalValueBefore: money(
        resolved.lines.reduce(
          (a, l) => a.plus(l.globalMetres.times(l.costPerMetre)),
          new Decimal(0),
        ),
      ),
      globalValueAfter: money(
        resolved.lines.reduce(
          (a, l) => a.plus(l.globalMetres.times(l.costPerMetre)),
          new Decimal(0),
        ),
      ),
    };

    const fingerprint = this.fingerprint({
      operation: input.operation,
      transferId: input.transferId,
      version: input.version ?? null,
      transferDate: input.transferDate,
      sourceBranchId: input.sourceBranchId,
      destinationBranchId: input.destinationBranchId,
      actorId: input.actorId,
      // every input the calculation depended on
      state: resolved.lines.map((l) => ({
        v: l.productVariantId,
        b: qty(l.boards),
        size: rate(l.boardSize),
        wac: rate(l.costPerMetre),
        sb: qty(l.sourceBoards),
        sm: qty(l.sourceMetres),
        db: qty(l.destinationBoards),
        dm: qty(l.destinationMetres),
        active: l.variantActive,
      })),
      branches: { s: source?.active ?? null, d: destination?.active ?? null },
    });

    return {
      transferId: input.transferId,
      transferNumber: input.transferNumber,
      status: input.status,
      operation: input.operation,
      transferDate: input.transferDate,
      sourceBranch: { id: input.sourceBranchId, nameAr: source?.nameAr ?? "" },
      destinationBranch: { id: input.destinationBranchId, nameAr: destination?.nameAr ?? "" },
      lines: previewLines,
      totals,
      accountingEffect: "NONE",
      accountingReasonAr:
        "المخزون يظل مملوكًا للشركة نفسها، والنظام يستخدم حساب مخزون واحدًا مشتركًا لكل الفروع؛ " +
        "لذلك لا ينشأ عن التحويل أي قيد محاسبي، ولا يتغير إجمالي المخزون ولا متوسط التكلفة.",
      blocking: [...resolved.blocking, ...previewLines.flatMap((l) => l.blocking)],
      warnings: resolved.warnings,
      previewFingerprint: fingerprint,
      committedChanges: 0,
    };
  }

  private fingerprint(value: unknown): string {
    const canonical = (v: unknown): unknown => {
      if (v === null || typeof v !== "object") return v === undefined ? null : v;
      if (Array.isArray(v)) return v.map(canonical);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[k];
        if (inner === undefined) continue;
        out[k] = canonical(inner);
      }
      return out;
    };
    return createHash("sha256")
      .update(JSON.stringify(canonical(value)), "utf8")
      .digest("hex");
  }

  // ── shared resolution + validation ───────────────────────────────────────

  private async resolveLines(
    db: Tx | PrismaService,
    sourceBranchId: string,
    destinationBranchId: string,
    lines: Array<{ productVariantId: string; boardQuantity: string }>,
    frozenCost?: Map<string, Decimal>,
    quantitySource: "typed" | "stored" = "typed",
  ) {
    const blocking: InventoryTransferIssue[] = [];
    const warnings: InventoryTransferIssue[] = [];

    if (sourceBranchId === destinationBranchId) {
      blocking.push(issue("same_branch", "لا يمكن اختيار نفس المخزن كمصدر ومستلم."));
    }
    const [source, destination] = await Promise.all([
      db.branch.findUnique({
        where: { id: sourceBranchId },
        select: { id: true, nameAr: true, active: true },
      }),
      db.branch.findUnique({
        where: { id: destinationBranchId },
        select: { id: true, nameAr: true, active: true },
      }),
    ]);
    if (!source) blocking.push(issue("source_branch_not_found", "المخزن المصدر غير موجود."));
    else if (!source.active)
      blocking.push(issue("source_branch_inactive", `المخزن المصدر «${source.nameAr}» غير نشط.`));
    if (!destination)
      blocking.push(issue("destination_branch_not_found", "المخزن المستلم غير موجود."));
    else if (!destination.active)
      blocking.push(
        issue("destination_branch_inactive", `المخزن المستلم «${destination.nameAr}» غير نشط.`),
      );

    const ids = lines.map((l) => l.productVariantId);
    if (new Set(ids).size !== ids.length) {
      blocking.push(issue("duplicate_variant", "لا يمكن تكرار نفس الصنف والمقاس في أكثر من بند."));
    }

    const variants = await db.productVariant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        sizeMetersPerBoard: true,
        active: true,
        avgCostPerMeter: true,
        sku: { select: { code: true, colorNameAr: true, colorNameEn: true } },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));

    const balances = ids.length
      ? await db.branchInventoryBalance.findMany({
          where: {
            productVariantId: { in: ids },
            branchId: { in: [sourceBranchId, destinationBranchId] },
          },
        })
      : [];
    const globals = ids.length
      ? await db.branchInventoryBalance.groupBy({
          by: ["productVariantId"],
          where: { productVariantId: { in: ids } },
          _sum: { boardsOnHand: true, metersOnHand: true },
        })
      : [];
    const globalById = new Map(globals.map((g) => [g.productVariantId, g]));

    const resolved = lines.map((line) => {
      const lineBlocking: InventoryTransferIssue[] = [];
      const v = byId.get(line.productVariantId);
      const srcBal = balances.find(
        (b) => b.branchId === sourceBranchId && b.productVariantId === line.productVariantId,
      );
      const dstBal = balances.find(
        (b) => b.branchId === destinationBranchId && b.productVariantId === line.productVariantId,
      );
      const g = globalById.get(line.productVariantId);

      if (!v) {
        lineBlocking.push(
          issue("variant_not_found", "الصنف أو المقاس غير متاح.", {
            productVariantId: line.productVariantId,
          }),
        );
      } else if (!v.active) {
        lineBlocking.push(
          issue("variant_inactive", `الصنف «${v.sku.code}» غير نشط.`, { productVariantId: v.id }),
        );
      }

      const boardSize = v ? D(v.sizeMetersPerBoard) : new Decimal(0);
      // The WAC a cancellation returns goods at is the one they LEFT at, so a
      // later purchase cannot change what a reversal is worth.
      const costPerMetre =
        frozenCost?.get(line.productVariantId) ?? (v ? D(v.avgCostPerMeter) : new Decimal(0));

      let boards = new Decimal(0);
      let metres = new Decimal(0);
      let value = new Decimal(0);
      try {
        const m = computeLine({
          boardQuantity: line.boardQuantity,
          boardSize,
          costPerMetre,
          source: quantitySource,
        });
        boards = m.boards;
        metres = m.metres;
        value = m.value;
      } catch (e) {
        const code = e instanceof TransferMathError ? e.code : "line_calculation_failed";
        lineBlocking.push(
          issue(
            code,
            code === "board_quantity_must_be_whole" || code === "board_quantity_must_be_positive"
              ? "يجب إدخال عدد ألواح صحيح أكبر من صفر."
              : code === "board_size_invalid"
                ? "الصنف أو المقاس غير متاح."
                : "تعذّر احتساب بنود التحويل.",
            { productVariantId: line.productVariantId },
          ),
        );
      }

      const sourceBoards = D(srcBal?.boardsOnHand);
      const sourceMetres = D(srcBal?.metersOnHand);
      const destinationBoards = D(dstBal?.boardsOnHand);
      const destinationMetres = D(dstBal?.metersOnHand);

      if (v && boards.gt(0)) {
        if (sourceBoards.lt(boards) || sourceMetres.lt(metres)) {
          lineBlocking.push(
            issue(
              "insufficient_source_stock",
              `الرصيد المتاح في المخزن المصدر غير كافٍ للصنف «${v.sku.code}» ` +
                `(المتاح ${qty(sourceBoards)} لوح / ${qty(sourceMetres)} متر، المطلوب ${qty(boards)} لوح / ${qty(metres)} متر).`,
              { productVariantId: v.id },
            ),
          );
        }
        // A board count and a metre count that disagree about whether there is
        // stock is a pre-existing data problem. Refuse to move it and say which
        // row it is, rather than quietly "fixing" someone else's data.
        if (sourceBoards.isZero() !== sourceMetres.isZero()) {
          lineBlocking.push(
            issue(
              "inconsistent_source_balance",
              `رصيد الصنف «${v.sku.code}» في المخزن المصدر غير متسق (${qty(sourceBoards)} لوح مقابل ${qty(sourceMetres)} متر). ` +
                "يرجى مراجعة المخزون قبل التحويل.",
              { productVariantId: v.id, branchId: sourceBranchId },
            ),
          );
        }
        if (costPerMetre.lte(0) && sourceMetres.gt(0)) {
          lineBlocking.push(
            issue(
              "INVENTORY_TRANSFER_WAC_UNAVAILABLE",
              `لا يوجد متوسط تكلفة صالح للصنف «${v.sku.code}»، ولا يمكن تحويل مخزون بدون تكلفة معروفة.`,
              { productVariantId: v.id, branchId: sourceBranchId },
            ),
          );
        }
      }

      return {
        productVariantId: line.productVariantId,
        skuCode: v?.sku.code ?? "",
        productNameAr: v?.sku.colorNameAr ?? "",
        productNameEn: v?.sku.colorNameEn ?? null,
        variantActive: v?.active ?? false,
        boardSize,
        boards,
        metres,
        costPerMetre,
        value,
        sourceBoards,
        sourceMetres,
        destinationBoards,
        destinationMetres,
        globalBoards: D(g?._sum.boardsOnHand),
        globalMetres: D(g?._sum.metersOnHand),
        blocking: lineBlocking,
      };
    });

    return { blocking, warnings, lines: resolved, source, destination };
  }

  /** Actors are selected down to id + name — a password hash has no business
   *  being loaded to render a transfer document. */
  private fullInclude() {
    const actor = { select: { id: true, name: true } };
    return {
      sourceBranch: { select: { id: true, nameAr: true } },
      destinationBranch: { select: { id: true, nameAr: true } },
      creator: actor,
      updater: actor,
      confirmer: actor,
      canceller: actor,
      lines: { orderBy: { lineIndex: "asc" as const } },
    };
  }

  private async writeAudit(
    tx: Tx,
    user: AuthenticatedUser,
    action: "CREATE" | "UPDATE" | "DELETE" | "CONFIRM" | "CANCEL",
    t: AuditableTransfer,
    summaryAr: string,
    extra: Record<string, unknown> = {},
  ) {
    await this.audit.write({
      tx,
      actorId: user.id,
      action,
      entityType: "inventory_transfer",
      entityId: t.id,
      afterSnapshot: {
        transferNumber: formatTransferNumber(t.transferNumber),
        status: t.status,
        sourceBranchId: t.sourceBranchId,
        destinationBranchId: t.destinationBranchId,
        productVariantIds: t.lines.map((l) => l.productVariantId),
        totalBoards: qty(t.lines.reduce((a, l) => a.plus(D(l.boardQuantity)), new Decimal(0))),
        totalMeters: qty(t.lines.reduce((a, l) => a.plus(D(l.meterQuantity)), new Decimal(0))),
        ...extra,
      },
      summaryAr,
      summaryEn: `${user.name} ${action.toLowerCase()} inventory transfer ${formatTransferNumber(t.transferNumber)}`,
    });
  }

  // ── confirm ──────────────────────────────────────────────────────────────

  async confirm(id: string, body: ConfirmInventoryTransfer, user: AuthenticatedUser) {
    // Idempotency barrier outside the transaction: a retry after a successful
    // commit never opens one.
    const replayed = await this.prisma.inventoryTransfer.findUnique({
      where: { confirmationIdempotencyKey: body.idempotencyKey },
      include: this.fullInclude(),
    });
    if (replayed) return { ...this.format(replayed), idempotentReplay: true };

    return this.withDeadlockRetry(() =>
      this.prisma.runInTransaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM inventory_transfers WHERE id = ${id}::uuid FOR UPDATE`;
          const inside = await tx.inventoryTransfer.findUnique({
            where: { confirmationIdempotencyKey: body.idempotencyKey },
            include: this.fullInclude(),
          });
          if (inside) return { ...this.format(inside), idempotentReplay: true };

          const t = await tx.inventoryTransfer.findUnique({
            where: { id },
            include: { lines: { orderBy: { lineIndex: "asc" } } },
          });
          if (!t) throw new NotFoundError({ id });
          this.assertBranchScope(t, user);
          if (t.status !== "DRAFT") {
            throw new ValidationError({
              reason: "inventory_transfer_already_posted",
              status: t.status,
            });
          }
          if (t.version !== body.expectedVersion) {
            throw new ConflictError("errors.inventory_transfer_version_stale", {
              reason: "inventory_transfer_version_stale",
              expected: body.expectedVersion,
              actual: t.version,
            });
          }

          await this.lockForPosting(
            tx,
            t.lines.map((l) => l.productVariantId),
            [t.sourceBranchId, t.destinationBranchId],
          );

          // Recompute AFTER the locks: everything the preview showed is re-read
          // under the lock and the fingerprint must still match, so a stale
          // approval cannot post.
          const preview = await this.buildPreview(tx, {
            operation: "CONFIRM",
            transferId: t.id,
            transferNumber: formatTransferNumber(t.transferNumber),
            status: t.status,
            version: t.version,
            transferDate: t.transferDate.toISOString().slice(0, 10),
            sourceBranchId: t.sourceBranchId,
            destinationBranchId: t.destinationBranchId,
            lines: t.lines.map((l) => ({
              productVariantId: l.productVariantId,
              boardQuantity: qty(D(l.boardQuantity)),
            })),
            quantitySource: "stored" as const,
            actorId: user.id,
          });
          this.assertPreviewUsable(preview, body.previewFingerprint);

          const movementIds = await this.postPair(tx, {
            transfer: t,
            lines: preview.lines,
            fromBranchId: t.sourceBranchId,
            toBranchId: t.destinationBranchId,
            referenceType: "inventory_transfer",
            user,
            noteAr: (dir) =>
              dir === "OUT"
                ? `تحويل صادر إلى ${preview.destinationBranch.nameAr} — ${formatTransferNumber(t.transferNumber)}`
                : `تحويل وارد من ${preview.sourceBranch.nameAr} — ${formatTransferNumber(t.transferNumber)}`,
          });

          for (const line of t.lines) {
            const p = preview.lines.find((x) => x.productVariantId === line.productVariantId)!;
            const ids = movementIds.get(line.productVariantId)!;
            await tx.inventoryTransferLine.update({
              where: { id: line.id },
              data: {
                // The cost snapshot is written at confirmation, when the stock
                // actually moved — not when the draft was typed.
                costPerMeter: p.costPerMeter,
                totalValue: p.totalValue,
                sourceMovementId: ids.out,
                destinationMovementId: ids.in,
              },
            });
          }

          const confirmed = await tx.inventoryTransfer.update({
            where: { id },
            data: {
              status: "CONFIRMED",
              confirmedById: user.id,
              confirmedAt: new Date(),
              version: { increment: 1 },
              confirmationIdempotencyKey: body.idempotencyKey,
              confirmationFingerprint: body.previewFingerprint,
            },
            include: this.fullInclude(),
          });

          await this.assertConservation(
            tx,
            confirmed.lines.map((l) => l.productVariantId),
            preview,
          );

          await this.writeAudit(
            tx,
            user,
            "CONFIRM",
            confirmed,
            `اعتمد ${user.name} إذن تحويل المخزون ${formatTransferNumber(confirmed.transferNumber)} ` +
              `من ${preview.sourceBranch.nameAr} إلى ${preview.destinationBranch.nameAr}`,
            { movementIds: [...movementIds.values()].flatMap((m) => [m.out, m.in]) },
          );

          return { ...this.format(confirmed), idempotentReplay: false };
        },
        // A multi-line transfer is ~5 round trips per leg; the default 10s is
        // tight for a large document.
        { timeoutMs: 30_000 },
      ),
    );
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  async cancel(id: string, body: CancelInventoryTransfer, user: AuthenticatedUser) {
    const replayed = await this.prisma.inventoryTransfer.findUnique({
      where: { cancellationIdempotencyKey: body.idempotencyKey },
      include: this.fullInclude(),
    });
    if (replayed) return { ...this.format(replayed), idempotentReplay: true };

    return this.withDeadlockRetry(() =>
      this.prisma.runInTransaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM inventory_transfers WHERE id = ${id}::uuid FOR UPDATE`;
          const inside = await tx.inventoryTransfer.findUnique({
            where: { cancellationIdempotencyKey: body.idempotencyKey },
            include: this.fullInclude(),
          });
          if (inside) return { ...this.format(inside), idempotentReplay: true };

          const t = await tx.inventoryTransfer.findUnique({
            where: { id },
            include: { lines: { orderBy: { lineIndex: "asc" } } },
          });
          if (!t) throw new NotFoundError({ id });
          this.assertBranchScope(t, user);
          if (t.status === "CANCELLED") {
            throw new ValidationError({ reason: "inventory_transfer_already_cancelled" });
          }
          if (t.status !== "CONFIRMED") {
            throw new ValidationError({
              reason: "inventory_transfer_not_confirmed",
              status: t.status,
            });
          }
          if (t.version !== body.expectedVersion) {
            throw new ConflictError("errors.inventory_transfer_version_stale", {
              reason: "inventory_transfer_version_stale",
              expected: body.expectedVersion,
              actual: t.version,
            });
          }

          await this.lockForPosting(
            tx,
            t.lines.map((l) => l.productVariantId),
            [t.sourceBranchId, t.destinationBranchId],
          );

          const preview = await this.buildPreview(tx, {
            operation: "CANCEL",
            transferId: t.id,
            transferNumber: formatTransferNumber(t.transferNumber),
            status: t.status,
            version: t.version,
            transferDate: t.transferDate.toISOString().slice(0, 10),
            sourceBranchId: t.destinationBranchId,
            destinationBranchId: t.sourceBranchId,
            lines: t.lines.map((l) => ({
              productVariantId: l.productVariantId,
              boardQuantity: qty(D(l.boardQuantity)),
            })),
            quantitySource: "stored" as const,
            actorId: user.id,
            frozenCost: new Map(t.lines.map((l) => [l.productVariantId, D(l.costPerMeter)])),
          });
          this.assertPreviewUsable(preview, body.previewFingerprint, "cancel");

          const movementIds = await this.postPair(tx, {
            transfer: t,
            lines: preview.lines,
            // reversed: the destination gives the goods back
            fromBranchId: t.destinationBranchId,
            toBranchId: t.sourceBranchId,
            referenceType: "inventory_transfer_cancel",
            user,
            noteAr: (dir) =>
              dir === "OUT"
                ? `إلغاء تحويل — إخراج من ${preview.sourceBranch.nameAr} — ${formatTransferNumber(t.transferNumber)}`
                : `إلغاء تحويل — إعادة إلى ${preview.destinationBranch.nameAr} — ${formatTransferNumber(t.transferNumber)}`,
          });

          for (const line of t.lines) {
            const ids = movementIds.get(line.productVariantId)!;
            await tx.inventoryTransferLine.update({
              where: { id: line.id },
              // Quantities and the original cost snapshot are NOT touched — only
              // the reversal movement back-references are filled in. The database
              // trigger enforces exactly that.
              data: { cancelDestinationMovementId: ids.out, cancelSourceMovementId: ids.in },
            });
          }

          const cancelled = await tx.inventoryTransfer.update({
            where: { id },
            data: {
              status: "CANCELLED",
              cancelledById: user.id,
              cancelledAt: new Date(),
              cancellationReason: body.reason.trim(),
              version: { increment: 1 },
              cancellationIdempotencyKey: body.idempotencyKey,
              cancellationFingerprint: body.previewFingerprint,
            },
            include: this.fullInclude(),
          });

          await this.assertConservation(
            tx,
            cancelled.lines.map((l) => l.productVariantId),
            preview,
          );

          await this.writeAudit(
            tx,
            user,
            "CANCEL",
            cancelled,
            `ألغى ${user.name} إذن تحويل المخزون ${formatTransferNumber(cancelled.transferNumber)}: ${body.reason.trim()}`,
            {
              reason: body.reason.trim(),
              movementIds: [...movementIds.values()].flatMap((m) => [m.out, m.in]),
            },
          );

          return { ...this.format(cancelled), idempotentReplay: false };
        },
        { timeoutMs: 30_000 },
      ),
    );
  }

  // ── posting internals ────────────────────────────────────────────────────

  /**
   * Postgres reports a deadlock as SQLSTATE 40P01 and a serialization failure
   * as 40001. Prisma surfaces both inconsistently — sometimes as P2034,
   * sometimes as a raw-query error whose text carries the code — so all three
   * shapes are recognised.
   */
  private static isSerializationFailure(e: unknown): boolean {
    const code = (e as { code?: string }).code;
    if (code === "P2034" || code === "40P01" || code === "40001") return true;
    const message = (e as Error)?.message ?? "";
    return /40P01|40001|deadlock detected|could not serialize/i.test(message);
  }

  /**
   * Retries the whole transaction when Postgres aborts it as a deadlock victim.
   *
   * This is needed because two lock orders already coexist in this codebase and
   * disagree: the costing paths (purchase confirm, returns, revisions) take
   * `product_variants FOR UPDATE` and then the balance row, while the bare
   * engine paths (receipts, adjustments, counts) take the balance row first and
   * only then touch the variant — the movement INSERT takes `FOR KEY SHARE` on
   * it, which conflicts with `FOR UPDATE`. A transfer has to choose one order,
   * and either choice can interleave badly with the other family.
   *
   * Rather than reorder somebody else's working code to suit this feature, the
   * transfer absorbs the collision. A deadlock rolls the transaction back
   * completely — including the idempotency key, which is written inside it — so
   * a retry starts from a clean slate and re-validates everything under fresh
   * locks. It cannot double-apply. Business failures are not retried: they will
   * fail again, and re-running them would only delay the answer.
   */
  private async withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (e) {
        if (attempt >= maxAttempts || !InventoryTransfersService.isSerializationFailure(e)) throw e;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  private assertPreviewUsable(
    preview: InventoryTransferPreview,
    fingerprint: string,
    op: "confirm" | "cancel" = "confirm",
  ) {
    if (preview.blocking.length > 0) {
      throw new ValidationError({
        reason:
          op === "cancel" ? "inventory_transfer_cancel_blocked" : "inventory_transfer_blocked",
        issues: preview.blocking.map((b) => b.code),
        messages: preview.blocking.map((b) => b.messageAr),
      });
    }
    if (preview.previewFingerprint !== fingerprint) {
      throw new ConflictError("errors.inventory_transfer_preview_stale", {
        reason: "inventory_transfer_preview_stale",
        expected: fingerprint,
        actual: preview.previewFingerprint,
      });
    }
  }

  /**
   * The lock discipline the whole feature rests on.
   *
   * Variants first, sorted by id, then balance rows sorted by (branch, variant)
   * — both pre-inserted so the engine's own upsert becomes a no-op re-lock.
   * Two things make this mandatory rather than cautious: every costing path
   * (purchase confirm, both return services, both revision services) takes the
   * variant `FOR UPDATE` first, so touching a balance before the variant would
   * deadlock against a concurrent purchase; and transfer A→B racing B→A would
   * take the two balance rows in opposite orders without a canonical sort.
   */
  private async lockForPosting(tx: Tx, variantIds: string[], branchIds: string[]) {
    for (const vid of [...new Set(variantIds)].sort()) {
      await tx.$queryRaw`SELECT id FROM product_variants WHERE id = ${vid}::uuid FOR UPDATE`;
    }
    const pairs: Array<[string, string]> = [];
    for (const b of branchIds) for (const v of new Set(variantIds)) pairs.push([b, v]);
    pairs.sort((x, y) => (x[0] === y[0] ? x[1].localeCompare(y[1]) : x[0].localeCompare(y[0])));
    for (const [branchId, variantId] of pairs) {
      await tx.$executeRaw`
        INSERT INTO branch_inventory_balances
          (branch_id, product_variant_id, boards_on_hand, meters_on_hand, updated_at)
        VALUES (${branchId}::uuid, ${variantId}::uuid, 0, 0, NOW())
        ON CONFLICT (branch_id, product_variant_id) DO NOTHING
      `;
      await tx.$queryRaw`
        SELECT boards_on_hand FROM branch_inventory_balances
        WHERE branch_id = ${branchId}::uuid AND product_variant_id = ${variantId}::uuid
        FOR UPDATE
      `;
    }
  }

  /**
   * Creates the two movements of one leg pair per line, in add-then-subtract
   * order so a same-variant round trip can never trip the engine's
   * non-negative guard on an intermediate state.
   */
  private async postPair(
    tx: Tx,
    input: {
      transfer: { id: string; transferNumber: bigint };
      lines: InventoryTransferPreviewLine[];
      fromBranchId: string;
      toBranchId: string;
      referenceType: string;
      user: AuthenticatedUser;
      noteAr: (dir: "OUT" | "IN") => string;
    },
  ): Promise<Map<string, { out: string; in: string }>> {
    const result = new Map<string, { out: string; in: string }>();
    const num = formatTransferNumber(input.transfer.transferNumber);

    for (const line of input.lines) {
      const boards = new Decimal(line.boardQuantity);
      const metres = new Decimal(line.meterQuantity);
      const value = new Decimal(line.totalValue);

      // Equal and opposite, checked before either row exists.
      assertPairConserves({
        sourceBoardsDelta: boards.negated(),
        destinationBoardsDelta: boards,
        sourceMetresDelta: metres.negated(),
        destinationMetresDelta: metres,
        sourceValueDelta: value.negated(),
        destinationValueDelta: value,
      });

      const received = await this.inventory.apply({
        branchId: input.toBranchId,
        productVariantId: line.productVariantId,
        movementType: "TRANSFER_IN",
        boardsDelta: boards.toFixed(4),
        metersDelta: metres.toFixed(4),
        reference: { type: input.referenceType, id: input.transfer.id },
        actor: input.user,
        summaryAr: input.noteAr("IN"),
        summaryEn: `Transfer in — ${num}`,
        humanReadableNote: input.noteAr("IN"),
        tx,
      });

      const issued = await this.inventory.apply({
        branchId: input.fromBranchId,
        productVariantId: line.productVariantId,
        movementType: "TRANSFER_OUT",
        boardsDelta: boards.negated().toFixed(4),
        metersDelta: metres.negated().toFixed(4),
        reference: { type: input.referenceType, id: input.transfer.id },
        actor: input.user,
        summaryAr: input.noteAr("OUT"),
        summaryEn: `Transfer out — ${num}`,
        humanReadableNote: input.noteAr("OUT"),
        tx,
      });

      result.set(line.productVariantId, { out: issued.movementId, in: received.movementId });
    }
    return result;
  }

  /**
   * The promise, verified rather than asserted: after posting, every touched
   * variant holds exactly the boards, metres and value it held before, and its
   * shared cost is untouched. If any of that is false the transaction rolls
   * back and nothing moved.
   */
  private async assertConservation(
    tx: Tx,
    variantIds: string[],
    preview: InventoryTransferPreview,
  ) {
    const ids = [...new Set(variantIds)];
    const after = await tx.branchInventoryBalance.groupBy({
      by: ["productVariantId"],
      where: { productVariantId: { in: ids } },
      _sum: { boardsOnHand: true, metersOnHand: true },
    });
    const variants = await tx.productVariant.findMany({
      where: { id: { in: ids } },
      select: { id: true, avgCostPerMeter: true },
    });
    const wacById = new Map(variants.map((v) => [v.id, D(v.avgCostPerMeter)]));

    for (const line of preview.lines) {
      const a = after.find((x) => x.productVariantId === line.productVariantId);
      const boardsAfter = D(a?._sum.boardsOnHand);
      const metresAfter = D(a?._sum.metersOnHand);
      if (!boardsAfter.equals(new Decimal(line.globalBoardsBefore))) {
        throw new ValidationError({
          reason: "inventory_transfer_boards_not_conserved",
          productVariantId: line.productVariantId,
          before: line.globalBoardsBefore,
          after: qty(boardsAfter),
        });
      }
      if (!metresAfter.equals(new Decimal(line.globalMetersBefore))) {
        throw new ValidationError({
          reason: "inventory_transfer_metres_not_conserved",
          productVariantId: line.productVariantId,
          before: line.globalMetersBefore,
          after: qty(metresAfter),
        });
      }
      const wacAfter = wacById.get(line.productVariantId) ?? new Decimal(0);
      if (!wacAfter.equals(new Decimal(line.costPerMeter)) && preview.operation === "CONFIRM") {
        throw new ValidationError({
          reason: "inventory_transfer_wac_changed",
          productVariantId: line.productVariantId,
          before: line.costPerMeter,
          after: rate(wacAfter),
        });
      }
    }
  }
}
