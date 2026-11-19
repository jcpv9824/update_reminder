import { isDeepStrictEqual } from "node:util";
import { buildSqlAuditRecord } from "../lib/auditSqlWriter";
import { refreshCatalogCustomerSource,type CatalogRefreshSink } from "../lib/catalogCustomerRefresh";
import { catalogManualPublicationSqlBatches as SQL,validateAndSerializeCatalogPublication } from "../lib/catalogCustomerSnapshotPublishSqlRepository";
import { createCatalogExternalSqlTransport } from "../lib/catalogExternalSqlTransport";
import { buildCatalogMatchKeyEvidence,type CatalogMatchKeyEvidence } from "../lib/catalogMatchKeyEvidence";
import { getSecret } from "../lib/keyVault";
import { pinnedQaPhysicalTargetAuditSql,readQaCatalogOperatorInput } from "./registerCatalogQaPhysicalSqlTarget";

// QA operator command; the actor/scope/timestamp are independently approved
// before --apply. Nothing is exported or queued and the broker never sees passwords or raw NITs.
const fail=():never=>{throw new Error("catalog_qa_erp_publication_not_confirmed");};
const q=(s:string)=>`N'${s.replaceAll("'","''")}'`;
const t=(s:string|null)=>s===null?"NULL":`CONVERT(nvarchar(max),0x${Buffer.from(s,"utf16le").toString("hex")})`;
const dt=(ms:number)=>q(new Date(ms).toISOString().slice(0,-1));
const utc=(s:unknown)=>typeof s==="string" && s.length===24 && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s ? Date.parse(s):NaN;
const id=(s:unknown,max=150):s is string=>typeof s==="string" && s.length>0 && s.length<=max && s===s.trim() && !/\p{C}/u.test(s);
const uuid=(s:unknown):s is string=>typeof s==="string" && s.length===36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s) &&
  s!=="00000000-0000-0000-0000-000000000000";
const hex=(s:unknown,n:number):s is string=>typeof s==="string" && s.length===n && /^[a-f0-9]+(?![\s\S])/.test(s);
const ordinal=(s:unknown):s is string=>typeof s==="string" && /^[1-9][0-9]{0,18}(?![\s\S])/.test(s) && BigInt(s)<=9223372036854775807n;
const ref=(s:unknown):s is string=>typeof s==="string" && /^[A-Za-z0-9-]{1,127}(?![\s\S])/.test(s);
function data<const K extends string>(v:unknown,keys:readonly K[]):Record<K,unknown>{
  if(!v || typeof v!=="object" || Reflect.ownKeys(v).length!==keys.length || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) return fail();
  const r=Object.create(null) as Record<K,unknown>;
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k); if(!d?.enumerable || !Object.hasOwn(d,"value")) return fail(); r[k]=d.value;}
  return r;
}
function approve(input:unknown,env:NodeJS.ProcessEnv){
  const {environment,issuerScope,actorId,sourceId,profileId,bindingVersion,profileVersion,vaultUrl,matchKeyVersion,
    matchKeySecretRef,matchKeySecretVersion,validUntil}=data(input,["environment","issuerScope","actorId","sourceId","profileId",
    "bindingVersion","profileVersion","vaultUrl","matchKeyVersion","matchKeySecretRef","matchKeySecretVersion","validUntil"]);
  const until=utc(validUntil);
  if(environment!=="qa" || env.PORTAL_SAG_ENVIRONMENT!=="qa" || issuerScope!=="CO:NIT" ||
    !id(actorId) || !uuid(sourceId) || !id(profileId) || !hex(bindingVersion,16) || !hex(profileVersion,16) ||
    typeof vaultUrl!=="string" || vaultUrl!==env.KEY_VAULT_URL || !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/?(?![\s\S])/.test(vaultUrl) ||
    typeof matchKeyVersion!=="number" || !Number.isInteger(matchKeyVersion) || matchKeyVersion<1 || matchKeyVersion>32767 ||
    String(matchKeyVersion)!==env.PORTAL_CATALOG_MATCH_KEY_VERSION || !ref(matchKeySecretRef) ||
    matchKeySecretRef!==env.PORTAL_CATALOG_MATCH_KEY_SECRET_NAME || !hex(matchKeySecretVersion,32) ||
    matchKeySecretVersion!==env.PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION || !Number.isFinite(until) ||
    until<=Date.now() || until-Date.now()>86_400_000) return fail();
  return {actorId,sourceId,profileId,bindingVersion,profileVersion,vaultUrl,matchKeyVersion,matchKeySecretRef,matchKeySecretVersion,until};
}
type Scope=ReturnType<typeof approve>;
type Broker=Awaited<ReturnType<typeof readQaCatalogOperatorInput>>["broker"];
const maxWire=5*1024*1024;
const maxBoundPayload=16*1024*1024;
const payloadMarker="/* portal-sag-catalog-qa-payload:v1 */";
type Io={broker:Broker;catalogPayloadSupported:boolean;env:NodeJS.ProcessEnv;secret:typeof getSecret;transport:typeof createCatalogExternalSqlTransport;
  refresh:typeof refreshCatalogCustomerSource;auditSource:()=>Promise<string>};
