import { createHash,timingSafeEqual } from "node:crypto";
import { readFile,realpath,stat } from "node:fs/promises";
import { isAbsolute,relative,resolve,sep } from "node:path";
import { parseEnv } from "node:util";
import { parseCatalogOriginConnectionAddress } from "../lib/catalogOriginConnectionAddress";
import { createCatalogExternalSqlTransport } from "../lib/catalogExternalSqlTransport";
import { verifyCatalogExternalSource,verifyCatalogSagDiscoveryV2Targets } from "../lib/catalogExternalSourceQueries";
import { CATALOG_ERP_ISSUER_SCOPE } from "../lib/catalogSourceBindingsSqlRepository";
import { getSecret } from "../lib/keyVault";
import { pinnedQaPhysicalTargetAuditSql,readQaCatalogOperatorInput } from "./registerCatalogQaPhysicalSqlTarget";

// Internal QA operator only. Verify independent scope/actor/QA Vault approval
// before --apply. Files and approved reference names are inputs, not authority.
const fail=():never=>{throw new Error("catalog_qa_origin_onboarding_not_confirmed");};
const qs=(s:string)=>`N'${s.replaceAll("'","''")}'`;
const sqlText=(s:string|null)=>s===null?"NULL":`CONVERT(nvarchar(max),0x${Buffer.from(s,"utf16le").toString("hex")})`;
const utc=(s:unknown)=>typeof s==="string" && s.length===24 && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s ? Date.parse(s):NaN;
const opaque=(s:unknown,max:number):s is string=>typeof s==="string" && s.length>0 && s.length<=max && s===s.trim() && !/\p{C}/u.test(s);
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/;
function data<const K extends string>(v:unknown,keys:readonly K[]):Record<K,unknown>{
  if (!v || typeof v!=="object" || Reflect.ownKeys(v).length!==keys.length || ![Object.prototype,null].includes(Object.getPrototypeOf(v))) return fail();
  const out=Object.create(null) as Record<K,unknown>;
  for(const key of keys){
    const d=Object.getOwnPropertyDescriptor(v,key);
    if(!d?.enumerable || !Object.hasOwn(d,"value")) return fail();
    out[key]=d.value;
  }
  return out;
}
function origin(v:unknown){
  const {profileId,label,envFile,vaultReference,routeSha256}=data(v,["profileId","label","envFile","vaultReference","routeSha256"]);
  if(typeof profileId!=="string" || !profileId.startsWith("external_sql_") || !uuid.test(profileId.slice(13)) ||
    /^external_sql_0{8}(?:-0{4}){3}-0{12}$/.test(profileId) || !opaque(label,150) || !opaque(envFile,500) || !isAbsolute(envFile) ||
    typeof vaultReference!=="string" || !/^[A-Za-z0-9-]{1,127}(?![\s\S])/.test(vaultReference) ||
    typeof routeSha256!=="string" || !/^[0-9a-f]{64}(?![\s\S])/.test(routeSha256)) return fail();
  return {profileId,label,envFile,vaultReference,routeSha256};
}
function approval(v:unknown,configuredVault:string|undefined){
  const {environment,actorId,vaultUrl,approvalReference,reviewedAt,validUntil,issuerScope,erp,sag}=data(v,[
    "environment","actorId","vaultUrl","approvalReference","reviewedAt","validUntil","issuerScope","erp","sag",
  ]);
  const since=utc(reviewedAt),until=utc(validUntil);
  if(environment!=="qa" || !opaque(actorId,150) || typeof vaultUrl!=="string" || vaultUrl!==configuredVault ||
    !/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/?(?![\s\S])/.test(vaultUrl) ||
    typeof issuerScope!=="string" || issuerScope!==issuerScope.trim() || !CATALOG_ERP_ISSUER_SCOPE.test(issuerScope) ||
    typeof approvalReference!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?![\s\S])/.test(approvalReference) ||
    !Number.isFinite(since) || !Number.isFinite(until) || since>Date.now() || until<=Date.now() || until-since>86_400_000) return fail();
  const e=origin(erp),s=origin(sag);
  if(e.profileId===s.profileId || e.vaultReference.toLowerCase()===s.vaultReference.toLowerCase() ||
    e.envFile.toLowerCase()===s.envFile.toLowerCase() || e.routeSha256===s.routeSha256) return fail();
  return {actorId,vaultUrl,approvalReference,until,issuerScope,erp:e,sag:s};
}
function sameSecret(a:string,b:string){
  const left=Buffer.from(a),right=Buffer.from(b);
  try{return left.length===right.length && timingSafeEqual(left,right);}
  finally{left.fill(0);right.fill(0);}
}
function exactLiteral(source:string,table:"external_database_connections"|"catalog_source_bindings",hash:string){
  const fence=String.fromCharCode(96);
  const pattern=new RegExp(fence+"(\\s*INSERT settings\\."+table+"\\b[^"+fence+"]+)"+fence,"g");
  const matches=[...source.replaceAll("\r","").matchAll(pattern)];
  const sql=matches[0]?.[1];
  if(matches.length!==1 || !sql || sql.includes("${") || createHash("sha256").update(sql).digest("hex")!==hash) return fail();
  return sql;
}
const guard=`
SET NOCOUNT ON;
SET XACT_ABORT ON;
IF @@TRANCOUNT<>0 OR (@@OPTIONS & 2)<>0 OR DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST' OR DATALENGTH(DB_NAME())<>34
  OR CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
  OR NOT EXISTS(SELECT 1 FROM sys.databases WHERE database_id=DB_ID() AND compatibility_level=150)
  THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
`;
const authorized=`
IF @deadline<=SYSUTCDATETIME() OR NOT EXISTS(
  SELECT 1 FROM security.users u WITH(HOLDLOCK)
  JOIN security.user_roles ur WITH(HOLDLOCK) ON ur.user_key=u.user_key
  JOIN security.roles r WITH(HOLDLOCK) ON r.role_id=ur.role_id AND r.active=1 AND r.system_role=1 AND r.protected_role=1
  WHERE u.active=1 AND u.source_id COLLATE Latin1_General_100_BIN2=@actor COLLATE Latin1_General_100_BIN2
    AND DATALENGTH(u.source_id)=DATALENGTH(@actor)
    AND r.role_id COLLATE Latin1_General_100_BIN2=N'super_admin' AND DATALENGTH(r.role_id)=22
    AND 4=(SELECT COUNT(*) FROM (VALUES(N'configuration.integrations.view'),(N'configuration.integrations.create_database'),
      (N'configuration.integrations.test_database'),(N'configuration.integrations.edit_database')) v(k)
      JOIN security.permissions p WITH(HOLDLOCK) ON p.permission_key COLLATE Latin1_General_100_BIN2=v.k
        AND DATALENGTH(p.permission_key)=DATALENGTH(v.k) AND p.active=1
      JOIN security.role_permissions rp WITH(HOLDLOCK) ON rp.role_id=r.role_id AND rp.permission_key=p.permission_key))
  THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
`;
function transaction(actor:string,deadline:number,body:string){
  return `${guard}
DECLARE @actor nvarchar(150)=${sqlText(actor)},@deadline datetime2(3)=${qs(new Date(deadline).toISOString().slice(0,-1))};
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
BEGIN TRY
  BEGIN TRANSACTION;
  ${authorized}
  ${body}
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
  THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
END CATCH;`;
}
type Origin=ReturnType<typeof origin>;
type Route={server:string;port:number;database:string;username:string};
type Broker=Awaited<ReturnType<typeof readQaCatalogOperatorInput>>["broker"];
type Io={broker:Broker;readProfile:(path:string)=>Promise<{path:string;content:string}>;
  secret:typeof getSecret;verify:(route:Route,password:string,contract:"erp_v1"|"sag_admin_v2",signal:AbortSignal)=>Promise<unknown>;
  vaultUrl:()=>string|undefined;sources:()=>Promise<{connections:string;drafts:string;audit:string}>};

