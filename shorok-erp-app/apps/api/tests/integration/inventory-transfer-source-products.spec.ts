/**
 * The source-warehouse product picker.
 *
 * The picker's only promise is that everything it offers can actually be sent
 * from the selected branch — so most of this suite is about what must NOT be
 * listed: a product whose stock sits elsewhere, one whose every size is empty,
 * an inactive product, or a product kept alive only by a balance that
 * disagrees with itself.
 *
 * It also pins the shared definition: a product appears here exactly when the
 * size endpoint would enable at least one of its sizes, so the two screens
 * cannot tell the user different things.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("inventory transfer source-product picker", () => {
  let handle: TestApp;
  let token: string;
  let branchA: string;
  let branchB: string;

  const api = () => request(handle.app.getHttpServer());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const PATH = "/api/v1/inventory-transfers/source-products";
  const SIZES = "/api/v1/inventory-transfers/source-size-options";

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    token = (
      await api().post("/api/v1/auth/login").send({ phone: handle.ownerPhone, password: "Pwd@2026!" })
    ).body.accessToken as string;

    branchA = handle.branchId;
    branchB = (
      await handle.prisma.branch.create({
        data: { nameAr: "فرع المنتجات", nameEn: "Products Branch", active: true },
      })
    ).id;
    await handle.prisma.userBranchAccess.create({ data: { userId: handle.ownerId, branchId: branchB } });
  });

  afterAll(async () => teardownTestApp(handle));

  let seq = 0;
  const makeSku = (active = true) => {
    seq += 1;
    return handle.prisma.productSku.create({
      data: {
        code: `SP-${seq}-${Date.now().toString().slice(-5)}`,
        colorNameAr: `صنف ${seq}`,
        colorNameEn: `Product ${seq}`,
        category: "NORMAL",
        active,
      },
    });
  };
  const makeVariant = (skuId: string, size: string, active = true) =>
    handle.prisma.productVariant.create({
      data: {
        skuId,
        sizeMetersPerBoard: size,
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
        avgCostPerMeter: "498",
        active,
      },
    });
  const setBalance = (branchId: string, productVariantId: string, boards: string, meters: string) =>
    handle.prisma.branchInventoryBalance.upsert({
      where: { branchId_productVariantId: { branchId, productVariantId } },
      create: { branchId, productVariantId, boardsOnHand: boards, metersOnHand: meters },
      update: { boardsOnHand: boards, metersOnHand: meters },
    });

  const get = (branchId: string) => auth(api().get(PATH).query({ sourceBranchId: branchId }));
  const listed = (body: { products: Array<{ productSkuId: string }> }, id: string) =>
    body.products.filter((p) => p.productSkuId === id);

  // ── products that qualify ────────────────────────────────────────────────

  it("lists a product once when ك is enabled and ص is not", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "20", "105");

    const res = await get(branchA);
    expect(res.status).toBe(200);
    const hits = listed(res.body, sku.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.enabledSizeCount).toBe(1);

    // and the size screen still shows the disabled ص, exactly as P10 does
    const sizes = await auth(api().get(SIZES).query({ sourceBranchId: branchA, productSkuId: sku.id }));
    expect(sizes.body.options).toHaveLength(2);
    expect(sizes.body.options.filter((o: { enabled: boolean }) => o.enabled)).toHaveLength(1);
  });

  it("lists a product once when only ص is enabled", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, s.id, "15", "60");
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(1);
  });

  it("lists a product ONCE even when both ك and ص are enabled", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "20", "105");
    await setBalance(branchA, s.id, "12", "48");
    const hits = listed((await get(branchA)).body, sku.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.enabledSizeCount).toBe(2);
  });

  it("lists a product whose only enabled size is a custom one", async () => {
    const sku = await makeSku();
    const c = await makeVariant(sku.id, "3.75");
    await setBalance(branchA, c.id, "2", "7.5");
    const hits = listed((await get(branchA)).body, sku.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.enabledSizeCount).toBe(1);
  });

  it("lists a product ONCE when several custom sizes are enabled", async () => {
    const sku = await makeSku();
    for (const [size, b, m] of [
      ["3", "2", "6"],
      ["3.5", "4", "14"],
      ["6", "3", "18"],
    ] as const) {
      await setBalance(branchA, (await makeVariant(sku.id, size)).id, b, m);
    }
    const hits = listed((await get(branchA)).body, sku.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.enabledSizeCount).toBe(3);
  });

  it("lists a product kept eligible by a second, genuinely available size", async () => {
    const sku = await makeSku();
    const broken = await makeVariant(sku.id, "5.25");
    const good = await makeVariant(sku.id, "4");
    await setBalance(branchA, broken.id, "0", "5"); // inconsistent
    await setBalance(branchA, good.id, "9", "36");
    const hits = listed((await get(branchA)).body, sku.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.enabledSizeCount).toBe(1);
  });

  // ── products that must NOT qualify ───────────────────────────────────────

  it("omits a product whose every size is at zero", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "0", "0");
    await setBalance(branchA, s.id, "0", "0");
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("omits a product with no balance rows at all", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("omits a product whose stock is only in another branch", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchB, k.id, "40", "210");
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
    // ...and lists it for the branch that actually holds it
    expect(listed((await get(branchB)).body, sku.id)).toHaveLength(1);
  });

  it("omits a product whose only variant is inactive, even with stock", async () => {
    const sku = await makeSku();
    const dead = await makeVariant(sku.id, "5.25", false);
    await setBalance(branchA, dead.id, "30", "157.5");
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("omits an inactive product even when its stock is fine", async () => {
    const sku = await makeSku(false);
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "50", "262.5");
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("omits a product held up only by an inconsistent balance, and repairs nothing", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "0", "7"); // boards say none, metres say some
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);

    const after = await handle.prisma.branchInventoryBalance.findUniqueOrThrow({
      where: { branchId_productVariantId: { branchId: branchA, productVariantId: k.id } },
    });
    expect(after.boardsOnHand.toString()).toBe("0");
    expect(after.metersOnHand.toString()).toBe("7");
  });

  it("is unaffected by destination stock", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchB, k.id, "99", "519.75"); // plenty at the destination
    await setBalance(branchA, k.id, "0", "0"); // none at the source
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
  });

  // ── the shared definition ────────────────────────────────────────────────

  it("agrees exactly with the size endpoint for every listed product", async () => {
    const res = await get(branchA);
    expect(res.status).toBe(200);
    for (const p of res.body.products.slice(0, 12)) {
      const sizes = await auth(api().get(SIZES).query({ sourceBranchId: branchA, productSkuId: p.productSkuId }));
      const enabled = sizes.body.options.filter((o: { enabled: boolean }) => o.enabled).length;
      expect(enabled).toBeGreaterThan(0);
      expect(enabled).toBe(p.enabledSizeCount);
    }
  });

  it("never lists a product the size endpoint would leave entirely disabled", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "0", "0");
    const sizes = await auth(api().get(SIZES).query({ sourceBranchId: branchA, productSkuId: sku.id }));
    expect(sizes.body.options.every((o: { enabled: boolean }) => !o.enabled)).toBe(true);
    expect(listed((await get(branchA)).body, sku.id)).toHaveLength(0);
  });

  // ── guards ───────────────────────────────────────────────────────────────

  it("forbids a branch the user may not access", async () => {
    const stranger = await handle.prisma.user.create({
      data: {
        name: "أمين مخزن آخر",
        phone: "+201110000888",
        passwordHash: await bcrypt.hash("Pwd@2026!", 10),
        role: "WAREHOUSE",
        status: "ACTIVE",
        branchAccesses: { create: [{ branchId: branchB }] },
      },
    });
    const t = (
      await api().post("/api/v1/auth/login").send({ phone: stranger.phone, password: "Pwd@2026!" })
    ).body.accessToken as string;

    const denied = await api().get(PATH).query({ sourceBranchId: branchA }).set("Authorization", `Bearer ${t}`);
    expect(denied.status).toBe(403);
    expect(denied.body.details.reason).toBe("UNAUTHORIZED_BRANCH_ACCESS");

    const allowed = await api().get(PATH).query({ sourceBranchId: branchB }).set("Authorization", `Bearer ${t}`);
    expect(allowed.status).toBe(200);
  });

  it("blocks an inactive source branch with the same semantics as the size endpoint", async () => {
    const closed = await handle.prisma.branch.create({
      data: { nameAr: "فرع مغلق ب", nameEn: "Closed B", active: false },
    });
    const res = await get(closed.id);
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("SOURCE_BRANCH_INACTIVE");
  });

  it("returns a safe 404 for a branch that does not exist", async () => {
    const res = await get("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.details.reason).toBe("SOURCE_BRANCH_NOT_FOUND");
  });

  it("rejects a malformed uuid without leaking internals", async () => {
    const res = await auth(api().get(PATH).query({ sourceBranchId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|SELECT|stack/i);
  });

  it("rejects an unauthenticated caller", async () => {
    expect((await api().get(PATH).query({ sourceBranchId: branchA })).status).toBe(401);
  });

  // ── the read is a read ───────────────────────────────────────────────────

  it("writes absolutely nothing", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "20", "105");

    const before = {
      transfers: await handle.prisma.inventoryTransfer.count(),
      lines: await handle.prisma.inventoryTransferLine.count(),
      movements: await handle.prisma.inventoryMovement.count(),
      journals: await handle.prisma.journalEntry.count(),
      audits: await handle.prisma.auditLog.count(),
      transferAudits: await handle.prisma.auditLog.count({ where: { entityType: "inventory_transfer" } }),
      balances: await handle.prisma.branchInventoryBalance.count(),
      wac: (await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: k.id } })).avgCostPerMeter.toString(),
      trSeq: (
        await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM inventory_transfers_transfer_number_seq`
      )[0]?.last_value.toString(),
      invSeq: (
        await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM sales_invoices_invoice_number_seq`
      )[0]?.last_value.toString(),
    };

    for (let i = 0; i < 3; i++) expect((await get(branchA)).status).toBe(200);

    expect(await handle.prisma.inventoryTransfer.count()).toBe(before.transfers);
    expect(await handle.prisma.inventoryTransferLine.count()).toBe(before.lines);
    expect(await handle.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await handle.prisma.journalEntry.count()).toBe(before.journals);
    expect(await handle.prisma.auditLog.count()).toBe(before.audits);
    expect(await handle.prisma.auditLog.count({ where: { entityType: "inventory_transfer" } })).toBe(before.transferAudits);
    expect(await handle.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(
      (await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: k.id } })).avgCostPerMeter.toString(),
    ).toBe(before.wac);
    expect(
      (await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM inventory_transfers_transfer_number_seq`)[0]?.last_value.toString(),
    ).toBe(before.trSeq);
    expect(
      (await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM sales_invoices_invoice_number_seq`)[0]?.last_value.toString(),
    ).toBe(before.invSeq);
  });

  it("reports committedChanges 0 and the branch it answered about", async () => {
    const res = await get(branchA);
    expect(res.body.committedChanges).toBe(0);
    expect(res.body.sourceBranchId).toBe(branchA);
    expect(typeof res.body.sourceBranchNameAr).toBe("string");
  });

  it("returns a stable, useful order and no duplicate product", async () => {
    const first = (await get(branchA)).body.products.map((p: { code: string }) => p.code);
    const second = (await get(branchA)).body.products.map((p: { code: string }) => p.code);
    expect(second).toEqual(first);
    expect([...first].sort((a, b) => a.localeCompare(b, "ar", { numeric: true }))).toEqual(first);
    const ids = (await get(branchA)).body.products.map((p: { productSkuId: string }) => p.productSkuId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries only what the picker needs — no cost, price or destination data", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "8", "42");
    const p = listed((await get(branchA)).body, sku.id)[0]!;
    expect(Object.keys(p).sort()).toEqual(["code", "enabledSizeCount", "nameAr", "nameEn", "productSkuId"]);
    expect(JSON.stringify(p)).not.toMatch(/cost|price|wac|destination/i);
  });
});
