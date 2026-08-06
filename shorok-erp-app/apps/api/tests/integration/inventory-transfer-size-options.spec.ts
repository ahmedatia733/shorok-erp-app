/**
 * Source-stock-driven size options.
 *
 * The screen is only trustworthy if the cards describe the selected branch and
 * nothing else, so the bulk of this suite is about what must NOT appear:
 * stock from another branch, a size the product does not have, two custom
 * variants collapsed into one button, or a balance that disagrees with itself
 * quietly enabling a transfer.
 *
 * It also pins the read as a read: the endpoint must leave the database exactly
 * as it found it.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("inventory transfer source-size options", () => {
  let handle: TestApp;
  let token: string;
  let branchA: string;
  let branchB: string;

  const api = () => request(handle.app.getHttpServer());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const PATH = "/api/v1/inventory-transfers/source-size-options";

  beforeAll(async () => {
    handle = await buildTestApp();
    await handle.prisma.user.update({
      where: { id: handle.ownerId },
      data: { passwordHash: await bcrypt.hash("Pwd@2026!", 10) },
    });
    const login = await api()
      .post("/api/v1/auth/login")
      .send({ phone: handle.ownerPhone, password: "Pwd@2026!" });
    token = login.body.accessToken as string;

    branchA = handle.branchId;
    branchB = (
      await handle.prisma.branch.create({
        data: { nameAr: "فرع المقاسات", nameEn: "Sizes Branch", active: true },
      })
    ).id;
    await handle.prisma.userBranchAccess.create({
      data: { userId: handle.ownerId, branchId: branchB },
    });
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  // ── fixtures ─────────────────────────────────────────────────────────────

  let seq = 0;
  async function makeSku(active = true) {
    seq += 1;
    return handle.prisma.productSku.create({
      data: {
        code: `SZ-${seq}-${Date.now().toString().slice(-5)}`,
        colorNameAr: "أسود مط",
        colorNameEn: "Matte Black",
        category: "NORMAL",
        active,
      },
    });
  }

  async function makeVariant(skuId: string, size: string, active = true) {
    return handle.prisma.productVariant.create({
      data: {
        skuId,
        sizeMetersPerBoard: size,
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
        avgCostPerMeter: "498",
        active,
      },
    });
  }

  /** Writes a balance directly so a deliberately inconsistent row can exist. */
  async function setBalance(branchId: string, productVariantId: string, boards: string, meters: string) {
    await handle.prisma.branchInventoryBalance.upsert({
      where: { branchId_productVariantId: { branchId, productVariantId } },
      create: { branchId, productVariantId, boardsOnHand: boards, metersOnHand: meters },
      update: { boardsOnHand: boards, metersOnHand: meters },
    });
  }

  const get = (sourceBranchId: string, productSkuId: string) =>
    auth(api().get(PATH).query({ sourceBranchId, productSkuId }));

  const byVariant = (body: { options: Array<{ productVariantId: string }> }, id: string) =>
    body.options.find((o) => o.productVariantId === id);

  // ── option composition ───────────────────────────────────────────────────

  it("shows ك enabled and ص disabled when only the 5.25 m size has stock", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "20", "105");

    const res = await get(branchA, sku.id);
    expect(res.status).toBe(200);

    const kOpt = byVariant(res.body, k.id)!;
    const sOpt = byVariant(res.body, s.id)!;
    expect(kOpt.sizeBadgeAr).toBe("ك");
    expect(kOpt.enabled).toBe(true);
    expect(kOpt.boardsAvailable).toBe("20.0000");
    expect(kOpt.metersAvailable).toBe("105.0000");

    expect(sOpt.sizeBadgeAr).toBe("ص");
    expect(sOpt.enabled).toBe(false);
    expect(sOpt.disabledReason).toBe("SOURCE_SIZE_OPTION_UNAVAILABLE");
    expect(sOpt.disabledReasonAr).toBe("غير متاح في المخزن المحدد");

    // and no phantom custom option was invented
    expect(res.body.options.filter((o: { sizeBadge: string }) => o.sizeBadge === "CUSTOM")).toHaveLength(0);
    expect(res.body.options).toHaveLength(2);
  });

  it("shows ص enabled and ك disabled when only the 4.00 m size has stock", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, s.id, "12", "48");

    const res = await get(branchA, sku.id);
    expect(byVariant(res.body, s.id)!.enabled).toBe(true);
    expect(byVariant(res.body, s.id)!.metersAvailable).toBe("48.0000");
    expect(byVariant(res.body, k.id)!.enabled).toBe(false);
  });

  it("enables both, each mapped to its own exact ProductVariant", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "20", "105");
    await setBalance(branchA, s.id, "12", "48");

    const res = await get(branchA, sku.id);
    expect(byVariant(res.body, k.id)!.enabled).toBe(true);
    expect(byVariant(res.body, s.id)!.enabled).toBe(true);
    // distinct ids, distinct sizes — no merging
    const ids = res.body.options.map((o: { productVariantId: string }) => o.productVariantId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byVariant(res.body, k.id)!.boardSizeMeters).toBe("5.2500");
    expect(byVariant(res.body, s.id)!.boardSizeMeters).toBe("4.0000");
  });

  it("shows ك, ص and a custom 6 m as three distinct options in scan order", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    const c = await makeVariant(sku.id, "6");
    await setBalance(branchA, k.id, "20", "105");
    await setBalance(branchA, s.id, "12", "48");
    await setBalance(branchA, c.id, "3", "18");

    const res = await get(branchA, sku.id);
    expect(res.body.options).toHaveLength(3);
    expect(res.body.options.map((o: { sizeBadgeAr: string }) => o.sizeBadgeAr)).toEqual(["ك", "ص", "م/خ"]);
    const custom = byVariant(res.body, c.id)!;
    expect(custom.dimensionsLabelAr).toBe("6.00 م");
    expect(custom.enabled).toBe(true);
    expect(custom.boardsAvailable).toBe("3.0000");
  });

  it("keeps every custom variant separate — never one generic م/خ button", async () => {
    const sku = await makeSku();
    const c6 = await makeVariant(sku.id, "6");
    const c35 = await makeVariant(sku.id, "3.5");
    const c3 = await makeVariant(sku.id, "3");
    for (const [v, b, m] of [
      [c6, "3", "18"],
      [c35, "4", "14"],
      [c3, "2", "6"],
    ] as const) {
      await setBalance(branchA, v.id, b, m);
    }

    const res = await get(branchA, sku.id);
    const customs = res.body.options.filter((o: { sizeBadge: string }) => o.sizeBadge === "CUSTOM");
    expect(customs).toHaveLength(3);
    expect(new Set(customs.map((o: { productVariantId: string }) => o.productVariantId)).size).toBe(3);
    // ascending size within the custom group
    expect(customs.map((o: { dimensionsLabelAr: string }) => o.dimensionsLabelAr)).toEqual([
      "3.00 م",
      "3.50 م",
      "6.00 م",
    ]);
    // a variant never gains a width it does not store
    for (const o of customs) expect(o.widthMeters).toBeNull();
  });

  // ── branch isolation ─────────────────────────────────────────────────────

  it("does not enable an option from stock that sits in the destination branch", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchB, k.id, "50", "262.5");

    const res = await get(branchA, sku.id);
    const opt = byVariant(res.body, k.id)!;
    expect(opt.enabled).toBe(false);
    expect(opt.boardsAvailable).toBe("0.0000");
  });

  it("does not enable an option from stock held in an unrelated branch", async () => {
    const other = await handle.prisma.branch.create({
      data: { nameAr: "فرع بعيد", nameEn: "Far Branch", active: true },
    });
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(other.id, k.id, "99", "519.75");

    const res = await get(branchA, sku.id);
    expect(byVariant(res.body, k.id)!.enabled).toBe(false);
  });

  // ── disabling rules ──────────────────────────────────────────────────────

  it("disables a zero board balance", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "0", "0");
    const res = await get(branchA, sku.id);
    expect(byVariant(res.body, k.id)!.enabled).toBe(false);
    expect(byVariant(res.body, k.id)!.disabledReason).toBe("SOURCE_SIZE_OPTION_UNAVAILABLE");
  });

  it("disables a variant with no balance row at all", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const res = await get(branchA, sku.id);
    const opt = byVariant(res.body, k.id)!;
    expect(opt.enabled).toBe(false);
    expect(opt.boardsAvailable).toBe("0.0000");
    expect(opt.metersAvailable).toBe("0.0000");
  });

  it("disables an inconsistent balance and repairs nothing", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    // boards say none, metres say some — a pre-existing data problem
    await setBalance(branchA, k.id, "0", "5");

    const res = await get(branchA, sku.id);
    const opt = byVariant(res.body, k.id)!;
    expect(opt.enabled).toBe(false);
    expect(opt.disabledReason).toBe("SOURCE_BALANCE_INCONSISTENT");
    expect(opt.disabledReasonAr).toBe("الرصيد يحتاج مراجعة قبل التحويل");

    // the row is left exactly as it was — reporting a problem is not fixing it
    const after = await handle.prisma.branchInventoryBalance.findUniqueOrThrow({
      where: { branchId_productVariantId: { branchId: branchA, productVariantId: k.id } },
    });
    expect(after.boardsOnHand.toString()).toBe("0");
    expect(after.metersOnHand.toString()).toBe("5");
  });

  it("disables an inactive variant even when it has stock", async () => {
    const sku = await makeSku();
    const dead = await makeVariant(sku.id, "5.25", false);
    await setBalance(branchA, dead.id, "10", "52.5");
    const res = await get(branchA, sku.id);
    const opt = byVariant(res.body, dead.id)!;
    expect(opt.enabled).toBe(false);
    expect(opt.disabledReason).toBe("VARIANT_INACTIVE");
  });

  // ── guards ───────────────────────────────────────────────────────────────

  it("blocks an inactive base product", async () => {
    const sku = await makeSku(false);
    await makeVariant(sku.id, "5.25");
    const res = await get(branchA, sku.id);
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("PRODUCT_INACTIVE");
  });

  it("blocks an inactive source branch", async () => {
    const closed = await handle.prisma.branch.create({
      data: { nameAr: "فرع مقفل", nameEn: "Shut Branch", active: false },
    });
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    const res = await get(closed.id, sku.id);
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("SOURCE_BRANCH_INACTIVE");
  });

  it("returns a safe 404 for a product that does not exist", async () => {
    const res = await get(branchA, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.details.reason).toBe("PRODUCT_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|SELECT/i);
  });

  it("rejects a malformed query without leaking internals", async () => {
    const res = await auth(api().get(PATH).query({ sourceBranchId: "nope", productSkuId: "nope" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|SELECT|stack/i);
  });

  it("forbids a branch the user may not access", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    const stranger = await handle.prisma.user.create({
      data: {
        name: "أمين فرع آخر",
        phone: "+201110000777",
        passwordHash: await bcrypt.hash("Pwd@2026!", 10),
        role: "WAREHOUSE",
        status: "ACTIVE",
        branchAccesses: { create: [{ branchId: branchB }] },
      },
    });
    const login = await api()
      .post("/api/v1/auth/login")
      .send({ phone: stranger.phone, password: "Pwd@2026!" });
    const strangerToken = login.body.accessToken as string;

    const denied = await api()
      .get(PATH)
      .query({ sourceBranchId: branchA, productSkuId: sku.id })
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.details.reason).toBe("UNAUTHORIZED_BRANCH_ACCESS");

    // ...but their own branch is fine
    const allowed = await api()
      .get(PATH)
      .query({ sourceBranchId: branchB, productSkuId: sku.id })
      .set("Authorization", `Bearer ${strangerToken}`);
    expect(allowed.status).toBe(200);
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await api().get(PATH).query({ sourceBranchId: branchA, productSkuId: branchA });
    expect(res.status).toBe(401);
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
      balances: await handle.prisma.branchInventoryBalance.count(),
      journals: await handle.prisma.journalEntry.count(),
      audits: await handle.prisma.auditLog.count(),
      transferAudits: await handle.prisma.auditLog.count({ where: { entityType: "inventory_transfer" } }),
      balanceRow: (
        await handle.prisma.branchInventoryBalance.findUniqueOrThrow({
          where: { branchId_productVariantId: { branchId: branchA, productVariantId: k.id } },
        })
      ).boardsOnHand.toString(),
      variantWac: (
        await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: k.id } })
      ).avgCostPerMeter.toString(),
      seq: (
        await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`
          SELECT last_value FROM inventory_transfers_transfer_number_seq`
      )[0]?.last_value.toString(),
    };

    // hit it repeatedly — a read stays a read however often it is called
    for (let i = 0; i < 3; i++) expect((await get(branchA, sku.id)).status).toBe(200);

    expect(await handle.prisma.inventoryTransfer.count()).toBe(before.transfers);
    expect(await handle.prisma.inventoryTransferLine.count()).toBe(before.lines);
    expect(await handle.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await handle.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(await handle.prisma.journalEntry.count()).toBe(before.journals);
    expect(await handle.prisma.auditLog.count()).toBe(before.audits);
    expect(
      await handle.prisma.auditLog.count({ where: { entityType: "inventory_transfer" } }),
    ).toBe(before.transferAudits);
    expect(
      (
        await handle.prisma.branchInventoryBalance.findUniqueOrThrow({
          where: { branchId_productVariantId: { branchId: branchA, productVariantId: k.id } },
        })
      ).boardsOnHand.toString(),
    ).toBe(before.balanceRow);
    expect(
      (await handle.prisma.productVariant.findUniqueOrThrow({ where: { id: k.id } })).avgCostPerMeter.toString(),
    ).toBe(before.variantWac);
    const seqAfter = (
      await handle.prisma.$queryRaw<Array<{ last_value: bigint }>>`
        SELECT last_value FROM inventory_transfers_transfer_number_seq`
    )[0]?.last_value.toString();
    expect(seqAfter).toBe(before.seq);
  });

  it("reports the response with committedChanges 0", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    const res = await get(branchA, sku.id);
    expect(res.body.committedChanges).toBe(0);
  });

  // ── serialization ────────────────────────────────────────────────────────

  it("returns quantities as canonical 4-decimal strings, not floats", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "20", "105");
    const res = await get(branchA, sku.id);
    const o = byVariant(res.body, k.id)!;
    for (const v of [o.boardSizeMeters, o.boardsAvailable, o.metersAvailable]) {
      expect(typeof v).toBe("string");
      expect(v).toMatch(/^\d+\.\d{4}$/);
    }
    expect(o.boardSizeMeters).toBe("5.2500");
  });

  it("carries the product identity needed to render the card", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, k.id, "7", "36.75");
    const res = await get(branchA, sku.id);
    expect(res.body.productSkuId).toBe(sku.id);
    expect(res.body.productCode).toBe(sku.code);
    expect(res.body.sourceBranchId).toBe(branchA);
    const o = byVariant(res.body, k.id)!;
    expect(o.variantCode).toBe(sku.code);
    expect(o.variantDisplayNameAr).toContain("ك — 5.25 م");
  });

  it("returns an empty option list for a product with no variants at all", async () => {
    const sku = await makeSku();
    const res = await get(branchA, sku.id);
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual([]);
  });
});
