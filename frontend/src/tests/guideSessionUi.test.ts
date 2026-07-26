import { describe, expect, it } from "vitest";
import { guideCurrentStep } from "../components/constructorGuias/guideSessionUi";
import { PERMISSION_CATALOG, optionPermissionKeys } from "../permissionModel";

describe("guideCurrentStep", () => {
  it.each([
    ["upload_pending", "ingest", 1],
    ["queued", "ingest", 2],
    ["processing", "transcription", 2],
    ["processing", "frame_extraction", 2],
    ["processing", "questions", 3],
    ["review", "questions", 3],
    ["processing", "reprocess", 3],
    ["finalizing", "finalize", 4],
    ["completed", "completed", 4],
    ["failed", "vision", 2],
    ["cancelled", "questions", 3],
    ["deleted", "completed", 4],
  ] as const)("deriva %s/%s como paso %i", (status, stage, expected) => {
    expect(guideCurrentStep({ status, stage })).toBe(expected);
  });

  it("mantiene el catálogo granular del Constructor de guías alineado con el API", () => {
    const option = PERMISSION_CATALOG
      .find((module) => module.id === "help")!
      .options.find((item) => item.id === "guide_builder")!;
    expect(optionPermissionKeys(option)).toEqual([
      "help.guide_builder.view",
      "help.guide_builder.create",
      "help.guide_builder.download_transcript",
      "help.guide_builder.regenerate",
      "help.guide_builder.finalize",
      "help.guide_builder.download_manual",
      "help.guide_builder.cancel",
      "help.guide_builder.view_all",
    ]);
  });
});
