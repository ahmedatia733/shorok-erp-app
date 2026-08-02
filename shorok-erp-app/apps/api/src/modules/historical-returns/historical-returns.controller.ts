import { Controller, Get, Param, Query } from "@nestjs/common";
import { HistoricalSalesReturnQuerySchema, type HistoricalSalesReturnQuery } from "@shorok/shared";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HistoricalReturnsService } from "./historical-returns.service";

/**
 * Archive of the six July 2026 paper sales returns — GET only.
 *
 * There is no POST/PUT/PATCH/DELETE here and there never will be: the rows are
 * already reflected in the 2026-08-01 opening AR balances and physical count,
 * so any create/confirm/cancel route would double-count them. Read access
 * mirrors the returns module (broad read, OWNER/ACCOUNTANT/BRANCH_MANAGER); the
 * archive has no branch column, so nothing is branch-narrowed.
 */
@Controller("historical-sales-returns")
export class HistoricalReturnsController {
  constructor(private readonly service: HistoricalReturnsService) {}

  @Get()
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  list(@Query(new ZodValidationPipe(HistoricalSalesReturnQuerySchema)) query: HistoricalSalesReturnQuery) {
    return this.service.list(query);
  }

  @Get(":id")
  @Roles("OWNER", "ACCOUNTANT", "BRANCH_MANAGER")
  get(@Param("id") id: string) {
    return this.service.get(id);
  }
}