async function checkOrigin(approved:Origin,contract:"erp_v1"|"sag_admin_v2",io:Io,signal:AbortSignal,vaultUrl:string){
  const file=await io.readProfile(approved.envFile);
  if(signal.aborted || typeof file.content!=="string" || file.content.length>65_536) return fail();
  const local=parseEnv(file.content);
  const address=parseCatalogOriginConnectionAddress(local.SOURCE_SQL_SERVER,local.SOURCE_SQL_PORT);
  if(!address || address.expectedInstanceName || (!local.SOURCE_SQL_PORT?.trim() && !/,\s*\d{1,5}\s*$/.test(local.SOURCE_SQL_SERVER??"")) ||
    !opaque(local.SOURCE_SQL_DATABASE,128) || !opaque(local.SOURCE_SQL_USER,128) ||
    typeof local.SOURCE_SQL_PASSWORD!=="string" || local.SOURCE_SQL_PASSWORD.length<1 || local.SOURCE_SQL_PASSWORD.length>512) return fail();
  const route={server:address.server,port:address.port,database:local.SOURCE_SQL_DATABASE,username:local.SOURCE_SQL_USER};
  const hash=createHash("sha256").update(JSON.stringify(["portal-sag:qa-origin-route:v1",
    route.server,route.port,route.database,route.username])).digest("hex");
  if(hash!==approved.routeSha256 || signal.aborted || io.vaultUrl()!==vaultUrl) return fail();
  const password=await io.secret(approved.vaultReference,signal);
  if(typeof password!=="string" || !sameSecret(local.SOURCE_SQL_PASSWORD,password) || signal.aborted) return fail();
  if(await io.verify(route,password,contract,signal)!=="verified" || signal.aborted) return fail();
  return {approved,route,path:file.path};
}

