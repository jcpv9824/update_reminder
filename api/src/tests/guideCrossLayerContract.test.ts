import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { optionPermissionKeys, PERMISSION_CATALOG } from "../lib/permissionModel";

type GuideContract = {
  version: number;
  statuses: string[];
  stages: string[];
  permissions: string[];
};

function stringUnion(source: string, typeName: string): string[] {
  const declaration = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source)?.[1] ?? "";
  return [...declaration.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("guide builder machine-readable cross-layer contract", () => {
  it("keeps API statuses, stages, and permissions aligned with the frozen v1 contract", async () => {
    const root = resolve(process.cwd(), "..");
    const contract = JSON.parse(
      await readFile(resolve(root, "docs/contracts/guide-builder-v1.json"), "utf8"),
    ) as GuideContract;
    const source = await readFile(resolve(process.cwd(), "src/lib/guideBuilder.ts"), "utf8");
    const option = PERMISSION_CATALOG
      .find((module) => module.id === "help")!
      .options.find((item) => item.id === "guide_builder")!;

    expect(contract.version).toBe(1);
    expect(stringUnion(source, "GuideSessionStatus")).toEqual(contract.statuses);
    expect(stringUnion(source, "GuideStage")).toEqual(contract.stages);
    expect(optionPermissionKeys(option)).toEqual(contract.permissions);
  });
});
