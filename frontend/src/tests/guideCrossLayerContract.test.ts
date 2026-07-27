import { describe, expect, it } from "vitest";
import contract from "../../../docs/contracts/guide-builder-v1.json";
import { optionPermissionKeys, PERMISSION_CATALOG } from "../permissionModel";
import { GUIDE_PROCESSING_STAGES, GUIDE_SESSION_STATUSES } from "../types";

describe("guide builder machine-readable cross-layer contract", () => {
  it("keeps frontend statuses, stages, and permissions aligned with the frozen v1 contract", () => {
    const option = PERMISSION_CATALOG
      .find((module) => module.id === "help")!
      .options.find((item) => item.id === "guide_builder")!;

    expect(contract.version).toBe(1);
    expect(GUIDE_SESSION_STATUSES).toEqual(contract.statuses);
    expect(GUIDE_PROCESSING_STAGES).toEqual(contract.stages);
    expect(optionPermissionKeys(option)).toEqual(contract.permissions);
  });
});