const projection=`
IF NOT EXISTS(SELECT 1 FROM security.users u WITH(HOLDLOCK)
  JOIN security.user_roles ur WITH(HOLDLOCK) ON ur.user_key=u.user_key
  JOIN security.roles r WITH(HOLDLOCK) ON r.role_id=ur.role_id AND r.active=1 AND r.system_role=1 AND r.protected_role=1
  WHERE u.active=1 AND u.source_id COLLATE Latin1_General_100_BIN2=@actor COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(u.source_id)=DATALENGTH(@actor) AND r.role_id COLLATE Latin1_General_100_BIN2=N'super_admin'
  AND DATALENGTH(r.role_id)=22 AND 3=(SELECT COUNT(*) FROM
    (VALUES(N'configuration.integrations.view'),(N'configuration.integrations.test_database'),(N'configuration.integrations.edit_database')) a(k)
    JOIN security.permissions ap WITH(HOLDLOCK) ON ap.permission_key COLLATE Latin1_General_100_BIN2=a.k
      AND DATALENGTH(ap.permission_key)=DATALENGTH(a.k) AND ap.active=1
    JOIN security.role_permissions ar WITH(HOLDLOCK) ON ar.role_id=r.role_id AND ar.permission_key=ap.permission_key))
  THROW 53380,N'ERP publication not confirmed.',1;
DECLARE @host nvarchar(255),@port int,@catalog nvarchar(128),@username nvarchar(128),@secretRef nvarchar(127);
SELECT @host=p.server_host,@port=p.server_port,@catalog=p.database_name,@username=p.login_name,@secretRef=p.password_secret_name
FROM settings.catalog_source_bindings b WITH(HOLDLOCK)
JOIN settings.external_database_connections p WITH(HOLDLOCK) ON p.external_database_connection_key=b.external_database_connection_key
  AND p.source_id COLLATE Latin1_General_100_BIN2=@profileId COLLATE Latin1_General_100_BIN2
  AND DATALENGTH(p.source_id)=DATALENGTH(@profileId) AND p.row_version=@profile AND p.active=1 AND p.status='active'
  AND p.encrypt_connection=1 AND p.password_configured=1
WHERE b.source_id=@source AND b.portal_environment COLLATE Latin1_General_100_BIN2='qa' AND DATALENGTH(b.portal_environment)=2
  AND b.source_state='active' AND b.source_role COLLATE Latin1_General_100_BIN2='erp-customers'
  AND DATALENGTH(b.source_role)=13 AND b.contract_version COLLATE Latin1_General_100_BIN2='erp_v1'
  AND DATALENGTH(b.contract_version)=6 AND b.issuer_scope COLLATE Latin1_General_100_BIN2=N'CO:NIT'
  AND DATALENGTH(b.issuer_scope)=12 AND b.row_version=@binding AND b.validated_profile_version=p.row_version
  AND b.validated_at<=SYSUTCDATETIME();
IF @@ROWCOUNT<>1 OR @secretRef IS NULL THROW 53380,N'ERP publication not confirmed.',1;
`;
const finish="COMMIT TRANSACTION; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;";
function batch(p:Scope,deadline:number,body:string){
  return `
SET NOCOUNT ON; SET XACT_ABORT ON;
IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0 OR DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'
  OR DATALENGTH(DB_NAME())<>34 OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 53380,N'ERP publication not confirmed.',1;
DECLARE @actor nvarchar(150)=${t(p.actorId)},@source uniqueidentifier=${q(p.sourceId)},@profileId nvarchar(150)=${t(p.profileId)},
  @binding binary(8)=0x${p.bindingVersion},@profile binary(8)=0x${p.profileVersion},
  @deadline datetime2(3)=${dt(deadline)},@keyVersion smallint=${p.matchKeyVersion};
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRY
  BEGIN TRANSACTION;
  IF @deadline<=SYSUTCDATETIME() THROW 53380,N'ERP publication not confirmed.',1;
  ${body}
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  THROW 53380,N'ERP publication not confirmed.',1;
END CATCH;`;
}
const clock="IF XACT_STATE()<>1 OR @@TRANCOUNT<>1 OR @deadline<=SYSUTCDATETIME() THROW 53380,N'ERP publication not confirmed.',1;";
function authorize(e:CatalogMatchKeyEvidence){
  return `
DECLARE @allowed table(allowed int);
DECLARE @vaultVersion binary(16)=0x${e.vaultSecretVersion.toString("hex")},@keyVerifier binary(32)=0x${e.keyVerifier.toString("hex")};
INSERT @allowed EXEC sys.sp_executesql ${q(SQL.authorize)},N'@actorId nvarchar(150),@source uniqueidentifier,@environment varchar(10),@binding varbinary(8),
  @profile varbinary(8),@currentKeyVersion smallint,@vaultSecretVersion varbinary(16),@keyVerifier varbinary(32)',
  @actorId=@actor,@source=@source,@environment='qa',@binding=@binding,@profile=@profile,@currentKeyVersion=@keyVersion,
  @vaultSecretVersion=@vaultVersion,@keyVerifier=@keyVerifier;
IF (SELECT COUNT(*) FROM @allowed)<>1 OR NOT EXISTS(SELECT 1 FROM @allowed WHERE allowed=1)
  THROW 53380,N'ERP publication not confirmed.',1;`;
}
function decodeProfile(value:unknown){
  const {server,port,database,username,secretRef}=data(value,["server","port","database","username","secretRef"]);
  if(!id(server,253) || typeof port!=="number" || !Number.isInteger(port) || port<1 || port>65535 ||
    !id(database,128) || !id(username,128) || !ref(secretRef)) return fail();
  return {server,port,database,username,secretRef};
}
function auditSql(p:Scope,audit:string){
  const a=buildSqlAuditRecord({entityType:"catalog_source_binding",entityId:p.sourceId,action:"catalog_source_refreshed",
    performedBy:p.actorId,performedByEmail:"system",metadata:{environment:"qa",sourceRole:"erp-customers",status:"published"}});
  return `
DECLARE @auditId nvarchar(150)=${t(a.entry.id)},@entityId nvarchar(260)=${t(a.entry.entityId)},@metadata nvarchar(max)=${t(a.metadataJson)},
  @performedAt datetime2(3)=${dt(Date.parse(a.entry.performedAt))};
EXEC sys.sp_executesql ${q(audit)},N'@sourceId nvarchar(150),@entityType nvarchar(100),@entitySourceId nvarchar(260),
  @clientSourceId nvarchar(150),@clientName nvarchar(200),@domainSourceId nvarchar(150),@domainName nvarchar(500),@companyName nvarchar(240),
  @action nvarchar(160),@performedBy nvarchar(150),@performedByEmail nvarchar(254),@performedAt datetime2(3),
  @beforeJson nvarchar(max),@afterJson nvarchar(max),@metadataJson nvarchar(max),@classification varchar(20)',
  @sourceId=@auditId,@entityType=N'catalog_source_binding',@entitySourceId=@entityId,@clientSourceId=NULL,@clientName=NULL,@domainSourceId=NULL,
  @domainName=NULL,@companyName=NULL,@action=N'catalog_source_refreshed',@performedBy=@actor,@performedByEmail=N'system',
  @performedAt=@performedAt,@beforeJson=NULL,@afterJson=NULL,@metadataJson=@metadata,@classification='confidential' WITH RESULT SETS NONE;`;
}

