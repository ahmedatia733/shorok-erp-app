import { Module } from "@nestjs/common";
import { ReceiptVouchersController } from "./receipt-vouchers.controller";
import { ReceiptVouchersService } from "./receipt-vouchers.service";
import { PostingModule } from "../posting/posting.module";
import { ConfigurationModule } from "../configuration/configuration.module";

@Module({
  imports: [PostingModule, ConfigurationModule],
  controllers: [ReceiptVouchersController],
  providers: [ReceiptVouchersService],
})
export class ReceiptVouchersModule {}
