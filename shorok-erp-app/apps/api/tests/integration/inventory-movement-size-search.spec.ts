/**
 * حركات المخزون — the board size on every movement, and searching by it.
 *
 * The size is never stored on the movement. It is read from the exact
 * ProductVariant the movement points at, so a row written long before this
 * feature existed describes its own size correctly without being touched.
 * These tests create movements through the ordinary domain paths and then only
 * ever READ them back, which is the same thing the production history does.
 *
 * The search is server-side on purpose: the list is cursor-paginated, so a
 * filter applied in the browser would only ever search the page already
 * downloaded and would quietly miss the rest of the history.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, openCurrentPeriod, teardownTestApp, type TestApp } from "./test-app";

describe("inventory movements — board size and size search", () => {
  let h: TestApp;
  let token: string;
  let skuId: string;
  let otherSkuId: string;
  const variant: Record<string, string> = {}; // size → variantId
  const u = Date.now().toString().slice(-6);
  const CODE = `SZ-${u}`;
  const OTHER_CODE = `OTH-${u}`;

  const srv = () => h.app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const movements = (params: Record<string, string> = {}) =>
    request(srv())
      .get("/api/v1/inventory/movements")
      .query({ limit: "200", ...params })
      .set(auth());

  /** Every size on the returned rows, so an assertion can be exact. */
  const sizesOf = (body: { data: Array<{ productVariant: { sizeMetersPerBoard: string } }> }) =>
    [...new Set(body.data.map((m) => Number(m.productVariant.sizeMetersPerBoard)))].sort((a, b) => a - b);

  const codesOf = (body: { data: Array<{ productVariant: { sku: { code: string } } }> }) =>
    [...new Set(body.data.map((m) => m.productVariant.sku.code))].sort();

  beforeAll(async () => {
    h = await buildTestApp();
    await openCurrentPeriod(h);
    const pw = "Pwd@2026!";
    await h.prisma.user.update({
      where: { id: h.ownerId },
      data: { passwordHash: await bcrypt.hash(pw, 10) },
    });
    token = (await request(srv()).post("/api/v1/auth/login").send({ phone: h.ownerPhone, password: pw }))
      .body.accessToken as string;

    // One product carrying all three size classes, which is exactly the shape
    // the live catalogue has for code 1010.
    const sku = await h.prisma.productSku.create({
      data: { code: CODE, colorNameAr: "خشبي دابل فيس", colorNameEn: "Wood Double Face", category: "NORMAL" },
    });
    skuId = sku.id;
    for (const size of ["5.25", "4", "3.75"]) {
      const v = await h.prisma.productVariant.create({
        data: { skuId, sizeMetersPerBoard: size, defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0" },
      });
      variant[size] = v.id;
    }

    // A second product whose Arabic name contains ك and ص, to prove those
    // letters are not matched as size tokens inside ordinary text.
    const other = await h.prisma.productSku.create({
      data: { code: OTHER_CODE, colorNameAr: "كوبرا صيني", colorNameEn: "Cobra", category: "NORMAL" },
    });
    otherSkuId = other.id;
    const ov = await h.prisma.productVariant.create({
      data: { skuId: otherSkuId, sizeMetersPerBoard: "6.6", defaultSalePricePerMeter: "0", defaultPurchasePricePerMeter: "0" },
    });
    variant["6.6"] = ov.id;

    // Movements through the ordinary receipt path — the same engine every
    // other document uses.
    for (const [size, boards] of [["5.25", "10"], ["4", "20"], ["3.75", "5"], ["6.6", "7"]] as const) {
      const res = await request(srv())
        .post("/api/v1/inventory/receipts")
        .set(auth())
        .send({ branchId: h.branchId, productVariantId: variant[size], boardsQuantity: boards, note: `استلام ${size}` });
      expect(res.status).toBeLessThan(300);
    }
  });

  afterAll(async () => teardownTestApp(h));

  // ── the derived size on every row ────────────────────────────────────────

  it("every movement reports the size of the variant that actually moved", async () => {
    const res = await movements();
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const m of res.body.data) {
      expect(m.productVariant.sizeMetersPerBoard).toBeTruthy();
      expect(m.boardSize).toBeTruthy();
      expect(["BIG", "SMALL", "CUSTOM"]).toContain(m.boardSize.kind);
    }
  });

  it("classifies 5.25 as ك, 4.00 as ص and anything else as م ق", async () => {
    const res = await movements({ search: CODE });
    const bySize = new Map<string, { kind: string; shortAr: string; meters: string }>();
    for (const m of res.body.data) bySize.set(m.productVariant.sizeMetersPerBoard, m.boardSize);

    expect(bySize.get("5.25")).toMatchObject({ kind: "BIG", shortAr: "ك", longAr: "كبير", meters: "5.25" });
    expect(bySize.get("4")).toMatchObject({ kind: "SMALL", shortAr: "ص", longAr: "صغير", meters: "4.00" });
    expect(bySize.get("3.75")).toMatchObject({ kind: "CUSTOM", shortAr: "م ق", longAr: "مقاس مخصص", meters: "3.75" });
  });

  it("keeps the actual measurement on a custom size, not just «م ق»", async () => {
    const res = await movements({ search: `${CODE} م ق` });
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const m of res.body.data) {
      expect(m.boardSize.shortAr).toBe("م ق");
      // the number must still be there, or the row does not say which board moved
      expect(m.boardSize.meters).toBe("3.75");
    }
  });

  // ── search ───────────────────────────────────────────────────────────────

  it("a product code returns every size for that code", async () => {
    const res = await movements({ search: CODE });
    expect(sizesOf(res.body)).toEqual([3.75, 4, 5.25]);
    expect(codesOf(res.body)).toEqual([CODE]);
  });

  it("«ك» returns only 5.25", async () => {
    const res = await movements({ search: "ك" });
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(sizesOf(res.body)).toEqual([5.25]);
  });

  it("«ص» returns only 4.00", async () => {
    const res = await movements({ search: "ص" });
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(sizesOf(res.body)).toEqual([4]);
  });

  it("«م ق» returns everything that is neither 5.25 nor 4.00", async () => {
    const res = await movements({ search: "م ق" });
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const s of sizesOf(res.body)) expect([5.25, 4]).not.toContain(s);
    expect(sizesOf(res.body)).toEqual(expect.arrayContaining([3.75, 6.6]));
  });

  it("the long Arabic words work too", async () => {
    expect(sizesOf((await movements({ search: `${CODE} كبير` })).body)).toEqual([5.25]);
    expect(sizesOf((await movements({ search: `${CODE} صغير` })).body)).toEqual([4]);
    expect(sizesOf((await movements({ search: `${CODE} مقاس مخصص` })).body)).toEqual([3.75]);
  });

  it("combines a code with a size class", async () => {
    expect(sizesOf((await movements({ search: `${CODE} ك` })).body)).toEqual([5.25]);
    expect(sizesOf((await movements({ search: `${CODE} ص` })).body)).toEqual([4]);
    expect(sizesOf((await movements({ search: `${CODE} م ق` })).body)).toEqual([3.75]);
    for (const q of [`${CODE} ك`, `${CODE} ص`, `${CODE} م ق`]) {
      expect(codesOf((await movements({ search: q })).body)).toEqual([CODE]);
    }
  });

  it("an exact custom measurement matches that size only", async () => {
    expect(sizesOf((await movements({ search: "3.75" })).body)).toEqual([3.75]);
    expect(sizesOf((await movements({ search: `${CODE} 3.75` })).body)).toEqual([3.75]);
    expect(sizesOf((await movements({ search: "6.6" })).body)).toEqual([6.6]);
  });

  it("the standard sizes typed as numbers behave as their class", async () => {
    expect(sizesOf((await movements({ search: `${CODE} 5.25` })).body)).toEqual([5.25]);
    expect(sizesOf((await movements({ search: `${CODE} 4` })).body)).toEqual([4]);
  });

  /**
   * The reason the parser exists. «كوبرا صيني» contains both ك and ص; a
   * substring search would classify it as a size and hide most of the list.
   */
  it("a product name containing ك or ص is NOT treated as a size search", async () => {
    const res = await movements({ search: "كوبرا" });
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(codesOf(res.body)).toEqual([OTHER_CODE]);
    // it is a 6.6 product, so a ك-as-substring bug would have returned nothing
    expect(sizesOf(res.body)).toEqual([6.6]);
  });

  it("searching by product name still works", async () => {
    const res = await movements({ search: "خشبي" });
    expect(codesOf(res.body)).toEqual([CODE]);
  });

  it("every word must match, so adding one narrows the result", async () => {
    const wide = await movements({ search: CODE });
    const narrow = await movements({ search: `${CODE} ك` });
    expect(narrow.body.data.length).toBeLessThan(wide.body.data.length);
  });

  it("a search that matches nothing returns an empty page, not everything", async () => {
    const res = await movements({ search: "ZZZ-NOTHING-MATCHES" });
    expect(res.body.data).toHaveLength(0);
  });

  // ── pagination stays correct under search ────────────────────────────────

  it("paginates the filtered set, not the unfiltered one", async () => {
    const first = await movements({ search: CODE, limit: "2" });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(srv())
      .get("/api/v1/inventory/movements")
      .query({ search: CODE, limit: "2", cursor: first.body.nextCursor })
      .set(auth());

    const ids = new Set([...first.body.data, ...second.body.data].map((m: { id: string }) => m.id));
    expect(ids.size).toBe(first.body.data.length + second.body.data.length); // no overlap
    for (const m of second.body.data) expect(m.productVariant.sku.code).toBe(CODE);
  });

  it("existing filters still work alongside search", async () => {
    const res = await movements({ search: CODE, movementType: "RECEIPT", branchId: h.branchId });
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const m of res.body.data) {
      expect(m.movementType).toBe("RECEIPT");
      expect(m.branchId).toBe(h.branchId);
      expect(m.productVariant.sku.code).toBe(CODE);
    }
  });

  it("no search at all still returns the full unfiltered list", async () => {
    const res = await movements();
    expect(codesOf(res.body)).toEqual(expect.arrayContaining([CODE, OTHER_CODE]));
  });

  // ── reading never writes ─────────────────────────────────────────────────

  it("searching does not create, duplicate or alter a single movement", async () => {
    const before = await h.prisma.inventoryMovement.count();
    const fingerprint = await h.prisma.inventoryMovement.findMany({
      select: { id: true, boardsQuantity: true, metersQuantity: true, productVariantId: true },
      orderBy: { id: "asc" },
    });
    const variantsBefore = await h.prisma.productVariant.findMany({
      select: { id: true, sizeMetersPerBoard: true, avgCostPerMeter: true, costUpdatedAt: true },
      orderBy: { id: "asc" },
    });

    for (const q of [CODE, "ك", "ص", "م ق", `${CODE} ك`, "3.75", "كوبرا", "خشبي"]) {
      expect((await movements({ search: q })).status).toBe(200);
    }

    expect(await h.prisma.inventoryMovement.count()).toBe(before);
    expect(
      await h.prisma.inventoryMovement.findMany({
        select: { id: true, boardsQuantity: true, metersQuantity: true, productVariantId: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(fingerprint);
    expect(
      await h.prisma.productVariant.findMany({
        select: { id: true, sizeMetersPerBoard: true, avgCostPerMeter: true, costUpdatedAt: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(variantsBefore);
  });
});
