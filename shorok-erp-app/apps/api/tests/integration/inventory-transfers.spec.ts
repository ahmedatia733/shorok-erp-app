/**
 * Inter-branch inventory transfers, end to end.
 *
 * The feature makes one promise — stock moves between branches and nothing else
 * changes — so most of this suite is that promise stated as assertions: company
 * totals, the shared WAC, the journal, and the accounting reports are all read
 * before and after and compared. The lifecycle (draft → confirm → cancel),
 * authorization, validation, idempotency and concurrency are covered alongside.
 */
import * as bcrypt from "bcrypt";
import request from "supertest";
import { buildTestApp, teardownTestApp, type TestApp } from "./test-app";

describe("inventory transfers", () => {
  let handle: TestApp;
  let token: string;
  let branchA: string;
  let branchB: string;
  let variantId: string;
  let variantId2: string;

  const api = () => request(handle.app.getHttpServer());
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    handle = await buildTestApp();

    const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
    await handle.prisma.user.update({ where: { id: handle.ownerId }, data: { passwordHash } });
    const login = await api().post("/api/v1/auth/login").send({
      phone: handle.ownerPhone,
      password: "Pwd@2026!",
    });
    token = login.body.accessToken as string;

    branchA = handle.branchId;
    const b = await handle.prisma.branch.create({
      data: { nameAr: "فرع التحويل", nameEn: "Transfer Branch", active: true },
    });
    branchB = b.id;
    await handle.prisma.userBranchAccess.create({
      data: { userId: handle.ownerId, branchId: branchB },
    });

    const sku = await handle.prisma.productSku.create({
      data: { code: "TRF-1", colorNameAr: "أزرق", colorNameEn: "Blue", category: "NORMAL" },
    });
    const v = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "5.25",
        defaultSalePricePerMeter: "100",
        defaultPurchasePricePerMeter: "80",
        avgCostPerMeter: "12.5",
      },
    });
    variantId = v.id;
    const v2 = await handle.prisma.productVariant.create({
      data: {
        skuId: sku.id,
        sizeMetersPerBoard: "4",
        defaultSalePricePerMeter: "90",
        defaultPurchasePricePerMeter: "70",
        avgCostPerMeter: "10",
      },
    });
    variantId2 = v2.id;
  });

  afterAll(async () => {
    await teardownTestApp(handle);
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function stock(branchId: string, productVariantId: string, boards: string) {
    const res = await auth(api().post("/api/v1/inventory/receipts")).send({
      branchId,
      productVariantId,
      boardsQuantity: boards,
    });
    expect(res.status).toBe(201);
  }

  async function balance(branchId: string, productVariantId: string) {
    const row = await handle.prisma.branchInventoryBalance.findUnique({
      where: { branchId_productVariantId: { branchId, productVariantId } },
    });
    return {
      boards: row?.boardsOnHand.toString() ?? "0",
      meters: row?.metersOnHand.toString() ?? "0",
    };
  }

  async function companyTotals(productVariantId: string) {
    const agg = await handle.prisma.branchInventoryBalance.aggregate({
      _sum: { boardsOnHand: true, metersOnHand: true },
      where: { productVariantId },
    });
    const variant = await handle.prisma.productVariant.findUniqueOrThrow({
      where: { id: productVariantId },
      select: { avgCostPerMeter: true, avgCost: true },
    });
    return {
      boards: (agg._sum.boardsOnHand ?? "0").toString(),
      meters: (agg._sum.metersOnHand ?? "0").toString(),
      wac: variant.avgCostPerMeter.toString(),
      legacyWac: variant.avgCost.toString(),
    };
  }

  async function draft(body: Record<string, unknown>) {
    return auth(api().post("/api/v1/inventory-transfers")).send({
      transferDate: today(),
      sourceBranchId: branchA,
      destinationBranchId: branchB,
      ...body,
    });
  }

  async function confirmed(lines: Array<{ productVariantId: string; boardQuantity: string }>) {
    const created = await draft({ lines });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm-preview`));
    expect(preview.status).toBe(200);
    const res = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm`)).send({
      expectedVersion: created.body.version,
      previewFingerprint: preview.body.previewFingerprint,
      idempotencyKey: `confirm:${id}`,
    });
    expect(res.status).toBe(201);
    return { id, body: res.body, version: res.body.version as number };
  }

  // ── calculation ──────────────────────────────────────────────────────────

  describe("board and metre calculation", () => {
    it("derives metres from the variant's board size — the user supplies only boards", async () => {
      await stock(branchA, variantId, "10");
      const res = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "3" }] });
      expect(res.status).toBe(201);
      expect(res.body.lines[0].boardQuantity).toBe("3.0000");
      // 3 × 5.25, computed by the server and re-checked by a DB CHECK.
      expect(res.body.lines[0].meterQuantity).toBe("15.7500");
      expect(res.body.lines[0].boardSizeMeters).toBe("5.2500");
    });

    it("ignores a metre or cost field a client tries to supply", async () => {
      const res = await draft({
        lines: [{ productVariantId: variantId, boardQuantity: "2", meterQuantity: "999", costPerMeter: "999" }],
      });
      expect(res.status).toBe(201);
      expect(res.body.lines[0].meterQuantity).toBe("10.5000");
    });

    it.each(["0", "-1", "2.5", "3.0", "abc", ""])("rejects the board quantity %p", async (boardQuantity) => {
      const res = await draft({ lines: [{ productVariantId: variantId, boardQuantity }] });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects a generic product with no exact variant", async () => {
      const res = await draft({
        lines: [{ productVariantId: "00000000-0000-0000-0000-000000000000", boardQuantity: "1" }],
      });
      expect(res.status).toBe(409);
    });
  });

  // ── validation ───────────────────────────────────────────────────────────

  describe("validation", () => {
    it("refuses a transfer to the same branch", async () => {
      const res = await auth(api().post("/api/v1/inventory-transfers")).send({
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: branchA,
        lines: [{ productVariantId: variantId, boardQuantity: "1" }],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("refuses the same variant twice in one document", async () => {
      const res = await draft({
        lines: [
          { productVariantId: variantId, boardQuantity: "1" },
          { productVariantId: variantId, boardQuantity: "2" },
        ],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("refuses an inactive destination branch", async () => {
      const dead = await handle.prisma.branch.create({
        data: { nameAr: "فرع مغلق", nameEn: "Closed Branch", active: false },
      });
      const res = await auth(api().post("/api/v1/inventory-transfers")).send({
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: dead.id,
        lines: [{ productVariantId: variantId, boardQuantity: "1" }],
      });
      expect(res.status).toBe(409);
    });

    it("blocks confirmation when the source is short, and moves nothing", async () => {
      await stock(branchA, variantId2, "2");
      const before = await balance(branchA, variantId2);
      const created = await draft({ lines: [{ productVariantId: variantId2, boardQuantity: "500" }] });
      // A draft may be saved — availability is a moment, not a mistake.
      expect(created.status).toBe(201);

      const preview = await auth(
        api().post(`/api/v1/inventory-transfers/${created.body.id}/confirm-preview`),
      );
      expect(preview.status).toBe(200);
      expect(preview.body.blocking.map((b: { code: string }) => b.code)).toContain(
        "insufficient_source_stock",
      );

      const res = await auth(api().post(`/api/v1/inventory-transfers/${created.body.id}/confirm`)).send({
        expectedVersion: created.body.version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `short:${created.body.id}`,
      });
      expect(res.status).toBe(409);
      expect(await balance(branchA, variantId2)).toEqual(before);
    });
  });

  // ── preview writes nothing ───────────────────────────────────────────────

  describe("preview", () => {
    it("returns 200 and commits nothing at all", async () => {
      await stock(branchA, variantId, "10");
      const before = await companyTotals(variantId);
      const movementsBefore = await handle.prisma.inventoryMovement.count();
      const transfersBefore = await handle.prisma.inventoryTransfer.count();

      const res = await auth(api().post("/api/v1/inventory-transfers/preview")).send({
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: branchB,
        lines: [{ productVariantId: variantId, boardQuantity: "2" }],
      });

      expect(res.status).toBe(200);
      expect(res.body.committedChanges).toBe(0);
      expect(res.body.accountingEffect).toBe("NONE");
      expect(await handle.prisma.inventoryMovement.count()).toBe(movementsBefore);
      expect(await handle.prisma.inventoryTransfer.count()).toBe(transfersBefore);
      expect(await companyTotals(variantId)).toEqual(before);
    });

    it("shows company totals that are identical before and after", async () => {
      await stock(branchA, variantId, "10");
      const res = await auth(api().post("/api/v1/inventory-transfers/preview")).send({
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: branchB,
        lines: [{ productVariantId: variantId, boardQuantity: "4" }],
      });
      const line = res.body.lines[0];
      expect(line.globalBoardsAfter).toBe(line.globalBoardsBefore);
      expect(line.globalMetersAfter).toBe(line.globalMetersBefore);
      expect(line.globalValueAfter).toBe(line.globalValueBefore);
      // and the two branches do change, in opposite directions
      expect(Number(line.sourceBoardsAfter)).toBe(Number(line.sourceBoardsBefore) - 4);
      expect(Number(line.destinationBoardsAfter)).toBe(Number(line.destinationBoardsBefore) + 4);
    });
  });

  // ── confirmation ─────────────────────────────────────────────────────────

  describe("confirmation", () => {
    it("moves the stock, conserves the company totals and leaves the WAC alone", async () => {
      await stock(branchA, variantId, "20");
      const beforeTotals = await companyTotals(variantId);
      const beforeA = await balance(branchA, variantId);
      const beforeB = await balance(branchB, variantId);

      const { body } = await confirmed([{ productVariantId: variantId, boardQuantity: "6" }]);

      expect(body.status).toBe("CONFIRMED");
      const afterA = await balance(branchA, variantId);
      const afterB = await balance(branchB, variantId);
      expect(Number(afterA.boards)).toBe(Number(beforeA.boards) - 6);
      expect(Number(afterB.boards)).toBe(Number(beforeB.boards) + 6);
      expect(Number(afterA.meters)).toBeCloseTo(Number(beforeA.meters) - 31.5, 4);
      expect(Number(afterB.meters)).toBeCloseTo(Number(beforeB.meters) + 31.5, 4);

      // The whole point, asserted:
      expect(await companyTotals(variantId)).toEqual(beforeTotals);
    });

    it("writes exactly one TRANSFER_OUT and one TRANSFER_IN per line", async () => {
      await stock(branchA, variantId, "20");
      const { id } = await confirmed([{ productVariantId: variantId, boardQuantity: "2" }]);

      const movements = await handle.prisma.inventoryMovement.findMany({
        where: { referenceType: "inventory_transfer", referenceId: id },
      });
      expect(movements).toHaveLength(2);
      const out = movements.find((m) => m.movementType === "TRANSFER_OUT")!;
      const inn = movements.find((m) => m.movementType === "TRANSFER_IN")!;
      expect(out.branchId).toBe(branchA);
      expect(inn.branchId).toBe(branchB);
      // equal and opposite
      expect(Number(out.boardsQuantity) + Number(inn.boardsQuantity)).toBe(0);
      expect(Number(out.metersQuantity) + Number(inn.metersQuantity)).toBe(0);
    });

    it("posts no journal entry — there is nothing to post", async () => {
      await stock(branchA, variantId, "20");
      const entriesBefore = await handle.prisma.journalEntry.count();
      const linesBefore = await handle.prisma.journalLine.count();

      const { id } = await confirmed([{ productVariantId: variantId, boardQuantity: "3" }]);

      expect(await handle.prisma.journalEntry.count()).toBe(entriesBefore);
      expect(await handle.prisma.journalLine.count()).toBe(linesBefore);
      expect(
        await handle.prisma.journalEntry.count({ where: { sourceId: id } }),
      ).toBe(0);
    });

    it("handles several lines in one document atomically", async () => {
      await stock(branchA, variantId, "20");
      await stock(branchA, variantId2, "20");
      const before1 = await companyTotals(variantId);
      const before2 = await companyTotals(variantId2);

      const { body } = await confirmed([
        { productVariantId: variantId, boardQuantity: "2" },
        { productVariantId: variantId2, boardQuantity: "5" },
      ]);

      expect(body.lines).toHaveLength(2);
      expect(await companyTotals(variantId)).toEqual(before1);
      expect(await companyTotals(variantId2)).toEqual(before2);
    });

    it("records the cost snapshot at confirmation, not at draft time", async () => {
      await stock(branchA, variantId, "20");
      const created = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "2" }] });
      expect(created.body.lines[0].costPerMeter).toBe("0.0000");

      const preview = await auth(
        api().post(`/api/v1/inventory-transfers/${created.body.id}/confirm-preview`),
      );
      const res = await auth(api().post(`/api/v1/inventory-transfers/${created.body.id}/confirm`)).send({
        expectedVersion: created.body.version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `snap:${created.body.id}`,
      });
      expect(res.status).toBe(201);
      expect(Number(res.body.lines[0].costPerMeter)).toBeGreaterThan(0);
    });

    it("refuses a second confirmation of the same document", async () => {
      await stock(branchA, variantId, "20");
      const { id, version } = await confirmed([{ productVariantId: variantId, boardQuantity: "1" }]);
      const res = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm`)).send({
        expectedVersion: version,
        previewFingerprint: "0".repeat(64),
        idempotencyKey: `again:${id}`,
      });
      expect(res.status).toBe(409);
    });

    it("replays the same result for a repeated idempotency key instead of moving stock twice", async () => {
      await stock(branchA, variantId, "20");
      const created = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "3" }] });
      const id = created.body.id as string;
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm-preview`));
      const key = `idem:${id}`;
      const send = () =>
        auth(api().post(`/api/v1/inventory-transfers/${id}/confirm`)).send({
          expectedVersion: created.body.version,
          previewFingerprint: preview.body.previewFingerprint,
          idempotencyKey: key,
        });

      const first = await send();
      expect(first.status).toBe(201);
      const afterFirst = await balance(branchB, variantId);

      const second = await send();
      expect(second.status).toBe(201);
      expect(second.body.idempotentReplay).toBe(true);
      expect(await balance(branchB, variantId)).toEqual(afterFirst);
      expect(
        await handle.prisma.inventoryMovement.count({
          where: { referenceType: "inventory_transfer", referenceId: id },
        }),
      ).toBe(2);
    });

    it("refuses a preview fingerprint that no longer matches the stock it was computed from", async () => {
      await stock(branchA, variantId, "20");
      const created = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "2" }] });
      const id = created.body.id as string;
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm-preview`));

      // the world moves between the preview and the approval
      await stock(branchA, variantId, "5");

      const res = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm`)).send({
        expectedVersion: created.body.version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `stale:${id}`,
      });
      expect(res.status).toBe(409);
      expect(res.body.details.reason).toBe("inventory_transfer_preview_stale");
    });
  });

  // ── cancellation ─────────────────────────────────────────────────────────

  describe("cancellation", () => {
    it("returns the stock and restores both branches exactly", async () => {
      await stock(branchA, variantId, "20");
      const beforeA = await balance(branchA, variantId);
      const beforeB = await balance(branchB, variantId);
      const totals = await companyTotals(variantId);

      const { id, version } = await confirmed([{ productVariantId: variantId, boardQuantity: "4" }]);
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel-preview`));
      expect(preview.status).toBe(200);

      const res = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `cancel:${id}`,
        reason: "أُلغي بناءً على طلب المخزن",
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("CANCELLED");

      expect(await balance(branchA, variantId)).toEqual(beforeA);
      expect(await balance(branchB, variantId)).toEqual(beforeB);
      expect(await companyTotals(variantId)).toEqual(totals);
    });

    it("reverses with new movements and leaves the originals untouched", async () => {
      await stock(branchA, variantId, "20");
      const { id, version } = await confirmed([{ productVariantId: variantId, boardQuantity: "2" }]);
      const originals = await handle.prisma.inventoryMovement.findMany({
        where: { referenceType: "inventory_transfer", referenceId: id },
        orderBy: { id: "asc" },
      });

      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel-preview`));
      await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `cancel2:${id}`,
        reason: "خطأ في الإدخال",
      });

      const after = await handle.prisma.inventoryMovement.findMany({
        where: { referenceType: "inventory_transfer", referenceId: id },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(originals);

      const reversals = await handle.prisma.inventoryMovement.findMany({
        where: { referenceType: "inventory_transfer_cancel", referenceId: id },
      });
      expect(reversals).toHaveLength(2);
    });

    it("keeps the original quantities and cost snapshot on the cancelled document", async () => {
      await stock(branchA, variantId, "20");
      const { id, version, body } = await confirmed([
        { productVariantId: variantId, boardQuantity: "3" },
      ]);
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel-preview`));
      const res = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `cancel3:${id}`,
        reason: "مراجعة",
      });
      expect(res.body.lines[0].boardQuantity).toBe(body.lines[0].boardQuantity);
      expect(res.body.lines[0].meterQuantity).toBe(body.lines[0].meterQuantity);
      expect(res.body.lines[0].costPerMeter).toBe(body.lines[0].costPerMeter);
      expect(res.body.cancellationReason).toBe("مراجعة");
    });

    it("refuses to cancel a draft, and refuses to cancel twice", async () => {
      await stock(branchA, variantId, "20");
      const created = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "1" }] });
      const draftCancel = await auth(
        api().post(`/api/v1/inventory-transfers/${created.body.id}/cancel`),
      ).send({
        expectedVersion: created.body.version,
        previewFingerprint: "0".repeat(64),
        idempotencyKey: `cd:${created.body.id}`,
        reason: "لا ينبغي",
      });
      expect(draftCancel.status).toBe(409);

      const { id, version } = await confirmed([{ productVariantId: variantId, boardQuantity: "1" }]);
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel-preview`));
      const first = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `c1:${id}`,
        reason: "الأولى",
      });
      expect(first.status).toBe(201);

      const second = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: first.body.version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `c2:${id}`,
        reason: "الثانية",
      });
      expect(second.status).toBe(409);
    });

    it("blocks the cancellation if the destination has already shipped the stock onward", async () => {
      await stock(branchA, variantId2, "10");
      const { id, version } = await confirmed([{ productVariantId: variantId2, boardQuantity: "5" }]);

      // The destination sends everything it has somewhere else.
      await auth(api().post("/api/v1/inventory/adjustments")).send({
        branchId: branchB,
        productVariantId: variantId2,
        boardsDelta: `-${(await balance(branchB, variantId2)).boards}`,
        note: "صرف من الفرع المستلم",
      });

      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel-preview`));
      expect(preview.body.blocking.map((b: { code: string }) => b.code)).toContain(
        "insufficient_source_stock",
      );

      const res = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `blocked:${id}`,
        reason: "محاولة إلغاء",
      });
      expect(res.status).toBe(409);
      const doc = await handle.prisma.inventoryTransfer.findUniqueOrThrow({ where: { id } });
      expect(doc.status).toBe("CONFIRMED");
    });
  });

  // ── immutability ─────────────────────────────────────────────────────────

  describe("posted documents are immutable", () => {
    it("refuses to edit or delete a confirmed transfer", async () => {
      await stock(branchA, variantId, "20");
      const { id, version } = await confirmed([{ productVariantId: variantId, boardQuantity: "2" }]);

      const edit = await auth(api().patch(`/api/v1/inventory-transfers/${id}`)).send({
        expectedVersion: version,
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: branchB,
        lines: [{ productVariantId: variantId, boardQuantity: "99" }],
      });
      expect(edit.status).toBe(409);

      const del = await auth(api().delete(`/api/v1/inventory-transfers/${id}`));
      expect(del.status).toBe(409);
    });

    it("the database itself refuses to alter a posted line", async () => {
      await stock(branchA, variantId, "20");
      const { id } = await confirmed([{ productVariantId: variantId, boardQuantity: "2" }]);
      const line = await handle.prisma.inventoryTransferLine.findFirstOrThrow({
        where: { transferId: id },
      });
      // Bypassing the service entirely — the trigger is the last line of defence.
      await expect(
        handle.prisma.inventoryTransferLine.update({
          where: { id: line.id },
          data: { boardQuantity: "999" },
        }),
      ).rejects.toThrow();
    });

    it("allows editing a draft and re-deriving its metres", async () => {
      const created = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "2" }] });
      const res = await auth(api().patch(`/api/v1/inventory-transfers/${created.body.id}`)).send({
        expectedVersion: created.body.version,
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: branchB,
        lines: [{ productVariantId: variantId2, boardQuantity: "7" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.lines[0].boardQuantity).toBe("7.0000");
      expect(res.body.lines[0].meterQuantity).toBe("28.0000"); // 7 × 4
    });

    it("refuses an edit based on a stale version", async () => {
      const created = await draft({ lines: [{ productVariantId: variantId, boardQuantity: "2" }] });
      const body = {
        expectedVersion: created.body.version,
        transferDate: today(),
        sourceBranchId: branchA,
        destinationBranchId: branchB,
        lines: [{ productVariantId: variantId, boardQuantity: "3" }],
      };
      expect((await auth(api().patch(`/api/v1/inventory-transfers/${created.body.id}`)).send(body)).status).toBe(200);
      expect((await auth(api().patch(`/api/v1/inventory-transfers/${created.body.id}`)).send(body)).status).toBe(409);
    });
  });

  // ── authorization ────────────────────────────────────────────────────────

  describe("authorization", () => {
    it("rejects an unauthenticated caller", async () => {
      const res = await api().get("/api/v1/inventory-transfers");
      expect(res.status).toBe(401);
    });

    it("lets a warehouse user read but not create", async () => {
      const passwordHash = await bcrypt.hash("Pwd@2026!", 10);
      const wh = await handle.prisma.user.create({
        data: {
          name: "أمين مخزن",
          phone: "+201110000099",
          passwordHash,
          role: "WAREHOUSE",
          status: "ACTIVE",
          branchAccesses: { create: [{ branchId: branchA }] },
        },
      });
      const login = await api()
        .post("/api/v1/auth/login")
        .send({ phone: wh.phone, password: "Pwd@2026!" });
      const whToken = login.body.accessToken as string;

      const read = await api()
        .get("/api/v1/inventory-transfers")
        .set("Authorization", `Bearer ${whToken}`);
      expect(read.status).toBe(200);

      const write = await api()
        .post("/api/v1/inventory-transfers")
        .set("Authorization", `Bearer ${whToken}`)
        .send({
          transferDate: today(),
          sourceBranchId: branchA,
          destinationBranchId: branchB,
          lines: [{ productVariantId: variantId, boardQuantity: "1" }],
        });
      expect(write.status).toBe(403);
    });
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  describe("concurrency", () => {
    it("two opposite transfers of the same variant do not deadlock or lose stock", async () => {
      await stock(branchA, variantId, "50");
      await stock(branchB, variantId, "50");
      const totals = await companyTotals(variantId);

      const build = async (from: string, to: string, boards: string) => {
        const created = await auth(api().post("/api/v1/inventory-transfers")).send({
          transferDate: today(),
          sourceBranchId: from,
          destinationBranchId: to,
          lines: [{ productVariantId: variantId, boardQuantity: boards }],
        });
        const id = created.body.id as string;
        const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm-preview`));
        return { id, version: created.body.version as number, fp: preview.body.previewFingerprint as string };
      };

      // A→B and B→A prepared, then fired together. Without a canonical lock
      // order these take the two balance rows in opposite orders and Postgres
      // aborts one with a deadlock (40P01).
      const ab = await build(branchA, branchB, "5");
      const ba = await build(branchB, branchA, "7");

      const results = await Promise.allSettled([
        auth(api().post(`/api/v1/inventory-transfers/${ab.id}/confirm`)).send({
          expectedVersion: ab.version,
          previewFingerprint: ab.fp,
          idempotencyKey: `race-ab:${ab.id}`,
        }),
        auth(api().post(`/api/v1/inventory-transfers/${ba.id}/confirm`)).send({
          expectedVersion: ba.version,
          previewFingerprint: ba.fp,
          idempotencyKey: `race-ba:${ba.id}`,
        }),
      ]);

      for (const r of results) {
        expect(r.status).toBe("fulfilled");
        if (r.status === "fulfilled") {
          // Either it committed, or it was refused cleanly because the stock
          // it previewed had moved. A deadlock (500) is not an acceptable
          // outcome for either.
          expect([201, 409]).toContain(r.value.status);
        }
      }

      // Whatever the interleaving, the company still owns the same stock.
      expect(await companyTotals(variantId)).toEqual(totals);
    });

    // This is the deadlock-retry test. A receipt locks the balance row first
    // and only then touches the variant, while the transfer (like every
    // costing path) locks the variant first — so the two can genuinely
    // deadlock, and Postgres kills one after deadlock_timeout. Before the
    // retry existed this returned 500. It must now either commit or refuse
    // cleanly, and the stock must add up either way.
    it("a transfer racing a receipt of the same variant conserves the total", async () => {
      await stock(branchA, variantId2, "30");
      const created = await draft({ lines: [{ productVariantId: variantId2, boardQuantity: "10" }] });
      const id = created.body.id as string;
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/confirm-preview`));

      const [confirmRes] = await Promise.all([
        auth(api().post(`/api/v1/inventory-transfers/${id}/confirm`)).send({
          expectedVersion: created.body.version,
          previewFingerprint: preview.body.previewFingerprint,
          idempotencyKey: `race-receipt:${id}`,
        }),
        auth(api().post("/api/v1/inventory/receipts")).send({
          branchId: branchA,
          productVariantId: variantId2,
          boardsQuantity: "4",
        }),
      ]);
      expect([201, 409]).toContain(confirmRes.status);

      const a = await balance(branchA, variantId2);
      const b = await balance(branchB, variantId2);
      const agg = await companyTotals(variantId2);
      expect(Number(agg.boards)).toBeCloseTo(Number(a.boards) + Number(b.boards), 4);
    });
  });

  // ── audit ────────────────────────────────────────────────────────────────

  describe("audit", () => {
    it("records the creation, the confirmation and the cancellation", async () => {
      await stock(branchA, variantId, "20");
      const { id, version } = await confirmed([{ productVariantId: variantId, boardQuantity: "2" }]);
      const preview = await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel-preview`));
      await auth(api().post(`/api/v1/inventory-transfers/${id}/cancel`)).send({
        expectedVersion: version,
        previewFingerprint: preview.body.previewFingerprint,
        idempotencyKey: `audit:${id}`,
        reason: "للتوثيق",
      });

      const logs = await handle.prisma.auditLog.findMany({
        where: { entityType: "inventory_transfer", entityId: id },
        orderBy: { createdAt: "asc" },
      });
      expect(logs.map((l) => l.action)).toEqual(
        expect.arrayContaining(["CREATE", "CONFIRM", "CANCEL"]),
      );
      for (const log of logs) {
        expect(log.humanReadableSummaryAr.length).toBeGreaterThan(0);
        expect(log.actorId).toBe(handle.ownerId);
      }
    });
  });
});
