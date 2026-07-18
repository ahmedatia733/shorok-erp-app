/**
 * Authoritative opening dataset (2026-07-18) + pure validation/normalization.
 * Shared by the import script and its tests so both use one source of truth.
 */
import { Decimal } from "decimal.js";

export const OPENING_DATE = "2026-07-18";
export const MARKER = "OPENING_DATASET_20260718_V1";
export const IK_INVENTORY = `${MARKER}:INVENTORY`;
export const IK_CUSTOMERS = `${MARKER}:CUSTOMERS`;

/** code → Arabic item name (27 products). */
export const PRODUCTS: Array<[string, string]> = [
  ["AP 120", "سيلفر"], ["AP 250", "دارك جراي"], ["AP 115", "رمادي ساده"], ["AP 385", "جراي فاتح"],
  ["AP D1", "ابيض لامع"], ["AP 788", "ابيض مط"], ["AP 9005", "اسود لامع"], ["AP 9010", "اسود مط"],
  ["AP 113", "اوف وايت"], ["AP 442", "بيج"], ["AP 276", "احمر لامع"], ["AP 116", "كحلي"],
  ["AP 1023", "اصفر"], ["AP 117", "ازرق"], ["AP 111", "اخضر"], ["AP 375", "رمادي مط غامق"],
  ["AP 119", "سيلفر مط"], ["AP D4", "لبني فاتح"], ["AP 2004", "اورانج"], ["AP 134", "لبني غامق"],
  ["AP 130", "دهبي ميتالك"], ["AP 106", "نحاسي"], ["AP 765", "اخضر امان"], ["AP 199", "شامبين جولد"],
  ["AP 1010", "خشبي دابل فيس"], ["AP 302", "مرايا دهبي"], ["AP 301", "مرايا فضي"],
];

export interface VariantRow {
  code: string; item: string; width: string; length: string; price: string;
  waraqBoards: string; waraqMeters: string; sohagBoards: string; sohagMeters: string;
}

const VARIANTS_RAW = `AP 120,سيلفر,1.25,3.20,500,76,304.00,0,0.00
AP 120,سيلفر,1.50,3.50,500,45,236.25,0,0.00
AP 250,دارك جراي,1.25,3.20,500,42,168.00,0,0.00
AP 250,دارك جراي,1.50,3.50,500,68,357.00,0,0.00
AP 115,رمادي ساده,1.25,3.20,500,58,232.00,0,0.00
AP 115,رمادي ساده,1.50,3.50,500,52,273.00,0,0.00
AP 385,جراي فاتح,1.25,3.20,500,66,264.00,0,0.00
AP D1,ابيض لامع,1.25,3.20,500,36,144.00,8,32.00
AP D1,ابيض لامع,1.50,3.50,500,55,288.75,0,0.00
AP 788,ابيض مط,1.25,3.20,500,67,268.00,0,0.00
AP 788,ابيض مط,1.50,3.50,500,28,147.00,0,0.00
AP 9005,اسود لامع,1.25,3.20,500,36,144.00,12,48.00
AP 9005,اسود لامع,1.50,3.50,500,6,31.50,28,147.00
AP 9010,اسود مط,1.25,3.20,500,35,140.00,0,0.00
AP 9010,اسود مط,1.50,3.50,500,5,26.25,0,0.00
AP 113,اوف وايت,1.25,3.20,500,45,180.00,6,24.00
AP 113,اوف وايت,1.50,3.50,500,33,173.25,0,0.00
AP 442,بيج,1.25,3.20,500,48,192.00,0,0.00
AP 442,بيج,1.50,3.50,500,73,383.25,14,73.50
AP 276,احمر لامع,1.25,3.20,500,37,148.00,8,32.00
AP 276,احمر لامع,1.50,3.50,500,16,84.00,15,78.75
AP 116,كحلي,1.25,3.20,500,107,428.00,0,0.00
AP 1023,اصفر,1.25,3.20,500,62,248.00,0,0.00
AP 117,ازرق,1.25,3.20,500,48,192.00,0,0.00
AP 111,اخضر,1.25,3.20,500,43,172.00,0,0.00
AP 375,رمادي مط غامق,1.25,3.20,500,50,200.00,0,0.00
AP 119,سيلفر مط,1.25,3.20,500,8,32.00,0,0.00
AP 119,سيلفر مط,1.50,3.50,500,26,136.50,0,0.00
AP 119,سيلفر مط,1.50,3.20,500,7,33.60,0,0.00
AP D4,لبني فاتح,1.25,3.20,500,20,80.00,0,0.00
AP 2004,اورانج,1.25,3.20,500,63,252.00,0,0.00
AP 2004,اورانج,1.50,3.50,500,44,231.00,0,0.00
AP 134,لبني غامق,1.25,3.20,500,45,180.00,0,0.00
AP 130,دهبي ميتالك,1.25,3.20,500,44,176.00,0,0.00
AP 106,نحاسي,1.25,3.20,500,28,112.00,0,0.00
AP 765,اخضر امان,1.25,3.20,500,39,156.00,0,0.00
AP 199,شامبين جولد,1.50,3.50,500,29,152.25,0,0.00
AP 1010,خشبي دابل فيس,1.25,3.20,625,30,120.00,8,32.00
AP 302,مرايا دهبي,1.25,3.20,635,48,192.00,0,0.00
AP 1010,خشبي دابل فيس,1.25,3.00,750,2,7.50,0,0.00
AP 301,مرايا فضي,1.25,3.20,635,3,12.00,0,0.00`;

