import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { catalogDocumentNumberToken,type refreshCatalogCustomerSource } from "../lib/catalogCustomerRefresh";
import { catalogManualPublicationSqlBatches as SQL } from "../lib/catalogCustomerSnapshotPublishSqlRepository";
import { publishCatalogQaErp } from "../tools/publishCatalogQaErp";
import { pinnedQaPhysicalTargetAuditSql } from "../tools/registerCatalogQaPhysicalSqlTarget";

const now=new Date("2026-11-19T13:00:00.000Z");
const rawNit="synthetic-document-not-for-wire";
const key="ab".repeat(32);
const approved={environment:"qa",issuerScope:"CO:NIT",actorId:"fixture-actor",
  sourceId:"74000000-0000-0000-0000-000000000001",profileId:"fixture-saved",bindingVersion:"12".repeat(8),
  profileVersion:"34".repeat(8),vaultUrl:"https://fixture-qa-vault.vault.azure.net",
  matchKeyVersion:3,matchKeySecretRef:"fixture-match-ref",matchKeySecretVersion:"21".repeat(16),validUntil:"2026-11-19T14:00:00.000Z"};
const env={PORTAL_SAG_ENVIRONMENT:"qa",KEY_VAULT_URL:approved.vaultUrl,PORTAL_CATALOG_MATCH_KEY_VERSION:"3",
  PORTAL_CATALOG_MATCH_KEY_SECRET_NAME:approved.matchKeySecretRef,PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION:approved.matchKeySecretVersion};
const profile={server:"erp.example.test",port:1433,database:"Fixture",username:"fixture_viewer",secretRef:"fixture-source-ref"};
const auditSource=()=>readFile(new URL("../lib/auditSqlWriter.ts",import.meta.url),"utf8");
type Refresh=typeof refreshCatalogCustomerSource;
async function scenario(args:Parameters<Refresh>[0],mode:"success"|"failure"|"oversize"="success"):ReturnType<Refresh>{
  const attemptOrdinal=await args.sink.reserveAttempt();
  if(typeof args.transport==="function") await args.transport();
  const witness={environment:"qa",sourceId:approved.sourceId,profileRevision:approved.profileVersion,
    bindingRevision:approved.bindingVersion,attemptOrdinal,matchKeyVersion:approved.matchKeyVersion,observedAt:args.now!()} as const;
  if(mode==="failure"){await args.sink.recordFailure(witness);return "unavailable";}
  const n=mode==="oversize"?9500:1;
  return args.sink.publish({...witness,role:"erp-customers",completeScopes:[],rows:Array.from({length:n},(_,sourceRecordId)=>({
    sourceRecordId,issuerScope:"CO:NIT",matchToken:catalogDocumentNumberToken(args.matchKey,"qa",rawNit),
    name:mode==="oversize"?"a".repeat(512):"Fixture O'Neil",activeCode:"S",
  }))});
}
function io(){
  const broker=vi.fn(async (sql:string,mode:"read"|"write",payload?:string):Promise<unknown>=>{
    if(mode==="read")return profile;
    if(sql.includes("SELECT attemptOrdinal FROM @reserved"))return {attemptOrdinal:"17"};
    return payload===undefined?{result:"failed"}:{published:1,row_count:1};
  });
  return {broker,catalogPayloadSupported:true,env:{...env},auditSource,secret:vi.fn(async(ref:string)=>ref===approved.matchKeySecretRef?key:"fixture-remote-password"),
    transport:vi.fn(()=>({withConsistentRead:vi.fn()})),refresh:vi.fn<Refresh>(args=>scenario(args))};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());

