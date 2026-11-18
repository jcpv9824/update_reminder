import { describe, it, expect } from "vitest";
import { buildMastersReportEmail, parseSemicolonEmails } from "../lib/reportsService";
import { CATALOG_ACTIVE_USERS_UNAVAILABLE, collectCatalogActiveUserReport } from "../lib/catalogActiveUserReport";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseAssignmentRecord, LicenseModuleRecord, UpdateSchedule } from "../types/models";

const client: ClientRecord = {
  id: "client_1",
  name: "Cliente Uno",
  status: "active",
  licenseModuleIds: ["module_mobile"],
  createdAt: "2026-05-01T00:00:00.000Z",
  createdBy: "admin",
  updatedAt: "2026-05-01T00:00:00.000Z",
  updatedBy: "admin",
};

const domain: DomainRecord = {
  id: "domain_1",
  clientId: "client_1",
  clientName: "Cliente Uno",
  domainName: "cliente.pya.com.co",
  environment: "production",
  assignedUpdaterIds: [],
  status: "active",
  createdAt: "2026-05-02T00:00:00.000Z",
  createdBy: "admin",
  updatedAt: "2026-05-02T00:00:00.000Z",
  updatedBy: "admin",
};

const database: DatabaseRecord = {
  id: "db_1",
  clientId: "client_1",
  clientName: "Cliente Uno",
  domainId: "domain_1",
  domainName: "cliente.pya.com.co",
  companyName: "Empresa Uno",
  environment: "production",
  dbAccess: {
    serverHostPort: "sql.example.com,1433",
    initialCatalog: "EMPRESA_UNO",
    userId: "usuario_sql_sensible",
    passwordSecretName: "secret-password-db-1",
  },
  assignedUpdaterIds: [],
  status: "active",
  createdAt: "2026-05-03T00:00:00.000Z",
  createdBy: "admin",
  updatedAt: "2026-05-03T00:00:00.000Z",
  updatedBy: "admin",
};

