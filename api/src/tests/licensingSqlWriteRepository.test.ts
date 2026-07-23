import { describe, expect, it } from "vitest";
import {
  buildLicenseModuleMutationValues,
  isSqlLicenseUniqueConstraintError,
  normalizeLicenseAssignmentEnvironment,
  selectUniqueSqlLicenseCode,
} from "../lib/licensingSqlWriteRepository";

describe("Licensing SQL write contract", () => {
  it("normalizes module values and maintains delete metadata", () => {
    const active = buildLicenseModuleMutationValues({
      name: "  Módulo   de Ventas  ",
      code: "  ventas_pro  ",
      description: "  Descripción  ",
      status: "active",
    }, "user-1", new Date("2026-07-22T20:00:00.000Z"));

    expect(active).toEqual({
      name: "Módulo de Ventas",
      nameNormalized: "módulo de ventas",
      code: "VENTAS_PRO",
      codeNormalized: "VENTAS_PRO",
      description: "Descripción",
      status: "active",
      activeLegacy: true,
      updatedAt: new Date("2026-07-22T20:00:00.000Z"),
      updatedBy: "user-1",
      deletedAt: null,
      deletedBy: null,
    });

    const deleted = buildLicenseModuleMutationValues({
      name: "Módulo", code: "", description: "", status: "deleted",
    }, "user-2", new Date("2026-07-22T20:01:00.000Z"));
    expect(deleted.code).toBeNull();
    expect(deleted.description).toBeNull();
    expect(deleted.activeLegacy).toBe(false);
    expect(deleted.deletedBy).toBe("user-2");
  });

  it("generates stable unique codes and respects an explicit code", () => {
    const existing = ["MODULO_DE_VENTAS", "MODULO_DE_VENTAS_2"];
    expect(selectUniqueSqlLicenseCode("Módulo de ventas", "", existing)).toBe("MODULO_DE_VENTAS_3");
    expect(selectUniqueSqlLicenseCode("Otro", " personalizado ", existing)).toBe("PERSONALIZADO");
  });

  it("normalizes all to SQL NULL and rejects unknown environments", () => {
    expect(normalizeLicenseAssignmentEnvironment("all")).toBeNull();
    expect(normalizeLicenseAssignmentEnvironment(" production ")).toBe("production");
    expect(() => normalizeLicenseAssignmentEnvironment("staging")).toThrow(/ambiente/i);
  });

  it("recognizes SQL unique-index violations without exposing provider detail", () => {
    expect(isSqlLicenseUniqueConstraintError({ number: 2601 })).toBe(true);
    expect(isSqlLicenseUniqueConstraintError({ originalError: { info: { number: 2627 } } })).toBe(true);
    expect(isSqlLicenseUniqueConstraintError({ number: 547 })).toBe(false);
  });
});
