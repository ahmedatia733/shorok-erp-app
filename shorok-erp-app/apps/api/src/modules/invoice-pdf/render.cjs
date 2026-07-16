/*
 * Standalone Chromium PDF render worker. Runs as its own Node process (spawned by
 * InvoicePdfService), which keeps ESM-only puppeteer-core / @sparticuz/chromium
 * out of the parent's module system — this is what lets it work identically under
 * Nest at runtime and under Jest's VM (where an in-process dynamic ESM import is
 * blocked without --experimental-vm-modules).
 *
 * Usage: node render.cjs <htmlInputPath> <pdfOutputPath>
 * Chromium selection: CHROME_PATH / PUPPETEER_EXECUTABLE_PATH, else the first
 * standard install path that exists (the production image is Alpine, which
 * installs its own musl-linked chromium at /usr/bin/chromium).
 */
const fs = require("fs");

/** Standard Chromium/Chrome locations, in preference order. */
const CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function resolveChromium() {
  const explicit = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Chromium not found at CHROME_PATH=${explicit}`);
    return explicit;
  }
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`No Chromium found. Set CHROME_PATH. Looked in: ${CANDIDATES.join(", ")}`);
  return found;
}

async function main() {
  const [htmlPath, outPath] = process.argv.slice(2);
  if (!htmlPath || !outPath) throw new Error("usage: render.cjs <htmlPath> <outPath>");
  const html = fs.readFileSync(htmlPath, "utf8");

  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromium(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

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
