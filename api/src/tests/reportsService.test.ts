import { describe, it, expect } from "vitest";
import { buildMastersReportEmail, parseSemicolonEmails } from "../lib/reportsService";
import type { ClientRecord, DatabaseRecord, DomainRecord, UpdateSchedule } from "../types/models";

const client: ClientRecord = {
  id: "client_1",
  name: "Cliente Uno",
  status: "active",
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
    const report = buildMastersReportEmail({ clients: [client], domains: [domain], databases: [database], schedules: [schedule] });
    expect(report.subject).toBe("Reporte maestro ERP — clientes, dominios y empresas");
    expect(report.html).toContain("Cliente Uno");
    expect(report.html).toContain("cliente.pya.com.co");
    expect(report.html).toContain("Empresa Uno");
    expect(report.html).toContain("EMPRESA_UNO");
    expect(report.html).toContain("Semanal");
  });

  it("no incluye passwords, usuarios SQL, secretos ni connection strings completas", () => {
    const report = buildMastersReportEmail({ clients: [client], domains: [domain], databases: [database], schedules: [schedule] });
    const serialized = `${report.html}\n${report.text}`;
    expect(serialized).not.toContain("usuario_sql_sensible");
    expect(serialized).not.toContain("secret-password-db-1");
    expect(serialized).not.toContain("sql.example.com,1433");
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/connection string/i);
  });
});
