import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import {
  CreatePurchaseReturnSchema, UpdatePurchaseReturnSchema, ReturnCancelSchema, ReturnQuerySchema,
  type CreatePurchaseReturn, type UpdatePurchaseReturn, type ReturnCancel, type ReturnQuery,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { PurchaseReturnsService } from "./purchase-returns.service";

@Controller("purchase-returns")
export class PurchaseReturnsController {
  constructor(private readonly service: PurchaseReturnsService) {}

  @Get("returnable/:invoiceId")
  @Roles("OWNER", "ACCOUNTANT")
  returnable(@Param("invoiceId") invoiceId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.returnableForInvoice(invoiceId, user);
  }

  @Get()
  @Roles("OWNER", "ACCOUNTANT")
  list(@Query(new ZodValidationPipe(ReturnQuerySchema)) query: ReturnQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(query, user);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT")
  get(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.get(id, user);
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  create(@Body(new ZodValidationPipe(CreatePurchaseReturnSchema)) body: CreatePurchaseReturn, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(body, user);
  }

  @Put(":id")
  @Roles("OWNER", "ACCOUNTANT")
  update(@Param("id") id: string, @Body(new ZodValidationPipe(UpdatePurchaseReturnSchema)) body: UpdatePurchaseReturn, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, body, user);
  }

  @Post(":id/confirm")
  @Roles("OWNER", "ACCOUNTANT")
  confirm(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.confirm(id, user);
  }

  @Post(":id/cancel")
  @Roles("OWNER", "ACCOUNTANT")
  cancel(@Param("id") id: string, @Body(new ZodValidationPipe(ReturnCancelSchema)) body: ReturnCancel, @CurrentUser() user: AuthenticatedUser) {
    return this.service.cancel(id, body.reason, user);
  }
}