export async function publishCatalogQaErp(input:unknown,io:Io):Promise<{status:string;rowCount?:number}>{
  let key:Buffer|undefined,evidence:CatalogMatchKeyEvidence|undefined;
  try{
    if(io.catalogPayloadSupported!==true) return fail();
    const p=approve(input,io.env);
    const audit=pinnedQaPhysicalTargetAuditSql(await io.auditSource());
    const deadline=Math.min(p.until,Date.now()+60_000);
    const signal=AbortSignal.timeout(Math.max(0,deadline-Date.now()));
    const send=(body:string,mode:"read"|"write",catalogPayload?:string)=>{
      const statement=(catalogPayload===undefined?"":payloadMarker)+batch(p,deadline,body);
      if(signal.aborted || Date.now()>=deadline || statement.length>maxWire || Buffer.byteLength(statement,"utf8")>maxWire ||
        io.env.KEY_VAULT_URL!==p.vaultUrl) return fail();
      if(catalogPayload===undefined) return io.broker(statement,mode);
      if(mode!=="write" || Buffer.byteLength(catalogPayload,"utf8")>maxWire ||
        Buffer.byteLength(catalogPayload,"utf16le")>maxBoundPayload) return fail();
      // No inline fallback. SQL diagnostics with RPC parameter capture can
      // still see typed values; never include them in CLI/broker diagnostics.
      return io.broker(statement,mode,catalogPayload);
    };
    const lookup=(auth="")=>send(auth+projection+
      "ROLLBACK TRANSACTION; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT @host AS server,@port AS port,@catalog AS [database],@username AS username,@secretRef AS secretRef;","read")
      .then(decodeProfile);
    const initial=await lookup();
    if(signal.aborted || Date.now()>=deadline || io.env.KEY_VAULT_URL!==p.vaultUrl) return fail();
    const secret=await io.secret(p.matchKeySecretRef,AbortSignal.any([signal,AbortSignal.timeout(5_000)]),p.matchKeySecretVersion);
    if(!hex(secret,64) || signal.aborted || Date.now()>=deadline) return fail();
    key=Buffer.from(secret,"hex");
    evidence=buildCatalogMatchKeyEvidence("qa",p.matchKeyVersion,p.matchKeySecretVersion,key);
    const authorization=authorize(evidence);
    let reserved:string|undefined,rowCount:number|undefined;
    const observedAt=new Date();
    const stamp=(attempt:Parameters<CatalogRefreshSink["recordFailure"]>[0])=>{
      if(!reserved || attempt.attemptOrdinal!==reserved || attempt.environment!=="qa" || attempt.sourceId!==p.sourceId ||
        attempt.bindingRevision!==p.bindingVersion || attempt.profileRevision!==p.profileVersion ||
        attempt.matchKeyVersion!==p.matchKeyVersion || attempt.observedAt.getTime()!==observedAt.getTime()) return fail();
      return `DECLARE @ordinal varchar(19)=${q(reserved)},@observedAt datetime2(3)=${dt(observedAt.getTime())};
DECLARE @out table(result varchar(11));`;
    };
    const stampParams="@environment varchar(10),@sourceId uniqueidentifier,@profileRevision varbinary(8),@bindingRevision varbinary(8),"+
      "@attemptOrdinal varchar(19),@matchKeyVersion smallint,@observedAt datetime2(3)";
    const stampArgs="@environment='qa',@sourceId=@source,@profileRevision=@profile,@bindingRevision=@binding,"+
      "@attemptOrdinal=@ordinal,@matchKeyVersion=@keyVersion,@observedAt=@observedAt";
    // Take the publication lock before profile/actor reads in mutating batches.
    const write=authorization+projection;
    const readAuthorized=()=>lookup(authorization);
    const sink:CatalogRefreshSink={
      async reserveAttempt(){
        if(reserved) return fail();
        const r=data(await send(write+`
DECLARE @reserved table(attemptOrdinal varchar(19));
INSERT @reserved EXEC sys.sp_executesql ${q(SQL.reserve)};
${clock}
${finish}
SELECT attemptOrdinal FROM @reserved;`,"write"),["attemptOrdinal"]);
        if(!ordinal(r.attemptOrdinal)) return fail();
        return reserved=r.attemptOrdinal;
      },
      async publish(revision){
        if(revision.role!=="erp-customers" || revision.rows.some(r=>r.issuerScope!==null && r.issuerScope!=="CO:NIT")) return fail();
        const payload=validateAndSerializeCatalogPublication(revision);
        if(payload.inventory!==null || payload.scopes!=="[]") return fail();
        const r=data(await send(write+stamp(revision)+`
DECLARE @scopes nvarchar(max)=N'[]';
INSERT @out EXEC sys.sp_executesql ${q(SQL.publish)},N'${stampParams},@sourceRole varchar(15),@rows nvarchar(max),
  @scopes nvarchar(max),@rowCount int,@scopeCount int,@freshnessMinutes int',
  ${stampArgs},@sourceRole='erp-customers',@rows=@catalogPayload,@scopes=@scopes,@rowCount=${revision.rows.length},@scopeCount=0,@freshnessMinutes=30;
IF (SELECT COUNT(*) FROM @out)<>1 OR NOT EXISTS(SELECT 1 FROM @out WHERE result IN ('published','superseded'))
  THROW 53380,N'ERP publication not confirmed.',1;
IF EXISTS(SELECT 1 FROM @out WHERE result='published')
BEGIN
  ${auditSql(p,audit)}
END;
${clock}
${finish}
SELECT CASE WHEN result='published' THEN 1 ELSE 0 END AS published,
  CASE WHEN result='published' THEN ${revision.rows.length} ELSE NULL END AS row_count FROM @out;`,"write",payload.rows),["published","row_count"]);
        if(r.published===1 && r.row_count===revision.rows.length){rowCount=revision.rows.length;return "published";}
        if(r.published===0 && r.row_count===null) return "superseded";
        return fail();
      },
      async recordFailure(attempt){
        const r=data(await send(write+stamp(attempt)+`
INSERT @out EXEC sys.sp_executesql ${q(SQL.recordFailure)},N'${stampParams}',${stampArgs};
IF (SELECT COUNT(*) FROM @out)<>1 OR NOT EXISTS(SELECT 1 FROM @out WHERE result IN ('failed','superseded'))
  THROW 53380,N'ERP publication not confirmed.',1;
${clock}
${finish} SELECT result FROM @out;`,"write"),["result"]);
        if(r.result!=="failed" && r.result!=="superseded") return fail();
      },
    };
    const result=await io.refresh({binding:{id:p.sourceId,profileId:p.profileId,label:"QA ERP",role:"erp-customers",environment:"qa",
      state:"active",profileRevision:p.profileVersion,contractVersion:"erp_v1",issuerScope:"CO:NIT"},
      bindingRevision:p.bindingVersion,environment:"qa",matchKey:key,matchKeyVersion:p.matchKeyVersion,signal,sink,now:()=>observedAt,
      async transport(){
        const before=await readAuthorized();
        if(!isDeepStrictEqual(before,initial) || signal.aborted || Date.now()>=deadline || io.env.KEY_VAULT_URL!==p.vaultUrl) return fail();
        const password=await io.secret(before.secretRef,signal);
        const current=await readAuthorized();
        if(!password || !isDeepStrictEqual(current,before) || signal.aborted) return fail();
        return io.transport({server:before.server,port:before.port,database:before.database,username:before.username,password});
      },
    });
    return result==="published" && rowCount!==undefined ? {status:result,rowCount} : {status:result==="superseded"?"superseded":"unavailable"};
  }catch{return {status:"unavailable"};}
  finally{key?.fill(0);evidence?.keyVerifier.fill(0);evidence?.vaultSecretVersion.fill(0);}
}

if(require.main===module) void readQaCatalogOperatorInput(true)
  .then(({input,broker,auditSource,catalogPayloadSupported})=>publishCatalogQaErp(input,{broker,auditSource,catalogPayloadSupported,secret:getSecret,env:process.env,
    transport:createCatalogExternalSqlTransport,refresh:refreshCatalogCustomerSource}))
  .catch(()=>({status:"unavailable"})).then(out=>{
    if(out.status!=="published") process.exitCode=1;
    process.stdout.write(JSON.stringify(out)+"\n");
  });