function writer(p:ReturnType<typeof approval>,pair:readonly Awaited<ReturnType<typeof checkOrigin>>[],
  insertConnection:string,insertDraft:string,audit:string){
  const values=pair.map(({approved:a,route:r},i)=>"("+[i+1,sqlText(a.profileId),sqlText(a.label),sqlText(r.server),r.port,
    sqlText(r.database),sqlText(r.username),sqlText(a.vaultReference)].join(",")+")").join(",");
  const receipt=sqlText(JSON.stringify({approvalReference:p.approvalReference}));
  const auditAction=(entity:string,id:string,action:string)=>`
SET @auditId=N'audit_'+LOWER(CONVERT(char(36),NEWID()));
EXEC sys.sp_executesql ${qs(audit)},N'@sourceId nvarchar(150),@entityType nvarchar(100),@entitySourceId nvarchar(260),
  @clientSourceId nvarchar(150),@clientName nvarchar(200),@domainSourceId nvarchar(150),@domainName nvarchar(500),@companyName nvarchar(240),
  @action nvarchar(160),@performedBy nvarchar(150),@performedByEmail nvarchar(254),@performedAt datetime2(3),
  @beforeJson nvarchar(max),@afterJson nvarchar(max),@metadataJson nvarchar(max),@classification varchar(20)',
  @sourceId=@auditId,@entityType=N'${entity}',@entitySourceId=${id},@clientSourceId=NULL,@clientName=NULL,@domainSourceId=NULL,
  @domainName=NULL,@companyName=NULL,@action=N'${action}',@performedBy=@actor,@performedByEmail=NULL,@performedAt=@now,
  @beforeJson=NULL,@afterJson=NULL,@metadataJson=@receipt,@classification='confidential' WITH RESULT SETS NONE;`;
  return `
DECLARE @wanted table(i int PRIMARY KEY,sourceId nvarchar(150),label nvarchar(150),host nvarchar(255),port int,
  databaseName nvarchar(128),username nvarchar(128),secretName nvarchar(127));
INSERT @wanted VALUES ${values};
DECLARE @i int=1,@now datetime2(3)=SYSUTCDATETIME(),@sourceId nvarchar(150),@label nvarchar(150),@host nvarchar(255),@port int,
  @database nvarchar(128),@username nvarchar(128),@passwordSecret nvarchar(127),@role varchar(15),@contractVersion varchar(40),
  @issuerScope nvarchar(80),@profileKey bigint,@bindingId nvarchar(36),@auditId nvarchar(150),@receipt nvarchar(max)=${receipt},
  @insertedProfiles int=0,@insertedDrafts int=0;
DECLARE @written table(written_id char(36));
WHILE @i<=2
BEGIN
  SELECT @sourceId=sourceId,@label=label,@host=host,@port=port,@database=databaseName,@username=username,@passwordSecret=secretName
  FROM @wanted WHERE i=@i;
  SET @role=CASE WHEN @i=1 THEN 'erp-customers' ELSE 'sag-admin' END;
  SET @contractVersion=CASE WHEN @i=1 THEN 'erp_v1' ELSE 'sag_admin_v2' END;
  SET @issuerScope=CASE WHEN @i=1 THEN ${sqlText(p.issuerScope)} ELSE NULL END;
  SET @profileKey=NULL;
  SELECT @profileKey=external_database_connection_key FROM settings.external_database_connections WITH(UPDLOCK,HOLDLOCK) WHERE source_id=@sourceId;
  IF @profileKey IS NULL
  BEGIN
    EXEC sys.sp_executesql ${qs(insertConnection)},N'@sourceId nvarchar(150),@displayName nvarchar(160),@purpose nvarchar(500),
      @host nvarchar(255),@port int,@database nvarchar(128),@username nvarchar(128),@passwordSecret nvarchar(127),
      @passwordConfigured bit,@active bit,@status varchar(20),@now datetime2(3),@actor nvarchar(150)',
      @sourceId=@sourceId,@displayName=@label,@purpose=NULL,@host=@host,@port=@port,@database=@database,@username=@username,
      @passwordSecret=@passwordSecret,@passwordConfigured=1,@active=1,@status='active',@now=@now,@actor=@actor WITH RESULT SETS NONE;
    SELECT @profileKey=external_database_connection_key FROM settings.external_database_connections WITH(UPDLOCK,HOLDLOCK) WHERE source_id=@sourceId;
    IF @profileKey IS NULL THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
    SET @insertedProfiles+=1;
    ${auditAction("integration_connection","@sourceId","external_database_connection_created")}
  END;
  IF NOT EXISTS(SELECT 1 FROM settings.external_database_connections p WITH(UPDLOCK,HOLDLOCK)
    WHERE p.external_database_connection_key=@profileKey AND p.active=1
      AND p.status COLLATE Latin1_General_100_BIN2='active' AND DATALENGTH(p.status)=6
      AND p.encrypt_connection=1 AND p.password_configured=1 AND p.purpose IS NULL
      AND NOT EXISTS(SELECT CONVERT(varbinary(300),p.source_id),CONVERT(varbinary(320),p.display_name),
        CONVERT(varbinary(510),p.server_host),p.server_port,CONVERT(varbinary(256),p.database_name),
        CONVERT(varbinary(256),p.login_name),CONVERT(varbinary(254),p.password_secret_name)
        EXCEPT SELECT CONVERT(varbinary(300),@sourceId),CONVERT(varbinary(320),@label),
          CONVERT(varbinary(510),@host),@port,CONVERT(varbinary(256),@database),
          CONVERT(varbinary(256),@username),CONVERT(varbinary(254),@passwordSecret)))
    THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
  DECLARE @prior int,@exact int;
  SELECT @prior=COUNT(*),@exact=COUNT(CASE WHEN portal_environment COLLATE Latin1_General_100_BIN2='qa'
    AND DATALENGTH(portal_environment)=2 AND source_state COLLATE Latin1_General_100_BIN2='draft' AND DATALENGTH(source_state)=5
    AND validated_at IS NULL AND validated_profile_version IS NULL
    AND source_role COLLATE Latin1_General_100_BIN2=@role AND contract_version COLLATE Latin1_General_100_BIN2=@contractVersion
    AND DATALENGTH(source_role)=DATALENGTH(@role) AND DATALENGTH(contract_version)=DATALENGTH(@contractVersion)
    AND CONVERT(varbinary(300),display_name)=CONVERT(varbinary(300),@label)
    AND ((issuer_scope IS NULL AND @issuerScope IS NULL) OR CONVERT(varbinary(160),issuer_scope)=CONVERT(varbinary(160),@issuerScope))
    THEN 1 END) FROM settings.catalog_source_bindings WITH(UPDLOCK,HOLDLOCK) WHERE external_database_connection_key=@profileKey;
  IF @prior<>@exact OR @prior>1 THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
  IF @prior=0
  BEGIN
    DELETE FROM @written;
    INSERT @written EXEC sys.sp_executesql ${qs(insertDraft)},N'@label nvarchar(150),@role varchar(15),@environment varchar(10),
      @issuerScope nvarchar(80),@contractVersion varchar(40),@actorId nvarchar(150),@profileId nvarchar(150)',
      @label=@label,@role=@role,@environment='qa',@issuerScope=@issuerScope,@contractVersion=@contractVersion,@actorId=@actor,@profileId=@sourceId;
    IF (SELECT COUNT(*) FROM @written)<>1 THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
    SELECT @bindingId=LOWER(written_id) FROM @written;
    SET @insertedDrafts+=1;
    ${auditAction("catalog_source_binding","@bindingId","catalog_source_draft_created")}
  END;
  SET @i+=1;
END;
IF XACT_STATE()<>1 OR @@TRANCOUNT<>1 OR @deadline<=SYSUTCDATETIME() THROW 53180,N'QA catalog origin onboarding not confirmed.',1;
COMMIT TRANSACTION;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT 'drafts-ready' AS status,@insertedProfiles AS insertedProfiles,@insertedDrafts AS insertedDrafts;
`;
}

