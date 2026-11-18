import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogOnceClosureSweep } from "../lib/catalogOnceClosureWorker";

const item = { portalEnvironment: "qa" as const, taskDate: "2030-01-01", observationKey: "9007199254740993" };
const io = () => ({ reserve: vi.fn().mockResolvedValue([item]), complete: vi.fn().mockResolvedValue(true) });

describe("bounded once closure worker", () => {
  beforeEach(() => vi.clearAllMocks());
  it("processes only the reserved exact candidates and reports each outcome", async () => {
    const fake = io();
    fake.reserve.mockResolvedValue([item, { ...item, observationKey: "9007199254740994" }]);
    fake.complete.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await runCatalogOnceClosureSweep("qa", fake)).toEqual({ checked: 2, completed: 1, skipped: 1, failed: 0 });
    expect(fake.reserve).toHaveBeenCalledExactlyOnceWith("qa", 50);
    expect(fake.complete).toHaveBeenNthCalledWith(1, item);
  });
  it("isolates proof failures without falling back or leaking details", async () => {
    const fake = io();
    fake.reserve.mockResolvedValue([item, { ...item, observationKey: "2" }]);
    fake.complete.mockRejectedValueOnce(new Error("synthetic private SQL detail"));
    expect(await runCatalogOnceClosureSweep("qa", fake)).toEqual({ checked: 2, completed: 1, skipped: 0, failed: 1 });
  });
  it("rejects a foreign environment or duplicate candidates before closure", async () => {
    const fake = io();
    fake.reserve.mockResolvedValue([item, item]);
    await expect(runCatalogOnceClosureSweep("qa", fake)).rejects.toThrow("catalog_once_candidates_invalid");
    expect(fake.complete).not.toHaveBeenCalled();
  });
});
