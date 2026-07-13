import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller";
import { AccountingStatementsModule } from "../accounting-statements/accounting-statements.module";
import { PostingModule } from "../posting/posting.module";

@Module({ imports: [AccountingStatementsModule, PostingModule], controllers: [PaymentsController] })
export class PaymentsModule {}