export async function onboardCatalogQaOrigins(input:unknown,io:Io){
  try{
    const p=approval(input,io.vaultUrl());
    const source=await io.sources();
    const insertConnection=exactLiteral(source.connections,"external_database_connections","9c7cb5e5b40a31f16332d3695c97900ba156aa9ba84b75ddf213eb0c833281ca");
    const insertDraft=exactLiteral(source.drafts,"catalog_source_bindings","d1d926a31d41226a07fce7dbaa3cdde554948eebbc3e5527e9214c2dac83dc60");
    const audit=pinnedQaPhysicalTargetAuditSql(source.audit);
    const deadline=Math.min(p.until,Date.now()+90_000);
    const initial=data(await io.broker(transaction(p.actorId,deadline,`
      ROLLBACK TRANSACTION; SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
      SELECT CONVERT(bit,1) AS authorized;`),"read"),["authorized"]);
    if(initial.authorized!==true || Date.now()>=deadline || io.vaultUrl()!==p.vaultUrl) return fail();
    const signal=AbortSignal.timeout(Math.max(0,deadline-Date.now()));
    const pair=await Promise.all([checkOrigin(p.erp,"erp_v1",io,signal,p.vaultUrl),
      checkOrigin(p.sag,"sag_admin_v2",io,signal,p.vaultUrl)]);
    if(pair[0].path.toLowerCase()===pair[1].path.toLowerCase() || signal.aborted || Date.now()>=deadline ||
      io.vaultUrl()!==p.vaultUrl) return fail();
    const result=data(await io.broker(transaction(p.actorId,deadline,writer(p,pair,insertConnection,insertDraft,audit)),"write"),
      ["status","insertedProfiles","insertedDrafts"]);
    if(result.status!=="drafts-ready" || ![0,1,2].includes(result.insertedProfiles as number) ||
      ![0,1,2].includes(result.insertedDrafts as number)) return fail();
    return {status:result.status,insertedProfiles:result.insertedProfiles as number,insertedDrafts:result.insertedDrafts as number};
  }catch{return {status:"unavailable"} as const;}
}

