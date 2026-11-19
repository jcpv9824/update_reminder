import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveCertifiedCatalogActiveUserSqlTarget } from "../lib/catalogActiveUserSqlReader";
import { REGISTER_CATALOG_REPORTING_PROFILE_SQL } from "../lib/catalogReportingProfileRegistrationSqlRepository";
import { READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL } from "../lib/catalogReportingProfileEnrollmentSqlReader";
import { enrollCatalogQaReportingProfile } from "../tools/enrollCatalogQaReportingProfile";
import { pinnedQaPhysicalTargetAuditSql } from "../tools/registerCatalogQaPhysicalSqlTarget";

const f=vi.hoisted(() => ({ secret:vi.fn(),probe:vi.fn(),create:vi.fn() }));
vi.mock("../lib/keyVault", () => ({ getSecret:f.secret }));
vi.mock("../lib/catalogActiveUserSqlReader", () => ({ createCatalogActiveUserSqlEnrollmentProbe:f.create }));
const date=new Date("2026-11-18T21:00:00.000Z");
const id=(n:number) => `72000000-0000-0000-0000-00000000000${n}`;
const approved={ environment:"qa",actorId:"fixture-authorized-operator",physicalLinkId:id(1),physicalTargetId:id(2),
  reportConnectionId:"fixture-saved-report",operationalVersion:"1111111111111111",reportVersion:"2222222222222222",
  instanceId:id(3),countContract:{contract:"approved_aggregate_view_v1"},
  approvalReference:"QA-058-CERTIFIED-CALCULATION",reviewedAt:"2026-11-18T20:55:00.000Z",validUntil:"2026-11-18T22:00:00.000Z" };
const row={ portalEnvironment:"qa",actorId:approved.actorId,physicalLinkId:approved.physicalLinkId,physicalTargetId:approved.physicalTargetId,
  reportConnectionId:approved.reportConnectionId,operationalProfileVersion:`0x${approved.operationalVersion}`,
  physicalValidUntil:"UTC:2026-11-18T23:00:00.000Z",expectedIdentityFingerprint:"0x"+"aa".repeat(32),profileVersion:`0x${approved.reportVersion}`,
  serverHost:"Qa-Sql.Example.test",serverPort:1433,databaseName:"Synthetic",username:"fixture_user",passwordSecretName:"fixture-ref" };
