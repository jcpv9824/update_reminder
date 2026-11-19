import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REGISTER_CATALOG_PHYSICAL_TARGET_SQL } from "../lib/catalogPhysicalTargetRegistrationSqlRepository";
import { pinnedQaPhysicalTargetAuditSql, registerCatalogQaPhysicalSqlTarget } from "../tools/registerCatalogQaPhysicalSqlTarget";

const now = new Date("2026-11-18T20:00:00.000Z");
const instanceId = "71000000-0000-0000-0000-000000000001";
const targetId = "71000000-0000-0000-0000-000000000002";
const linkId = "71000000-0000-0000-0000-000000000003";
const route = { accessProfileKey: "9223372036854775807", serverHost: "qa-sql.example.test", serverPort: 1433,
  databaseName: "Synthetic", username: "fixture_meta_reader", secretName: "fixture-vault-ref" };
const approval = {
  environment: "qa", actorId: "fixture-operator", clientId: "fixture-client", domainId: "fixture-domain", databaseId: "fixture-db",
  savedConnectionId: "fixture-saved", operationalVersion: "0102030405060708", savedVersion: "0807060504030201", instanceId,
  principalRouteSha256: createHash("sha256").update(JSON.stringify(["portal-sag:qa-036-metadata:v1",
    route.serverHost, route.serverPort, route.databaseName, route.username])).digest("hex"),
  approvalReference: "QA-036-INDEPENDENT-FIXTURE", reviewedAt: new Date(now.valueOf() - 1000).toISOString(),
  validUntil: new Date(now.valueOf() + 300_000).toISOString(),
};
const registry = JSON.stringify([{ environment: "qa", host: route.serverHost, port: route.serverPort, instanceId }]);
const auditSource = () => readFile(new URL("../lib/auditSqlWriter.ts", import.meta.url), "utf8");