describe("supervised QA ERP v1 publication",()=>{
  it("uses exact manual SQL, sends HMAC not NIT in a separate typed payload and emits only status and count",async()=>{
    const f=io();
    expect(await publishCatalogQaErp(approved,f)).toEqual({status:"published",rowCount:1});
    expect(f.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read","write","read","read","write"]);
    expect(f.broker.mock.invocationCallOrder[0]).toBeLessThan(f.secret.mock.invocationCallOrder[0]);
    expect(f.broker.mock.invocationCallOrder[2]).toBeLessThan(f.secret.mock.invocationCallOrder[1]);
    expect(f.broker.mock.invocationCallOrder[3]).toBeLessThan(f.transport.mock.invocationCallOrder[0]);
    expect(f.secret).toHaveBeenNthCalledWith(1,approved.matchKeySecretRef,expect.any(AbortSignal),approved.matchKeySecretVersion);
    const reserve=f.broker.mock.calls[1][0];
    const [published,mode,payload]=f.broker.mock.calls.at(-1)!;
    expect(reserve).toContain(SQL.authorize.replaceAll("'","''"));
    expect(reserve).toContain(SQL.reserve.replaceAll("'","''"));
    expect(published).toContain(SQL.publish.replaceAll("'","''"));
    expect(published).toContain(pinnedQaPhysicalTargetAuditSql(await auditSource()).replaceAll("'","''"));
    expect(mode).toBe("write");
    expect(published.startsWith("/* portal-sag-catalog-qa-payload:v1 */")).toBe(true);
    expect(published).toContain("@rows=@catalogPayload");
    expect(published).not.toContain("Fixture O");
    const token=catalogDocumentNumberToken(Buffer.from(key,"hex"),"qa",rawNit)?.toString("hex");
    expect(published).not.toContain(token);
    expect(JSON.parse(payload!)).toEqual([{sourceRecordId:0,issuer:"CO",documentType:"NIT",token,
      officialName:"Fixture O'Neil",activeCode:"S",allocationId:expect.any(String)}]);
    expect(payload).not.toContain(rawNit);expect(payload).not.toContain(key);expect(payload).not.toContain("fixture-remote-password");
    expect(f.broker.mock.calls.slice(0,-1).every(call=>call[2]===undefined)).toBe(true);
    expect(published).toContain("b.issuer_scope COLLATE Latin1_General_100_BIN2=N'CO:NIT'");
    expect(published).toContain("@deadline<=SYSUTCDATETIME()");
    expect(published).not.toContain(rawNit);expect(published).not.toContain(key);expect(published).not.toContain("fixture-remote-password");
    expect(f.refresh.mock.calls[0][0].matchKey).toEqual(Buffer.alloc(32));
  });
  it("refuses a legacy broker before any authorization read, key fetch or reserve",async()=>{
    const f=io();
    f.catalogPayloadSupported=false;
    expect(await publishCatalogQaErp(approved,f)).toEqual({status:"unavailable"});
    expect(f.broker).not.toHaveBeenCalled();expect(f.secret).not.toHaveBeenCalled();expect(f.refresh).not.toHaveBeenCalled();
  });
  it.each([{published:0,row_count:null},{published:0,row_count:0},{published:1,row_count:99},{result:"published"}])(
    "requires an exact typed payload receipt and never falls back to inline SQL (%#)",async receipt=>{
      const f=io();
      f.broker.mockResolvedValueOnce(profile).mockResolvedValueOnce({attemptOrdinal:"17"})
        .mockResolvedValueOnce(profile).mockResolvedValueOnce(profile).mockResolvedValueOnce(receipt);
      const status="published" in receipt && receipt.published===0 && receipt.row_count===null?"superseded":"unavailable";
      expect(await publishCatalogQaErp(approved,f)).toEqual({status});
      const writes=f.broker.mock.calls.filter(([,mode])=>mode==="write");
      expect(writes).toHaveLength(2);expect(writes[1][2]).toBeDefined();
    });
  it.each([{...approved,environment:"production"},{...approved,issuerScope:"MX:RFC"},{...approved,profileVersion:"f".repeat(15)+"\n"},
    {...approved,matchKeyVersion:4},{...approved,validUntil:now.toISOString()},{...approved,host:"not permitted"}])(
    "does not call the broker with an unapproved scope (%#)",async input=>{
      const f=io();expect(await publishCatalogQaErp(input,f)).toEqual({status:"unavailable"});expect(f.broker).not.toHaveBeenCalled();
    });
  it("checks enrolled evidence in SQL before opening the remote profile",async()=>{
    const f=io();
    f.broker.mockResolvedValueOnce(profile).mockRejectedValueOnce(new Error("fixture enrollment mismatch"));
    expect(await publishCatalogQaErp(approved,f)).toEqual({status:"unavailable"});
    expect(f.secret).toHaveBeenCalledOnce();expect(f.transport).not.toHaveBeenCalled();
  });
  it("checks route both before and after the Vault read and refuses stale evidence",async()=>{
    const f=io();
    f.broker.mockResolvedValueOnce(profile).mockResolvedValueOnce({attemptOrdinal:"17"}).mockResolvedValueOnce(profile)
      .mockResolvedValueOnce({...profile,username:"unexpected"});
    expect(await publishCatalogQaErp(approved,f)).toEqual({status:"unavailable"});
    expect(f.transport).not.toHaveBeenCalled();expect(f.broker.mock.calls.map(([,mode])=>mode)).toEqual(["read","write","read","read"]);
  });
  it("records the exact existing manual failure without writing a replacement or retrying",async()=>{
    const f=io();f.refresh.mockImplementation(args=>scenario(args,"failure"));
    expect(await publishCatalogQaErp(approved,f)).toEqual({status:"unavailable"});
    const failure=f.broker.mock.calls.at(-1)![0];
    expect(failure).toContain(SQL.recordFailure.replaceAll("'","''"));
    expect(failure).not.toContain("INSERT audit.audit_logs");
    expect(f.broker.mock.calls.filter(([,mode])=>mode==="write")).toHaveLength(2);
  });
  it("rejects a snapshot above the broker cap instead of chunking or retrying",async()=>{
    const f=io();f.refresh.mockImplementation(args=>scenario(args,"oversize"));
    expect(await publishCatalogQaErp(approved,f)).toEqual({status:"unavailable"});
    expect(f.broker.mock.calls.filter(([,mode])=>mode==="write")).toHaveLength(1);
  },15_000);
  it.runIf(!!process.env.PORTAL_QA_SCRIPT_DOM_PATH)("parses broker batches and existing nested SQL offline",async()=>{
    const f=io();expect(await publishCatalogQaErp(approved,f)).toEqual({status:"published",rowCount:1});
    const command=String.raw`
$ErrorActionPreference='Stop'; Add-Type -Path $env:PORTAL_QA_SCRIPT_DOM_PATH
$p=[Microsoft.SqlServer.TransactSql.ScriptDom.TSql150Parser]::new($true)
foreach($sql in ([Console]::In.ReadToEnd()|ConvertFrom-Json)){
  $e=$null;$r=[IO.StringReader]::new($sql)
  try{$null=$p.Parse($r,[ref]$e)}finally{$r.Dispose()}
  if(@($e).Count){ throw ("SQL grammar line {0} col {1}" -f $e[0].Line,$e[0].Column) }
}
`;
    const parsed=spawnSync("pwsh",["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",timeout:40_000,
      input:JSON.stringify([...f.broker.mock.calls.map(([sql])=>sql),...Object.values(SQL),pinnedQaPhysicalTargetAuditSql(await auditSource())])});
    expect(parsed.status,parsed.error?.message??parsed.stderr).toBe(0);
  },45_000);
});
