import { describe, expect, it } from "vitest";
import {
  hasDuplicateClientName,
  hasDuplicateClientExternalId,
  hasDuplicateDatabaseConnection,
  hasDuplicateDomainUrl,
  normalizeComparableText,
  normalizeDomainUrl,
} from "../lib/duplicateValidation";
import type { ClientRecord, DatabaseRecord, DomainRecord } from "../types/models";

describe("duplicateValidation", () => {
  it("normaliza texto con trim, espacios repetidos y case-insensitive", () => {
    expect(normalizeComparableText("  Cliente   Uno  ")).toBe("cliente uno");
  });

  it("detecta cliente duplicado por nombre y permite el mismo registro en edición", () => {
    const clients = [
      { id: "client_1", name: "Cliente Uno", status: "active" },
      { id: "client_2", name: "Cliente Dos", status: "inactive" },
    ] as ClientRecord[];

    expect(hasDuplicateClientName(clients, " cliente   uno ")).toBe(true);
    expect(hasDuplicateClientName(clients, "CLIENTE UNO", "client_1")).toBe(false);
    expect(hasDuplicateClientName(clients, "cliente dos")).toBe(true);
  });

  it("detecta ID de cliente duplicado solo cuando se captura", () => {
    const clients = [
      { id: "client_1", externalId: "PYA-001", name: "Cliente Uno", status: "active" },
      { id: "client_2", externalId: "OLD-001", name: "Eliminado", status: "deleted" },
    ] as ClientRecord[];

    expect(hasDuplicateClientExternalId(clients, " pya-001 ")).toBe(true);
    expect(hasDuplicateClientExternalId(clients, "PYA-001", "client_1")).toBe(false);
    expect(hasDuplicateClientExternalId(clients, "")).toBe(false);
    expect(hasDuplicateClientExternalId(clients, undefined)).toBe(false);
    expect(hasDuplicateClientExternalId(clients, "old-001")).toBe(false);
  });

  it("normaliza dominios removiendo slash final", () => {
    expect(normalizeDomainUrl(" HTTPS://DEMO.SAGERP.CLOUD/ ")).toBe("https://demo.sagerp.cloud");
  });

  it("detecta dominio duplicado con y sin slash final", () => {
    const domains = [{ id: "domain_1", domainName: "https://demo.sagerp.cloud/", status: "active" }] as DomainRecord[];

    expect(hasDuplicateDomainUrl(domains, "https://demo.sagerp.cloud")).toBe(true);
    expect(hasDuplicateDomainUrl(domains, "https://demo.sagerp.cloud", "domain_1")).toBe(false);
  });

  it("detecta base duplicada por cadena de conexión normalizada", () => {
    const databases = [{
      id: "db_1",
      status: "active",
      dbAccess: { serverHostPort: "sql.demo:1433", initialCatalog: "SAGWEB", userId: "usr", passwordSecretName: "secret" },
    }] as DatabaseRecord[];
    const raw = "  SQL.DEMO:1433; Initial Catalog = sagweb; User ID = USR; Password = otra; ";

    expect(hasDuplicateDatabaseConnection(databases, raw)).toBe(true);
    expect(hasDuplicateDatabaseConnection(databases, raw, "db_1")).toBe(false);
  });

  it("ignora registros eliminados al validar duplicados", () => {
    const clients = [{ id: "client_1", name: "Cliente Uno", status: "deleted" }] as ClientRecord[];

    expect(hasDuplicateClientName(clients, "Cliente Uno")).toBe(false);
  });
});
