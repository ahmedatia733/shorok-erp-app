import * as ExcelJS from "exceljs";
import { Decimal } from "decimal.js";

export interface ParsedOrder {
  row: number;
  orderDate: Date;
  customerName: string;
  colorName: string;
  code: string;
  boardsQuantity: number;
  sizeMetersPerBoard: number;
  salePricePerMeter: number;
  collectedAmount: number;
  receiverName?: string;
}

export interface ParsedInventory {
  row: number;
  date: Date;
  colorName: string;
  code: string;
  boardsQuantity: number;
  sizeMetersPerBoard: number;
  movementType: "RECEIPT" | "ADJUSTMENT" | "COUNT_CORRECTION";
  note?: string;
}

export interface ParsedExpense {
  row: number;
  expenseDate: Date;
  description: string;
  amount: number;
  paidFromAccount: string;
}

export interface ParsedFactoryLedger {
  row: number;
  orderDate: Date;
  invoiceNumber?: string;
  colorName?: string;
  code?: string;
  sizeMetersPerBoard?: number;
  boardsQuantity?: number;
  purchasePricePerMeter?: number;
  totalAmount: number;
  paidAmount: number;
  notes?: string;
  storeName?: string;
}

export class ExcelParser {
  static getCellValue(cell: ExcelJS.Cell): any {
    const val = cell.value;
    if (val && typeof val === "object") {
      if ("result" in val) return val.result;
      if ("text" in val) return val.text;
      if ("date" in val) return (val as any).date;
    }
    return val;
  }

