import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { onboardCatalogQaOrigins,readExternalQaOriginProfile } from "../tools/onboardCatalogQaOrigins";

const at=new Date("2026-11-18T22:00:00.000Z");
const vaultUrl="https://fixture-qa-vault.vault.azure.net";
const route=(n:number)=>({server:`sql${n}.example.test`,port:1433+n,database:`Fixture${n}`,username:`fixture${n}_readonly`});
const file=(n:number)=>resolve(__dirname,`../../../../../private-operator-${n}.env`);
const digest=(n:number)=>{const r=route(n); return createHash("sha256").update(JSON.stringify(["portal-sag:qa-origin-route:v1",
  r.server,r.port,r.database,r.username])).digest("hex");};
const origin=(n:number)=>({profileId:`external_sql_73000000-0000-0000-0000-00000000000${n}`,label:`QA synthetic ${n}`,envFile:file(n),
  vaultReference:`fixture-ref-${n}`,routeSha256:digest(n)});
const approval={environment:"qa",actorId:"fixture-operator",vaultUrl,approvalReference:"QA-ORIGINS-APPROVED-FIXTURE",
  reviewedAt:"2026-11-18T21:55:00.000Z",validUntil:"2026-11-18T23:00:00.000Z",issuerScope:"CO:NIT",erp:origin(1),sag:origin(2)};
const env=(n:number,password=`fixture-local-secret-${n}`)=>{const r=route(n);return `SOURCE_SQL_SERVER=${r.server},${r.port}
SOURCE_SQL_DATABASE=${r.database}
SOURCE_SQL_USER=${r.username}
SOURCE_SQL_PASSWORD="${password}"`;};
const sources=async()=>({
  connections:await readFile(new URL("../lib/integrationConnectionsSqlRepository.ts",import.meta.url),"utf8"),
  drafts:await readFile(new URL("../lib/catalogSourceBindingsSqlRepository.ts",import.meta.url),"utf8"),
  audit:await readFile(new URL("../lib/auditSqlWriter.ts",import.meta.url),"utf8"),
});
const ready={status:"drafts-ready",insertedProfiles:2,insertedDrafts:2};
const fixture=()=>{
  const broker=vi.fn(async (_sql:string,mode:"read"|"write"):Promise<unknown>=>mode==="read"?{authorized:true}:ready);
  return {broker,sources,vaultUrl:vi.fn(()=>vaultUrl),readProfile:vi.fn(async(path:string)=>({path,content:env(path===file(1)?1:2)})),
    secret:vi.fn(async(ref:string)=>`fixture-local-secret-${ref.endsWith("1")?1:2}`),verify:vi.fn(async()=>"verified")};
};
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(at);});
afterEach(()=>vi.useRealTimers());

