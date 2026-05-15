import { describe, expect, it } from "vitest";
import { summarizeLicenseDeleteDependencies } from "../lib/licenseDeletion";
import type { ClientRecord, DatabaseRecord, DomainRecord, LicenseAssignmentRecord } from "../types/models";

const clientA: ClientRecord = {
  id: "client_a",
  name: "Cliente A",
  status: "active",
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const clientB: ClientRecord = {
  id: "client_b",
  name: "Cliente B",
  status: "active",
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const domainA: DomainRecord = {
  id: "domain_a",
  clientId: "client_a",
  clientName: "Cliente A",
  domainName: "cliente-a.sagerp.cloud",
  environment: "production",
  assignedUpdaterIds: [],
  status: "active",
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

const dbB: DatabaseRecord = {
  id: "db_b",
  clientId: "client_b",
  clientName: "Cliente B",
  domainId: "domain_b",
  domainName: "cliente-b.sagerp.cloud",
  companyName: "Empresa B",
  environment: "production",
  dbAccess: {
    serverHostPort: "no-debe-salir",
    initialCatalog: "EMPRESA_B",
    userId: "no-debe-salir",
    passwordSecretName: "no-debe-salir",
  },
  assignedUpdaterIds: [],
  status: "active",
  createdAt: "",
  createdBy: "",
  updatedAt: "",
  updatedBy: "",
};

describe("summarizeLicenseDeleteDependencies", () => {
  it("resume clientes que bloquean la eliminación de una licencia", () => {
    const assignments: LicenseAssignmentRecord[] = [
      { id: "a1", moduleId: "module_mobile", clientId: "client_a", status: "active" },
      { id: "a2", moduleId: "module_mobile", domainId: "domain_a", status: "active" },
      { id: "a3", moduleId: "module_mobile", databaseId: "db_b", status: "active" },
      { id: "a4", moduleId: "module_mobile", clientId: "client_b", status: "inactive" },
      { id: "a5", moduleId: "other_module", clientId: "client_a", status: "active" },
    ];

    expect(summarizeLicenseDeleteDependencies({
      moduleId: "module_mobile",
      assignments,
      clients: [clientA, clientB],
      domains: [domainA],
      databases: [dbB],
    })).toEqual([
      { clientId: "client_a", clientName: "Cliente A", assignments: 2 },
      { clientId: "client_b", clientName: "Cliente B", assignments: 1 },
    ]);
  });

  it("ignora asignaciones eliminadas y clientes inactivos", () => {
    const inactiveClient = { ...clientA, status: "inactive" as const };
    const assignments: LicenseAssignmentRecord[] = [
      { id: "a1", moduleId: "module_mobile", clientId: "client_a", status: "active" },
      { id: "a2", moduleId: "module_mobile", clientId: "client_b", status: "deleted", deletedAt: "2026-05-01T00:00:00.000Z" },
    ];

    expect(summarizeLicenseDeleteDependencies({
      moduleId: "module_mobile",
      assignments,
      clients: [inactiveClient, clientB],
      domains: [],
      databases: [],
    })).toEqual([]);
  });
});