function fakeIo() {
  const fingerprint = Buffer.alloc(32, 41);
  const broker = vi.fn(async (_sql: string, mode: "read" | "write"): Promise<unknown> =>
    mode === "read" ? route : { status: "registered", targetId, linkId });
  return {
    broker, fingerprint, identity: vi.fn(async () => fingerprint as Buffer | null),
    secret: vi.fn(async () => "synthetic-password"), routes: vi.fn(() => registry), auditSource,
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("one-shot 036 QA physical target operator", () => {
  it("reads exact authorized profile before Vault, rechecks before TLS, and writes exact 036 plus audit in one batch", async () => {
    const io = fakeIo();
    const wireIdentity = io.fingerprint.toString("hex");
    await expect(registerCatalogQaPhysicalSqlTarget(approval, io)).resolves.toEqual({ status: "registered", targetId, linkId });
    expect(io.broker.mock.calls.map(([, mode]) => mode)).toEqual(["read", "read", "write"]);
    expect(io.broker.mock.invocationCallOrder[0]).toBeLessThan(io.secret.mock.invocationCallOrder[0]);
    expect(io.secret.mock.invocationCallOrder[0]).toBeLessThan(io.broker.mock.invocationCallOrder[1]);
    expect(io.broker.mock.invocationCallOrder[1]).toBeLessThan(io.identity.mock.invocationCallOrder[0]);
    expect(io.identity).toHaveBeenCalledExactlyOnceWith({
      instanceId, connection: { server: route.serverHost, port: route.serverPort, database: route.databaseName,
        username: route.username, password: "synthetic-password" },
    }, expect.any(AbortSignal));
    const write = io.broker.mock.calls.at(-1)![0];
    expect(write).toContain(REGISTER_CATALOG_PHYSICAL_TARGET_SQL.replaceAll("'", "''"));
    expect(write).toContain(pinnedQaPhysicalTargetAuditSql(await auditSource()).replaceAll("'", "''"));
    expect(write).toContain(`@identityFingerprint binary(32)=0x${wireIdentity}`);
    expect(write).toContain("DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'");
    expect(write).toContain("db.environment_id COLLATE Latin1_General_100_BIN2='test'");
    expect(write).toContain("ap.row_version=@operationalVersion");
    expect(write).toContain("p.row_version=@savedVersion");
    expect(write).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(write).toContain("COMMIT TRANSACTION");
    expect(write).toContain("ROLLBACK TRANSACTION");
    const metadata = Buffer.from(JSON.stringify({ approvalReference: approval.approvalReference }), "utf16le").toString("hex");
    expect(write).toContain(`@auditMetadata nvarchar(max)=CONVERT(nvarchar(max),0x${metadata})`);
    expect(write).toContain("@metadataJson=@auditMetadata");
    expect(write).not.toMatch(/usuarios|COUNT_BIG|synthetic-password|fixture_meta_reader|fixture-vault-ref/i);
    expect(io.fingerprint).toEqual(Buffer.alloc(32));
  });

  it.each([
    { ...approval, environment: "production" }, { ...approval, validUntil: now.toISOString() },
    { ...approval, reviewedAt: new Date(now.valueOf() + 1).toISOString() }, { ...approval, actorId: " fixture" },
    { ...approval, savedVersion: "0000000000000000" }, { ...approval, operationalVersion: "1111" },
    { ...approval, identityFingerprint: "not permitted" }, { ...approval, password: "not permitted" },
    { ...approval, approvalReference: "no punctuation?" },
  ])("rejects invalid approved scope and caller-supplied proof/secret before Portal IO (%#)", async input => {
    const io = fakeIo();
    await expect(registerCatalogQaPhysicalSqlTarget(input, io)).resolves.toEqual({ status: "unavailable" });
    expect(io.broker).not.toHaveBeenCalled();
    expect(io.secret).not.toHaveBeenCalled();
  });

  it.each(["authorized read denied", "different route", "different principal", "unknown instance", "raw unexpected fields"])(
    "does not fetch secrets when %s", async issue => {
      const io = fakeIo();
      if (issue === "authorized read denied") io.broker.mockRejectedValueOnce(new Error("fixture private diagnostic"));
      if (issue === "different route") io.broker.mockResolvedValueOnce({ ...route, serverPort: 1434 });
      if (issue === "different principal") io.broker.mockResolvedValueOnce({ ...route, username: "not attested" });
      if (issue === "unknown instance") io.routes.mockReturnValueOnce("[]");
      if (issue === "raw unexpected fields") io.broker.mockResolvedValueOnce({ ...route, extra: "reject" });
      await expect(registerCatalogQaPhysicalSqlTarget(approval, io)).resolves.toEqual({ status: "unavailable" });
      expect(io.secret).not.toHaveBeenCalled();
      expect(io.identity).not.toHaveBeenCalled();
      expect(io.broker.mock.calls.map(([, mode]) => mode)).toEqual(["read"]);
    },
  );

  it("does not dial if authority, profile, or attestation expires before the second read", async () => {
    const authorization = fakeIo();
    authorization.broker.mockResolvedValueOnce(route).mockRejectedValueOnce(new Error("authority or profile lost"));
    expect(await registerCatalogQaPhysicalSqlTarget(approval, authorization)).toEqual({ status: "unavailable" });
    expect(authorization.identity).not.toHaveBeenCalled();
    const expired = fakeIo();
    expired.secret.mockImplementationOnce(async () => { vi.setSystemTime(new Date(approval.validUntil)); return "synthetic-password"; });
    expect(await registerCatalogQaPhysicalSqlTarget(approval, expired)).toEqual({ status: "unavailable" });
    expect(expired.identity).not.toHaveBeenCalled();
  });

  it("does not write when the guarded TLS/GUID probe cannot verify the identity", async () => {
    const io = fakeIo();
    io.identity.mockResolvedValueOnce(null);
    expect(await registerCatalogQaPhysicalSqlTarget(approval, io)).toEqual({ status: "unavailable" });
    expect(io.broker.mock.calls.map(([, mode]) => mode)).toEqual(["read", "read"]);
  });

  it("keeps exact existing evidence opaque and rejects malformed write outcomes", async () => {
    const io = fakeIo();
    io.broker.mockResolvedValueOnce(route).mockResolvedValueOnce(route).mockResolvedValueOnce({ status: "existing", targetId, linkId });
    expect(await registerCatalogQaPhysicalSqlTarget(approval, io)).toEqual({ status: "existing", targetId, linkId });
    const bad = fakeIo();
    bad.broker.mockResolvedValueOnce(route).mockResolvedValueOnce(route)
      .mockResolvedValueOnce({ status: "registered", targetId, linkId, databaseName: "private fixture" });
    expect(await registerCatalogQaPhysicalSqlTarget(approval, bad)).toEqual({ status: "unavailable" });
    expect(bad.fingerprint).toEqual(Buffer.alloc(32));
  });

  it("allows an expired same-identity renewal only after independent new review and never rewrites a different identity", async () => {
    const io = fakeIo();
    expect(await registerCatalogQaPhysicalSqlTarget(approval, io)).toEqual({ status: "registered", targetId, linkId });
    const statement = io.broker.mock.calls.at(-1)![0];
    expect(statement).toContain("ORDER BY l.verified_at DESC,l.physical_target_link_key DESC");
    expect(statement).toContain("@priorRetired IS NOT NULL OR @priorVerified>@now OR @priorIdentity<>@identityFingerprint");
    expect(statement).toContain("@linkUntil>@now AND @priorProfileKey=@accessProfileKey AND @priorVersion=@operationalVersion");
    expect(statement).toContain("@existing=0 AND @reviewedAt<=@priorVerified");
    expect(statement).toContain("CONVERT(uniqueidentifier,replaced_link_id)<>@previous");
    expect(statement).toContain("catalog_physical_target_reverified");
  });

  it("refuses to run when the existing pinned audit literal changes", async () => {
    const io = fakeIo();
    await expect(registerCatalogQaPhysicalSqlTarget(approval, { ...io, auditSource: async () => "changed audit" }))
      .resolves.toEqual({ status: "unavailable" });
    expect(io.broker).not.toHaveBeenCalled();
  });

  it.runIf(process.env.PORTAL_QA_TEST_SQL2019 === "true")("parses both generated SQL wire batches and the nested literals offline", async () => {
    const io = fakeIo();
    expect(await registerCatalogQaPhysicalSqlTarget(approval, io)).toEqual({ status: "registered", targetId, linkId });
    const parser = String.raw`
$ErrorActionPreference='Stop'
$dll=$env:PORTAL_QA_SCRIPT_DOM_PATH
if (!$dll) {
  $dll=(Get-ChildItem -Path 'C:\Program Files\Microsoft SQL Server Management Studio*' -Filter 'Microsoft.SqlServer.TransactSql.ScriptDom.dll' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if (!$dll) { throw 'Missing local SQL Server 2019 ScriptDom.' }
Add-Type -Path $dll
$parser=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
foreach ($sql in ([Console]::In.ReadToEnd()|ConvertFrom-Json)){
  $errors=$null
  $reader=[IO.StringReader]::new($sql)
  try { $null=$parser.Parse($reader,[ref]$errors) } finally { $reader.Dispose() }
  if (@($errors).Count) { throw ("Invalid SQL grammar: line {0}, column {1}." -f $errors[0].Line,$errors[0].Column) }
}
`;
    const result=spawnSync("pwsh",["-NoProfile","-NonInteractive","-Command",parser], { encoding: "utf8",
      input: JSON.stringify([...io.broker.mock.calls.map(([statement]) => statement), REGISTER_CATALOG_PHYSICAL_TARGET_SQL,
        pinnedQaPhysicalTargetAuditSql(await auditSource())]), timeout: 40_000 });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  }, 45_000);
});
