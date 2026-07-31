/**
 * Unit test for the return PDF download client. Runs in the node jest env, so the
 * browser globals it touches (URL.createObjectURL, document) are stubbed and
 * apiDownload is mocked to capture the request path/options.
 */
const apiDownload = jest.fn();
jest.mock("./api-client", () => ({ apiDownload: (...a: unknown[]) => apiDownload(...a) }));

import { downloadReturnPdf } from "./returns-pdf-client";

describe("downloadReturnPdf", () => {
  let anchor: { href: string; download: string; click: jest.Mock; remove: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    apiDownload.mockReset();
    apiDownload.mockResolvedValue({ blob: new Blob(["%PDF"]), filename: "sales-return-SR-2-draft.pdf" });
    anchor = { href: "", download: "", click: jest.fn(), remove: jest.fn() };
    (global as unknown as { URL: typeof URL }).URL.createObjectURL = jest.fn(() => "blob:mock");
    (global as unknown as { URL: typeof URL }).URL.revokeObjectURL = jest.fn();
    (global as unknown as { document: unknown }).document = {
      createElement: () => anchor,
      body: { appendChild: jest.fn(), removeChild: jest.fn() },
    };
  });
  afterEach(() => jest.useRealTimers());

  it("requests the sales-returns PDF path with the locale query + option and downloads the server filename", async () => {
    await downloadReturnPdf("sales", "id-1", "ar", "SR-2");
    expect(apiDownload).toHaveBeenCalledWith("/sales-returns/id-1/pdf?locale=ar", { locale: "ar" });
    expect(anchor.download).toBe("sales-return-SR-2-draft.pdf"); // server filename wins
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("requests the purchase-returns path and preserves the English locale", async () => {
    await downloadReturnPdf("purchase", "id-9", "en", "PR-3");
    expect(apiDownload).toHaveBeenCalledWith("/purchase-returns/id-9/pdf?locale=en", { locale: "en" });
  });

  it("falls back to `${name}.pdf` when the response has no filename", async () => {
    apiDownload.mockResolvedValue({ blob: new Blob(["%PDF"]), filename: null });
    await downloadReturnPdf("sales", "id-2", "ar", "SR-5");
    expect(anchor.download).toBe("SR-5.pdf");
  });

  it("propagates apiDownload errors to the caller", async () => {
    apiDownload.mockRejectedValue(new Error("boom"));
    await expect(downloadReturnPdf("sales", "id-3", "ar", "SR-6")).rejects.toThrow("boom");
  });
});