export const VARIANTS: VariantRow[] = VARIANTS_RAW.trim().split("\n").map((l) => {
  const [code, item, width, length, price, waraqBoards, waraqMeters, sohagBoards, sohagMeters] = l.split(",");
  return { code, item, width, length, price, waraqBoards, waraqMeters, sohagBoards, sohagMeters };
});

export interface CustomerRow { name: string; side: "DEBIT" | "CREDIT"; amount: string }
export const CUSTOMERS: CustomerRow[] = ([
  ["صلاح مكي", "DEBIT", "416000.00"], ["محمود ميجا", "DEBIT", "166000.00"], ["عبده قطر", "DEBIT", "33300.00"],
  ["محمد فرحات", "DEBIT", "32000.00"], ["عطيه", "DEBIT", "152000.00"], ["حسام زكريا", "DEBIT", "10400.00"],
  ["محمد رجب", "DEBIT", "53100.00"], ["ايمن العمده", "DEBIT", "10000.00"], ["مها احمد", "DEBIT", "385600.00"],
  ["شريف العربي", "DEBIT", "60150.00"], ["اشرف محمد", "DEBIT", "56000.00"], ["م مصطفى", "DEBIT", "200000.00"],
  ["احمد حسن الحوامديه", "DEBIT", "12280.00"], ["اسلام قاسم", "DEBIT", "3000.00"], ["محمود خاطر", "DEBIT", "3000.00"],
  ["موزع الجماليه", "CREDIT", "85730.00"], ["محمد الغردقه", "CREDIT", "30000.00"], ["اسلام الزيني", "CREDIT", "126000.00"],
  ["مارتن فايز", "CREDIT", "45850.00"],
] as Array<[string, "DEBIT" | "CREDIT", string]>).map(([name, side, amount]) => ({ name: name.trim(), side, amount }));

export const EXPECT = {
  products: 27, variants: 41,
  waraq: { boards: 1673, meters: "7297.10", value: "3692965.00" },
  sohag: { boards: 99, meters: "467.25", value: "237625.00" },
  combined: { boards: 1772, meters: "7764.35", value: "3930590.00" },
  customers: 19, debitCount: 15, creditCount: 4,
  debitTotal: "1592830.00", creditTotal: "287580.00", netAr: "1305250.00",
};

export const D = (v: string | number) => new Decimal(v);
export const money = (d: Decimal) => d.toFixed(2);

/**
 * "AP " + source suffix, uppercased, single space, trimmed. Accepts a raw source
 * code with or without an "AP" prefix: "d1"→"AP D1", "AP 120"→"AP 120".
 */
export function normalizeCode(raw: string): string {
  const parts = raw.trim().replace(/\s+/g, " ").split(" ");
  const suffix = (parts[0].toUpperCase() === "AP" ? parts.slice(1) : parts).join(" ").toUpperCase();
  return `AP ${suffix}`;
}

/** meters-per-board = width × length. */
export function sizeOf(v: VariantRow): Decimal { return D(v.width).mul(v.length); }

/** Pure branch totals from the dataset. */
export function computeTotals() {
  let wb = D(0), wm = D(0), sb = D(0), sm = D(0), wval = D(0), sval = D(0);
  for (const v of VARIANTS) {
    wb = wb.add(v.waraqBoards); wm = wm.add(v.waraqMeters); sb = sb.add(v.sohagBoards); sm = sm.add(v.sohagMeters);
    wval = wval.add(D(v.waraqMeters).mul(v.price)); sval = sval.add(D(v.sohagMeters).mul(v.price));
  }
  return { wb, wm, sb, sm, wval, sval };
}

