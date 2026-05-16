import { describe, expect, it } from "vitest";
import {
  matchesDatabaseSearch,
  matchesDomainSearch,
  matchesLicenseModuleSearch,
  matchesScheduleSearch,
} from "../lib/listSearch";
import type { DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule } from "../types/models";

describe("listSearch", () => {
  it("busca dominios por cliente, URL, ambiente y estado", () => {
    const domain = {
      clientName: "P&A Soluciones",
      domainName: "https://demo.sagerp.cloud",
      environment: "Producción",
      status: "active",
    } as DomainRecord;

    expect(matchesDomainSearch(domain, "p&a")).toBe(true);
    expect(matchesDomainSearch(domain, "demo.sagerp")).toBe(true);
    expect(matchesDomainSearch(domain, "producción")).toBe(true);
    expect(matchesDomainSearch(domain, "active")).toBe(true);
    expect(matchesDomainSearch(domain, "otro")).toBe(false);
  });

  it("busca bases por dominio, empresa, base, servidor, ambiente y estado", () => {
    const database = {
      clientName: "P&A Soluciones",
      domainName: "demo.sagerp.cloud",
      companyName: "SAG Web Demo",
      environment: "Pruebas",
      status: "active",
      dbAccess: { serverHostPort: "sql.demo:1433", initialCatalog: "SAGWEBDEMO", userId: "sql", passwordSecretName: "secret" },
    } as DatabaseRecord;

    expect(matchesDatabaseSearch(database, "demo.sagerp")).toBe(true);
    expect(matchesDatabaseSearch(database, "SAGWEB")).toBe(true);
    expect(matchesDatabaseSearch(database, "sql.demo")).toBe(true);
    expect(matchesDatabaseSearch(database, "pruebas")).toBe(true);
    expect(matchesDatabaseSearch(database, "otro")).toBe(false);
  });

  it("busca licencias por nombre, código, descripción y estado", () => {
    const module = { name: "Mobile App", code: "MOBILE", description: "Aplicación móvil", status: "active" } as LicenseModuleRecord;

    expect(matchesLicenseModuleSearch(module, "mobile")).toBe(true);
    expect(matchesLicenseModuleSearch(module, "aplicación")).toBe(true);
    expect(matchesLicenseModuleSearch(module, "active")).toBe(true);
    expect(matchesLicenseModuleSearch(module, "wms")).toBe(false);
  });

  it("busca programaciones por cliente, tipo, licencia, frecuencia, responsable y estado", () => {
    const module = { id: "module_mobile", name: "Mobile App", code: "MOBILE", status: "active" } as LicenseModuleRecord;
    const schedule = {
      clientName: "Cliente Uno",
      targetType: "database",
      frequencyType: "weekly",
      assignedRole: "database_updater",
      active: true,
      selectionMode: "licensing",
      licensingScope: { licenseModuleIds: ["module_mobile"], licenseMatchMode: "any", environment: "production", targetTypes: "databases_only", activeOnly: true },
    } as UpdateSchedule;

    expect(matchesScheduleSearch(schedule, "Cliente Uno")).toBe(true);
    expect(matchesScheduleSearch(schedule, "base de datos")).toBe(true);
    expect(matchesScheduleSearch(schedule, "Mobile", new Map([[module.id, module]]))).toBe(true);
    expect(matchesScheduleSearch(schedule, "weekly")).toBe(true);
    expect(matchesScheduleSearch(schedule, "database_updater")).toBe(true);
    expect(matchesScheduleSearch(schedule, "activo")).toBe(true);
    expect(matchesScheduleSearch(schedule, "manual")).toBe(false);
  });
});
