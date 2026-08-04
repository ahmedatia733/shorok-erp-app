import { Body, Controller, Get, Param, ParseIntPipe, Post } from "@nestjs/common";
import {
  ExecutePurchaseInvoiceRevisionSchema,
  ExecuteSalesInvoiceRevisionSchema,
  PreviewPurchaseInvoiceRevisionSchema,
  PreviewSalesInvoiceRevisionSchema,
  type ExecutePurchaseInvoiceRevision,
  type ExecuteSalesInvoiceRevision,
  type PreviewPurchaseInvoiceRevision,
  type PreviewSalesInvoiceRevision,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
// Value imports, NOT `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time — the code would compile and then fail to inject.
// The rule is disabled here so `eslint --fix` cannot silently reintroduce it.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { SalesInvoiceRevisionService } from "./sales-invoice-revision.service";
import { PurchaseInvoiceRevisionService } from "./purchase-invoice-revision.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

/**
 * Confirmed-invoice revision routes.
 *
 * Preview and execute are OWNER-only; the history is readable by whoever may
 * already read the invoice itself, since it contains nothing the invoice does
 * not. The role check is the existing `RolesGuard` — no parallel permission
 * model is introduced for one feature.
 *
 * These live in their own controller so the existing invoice controllers keep
 * their exact surface. Nest matches `:id/revisions…` ahead of `:id` because the
 * paths differ in depth, so no existing route changes behaviour.
 */
@Controller("sales-invoices")
export class SalesInvoiceRevisionsController {
  constructor(private readonly service: SalesInvoiceRevisionService) {}

  /** Full calculation, zero writes. Returns the fingerprint execution requires. */
  @Post(":id/revisions/preview")
  @Roles("OWNER")
  async preview(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PreviewSalesInvoiceRevisionSchema)) body: PreviewSalesInvoiceRevision,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.preview(id, body, user);
  }

  @Post(":id/revisions")
  @Roles("OWNER")
  async execute(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ExecuteSalesInvoiceRevisionSchema)) body: ExecuteSalesInvoiceRevision,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.execute(id, body, user);
  }

  @Get(":id/revisions")
  @Roles("OWNER", "ACCOUNTANT")
  async history(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.history(id, user);
  }

  @Get(":id/revisions/:revisionNumber")
  @Roles("OWNER", "ACCOUNTANT")
  async one(
    @Param("id") id: string,
    @Param("revisionNumber", ParseIntPipe) revisionNumber: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getRevision(id, revisionNumber, user);
  }
}

@Controller("purchase-invoices")
export class PurchaseInvoiceRevisionsController {
  constructor(private readonly service: PurchaseInvoiceRevisionService) {}

  @Post(":id/revisions/preview")
  @Roles("OWNER")
  async preview(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(PreviewPurchaseInvoiceRevisionSchema)) body: PreviewPurchaseInvoiceRevision,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.preview(id, body, user);
  }

  @Post(":id/revisions")
  @Roles("OWNER")
  async execute(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ExecutePurchaseInvoiceRevisionSchema)) body: ExecutePurchaseInvoiceRevision,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.execute(id, body, user);
  }

  @Get(":id/revisions")
  @Roles("OWNER", "ACCOUNTANT")
  async history(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.history(id, user);
  }

  @Get(":id/revisions/:revisionNumber")
  @Roles("OWNER", "ACCOUNTANT")
  async one(
    @Param("id") id: string,
    @Param("revisionNumber", ParseIntPipe) revisionNumber: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getRevision(id, revisionNumber, user);
  }
}
