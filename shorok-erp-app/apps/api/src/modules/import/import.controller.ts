import {
  Body,
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ImportCommitRequestSchema,
  type ImportCommitRequest,
  ImportDryRunQuerySchema,
  type ImportDryRunQuery,
} from "@shorok/shared";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import { ImportService } from "./import.service";

@Controller("import")
@Roles("OWNER")
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post("dry-run")
  @UseInterceptors(FileInterceptor("file"))
  async dryRun(
    @UploadedFile() file: any,
    @Query(new ZodValidationPipe(ImportDryRunQuerySchema)) query: ImportDryRunQuery,
  ) {
    if (!file) {
      throw new ValidationError({ reason: "file_required" });
    }

    return this.importService.dryRun(
      file.buffer,
      file.originalname,
      query.kind,
      query.branchId,
      query.supplierId,
    );
  }

  @Post("commit")
  async commit(
    @Body(new ZodValidationPipe(ImportCommitRequestSchema)) body: ImportCommitRequest,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.importService.commit(body.importSessionId, user);
  }
}
