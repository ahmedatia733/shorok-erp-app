import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { InventoryEngine } from "../inventory/inventory.engine";
import { FactoryLedgerRecompute } from "../factory-ledger/recompute.sql";
import { ExcelParser, type ParsedOrder, type ParsedInventory, type ParsedExpense, type ParsedFactoryLedger } from "./excel.parser";
import { ImportPreflight } from "./preflight";
import { ConflictError, NotFoundError, ValidationError } from "../../common/errors/api-errors";
import type { AuthenticatedUser } from "../../common/types/request-user";
import * as ExcelJS from "exceljs";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Decimal } from "decimal.js";

const UPLOADS_DIR = path.join(__dirname, "../../../uploads");

interface SessionMetadata {
  kind: string;
  branchId?: string;
  supplierId?: string;
  originalname: string;
}

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventoryEngine: InventoryEngine,
    private readonly ledgerRecompute: FactoryLedgerRecompute,
  ) {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
  }

  private getSessionPaths(sessionId: string) {
    return {
      xlsxPath: path.join(UPLOADS_DIR, `${sessionId}.xlsx`),
      jsonPath: path.join(UPLOADS_DIR, `${sessionId}.json`),
    };
  }

  async dryRun(
    fileBuffer: Buffer,
    originalname: string,
    kind: string,
    branchId?: string,
    supplierId?: string,
  ) {
    const sessionId = crypto.randomUUID();
    const { xlsxPath, jsonPath } = this.getSessionPaths(sessionId);

    // Save uploaded file temporarily
    fs.writeFileSync(xlsxPath, fileBuffer);

    // Save session metadata
    const metadata: SessionMetadata = { kind, branchId, supplierId, originalname };
    fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);

    const validationErrors: any[] = [];
    let rowsParsed = 0;
    let rowsValid = 0;
    const preflightItems: { code: string; size: number }[] = [];

    try {
      if (kind === "orders") {
        if (!branchId) throw new ValidationError({ reason: "branch_id_required" });

        const worksheet = workbook.worksheets[0] || workbook.getWorksheet("الاوردرات");
        if (!worksheet) throw new ValidationError({ reason: "orders_sheet_not_found" });

        const orders = ExcelParser.parseOrders(worksheet);
        rowsParsed = orders.length;

        for (const order of orders) {
          let hasError = false;
          if (!order.code) {
            validationErrors.push({
              row: order.row,
              code: "missing_product_code",
              message_ar: "كود المنتج مفقود.",
              message_en: "Product code is missing.",
            });
            hasError = true;
          }
          if (order.boardsQuantity <= 0) {
            validationErrors.push({
              row: order.row,
              code: "invalid_quantity",
              message_ar: "عدد الألواح يجب أن يكون أكبر من الصفر.",
              message_en: "Boards quantity must be greater than zero.",
            });
            hasError = true;
          }

          if (!hasError) {
            rowsValid++;
            preflightItems.push({ code: order.code, size: order.sizeMetersPerBoard });
          }
        }
      } else if (kind === "inventory") {
        if (!branchId) throw new ValidationError({ reason: "branch_id_required" });

        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new ValidationError({ reason: "inventory_sheet_not_found" });

        const items = ExcelParser.parseInventory(worksheet);
        rowsParsed = items.length;

        for (const item of items) {
          let hasError = false;
          if (!item.code) {
            validationErrors.push({
              row: item.row,
              code: "missing_product_code",
              message_ar: "كود المنتج مفقود.",
              message_en: "Product code is missing.",
            });
            hasError = true;
          }
          if (item.boardsQuantity <= 0) {
            validationErrors.push({
              row: item.row,
              code: "invalid_quantity",
              message_ar: "عدد الألواح يجب أن يكون أكبر من الصفر.",
              message_en: "Boards quantity must be greater than zero.",
            });
            hasError = true;
          }

          if (!hasError) {
            rowsValid++;
            preflightItems.push({ code: item.code, size: item.sizeMetersPerBoard });
          }
        }
      } else if (kind === "expenses") {
        if (!branchId) throw new ValidationError({ reason: "branch_id_required" });

        const worksheet = workbook.worksheets[0] || workbook.getWorksheet("المصروفات");
        if (!worksheet) throw new ValidationError({ reason: "expenses_sheet_not_found" });

        const expenses = ExcelParser.parseExpenses(worksheet);
        rowsParsed = expenses.length;

        for (const expense of expenses) {
          let hasError = false;
          if (!expense.description) {
            validationErrors.push({
              row: expense.row,
              code: "missing_description",
              message_ar: "بيان المصروف مفقود.",
              message_en: "Expense statement/description is missing.",
            });
            hasError = true;
          }
          if (expense.amount <= 0) {
            validationErrors.push({
              row: expense.row,
              code: "invalid_amount",
              message_ar: "المصروف يجب أن يكون أكبر من الصفر.",
              message_en: "Expense amount must be greater than zero.",
            });
            hasError = true;
          }

          if (!hasError) {
            rowsValid++;
          }
        }
      } else if (kind === "factory_ledger") {
        if (!supplierId) throw new ValidationError({ reason: "supplier_id_required" });

        const ledgerItems = ExcelParser.parseFactoryLedger(workbook);
        rowsParsed = ledgerItems.length;

        for (const item of ledgerItems) {
          let hasError = false;
          if (item.totalAmount < 0 || item.paidAmount < 0) {
            validationErrors.push({
              row: item.row,
              code: "invalid_financial_amounts",
              message_ar: "المبالغ المالية يجب أن تكون موجبة.",
              message_en: "Financial amounts must be positive values.",
            });
            hasError = true;
          }

          if (!hasError) {
            rowsValid++;
            if (item.code && item.sizeMetersPerBoard) {
              preflightItems.push({ code: item.code, size: item.sizeMetersPerBoard });
            }
          }
        }
      } else {
        throw new ValidationError({ reason: "invalid_import_kind" });
      }

      // Check product/variant reference resolution
      const preflight = await ImportPreflight.validate(this.prisma, preflightItems);

      return {
        sessionId,
        rowsParsed,
        rowsValid,
        validationErrors,
        missingReferences: {
          skuCodes: preflight.missingSkus,
          variantSizes: preflight.missingVariants.map(v => `${v.code} (${v.size}m)`),
        },
      };
    } catch (err) {
      this.cleanupSession(sessionId);
      throw err;
    }
  }

  async commit(sessionId: string, actor: AuthenticatedUser) {
    const { xlsxPath, jsonPath } = this.getSessionPaths(sessionId);

    if (!fs.existsSync(jsonPath) || !fs.existsSync(xlsxPath)) {
      throw new NotFoundError({ sessionId });
    }

    const metadata: SessionMetadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);

    const { kind, branchId, supplierId, originalname } = metadata;

    await this.prisma.runInTransaction(async (tx) => {
      if (kind === "orders") {
        const worksheet = workbook.worksheets[0] || workbook.getWorksheet("الاوردرات");
        const orders = ExcelParser.parseOrders(worksheet!);

        // Preflight check inside tx
        const preflightItems = orders.map(o => ({ code: o.code, size: o.sizeMetersPerBoard }));
        const preflight = await ImportPreflight.validate(tx as any, preflightItems);
        if (!preflight.valid) {
          throw new ConflictError("errors.missing_references", {
            missingSkus: preflight.missingSkus,
          });
        }

        // Cache product variants for speedy lookups
        const variantCache = new Map<string, string>();
        for (const item of orders) {
          const key = `${item.code}-${item.sizeMetersPerBoard.toFixed(4)}`;
          if (!variantCache.has(key)) {
            const v = await tx.productVariant.findFirst({
              where: {
                sku: { code: item.code },
                sizeMetersPerBoard: item.sizeMetersPerBoard,
              },
              select: { id: true },
            });
            if (v) variantCache.set(key, v.id);
          }
        }

        for (const order of orders) {
          const variantId = variantCache.get(`${order.code}-${order.sizeMetersPerBoard.toFixed(4)}`);
          if (!variantId) {
            throw new ConflictError("errors.missing_references", { code: order.code, size: order.sizeMetersPerBoard });
          }

          const boards = new Decimal(order.boardsQuantity);
          const size = new Decimal(order.sizeMetersPerBoard);
          const meters = boards.times(size);
          const price = new Decimal(order.salePricePerMeter);
          const required = meters.times(price);
          const collected = new Decimal(order.collectedAmount);
          const remaining = required.minus(collected);

          let status: "CONFIRMED" | "PARTIALLY_COLLECTED" | "PAID" = "CONFIRMED";
          if (collected.gte(required)) {
            status = "PAID";
          } else if (collected.gt(0)) {
            status = "PARTIALLY_COLLECTED";
          }

          // Create CustomerOrder
          const dbOrder = await tx.customerOrder.create({
            data: {
              branchId: branchId!,
              orderDate: order.orderDate,
              customerName: order.customerName,
              productVariantId: variantId,
              boardsQuantity: boards.toFixed(4),
              metersQuantity: meters.toFixed(4),
              salePricePerMeter: price.toFixed(2),
              priceOverrideStatus: "WITHIN_TOLERANCE",
              requiredAmount: required.toFixed(2),
              collectedAmount: collected.toFixed(2),
              remainingAmount: remaining.toFixed(2),
              receiverName: order.receiverName || null,
              status,
              createdBy: actor.id,
              createdAt: order.orderDate,
            },
          });

          // Create OrderCollection if collected amount > 0
          if (collected.gt(0)) {
            await tx.orderCollection.create({
              data: {
                orderId: dbOrder.id,
                amount: collected.toFixed(2),
                collectedAt: order.orderDate,
                paidToAccount: "safe",
                createdBy: actor.id,
                createdAt: order.orderDate,
              },
            });
          }

          // Apply inventory movement (SALE)
          const productLabelAr = `${order.colorName} (${order.code} · ${order.sizeMetersPerBoard} م)`;
          const productLabelEn = `${order.colorName} (${order.code} · ${order.sizeMetersPerBoard} m)`;
          
          await this.inventoryEngine.apply({
            branchId: branchId!,
            productVariantId: variantId,
            movementType: "SALE",
            boardsDelta: `-${boards.toFixed(4)}`,
            reference: { type: "customer_order", id: dbOrder.id },
            actor,
            summaryAr: `سحب مخزني لطلب مبيعات مستورد للعميل ${order.customerName}`,
            summaryEn: `Stock deduction for imported sales order of client ${order.customerName}`,
            humanReadableNote: `مستورد من ${originalname}`,
            createdAt: order.orderDate,
            tx,
          });
        }
      } else if (kind === "inventory") {
        const worksheet = workbook.worksheets[0];
        const items = ExcelParser.parseInventory(worksheet!);

        const preflightItems = items.map(o => ({ code: o.code, size: o.sizeMetersPerBoard }));
        const preflight = await ImportPreflight.validate(tx as any, preflightItems);
        if (!preflight.valid) {
          throw new ConflictError("errors.missing_references");
        }

        const variantCache = new Map<string, string>();
        for (const item of items) {
          const key = `${item.code}-${item.sizeMetersPerBoard.toFixed(4)}`;
          if (!variantCache.has(key)) {
            const v = await tx.productVariant.findFirst({
              where: {
                sku: { code: item.code },
                sizeMetersPerBoard: item.sizeMetersPerBoard,
              },
              select: { id: true },
            });
            if (v) variantCache.set(key, v.id);
          }
        }

        for (const item of items) {
          const variantId = variantCache.get(`${item.code}-${item.sizeMetersPerBoard.toFixed(4)}`);
          if (!variantId) continue;

          await this.inventoryEngine.apply({
            branchId: branchId!,
            productVariantId: variantId,
            movementType: "RECEIPT",
            boardsDelta: item.boardsQuantity,
            reference: { type: "import" },
            actor,
            summaryAr: `جرد وارد مستورد من ملف: ${originalname}`,
            summaryEn: `Imported stock receipt from file: ${originalname}`,
            humanReadableNote: item.note || null,
            createdAt: item.date,
            tx,
          });
        }
      } else if (kind === "expenses") {
        const worksheet = workbook.worksheets[0] || workbook.getWorksheet("المصروفات");
        const expenses = ExcelParser.parseExpenses(worksheet!);

        for (const expense of expenses) {
          const dbExpense = await tx.expense.create({
            data: {
              branchId: branchId!,
              expenseDate: expense.expenseDate,
              description: expense.description,
              amount: new Decimal(expense.amount).toFixed(2),
              paidFromAccount: expense.paidFromAccount,
              createdBy: actor.id,
              createdAt: expense.expenseDate,
            },
          });

          await this.audit.write({
            tx,
            actorId: actor.id,
            action: "CREATE",
            entityType: "expense",
            entityId: dbExpense.id,
            afterSnapshot: {
              amount: expense.amount,
              description: expense.description,
              branchId,
            },
            summaryAr: `تم استيراد مصروف: ${expense.description} بقيمة ${expense.amount} ج.م`,
            summaryEn: `Imported expense: ${expense.description} of amount ${expense.amount} EGP`,
            createdAt: expense.expenseDate,
          });
        }
      } else if (kind === "factory_ledger") {
        const ledgerItems = ExcelParser.parseFactoryLedger(workbook);

        const preflightItems = ledgerItems
          .filter(o => o.code && o.sizeMetersPerBoard)
          .map(o => ({ code: o.code!, size: o.sizeMetersPerBoard! }));
        
        const preflight = await ImportPreflight.validate(tx as any, preflightItems);
        if (!preflight.valid) {
          throw new ConflictError("errors.missing_references");
        }

        const variantCache = new Map<string, string>();
        for (const item of ledgerItems) {
          if (!item.code || !item.sizeMetersPerBoard) continue;
          const key = `${item.code}-${item.sizeMetersPerBoard.toFixed(4)}`;
          if (!variantCache.has(key)) {
            const v = await tx.productVariant.findFirst({
              where: {
                sku: { code: item.code },
                sizeMetersPerBoard: item.sizeMetersPerBoard,
              },
              select: { id: true },
            });
            if (v) variantCache.set(key, v.id);
          }
        }

        for (const item of ledgerItems) {
          let variantId: string | null = null;
          let meters: Decimal | null = null;

          if (item.code && item.sizeMetersPerBoard) {
            variantId = variantCache.get(`${item.code}-${item.sizeMetersPerBoard.toFixed(4)}`) || null;
            if (variantId && item.boardsQuantity) {
              meters = new Decimal(item.boardsQuantity).times(new Decimal(item.sizeMetersPerBoard));
            }
          }

          const dbEntry = await tx.factoryLedgerEntry.create({
            data: {
              supplierId: supplierId!,
              orderDate: item.orderDate,
              productVariantId: variantId,
              boardsQuantity: item.boardsQuantity ? new Decimal(item.boardsQuantity).toFixed(4) : null,
              metersQuantity: meters ? meters.toFixed(4) : null,
              purchasePricePerMeter: item.purchasePricePerMeter ? new Decimal(item.purchasePricePerMeter).toFixed(2) : null,
              totalAmount: new Decimal(item.totalAmount).toFixed(2),
              paidAmount: new Decimal(item.paidAmount).toFixed(2),
              runningBalance: "0.00", // Will be computed
              notes: item.notes || `مستورد من ${originalname}`,
              createdBy: actor.id,
              createdAt: item.orderDate,
            },
          });

          // If storeName is specified and matches a seeded branch, we can also record a RECEIPT movement
          // to automatically increment branch stock for purchases!
          if (variantId && item.boardsQuantity && item.storeName) {
            // Find branch by nameAr or nameEn
            const mappedBranchName = item.storeName.toLowerCase() === "sohag" ? "فرع سوهاج" : "فرع الوراق";
            const targetBranch = await tx.branch.findUnique({
              where: { nameAr: mappedBranchName }
            });

            if (targetBranch) {
              await this.inventoryEngine.apply({
                branchId: targetBranch.id,
                productVariantId: variantId,
                movementType: "RECEIPT",
                boardsDelta: item.boardsQuantity.toString(),
                reference: { type: "factory_ledger_entry", id: dbEntry.id },
                actor,
                summaryAr: `وارد مخزني تلقائي من فاتورة المصنع المستوردة`,
                summaryEn: `Automatic stock receipt from imported factory order`,
                humanReadableNote: `فاتورة مصنع رقم ${item.invoiceNumber || ""}`,
                createdAt: item.orderDate,
                tx,
              });
            }
          }
        }

        // Recompute running balances for the supplier
        await this.ledgerRecompute.run(tx, supplierId!);

        await this.audit.write({
          tx,
          actorId: actor.id,
          action: "IMPORT",
          entityType: "supplier",
          entityId: supplierId!,
          summaryAr: `استيراد كشف حساب المصنع من ملف ${originalname}`,
          summaryEn: `Imported factory ledger entries from file ${originalname}`,
        });
      }

      // Write system-wide audit entry
      await this.audit.write({
        tx,
        actorId: actor.id,
        action: "IMPORT",
        entityType: "system_settings",
        entityId: null,
        summaryAr: `تم استيراد ملف البيانات بنجاح: ${originalname} (نوع: ${kind})`,
        summaryEn: `Successfully imported data workbook: ${originalname} (kind: ${kind})`,
      });
    });

    this.cleanupSession(sessionId);
    return { success: true };
  }

  private cleanupSession(sessionId: string) {
    const { xlsxPath, jsonPath } = this.getSessionPaths(sessionId);
    try {
      if (fs.existsSync(xlsxPath)) fs.unlinkSync(xlsxPath);
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    } catch (err) {
      console.error(`Error deleting session files for ${sessionId}:`, err);
    }
  }
}
