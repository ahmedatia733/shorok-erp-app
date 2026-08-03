/**
 * Adds catalogue products (SKU + one variant each) through the supported API.
 *
 * The point of this script is the sales price. A default PURCHASE cost is what
 * the purchase-invoice form prefills; the sales form deliberately never reads a
 * default sale price, because the selling price is the accountant's decision per
 * customer. So a purchase cost must never leak into the sale-price field: it
 * would quietly turn a cost into a price and, at a glance, look correct.
 *
 * `defaultSalePricePerMeter` is therefore always written as "0" — the same value
 * every existing production variant carries — and the script refuses to run if
 * anyone passes a non-zero one. "0" here means "no default", not "free": the
 * sales form leaves the price blank and requires manual entry.
 *
 * Idempotency is the product code. Codes are unique, so the script reads the
 * whole catalogue first (every page — a duplicate on page two is still a
 * duplicate) and, for a code that already exists, reconciles it field by field
 * instead of writing. It never overwrites an existing product: a code that
 * exists with different values is reported as a conflict and stops the run.
 *
 *   pnpm --filter @shorok/api catalogue:create -- \
 *     --base <url> --phone <e164> --actor-id <uuid> \
 *     --purchase-cost 489.00 --size 4 \
 *     --product 555:بينك:Pink \
 *     --product 3005:نبيتي لامع:Glossy Burgundy \
 *     [--execute]
 *
 * Without --execute it reads production, prints exactly what it would send, and
 * writes nothing. The password comes from SHOROK_PASSWORD and is never logged.
 */

interface Sku {
  id: string;
  code: string;
  colorNameAr: string;
  colorNameEn: string;
  category: string;
  active: boolean;
}

interface Variant {
  id: string;
  skuId: string;
  sizeMetersPerBoard: string;
  defaultSalePricePerMeter: string;
  defaultPurchasePricePerMeter: string;
  priceOverrideTolerancePercent: string | null;
  active: boolean;
}

interface Product {
  code: string;
  nameAr: string;
  nameEn: string;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return process.argv[i + 1];
}

function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const BASE = arg("base").replace(/\/$/, "");
const EXECUTE = process.argv.includes("--execute");

