import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REGISTER_CATALOG_PHYSICAL_TARGET_SQL } from "../lib/catalogPhysicalTargetRegistrationSqlRepository";
import { resolveCatalogSqlInstanceRoute } from "../lib/catalogSqlInstanceRegistry";
import { readCatalogSqlTargetIdentity } from "../lib/catalogSqlTargetIdentityReader";
import { getSecret } from "../lib/keyVault";

// One-shot operator CLI, not an application entry point. The operator must
// independently verify the approved scope and the DBA's effective read-only
// metadata-access attestation for the exact principal before issuing --apply.
// The submitted record and its reference are not authentication or proof of
// SQL permissions. The Portal actor, saved route and TLS GUID are rechecked here.
const approvalKeys = ["environment", "actorId", "clientId", "domainId", "databaseId", "savedConnectionId",
  "operationalVersion", "savedVersion", "instanceId", "principalRouteSha256", "approvalReference",
  "reviewedAt", "validUntil"] as const;
const rowKeys = ["accessProfileKey", "serverHost", "serverPort", "databaseName", "username", "secretName"] as const;
const maxReviewMs = 24 * 60 * 60_000;
const stableError = () => new Error("catalog_qa_036_not_confirmed");
const opaque = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 150 &&
  s === s.trim() && !/\p{C}/u.test(s);
const hex = (s: unknown, n: number): s is string => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s)
  && /[1-9a-f]/.test(s);
const guid = (s: unknown): s is string => typeof s === "string" && s.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s) && s !== "00000000-0000-0000-0000-000000000000";
const literal = (s: string) => `N'${s.replaceAll("'", "''")}'`;
const text = (s: string) => `CONVERT(nvarchar(max),0x${Buffer.from(s, "utf16le").toString("hex")})`;
const millis = (s: unknown): number => typeof s === "string" && s.length === 24 && Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s ? Date.parse(s) : NaN;

function data<const K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw stableError();
  const copy = Object.create(null) as Record<K, unknown>;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw stableError();
    copy[key] = field.value;
  }
  return copy;
}

function approval(input: unknown) {
  const p = data(input, approvalKeys);
  const { environment, actorId, clientId, domainId, databaseId, savedConnectionId, operationalVersion, savedVersion,
    instanceId, principalRouteSha256, approvalReference, reviewedAt, validUntil } = p;
  const since = millis(reviewedAt);
  const until = millis(validUntil);
  if (environment !== "qa" || !opaque(actorId) || !opaque(clientId) || !opaque(domainId) || !opaque(databaseId) ||
    !opaque(savedConnectionId) || !hex(operationalVersion, 16) || !hex(savedVersion, 16) || !guid(instanceId) ||
    !hex(principalRouteSha256, 64) || typeof approvalReference !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}(?![\s\S])/.test(approvalReference) ||
    !Number.isFinite(since) || !Number.isFinite(until) || since > Date.now() || until <= Date.now() ||
    until - since > maxReviewMs) throw stableError();
  return { actorId, clientId, domainId, databaseId, savedConnectionId, operationalVersion, savedVersion,
    instanceId, principalRouteSha256, approvalReference, since, until };
}

