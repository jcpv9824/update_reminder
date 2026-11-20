import { describe, expect, it, vi } from "vitest";
import { createCatalogCustomerDocumentDisplay } from "../lib/catalogCustomerDocumentDisplay";
import { buildCatalogCustomerDirectory, type CatalogDirectoryInput } from "../lib/catalogCustomerDirectory";
import { catalogDocumentNumberToken } from "../lib/catalogCustomerRefresh";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";

const erp = "a1e1b24a-2a37-4bad-b204-2afa341753c2";
const sag = "1db1fa1c-babf-4ddd-b708-e1b5d09d9c4f";
const hidden = "043d9020-338d-4614-b89b-e061dce39306";
const key = Buffer.alloc(32, 42);
const doc = (value: string) => `hmac:${catalogDocumentNumberToken(key, "qa", value)!.toString("hex")}`;
const conf = { PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "catalog-fixture", PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "a".repeat(32),
  PORTAL_CATALOG_MATCH_KEY_VERSION: "1" };
const selector = { state: "active_or_unverified", web: "all" } as const;
const stamp = "2026-11-20T12:00:00Z";
const member = (id: number, name: string, value: string, code: "S" | "N") => ({
  customerId: `fixture-opaque-${id}`, sourceCustomerId: String(id), officialName: name, activeCode: code,
  document: { issuer: "CO", type: "NIT", number: doc(value) },
});
const source = (id: string, rows: ReturnType<typeof member>[]) => ({
  sourceId: id, label: "Fuente autorizada", priority: 0, state: "verified" as const, verifiedAt: stamp, customers: rows,
});
function fixture(): CatalogDirectoryInput {
  return { erp: [source(erp, [member(1,"Solo ERP","007001","S"), member(2,"Inactivo","887766","N")]),
    source(hidden, [member(9,"No autorizado","771122","S")])],
    sag: { state:"verified", verifiedAt: stamp, documents: [], completeScopes: [] },
    allowedSourceIds: new Set([erp]),
    sagOnlyCustomers: [{customerId:"sag-orphan",name:"Solo Admin"}],
    sagOnlyDocumentReferences: new Map([["sag-orphan",{sourceId:sag,recordId:1,token:doc("EXT-123 4")}]]),
  };
}
const binding = (id: string, role: "erp-customers" | "sag-admin", version = "0000000000000001") => ({
  id, role, issuerScope: role === "erp-customers" ? "CO:NIT" : null, environment: "qa", state: "active",
  contractVersion: role === "erp-customers" ? "erp_v1" : "sag_admin_v2",
  profileId: id, profileRevision: version, bindingVersion: version, canReadCurrentProfile: true,
}) as SqlCatalogSourceBinding;

describe("authenticated customer document projection", () => {
  it("includes nonmatches and unverified clients, returns original documents, and never reads an unauthorized source", async () => {
    const read = vi.fn(async (b: SqlCatalogSourceBinding) => b.role === "erp-customers"
      ? [{sourceRecordId:1,documentNumber:"007001"},{sourceRecordId:2,documentNumber:"887766"}]
      : [{sourceRecordId:1,documentNumber:"EXT-123 4"}]);
    const enrich=createCatalogCustomerDocumentDisplay({ bindings: async () => [binding(erp,"erp-customers"),binding(sag,"sag-admin"),
      binding(hidden,"erp-customers")], secret: async () => key.toString("hex"), read, now: Date.now });
    const input=await enrich(fixture(),"qa",1,undefined,conf);
    const items=buildCatalogCustomerDirectory(input,selector).items;
    expect(items.map(i=>[i.name,i.displayDocument,i.state,i.web])).toEqual([
      ["Solo Admin","EXT-123 4","unverified","in_web"],["Solo ERP","007001","active","unverified"]]);
    expect(read.mock.calls.map(([b])=>b.id).sort()).toEqual([erp,sag].sort());
    expect(buildCatalogCustomerDirectory(input,{...selector,search:"EXT-1234"}).total).toBe(1);
    expect(buildCatalogCustomerDirectory(input,{...selector,search:"007001"}).total).toBe(1);
    expect(buildCatalogCustomerDirectory(input,{...selector,search:"fixture-opaque-1"}).total).toBe(0);
    expect(JSON.stringify(items)).not.toMatch(/hmac:|771122|887766/);
  });

  it("rejects a changed document for the same external row and never uses the opaque route ID as fallback", async () => {
    const enrich=createCatalogCustomerDocumentDisplay({ bindings: async () => [binding(erp,"erp-customers")],
      secret: async () => key.toString("hex"), read: async () => [{sourceRecordId:1,documentNumber:"REASSIGNED"}], now: Date.now });
    const result=buildCatalogCustomerDirectory(await enrich(fixture(),"qa",1,[erp],conf),{...selector,sourceIds:[erp]});
    expect(result.partial).toBe(true);
    expect(result.items[0]).toMatchObject({displayDocument:null,name:"Solo ERP"});
    expect(JSON.stringify(result)).not.toContain("REASSIGNED");
  });

  it("deduplicates in-flight reads without keeping a cache across binding/profile versions", async () => {
    let version="0000000000000001";
    const read=vi.fn(async () => [{sourceRecordId:1,documentNumber:"007001"}]);
    const secret=vi.fn(async () => key.toString("hex"));
    const enrich=createCatalogCustomerDocumentDisplay({ bindings: async () => [binding(erp,"erp-customers",version)],
      secret, read, now: Date.now });
    await Promise.all([enrich(fixture(),"qa",1,[erp],conf),enrich(fixture(),"qa",1,[erp],conf)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(secret).toHaveBeenCalledTimes(1);
    version="0000000000000002";
    await enrich(fixture(),"qa",1,[erp],conf);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
