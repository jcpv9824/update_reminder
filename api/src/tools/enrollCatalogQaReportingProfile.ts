import { withVerifiedReportingProfileEnrollment, type ReportingEnrollmentScope } from "../lib/catalogReportingProfileEnrollment";
import { decodeCatalogReportingEnrollmentRow, parseCatalogReportingEnrollmentContract,
  READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL as READ_SQL } from "../lib/catalogReportingProfileEnrollmentSqlReader";
import { bindReportingCountContract, REGISTER_CATALOG_REPORTING_PROFILE_SQL as REGISTER_SQL }
  from "../lib/catalogReportingProfileRegistrationSqlRepository";
import { resolveCatalogSqlInstanceRoute } from "../lib/catalogSqlInstanceRegistry";
import { pinnedQaPhysicalTargetAuditSql, readQaCatalogOperatorInput } from "./registerCatalogQaPhysicalSqlTarget";

// Workspace-only QA tool. Operator must independently verify the approved actor,
// 036 destination, exact saved profile and reviewed read-only counting contract.
// Neither the ticket nor the JSON record grants authority. --apply is mandatory.
const fail = (): never => { throw new Error("catalog_qa_reporting_enrollment_not_confirmed"); };
const qs = (value: string) => `N'${value.replaceAll("'", "''")}'`;
const wireText = (value: string | null) => value === null ? "NULL" : `CONVERT(nvarchar(max),0x${Buffer.from(value,"utf16le").toString("hex")})`;
const wireDate = (ms: number) => qs(new Date(ms).toISOString().slice(0,-1));
const opaque = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 150 &&
  s === s.trim() && !/\p{C}/u.test(s);
const guid = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/.test(s)
  && s !== "00000000-0000-0000-0000-000000000000";
const bytes = (s: unknown, n: number): s is string => typeof s === "string" && s.length === n &&
  /^[a-f0-9]+(?![\s\S])/.test(s) && /[1-9a-f]/.test(s);
const decode = (v: unknown, length: number) => typeof v === "string" && v.startsWith("0x") && bytes(v.slice(2),length)
  ? Buffer.from(v.slice(2),"hex") : fail();
const utc = (v: unknown): number => typeof v === "string" && v.length === 24 && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v ? Date.parse(v) : NaN;
// PowerShell ConvertFrom-Json may reinterpret a plain ISO string and trim its
// fractional seconds. An exact tagged scalar is never parsed as a date by it.
const brokerUtc = (v: unknown): number => typeof v === "string" && v.startsWith("UTC:") && v.length === 28 ? utc(v.slice(4)) : NaN;
function data<const Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, unknown> {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== keys.length ||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return fail();
  const result=Object.create(null) as Record<Key, unknown>;
  for (const key of keys) {
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,"value")) return fail();
    result[key]=descriptor.value;
  }
  return result;
}

function approve(value: unknown) {
  const { environment, actorId, physicalLinkId, physicalTargetId, reportConnectionId, operationalVersion,
    reportVersion, instanceId, countContract, approvalReference, reviewedAt, validUntil } = data(value, [
    "environment","actorId","physicalLinkId","physicalTargetId","reportConnectionId","operationalVersion",
    "reportVersion","instanceId","countContract","approvalReference","reviewedAt","validUntil",
  ]);
  const since=utc(reviewedAt), until=utc(validUntil);
  const evidence=parseCatalogReportingEnrollmentContract(countContract);
  const bindings=evidence && bindReportingCountContract(evidence);
  if (environment!=="qa" || !opaque(actorId) || !opaque(reportConnectionId) || !guid(physicalLinkId) ||
    !guid(physicalTargetId) || !guid(instanceId) || !bytes(operationalVersion,16) || !bytes(reportVersion,16) || !evidence || !bindings ||
    typeof approvalReference!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}(?![\s\S])/.test(approvalReference) ||
    !Number.isFinite(since) || !Number.isFinite(until) || since>Date.now() || until<=Date.now() || until-since>86_400_000) return fail();
  const scope: ReportingEnrollmentScope={ portalEnvironment:environment,actorId,physicalLinkId,physicalTargetId,reportConnectionId };
  return { scope, operationalVersion, reportVersion, instanceId, evidence, bindings, approvalReference, since, until };
}

