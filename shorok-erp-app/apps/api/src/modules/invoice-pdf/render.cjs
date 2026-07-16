/*
 * Standalone Chromium PDF render worker. Runs as its own Node process (spawned by
 * InvoicePdfService), which keeps ESM-only puppeteer-core / @sparticuz/chromium
 * out of the parent's module system — this is what lets it work identically under
 * Nest at runtime and under Jest's VM (where an in-process dynamic ESM import is
 * blocked without --experimental-vm-modules).
 *
 * Usage: node render.cjs <htmlInputPath> <pdfOutputPath>
 * Chrome/Chromium selection: CHROME_PATH / PUPPETEER_EXECUTABLE_PATH for a local
 * binary, otherwise the bundled @sparticuz/chromium (Railway-safe).
 */
const fs = require("fs");

async function main() {
  const [htmlPath, outPath] = process.argv.slice(2);
  if (!htmlPath || !outPath) throw new Error("usage: render.cjs <htmlPath> <outPath>");
  const html = fs.readFileSync(htmlPath, "utf8");

  const puppeteer = (await import("puppeteer-core")).default;
  const localPath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

  let browser;
  if (localPath) {
    browser = await puppeteer.launch({ headless: true, executablePath: localPath, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  } else {
    const chromium = (await import("@sparticuz/chromium")).default;
    browser = await puppeteer.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // Fonts are embedded as data URIs; wait for glyph readiness so Arabic shapes.
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;text-align:center;color:#999;">— <span class="pageNumber"></span> / <span class="totalPages"></span> —</div>',
      margin: { top: "14mm", bottom: "18mm", left: "12mm", right: "12mm" },
    });
    fs.writeFileSync(outPath, pdf);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