/** Throws with a joined message when any authoritative rule is violated. */
export function validateDataset(): void {
  const errs: string[] = [];
  if (PRODUCTS.length !== EXPECT.products) errs.push(`product count ${PRODUCTS.length} != 27`);
  if (VARIANTS.length !== EXPECT.variants) errs.push(`variant count ${VARIANTS.length} != 41`);
  const codeName = new Map<string, string>();
  for (const [code, name] of PRODUCTS) {
    if (normalizeCode(code) !== code) errs.push(`product code not normalized: ${code}`);
    if (!code.startsWith("AP ")) errs.push(`code missing AP prefix: ${code}`);
    codeName.set(code, name);
  }
  if (codeName.get("AP 199") !== "شامبين جولد") errs.push("AP 199 must be شامبين جولد");
  if (codeName.get("AP 1010") !== "خشبي دابل فيس") errs.push("AP 1010 must be خشبي دابل فيس");
  if ([...codeName.keys()].includes("AP 183")) errs.push("AP 183 must not exist");
  if ([...codeName.values()].includes("خشبي")) errs.push("no separate خشبي master allowed");
  let ap1010 = 0;
  for (const v of VARIANTS) {
    if (normalizeCode(v.code) !== v.code) errs.push(`variant code not normalized: ${v.code}`);
    if (v.code === "AP 1010") { ap1010++; if (v.item !== "خشبي دابل فيس") errs.push("AP 1010 variant name wrong"); }
    const mpb = sizeOf(v);
    if (mpb.lte(0)) errs.push(`non-positive size for ${v.code}`);
    if (D(v.price).lte(0)) errs.push(`non-positive price for ${v.code}`);
    if (!D(v.waraqBoards).mul(mpb).eq(v.waraqMeters)) errs.push(`الوراق meters mismatch ${v.code} ${v.width}x${v.length}`);
    if (!D(v.sohagBoards).mul(mpb).eq(v.sohagMeters)) errs.push(`سوهاج meters mismatch ${v.code} ${v.width}x${v.length}`);
  }
  if (ap1010 !== 2) errs.push(`AP 1010 must have 2 variants, has ${ap1010}`);
  const t = computeTotals();
  if (!t.wb.eq(EXPECT.waraq.boards) || !t.wm.eq(EXPECT.waraq.meters) || !t.wval.eq(EXPECT.waraq.value)) errs.push(`الوراق totals mismatch`);
  if (!t.sb.eq(EXPECT.sohag.boards) || !t.sm.eq(EXPECT.sohag.meters) || !t.sval.eq(EXPECT.sohag.value)) errs.push(`سوهاج totals mismatch`);
  const names = new Set(CUSTOMERS.map((c) => c.name));
  if (names.size !== CUSTOMERS.length) errs.push("duplicate customer names");
  if (CUSTOMERS.length !== EXPECT.customers) errs.push(`customer count ${CUSTOMERS.length} != 19`);
  const debits = CUSTOMERS.filter((c) => c.side === "DEBIT");
  const credits = CUSTOMERS.filter((c) => c.side === "CREDIT");
  if (debits.length !== EXPECT.debitCount) errs.push(`debit count ${debits.length} != 15`);
  if (credits.length !== EXPECT.creditCount) errs.push(`credit count ${credits.length} != 4`);
  const dt = debits.reduce((a, c) => a.add(c.amount), D(0));
  const ct = credits.reduce((a, c) => a.add(c.amount), D(0));
  if (!dt.eq(EXPECT.debitTotal)) errs.push(`debit total ${money(dt)} != ${EXPECT.debitTotal}`);
  if (!ct.eq(EXPECT.creditTotal)) errs.push(`credit total ${money(ct)} != ${EXPECT.creditTotal}`);
  if (!dt.sub(ct).eq(EXPECT.netAr)) errs.push(`net AR ${money(dt.sub(ct))} != ${EXPECT.netAr}`);
  for (const c of CUSTOMERS) if (D(c.amount).lte(0)) errs.push(`non-positive amount ${c.name}`);
  if (errs.length) throw new Error("Dataset validation failed:\n - " + errs.join("\n - "));
}