const snapshotSql = `
IF NOT EXISTS(SELECT 1 FROM core.catalog_physical_target_links l WITH (HOLDLOCK)
  JOIN core.databases db WITH (HOLDLOCK) ON db.database_key=l.database_key AND db.client_key=l.client_key AND db.domain_key=l.domain_key
  WHERE l.portal_environment='qa' AND l.target_kind='database' AND l.link_id=@linkId
    AND db.environment_id COLLATE Latin1_General_100_BIN2='test' AND DATALENGTH(db.environment_id)=4)
  THROW 55880,N'QA reporting profile not confirmed.',1;
DECLARE @snapshot table(portalEnvironment varchar(10),actorId nvarchar(150),physicalLinkId uniqueidentifier,
  physicalTargetId uniqueidentifier,reportConnectionId nvarchar(150),operationalProfileVersion binary(8),physicalValidUntil datetime2(3),
  expectedIdentityFingerprint binary(32),profileVersion binary(8),serverHost nvarchar(255),serverPort int,
  databaseName nvarchar(128),username nvarchar(128),passwordSecretName nvarchar(255));
INSERT @snapshot EXEC sys.sp_executesql ${qs(READ_SQL)},N'@portalEnvironment varchar(32),@actorId nvarchar(150),
  @physicalLinkId uniqueidentifier,@physicalTargetId uniqueidentifier,@reportConnectionId nvarchar(150)',
  @portalEnvironment='qa',@actorId=@actorId,@physicalLinkId=@linkId,@physicalTargetId=@targetId,@reportConnectionId=@connectionId;
IF (SELECT COUNT(*) FROM @snapshot)<>1 OR @approvalUntil<=SYSUTCDATETIME() OR EXISTS(
  SELECT 1 FROM @snapshot WHERE operationalProfileVersion IS NULL OR operationalProfileVersion<>@operationalVersion
    OR profileVersion IS NULL OR profileVersion<>@reportVersion)
  THROW 55880,N'QA reporting profile not confirmed.',1;
`;

function batch(p: ReturnType<typeof approve>, body: string) {
  const { scope }=p;
  return `
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0 OR DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'
  OR DATALENGTH(DB_NAME())<>34 OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 55880,N'QA reporting profile not confirmed.',1;
DECLARE @actorId nvarchar(150)=${wireText(scope.actorId)},@linkId uniqueidentifier=${qs(scope.physicalLinkId)},
  @targetId uniqueidentifier=${qs(scope.physicalTargetId)},@connectionId nvarchar(150)=${wireText(scope.reportConnectionId)},
  @operationalVersion binary(8)=0x${p.operationalVersion},@reportVersion binary(8)=0x${p.reportVersion},
  @reviewedAt datetime2(3)=${wireDate(p.since)},@approvalUntil datetime2(3)=${wireDate(p.until)};
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRY
  BEGIN TRANSACTION;
  ${snapshotSql}
  ${body}
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  THROW 55880,N'QA reporting profile not confirmed.',1;
END CATCH;`;
}

const probeProjection = `
ROLLBACK TRANSACTION;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT portalEnvironment,actorId,physicalLinkId,physicalTargetId,reportConnectionId,operationalProfileVersion,
  'UTC:'+CONVERT(char(19),physicalValidUntil,126)+'.'+RIGHT('00'+CONVERT(varchar(3),DATEPART(millisecond,physicalValidUntil)),3)+'Z'
    AS physicalValidUntil,expectedIdentityFingerprint,profileVersion,
  serverHost,serverPort,databaseName,username,passwordSecretName FROM @snapshot;`;
const rowKeys=["portalEnvironment","actorId","physicalLinkId","physicalTargetId","reportConnectionId","operationalProfileVersion",
  "physicalValidUntil","expectedIdentityFingerprint","profileVersion","serverHost","serverPort","databaseName","username","passwordSecretName"] as const;
type Proof = Parameters<Parameters<typeof withVerifiedReportingProfileEnrollment>[2]>[0];

