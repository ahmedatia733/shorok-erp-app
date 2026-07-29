import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import {
  CreateTreasurySchema,
  UpdateTreasurySchema,
  TreasuryQuerySchema,
  TreasuryOpeningBalanceSchema,
  ReverseTreasuryOpeningBalanceSchema,
  TreasuryStatementQuerySchema,
  CreateTreasuryTransferSchema,
  UpdateTreasuryTransferSchema,
  ConfirmTreasuryTransferSchema,
  CancelTreasuryTransferSchema,
  type CreateTreasury,
  type UpdateTreasury,
  type TreasuryQuery,
  type TreasuryOpeningBalance,
  type ReverseTreasuryOpeningBalance,
  type TreasuryStatementQuery,
  type CreateTreasuryTransfer,
  type UpdateTreasuryTransfer,
  type ConfirmTreasuryTransfer,
  type CancelTreasuryTransfer,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { TreasuriesService } from "./treasuries.service";
import { TreasuryTransfersService } from "./treasury-transfers.service";

/**
 * Multi-treasury API. Viewing (list/detail/statement/selector) is open to the
 * finance roles; treasury MANAGEMENT (create/update/activate/deactivate/opening
 * balance) is OWNER-only — no capability model grants it to others. Transfers
 * are money operations available to OWNER + ACCOUNTANT. Branch scope + the
 * 404-no-leak policy for direct :id access are enforced in the service.
 */
@Controller("treasuries")
export class TreasuriesController {
  constructor(
    private readonly service: TreasuriesService,
    private readonly transfers: TreasuryTransfersService,
  ) {}

  // ── transfers (declared before :id routes so /transfers is not shadowed) ──
  @Get("transfers")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async listTransfers(@Query("status") status: string | undefined, @Query("treasuryId") treasuryId: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.list(user, { status, treasuryId });
  }

  @Get("transfers/:id")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async getTransfer(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.getOne(id, user);
  }

  @Post("transfers")
  @Roles("OWNER", "ACCOUNTANT")
  async createTransfer(@Body(new ZodValidationPipe(CreateTreasuryTransferSchema)) body: CreateTreasuryTransfer, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.create(body, user);
  }

  @Patch("transfers/:id")
  @Roles("OWNER", "ACCOUNTANT")
  async updateTransfer(@Param("id") id: string, @Body(new ZodValidationPipe(UpdateTreasuryTransferSchema)) body: UpdateTreasuryTransfer, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.update(id, body, user);
  }

  @Post("transfers/:id/confirm")
  @Roles("OWNER", "ACCOUNTANT")
  async confirmTransfer(@Param("id") id: string, @Body(new ZodValidationPipe(ConfirmTreasuryTransferSchema)) body: ConfirmTreasuryTransfer, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.confirm(id, body, user);
  }

  @Post("transfers/:id/cancel")
  @Roles("OWNER", "ACCOUNTANT")
  async cancelTransfer(@Param("id") id: string, @Body(new ZodValidationPipe(CancelTreasuryTransferSchema)) body: CancelTreasuryTransfer, @CurrentUser() user: AuthenticatedUser) {
    return this.transfers.cancel(id, body, user);
  }

  // ── treasuries ────────────────────────────────────────────────────────
  @Get()
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async list(@Query(new ZodValidationPipe(TreasuryQuerySchema)) query: TreasuryQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user, query);
  }

  @Get("selector")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async selector(@Query("branchId") branchId: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.service.selector(user, branchId);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async getOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.getOne(id, user);
  }

  @Get(":id/statement")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async statement(@Param("id") id: string, @Query(new ZodValidationPipe(TreasuryStatementQuerySchema)) query: TreasuryStatementQuery, @CurrentUser() user: AuthenticatedUser) {
    return this.service.statement(id, query, user);
  }

  @Post()
  @Roles("OWNER")
  async create(@Body(new ZodValidationPipe(CreateTreasurySchema)) body: CreateTreasury, @CurrentUser() user: AuthenticatedUser) {
    return this.service.create(body, user);
  }

  @Patch(":id")
  @Roles("OWNER")
  async update(@Param("id") id: string, @Body(new ZodValidationPipe(UpdateTreasurySchema)) body: UpdateTreasury, @CurrentUser() user: AuthenticatedUser) {
    return this.service.update(id, body, user);
  }

  @Post(":id/activate")
  @Roles("OWNER")
  async activate(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.setActive(id, true, user);
  }

  @Post(":id/deactivate")
  @Roles("OWNER")
  async deactivate(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.setActive(id, false, user);
  }

  @Post(":id/opening-balance")
  @Roles("OWNER")
  async openingBalance(@Param("id") id: string, @Body(new ZodValidationPipe(TreasuryOpeningBalanceSchema)) body: TreasuryOpeningBalance, @CurrentUser() user: AuthenticatedUser) {
    return this.service.postOpeningBalance(id, body, user);
  }

  @Get(":id/opening-balances")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  async listOpeningBalances(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.listOpeningBalances(id, user);
  }

  @Post(":id/opening-balances/:entryId/reverse")
  @Roles("OWNER")
  async reverseOpeningBalance(@Param("id") id: string, @Param("entryId") entryId: string, @Body(new ZodValidationPipe(ReverseTreasuryOpeningBalanceSchema)) body: ReverseTreasuryOpeningBalance, @CurrentUser() user: AuthenticatedUser) {
    return this.service.reverseOpeningBalance(id, entryId, body, user);
  }
}
