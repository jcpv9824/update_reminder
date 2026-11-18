import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateSqlCatalogSource, CATALOG_SOURCE_ACTIVATION_PROOF_MAX_AGE_MS } from "../lib/catalogSourceActivationSqlRepository";
import type { SqlCatalogSourceBinding } from "../lib/catalogSourceBindingsSqlRepository";
import type { CatalogSourceVerification } from "../lib/catalogSourceConfiguration";
import type { CurrentUser } from "../types/models";

const fake = vi.hoisted(() => ({
  transaction: { id: "synthetic-transaction" },
  run: vi.fn(), request: vi.fn(), input: vi.fn(), query: vi.fn(), audit: vi.fn(),
  commit: vi.fn(), rollback: vi.fn(),
}));
vi.mock("mssql", () => ({
  default: {
    Request: fake.request, UniqueIdentifier: {}, NVarChar: (width: number) => ({ width }),
    VarBinary: (width: number) => ({ width }), VarChar: (width: number) => ({ width }),
    DateTime2: (precision: number) => ({ precision }), Int: {}, ISOLATION_LEVEL: { SERIALIZABLE: 5 },
  },
}));
vi.mock("../lib/sqlTransaction", () => ({ runSqlTransaction: fake.run }));
vi.mock("../lib/auditSqlWriter", () => ({ writeSqlAuditLog: fake.audit }));

const binding: SqlCatalogSourceBinding = {
  id: "dc720d81-2122-4ad3-8c8e-51e6fd8d1930", profileId: "synthetic-profile", label: "Synthetic",
  environment: "qa", state: "draft", role: "erp-customers", profileRevision: "0000000000000f01",
  contractVersion: "erp_v1", issuerScope: "CO:NIT", bindingVersion: "0000000000000218", canReadCurrentProfile: false,
};
const actor: CurrentUser = { id: "synthetic-actor", displayName: "Synthetic User", email: "synthetic@example.test", roles: [] };

function proof(overrides?: Partial<CatalogSourceVerification>): CatalogSourceVerification {
  return {
    bindingId: binding.id, bindingVersion: binding.bindingVersion,
    profileId: binding.profileId, profileRevision: binding.profileRevision,
    contractVersion: binding.contractVersion, role: binding.role, environment: binding.environment,
    tlsValidated: true, canSelectApprovedProjection: true, hasElevatedOrWriteAccess: false,
    contractValid: true, checkedAtMs: Date.now() - 500, ...overrides,
  };
}