function write(proof: Proof, p: ReturnType<typeof approve>, audit: string) {
  const { checked, databaseGuid, enrollmentProofId, reportingProofId, verifiedAtMs }=proof;
  const { connection }=checked;
  const b=p.bindings;
  const enrollmentUntil=Math.min(proof.enrollmentExpiryMs,p.until);
  const reportingUntil=Math.min(proof.reportingExpiryMs,p.until);
  const operationUntil=Math.min(enrollmentUntil,proof.deadlineMs);
  return `
DECLARE @verifiedAt datetime2(3)=${wireDate(verifiedAtMs)},@enrollmentUntil datetime2(3)=${wireDate(enrollmentUntil)},
  @reportingUntil datetime2(3)=${wireDate(reportingUntil)},@operationUntil datetime2(3)=${wireDate(operationUntil)},
  @physicalUntil datetime2(3)=${wireDate(checked.physicalUntilMs)},
  @identity binary(32)=0x${checked.expectedIdentityFingerprint.toString("hex")},@instance uniqueidentifier=${qs(p.instanceId)},
  @databaseGuid uniqueidentifier=${qs(databaseGuid)},@enrollmentProof uniqueidentifier=${qs(enrollmentProofId)},
  @reportingProof uniqueidentifier=${qs(reportingProofId)},@enrolled varchar(32),@route binary(32);
IF @reviewedAt>@verifiedAt OR @operationUntil<=SYSUTCDATETIME() OR @reportingUntil>@approvalUntil
  OR EXISTS(SELECT expectedIdentityFingerprint,physicalValidUntil,serverHost COLLATE Latin1_General_100_BIN2,DATALENGTH(serverHost),
    serverPort,databaseName COLLATE Latin1_General_100_BIN2,DATALENGTH(databaseName),username COLLATE Latin1_General_100_BIN2,
    DATALENGTH(username),passwordSecretName COLLATE Latin1_General_100_BIN2,DATALENGTH(passwordSecretName)
    FROM @snapshot EXCEPT
    SELECT @identity,@physicalUntil,${wireText(connection.serverHost)},${connection.serverHost.length*2},${connection.serverPort},
      ${wireText(connection.databaseName)},${connection.databaseName.length*2},${wireText(connection.username)},
      ${connection.username.length*2},${wireText(connection.passwordSecretName)},${connection.passwordSecretName.length*2})
  THROW 55880,N'QA reporting profile not confirmed.',1;
SELECT @route=HASHBYTES('SHA2_256',CONVERT(varbinary(max),N'portal-sag:report-enrollment-route:v1|')
  +CONVERT(binary(4),DATALENGTH(serverHost))+CONVERT(varbinary(max),serverHost)+CONVERT(binary(4),serverPort)
  +CONVERT(binary(4),DATALENGTH(databaseName))+CONVERT(varbinary(max),databaseName)) FROM @snapshot;
EXEC settings.enroll_catalog_sql_target_instance_internal
  @environment='qa',@actorId=@actorId,@physicalLinkId=@linkId,@physicalTargetId=@targetId,
  @operationalProfileVersion=@operationalVersion,@reportConnectionId=@connectionId,@reportProfileVersion=@reportVersion,
  @reportRouteFingerprint=@route,@trustedInstanceId=@instance,@verifiedDatabaseGuid=@databaseGuid,
  @identityFingerprint=@identity,@proofId=@enrollmentProof,@verifiedAt=@verifiedAt,@validUntil=@enrollmentUntil,@result=@enrolled OUTPUT
  WITH RESULT SETS NONE;
IF @enrolled IS NULL OR @enrolled NOT IN ('enrolled','already-enrolled') OR @operationUntil<=SYSUTCDATETIME()
  THROW 55880,N'QA reporting profile not confirmed.',1;
DECLARE @saved table(result varchar(32),profile_id char(36),replaced_profile_id char(36));
DECLARE @contract varchar(32)=${wireText(b.contract)},@column varchar(128)=${wireText(b.column)},@storage varchar(4)=${wireText(b.storage)},
  @activeBit bit=${b.bit===null?"NULL":b.bit?1:0},@activeText nvarchar(32)=${wireText(b.active)},@inactiveText nvarchar(32)=${wireText(b.inactive)};
INSERT @saved EXEC sys.sp_executesql ${qs(REGISTER_SQL)},N'
  @environment varchar(10),@targetId uniqueidentifier,@connectionId nvarchar(150),@profileVersion varbinary(8),
  @identityFingerprint varbinary(32),@instanceId uniqueidentifier,@proofId uniqueidentifier,@actor nvarchar(150),
  @verifiedAt datetime2(3),@validUntil datetime2(3),@contract varchar(32),@column varchar(128),@storage varchar(4),
  @activeBit bit,@activeText nvarchar(32),@inactiveText nvarchar(32)',
  @environment='qa',@targetId=@targetId,@connectionId=@connectionId,@profileVersion=@reportVersion,@identityFingerprint=@identity,
  @instanceId=@instance,@proofId=@reportingProof,@actor=@actorId,@verifiedAt=@verifiedAt,@validUntil=@reportingUntil,
  @contract=@contract,@column=@column,@storage=@storage,@activeBit=@activeBit,@activeText=@activeText,@inactiveText=@inactiveText;
IF (SELECT COUNT(*) FROM @saved)<>1 OR EXISTS(SELECT 1 FROM @saved WHERE result<>'registered'
  OR TRY_CONVERT(uniqueidentifier,profile_id) IS NULL
  OR (replaced_profile_id IS NOT NULL AND TRY_CONVERT(uniqueidentifier,replaced_profile_id) IS NULL))
  THROW 55880,N'QA reporting profile not confirmed.',1;
DECLARE @profileId nvarchar(260),@replaced char(36),@auditId nvarchar(150)=N'audit_'+LOWER(CONVERT(char(36),NEWID())),
  @action nvarchar(160),@now datetime2(3)=SYSUTCDATETIME(),
  @metadata nvarchar(max)=${wireText(JSON.stringify({approvalReference:p.approvalReference}))};
SELECT @profileId=profile_id,@replaced=replaced_profile_id FROM @saved;
SET @action=CASE WHEN @replaced IS NULL THEN N'catalog_reporting_profile_registered' ELSE N'catalog_reporting_profile_reverified' END;
EXEC sys.sp_executesql ${qs(audit)},N'
  @sourceId nvarchar(150),@entityType nvarchar(100),@entitySourceId nvarchar(260),@clientSourceId nvarchar(150),
  @clientName nvarchar(200),@domainSourceId nvarchar(150),@domainName nvarchar(500),@companyName nvarchar(240),
  @action nvarchar(160),@performedBy nvarchar(150),@performedByEmail nvarchar(254),@performedAt datetime2(3),
  @beforeJson nvarchar(max),@afterJson nvarchar(max),@metadataJson nvarchar(max),@classification varchar(20)',
  @sourceId=@auditId,@entityType=N'catalog_reporting_profile',@entitySourceId=@profileId,@clientSourceId=NULL,
  @clientName=NULL,@domainSourceId=NULL,@domainName=NULL,@companyName=NULL,@action=@action,
  @performedBy=@actorId,@performedByEmail=NULL,@performedAt=@now,@beforeJson=NULL,@afterJson=NULL,@metadataJson=@metadata,
  @classification='confidential';
IF XACT_STATE()<>1 OR @@TRANCOUNT<>1 OR @verifiedAt>SYSUTCDATETIME() OR @operationUntil<=SYSUTCDATETIME()
  OR @reportingUntil<=SYSUTCDATETIME() OR @approvalUntil<=SYSUTCDATETIME()
  THROW 55880,N'QA reporting profile not confirmed.',1;
COMMIT TRANSACTION;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT 'registered' AS status,@profileId AS reportingProfileId;
`;
}