let token = "";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  if (![200, 201].includes(res.status)) {
    throw new Error(`HTTP ${res.status} on ${method} ${path}: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return payload as T;
}

/** This API wraps collections three different ways; assuming one is how a
 *  duplicate check silently reads an empty list and creates a second copy. */
function rows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const record = payload as Record<string, unknown> | null;
  for (const key of ["data", "items", "results"]) {
    const value = record?.[key];
    if (Array.isArray(value)) return value as T[];
  }
  throw new Error(`unrecognised collection response: ${JSON.stringify(payload).slice(0, 200)}`);
}

async function allRows<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await api<{ nextCursor?: string | null }>(
      "GET",
      cursor ? `${path}${sep}cursor=${cursor}` : path,
    );
    out.push(...rows<T>(page));
    cursor = page?.nextCursor ?? null;
    if (!cursor) return out;
  }
}

/** Arabic text varies in presentation forms; compare canonically so a duplicate
 *  written with a different alef or a tatweel is still recognised as one. */
function normAr(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[ـ]/g, "")
    .replace(/[ً-ْ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .split(/\s+/)
    .join(" ")
    .trim();
}

const eq = (a: string, b: string) => Number(a) === Number(b);

async function main(): Promise<void> {
  const phone = arg("phone");
  const actorId = arg("actor-id");
  const purchaseCost = arg("purchase-cost");
  const size = arg("size");
  const category = arg("category", "NORMAL");
  // Not configurable by accident: a caller must pass --sale-price 0 or nothing.
  const salePrice = arg("sale-price", "0");

  if (Number(salePrice) !== 0) {
    throw new Error(
      "REFUSED: --sale-price must be 0. A default sale price would prefill the sales " +
      "invoice and turn a purchase cost into a customer price.",
    );
  }

  const products: Product[] = argAll("product").map((spec) => {
    const [code, nameAr, nameEn] = spec.split(":");
    if (!code || !nameAr || !nameEn) {
      throw new Error(`--product must be code:arabicName:englishName, got "${spec}"`);
    }
    return { code: code.trim(), nameAr: nameAr.trim(), nameEn: nameEn.trim() };
  });
  if (products.length === 0) throw new Error("at least one --product is required");

  const codes = products.map((p) => p.code);
  if (new Set(codes).size !== codes.length) throw new Error("duplicate --product codes supplied");

  const password = process.env.SHOROK_PASSWORD;
  if (!password) throw new Error("SHOROK_PASSWORD must be set in the environment");

  console.log(`  target        : ${BASE}`);
  console.log(`  mode          : ${EXECUTE ? "EXECUTE" : "DRY RUN (reads only, writes nothing)"}`);
  console.log(`  purchase cost : ${purchaseCost} per meter`);
  console.log(`  sale price    : ${salePrice}  (no default — the sales form requires manual entry)`);
  console.log(`  variant size  : ${size} meters per board`);
  console.log(`  category      : ${category}`);

  const login = await api<{ accessToken: string }>("POST", "/auth/login", { phone, password });
  token = login.accessToken;
  const me = await api<{ id: string; phone: string; role: string; status: string }>("GET", "/auth/me");
  if (me.id !== actorId || me.phone !== phone) {
    throw new Error("ACTOR_IDENTITY_MISMATCH: authenticated user is not the approved actor id + phone");
  }
  console.log(`  actor         : bound by id + phone (${me.role}, ${me.status})`);

  const skus = await allRows<Sku>("/products/skus?limit=100");
  const variants = await allRows<Variant>("/products/variants?limit=100");
  console.log(`  catalogue     : ${skus.length} SKUs / ${variants.length} variants scanned\n`);

  const created: Array<Record<string, string>> = [];

  for (const p of products) {
    const byCode = skus.filter((s) => String(s.code).trim() === p.code);
    const byNameAr = skus.filter((s) => normAr(s.colorNameAr) === normAr(p.nameAr));
    const byNameEn = skus.filter(
      (s) => String(s.colorNameEn).trim().toLowerCase() === p.nameEn.toLowerCase(),
    );

    // A name collision on a DIFFERENT code is a genuine ambiguity, not a
    // duplicate to reconcile — two products would be indistinguishable in the
    // selector.
    const nameClash = [...byNameAr, ...byNameEn].filter((s) => String(s.code).trim() !== p.code);
    if (nameClash.length) {
      throw new Error(
        `CONFLICT for ${p.code}: name already used by code(s) ` +
        `${[...new Set(nameClash.map((s) => s.code))].join(", ")} — refusing to create a second product with the same name`,
      );
    }

    if (byCode.length > 1) throw new Error(`CONFLICT: code ${p.code} exists ${byCode.length} times`);

    if (byCode.length === 1) {
      const sku = byCode[0];
      const vs = variants.filter((v) => v.skuId === sku.id);
      const problems: string[] = [];
      if (normAr(sku.colorNameAr) !== normAr(p.nameAr)) problems.push(`Arabic name is "${sku.colorNameAr}"`);
      if (String(sku.colorNameEn).trim().toLowerCase() !== p.nameEn.toLowerCase()) problems.push(`English name is "${sku.colorNameEn}"`);
      if (!sku.active) problems.push("SKU is inactive");
      if (sku.category !== category) problems.push(`category is ${sku.category}`);
      if (vs.length !== 1) problems.push(`${vs.length} variants (expected 1)`);
      if (vs.length === 1) {
        if (!eq(vs[0].defaultPurchasePricePerMeter, purchaseCost)) problems.push(`purchase cost is ${vs[0].defaultPurchasePricePerMeter}`);
        if (!eq(vs[0].defaultSalePricePerMeter, "0")) problems.push(`sale price is ${vs[0].defaultSalePricePerMeter}, expected 0`);
        if (!eq(vs[0].sizeMetersPerBoard, size)) problems.push(`size is ${vs[0].sizeMetersPerBoard}`);
        if (!vs[0].active) problems.push("variant is inactive");
      }
      if (problems.length) {
        throw new Error(`CONFLICT for existing code ${p.code}: ${problems.join("; ")} — refusing to overwrite`);
      }
      console.log(`    ${p.code.padEnd(6)} ALREADY_EXISTS_AND_RECONCILED  sku=${sku.id} variant=${vs[0].id}`);
      created.push({ code: p.code, skuId: sku.id, variantId: vs[0].id, status: "ALREADY_EXISTS_AND_RECONCILED" });
      continue;
    }

    if (!EXECUTE) {
      console.log(`    ${p.code.padEnd(6)} WOULD CREATE`);
      console.log(`             POST /products/skus     { code:"${p.code}", colorNameAr:"${p.nameAr}", colorNameEn:"${p.nameEn}", category:"${category}" }`);
      console.log(`             POST /products/variants { skuId:<new>, sizeMetersPerBoard:"${size}", defaultSalePricePerMeter:"${salePrice}", defaultPurchasePricePerMeter:"${purchaseCost}" }`);
      console.log(`             deltas: product_skus +1, product_variants +1, everything else +0`);
      continue;
    }

    const sku = await api<Sku>("POST", "/products/skus", {
      code: p.code,
      colorNameAr: p.nameAr,
      colorNameEn: p.nameEn,
      category,
    });
    const variant = await api<Variant>("POST", "/products/variants", {
      skuId: sku.id,
      sizeMetersPerBoard: size,
      defaultSalePricePerMeter: salePrice,
      defaultPurchasePricePerMeter: purchaseCost,
    });
    console.log(`    ${p.code.padEnd(6)} CREATED  sku=${sku.id} variant=${variant.id}`);
    created.push({ code: p.code, skuId: sku.id, variantId: variant.id, status: "CREATED" });
  }

  if (!EXECUTE) {
    console.log("\n  DRY RUN — nothing written.");
    return;
  }

  // Read back from the API rather than trusting the create responses.
  const finalSkus = await allRows<Sku>("/products/skus?limit=100");
  const finalVariants = await allRows<Variant>("/products/variants?limit=100");
  const failures: string[] = [];
  for (const p of products) {
    const matches = finalSkus.filter((s) => String(s.code).trim() === p.code);
    if (matches.length !== 1) { failures.push(`${p.code}: ${matches.length} SKUs`); continue; }
    const sku = matches[0];
    const vs = finalVariants.filter((v) => v.skuId === sku.id);
    if (vs.length !== 1) failures.push(`${p.code}: ${vs.length} variants`);
    if (!sku.active) failures.push(`${p.code}: SKU inactive`);
    if (vs[0] && !vs[0].active) failures.push(`${p.code}: variant inactive`);
    if (vs[0] && !eq(vs[0].defaultPurchasePricePerMeter, purchaseCost)) {
      failures.push(`${p.code}: purchase cost ${vs[0].defaultPurchasePricePerMeter} != ${purchaseCost}`);
    }
    if (vs[0] && !eq(vs[0].defaultSalePricePerMeter, "0")) {
      failures.push(`${p.code}: sale price ${vs[0].defaultSalePricePerMeter} — a default sale price must never be set`);
    }
  }
  if (failures.length) throw new Error(`VERIFICATION FAILED: ${failures.join("; ")}`);

  console.log(`\n  VERIFIED — ${products.length} product(s), each 1 active SKU + 1 active variant,`);
  console.log(`  purchase cost ${purchaseCost}, sale price 0 (manual).`);
  console.log(JSON.stringify({ result: "OK", products: created }));
}

main().catch((e) => {
  console.error(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
