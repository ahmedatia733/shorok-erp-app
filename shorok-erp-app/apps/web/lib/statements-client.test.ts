const apiCall = jest.fn();
jest.mock("./api-client", () => ({ apiCall: (...a: unknown[]) => apiCall(...a) }));

import { getConsolidatedStatement } from "./statements-client";

/** The path passed to apiCall for a given params object. */
const pathFor = async (params: Parameters<typeof getConsolidatedStatement>[0]) => {
  apiCall.mockReset();
  apiCall.mockResolvedValue({});
  await getConsolidatedStatement(params);
  return apiCall.mock.calls[0][0] as string;
};

describe("getConsolidatedStatement — balanceSide serialization", () => {
  it("omits balanceSide for the default ALL (existing URLs unchanged)", async () => {
    expect(await pathFor({ category: "customers", balanceSide: "ALL" })).not.toContain("balanceSide");
  });

  it("omits balanceSide when not provided", async () => {
    expect(await pathFor({ category: "customers" })).not.toContain("balanceSide");
  });

  it("sends balanceSide=DEBIT and balanceSide=CREDIT", async () => {
    expect(await pathFor({ category: "customers", balanceSide: "DEBIT" })).toContain("balanceSide=DEBIT");
    expect(await pathFor({ category: "customers", balanceSide: "CREDIT" })).toContain("balanceSide=CREDIT");
  });

  it("keeps the other filters alongside balanceSide", async () => {
    const p = await pathFor({ category: "customers", entityId: "all", from: "2026-07-01", to: "2026-07-31", includeZero: true, balanceSide: "DEBIT" });
    expect(p).toContain("category=customers");
    expect(p).toContain("from=2026-07-01");
    expect(p).toContain("to=2026-07-31");
    expect(p).toContain("includeZero=true");
    expect(p).toContain("balanceSide=DEBIT");
    expect(p).not.toContain("entityId=all"); // "all" is never sent as a specific entity
  });
});
