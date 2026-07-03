import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import {
  CreateFixedAssetSchema,
  UpdateFixedAssetSchema,
  RunDepreciationSchema,
  type CreateFixedAsset,
  type UpdateFixedAsset,
  type RunDepreciation,
} from "@shorok/shared";
import Decimal from "decimal.js";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError, ValidationError, ConflictError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller("fixed-assets")
export class FixedAssetsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /fixed-assets — list all assets with computed figures
  // ---------------------------------------------------------------------------
  @Get()
  async list() {
    const assets = await this.prisma.fixedAsset.findMany({
      orderBy: { code: "asc" },
      include: {
        assetAccount: { select: { id: true, code: true, nameAr: true } },
        accumulatedDepAccount: { select: { id: true, code: true, nameAr: true } },
        depreciationExpenseAccount: { select: { id: true, code: true, nameAr: true } },
        depreciationEntries: { select: { amount: true } },
      },
    });

    return assets.map((a) => this._formatSummary(a));
  }

  // ---------------------------------------------------------------------------
  // GET /fixed-assets/:id — single asset with full depreciation entries
  // ---------------------------------------------------------------------------
  @Get(":id")
  async getOne(@Param("id") id: string) {
    const asset = await this.prisma.fixedAsset.findUnique({
      where: { id },
      include: {
        assetAccount: { select: { id: true, code: true, nameAr: true } },
        accumulatedDepAccount: { select: { id: true, code: true, nameAr: true } },
        depreciationExpenseAccount: { select: { id: true, code: true, nameAr: true } },
        depreciationEntries: {
          orderBy: { periodDate: "asc" },
          select: {
            id: true,
            periodDate: true,
            amount: true,
            journalEntryId: true,
            notes: true,
            createdAt: true,
          },
        },
      },
    });

    if (!asset) throw new NotFoundError({ id });
    return this._formatDetail(asset);
  }

  // ---------------------------------------------------------------------------
  // POST /fixed-assets — create
  // ---------------------------------------------------------------------------
  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateFixedAssetSchema)) body: CreateFixedAsset,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const asset = await tx.fixedAsset.create({
        data: {
          code: body.code,
          nameAr: body.nameAr,
          nameEn: body.nameEn ?? "",
          acquisitionDate: new Date(body.acquisitionDate),
          acquisitionCost: new Decimal(body.acquisitionCost),
          salvageValue: new Decimal(body.salvageValue ?? "0"),
          usefulLifeMonths: body.usefulLifeMonths,
          depreciationMethod: body.depreciationMethod ?? "STRAIGHT_LINE",
          assetAccountId: body.assetAccountId,
          accumulatedDepAccountId: body.accumulatedDepAccountId,
          depreciationExpenseAccountId: body.depreciationExpenseAccountId,
          notes: body.notes ?? null,
          createdBy: user.id,
        },
        include: {
          assetAccount: { select: { id: true, code: true, nameAr: true } },
          accumulatedDepAccount: { select: { id: true, code: true, nameAr: true } },
          depreciationExpenseAccount: { select: { id: true, code: true, nameAr: true } },
          depreciationEntries: true,
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "fixed_asset",
        entityId: asset.id,
        afterSnapshot: { code: asset.code, nameAr: asset.nameAr, acquisitionCost: asset.acquisitionCost.toFixed(2) },
        summaryAr: `${user.name} أضاف أصلاً ثابتاً: ${asset.nameAr} (${asset.code})`,
        summaryEn: `${user.name} created fixed asset: ${asset.nameAr} (${asset.code})`,
      });

      return this._formatDetail(asset);
    });
  }

  // ---------------------------------------------------------------------------
  // PUT /fixed-assets/:id — update nameAr, nameEn, notes, active
  // ---------------------------------------------------------------------------
  @Put(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateFixedAssetSchema)) body: UpdateFixedAsset,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.fixedAsset.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError({ id });

      const asset = await tx.fixedAsset.update({
        where: { id },
        data: {
          nameAr: body.nameAr !== undefined ? body.nameAr : existing.nameAr,
          nameEn: body.nameEn !== undefined ? body.nameEn : existing.nameEn,
          notes: body.notes !== undefined ? body.notes : existing.notes,
          active: body.active !== undefined ? body.active : existing.active,
        },
        include: {
          assetAccount: { select: { id: true, code: true, nameAr: true } },
          accumulatedDepAccount: { select: { id: true, code: true, nameAr: true } },
          depreciationExpenseAccount: { select: { id: true, code: true, nameAr: true } },
          depreciationEntries: {
            orderBy: { periodDate: "asc" },
            select: { id: true, periodDate: true, amount: true, journalEntryId: true, notes: true, createdAt: true },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "fixed_asset",
        entityId: id,
        beforeSnapshot: { nameAr: existing.nameAr, active: existing.active },
        afterSnapshot: { nameAr: asset.nameAr, active: asset.active },
        summaryAr: `${user.name} عدّل الأصل الثابت: ${asset.nameAr}`,
        summaryEn: `${user.name} updated fixed asset: ${asset.nameAr}`,
      });

      return this._formatDetail(asset);
    });
  }

  // ---------------------------------------------------------------------------
  // DELETE /fixed-assets/:id — soft delete (OWNER only)
  // ---------------------------------------------------------------------------
  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.fixedAsset.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError({ id });

      await tx.fixedAsset.update({ where: { id }, data: { active: false } });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "fixed_asset",
        entityId: id,
        beforeSnapshot: { code: existing.code, nameAr: existing.nameAr },
        summaryAr: `${user.name} أوقف الأصل الثابت: ${existing.nameAr}`,
        summaryEn: `${user.name} deactivated fixed asset: ${existing.nameAr}`,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // POST /fixed-assets/:id/depreciate — record a depreciation period
  // ---------------------------------------------------------------------------
  @Post(":id/depreciate")
  @Roles("OWNER", "ACCOUNTANT")
  async depreciate(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RunDepreciationSchema)) body: RunDepreciation,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const asset = await tx.fixedAsset.findUnique({
        where: { id },
        include: { depreciationEntries: { select: { amount: true, periodDate: true } } },
      });
      if (!asset) throw new NotFoundError({ id });

      const acquisitionCost = new Decimal(asset.acquisitionCost);
      const salvageValue = new Decimal(asset.salvageValue);
      const depreciableBase = acquisitionCost.minus(salvageValue);
      const monthlyAmount = depreciableBase.dividedBy(asset.usefulLifeMonths);

      const totalDepreciated = asset.depreciationEntries.reduce(
        (acc, e) => acc.plus(new Decimal(e.amount)),
        new Decimal(0),
      );
      const bookValue = acquisitionCost.minus(salvageValue).minus(totalDepreciated);

      // Check if already fully depreciated
      if (bookValue.lessThanOrEqualTo(0)) {
        throw new ValidationError({ reason: "asset_fully_depreciated" });
      }

      // Check if period already has an entry
      const periodDate = new Date(body.periodDate);
      const existing = await tx.depreciationEntry.findUnique({
        where: { assetId_periodDate: { assetId: id, periodDate } },
      });
      if (existing) {
        throw new ConflictError("errors.conflict", { reason: "period_already_depreciated", periodDate: body.periodDate });
      }

      // Clamp amount: don't depreciate below salvage value
      const clampedAmount = Decimal.min(monthlyAmount, bookValue);

      // Create depreciation entry
      const entry = await tx.depreciationEntry.create({
        data: {
          assetId: id,
          periodDate,
          amount: clampedAmount,
          notes: body.notes ?? null,
          createdBy: user.id,
        },
      });

      let journalEntryId: string | null = null;

      if (body.postJournalEntry) {
        const periodStr = body.periodDate;
        const je = await tx.journalEntry.create({
          data: {
            entryType:     "ADJUSTMENT",
            reference:     asset.code,
            entryDate:     periodDate,
            description:   `استهلاك ${asset.nameAr} - ${periodStr}`,
            referenceType: "depreciation_entry",
            referenceId:   entry.id,
            createdBy:     user.id,
            lines: {
              create: [
                {
                  accountId: asset.depreciationExpenseAccountId,
                  debit: clampedAmount,
                  credit: new Decimal(0),
                  note: `استهلاك ${asset.nameAr}`,
                },
                {
                  accountId: asset.accumulatedDepAccountId,
                  debit: new Decimal(0),
                  credit: clampedAmount,
                  note: `مجمع استهلاك ${asset.nameAr}`,
                },
              ],
            },
          },
        });
        journalEntryId = je.id;

        // Link the journal entry to the depreciation entry
        await tx.depreciationEntry.update({
          where: { id: entry.id },
          data: { journalEntryId: je.id },
        });
      }

      const newTotalDepreciated = totalDepreciated.plus(clampedAmount);
      const newBookValue = acquisitionCost.minus(salvageValue).minus(newTotalDepreciated);

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "depreciation_entry",
        entityId: entry.id,
        afterSnapshot: {
          assetCode: asset.code,
          periodDate: body.periodDate,
          amount: clampedAmount.toFixed(2),
          journalEntryId,
        },
        summaryAr: `${user.name} سجّل استهلاك ${asset.nameAr} لفترة ${body.periodDate} بمبلغ ${clampedAmount.toFixed(2)}`,
        summaryEn: `${user.name} posted depreciation for ${asset.nameAr} period ${body.periodDate} amount ${clampedAmount.toFixed(2)}`,
      });

      return {
        id: entry.id,
        periodDate: entry.periodDate.toISOString().slice(0, 10),
        amount: clampedAmount.toFixed(2),
        journalEntryId: journalEntryId,
        notes: entry.notes,
        createdAt: entry.createdAt.toISOString(),
        bookValue: Decimal.max(newBookValue, new Decimal(0)).toFixed(2),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // GET /fixed-assets/:id/schedule — full calculated depreciation schedule
  // ---------------------------------------------------------------------------
  @Get(":id/schedule")
  async schedule(@Param("id") id: string) {
    const asset = await this.prisma.fixedAsset.findUnique({
      where: { id },
      include: {
        depreciationEntries: {
          select: { id: true, periodDate: true, amount: true },
          orderBy: { periodDate: "asc" },
        },
      },
    });
    if (!asset) throw new NotFoundError({ id });

    const acquisitionCost = new Decimal(asset.acquisitionCost);
    const salvageValue = new Decimal(asset.salvageValue);
    const depreciableBase = acquisitionCost.minus(salvageValue);
    const monthlyAmount = depreciableBase.dividedBy(asset.usefulLifeMonths);

    // Build a map of posted entries by period date string
    const postedMap = new Map<string, string>();
    for (const e of asset.depreciationEntries) {
      const key = e.periodDate.toISOString().slice(0, 10);
      postedMap.set(key, e.id);
    }

    // Generate schedule starting from first day of acquisition month
    const scheduleStart = new Date(asset.acquisitionDate);
    scheduleStart.setDate(1); // first of acquisition month

    const schedule: Array<{
      periodDate: string;
      amount: string;
      posted: boolean;
      depreciationEntryId: string | null;
    }> = [];

    let remaining = depreciableBase;

    for (let i = 0; i < asset.usefulLifeMonths; i++) {
      if (remaining.lessThanOrEqualTo(0)) break;

      const periodDate = new Date(scheduleStart);
      periodDate.setMonth(scheduleStart.getMonth() + i);
      const periodStr = periodDate.toISOString().slice(0, 10);

      const periodAmount = Decimal.min(monthlyAmount, remaining);
      remaining = remaining.minus(periodAmount);

      const entryId = postedMap.get(periodStr) ?? null;
      schedule.push({
        periodDate: periodStr,
        amount: periodAmount.toFixed(2),
        posted: entryId !== null,
        depreciationEntryId: entryId,
      });
    }

    return {
      assetId: id,
      totalPeriods: asset.usefulLifeMonths,
      monthlyAmount: monthlyAmount.toFixed(2),
      schedule,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _computeFigures(asset: {
    acquisitionCost: { toString(): string };
    salvageValue: { toString(): string };
    usefulLifeMonths: number;
    depreciationEntries: Array<{ amount: { toString(): string } }>;
  }) {
    const acquisitionCost = new Decimal(asset.acquisitionCost.toString());
    const salvageValue = new Decimal(asset.salvageValue.toString());
    const depreciableBase = acquisitionCost.minus(salvageValue);
    const monthlyDepreciation = depreciableBase.dividedBy(asset.usefulLifeMonths);

    const totalDepreciated = asset.depreciationEntries.reduce(
      (acc, e) => acc.plus(new Decimal(e.amount.toString())),
      new Decimal(0),
    );

    const rawBookValue = depreciableBase.minus(totalDepreciated);
    const bookValue = Decimal.max(rawBookValue, new Decimal(0));

    return {
      totalDepreciated: totalDepreciated.toFixed(2),
      bookValue: bookValue.toFixed(2),
      monthlyDepreciation: monthlyDepreciation.toFixed(2),
    };
  }

  private _formatSummary(asset: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    acquisitionDate: Date;
    acquisitionCost: { toString(): string };
    salvageValue: { toString(): string };
    usefulLifeMonths: number;
    depreciationMethod: string;
    active: boolean;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    assetAccount: { id: string; code: string; nameAr: string };
    accumulatedDepAccount: { id: string; code: string; nameAr: string };
    depreciationExpenseAccount: { id: string; code: string; nameAr: string };
    depreciationEntries: Array<{ amount: { toString(): string } }>;
  }) {
    const figures = this._computeFigures(asset);
    return {
      id: asset.id,
      code: asset.code,
      nameAr: asset.nameAr,
      nameEn: asset.nameEn,
      acquisitionDate: asset.acquisitionDate.toISOString().slice(0, 10),
      acquisitionCost: new Decimal(asset.acquisitionCost.toString()).toFixed(2),
      salvageValue: new Decimal(asset.salvageValue.toString()).toFixed(2),
      usefulLifeMonths: asset.usefulLifeMonths,
      depreciationMethod: asset.depreciationMethod,
      active: asset.active,
      notes: asset.notes,
      assetAccount: asset.assetAccount,
      accumulatedDepAccount: asset.accumulatedDepAccount,
      depreciationExpenseAccount: asset.depreciationExpenseAccount,
      ...figures,
    };
  }

  private _formatDetail(asset: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string;
    acquisitionDate: Date;
    acquisitionCost: { toString(): string };
    salvageValue: { toString(): string };
    usefulLifeMonths: number;
    depreciationMethod: string;
    active: boolean;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    assetAccount: { id: string; code: string; nameAr: string };
    accumulatedDepAccount: { id: string; code: string; nameAr: string };
    depreciationExpenseAccount: { id: string; code: string; nameAr: string };
    depreciationEntries: Array<{
      id: string;
      periodDate: Date;
      amount: { toString(): string };
      journalEntryId: string | null;
      notes: string | null;
      createdAt: Date;
    }>;
  }) {
    const figures = this._computeFigures(asset);
    return {
      id: asset.id,
      code: asset.code,
      nameAr: asset.nameAr,
      nameEn: asset.nameEn,
      acquisitionDate: asset.acquisitionDate.toISOString().slice(0, 10),
      acquisitionCost: new Decimal(asset.acquisitionCost.toString()).toFixed(2),
      salvageValue: new Decimal(asset.salvageValue.toString()).toFixed(2),
      usefulLifeMonths: asset.usefulLifeMonths,
      depreciationMethod: asset.depreciationMethod,
      active: asset.active,
      notes: asset.notes,
      assetAccount: asset.assetAccount,
      accumulatedDepAccount: asset.accumulatedDepAccount,
      depreciationExpenseAccount: asset.depreciationExpenseAccount,
      ...figures,
      depreciationEntries: asset.depreciationEntries.map((e) => ({
        id: e.id,
        periodDate: e.periodDate.toISOString().slice(0, 10),
        amount: new Decimal(e.amount.toString()).toFixed(2),
        journalEntryId: e.journalEntryId,
        notes: e.notes,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }
}
