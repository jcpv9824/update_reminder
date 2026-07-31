import { describe, expect, it } from "vitest";
import {
  dedupeResolvedSourceKeys,
  normalizeSqlIdentityKey,
  printFormatSqlConflictMessage,
  resolvedSourceAssignmentsChanged,
  temporaryPrintFormatNormalizedName,
} from "../lib/printFormatsSqlWriteRepository";

describe("Print Formats SQL write contract", () => {
  it("deduplicates source IDs after SQL resolution while preserving display order", () => {
    expect(dedupeResolvedSourceKeys([27, 27, 31, 27, 45])).toEqual([27, 31, 45]);
    expect(dedupeResolvedSourceKeys([])).toEqual([]);
  });

  it("normalizes BIGINT identity values returned as strings by the SQL driver", () => {
    expect(normalizeSqlIdentityKey("27")).toBe(27);
    expect(normalizeSqlIdentityKey(27)).toBe(27);
    expect(normalizeSqlIdentityKey(27n)).toBe(27);
    expect(() => normalizeSqlIdentityKey("")).toThrow(/missing/i);
    expect(() => normalizeSqlIdentityKey("27.5")).toThrow(/invalid/i);
  });

  it("does not misclassify a PDF-only edit when SQL returns BIGINT keys as strings", () => {
    const currentPrimary = normalizeSqlIdentityKey("27");
    const desiredPrimary = normalizeSqlIdentityKey("27");
    const currentSources = ["27", "31"].map((key) => normalizeSqlIdentityKey(key));
    const desiredSources = ["27", "31"].map((key) => normalizeSqlIdentityKey(key));

    expect(resolvedSourceAssignmentsChanged(
      currentSources,
      desiredSources,
      currentPrimary,
      desiredPrimary,
    )).toBe(false);
  });

  it("maps assignment uniqueness failures to a safe business conflict", () => {
    const providerError = {
      number: 2627,
      message: "Violation of PRIMARY KEY constraint 'PK_print_format_source_assignments'.",
    };
    const message = printFormatSqlConflictMessage(providerError);
    expect(message).toMatch(/misma fuente (?:se envió|fue enviada) más de una vez dentro de este formato/i);
    expect(message).not.toContain("PRIMARY KEY");
  });

  it("does not mislabel unknown uniqueness failures as duplicate sources", () => {
    expect(printFormatSqlConflictMessage({
      originalError: { info: { number: 2601 } },
      message: "Cannot insert duplicate key row.",
    })).toMatch(/conflicto concurrente/i);
  });

  it("distinguishes name and PDF-version constraints", () => {
    expect(printFormatSqlConflictMessage({
      number: 2601,
      message: "Cannot insert duplicate key row in index 'UX_print_formats_source_name_active'.",
    })).toMatch(/otro formato con el mismo nombre/i);
    expect(printFormatSqlConflictMessage({
      number: 51514,
      message: "Print-format names must be unique within every assigned source.",
    })).toMatch(/otro formato con el mismo nombre/i);
    expect(printFormatSqlConflictMessage({
      number: 2627,
      message: "Violation of PRIMARY KEY constraint 'PK_print_format_files'.",
    })).toMatch(/nueva versión del PDF/i);
    expect(printFormatSqlConflictMessage({ number: 547 })).toBeNull();
  });

  it("leaves source assignments untouched for metadata-only and PDF-only edits", () => {
    expect(resolvedSourceAssignmentsChanged([27, 31], [27, 31], 27, 27)).toBe(false);
  });

  it("reconciles assignments when source membership, order or primary source changes", () => {
    expect(resolvedSourceAssignmentsChanged([27], [27, 31], 27, 27)).toBe(true);
    expect(resolvedSourceAssignmentsChanged([27, 31], [31, 27], 27, 31)).toBe(true);
    expect(resolvedSourceAssignmentsChanged([27, 31], [31, 27], 27, 27)).toBe(true);
  });

  it("uses a unique bounded temporary normalized name during source reassignment", () => {
    const first = temporaryPrintFormatNormalizedName(10038, "nonce-a");
    const second = temporaryPrintFormatNormalizedName(10038, "nonce-b");
    expect(first).not.toBe(second);
    expect(first).toContain("10038");
    expect(first.length).toBeLessThanOrEqual(240);
  });
});
