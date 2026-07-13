import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller";
import { AccountingStatementsModule } from "../accounting-statements/accounting-statements.module";

@Module({ imports: [AccountingStatementsModule], controllers: [PaymentsController] })
export class PaymentsModule {}