const schedule: UpdateSchedule = {
  id: "schedule_1",
  clientId: "client_1",
  clientName: "Cliente Uno",
  domainId: "domain_1",
  domainName: "cliente.pya.com.co",
  targetType: "domain",
  targetIds: ["domain_1"],
  frequencyType: "weekly",
  everyNWeeks: 1,
  weekdays: ["FRIDAY"],
  startDate: "2026-05-01",
  timezone: "America/Bogota",
  assignedRole: "domain_updater",
  assignedUserIds: [],
  active: true,
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const mobileModule: LicenseModuleRecord = {
  id: "module_mobile",
  name: "Mobile App",
  code: "MOBILE",
  status: "active",
};

const wmsModule: LicenseModuleRecord = {
  id: "module_wms",
  name: "WMS",
  code: "WMS",
  status: "active",
};

const inactiveModule: LicenseModuleRecord = {
  id: "module_inactive",
  name: "Modulo inactivo",
  status: "inactive",
};

const clientAssignment: LicenseAssignmentRecord = {
  id: "assignment_client",
  moduleId: "module_mobile",
  clientId: "client_1",
  targetType: "client",
  targetId: "client_1",
  status: "active",
};

const duplicateDomainAssignment: LicenseAssignmentRecord = {
  id: "assignment_domain_duplicate",
  moduleId: "module_mobile",
  domainId: "domain_1",
  targetType: "domain",
  targetId: "domain_1",
  status: "active",
};

const databaseAssignment: LicenseAssignmentRecord = {
  id: "assignment_database",
  moduleId: "module_wms",
  databaseId: "db_1",
  targetType: "database",
  targetId: "db_1",
  status: "active",
};

describe("parseSemicolonEmails", () => {
  it("acepta varios correos separados por punto y coma", () => {
    expect(parseSemicolonEmails("uno@empresa.com; dos@empresa.com ; tres@empresa.com")).toEqual([
      "uno@empresa.com",
      "dos@empresa.com",
      "tres@empresa.com",
    ]);
  });

  it("rechaza correos inválidos", () => {
    expect(() => parseSemicolonEmails("uno@empresa.com; no-es-correo")).toThrow(/Correo inválido/i);
  });
});

describe("buildMastersReportEmail", () => {
  it("genera HTML y texto con clientes, dominios y empresas", () => {
    const report = buildMastersReportEmail({
      clients: [{ ...client, licenseModuleIds: ["module_mobile", "module_mobile", "module_wms"] }],
      domains: [domain],
      databases: [database],
      schedules: [schedule],
      licenseModules: [mobileModule],
      licenseAssignments: [],
    });
    expect(report.subject).toBe("Reporte maestro ERP — clientes, dominios y empresas");
    expect(report.html).toContain("Cliente Uno");
    expect(report.html).toContain("Licencias / módulos");
    expect(report.html).toContain("Mobile App");
    expect(report.html).toContain("cliente.pya.com.co");
    expect(report.html).toContain("Empresa Uno");
    expect(report.html).toContain("EMPRESA_UNO");
    expect(report.html).toContain("Semanal");
    expect(report.html).not.toContain("Usuarios activos");
    expect(report.text).not.toContain("Usuarios activos");
  });

  it("muestra conteos por vínculo, suma las bases físicas una vez y no expone metadatos del conteo", async () => {
    const physical = { physicalDatabaseId: "física-interna", serverGroupId: "host-sensible.invalid",
      reportingProfileId: "referencia-sensible" };
    const zero = { ...physical, physicalDatabaseId: "física-cero" };
    const secondClient = { ...client, id: "client_2", name: "Cliente Dos" };
    const secondDomain = { ...domain, id: "domain_2", clientId: secondClient.id };
    const linkedDb = { ...database, id: "db_link_2", clientId: secondClient.id, domainId: secondDomain.id,
      companyName: "<script>Etiqueta</script>" };
    const zeroDb = { ...database, id: "db_zero", companyName: "Conteo cero" };
    const unverifiedDb = { ...database, id: "db_unverified", companyName: "Base sin verificación" };
    const evidence = await collectCatalogActiveUserReport([
      { clientId: client.id, databaseLinkId: database.id, target: physical },
      { clientId: secondClient.id, databaseLinkId: linkedDb.id, target: physical },
      { clientId: client.id, databaseLinkId: zeroDb.id, target: zero },
      { clientId: client.id, databaseLinkId: unverifiedDb.id, target: null },
    ].map(link => ({ ...link, clientName: "cliente-interno", databaseAlias: "alias-interno" })),
    async target => target.physicalDatabaseId === zero.physicalDatabaseId ? 0 : 7);
    const report = buildMastersReportEmail({
      clients: [client, secondClient], domains: [domain, secondDomain],
      databases: [database, linkedDb, zeroDb, unverifiedDb], schedules: [], activeUsersReport: evidence,
    });
    for (const body of [report.html, report.text]) {
      expect(body).toContain("Usuarios activos en bases físicas verificadas: 7");
      expect(body).toContain("Resultado parcial");
      expect(body.match(/Usuarios activos: 7/g)).toHaveLength(2);
      expect(body).toContain("Usuarios activos: 0");
      expect(body).toContain(CATALOG_ACTIVE_USERS_UNAVAILABLE);
      for (const value of [...Object.values(physical), "alias-interno", "cliente-interno", database.id]) {
        expect(body).not.toContain(value);
      }
    }
    expect(report.html).toContain("&lt;script&gt;Etiqueta&lt;/script&gt;");
    expect(report.html).not.toContain("<script>Etiqueta</script>");
  });

  it("no muestra el conteo de otro cliente aunque coincida el ID del vínculo", () => {
    const report = buildMastersReportEmail({
      clients: [client], domains: [domain], databases: [database], schedules: [],
      activeUsersReport: {
        rows: [{ clientId: "otro", databaseLinkId: database.id, clientName: "No usar", databaseAlias: "No usar",
          status: "available", activeUsers: 999, checkedAt: "2026-05-04T00:00:00Z" }],
        summary: { activeUsers: 999, physicalDatabases: 1, verifiedCounts: 1, unverifiedLinks: 0, partial: false },
      },
    });
    for (const body of [report.html, report.text]) {
      expect(body).toContain(CATALOG_ACTIVE_USERS_UNAVAILABLE);
      expect(body).toContain("Usuarios activos en bases físicas verificadas: No disponible");
      expect(body).toContain("Resultado parcial");
      expect(body).not.toContain("999");
    }
  });

  it("no incluye passwords, usuarios SQL, secretos ni connection strings completas", () => {
    const report = buildMastersReportEmail({ clients: [client], domains: [domain], databases: [database], schedules: [schedule], licenseModules: [mobileModule], licenseAssignments: [] });
    const serialized = `${report.html}\n${report.text}`;
    expect(serialized).not.toContain("usuario_sql_sensible");
    expect(serialized).not.toContain("secret-password-db-1");
    expect(serialized).not.toContain("sql.example.com,1433");
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/connection string/i);
  });

  it("incluye licencias activas del cliente y las deduplica", () => {
    const report = buildMastersReportEmail({
      clients: [{ ...client, licenseModuleIds: ["module_mobile", "module_mobile", "module_wms"] }],
      domains: [domain],
      databases: [database],
      schedules: [schedule],
      licenseModules: [mobileModule, wmsModule],
      licenseAssignments: [clientAssignment, duplicateDomainAssignment, databaseAssignment],
    });
    const serialized = `${report.html}\n${report.text}`;
    expect(serialized.match(/Mobile App/g)?.length).toBe(2);
    expect(serialized).toContain("WMS");
  });

  it("excluye módulos y asignaciones inactivas o eliminadas", () => {
    const inactiveAssignment: LicenseAssignmentRecord = {
      id: "assignment_inactive",
      moduleId: "module_wms",
      clientId: "client_1",
      status: "inactive",
    };
    const deletedAssignment: LicenseAssignmentRecord = {
      id: "assignment_deleted",
      moduleId: "module_wms",
      clientId: "client_1",
      status: "deleted",
      deletedAt: "2026-05-10T00:00:00.000Z",
    };
    const inactiveModuleAssignment: LicenseAssignmentRecord = {
      id: "assignment_inactive_module",
      moduleId: "module_inactive",
      clientId: "client_1",
      status: "active",
    };
    const report = buildMastersReportEmail({
      clients: [client],
      domains: [domain],
      databases: [database],
      schedules: [schedule],
      licenseModules: [mobileModule, wmsModule, inactiveModule],
      licenseAssignments: [clientAssignment, inactiveAssignment, deletedAssignment, inactiveModuleAssignment],
    });
    const serialized = `${report.html}\n${report.text}`;
    expect(serialized).toContain("Mobile App");
    expect(serialized).not.toContain("Modulo inactivo");
    expect(serialized).not.toContain("Sin licencias registradas");
    expect(serialized.match(/WMS/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("muestra Sin licencias registradas cuando el cliente no tiene módulos activos", () => {
    const report = buildMastersReportEmail({
      clients: [{ ...client, licenseModuleIds: [] }],
      domains: [domain],
      databases: [database],
      schedules: [schedule],
      licenseModules: [],
      licenseAssignments: [],
    });
    expect(`${report.html}\n${report.text}`).toContain("Sin licencias registradas");
  });
});
