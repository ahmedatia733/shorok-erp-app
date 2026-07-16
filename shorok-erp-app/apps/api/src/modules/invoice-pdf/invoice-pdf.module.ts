import { Module } from "@nestjs/common";
import { InvoicePdfService } from "./invoice-pdf.service";

/** Provides the shared headless-Chromium invoice PDF renderer to the invoice modules. */
@Module({
  providers: [InvoicePdfService],
  exports: [InvoicePdfService],
})
export class InvoicePdfModule {}