function profile(raw: unknown) {
  const { accessProfileKey, serverHost, serverPort, databaseName, username, secretName } = data(raw, rowKeys);
  if (typeof accessProfileKey !== "string" || !/^[1-9][0-9]{0,18}(?![\s\S])/.test(accessProfileKey) ||
    BigInt(accessProfileKey) > 9223372036854775807n || typeof serverHost !== "string" || serverHost.length < 3 ||
    serverHost.length > 253 || serverHost !== serverHost.trim() || !opaque(databaseName) || databaseName.length > 128 ||
    !opaque(username) || username.length > 128 || typeof secretName !== "string" ||
    !/^[a-zA-Z0-9-]{1,127}(?![\s\S])/.test(secretName) || typeof serverPort !== "number" ||
    !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw stableError();
  return { accessProfileKey, serverHost, serverPort, databaseName, username, secretName };
}

const qaGuard = `
IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0 OR DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'
  OR DATALENGTH(DB_NAME())<>34 OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 53680,N'QA physical target not confirmed.',1;
`;
const verifiedScopeSql = `
SELECT TOP(2) @accessProfileKey=ap.access_profile_key,@host=p.server_host,@port=p.server_port,
  @catalog=p.database_name,@login=p.login_name,@secretName=p.password_secret_name,
  @clientKey=c.client_key,@domainKey=d.domain_key,@databaseKey=db.database_key
FROM core.clients c WITH (HOLDLOCK)
JOIN core.domains d WITH (HOLDLOCK) ON d.client_key=c.client_key AND d.status='active'
JOIN core.databases db WITH (HOLDLOCK) ON db.domain_key=d.domain_key AND db.client_key=c.client_key AND db.status='active'
JOIN core.database_access_profiles ap WITH (HOLDLOCK) ON ap.access_profile_key=db.access_profile_key
  AND ap.active=1 AND ap.row_version=@operationalVersion
JOIN settings.external_database_connections p WITH (HOLDLOCK) ON p.source_id=@savedConnectionId
  AND p.source_id COLLATE Latin1_General_100_BIN2=@savedConnectionId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(p.source_id)=DATALENGTH(@savedConnectionId) AND p.row_version=@savedVersion AND p.active=1
  AND p.status='active' AND p.encrypt_connection=1 AND p.password_configured=1 AND p.password_secret_name IS NOT NULL
WHERE c.status='active' AND c.source_id COLLATE Latin1_General_100_BIN2=@clientId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(c.source_id)=DATALENGTH(@clientId)
  AND d.source_id COLLATE Latin1_General_100_BIN2=@domainId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(d.source_id)=DATALENGTH(@domainId)
  AND db.source_id COLLATE Latin1_General_100_BIN2=@databaseId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(db.source_id)=DATALENGTH(@databaseId)
  AND db.environment_id COLLATE Latin1_General_100_BIN2='test' AND DATALENGTH(db.environment_id)=4
  AND ap.server_host_port COLLATE Latin1_General_100_BIN2=CONCAT(p.server_host,N',',p.server_port) COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(ap.server_host_port)=DATALENGTH(CONCAT(p.server_host,N',',p.server_port))
  AND ap.initial_catalog COLLATE Latin1_General_100_BIN2=p.database_name COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(ap.initial_catalog)=DATALENGTH(p.database_name)
  AND NOT EXISTS(SELECT 1 FROM settings.catalog_source_bindings b WITH (HOLDLOCK)
    WHERE b.external_database_connection_key=p.external_database_connection_key AND b.source_state='active')
  AND EXISTS(SELECT 1 FROM security.users u WITH (HOLDLOCK)
    JOIN security.user_roles ur WITH (HOLDLOCK) ON ur.user_key=u.user_key
    JOIN security.roles r WITH (HOLDLOCK) ON r.role_id=ur.role_id
    WHERE u.active=1 AND u.source_id COLLATE Latin1_General_100_BIN2=@actorId COLLATE Latin1_General_100_BIN2
      AND DATALENGTH(u.source_id)=DATALENGTH(@actorId)
      AND r.role_id COLLATE Latin1_General_100_BIN2=N'super_admin' AND DATALENGTH(r.role_id)=22
      AND r.active=1 AND r.protected_role=1 AND r.system_role=1
      AND 3=(SELECT COUNT(*) FROM (VALUES(N'configuration.integrations.view'),(N'configuration.integrations.test_database'),
        (N'configuration.integrations.edit_database')) v(k)
        JOIN security.permissions p WITH (HOLDLOCK) ON p.permission_key COLLATE Latin1_General_100_BIN2=v.k
          AND DATALENGTH(p.permission_key)=DATALENGTH(v.k) AND p.active=1
        JOIN security.role_permissions a WITH (HOLDLOCK) ON a.role_id=r.role_id AND a.permission_key=p.permission_key));
SET @matches=@@ROWCOUNT;
IF @matches<>1 OR @approvalUntil<=SYSUTCDATETIME() THROW 53680,N'QA physical target not confirmed.',1;
`;
const variables = `
DECLARE @matches int=0,@accessProfileKey bigint,@clientKey bigint,@domainKey bigint,@databaseKey bigint,
  @host nvarchar(255),@port int,@catalog nvarchar(128),@login nvarchar(128),@secretName nvarchar(255);
`;
function batch(p: ReturnType<typeof approval>, body: string) {
  return `
SET NOCOUNT ON;
SET XACT_ABORT ON;
${qaGuard}
DECLARE @actorId nvarchar(150)=${text(p.actorId)},@clientId nvarchar(150)=${text(p.clientId)},@domainId nvarchar(150)=${text(p.domainId)},
  @databaseId nvarchar(150)=${text(p.databaseId)},@savedConnectionId nvarchar(150)=${text(p.savedConnectionId)},
  @operationalVersion binary(8)=0x${p.operationalVersion},@savedVersion binary(8)=0x${p.savedVersion},
  @reviewedAt datetime2(3)=${literal(new Date(p.since).toISOString().slice(0,-1))},
  @approvalUntil datetime2(3)=${literal(new Date(p.until).toISOString().slice(0,-1))};
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRY
  BEGIN TRANSACTION;
  ${variables}
  ${verifiedScopeSql}
  ${body}
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  THROW 53680,N'QA physical target not confirmed.',1;
END CATCH;
`;
}
const readBody = `
ROLLBACK TRANSACTION;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT CONVERT(varchar(20),@accessProfileKey) AS accessProfileKey,@host AS serverHost,@port AS serverPort,
  @catalog AS databaseName,@login AS username,@secretName AS secretName;
`;
const auditHash = "41ac873e498b1a34501995d15ae23117e386a29c6c7d317c23ac70f86b4a39a9";
export function pinnedQaPhysicalTargetAuditSql(source: string): string {
  const literals = [...source.replaceAll("\r", "").matchAll(/await request\.query\(`(\s*INSERT audit\.audit_logs\b[^`]+)`\);/g)];
  const sql = literals[0]?.[1];
  if (literals.length !== 1 || !sql || createHash("sha256").update(sql).digest("hex") !== auditHash) throw stableError();
  return sql;
}

function writeBody(r: ReturnType<typeof profile>, fingerprint: Buffer, verifiedAt: Date, p: ReturnType<typeof approval>, audit: string) {
  const date = (v: Date) => literal(v.toISOString().slice(0, -1));
  return `
IF @accessProfileKey<>${r.accessProfileKey} OR @port<>${r.serverPort}
  OR EXISTS(SELECT @host COLLATE Latin1_General_100_BIN2,DATALENGTH(@host),@catalog COLLATE Latin1_General_100_BIN2,DATALENGTH(@catalog),
    @login COLLATE Latin1_General_100_BIN2,DATALENGTH(@login),@secretName COLLATE Latin1_General_100_BIN2,DATALENGTH(@secretName)
    EXCEPT SELECT ${text(r.serverHost)},${r.serverHost.length * 2},${text(r.databaseName)},${r.databaseName.length * 2},
      ${text(r.username)},${r.username.length * 2},${text(r.secretName)},${r.secretName.length * 2})
  THROW 53680,N'QA physical target not confirmed.',1;
DECLARE @verifiedAt datetime2(3)=${date(verifiedAt)},@validUntil datetime2(3)=@approvalUntil,
  @identityFingerprint binary(32)=0x${fingerprint.toString("hex")},@proofId uniqueidentifier=NEWID(),@now datetime2(3)=SYSUTCDATETIME(),
  @targetId uniqueidentifier,@linkId uniqueidentifier,@previous uniqueidentifier,@priorIdentity binary(32),@priorCatalog binary(32),
  @priorVerified datetime2(3),@priorRetired datetime2(3),@linkUntil datetime2(3),@priorProfileKey bigint,@priorVersion binary(8),
  @existing bit=0,@auditId nvarchar(150)=N'audit_'+LOWER(CONVERT(char(36),NEWID())),
  @auditMetadata nvarchar(max)=${text(JSON.stringify({ approvalReference: p.approvalReference }))};
IF @verifiedAt>@now OR @reviewedAt>@verifiedAt OR @validUntil<=@now OR DATEDIFF_BIG(millisecond,@verifiedAt,@now)>=300000
  THROW 53680,N'QA physical target not confirmed.',1;
SELECT TOP(1) @previous=l.link_id,@targetId=t.target_id,@priorIdentity=t.identity_fingerprint,
  @priorCatalog=t.database_name_fingerprint,@priorVerified=l.verified_at,@priorRetired=l.retired_at,@linkUntil=l.valid_until,
  @priorProfileKey=l.access_profile_key,@priorVersion=l.access_profile_version
FROM core.catalog_physical_target_links l WITH (UPDLOCK,HOLDLOCK)
JOIN core.catalog_physical_targets t WITH (HOLDLOCK) ON t.physical_target_key=l.physical_target_key
  AND t.portal_environment=l.portal_environment AND t.target_kind=l.target_kind
WHERE l.portal_environment='qa' AND l.target_kind='database' AND l.client_key=@clientKey AND l.domain_key=@domainKey
  AND l.database_key=@databaseKey
ORDER BY l.verified_at DESC,l.physical_target_link_key DESC;
IF @previous IS NOT NULL
BEGIN
  IF @priorRetired IS NOT NULL OR @priorVerified>@now OR @priorIdentity<>@identityFingerprint OR @priorCatalog IS NULL
    OR @priorCatalog<>HASHBYTES('SHA2_256',CONVERT(varbinary(max),@catalog))
    THROW 53680,N'QA physical target not confirmed.',1;
  IF @linkUntil>@now AND @priorProfileKey=@accessProfileKey AND @priorVersion=@operationalVersion
  BEGIN
    SET @existing=1;
    SET @linkId=@previous;
  END;
  IF @existing=0 AND @reviewedAt<=@priorVerified THROW 53680,N'QA physical target not confirmed.',1;
END
IF @existing=0
BEGIN
  DECLARE @registration table(result varchar(32),target_id char(36),link_id char(36),replaced_link_id char(36));
  INSERT @registration EXEC sys.sp_executesql ${literal(REGISTER_CATALOG_PHYSICAL_TARGET_SQL)},N'
    @environment varchar(10),@kind varchar(20),@clientId nvarchar(150),@domainId nvarchar(150),@databaseId nvarchar(150),
    @verifiedProfileKey bigint,@profileVersion varbinary(8),@routeFingerprint varbinary(32),@identityFingerprint varbinary(32),
    @proofId uniqueidentifier,@verifiedAt datetime2(3),@validUntil datetime2(3),@actorId nvarchar(150)',
    @environment='qa',@kind='database',@clientId=@clientId,@domainId=@domainId,@databaseId=@databaseId,
    @verifiedProfileKey=@accessProfileKey,@profileVersion=@operationalVersion,@routeFingerprint=NULL,
    @identityFingerprint=@identityFingerprint,@proofId=@proofId,@verifiedAt=@verifiedAt,@validUntil=@validUntil,@actorId=@actorId;
  IF (SELECT COUNT(*) FROM @registration)<>1 OR EXISTS(SELECT 1 FROM @registration WHERE result<>'registered'
    OR (@previous IS NULL AND replaced_link_id IS NOT NULL)
    OR (@previous IS NOT NULL AND (replaced_link_id IS NULL OR CONVERT(uniqueidentifier,replaced_link_id)<>@previous)))
    THROW 53680,N'QA physical target not confirmed.',1;
  SELECT @linkId=CONVERT(uniqueidentifier,link_id),@targetId=CONVERT(uniqueidentifier,target_id) FROM @registration;
  IF @linkId IS NULL OR @targetId IS NULL THROW 53680,N'QA physical target not confirmed.',1;
  DECLARE @auditLink nvarchar(260)=LOWER(CONVERT(char(36),@linkId));
  DECLARE @auditAction nvarchar(160)=CASE WHEN @previous IS NULL THEN N'catalog_physical_target_registered' ELSE N'catalog_physical_target_reverified' END;
  EXEC sys.sp_executesql ${literal(audit)},N'
    @sourceId nvarchar(150),@entityType nvarchar(100),@entitySourceId nvarchar(260),@clientSourceId nvarchar(150),
    @clientName nvarchar(200),@domainSourceId nvarchar(150),@domainName nvarchar(500),@companyName nvarchar(240),
    @action nvarchar(160),@performedBy nvarchar(150),@performedByEmail nvarchar(254),@performedAt datetime2(3),
    @beforeJson nvarchar(max),@afterJson nvarchar(max),@metadataJson nvarchar(max),@classification varchar(20)',
    @sourceId=@auditId,@entityType=N'catalog_physical_target_link',@entitySourceId=@auditLink,@clientSourceId=NULL,
    @clientName=NULL,@domainSourceId=NULL,@domainName=NULL,@companyName=NULL,@action=@auditAction,
    @performedBy=@actorId,@performedByEmail=NULL,@performedAt=@now,@beforeJson=NULL,@afterJson=NULL,@metadataJson=@auditMetadata,@classification='confidential';
END;
SET @now=SYSUTCDATETIME();
IF @validUntil<=@now OR (@existing=1 AND @linkUntil<=@now) OR DATEDIFF_BIG(millisecond,@verifiedAt,@now)>=300000 OR XACT_STATE()<>1
  THROW 53680,N'QA physical target not confirmed.',1;
COMMIT TRANSACTION;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT CASE WHEN @existing=0 THEN 'registered' ELSE 'existing' END AS status,LOWER(CONVERT(char(36),@targetId)) AS targetId,
  LOWER(CONVERT(char(36),@linkId)) AS linkId;
`;
}

type Mode = "read" | "write";
type Options = Readonly<{
  broker: (statement: string, mode: Mode) => Promise<unknown>;
  secret: typeof getSecret;
  identity: typeof readCatalogSqlTargetIdentity;
  routes: () => string | undefined;
  auditSource: () => Promise<string>;
}>;
type Result = Readonly<{ status: "registered" | "existing"; targetId: string; linkId: string }> | { status: "unavailable" };
export async function registerCatalogQaPhysicalSqlTarget(approved: unknown, io: Options): Promise<Result> {
  let observed: Buffer | null = null;
  try {
    const p = approval(approved);
    const audit = pinnedQaPhysicalTargetAuditSql(await io.auditSource());
    const sql = batch(p, readBody);
    const snapshot = async () => {
      if (Date.now() >= p.until) throw stableError();
      const r = profile(await io.broker(sql, "read"));
      const saved = createHash("sha256").update(JSON.stringify(["portal-sag:qa-036-metadata:v1",
        r.serverHost,r.serverPort,r.databaseName,r.username])).digest();
      if (!timingSafeEqual(saved, Buffer.from(p.principalRouteSha256, "hex")) ||
        resolveCatalogSqlInstanceRoute(io.routes(), "qa", r.serverHost, r.serverPort) !== p.instanceId ||
        Date.now() >= p.until) throw stableError();
      return r;
    };
    const before = await snapshot();
    const signal = AbortSignal.timeout(Math.max(0, Math.min(15_000, p.until - Date.now())));
    if (Date.now() >= p.until) throw stableError();
    const password = await io.secret(before.secretName, signal);
    const current = await snapshot();
    if (!password || JSON.stringify(before) !== JSON.stringify(current) || signal.aborted) throw stableError();
    observed = await io.identity({ instanceId: p.instanceId, connection: { server: current.serverHost, port: current.serverPort,
      database: current.databaseName, username: current.username, password } }, signal);
    if (!Buffer.isBuffer(observed) || observed.length !== 32 || !observed.some(Boolean) || signal.aborted ||
      resolveCatalogSqlInstanceRoute(io.routes(), "qa", current.serverHost, current.serverPort) !== p.instanceId) throw stableError();
    const verifiedAt = new Date();
    if (verifiedAt.valueOf() >= p.until) throw stableError();
    const result = data(await io.broker(batch(p, writeBody(current, observed, verifiedAt, p, audit)), "write"),
      ["status", "targetId", "linkId"]);
    if ((result.status !== "registered" && result.status !== "existing") || !guid(result.targetId) || !guid(result.linkId)) throw stableError();
    return { status: result.status, targetId: result.targetId, linkId: result.linkId };
  } catch {
    return { status: "unavailable" };
  } finally {
    if (Buffer.isBuffer(observed)) observed.fill(0);
  }
}

function broker(sessionDirectory: string, scriptPath: string) {
  return async (statement: string, mode: Mode): Promise<unknown> => new Promise((done, fail) => {
    const command = "$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
      "& $env:PORTAL_QA_036_BROKER -SessionDirectory $r.sessionDirectory -Sql $r.statement -Mode $r.mode -TimeoutSeconds 20 -MaxRows 1";
    const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
      shell: false, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PORTAL_QA_036_BROKER: scriptPath },
      stdio: ["pipe","pipe","ignore"],
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); fail(stableError()); }, 28_000);
    const reject = () => { clearTimeout(timeout); fail(stableError()); };
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.stdout.setEncoding("utf8").on("data", (value: string) => {
      output += value;
      if (output.length > 8192) { child.kill(); reject(); }
    });
    child.on("close", code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw stableError();
        const response = JSON.parse(output);
        const set = response?.resultSets?.[0];
        if (response?.success !== true || response.resultSets.length !== 1 || set?.totalRows !== 1 ||
          set?.truncated !== false || !Array.isArray(set.rows) || set.rows.length !== 1) throw stableError();
        done(set.rows[0]);
      } catch { reject(); }
    });
    child.stdin.end(JSON.stringify({ sessionDirectory, statement, mode }));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (process.env.PORTAL_SAG_ENVIRONMENT !== "qa" || argv.length !== 3 || argv[0] !== "--session-directory" ||
    !argv[1] || argv[2] !== "--apply") throw stableError();
  const sessionDirectory = resolve(argv[1]);
  const descriptor = JSON.parse(await readFile(resolve(sessionDirectory,"active.json"), "utf8"));
  if (descriptor?.environment !== "qa" || descriptor.database !== "PortalSAGWeb-TEST" || descriptor.fullControl !== true ||
    descriptor.accessLevel !== "full-control" || descriptor.sessionAuthorized !== true || descriptor.approvalMode !== "session") throw stableError();
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw stableError();
  }
  const root = resolve(__dirname, "../../../..");
  return registerCatalogQaPhysicalSqlTarget(JSON.parse(input), {
    broker: broker(sessionDirectory, resolve(root, "migration/connect-sql-server/Invoke-PortalSAGWeb-EphemeralRequest.ps1")),
    secret: getSecret,
    identity: readCatalogSqlTargetIdentity,
    routes: () => process.env.PORTAL_CATALOG_SQL_INSTANCE_ROUTES,
    auditSource: () => readFile(resolve(root, "api/src/lib/auditSqlWriter.ts"), "utf8"),
  });
}

if (require.main === module) void main().catch(() => ({ status: "unavailable" })).then(result => {
  if (result.status === "unavailable") process.exitCode = 1;
  process.stdout.write(JSON.stringify(result) + "\n");
});
