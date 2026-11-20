import { describe, expect, it } from "vitest";
import { normalizeCatalogColombianNit } from "../lib/catalogColombianNit";

describe("catalog-only Colombian NIT comparison", () => {
  const co = { issuer: "CO", documentType: "NIT" };
  it.each(["123456789-3", " 123 456789 - 3 ", "123456789 -3", "123456789- 3", "123456789", "123456789-"])(
    "compares %s by its numeric base", input => expect(normalizeCatalogColombianNit(input, co)).toBe("123456789"),
  );
  it("removes Unicode whitespace without treating it as a distinct check-digit separator", () => {
    expect(normalizeCatalogColombianNit("123\u00a0456\t789 - 3", co)).toBe("123456789");
  });
  it("does not reclassify foreign, unknown, invalid or empty sources", () => {
    expect(normalizeCatalogColombianNit("123-2-2025 DV3", { issuer: "PA", documentType: "RUC" })).toBeNull();
    expect(normalizeCatalogColombianNit("123-3", undefined)).toBeNull();
    expect(normalizeCatalogColombianNit("ABC-1", co)).toBeNull();
    expect(normalizeCatalogColombianNit("-1", co)).toBeNull();
    expect(normalizeCatalogColombianNit(null, co)).toBeNull();
  });
});