describe("initial QA catalog origin onboarding",()=>{
  it("authorizes first, verifies the approved exact pair and submits one atomic insert-only audited batch",async()=>{
    const io=fixture();
    expect(await onboardCatalogQaOrigins(approval,io)).toEqual(ready);
    expect(io.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read","write"]);
    expect(io.broker.mock.invocationCallOrder[0]).toBeLessThan(io.readProfile.mock.invocationCallOrder[0]);
    expect(io.broker.mock.invocationCallOrder[0]).toBeLessThan(io.secret.mock.invocationCallOrder[0]);
    expect(io.verify).toHaveBeenCalledTimes(2);
    expect(io.verify).toHaveBeenCalledWith(route(1),"fixture-local-secret-1","erp_v1",expect.any(AbortSignal));
    expect(io.verify).toHaveBeenCalledWith(route(2),"fixture-local-secret-2","sag_admin_v2",expect.any(AbortSignal));
    const sql=io.broker.mock.calls[1][0];
    for(const part of ["DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'","configuration.integrations.create_database",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE","INSERT settings.external_database_connections","INSERT settings.catalog_source_bindings",
      "INSERT audit.audit_logs","external_database_connection_created","catalog_source_draft_created","@deadline<=SYSUTCDATETIME()",
      "COMMIT TRANSACTION","ROLLBACK TRANSACTION","source_state COLLATE Latin1_General_100_BIN2='draft'","@prior<>@exact"]) expect(sql).toContain(part);
    expect(sql).toContain("2026-11-18T22:01:30.000");
    expect(sql).not.toMatch(/fixture-local-secret|fixture-readonly|private-operator|UPDATE settings|SET source_state|GRANT /i);
  });

  it.each([
    {...approval,environment:"production"}, {...approval,vaultUrl:"https://another-qa.vault.azure.net"},
    {...approval,erp:{...approval.erp,vaultReference:approval.sag.vaultReference}}, {...approval,validUntil:at.toISOString()},
    {...approval,password:"not an input"}, {...approval,erp:{...approval.erp,envFile:"relative.env"}},
  ])("rejects unacceptable approval before any QA access (%#)",async value=>{
    const io=fixture();
    expect(await onboardCatalogQaOrigins(value,io)).toEqual({status:"unavailable"});
    expect(io.broker).not.toHaveBeenCalled();expect(io.secret).not.toHaveBeenCalled();expect(io.readProfile).not.toHaveBeenCalled();
  });

  it("does not open files or read Vault if the Portal actor is not authorized",async()=>{
    const io=fixture();
    io.broker.mockResolvedValueOnce({authorized:false});
    expect(await onboardCatalogQaOrigins(approval,io)).toEqual({status:"unavailable"});
    expect(io.readProfile).not.toHaveBeenCalled();expect(io.secret).not.toHaveBeenCalled();
  });

  it.each(["missing vault reference","different vault password","different approved route","source not read only","source unavailable"])(
    "does not write if either source has %s",async scenario=>{
      const io=fixture();
      if(scenario==="missing vault reference") io.secret.mockRejectedValueOnce(new Error("fixture-only diagnostic"));
      if(scenario==="different vault password") io.secret.mockResolvedValueOnce("fixture mismatch");
      if(scenario==="different approved route") io.readProfile.mockResolvedValueOnce({path:file(1),content:env(2)});
      if(scenario==="source not read only") io.verify.mockResolvedValueOnce("not_read_only");
      if(scenario==="source unavailable") io.verify.mockResolvedValueOnce("unavailable");
      expect(await onboardCatalogQaOrigins(approval,io)).toEqual({status:"unavailable"});
      expect(io.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read"]);
    },
  );

  it("does not write after the approval/operation deadline or after a Vault realm change",async()=>{
    const late=fixture();
    late.verify.mockImplementationOnce(async()=>{vi.setSystemTime(at.getTime()+90_000);return "verified";});
    expect(await onboardCatalogQaOrigins(approval,late)).toEqual({status:"unavailable"});
    expect(late.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read"]);
    vi.setSystemTime(at);
    const changed=fixture();
    changed.verify.mockImplementationOnce(async()=>{changed.vaultUrl.mockReturnValue("https://other-qa.vault.azure.net");return "verified";});
    expect(await onboardCatalogQaOrigins(approval,changed)).toEqual({status:"unavailable"});
    expect(changed.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read"]);
  });

  it("reports an exact replay as zero writes and never retries a conflict, second insert failure, or audit failure",async()=>{
    const replay=fixture();
    replay.broker.mockResolvedValueOnce({authorized:true}).mockResolvedValueOnce({status:"drafts-ready",insertedProfiles:0,insertedDrafts:0});
    expect(await onboardCatalogQaOrigins(approval,replay)).toEqual({status:"drafts-ready",insertedProfiles:0,insertedDrafts:0});
    for(const failure of ["fixture existing conflict","fixture second insert failed","fixture audit failed"]){
      const io=fixture();
      io.broker.mockResolvedValueOnce({authorized:true}).mockRejectedValueOnce(new Error(failure));
      expect(await onboardCatalogQaOrigins(approval,io)).toEqual({status:"unavailable"});
      expect(io.broker.mock.calls.filter(([,mode])=>mode==="write")).toHaveLength(1);
    }
  });

  it("rejects in-repository profiles before reading them and refuses changed pinned write literals",async()=>{
    await expect(readExternalQaOriginProfile(resolve(__dirname,"../../package.json"),resolve(__dirname,"../../..")))
      .rejects.toThrow(/^catalog_qa_origin_onboarding_not_confirmed$/);
    const io=fixture();
    const actual=await sources();
    expect(await onboardCatalogQaOrigins(approval,{...io,sources:async()=>({...actual,connections:"not pinned"})}))
      .toEqual({status:"unavailable"});
    expect(io.broker).not.toHaveBeenCalled();
  });

  it.runIf(!!process.env.PORTAL_QA_SCRIPT_DOM_PATH)("parses the generated batches and all nested SQL literals offline",async()=>{
    const io=fixture();
    expect(await onboardCatalogQaOrigins(approval,io)).toEqual(ready);
    const source=await sources();
    const literals=["external_database_connections","catalog_source_bindings","audit_logs"].map(table=>{
      const pattern=new RegExp(String.fromCharCode(96)+"(\\s*INSERT (?:settings|audit)\\."+table+"\\b[^"+String.fromCharCode(96)+"]+)"+String.fromCharCode(96));
      return pattern.exec(Object.values(source).find(s=>pattern.test(s))??"")?.[1];
    });
    expect(literals.every(Boolean)).toBe(true);
    const script=String.raw`
$ErrorActionPreference='Stop'; Add-Type -Path $env:PORTAL_QA_SCRIPT_DOM_PATH
$parser=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
foreach ($sql in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) {
  $err=$null; $reader=[IO.StringReader]::new($sql)
  try { $null=$parser.Parse($reader,[ref]$err) } finally { $reader.Dispose() }
  if (@($err).Count) { throw ("SQL grammar line {0} col {1}" -f $err[0].Line,$err[0].Column) }
}
`;
    const saved=spawnSync("pwsh",["-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",timeout:40_000,
      input:JSON.stringify([...io.broker.mock.calls.map(([sql])=>sql),...literals])});
    expect(saved.status,saved.error?.message??saved.stderr).toBe(0);
  },45_000);
});
