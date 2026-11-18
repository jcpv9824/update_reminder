import { beforeEach, describe, expect, it, vi } from "vitest";
import sql from "mssql";
import { revalidateSqlCatalogExecutionLicenses, type CatalogExecutionLicenseProofInput } from "../lib/catalogExecutionLicenseSqlProof";

const fake = vi.hoisted(() => ({ construct: vi.fn(), input: vi.fn(), query: vi.fn() }));
vi.mock("mssql", async original => {
  const actual = await original<typeof import("mssql")>();
  return { ...actual, default: { ...actual.default, Request: class {
    constructor(tx: unknown) { fake.construct(tx); }
    input = fake.input;
    query = fake.query;
  } } };
});
const transaction = {} as sql.Transaction;
const deadline = new Date("2030-01-01T12:00:00.000Z");
const input: CatalogExecutionLicenseProofInput = { executionId: "9007199254740993", portalEnvironment: "qa", matchKeyVersion: 7,
  attachments: [{ linkId: "117fdc31-5137-49db-8109-e881442554d5", scheduleId: "schedule-private", moduleIds: ["module-a"] }] };
const statement = () => fake.query.mock.calls[0][0] as string;

describe("transactional catalog execution licensing proof", () => {
  beforeEach(() => {
    vi.resetAllMocks(); fake.input.mockReturnThis(); fake.query.mockResolvedValue({ recordset: [{ validUntil: deadline }] });
  });

  it("uses the provided transaction, bound exact bigint/scope/attachments and returns only the SQL deadline", async () => {
    expect(await revalidateSqlCatalogExecutionLicenses(transaction, input)).toEqual(deadline);
    expect(fake.construct).toHaveBeenCalledExactlyOnceWith(transaction);
    expect(fake.input).toHaveBeenCalledWith("executionId", sql.BigInt, input.executionId);
    expect(fake.input).toHaveBeenCalledWith("portalEnvironment", expect.anything(), "qa");
    expect(fake.input).toHaveBeenCalledWith("matchKeyVersion", sql.SmallInt, 7);
    expect(fake.input).toHaveBeenCalledWith("attachments", expect.anything(), JSON.stringify(input.attachments));
    expect(statement()).not.toContain(input.attachments[0].scheduleId);
    expect(statement()).not.toContain(input.attachments[0].linkId);
    expect(statement()).not.toContain("${");
    expect(statement()).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:core|settings|scheduling|workflow)\./i);
    expect(statement().slice(statement().lastIndexOf("SELECT @deadline"))).toBe("SELECT @deadline AS validUntil WHERE @deadline>SYSUTCDATETIME();\n");
  });

  it.each([[], [{ validUntil: "2030-01-01" }], [{ validUntil: null }], [{ validUntil: new Date("invalid") }],
    [{ validUntil: deadline }, { validUntil: deadline }]])("denies an absent or malformed result without inventing a deadline: %j", async recordset => {
    fake.query.mockResolvedValue({ recordset });
    expect(await revalidateSqlCatalogExecutionLicenses(transaction, input)).toBeNull();
  });

  it("sanitizes SQL failures and never swallows them as successful empty membership", async () => {
    fake.query.mockRejectedValue(new Error("private database message"));
    await expect(revalidateSqlCatalogExecutionLicenses(transaction, input)).rejects.toEqual(new Error("catalog_execution_license_proof_unavailable"));
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "01", "9223372036854775808", "1\n", "bad"])
    ("denies malformed execution ID %j before SQL", async executionId => {
      expect(await revalidateSqlCatalogExecutionLicenses(transaction, { ...input, executionId })).toBeNull();
      expect(fake.query).not.toHaveBeenCalled();
    });

  it.each([0, -1, 1.5, 32768, undefined])("requires explicit valid match key version %j", async matchKeyVersion => {
    expect(await revalidateSqlCatalogExecutionLicenses(transaction, { ...input, matchKeyVersion } as CatalogExecutionLicenseProofInput)).toBeNull();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("denies empty, excessive, duplicate or malformed attachments and absent environment before SQL", async () => {
    const attachment = input.attachments[0];
    for (const attachments of [[], Array.from({ length: 513 }, () => attachment), [attachment, attachment],
      [{ ...attachment, moduleIds: ["module-a", "module-a"] }], [{ ...attachment, moduleIds: ["module-a "] }],
      [{ ...attachment, moduleIds: Array.from({ length: 26 }, (_, n) => `module-${n}`) }],
      [{ ...attachment, scheduleId: " schedule" }], [{ ...attachment, linkId: "link\u0000" }]]) {
      expect(await revalidateSqlCatalogExecutionLicenses(transaction, { ...input, attachments })).toBeNull();
    }
    expect(await revalidateSqlCatalogExecutionLicenses(transaction, { ...input, portalEnvironment: undefined } as unknown as CatalogExecutionLicenseProofInput)).toBeNull();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("rejects empty planning module sets before SQL for licensing-only attachments", async () => {
    fake.query.mockResolvedValue({ recordset: [] });
    expect(await revalidateSqlCatalogExecutionLicenses(transaction, { ...input,
      attachments: [{ ...input.attachments[0], moduleIds: [] }] })).toBeNull();
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("permits the exact maximum of 25 distinct planned module IDs and 512 unique attachments", async () => {
    const attachments = Array.from({ length: 512 }, (_, n) => ({ ...input.attachments[0], scheduleId: `schedule-${n}`,
      moduleIds: Array.from({ length: 25 }, (_, m) => `module-${m}`) }));
    expect(await revalidateSqlCatalogExecutionLicenses(transaction, { ...input, attachments })).toEqual(deadline);
    expect(fake.query).toHaveBeenCalledTimes(1);
  });

  it("binds exact current 042 ERP record, source, scope and enrolled match-key identity", async () => {
    await revalidateSqlCatalogExecutionLicenses(transaction, input);
    for (const text of ["settings.catalog_match_key_registry WITH (HOLDLOCK)", "match_key_version=@matchKeyVersion AND enrolled_at<=@now",
      "l.catalog_execution_key=e.catalog_execution_key", "l.catalog_source_key IS NOT NULL",
      "bridge.link_id=TRY_CONVERT(uniqueidentifier,l.link_id) AND DATALENGTH(l.link_id)=72",
      "bridge.client_key=l.client_key AND bridge.domain_key=l.domain_key", "bridge.database_key=l.database_key",
      "bridge.target_kind=l.execution_kind COLLATE Latin1_General_100_BIN2",
      "bridge.link_environment=l.link_environment COLLATE Latin1_General_100_BIN2",
      "bridge.catalog_source_key=l.catalog_source_key AND bridge.source_record_id=TRY_CONVERT(int,l.catalog_record_id)",
      "DATALENGTH(CONVERT(nvarchar(11),bridge.source_record_id))=DATALENGTH(l.catalog_record_id)",
      "bridge.retired_at IS NULL AND bridge.owner_retired_at IS NULL AND bridge.evidence_state='verified'",
      "r.revision_key=bridge.revision_key AND r.revision_key=h.revision_key",
      "erp.revision_key=r.revision_key AND erp.source_record_id=bridge.source_record_id",
      "erp.catalog_customer_key=bridge.catalog_customer_key AND erp.active_code='S'",
      "other_erp.source_record_id<>erp.source_record_id", "other_erp.catalog_customer_key=erp.catalog_customer_key",
      "other_erp.document_number_token=erp.document_number_token",
    ]) expect(statement()).toContain(text);
  });

  it("locks mutable source/profile/head evidence and demands one fresh certified SAG head", async () => {
    await revalidateSqlCatalogExecutionLicenses(transaction, input);
    for (const text of ["settings.catalog_source_bindings b WITH (HOLDLOCK)",
      "settings.external_database_connections p WITH (HOLDLOCK)", "settings.catalog_customer_revision_heads h WITH (HOLDLOCK)",
      "b.validated_at<=@now AND b.validated_profile_version=p.row_version",
      "p.active=1 AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1",
      "h.attempt_status='succeeded' AND h.attempted_at<=@now", "r.binding_version=b.row_version AND r.profile_version=p.row_version",
      "r.sealed_at<=@now AND r.observed_at<=@now AND r.verified_until>@now AND r.has_sag_inventory_evidence=1",
      "IF (SELECT COUNT_BIG(*) FROM @sag)<>1 RETURN;",
    ]) expect(statement()).toContain(text);
  });

  it("derives only a strict HTTPS root DNS hostname and preserves scoped parent/exclusion/target rules", async () => {
    await revalidateSqlCatalogExecutionLicenses(transaction, input);
    for (const text of ["LEFT(d.domain_name,8) COLLATE Latin1_General_100_BIN2=N'https://'",
      "DATALENGTH(d.domain_name)=2*LEN(d.domain_name)", "REPLACE(host.hostname,N'-',N'') COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^a-z0-9.]%'",
      "LEN(label.[value]) NOT BETWEEN 1 AND 63", "parent_bridge.client_key=l.client_key AND parent_bridge.domain_key=l.domain_key",
      "parent_bridge.database_key IS NULL AND parent_bridge.target_kind='domain'",
      "parent_bridge.evidence_state='verified' AND parent_bridge.verified_until>@now",
      "l.execution_kind='domain' OR parent.valid_until IS NOT NULL", "ls.environment_id IS NULL",
      "ls.target_types='domains_and_databases'", "ls.target_types='domains_only'", "ls.target_types='databases_only'",
      "DATALENGTH(d.environment_id)=DATALENGTH(l.link_environment)",
      "DATALENGTH(db.environment_id)=DATALENGTH(l.link_environment)",
      "DATALENGTH(ls.environment_id)=DATALENGTH(l.link_environment)",
      "scheduling.licensing_excluded_domains WITH (HOLDLOCK)", "scheduling.licensing_excluded_databases WITH (HOLDLOCK)",
      "s.active=1 AND s.deleted_at IS NULL AND s.selection_mode='licensing'",
    ]) expect(statement()).toContain(text);
    expect(statement()).not.toContain("%[^a-z0-9.-]%");
    expect(statement()).toContain("LEFT(label.[value],1)=N'-' OR RIGHT(label.[value],1)=N'-'");
  });

  it("rejects identity ambiguity and duplicate/unknown claims without borrowing other-scope entitlements", async () => {
    await revalidateSqlCatalogExecutionLicenses(transaction, input);
    for (const text of ["r.document_number_token=a.document_token AND r.issuer IS NULL",
      "r.issuer=a.issuer AND r.document_type=a.document_type AND r.document_number_token=a.document_token",
      "c.environment_kind IS NULL OR c.environment_kind='unknown'",
      "c.environment_kind=a.environment_id AND c.domain_candidate IS NULL",
      "c.environment_kind=a.environment_id AND CONVERT(nvarchar(253),c.domain_candidate)=a.hostname",
      "GROUP BY ordinal,domain_candidate,environment_kind HAVING COUNT_BIG(*)>1",
      "GROUP BY ordinal,code HAVING COUNT_BIG(*)>1", "GROUP BY ordinal HAVING COUNT_BIG(*)>128",
      "DATALENGTH(c.environment_kind)=DATALENGTH(a.environment_id)",
    ]) expect(statement()).toContain(text);
  });

  it("requires versioned active module approvals, symmetric exact sets and persisted any/all membership", async () => {
    await revalidateSqlCatalogExecutionLicenses(transaction, input);
    for (const text of ["settings.catalog_sag_license_module_approvals approval WITH (HOLDLOCK)",
      "approval.catalog_source_key=sag.source_key AND approval.binding_version=sag.binding_version",
      "approval.profile_version=sag.profile_version AND approval.sag_code=c.code AND approval.approved_at<=@now",
      "m.status='active' AND m.deleted_at IS NULL", "EXCEPT SELECT ordinal,module_id,DATALENGTH(module_id) FROM @derived",
      "SELECT ordinal,module_id,DATALENGTH(module_id) FROM @derived\n  EXCEPT SELECT",
      "DATALENGTH(CONVERT(nvarchar(150),j.[value]))", "scheduling.licensing_scope_modules requested WITH (HOLDLOCK)",
      "a.match_mode='any' AND NOT EXISTS", "a.match_mode='all' AND EXISTS",
    ]) expect(statement()).toContain(text);
  });

  it("returns the minimum ERP/parent/SAG deadline only after a fresh final server-clock check", async () => {
    await revalidateSqlCatalogExecutionLicenses(transaction, input);
    expect(statement()).toContain("SELECT erp_until AS deadline FROM @eligible UNION ALL SELECT parent_until FROM @eligible");
    expect(statement()).toContain("UNION ALL SELECT valid_until FROM @sag");
    expect(statement()).toContain("SELECT @deadline AS validUntil WHERE @deadline>SYSUTCDATETIME();");
    expect(statement()).not.toMatch(/\b(?:COMMIT|ROLLBACK|BEGIN TRANSACTION)\b/);
  });
});