export async function readExternalQaOriginProfile(file:string,repository:string){
  const [path,root]=await Promise.all([realpath(file),realpath(repository)]);
  const local=relative(root,path);
  if(local!== ".." && !local.startsWith(".."+sep) && !isAbsolute(local)) return fail();
  const info=await stat(path);
  if(!info.isFile() || info.size<1 || info.size>65_536) return fail();
  return {path,content:await readFile(path,"utf8")};
}

async function main(){
  const {input,broker,auditSource}=await readQaCatalogOperatorInput();
  const root=resolve(__dirname,"../../../..");
  return onboardCatalogQaOrigins(input,{
    broker,readProfile:path=>readExternalQaOriginProfile(path,root),secret:getSecret,vaultUrl:()=>process.env.KEY_VAULT_URL,
    async verify(route,password,contract,signal){
      const transport=createCatalogExternalSqlTransport({...route,password});
      return contract==="erp_v1" ? verifyCatalogExternalSource(transport,contract,signal) : verifyCatalogSagDiscoveryV2Targets(transport,{signal});
    },
    async sources(){return {
      connections:await readFile(resolve(root,"api/src/lib/integrationConnectionsSqlRepository.ts"),"utf8"),
      drafts:await readFile(resolve(root,"api/src/lib/catalogSourceBindingsSqlRepository.ts"),"utf8"),audit:await auditSource(),
    };},
  });
}
if(require.main===module) void main().catch(()=>({status:"unavailable"})).then(out=>{
  if(out.status==="unavailable") process.exitCode=1;
  process.stdout.write(JSON.stringify(out)+"\n");
});