describe("catalog source activation persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake.request.mockImplementation(function () { return { input: fake.input, query: fake.query }; });
    fake.input.mockReturnThis();
    fake.query.mockResolvedValue({ recordset: [{ result: "activated" }] });
    fake.run.mockImplementation(async work => {
      try {
        const value = await work(fake.transaction);
        fake.commit();
        return value;
      } catch (error) {
        fake.rollback();
        throw error;
      }
    });
  });

  it("takes rowversion CAS locks and audits the activation in the same serializable transaction", async () => {
    const evidence = proof();
    await expect(activateSqlCatalogSource(binding, evidence, actor)).resolves.toBe("activated");
    expect(fake.run).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5);
    expect(fake.request).toHaveBeenCalledExactlyOnceWith(fake.transaction);
    expect(fake.input).toHaveBeenCalledWith("bindingVersion", expect.anything(), Buffer.from(binding.bindingVersion, "hex"));
    expect(fake.input).toHaveBeenCalledWith("profileVersion", expect.anything(), Buffer.from(binding.profileRevision, "hex"));
    expect(fake.input).toHaveBeenCalledWith("checkedAt", expect.anything(), new Date(evidence.checkedAtMs));
    expect(fake.input).toHaveBeenCalledWith("maxProofAgeMs", expect.anything(), CATALOG_SOURCE_ACTIVATION_PROOF_MAX_AGE_MS);
    expect(fake.input).toHaveBeenCalledWith("issuerScope", expect.anything(), "CO:NIT");
    const sql = fake.query.mock.calls[0][0] as string;
    expect(sql).toContain("sys.sp_getapplock");
    expect(sql).toContain("WITH (UPDLOCK,HOLDLOCK)");
    expect(sql).toContain("p.row_version=CONVERT(binary(8),@profileVersion)");
    expect(sql).toContain("b.row_version=CONVERT(binary(8),@bindingVersion)");
    expect(sql).toContain("p.status='active' AND p.active=1 AND p.encrypt_connection=1 AND p.password_configured=1");
    expect(sql).toContain("b.source_state='draft'");
    expect(sql).toContain("b.source_state='active' AND b.source_role='sag-admin'");
    expect(sql).toContain("@checkedAt<DATEADD(millisecond,-@maxProofAgeMs,@validatedAt)");
    expect(sql).toContain("validated_profile_version=CONVERT(binary(8),@profileVersion)");
    expect(sql).toContain("validated_at=@validatedAt");
    expect(sql.indexOf("SYSUTCDATETIME()")).toBeGreaterThan(sql.indexOf("HOLDLOCK"));
    expect(sql).not.toMatch(/password_secret|server_host|database_name|login_name/);
    expect(fake.audit).toHaveBeenCalledExactlyOnceWith(fake.transaction, {
      entityType: "catalog_source_binding", entityId: binding.id, action: "catalog_source_activated",
      performedBy: actor.id, performedByEmail: "",
    });
    expect(fake.commit).toHaveBeenCalledOnce();
  });

  it("rejects unbound, superseded, elevated, future, or stale evidence without touching SQL", async () => {
    for (const overrides of [
      { bindingId: undefined }, { bindingVersion: undefined }, { bindingVersion: "0000000000000219" },
      { profileRevision: "0000000000000221" }, { contractVersion: "sag_admin_v1" },
      { environment: "production" }, { tlsValidated: false }, { hasElevatedOrWriteAccess: true },
      { hasElevatedOrWriteAccess: null }, { contractValid: false }, { canSelectApprovedProjection: false },
      { checkedAtMs: Date.now() + 100_000 },
      { checkedAtMs: Date.now() - CATALOG_SOURCE_ACTIVATION_PROOF_MAX_AGE_MS - 1 },
    ] satisfies Partial<CatalogSourceVerification>[]) {
      await expect(activateSqlCatalogSource(binding, proof(overrides), actor)).resolves.toBe("superseded");
    }
    await expect(activateSqlCatalogSource({ ...binding, state: "retired" }, proof(), actor)).resolves.toBe("superseded");
    await expect(activateSqlCatalogSource({ ...binding, state: "active", canReadCurrentProfile: true }, proof(), actor))
      .resolves.toBe("superseded");
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("revalidates only the same stale active binding and cannot churn a current one", async () => {
    const stale = { ...binding, state: "active" as const, canReadCurrentProfile: false };
    await expect(activateSqlCatalogSource(stale, proof(), actor)).resolves.toBe("activated");
    expect(fake.input).toHaveBeenCalledWith("expectedState", expect.anything(), "active");
    const sql = fake.query.mock.calls[0][0] as string;
    expect(sql).toContain("b.source_state='active' AND b.validated_profile_version<>CONVERT(binary(8),@profileVersion)");
    expect(sql).toContain("b.catalog_source_key<>@bindingKey");
    expect(sql).not.toMatch(/SET .*source_role|SET .*external_database_connection_key/);
    expect(fake.audit).toHaveBeenCalledExactlyOnceWith(fake.transaction, expect.objectContaining({ action: "catalog_source_revalidated" }));
  });

  it.each(["conflict", "superseded"] as const)("returns SQL's %s with no audit write", async status => {
    fake.query.mockResolvedValueOnce({ recordset: [{ result: status }] });
    await expect(activateSqlCatalogSource(binding, proof(), actor)).resolves.toBe(status);
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("rolls back if the audit fails and never exposes the driver error", async () => {
    fake.audit.mockRejectedValueOnce(new Error("synthetic private SQL error"));
    await expect(activateSqlCatalogSource(binding, proof(), actor)).rejects.toEqual(new Error("catalog_source_activation_failed"));
    expect(fake.rollback).toHaveBeenCalledOnce();
    expect(fake.commit).not.toHaveBeenCalled();
  });

  it("rejects malformed SQL output and rolls back without auditing a false activation", async () => {
    fake.query.mockResolvedValueOnce({ recordset: [{ result: "activated" }, { result: "activated" }] });
    await expect(activateSqlCatalogSource(binding, proof(), actor)).rejects.toEqual(new Error("catalog_source_activation_failed"));
    expect(fake.rollback).toHaveBeenCalledOnce();
    expect(fake.audit).not.toHaveBeenCalled();
  });
});
