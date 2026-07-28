import { statusBadge, money, treasuryOptionLabel, selectableTreasuries, validateTreasuryForm, validateTransferForm } from "./treasury-format";

describe("treasury-format", () => {
  it("maps transfer status to Arabic label + variant", () => {
    expect(statusBadge("DRAFT")).toEqual({ label: "مسودة", variant: "warning" });
    expect(statusBadge("CONFIRMED")).toEqual({ label: "مؤكد", variant: "success" });
    expect(statusBadge("CANCELLED")).toEqual({ label: "ملغي", variant: "neutral" });
    expect(statusBadge("???")).toEqual({ label: "مسودة", variant: "warning" }); // safe fallback
  });

  it("formats money with 2 decimals (locale-stable)", () => {
    const expected = (n: number) => n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(money("1000")).toBe(expected(1000));
    expect(money("0")).toBe(expected(0));
    expect(money(1234.5)).toBe(expected(1234.5));
  });

  it("builds a selector label with name, code and balance", () => {
    expect(treasuryOptionLabel({ nameAr: "خزنة المبيعات", code: "TRZ-001", balance: "500.00" })).toContain("خزنة المبيعات");
    expect(treasuryOptionLabel({ nameAr: "خزنة المبيعات", code: "TRZ-001", balance: "500.00" })).toContain("TRZ-001");
  });

  it("selector shows ONLY active treasuries", () => {
    const rows = [{ id: "a", active: true }, { id: "b", active: false }, { id: "c", active: true }];
    expect(selectableTreasuries(rows).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("validates the create-treasury form with Arabic messages", () => {
    expect(validateTreasuryForm({ nameAr: "", branchId: "b1" })).toBe("اسم الخزنة بالعربية مطلوب.");
    expect(validateTreasuryForm({ nameAr: "خزنة", branchId: "" })).toBe("اختر الفرع.");
    expect(validateTreasuryForm({ nameAr: "خزنة", branchId: "b1" })).toBeNull();
  });

  it("validates the transfer form with Arabic messages", () => {
    expect(validateTransferForm({ sourceTreasuryId: "", destinationTreasuryId: "d", amount: "10" })).toBe("اختر خزنة المصدر والوجهة.");
    expect(validateTransferForm({ sourceTreasuryId: "s", destinationTreasuryId: "s", amount: "10" })).toBe("لا يمكن التحويل إلى نفس الخزنة.");
    expect(validateTransferForm({ sourceTreasuryId: "s", destinationTreasuryId: "d", amount: "0" })).toBe("أدخل مبلغاً أكبر من صفر.");
    expect(validateTransferForm({ sourceTreasuryId: "s", destinationTreasuryId: "d", amount: "10" })).toBeNull();
  });
});
