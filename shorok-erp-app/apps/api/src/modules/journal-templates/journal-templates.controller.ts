import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import {
  CreateJournalTemplateSchema,
  UpdateJournalTemplateSchema,
  type CreateJournalTemplate,
  type UpdateJournalTemplate,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { NotFoundError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

@Controller("journal-templates")
export class JournalTemplatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /journal-templates — list all active templates with lines + account info
   */
  @Get()
  async list() {
    const templates = await this.prisma.journalTemplate.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      include: {
        lines: {
          orderBy: { sortOrder: "asc" },
          include: {
            account: {
              select: { id: true, code: true, nameAr: true, nameEn: true },
            },
          },
        },
      },
    });
    return templates.map(this._format);
  }

  /**
   * GET /journal-templates/:id
   */
  @Get(":id")
  async getOne(@Param("id") id: string) {
    const template = await this.prisma.journalTemplate.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { sortOrder: "asc" },
          include: {
            account: {
              select: { id: true, code: true, nameAr: true, nameEn: true },
            },
          },
        },
      },
    });
    if (!template || !template.active) throw new NotFoundError({ id });
    return this._format(template);
  }

  /**
   * POST /journal-templates — OWNER, ACCOUNTANT: create template with lines
   */
  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateJournalTemplateSchema)) body: CreateJournalTemplate,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const template = await tx.journalTemplate.create({
        data: {
          name: body.name,
          description: body.description ?? null,
          createdBy: user.id,
          lines: {
            create: (body.lines ?? []).map((line, idx) => ({
              accountId: line.accountId,
              type: line.type,
              amount: line.amount != null ? line.amount : null,
              note: line.note ?? null,
              sortOrder: line.sortOrder ?? idx,
            })),
          },
        },
        include: {
          lines: {
            orderBy: { sortOrder: "asc" },
            include: {
              account: {
                select: { id: true, code: true, nameAr: true, nameEn: true },
              },
            },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "CREATE",
        entityType: "journal_template",
        entityId: template.id,
        afterSnapshot: { name: body.name, lineCount: body.lines?.length ?? 0 },
        summaryAr: `${user.name} أنشأ قالب قيد: ${body.name}`,
        summaryEn: `${user.name} created journal template: ${body.name}`,
      });

      return this._format(template);
    });
  }

  /**
   * PUT /journal-templates/:id — OWNER, ACCOUNTANT: replace template (delete old lines, create new)
   */
  @Put(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateJournalTemplateSchema)) body: UpdateJournalTemplate,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.journalTemplate.findUnique({ where: { id } });
      if (!existing || !existing.active) throw new NotFoundError({ id });

      // Delete all old lines (cascade would handle it too, but we do it explicitly)
      await tx.journalTemplateLine.deleteMany({ where: { templateId: id } });

      const template = await tx.journalTemplate.update({
        where: { id },
        data: {
          name: body.name ?? existing.name,
          description: body.description !== undefined ? body.description : existing.description,
          lines: body.lines
            ? {
                create: body.lines.map((line, idx) => ({
                  accountId: line.accountId,
                  type: line.type,
                  amount: line.amount != null ? line.amount : null,
                  note: line.note ?? null,
                  sortOrder: line.sortOrder ?? idx,
                })),
              }
            : undefined,
        },
        include: {
          lines: {
            orderBy: { sortOrder: "asc" },
            include: {
              account: {
                select: { id: true, code: true, nameAr: true, nameEn: true },
              },
            },
          },
        },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "UPDATE",
        entityType: "journal_template",
        entityId: id,
        beforeSnapshot: { name: existing.name },
        afterSnapshot: { name: template.name, lineCount: template.lines.length },
        summaryAr: `${user.name} عدّل قالب قيد: ${template.name}`,
        summaryEn: `${user.name} updated journal template: ${template.name}`,
      });

      return this._format(template);
    });
  }

  /**
   * DELETE /journal-templates/:id — OWNER only: soft delete (set active=false)
   */
  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.journalTemplate.findUnique({ where: { id } });
      if (!existing || !existing.active) throw new NotFoundError({ id });

      await tx.journalTemplate.update({
        where: { id },
        data: { active: false },
      });

      await this.audit.write({
        tx,
        actorId: user.id,
        action: "DELETE",
        entityType: "journal_template",
        entityId: id,
        beforeSnapshot: { name: existing.name },
        summaryAr: `${user.name} حذف قالب قيد: ${existing.name}`,
        summaryEn: `${user.name} deleted journal template: ${existing.name}`,
      });
    });
  }

  private _format(template: {
    id: string;
    name: string;
    description: string | null;
    active: boolean;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
    lines: Array<{
      id: string;
      templateId: string;
      accountId: string;
      type: string;
      amount: { toString(): string } | null;
      note: string | null;
      sortOrder: number;
      account: { id: string; code: string; nameAr: string; nameEn: string };
    }>;
  }) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      active: template.active,
      createdBy: template.createdBy,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
      lines: template.lines.map((l) => ({
        id: l.id,
        accountId: l.account.id,
        accountCode: l.account.code,
        accountNameAr: l.account.nameAr,
        accountNameEn: l.account.nameEn,
        type: l.type as "debit" | "credit",
        amount: l.amount != null ? l.amount.toString() : null,
        note: l.note,
        sortOrder: l.sortOrder,
      })),
    };
  }
}