type Broker = Awaited<ReturnType<typeof readQaCatalogOperatorInput>>["broker"];
export async function enrollCatalogQaReportingProfile(input: unknown, io: {broker:Broker; auditSource:()=>Promise<string>}) {
  try {
    const p=approve(input);
    const audit=pinnedQaPhysicalTargetAuditSql(await io.auditSource());
    const readBatch=batch(p,probeProjection);
    return await withVerifiedReportingProfileEnrollment(p.scope,async (scope,signal) => {
      if (signal.aborted || Date.now()>=p.until) return null;
      const row=data(await io.broker(readBatch,"read"),rowKeys);
      if (signal.aborted || Date.now()>=p.until || row.operationalProfileVersion!==`0x${p.operationalVersion}` ||
        row.profileVersion!==`0x${p.reportVersion}`) return null;
      const verified=decodeCatalogReportingEnrollmentRow({...row,operationalProfileVersion:decode(row.operationalProfileVersion,16),
        profileVersion:decode(row.profileVersion,16),expectedIdentityFingerprint:decode(row.expectedIdentityFingerprint,64),
        physicalValidUntil:new Date(brokerUtc(row.physicalValidUntil)) },scope,p.evidence);
      return verified && resolveCatalogSqlInstanceRoute(process.env.PORTAL_CATALOG_SQL_INSTANCE_ROUTES,"qa",
        verified.connection.serverHost,verified.connection.serverPort)===p.instanceId ? verified : null;
    },async proof => {
      if (proof.instance!==p.instanceId || !proof.fresh() || Date.now()>=p.until) return fail();
      const result=data(await io.broker(batch(p,write(proof,p,audit)),"write"),["status","reportingProfileId"]);
      if (result.status!=="registered" || !guid(result.reportingProfileId)) return fail();
      return {status:"registered",reportingProfileId:result.reportingProfileId};
    },undefined,45_000);
  } catch {
    return {status:"unavailable"} as const;
  }
}

if (require.main===module) void readQaCatalogOperatorInput()
  .then(({input,broker,auditSource}) => enrollCatalogQaReportingProfile(input,{broker,auditSource}))
  .catch(() => ({status:"unavailable"})).then(result => {
    if (result.status==="unavailable") process.exitCode=1;
    process.stdout.write(JSON.stringify(result)+"\n");
  });
