import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CancelInventoryTransferSchema,
  ConfirmInventoryTransferSchema,
  CreateInventoryTransferSchema,
  InventoryTransferQuerySchema,
  PreviewInventoryTransferSchema,
  UpdateInventoryTransferSchema,
  type CancelInventoryTransfer,
  type ConfirmInventoryTransfer,
  type CreateInventoryTransfer,
  type InventoryTransferQuery,
  type PreviewInventoryTransfer,
  type UpdateInventoryTransfer,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
// Value import, NOT `import type` — Nest resolves the constructor from the
// emitted decorator metadata, which a type-only import erases.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { InventoryTransfersService } from "./inventory-transfers.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */

/**
 * إذن تحويل مخزون — internal branch-to-branch stock transfers.
 *
 * Reads are open to the roles that already read stock; every write, and both
 * previews, are OWNER-only for this first version. The API is authoritative:
 * hiding a button in the web app is a convenience, not the control.
 */
@Controller("inventory-transfers")
export class InventoryTransfersController {
  constructor(private readonly service: InventoryTransfersService) {}

  @Get()
  @Roles("OWNER", "ACCOUNTANT", "WAREHOUSE", "BRANCH_MANAGER")
  list(
    @Query(new ZodValidationPipe(InventoryTransferQuerySchema)) query: InventoryTransferQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(query, user);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT", "WAREHOUSE", "BRANCH_MANAGER")
  getOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getOne(id, user);
  }

  /** Zero-write calculation for a payload that has not been saved. */
  @Post("preview")
  @HttpCode(200)
  @Roles("OWNER")
  preview(
    @Body(new ZodValidationPipe(PreviewInventoryTransferSchema)) body: PreviewInventoryTransfer,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.previewPayload(body, user);
  }

  @Post()
  @Roles("OWNER")
  create(
    @Body(new ZodValidationPipe(CreateInventoryTransferSchema)) body: CreateInventoryTransfer,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(body, user);
  }

  @Patch(":id")
  @Roles("OWNER")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateInventoryTransferSchema)) body: UpdateInventoryTransfer,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(id, body, user);
  }

  @Delete(":id")
  @Roles("OWNER")
  @HttpCode(204)
  remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.remove(id, user);
  }

  /** 200, not Nest's default 201: a preview creates nothing. */
  @Post(":id/confirm-preview")
  @HttpCode(200)
  @Roles("OWNER")
  confirmPreview(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.previewConfirm(id, user);
  }

  @Post(":id/confirm")
  @Roles("OWNER")
  confirm(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ConfirmInventoryTransferSchema)) body: ConfirmInventoryTransfer,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.confirm(id, body, user);
  }

  @Post(":id/cancel-preview")
  @HttpCode(200)
  @Roles("OWNER")
  cancelPreview(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.previewCancel(id, user);
  }

  @Post(":id/cancel")
  @Roles("OWNER")
  cancel(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CancelInventoryTransferSchema)) body: CancelInventoryTransfer,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.cancel(id, body, user);
  }
}
