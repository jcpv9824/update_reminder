import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), audit: vi.fn(), transaction: {} }));
vi.mock("../lib/sqlTransaction", () => ({
  runSqlTransaction: (fn: (tx: object) => unknown) => fn(mocks.transaction),
}));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: mocks.audit }));
vi.mock("mssql", () => ({ default: {
  Request: class {
    params: Record<string, unknown> = {};
    input(name: string, _type: unknown, value: unknown) { this.params[name] = value; return this; }
    query(statement: string) { return mocks.query(statement, this.params); }
  },
  VarChar: vi.fn(), NVarChar: vi.fn(), VarBinary: vi.fn(), UniqueIdentifier: Symbol(),
} }));

import { saveSqlCatalogSourceDraft } from "../lib/catalogSourceBindingsSqlRepository";

const id = "00000000-0000-0000-0000-000000000001";
const profile = { display_name: "ERP CO", status: "active", active: true, encrypt_connection: true };
const input = { profileId: "profile-1", environment: "qa", role: "erp-customers", issuerScope: "CO:NIT" } as const;
const actor = { id: "editor-1" };
const row = {
  catalog_source_id: id, profile_id: input.profileId, display_name: profile.display_name,
  source_role: input.role, portal_environment: input.environment, source_state: "draft",
  issuer_scope: input.issuerScope, contract_version: "erp_v1", binding_version: Buffer.alloc(8, 2),
  profile_version: Buffer.alloc(8, 3), can_read_current_profile: false,
};
const responds = (...sets: object[][]) => {
  for (const recordset of sets) mocks.query.mockResolvedValueOnce({ recordset });
};

beforeEach(() => { mocks.query.mockReset(); mocks.audit.mockReset(); });

describe("catalog source draft SQL repository", () => {
  it("inserts a draft with safe projections and audits only source/actor IDs in its transaction", async () => {
    responds([profile], [], [{ written_id: id }], [row]);
    await expect(saveSqlCatalogSourceDraft(input, actor)).resolves.toMatchObject({
      status: "saved", binding: { id, state: "draft", issuerScope: "CO:NIT", canReadCurrentProfile: false },
    });
    const [selectProfile, insert] = [mocks.query.mock.calls[0], mocks.query.mock.calls[2]];
    expect(selectProfile[0]).toContain("WITH (UPDLOCK,HOLDLOCK)");
    expect(selectProfile[0]).not.toMatch(/password|host|secret|login|username/i);
    expect(insert[0]).toContain("'draft'");
    expect(insert[0]).toContain("NOT EXISTS");
    expect(insert[1]).toEqual({ profileId: input.profileId, environment: "qa", label: "ERP CO",
      role: "erp-customers", issuerScope: "CO:NIT", contractVersion: "erp_v1", actorId: actor.id });
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(mocks.transaction, {
      entityType: "catalog_source_binding", entityId: id, action: "catalog_source_draft_created",
      performedBy: actor.id, performedByEmail: "",
    });
  });

  it.each(["draft", "active"])("does not write or audit an unchanged %s", async source_state => {
    responds([profile], [{ ...row, source_state }]);
    await expect(saveSqlCatalogSourceDraft(input, actor)).resolves.toMatchObject({
      status: "saved", binding: { state: source_state },
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(["draft", "active"])("does not promote a stored SAG v1 %s when the configured new-draft contract becomes v2", async source_state => {
    responds([profile], [{ ...row, source_state, source_role: "sag-admin", issuer_scope: null, contract_version: "sag_admin_v1" }]);
    await expect(saveSqlCatalogSourceDraft({ profileId: input.profileId, environment: "qa", role: "sag-admin" }, actor, "sag_admin_v2"))
      .resolves.toMatchObject({ status: "saved", binding: { contractVersion: "sag_admin_v1", state: source_state } });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("cannot change an active issuer or role and refuses ambiguous or retired bindings", async () => {
    responds([profile], [{ ...row, source_state: "active", issuer_scope: "US:TIN" }],
      [profile], [{ ...row, source_state: "active", source_role: "sag-admin", issuer_scope: null }],
      [profile], [row, row], [profile], [], []);
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(saveSqlCatalogSourceDraft(input, actor)).resolves.toEqual({ status: "conflict" });
    }
    expect(mocks.query).toHaveBeenCalledTimes(9);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("updates a draft only at its locked revision and clears its old verification", async () => {
    responds([profile], [{ ...row, issuer_scope: "US:TIN" }], [{ written_id: id }], [row]);
    await expect(saveSqlCatalogSourceDraft(input, actor)).resolves.toMatchObject({ status: "saved" });
    const [update, params] = mocks.query.mock.calls[2];
    expect(update).toContain("validated_at=NULL, validated_profile_version=NULL");
    expect(update).toContain("source_state='draft'");
    expect(update).toContain("row_version=CONVERT(binary(8),@bindingVersion)");
    expect(params.bindingVersion).toEqual(row.binding_version);
    expect(mocks.audit.mock.calls[0][1].action).toBe("catalog_source_draft_updated");
  });

  it("rejects absent, disabled or TLS-disabled profiles without writing or auditing", async () => {
    responds([], [{ ...profile, status: "inactive", active: false }], [], [{ ...profile, encrypt_connection: false }], []);
    await expect(saveSqlCatalogSourceDraft(input, actor)).resolves.toEqual({ status: "profile-not-found" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(saveSqlCatalogSourceDraft(input, actor)).resolves.toEqual({ status: "unsupported-profile" });
    }
    expect(mocks.query).toHaveBeenCalledTimes(5);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
