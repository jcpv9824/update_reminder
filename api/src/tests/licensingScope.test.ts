import { describe, expect, it } from "vitest";
import { expandLicensingSchedule, previewLicensingScope } from "../lib/licensingScope";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseModuleRecord, UpdateSchedule } from "../types/models";

const mobile: LicenseModuleRecord = { id: "lic_mobile", name: "Mobile App", code: "MOBILE", status: "active" };
const wms: LicenseModuleRecord = { id: "lic_wms", name: "WMS", code: "WMS", status: "active" };
const inactiveModule: LicenseModuleRecord = { id: "lic_inactive", name: "Licencia inactiva", code: "OLD", status: "inactive" };

const clientA: ClientRecord = {
  id: "client_a",
  name: "Cliente A",
  status: "active",
  licenseModuleIds: ["lic_mobile", "lic_wms"],
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const clientB: ClientRecord = {
  id: "client_b",
  name: "Cliente B",
  status: "active",
  licenseModuleIds: ["lic_mobile"],
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const domainA: DomainRecord = {
  id: "domain_a",
  clientId: "client_a",
  clientName: "Cliente A",
  domainName: "a.sagerp.cloud",
  environment: "production",
  assignedUpdaterIds: [],
  status: "active",
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const domainB: DomainRecord = { ...domainA, id: "domain_b", clientId: "client_b", clientName: "Cliente B", domainName: "b.sagerp.cloud", environment: "test" };
const inactiveDomain: DomainRecord = { ...domainA, id: "domain_inactive", status: "inactive" };

const db = (id: string, domain: DomainRecord, environment = domain.environment, status: "active" | "inactive" = "active"): DatabaseRecord => ({
  id,
  clientId: domain.clientId,
  clientName: domain.clientName,
  domainId: domain.id,
  domainName: domain.domainName,
  companyName: `Empresa ${id}`,
  environment,
  dbAccess: { serverHostPort: "server", initialCatalog: id.toUpperCase(), userId: "sql", passwordSecretName: "secret" },
  assignedUpdaterIds: [],
  status,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
});

const schedule: UpdateSchedule = {
  id: "schedule_license",
  clientId: "client_a",
  clientName: "Cliente A",
  targetType: "domain",
  targetIds: [],
  frequencyType: "weekly",
  everyNWeeks: 1,
  weekdays: ["FRIDAY"],
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "domain_updater",
  assignedUserIds: [],
  selectionMode: "licensing",
  licensingScope: {
    licenseModuleIds: ["lic_mobile"],
    licenseMatchMode: "any",
    environment: "all",
    targetTypes: "domains_and_databases",
    activeOnly: true,
  },
  active: true,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

describe("licensingScope", () => {
  const baseArgs = {
    clients: [clientA, clientB, { ...clientB, id: "client_inactive", status: "inactive" as const }],
    domains: [domainA, domainB, inactiveDomain],
    databases: [db("db_a", domainA), db("db_b", domainB), db("db_inactive", inactiveDomain)],
    licenseModules: [mobile, wms],
  };

  it("previsualiza clientes con cualquiera de las licencias seleccionadas", () => {
    const preview = previewLicensingScope({ ...baseArgs, scope: { ...schedule.licensingScope!, licenseModuleIds: ["lic_mobile"], licenseMatchMode: "any" } });
    expect(preview.clientsCount).toBe(2);
    expect(preview.domainsCount).toBe(2);
    expect(preview.databasesCount).toBe(2);
  });

  it("previsualiza clientes con todas las licencias seleccionadas", () => {
    const preview = previewLicensingScope({ ...baseArgs, scope: { ...schedule.licensingScope!, licenseModuleIds: ["lic_mobile", "lic_wms"], licenseMatchMode: "all" } });
    expect(preview.clientsCount).toBe(1);
    expect(preview.groups[0].client.name).toBe("Cliente A");
  });

  it("filtra por ambiente y excluye inactivos", () => {
    const preview = previewLicensingScope({ ...baseArgs, scope: { ...schedule.licensingScope!, environment: "production", activeOnly: true } });
    expect(preview.clientsCount).toBe(1);
    expect(preview.domainsCount).toBe(1);
    expect(preview.databasesCount).toBe(1);
  });

  it("usa solo registros activos aunque se reciba activeOnly en false", () => {
    const inactiveClient: ClientRecord = { ...clientA, id: "client_inactive_scope", name: "Cliente inactivo", status: "inactive", licenseModuleIds: ["lic_mobile"] };
    const inactiveClientDomain: DomainRecord = { ...domainA, id: "domain_inactive_client", clientId: inactiveClient.id, clientName: inactiveClient.name };
    const preview = previewLicensingScope({
      ...baseArgs,
      clients: [...baseArgs.clients, inactiveClient],
      domains: [...baseArgs.domains, inactiveClientDomain],
      databases: [...baseArgs.databases, db("db_inactive_client", inactiveClientDomain)],
      scope: { ...schedule.licensingScope!, activeOnly: false },
    });
    expect(preview.groups.some((group) => group.client.id === inactiveClient.id)).toBe(false);
    expect(preview.clientsCount).toBe(2);
  });

  it("excluye licencias inactivas del alcance por licenciamiento", () => {
    const licensedOnlyWithInactiveModule: ClientRecord = { ...clientA, id: "client_inactive_license", licenseModuleIds: ["lic_inactive"] };
    const domainInactiveLicense: DomainRecord = { ...domainA, id: "domain_inactive_license", clientId: licensedOnlyWithInactiveModule.id };
    const preview = previewLicensingScope({
      clients: [licensedOnlyWithInactiveModule],
      domains: [domainInactiveLicense],
      databases: [db("db_inactive_license", domainInactiveLicense)],
      licenseModules: [inactiveModule],
      scope: { ...schedule.licensingScope!, licenseModuleIds: ["lic_inactive"] },
    });
    expect(preview.clientsCount).toBe(0);
    expect(preview.groups).toEqual([]);
  });

  it("respeta targetTypes solo dominios y solo bases", () => {
    const onlyDomains = previewLicensingScope({ ...baseArgs, scope: { ...schedule.licensingScope!, targetTypes: "domains_only" } });
    const onlyDatabases = previewLicensingScope({ ...baseArgs, scope: { ...schedule.licensingScope!, targetTypes: "databases_only" } });
    expect(onlyDomains.domainsCount).toBe(2);
    expect(onlyDomains.databasesCount).toBe(0);
    expect(onlyDatabases.domainsCount).toBe(0);
    expect(onlyDatabases.databasesCount).toBe(2);
  });

  it("expande una programación por licencia dinámicamente", () => {
    const expanded = expandLicensingSchedule({ schedule, ...baseArgs });
    expect(expanded.some((item) => item.id.includes("__lic_domain_domain_a"))).toBe(true);
    expect(expanded.some((item) => item.id.includes("__lic_db_db_b"))).toBe(true);
  });
});
