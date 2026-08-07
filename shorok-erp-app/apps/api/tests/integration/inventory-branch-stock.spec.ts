/**
 * The stock-settlement pickers, and the settlement they feed.
 *
 * «تعديل مخزون» used to offer the entire active catalogue, so the two questions
 * that decide what gets written — which warehouse, and which board size — could
 * be answered with a size that does not exist where the storekeeper is standing.
 * These endpoints answer both from the stock itself.
 *
 * Three things are worth proving and are proved here:
 *   1. the reads are branch-exact and variant-exact, and never invent, borrow or
 *      repair a balance;
 *   2. they agree with the transfer pickers wherever the two ask the same
 *      question, because they are the same code;
 *   3. reading is reading — no movement, no balance, no journal, no sequence.
 *
 * The posting rules are pinned too: whole boards only, and a settlement lands on
 * the one variant it names and leaves its sibling sizes alone.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("branch stock pickers for inventory adjustment", () => {
  let handle: TestApp;
  let token: string;
  let branchA: string;
  let branchB: string;

  const api = () => request(handle.app.getHttpServer());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const PRODUCTS = "/api/v1/inventory/branch-stock/products";
  const SIZES = "/api/v1/inventory/branch-stock/sizes";
  const ADJUST = "/api/v1/inventory/adjustments";
  const TRANSFER_PRODUCTS = "/api/v1/inventory-transfers/source-products";

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
        data: { nameAr: "فرع التسوية", nameEn: "Settlement Branch", active: true },
      })
    ).id;
    await handle.prisma.userBranchAccess.create({ data: { userId: handle.ownerId, branchId: branchB } });
  });

  afterAll(async () => teardownTestApp(handle));

  // ── fixtures ─────────────────────────────────────────────────────────────

  let seq = 0;
  const makeSku = (active = true) => {
    seq += 1;
    return handle.prisma.productSku.create({
      data: {
        code: `BS-${seq}-${Date.now().toString().slice(-5)}`,
        colorNameAr: `صنف تسوية ${seq}`,
        colorNameEn: `Settlement product ${seq}`,
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

  interface SizeRow {
    productVariantId: string;
    sizeBadge: string;
    sizeBadgeAr: string;
    boardSizeMeters: string;
    boardsOnHand: string;
    metersOnHand: string;
    hasStock: boolean;
    adjustable: boolean;
    blockedReason: string | null;
    blockedReasonAr: string | null;
  }

  const products = (branchId: string) => auth(api().get(PRODUCTS).query({ branchId }));
  const sizes = (branchId: string, productSkuId: string) =>
    auth(api().get(SIZES).query({ branchId, productSkuId }));
  const listed = (body: { products: Array<{ productSkuId: string }> }, id: string) =>
    body.products.filter((p) => p.productSkuId === id);
  const sizeOf = (body: { sizes: SizeRow[] }, variantId: string) =>
    body.sizes.find((s) => s.productVariantId === variantId)!;

  // ── the product picker: only what this warehouse actually holds ───────────

  it("lists a product the branch holds, once, with its usable size count", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "10", "52.5");
    await setBalance(branchA, s.id, "3", "12");

    const res = await products(branchA);
    expect(res.status).toBe(200);
    const rows = listed(res.body, sku.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe(sku.code);
    expect(rows[0].nameAr).toBe(sku.colorNameAr);
    expect(rows[0].availableSizeCount).toBe(2);
  });

  it("does not list a product whose stock is in another branch", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25");
    await setBalance(branchB, v.id, "9", "47.25");

    expect(listed((await products(branchA)).body, sku.id)).toHaveLength(0);
    expect(listed((await products(branchB)).body, sku.id)).toHaveLength(1);
  });

  it("does not list a product whose every size sits at zero here", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, v.id, "0", "0");

    expect(listed((await products(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("does not list a product with no balance row at all", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");

    expect(listed((await products(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("does not list an inactive product even when it is holding stock", async () => {
    const sku = await makeSku(false);
    const v = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, v.id, "7", "36.75");

    expect(listed((await products(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("does not list a product kept alive only by an inactive size", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25", false);
    await setBalance(branchA, v.id, "5", "26.25");

    expect(listed((await products(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("does not list a product kept alive only by a balance that disagrees with itself", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25");
    // Boards without metres is not stock; it is a balance needing repair.
    await setBalance(branchA, v.id, "4", "0");

    expect(listed((await products(branchA)).body, sku.id)).toHaveLength(0);
  });

  it("counts only the sizes that are usable here, not every size the product has", async () => {
    const sku = await makeSku();
    const stocked = await makeVariant(sku.id, "5.25");
    const empty = await makeVariant(sku.id, "4");
    const elsewhere = await makeVariant(sku.id, "3.3");
    await setBalance(branchA, stocked.id, "6", "31.5");
    await setBalance(branchA, empty.id, "0", "0");
    await setBalance(branchB, elsewhere.id, "8", "26.4");

    expect(listed((await products(branchA)).body, sku.id)[0].availableSizeCount).toBe(1);
  });

  it("echoes the branch it answered about, so a late reply can be discarded", async () => {
    const res = await products(branchA);
    expect(res.body.branchId).toBe(branchA);
    expect(res.body.branchNameAr).toBeTruthy();
  });

  it("gives the same answer as the transfer product picker — one shared definition", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, v.id, "2", "10.5");

    const mine = (await products(branchA)).body.products.map(
      (p: { productSkuId: string }) => p.productSkuId,
    );
    const theirs = (
      await auth(api().get(TRANSFER_PRODUCTS).query({ sourceBranchId: branchA }))
    ).body.products.map((p: { productSkuId: string }) => p.productSkuId);

    expect([...mine].sort()).toEqual([...theirs].sort());
    expect(mine).toContain(sku.id);
  });

  // ── the size picker: one card per exact variant ───────────────────────────

  it("returns each size as its own exact variant with this branch's own figures", async () => {
    const sku = await makeSku();
    const k = await makeVariant(sku.id, "5.25");
    const s = await makeVariant(sku.id, "4");
    await setBalance(branchA, k.id, "10", "52.5");
    await setBalance(branchA, s.id, "3", "12");

    const res = await sizes(branchA, sku.id);
    expect(res.status).toBe(200);
    expect(res.body.productCode).toBe(sku.code);

    const large = sizeOf(res.body, k.id);
    expect(large.sizeBadge).toBe("LARGE");
    expect(large.sizeBadgeAr).toBe("ك");
    expect(large.boardsOnHand).toBe("10.0000");
    expect(large.metersOnHand).toBe("52.5000");
    expect(large.hasStock).toBe(true);
    expect(large.adjustable).toBe(true);
    expect(large.blockedReason).toBeNull();

    // The sibling keeps its own numbers — no size is ever answered from another.
    const small = sizeOf(res.body, s.id);
    expect(small.sizeBadgeAr).toBe("ص");
    expect(small.boardsOnHand).toBe("3.0000");
    expect(small.metersOnHand).toBe("12.0000");
  });

  it("keeps two custom boards apart even though both read «م/خ»", async () => {
    const sku = await makeSku();
    const a = await makeVariant(sku.id, "3.3");
    const b = await makeVariant(sku.id, "6.1");
    await setBalance(branchA, a.id, "2", "6.6");
    await setBalance(branchA, b.id, "5", "30.5");

    const res = await sizes(branchA, sku.id);
    const first = sizeOf(res.body, a.id);
    const second = sizeOf(res.body, b.id);
    expect(first.sizeBadgeAr).toBe("م/خ");
    expect(second.sizeBadgeAr).toBe("م/خ");
    expect(first.boardsOnHand).toBe("2.0000");
    expect(second.boardsOnHand).toBe("5.0000");
    expect(first.productVariantId).not.toBe(second.productVariantId);
  });

  it("keeps an empty size selectable, because found stock is what a settlement records", async () => {
    const sku = await makeSku();
    const stocked = await makeVariant(sku.id, "5.25");
    const empty = await makeVariant(sku.id, "4");
    await setBalance(branchA, stocked.id, "4", "21");
    await setBalance(branchA, empty.id, "0", "0");

    const row = sizeOf((await sizes(branchA, sku.id)).body, empty.id);
    expect(row.hasStock).toBe(false);
    expect(row.adjustable).toBe(true);
    expect(row.boardsOnHand).toBe("0.0000");
    expect(row.blockedReason).toBeNull();
  });

  it("treats a size with no balance row here as empty rather than missing", async () => {
    const sku = await makeSku();
    const stocked = await makeVariant(sku.id, "5.25");
    const never = await makeVariant(sku.id, "4");
    await setBalance(branchA, stocked.id, "4", "21");

    const row = sizeOf((await sizes(branchA, sku.id)).body, never.id);
    expect(row.hasStock).toBe(false);
    expect(row.adjustable).toBe(true);
    expect(row.boardsOnHand).toBe("0.0000");
  });

  it("blocks a discontinued size instead of letting it quietly gain stock", async () => {
    const sku = await makeSku();
    const live = await makeVariant(sku.id, "5.25");
    const dead = await makeVariant(sku.id, "4", false);
    await setBalance(branchA, live.id, "4", "21");
    await setBalance(branchA, dead.id, "2", "8");

    const row = sizeOf((await sizes(branchA, sku.id)).body, dead.id);
    expect(row.adjustable).toBe(false);
    expect(row.blockedReason).toBe("VARIANT_INACTIVE");
    expect(row.blockedReasonAr).toBeTruthy();
    // The real figures are still reported — the balance is not hidden.
    expect(row.boardsOnHand).toBe("2.0000");
  });

  it("blocks a balance whose boards and metres contradict each other", async () => {
    const sku = await makeSku();
    const live = await makeVariant(sku.id, "5.25");
    const broken = await makeVariant(sku.id, "4");
    await setBalance(branchA, live.id, "4", "21");
    await setBalance(branchA, broken.id, "3", "0");

    const row = sizeOf((await sizes(branchA, sku.id)).body, broken.id);
    expect(row.adjustable).toBe(false);
    expect(row.hasStock).toBe(false);
    expect(row.blockedReason).toBe("BALANCE_NEEDS_REVIEW");
    expect(row.blockedReasonAr).toBeTruthy();
  });

  it("answers per branch: the same size reads differently in two warehouses", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, v.id, "10", "52.5");
    await setBalance(branchB, v.id, "1", "5.25");

    expect(sizeOf((await sizes(branchA, sku.id)).body, v.id).boardsOnHand).toBe("10.0000");
    expect(sizeOf((await sizes(branchB, sku.id)).body, v.id).boardsOnHand).toBe("1.0000");
  });

  it("orders the cards ك, then ص, then the custom boards ascending", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "6.1");
    await makeVariant(sku.id, "4");
    await makeVariant(sku.id, "3.3");
    await makeVariant(sku.id, "5.25");

    const badges = (await sizes(branchA, sku.id)).body.sizes.map((s: SizeRow) => s.sizeBadgeAr);
    expect(badges).toEqual(["ك", "ص", "م/خ", "م/خ"]);
    const customs = (await sizes(branchA, sku.id)).body.sizes
      .filter((s: SizeRow) => s.sizeBadge === "CUSTOM")
      .map((s: SizeRow) => s.boardSizeMeters);
    expect(customs).toEqual(["3.3000", "6.1000"]);
  });

  it("echoes the branch and product it answered about", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    const res = await sizes(branchA, sku.id);
    expect(res.body.branchId).toBe(branchA);
    expect(res.body.productSkuId).toBe(sku.id);
  });

  // ── refusals ─────────────────────────────────────────────────────────────

  it("refuses a branch that does not exist, and one that is closed", async () => {
    const missing = await products("11111111-1111-4111-8111-111111111111");
    expect(missing.status).toBe(404);

    const closed = await handle.prisma.branch.create({
      data: { nameAr: "فرع مغلق", nameEn: "Closed", active: false },
    });
    await handle.prisma.userBranchAccess.create({
      data: { userId: handle.ownerId, branchId: closed.id },
    });
    const res = await products(closed.id);
    expect(res.status).toBe(409);
  });

  it("refuses a malformed branch id rather than guessing", async () => {
    expect((await products("not-a-uuid")).status).toBe(400);
    expect((await auth(api().get(PRODUCTS))).status).toBe(400);
  });

  it("refuses a product that does not exist, and one that is inactive", async () => {
    expect((await sizes(branchA, "11111111-1111-4111-8111-111111111111")).status).toBe(404);

    const dead = await makeSku(false);
    await makeVariant(dead.id, "5.25");
    expect((await sizes(branchA, dead.id)).status).toBe(409);
  });

  it("refuses a branch the caller has no access to", async () => {
    const otherBranch = await handle.prisma.branch.create({
      data: { nameAr: "فرع بعيد", nameEn: "Far branch", active: true },
    });
    const outsider = await handle.prisma.user.create({
      data: {
        name: "أمين مخزن",
        phone: `+2011${Date.now().toString().slice(-8)}`,
        passwordHash: await bcrypt.hash("Pwd@2026!", 10),
        role: "WAREHOUSE",
        status: "ACTIVE",
        branchAccesses: { create: { branchId: otherBranch.id } },
      },
    });
    const outsiderToken = (
      await api().post("/api/v1/auth/login").send({ phone: outsider.phone, password: "Pwd@2026!" })
    ).body.accessToken as string;

    const res = await api()
      .get(PRODUCTS)
      .query({ branchId: branchA })
      .set("Authorization", `Bearer ${outsiderToken}`);
    expect(res.status).toBe(403);
  });

  // ── reading is reading ───────────────────────────────────────────────────

  it("writes nothing: no movement, no balance, no journal, no sequence", async () => {
    const sku = await makeSku();
    const v = await makeVariant(sku.id, "5.25");
    await setBalance(branchA, v.id, "5", "26.25");

    const before = {
      movements: await handle.prisma.inventoryMovement.count(),
      balances: await handle.prisma.branchInventoryBalance.count(),
      journals: await handle.prisma.journalEntry.count(),
      balance: await handle.prisma.branchInventoryBalance.findUnique({
        where: { branchId_productVariantId: { branchId: branchA, productVariantId: v.id } },
      }),
    };

    for (let i = 0; i < 3; i += 1) {
      expect((await products(branchA)).status).toBe(200);
      expect((await sizes(branchA, sku.id)).status).toBe(200);
    }

    expect(await handle.prisma.inventoryMovement.count()).toBe(before.movements);
    expect(await handle.prisma.branchInventoryBalance.count()).toBe(before.balances);
    expect(await handle.prisma.journalEntry.count()).toBe(before.journals);
    const after = await handle.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId: branchA, productVariantId: v.id } },
    });
    expect(after!.boardsOnHand.toFixed(4)).toBe(before.balance!.boardsOnHand.toFixed(4));
    expect(after!.metersOnHand.toFixed(4)).toBe(before.balance!.metersOnHand.toFixed(4));
  });

  it("says so in the payload — committedChanges is zero on both reads", async () => {
    const sku = await makeSku();
    await makeVariant(sku.id, "5.25");
    expect((await products(branchA)).body.committedChanges).toBe(0);
    expect((await sizes(branchA, sku.id)).body.committedChanges).toBe(0);
  });

  // ── the settlement these pickers feed ────────────────────────────────────

  describe("posting a settlement", () => {
    const post = (body: Record<string, unknown>) => auth(api().post(ADJUST)).send(body);

    it("rejects a fractional board rather than settling a quarter of one", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "10", "52.5");
      const before = await handle.prisma.inventoryMovement.count();

      for (const boardsDelta of ["1.5", "0.25", "-2.75", "3.0"]) {
        const res = await post({
          branchId: branchA,
          productVariantId: v.id,
          boardsDelta,
          note: "كسر لوح",
        });
        expect(res.status).toBe(400);
      }
      expect(await handle.prisma.inventoryMovement.count()).toBe(before);
    });

    it("rejects zero and anything that is not a number", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "10", "52.5");

      for (const boardsDelta of ["0", "-0", "", "abc", "1e3", "+3", " "]) {
        const res = await post({
          branchId: branchA,
          productVariantId: v.id,
          boardsDelta,
          note: "لا شيء",
        });
        expect(res.status).toBe(400);
      }
    });

    it("still requires a reason", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "10", "52.5");

      expect(
        (await post({ branchId: branchA, productVariantId: v.id, boardsDelta: "1", note: "  " }))
          .status,
      ).toBe(400);
      expect(
        (await post({ branchId: branchA, productVariantId: v.id, boardsDelta: "1" })).status,
      ).toBe(400);
    });

    it("accepts whole boards up and down, moving metres by that size's own board", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "4");
      await setBalance(branchA, v.id, "10", "40");

      const up = await post({
        branchId: branchA,
        productVariantId: v.id,
        boardsDelta: "3",
        note: "جرد شهري",
      });
      expect(up.status).toBe(201);
      expect(up.body.boardsOnHand).toBe("13.0000");
      expect(up.body.metersOnHand).toBe("52.0000");

      const down = await post({
        branchId: branchA,
        productVariantId: v.id,
        boardsDelta: "-5",
        note: "تلف",
      });
      expect(down.status).toBe(201);
      expect(down.body.boardsOnHand).toBe("8.0000");
      expect(down.body.metersOnHand).toBe("32.0000");
    });

    it("lands on the size it names and leaves the sibling size untouched", async () => {
      const sku = await makeSku();
      const k = await makeVariant(sku.id, "5.25");
      const s = await makeVariant(sku.id, "4");
      await setBalance(branchA, k.id, "10", "52.5");
      await setBalance(branchA, s.id, "6", "24");

      const res = await post({
        branchId: branchA,
        productVariantId: k.id,
        boardsDelta: "-2",
        note: "تسوية ك",
      });
      expect(res.status).toBe(201);

      const sibling = await handle.prisma.branchInventoryBalance.findUnique({
        where: { branchId_productVariantId: { branchId: branchA, productVariantId: s.id } },
      });
      expect(sibling!.boardsOnHand.toFixed(4)).toBe("6.0000");
      expect(sibling!.metersOnHand.toFixed(4)).toBe("24.0000");
    });

    it("settles the branch it names and leaves the same size in the other branch alone", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "10", "52.5");
      await setBalance(branchB, v.id, "4", "21");

      expect(
        (await post({ branchId: branchA, productVariantId: v.id, boardsDelta: "2", note: "جرد" }))
          .status,
      ).toBe(201);

      const other = await handle.prisma.branchInventoryBalance.findUnique({
        where: { branchId_productVariantId: { branchId: branchB, productVariantId: v.id } },
      });
      expect(other!.boardsOnHand.toFixed(4)).toBe("4.0000");
    });

    it("records found stock on a size the branch was holding none of", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "0", "0");

      const res = await post({
        branchId: branchA,
        productVariantId: v.id,
        boardsDelta: "2",
        note: "لوحان ظهرا في الجرد",
      });
      expect(res.status).toBe(201);
      expect(res.body.boardsOnHand).toBe("2.0000");
      expect(res.body.metersOnHand).toBe("10.5000");
    });

    it("corrects the count without touching the books or the cost", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "10", "52.5");
      const journalsBefore = await handle.prisma.journalEntry.count();
      const wacBefore = (await handle.prisma.productVariant.findUnique({ where: { id: v.id } }))!
        .avgCostPerMeter;

      expect(
        (await post({ branchId: branchA, productVariantId: v.id, boardsDelta: "4", note: "جرد" }))
          .status,
      ).toBe(201);

      // A settlement is a count correction, not an accounting event.
      expect(await handle.prisma.journalEntry.count()).toBe(journalsBefore);
      const wacAfter = (await handle.prisma.productVariant.findUnique({ where: { id: v.id } }))!
        .avgCostPerMeter;
      expect(wacAfter.toFixed(4)).toBe(wacBefore.toFixed(4));
    });

    it("writes one ADJUSTMENT movement carrying the reason that was given", async () => {
      const sku = await makeSku();
      const v = await makeVariant(sku.id, "5.25");
      await setBalance(branchA, v.id, "10", "52.5");

      const res = await post({
        branchId: branchA,
        productVariantId: v.id,
        boardsDelta: "-1",
        note: "لوح تالف أثناء التحميل",
      });
      expect(res.status).toBe(201);

      const movement = await handle.prisma.inventoryMovement.findUnique({
        where: { id: res.body.movementId },
      });
      expect(movement!.movementType).toBe("ADJUSTMENT");
      expect(movement!.productVariantId).toBe(v.id);
      expect(movement!.branchId).toBe(branchA);
      expect(movement!.boardsQuantity.toFixed(4)).toBe("-1.0000");
      expect(movement!.metersQuantity.toFixed(4)).toBe("-5.2500");
      expect(movement!.humanReadableNote).toContain("لوح تالف");
    });
  });
});
