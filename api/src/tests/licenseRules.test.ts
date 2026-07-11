import { describe, expect, it } from "vitest";
import {
  buildUniqueLicenseCode,
  generateLicenseCodeFromName,
  hasDuplicateLicenseCode,
  hasDuplicateLicenseName,
  normalizeLicenseCode,
  normalizeLicenseName,
  validateLicenseAssignmentRequirements,
} from "../lib/licenseRules";
import type { LicenseModuleRecord } from "../types/models";

const modules: LicenseModuleRecord[] = [
  { id: "module_mobile", name: "Mobile App", code: "MOBILE", status: "active" },
  { id: "module_deleted", name: "Eliminado", code: "OLD", status: "deleted", deletedAt: "2026-05-01T00:00:00.000Z" },
];

describe("licenseRules", () => {
  it("normaliza y detecta códigos duplicados de módulos activos", () => {
    expect(normalizeLicenseCode(" mobile ")).toBe("MOBILE");
    expect(hasDuplicateLicenseCode(modules, " mobile ")).toBe(true);
    expect(hasDuplicateLicenseCode(modules, " mobile ", "module_mobile")).toBe(false);
    expect(hasDuplicateLicenseCode(modules, "old")).toBe(false);
  });

  it("normaliza y detecta nombres duplicados de módulos activos", () => {
    expect(normalizeLicenseName("  Mobile   App  ")).toBe("mobile app");
    expect(hasDuplicateLicenseName(modules, "mobile   app")).toBe(true);
    expect(hasDuplicateLicenseName(modules, "mobile app", "module_mobile")).toBe(false);
    expect(hasDuplicateLicenseName(modules, "Eliminado")).toBe(false);
  });

  it("genera códigos automáticos sin tildes y evita duplicados", () => {
    expect(generateLicenseCodeFromName("Facturación electrónica")).toBe("FACTURACION_ELECTRONICA");
    expect(buildUniqueLicenseCode(modules, "Mobile")).toBe("MOBILE_2");
    expect(buildUniqueLicenseCode(modules, generateLicenseCodeFromName("AI Extract"))).toBe("AI_EXTRACT");
  });

  it("valida los campos requeridos por nivel de asignación", () => {
    expect(validateLicenseAssignmentRequirements({ targetType: "client" })).toBe("Seleccione un cliente.");
    expect(validateLicenseAssignmentRequirements({ targetType: "domain", clientId: "client_1" })).toBe("Seleccione un dominio.");
    expect(validateLicenseAssignmentRequirements({ targetType: "database", clientId: "client_1", domainId: "domain_1" })).toBe("Seleccione una base de datos.");
    expect(validateLicenseAssignmentRequirements({ targetType: "database", clientId: "client_1", domainId: "domain_1", databaseId: "db_1" })).toBeNull();
  });

});
