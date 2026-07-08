import { Body, Controller, Get, Param, Post, Patch, Put } from "@nestjs/common";
import {
  UpdateCompanyProfileSchema,
  CreatePostingProfileSchema,
  CreateTaxProfileSchema,
  CreateExpenseCategorySchema,
  UpdateExpenseCategorySchema,
  type UpdateCompanyProfile,
  type CreatePostingProfile,
  type CreateTaxProfile,
  type CreateExpenseCategory,
  type UpdateExpenseCategory,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { permissionMatrix } from "../../common/permissions";

/**
 * Phase 2 accounting configuration. Permission-gated per common/permissions.ts:
 * company/posting-profile = OWNER only; tax-profile/expense-category =
 * ACCOUNTANT(+OWNER). Every write is audited. Posting profiles and tax
 * profiles are versioned — a "create" always appends a new effective-dated
 * row and never edits history (Constitution VII/VIII).
 */
@Controller("settings")
export class ConfigurationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Permission matrix (read-only, any authenticated user) ─────────────────
  @Get("permissions")
  permissions() {
    return permissionMatrix();
  }

  // ── Company profile (OWNER only; single row) ──────────────────────────────
  @Get("company")
  @Roles("ACCOUNTANT")
  async getCompany() {
    return (await this.prisma.companyProfile.findFirst()) ?? null;
  }

  @Put("company")
  @Roles("OWNER")
  async updateCompany(
    @Body(new ZodValidationPipe(UpdateCompanyProfileSchema)) body: UpdateCompanyProfile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.companyProfile.findFirst();
      const data = {
        nameAr: body.nameAr,
        nameEn: body.nameEn,
        logoUrl: body.logoUrl ?? null,
        brandPrimaryColor: body.brandPrimaryColor ?? null,
        taxRegistrationNo: body.taxRegistrationNo ?? null,
        fiscalYearStartMonth: body.fiscalYearStartMonth,
        defaultLocale: body.defaultLocale,
        printFooterAr: body.printFooterAr ?? null,
        printFooterEn: body.printFooterEn ?? null,
        printBrandingPolicy: body.printBrandingPolicy,
      };
      const saved = existing
        ? await tx.companyProfile.update({ where: { id: existing.id }, data })
        : await tx.companyProfile.create({ data });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: existing ? "UPDATE" : "CREATE",
        entityType: "company_profile",
        entityId: saved.id,
        beforeSnapshot: existing ?? undefined,
        afterSnapshot: { nameAr: body.nameAr, nameEn: body.nameEn },
        summaryAr: `${user.name} حدّث بيانات الشركة`,
        summaryEn: `${user.name} updated the company profile`,
      });
      return saved;
    });
  }

  // ── Posting profiles (OWNER only; versioned) ──────────────────────────────
  @Get("posting-profiles")
  @Roles("ACCOUNTANT")
  listPostingProfiles() {
    return this.prisma.postingProfile.findMany({ orderBy: { effectiveFrom: "desc" } });
  }

  @Post("posting-profiles")
  @Roles("OWNER")
  async createPostingProfile(
    @Body(new ZodValidationPipe(CreatePostingProfileSchema)) body: CreatePostingProfile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const profile = await tx.postingProfile.create({
        data: {
          effectiveFrom: new Date(body.effectiveFrom),
          arAccountId: body.arAccountId ?? null,
          apAccountId: body.apAccountId ?? null,
          revenueAccountId: body.revenueAccountId ?? null,
          cogsAccountId: body.cogsAccountId ?? null,
          inventoryAccountId: body.inventoryAccountId ?? null,
          vatInputAccountId: body.vatInputAccountId ?? null,
          vatOutputAccountId: body.vatOutputAccountId ?? null,
          discountAccountId: body.discountAccountId ?? null,
          roundingAccountId: body.roundingAccountId ?? null,
          retainedEarningsAccountId: body.retainedEarningsAccountId ?? null,
          openingEquityAccountId: body.openingEquityAccountId ?? null,
          shrinkageAccountId: body.shrinkageAccountId ?? null,
          createdBy: user.id,
        },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "posting_profile",
        entityId: profile.id,
        afterSnapshot: { effectiveFrom: body.effectiveFrom },
        summaryAr: `${user.name} أضاف نسخة ربط حسابات سارية من ${body.effectiveFrom}`,
        summaryEn: `${user.name} added a posting profile effective ${body.effectiveFrom}`,
      });
      return profile;
    });
  }

  // ── Tax profiles (ACCOUNTANT+OWNER; versioned) ────────────────────────────
  @Get("tax-profiles")
  @Roles("ACCOUNTANT")
  listTaxProfiles() {
    return this.prisma.taxProfile.findMany({ orderBy: { effectiveFrom: "desc" } });
  }

  @Post("tax-profiles")
  @Roles("ACCOUNTANT")
  async createTaxProfile(
    @Body(new ZodValidationPipe(CreateTaxProfileSchema)) body: CreateTaxProfile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const profile = await tx.taxProfile.create({
        data: {
          nameKey: body.nameKey,
          rate: body.rate,
          inputAccountId: body.inputAccountId ?? null,
          outputAccountId: body.outputAccountId ?? null,
          registrationStatus: body.registrationStatus,
          filingCycle: body.filingCycle,
          effectiveFrom: new Date(body.effectiveFrom),
          active: body.active,
          createdBy: user.id,
        },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "tax_profile",
        entityId: profile.id,
        afterSnapshot: { rate: body.rate, effectiveFrom: body.effectiveFrom },
        summaryAr: `${user.name} أضاف نسخة ضريبة ${body.rate}% سارية من ${body.effectiveFrom}`,
        summaryEn: `${user.name} added a ${body.rate}% tax profile effective ${body.effectiveFrom}`,
      });
      return profile;
    });
  }

  // ── Expense categories (ACCOUNTANT+OWNER) ─────────────────────────────────
  @Get("expense-categories")
  @Roles("ACCOUNTANT")
  listExpenseCategories() {
    return this.prisma.expenseCategory.findMany({ orderBy: { nameAr: "asc" } });
  }

  @Post("expense-categories")
  @Roles("ACCOUNTANT")
  async createExpenseCategory(
    @Body(new ZodValidationPipe(CreateExpenseCategorySchema)) body: CreateExpenseCategory,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const account = await this.prisma.account.findUnique({ where: { id: body.accountId } });
    if (!account) throw new NotFoundError({ accountId: body.accountId });
    return this.prisma.runInTransaction(async (tx) => {
      const cat = await tx.expenseCategory.create({
        data: {
          nameAr: body.nameAr,
          nameEn: body.nameEn,
          accountId: body.accountId,
          taxableDefault: body.taxableDefault,
        },
      });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "expense_category",
        entityId: cat.id,
        afterSnapshot: { nameAr: body.nameAr, accountId: body.accountId },
        summaryAr: `${user.name} أضاف نوع مصروف: ${body.nameAr}`,
        summaryEn: `${user.name} added expense category: ${body.nameEn}`,
      });
      return cat;
    });
  }

  @Patch("expense-categories/:id")
  @Roles("ACCOUNTANT")
  async updateExpenseCategory(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateExpenseCategorySchema)) body: UpdateExpenseCategory,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const existing = await this.prisma.expenseCategory.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError({ id });
    return this.prisma.runInTransaction(async (tx) => {
      const cat = await tx.expenseCategory.update({ where: { id }, data: body });
      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "expense_category",
        entityId: id,
        beforeSnapshot: { nameAr: existing.nameAr, active: existing.active },
        afterSnapshot: body,
        summaryAr: `${user.name} عدّل نوع المصروف ${existing.nameAr}`,
        summaryEn: `${user.name} updated expense category ${existing.nameEn}`,
      });
      return cat;
    });
  }
}