  static parseDate(value: any): Date {
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      const parts = value.split("/");
      if (parts.length === 3) {
        // e.g. "30/4/2026" or "22/4/2026"
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // 0-indexed
        const year = parseInt(parts[2], 10);
        return new Date(year, month, day);
      }
      const isoDate = Date.parse(value);
      if (!isNaN(isoDate)) return new Date(isoDate);
    }
    if (typeof value === "number") {
      // Excel serial date number
      return new Date((value - 25569) * 86400 * 1000);
    }
    throw new Error(`Invalid date value: ${value}`);
  }

  static parseDecimal(value: any): number {
    if (value === null || value === undefined || value === "") return 0;
    if (typeof value === "number") return value;
    try {
      const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ""));
      return isNaN(parsed) ? 0 : parsed;
    } catch {
      return 0;
    }
  }

  static parseOrders(worksheet: ExcelJS.Worksheet): ParsedOrder[] {
    let headerRowIndex = -1;
    const colMap: Record<string, number> = {};

    // Find header row by looking for "اللون" or "الكود"
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRowIndex !== -1) return;
      const values = row.values as any[];
      if (
        values.some((v) =>
          ["اللون", "color", "الكود", "code"].includes(
            String(this.getCellValue(row.getCell(values.indexOf(v)))).trim()
          )
        )
      ) {
        headerRowIndex = rowNumber;
        row.eachCell((cell, colNumber) => {
          const val = String(this.getCellValue(cell)).trim().toLowerCase();
          if (val === "date" || val === "التاريخ") colMap.orderDate = colNumber;
          else if (val === "اسم العميل" || val === "customer name" || val === "customer") colMap.customerName = colNumber;
          else if (val === "اللون" || val === "color") colMap.colorName = colNumber;
          else if (val === "الكود" || val === "code") colMap.code = colNumber;
          else if (val === "عدد الالواح" || val === "qty/ pic" || val === "quantity boards" || val === "boards") colMap.boardsQuantity = colNumber;
          else if (val === "المقاس" || val === "l" || val === "size" || val === "length") colMap.sizeMetersPerBoard = colNumber;
          else if (val === "سعر المتر" || val === "cost/ m2" || val === "sale_price" || val === "price") colMap.salePricePerMeter = colNumber;
          else if (val === "التحصيل" || val === "paid" || val === "collected") colMap.collectedAmount = colNumber;
          else if (val === "المستلم" || val === "receiver" || val === "stor") colMap.receiverName = colNumber;
        });
      }
    });

    if (headerRowIndex === -1) {
      throw new Error("Could not find order headers in sheet.");
    }

    const parsed: ParsedOrder[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowIndex) return;

      const orderDateVal = this.getCellValue(row.getCell(colMap.orderDate));
      const customerName = String(this.getCellValue(row.getCell(colMap.customerName)) || "").trim();
      const code = String(this.getCellValue(row.getCell(colMap.code)) || "").trim();
      const boardsVal = this.getCellValue(row.getCell(colMap.boardsQuantity));

      // Skip summary / empty rows
      if (!customerName || !code || !orderDateVal || boardsVal === null || boardsVal === undefined) return;

      const orderDate = this.parseDate(orderDateVal);
      const colorName = String(this.getCellValue(row.getCell(colMap.colorName)) || "").trim();
      const boardsQuantity = this.parseDecimal(boardsVal);
      const sizeMetersPerBoard = this.parseDecimal(this.getCellValue(row.getCell(colMap.sizeMetersPerBoard)));
      const salePricePerMeter = this.parseDecimal(this.getCellValue(row.getCell(colMap.salePricePerMeter)));
      const collectedAmount = this.parseDecimal(this.getCellValue(row.getCell(colMap.collectedAmount)));
      const receiverName = String(this.getCellValue(row.getCell(colMap.receiverName)) || "").trim() || undefined;

      if (boardsQuantity <= 0) return; // Skip if no boards

      parsed.push({
        row: rowNumber,
        orderDate,
        customerName,
        colorName,
        code,
        boardsQuantity,
        sizeMetersPerBoard,
        salePricePerMeter,
        collectedAmount,
        receiverName,
      });
    });

    return parsed;
  }

  static parseInventory(worksheet: ExcelJS.Worksheet): ParsedInventory[] {
    // Check if side-by-side (Initial Inventory "الجرد الابتدائي")
    const row1Val = String(this.getCellValue(worksheet.getRow(1).getCell(1)) || "");
    const isInitialInventory = row1Val.includes("جرد يوم") || row1Val.includes("الوان عاديه");

    const parsed: ParsedInventory[] = [];

    if (isInitialInventory) {
      // Find date from row 1, e.g. "جرد يوم 22/4/2026"
      let date = new Date();
      const match = row1Val.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (match) {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1;
        const year = parseInt(match[3], 10);
        date = new Date(year, month, day);
      }

      // Left side: ordinary colors (Cols 1-5, Col 1 is م, Col 2 is اللون, Col 3 is الكود, Col 4 is كبير (5.25), Col 5 is صغير (4))
      // Right side: special colors (Cols 6-10, Col 6 is م, Col 7 is اللون, Col 8 is الكود, Col 9 is كبير (5.25), Col 10 is صغير (4))
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber <= 2) return; // Skip title and headers

        // Left side
        const leftColor = String(this.getCellValue(row.getCell(2)) || "").trim();
        const leftCode = String(this.getCellValue(row.getCell(3)) || "").trim();
        const leftLarge = this.parseDecimal(this.getCellValue(row.getCell(4)));
        const leftSmall = this.parseDecimal(this.getCellValue(row.getCell(5)));

        if (leftColor && leftCode && leftColor !== "اجمالي" && leftColor !== "المقاس") {
          if (leftLarge > 0) {
            parsed.push({
              row: rowNumber,
              date,
              colorName: leftColor,
              code: leftCode,
              boardsQuantity: leftLarge,
              sizeMetersPerBoard: 5.25,
              movementType: "RECEIPT",
              note: "الجرد الابتدائي - كبير",
            });
          }
          if (leftSmall > 0) {
            parsed.push({
              row: rowNumber,
              date,
              colorName: leftColor,
              code: leftCode,
              boardsQuantity: leftSmall,
              sizeMetersPerBoard: 4.0,
              movementType: "RECEIPT",
              note: "الجرد الابتدائي - صغير",
            });
          }
        }

        // Right side
        const rightColor = String(this.getCellValue(row.getCell(7)) || "").trim();
        const rightCode = String(this.getCellValue(row.getCell(8)) || "").trim();
        const rightLarge = this.parseDecimal(this.getCellValue(row.getCell(9)));
        const rightSmall = this.parseDecimal(this.getCellValue(row.getCell(10)));

        if (rightColor && rightCode && rightColor !== "اجمالي" && rightColor !== "المقاس") {
          if (rightLarge > 0) {
            parsed.push({
              row: rowNumber,
              date,
              colorName: rightColor,
              code: rightCode,
              boardsQuantity: rightLarge,
              sizeMetersPerBoard: 5.25,
              movementType: "RECEIPT",
              note: "الجرد الابتدائي - كبير",
            });
          }
          if (rightSmall > 0) {
            parsed.push({
              row: rowNumber,
              date,
              colorName: rightColor,
              code: rightCode,
              boardsQuantity: rightSmall,
              sizeMetersPerBoard: 4.0,
              movementType: "RECEIPT",
              note: "الجرد الابتدائي - صغير",
            });
          }
        }
      });
    } else {
      // Standard list sheet (like "الوارد 27-4" or "الجرد")
      let date = new Date();
      // Extract date from sheet title if possible
      const title = String(this.getCellValue(worksheet.getRow(1).getCell(1)) || "");
      const match = title.match(/(\d{1,2})[-/](\d{1,2})/);
      if (match) {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1;
        const year = 2026; // Default to year 2026 as per our database settings and context
        date = new Date(year, month, day);
      }

      let headerRowIndex = -1;
      const colMap: Record<string, number> = {};

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (headerRowIndex !== -1) return;
        const values = row.values as any[];
        if (values.some((v) => ["اللون", "اللون ", "الكود"].includes(String(v).trim()))) {
          headerRowIndex = rowNumber;
          row.eachCell((cell, colNumber) => {
            const val = String(this.getCellValue(cell)).trim().toLowerCase();
            if (val.startsWith("اللون")) colMap.colorName = colNumber;
            else if (val === "الكود") colMap.code = colNumber;
            else if (val === "المقاس") colMap.sizeMetersPerBoard = colNumber;
            else if (val === "عدد الالواح" || val === "الوارد" || val === "المتبقي") colMap.boardsQuantity = colNumber;
          });
        }
      });

      if (headerRowIndex === -1) {
        throw new Error("Could not find inventory headers in sheet.");
      }

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber <= headerRowIndex) return;

        const colorName = String(this.getCellValue(row.getCell(colMap.colorName)) || "").trim();
        const code = String(this.getCellValue(row.getCell(colMap.code)) || "").trim();
        const boardsVal = this.getCellValue(row.getCell(colMap.boardsQuantity));

        if (!colorName || !code || boardsVal === null || boardsVal === undefined) return;

        const boardsQuantity = this.parseDecimal(boardsVal);
        const sizeMetersPerBoard = this.parseDecimal(this.getCellValue(row.getCell(colMap.sizeMetersPerBoard)));

        if (boardsQuantity <= 0) return;

        parsed.push({
          row: rowNumber,
          date,
          colorName,
          code,
          boardsQuantity,
          sizeMetersPerBoard,
          movementType: "RECEIPT",
          note: `وارد يوم ${date.getDate()}/${date.getMonth() + 1}`,
        });
      });
    }

    return parsed;
  }

  static parseExpenses(worksheet: ExcelJS.Worksheet): ParsedExpense[] {
    let headerRowIndex = -1;
    const colMap: Record<string, number> = {};

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRowIndex !== -1) return;
      const values = row.values as any[];
      if (values.some((v) => ["التاريخ", "البيان", "المصروف"].includes(String(v).trim()))) {
        headerRowIndex = rowNumber;
        row.eachCell((cell, colNumber) => {
          const val = String(this.getCellValue(cell)).trim().toLowerCase();
          if (val === "التاريخ") colMap.expenseDate = colNumber;
          else if (val === "البيان") colMap.description = colNumber;
          else if (val === "المصروف") colMap.amount = colNumber;
          else if (val === "من حساب") colMap.paidFromAccount = colNumber;
        });
      }
    });

    if (headerRowIndex === -1) {
      throw new Error("Could not find expense headers in sheet.");
    }

    const parsed: ParsedExpense[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowIndex) return;

      const dateVal = this.getCellValue(row.getCell(colMap.expenseDate));
      const description = String(this.getCellValue(row.getCell(colMap.description)) || "").trim();
      const amountVal = this.getCellValue(row.getCell(colMap.amount));

      if (!dateVal || !description || amountVal === null || amountVal === undefined) return;

      const expenseDate = this.parseDate(dateVal);
      const amount = this.parseDecimal(amountVal);
      const paidFromAccount = String(this.getCellValue(row.getCell(colMap.paidFromAccount)) || "Safe").trim();

      if (amount <= 0) return;

      parsed.push({
        row: rowNumber,
        expenseDate,
        description,
        amount,
        paidFromAccount,
      });
    });

    return parsed;
  }

  static parseFactoryLedger(workbook: ExcelJS.Workbook): ParsedFactoryLedger[] {
    // Legacy file has sheets like 'Date' containing purchase rows and supplier info
    const worksheet = workbook.getWorksheet("Date");
    if (!worksheet) {
      throw new Error("Could not find 'Date' sheet for factory ledger.");
    }

    const parsed: ParsedFactoryLedger[] = [];
    let headerRowIndex = -1;
    const colMap: Record<string, number> = {};

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRowIndex !== -1) return;
      const values = row.values as any[];
      if (values.some((v) => ["Type", "Code", "Stor", "Invoice #"].includes(String(v).trim()))) {
        headerRowIndex = rowNumber;
        row.eachCell((cell, colNumber) => {
          const val = String(this.getCellValue(cell)).trim().toLowerCase();
          if (val === "date") colMap.orderDate = colNumber;
          else if (val === "invoice #") colMap.invoiceNumber = colNumber;
          else if (val === "stor" || val === "store") colMap.storeName = colNumber;
          else if (val === "type") colMap.colorName = colNumber;
          else if (val === "code") colMap.code = colNumber;
          else if (val === "qty/ pic") colMap.boardsQuantity = colNumber;
          else if (val === "l") colMap.sizeMetersPerBoard = colNumber;
          else if (val === "cost/ m2") colMap.purchasePricePerMeter = colNumber;
          else if (val === "total cost") colMap.totalAmount = colNumber;
          else if (val === "paid") colMap.paidAmount = colNumber;
        });
      }
    });

    if (headerRowIndex === -1) {
      throw new Error("Could not find factory headers in 'Date' sheet.");
    }

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowIndex) return;

      const dateVal = this.getCellValue(row.getCell(colMap.orderDate));
      const code = String(this.getCellValue(row.getCell(colMap.code)) || "").trim();
      const totalAmountVal = this.getCellValue(row.getCell(colMap.totalAmount));
      const paidAmountVal = this.getCellValue(row.getCell(colMap.paidAmount));

      if (!dateVal || (!code && totalAmountVal === null && paidAmountVal === null)) return;

      const orderDate = this.parseDate(dateVal);
      const invoiceNumber = String(this.getCellValue(row.getCell(colMap.invoiceNumber)) || "").trim() || undefined;
      const storeName = String(this.getCellValue(row.getCell(colMap.storeName)) || "").trim() || undefined;
      const colorName = String(this.getCellValue(row.getCell(colMap.colorName)) || "").trim() || undefined;
      const boardsQuantity = this.parseDecimal(this.getCellValue(row.getCell(colMap.boardsQuantity)));
      
      // Legacy size = L * W? In Sheet: L is e.g. 1.25, W is e.g. 3.2. Size is 4.
      // Actually size is given in list: 4 or 5.25.
      // Let's read size: if L is 1.5 or size is large, size is 5.25. If L is 1.25, size is 4.
      // Let's compute sizeMetersPerBoard = parseDecimal(L) * parseDecimal(W) = size.
      // Let's see: L = 1.25, W = 3.2 => 1.25 * 3.2 = 4.0.
      // L = 1.5, W = 3.5 => 1.5 * 3.5 = 5.25.
      // This is exactly it!
      const l = this.parseDecimal(this.getCellValue(row.getCell(colMap.sizeMetersPerBoard)));
      const w = this.parseDecimal(this.getCellValue(row.getCell(colMap.sizeMetersPerBoard + 1))); // next column is W
      const sizeMetersPerBoard = l * w;

      const purchasePricePerMeter = this.parseDecimal(this.getCellValue(row.getCell(colMap.purchasePricePerMeter)));
      const totalAmount = this.parseDecimal(totalAmountVal);
      const paidAmount = this.parseDecimal(paidAmountVal);

      if (totalAmount <= 0 && paidAmount <= 0) return;

      parsed.push({
        row: rowNumber,
        orderDate,
        invoiceNumber,
        colorName,
        code,
        sizeMetersPerBoard,
        boardsQuantity,
        purchasePricePerMeter,
        totalAmount,
        paidAmount,
        notes: invoiceNumber ? `فاتورة رقم ${invoiceNumber}` : undefined,
        storeName,
      });
    });

    return parsed;
  }
}
