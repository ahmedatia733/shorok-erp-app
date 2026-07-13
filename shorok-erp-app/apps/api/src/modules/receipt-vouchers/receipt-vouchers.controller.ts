import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateReceiptVoucherSchema,
  UpdateReceiptVoucherSchema,
  ReceiptVoucherPostSchema,
  ReceiptVoucherReverseSchema,
  ReceiptVoucherQuerySchema,
  type CreateReceiptVoucher,
  type UpdateReceiptVoucher,
  type ReceiptVoucherReverse,
  type ReceiptVoucherQuery,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { ReceiptVouchersService } from "./receipt-vouchers.service";

/**
 * Receipt vouchers — customer receipts posted through the single PostingEngine
 * (Dr Treasury / Cr AR_CONTROL [CUSTOMER party]). Draft CRUD is editable;
 * post/reverse are GL-authoritative and require the OWNER/ACCOUNTANT role.
 */
@Controller("receipt-vouchers")
export class ReceiptVouchersController {
  constructor(private readonly service: ReceiptVouchersService) {}

  @Get()
  async list(@Query(new ZodValidationPipe(ReceiptVoucherQuerySchema)) query: ReceiptVoucherQuery) {
    return this.service.list(query);
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    return this.service.getById(id);
  }

  @Post()
  @Roles("OWNER", "ACCOUNTANT")
  async create(
    @Body(new ZodValidationPipe(CreateReceiptVoucherSchema)) body: CreateReceiptVoucher,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(body, user);
  }

  @Patch(":id")
  @Roles("OWNER", "ACCOUNTANT")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateReceiptVoucherSchema)) body: UpdateReceiptVoucher,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(id, body, user);
  }

  @Delete(":id")
  @Roles("OWNER", "ACCOUNTANT")
  @HttpCode(204)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.service.remove(id, user);
  }

  @Post(":id/post")
  @Roles("OWNER", "ACCOUNTANT")
  async post(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReceiptVoucherPostSchema)) _body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.post(id, user);
  }

  @Post(":id/reverse")
  @Roles("OWNER", "ACCOUNTANT")
  async reverse(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReceiptVoucherReverseSchema)) body: ReceiptVoucherReverse,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.reverseVoucher(id, body, user);
  }
}