const registry=JSON.stringify([{environment:"qa",host:row.serverHost,port:row.serverPort,instanceId:approved.instanceId}]);
const result={status:"registered",reportingProfileId:id(4)};
const auditSource=()=>readFile(new URL("../lib/auditSqlWriter.ts",import.meta.url),"utf8");
const io=()=>{
  const broker=vi.fn(async (_sql:string,mode:"read"|"write"):Promise<unknown> => mode==="read"?row:result);
  return {broker,auditSource};
};
const text=(s:string)=>Buffer.from(s,"utf16le").toString("hex");
beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(date); vi.stubEnv("PORTAL_CATALOG_SQL_INSTANCE_ROUTES",registry); vi.resetAllMocks();
  f.secret.mockResolvedValue("fixture-password");
  f.probe.mockResolvedValue({databaseGuid:id(5)});
  f.create.mockImplementation((resolve:ResolveCertifiedCatalogActiveUserSqlTarget)=>
    async (reference:Parameters<ResolveCertifiedCatalogActiveUserSqlTarget>[0],signal:AbortSignal)=>{
      const certified=await resolve(reference,signal);
      if (!certified) throw new Error("fixture rejected");
      return f.probe(certified);
    });
});
afterEach(()=>{ vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("QA broker enrollment and profile registration",()=>{
  it.each([
    {contract:"approved_aggregate_view_v1"},
    {contract:"certified_usuarios_v1",population:"all_rows",activeColumn:"sc_activo",storage:"text",activeValue:"S ",inactiveValue:"N"},
    {contract:"certified_usuarios_v1",population:"all_rows",activeColumn:"sc_activo",storage:"bit",activeValue:1},
  ])("uses the common guarded probe and one atomic writer for the approved contract (%#)",async countContract=>{
    const transport=io();
    expect(await enrollCatalogQaReportingProfile({...approved,countContract},transport)).toEqual(result);
    expect(transport.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read","read","read","write"]);
    expect(transport.broker.mock.invocationCallOrder[1]).toBeLessThan(f.secret.mock.invocationCallOrder[0]);
    expect(transport.broker.mock.invocationCallOrder[2]).toBeLessThan(f.probe.mock.invocationCallOrder[0]);
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      evidence:countContract,identity:{instanceId:approved.instanceId,expectedFingerprint:Buffer.alloc(32,0xaa)},
      connection:{server:row.serverHost,port:row.serverPort,database:row.databaseName,username:row.username,password:"fixture-password"},
    }));
    const sql=transport.broker.mock.calls.at(-1)![0];
    const audit=pinnedQaPhysicalTargetAuditSql(await auditSource()).replaceAll("'","''");
    const writeAnchors=["BEGIN TRANSACTION","INSERT @snapshot EXEC","EXCEPT","EXEC settings.enroll_catalog_sql_target_instance_internal",
      "INSERT @saved EXEC",audit,"IF XACT_STATE()<>1","COMMIT TRANSACTION","ROLLBACK TRANSACTION"];
    expect(writeAnchors.every(anchor=>sql.includes(anchor))).toBe(true);
    expect(writeAnchors.map(anchor=>sql.indexOf(anchor))).toEqual(writeAnchors.map(anchor=>sql.indexOf(anchor)).sort((a,b)=>a-b));
    expect(sql).toContain(REGISTER_CATALOG_REPORTING_PROFILE_SQL.replaceAll("'","''"));
    expect(sql).toContain(READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL.replaceAll("'","''"));
    expect(sql).toContain("@operationUntil datetime2(3)=N'2026-11-18T21:00:45.000'");
    expect(sql).toContain("@enrollmentUntil datetime2(3)=N'2026-11-18T21:05:00.000'");
    expect(sql).toContain("@reportingUntil datetime2(3)=N'2026-11-18T22:00:00.000'");
    expect(sql).toContain("@operationUntil<=SYSUTCDATETIME()");
    expect(sql).toContain(text(JSON.stringify({approvalReference:approved.approvalReference})));
    expect(sql).toContain(text(countContract.contract));
    const proof1=sql.match(/@enrollmentProof uniqueidentifier=N'([^']+)'/)?.[1];
    const proof2=sql.match(/@reportingProof uniqueidentifier=N'([^']+)'/)?.[1];
    expect(proof1).toBeTruthy();expect(proof2).toBeTruthy();expect(proof1).not.toBe(proof2);
    expect(sql).not.toContain("fixture-password");
  });

  it.each([
    {...approved,environment:"production"}, {...approved,validUntil:date.toISOString()},
    {...approved,password:"not an input"}, {...approved,host:"not an input"}, {...approved,databaseGuid:id(5)},
    {...approved,countContract:{contract:"approved_aggregate_view_v1",bad:"unsupported"}},
  ])("rejects malformed approval before any request (%#)",async input=>{
    const transport=io();
    expect(await enrollCatalogQaReportingProfile(input,transport)).toEqual({status:"unavailable"});
    expect(transport.broker).not.toHaveBeenCalled();expect(f.secret).not.toHaveBeenCalled();
  });

  it.each(["authority","changed profile","expired link","wrong approved instance"])("does not read credentials when %s is not current",async problem=>{
    const transport=io();
    let input=approved;
    if (problem==="authority") transport.broker.mockRejectedValueOnce(new Error("fixture unauthorized"));
    if (problem==="changed profile") transport.broker.mockResolvedValueOnce({...row,profileVersion:"0x"+"99".repeat(8)});
    if (problem==="expired link") transport.broker.mockResolvedValueOnce({...row,physicalValidUntil:"UTC:"+date.toISOString()});
    if (problem==="wrong approved instance") input={...approved,instanceId:id(9)};
    expect(await enrollCatalogQaReportingProfile(input,transport)).toEqual({status:"unavailable"});
    expect(f.secret).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
  });

  it("round-trips exact millisecond precision through the tagged broker wire and rejects coerced ISO strings",async()=>{
    const precise={...row,physicalValidUntil:"UTC:2026-11-18T23:00:00.100Z"};
    const transport=io();
    transport.broker.mockImplementation(async (_statement,mode)=>mode==="read"?precise:result);
    expect(await enrollCatalogQaReportingProfile(approved,transport)).toEqual(result);
    expect(transport.broker.mock.calls[0][0]).toContain("'UTC:'+CONVERT(char(19),physicalValidUntil,126)");
    expect(transport.broker.mock.calls.at(-1)?.[0]).toContain("@physicalUntil datetime2(3)=N'2026-11-18T23:00:00.100'");
    for (const physicalValidUntil of ["2026-11-18T23:00:00Z","2026-11-18T23:00:00.1Z","UTC:2026-11-18T23:00:00.1Z"]) {
      const malformed=io();
      malformed.broker.mockResolvedValueOnce({...row,physicalValidUntil});
      expect(await enrollCatalogQaReportingProfile(approved,malformed)).toEqual({status:"unavailable"});
      expect(malformed.broker).toHaveBeenCalledOnce();
    }
    expect(f.secret).toHaveBeenCalledOnce();
  });

  it("does not dial when the exact route or authorization changes during Vault",async()=>{
    const transport=io();
    transport.broker.mockResolvedValueOnce(row).mockResolvedValueOnce(row).mockResolvedValueOnce({...row,databaseName:"Drift"});
    expect(await enrollCatalogQaReportingProfile(approved,transport)).toEqual({status:"unavailable"});
    expect(transport.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read","read","read"]);
    expect(f.probe).not.toHaveBeenCalled();
  });

  it.each(["bad count","clock","037 conflict/audit failure","ambiguous write timeout"])("does not retry or report false success for %s",async problem=>{
    const transport=io();
    if (problem==="bad count") f.probe.mockRejectedValueOnce(new Error("fixture count failed"));
    if (problem==="clock") f.probe.mockImplementationOnce(()=>{vi.setSystemTime(date.getTime()+45_000);return {databaseGuid:id(5)};});
    if (problem.includes("failure") || problem.includes("timeout")) {
      transport.broker.mockResolvedValueOnce(row).mockResolvedValueOnce(row).mockResolvedValueOnce(row)
        .mockRejectedValueOnce(new Error("fixture private broker failure"));
    }
    expect(await enrollCatalogQaReportingProfile(approved,transport)).toEqual({status:"unavailable"});
    expect(transport.broker.mock.calls.filter(([,mode])=>mode==="write")).toHaveLength(problem==="bad count" || problem==="clock"?0:1);
  });

  it.runIf(!!process.env.PORTAL_QA_SCRIPT_DOM_PATH)("parses all fixed and framed statements offline with SQL Server 2019 grammar",async()=>{
    const transport=io();
    expect(await enrollCatalogQaReportingProfile(approved,transport)).toEqual(result);
    const command=String.raw`
$ErrorActionPreference='Stop'; Add-Type -Path $env:PORTAL_QA_SCRIPT_DOM_PATH
$parser=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
foreach ($sql in ([Console]::In.ReadToEnd() | ConvertFrom-Json)) {
  $err=$null; $reader=[IO.StringReader]::new($sql)
  try { $null=$parser.Parse($reader,[ref]$err) } finally { $reader.Dispose() }
  if (@($err).Count) { throw ("SQL grammar line {0} col {1}" -f $err[0].Line,$err[0].Column) }
}
`;
    const parsed=spawnSync("pwsh",["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",timeout:40_000,
      input:JSON.stringify([...transport.broker.mock.calls.map(([sql])=>sql),READ_CATALOG_REPORTING_PROFILE_ENROLLMENT_SQL,
        REGISTER_CATALOG_REPORTING_PROFILE_SQL,pinnedQaPhysicalTargetAuditSql(await auditSource())])});
    expect(parsed.status,parsed.error?.message??parsed.stderr).toBe(0);
  },45_000);
});
