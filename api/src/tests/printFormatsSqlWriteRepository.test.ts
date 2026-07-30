import { describe, expect, it } from "vitest";
import {
  dedupeResolvedSourceKeys,
  printFormatSqlConflictMessage,
} from "../lib/printFormatsSqlWriteRepository";

describe("Print Formats SQL write contract", () => {
  it("deduplicates source IDs after SQL resolution while preserving display order", () => {
    expect(dedupeResolvedSourceKeys([27, 27, 31, 27, 45])).toEqual([27, 31, 45]);
    expect(dedupeResolvedSourceKeys([])).toEqual([]);
  });

  it("maps assignment uniqueness failures to a safe business conflict", () => {
    const providerError = {
      number: 2627,
      message: "Violation of PRIMARY KEY constraint 'PK_print_format_source_assignments'.",
    };
    const message = printFormatSqlConflictMessage(providerError);
    expect(message).toMatch(/fuente está repetida/i);
    expect(message).not.toContain("PRIMARY KEY");
    expect(printFormatSqlConflictMessage({
      originalError: { info: { number: 2601 } },
      message: "Cannot insert duplicate key row.",
    })).toMatch(/fuente está repetida/i);
    expect(printFormatSqlConflictMessage({ number: 547 })).toBeNull();
  });
});
