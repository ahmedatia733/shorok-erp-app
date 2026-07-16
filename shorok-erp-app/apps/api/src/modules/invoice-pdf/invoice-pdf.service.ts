import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildInvoiceHtml, type InvoicePdfData } from "./invoice-template";

/**
 * Renders an invoice to PDF with headless Chromium. The actual render runs in a
 * separate Node process (render.cjs) so that ESM-only puppeteer-core /
 * @sparticuz/chromium stay out of this module's loader — that keeps rendering
 * identical under Nest at runtime and under Jest's VM sandbox. Chromium is
 * production-safe on Railway via @sparticuz/chromium; locally it uses CHROME_PATH.
 */
@Injectable()
export class InvoicePdfService {
  // render.cjs sits next to this file in both src (ts-jest) and dist (nest build
  // copies it as an asset), so __dirname resolves it correctly in every environment.
  private readonly workerPath = join(__dirname, "render.cjs");

  async renderInvoice(data: InvoicePdfData): Promise<Buffer> {
    const html = buildInvoiceHtml(data);
    const dir = mkdtempSync(join(tmpdir(), "invoice-pdf-"));
    const htmlPath = join(dir, `${randomUUID()}.html`);
    const outPath = join(dir, `${randomUUID()}.pdf`);
    writeFileSync(htmlPath, html, "utf8");

    try {
      await this.runWorker(htmlPath, outPath);
      return readFileSync(outPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private runWorker(htmlPath: string, outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.workerPath, htmlPath, outPath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new InternalServerErrorException(`PDF render failed (exit ${code}): ${stderr.slice(0, 500)}`));
      });
    });
  }
}
