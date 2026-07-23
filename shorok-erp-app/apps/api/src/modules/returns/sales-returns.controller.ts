import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import {
  CreateSalesReturnSchema, UpdateSalesReturnSchema, ReturnCancelSchema, ReturnQuerySchema,
  type CreateSalesReturn, type UpdateSalesReturn, type ReturnCancel, type ReturnQuery,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { SalesReturnsService } from "./sales-returns.service";

@Controller("sales-returns")
export class SalesReturnsController {
  constructor(private readonly service: SalesReturnsService) {}

  // Returnable snapshot for an original invoice (original / returned / remaining).
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
  create(@Body(new ZodValidationPipe(CreateSalesReturnSchema)) body: CreateSalesReturn, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(body, user);
  }

  @Put(":id")
  @Roles("OWNER", "ACCOUNTANT")
  update(@Param("id") id: string, @Body(new ZodValidationPipe(UpdateSalesReturnSchema)) body: UpdateSalesReturn, @CurrentUser() user: AuthenticatedUser) {
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
