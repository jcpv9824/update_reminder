import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const filename = "073_catalog_historical_schedule_company_locations.sql";
const read = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");

describe("073 historical schedule database proof migration", () => {
  const migration = () => read(`migration/sql/${filename}`);

  it("trusts the exact approved copy boundary, not a supplied instant or present head", () => {
    const sql = migration();
    expect(sql).toContain("transaction_isolation_level=4");
    expect(sql).toContain("schedule_approval.schedule_version=s.row_version");
    expect(sql).toContain("schedule_approval.approved_at<=@asOf");
    expect(sql).toContain("copy.created_at<=@asOf");
    expect(sql).toContain("DATEADD(hour,5,CONVERT(datetime2(3),s.start_date))");
    expect(sql).toContain("pin.verified_target_id=claim.physical_target_id");
    expect(sql).not.toContain("catalog_customer_revision_heads");
    for (const alias of ["erp", "sag"]) {
      expect(sql).toContain(`event.catalog_source_key=${alias}_binding.catalog_source_key AND event.recorded_at<=@asOf`);
      expect(sql).toContain(`${alias}_head.attempt_status=''succeeded''`);
    }
  });

  it("only matches per-Company tokens after proving the complete sealed set, without leaking its values", () => {
    const sql = migration();
    expect(sql).toContain("company.customer_record_id=sag_parent.source_record_id");
    expect(sql).toContain("sag_parent.document_number_token=erp_record.document_number_token");
    expect(sql).toContain("domain_record.domain_candidate");
    expect(sql).toContain("location_seal.sealed_at BETWEEN sag_revision.sealed_at AND @asOf");
    expect(sql).toContain("required_company.revision_key=sag_revision.revision_key");
    expect(sql).toContain("submitted.company_record_id=required_company.company_record_id");
    expect(sql).toContain("location_observation.location_token=claim.location_token");
    expect(sql).toContain("COUNT(DISTINCT proof.company_record_id)=asked.claim_count");
    expect(sql).toContain("COUNT(DISTINCT CASE WHEN proof.is_match=1 THEN proof.company_record_id END)");
    expect(sql).not.toContain("sag_customer_record_id,location_token FROM @parsed");
    expect(sql).toContain("ELSE 0 END AS matchCount");
    expect(sql).not.toMatch(/server_host_port|password_secret|EXECUTE AS|OPENROWSET|sp_executesql.*@claims/i);
    expect([...sql.matchAll(/\bGRANT\s+([^\r\n]+)/gi)].map(row => row[1])).toEqual([
      "EXECUTE ON OBJECT::settings.verify_catalog_historical_schedule_company_locations TO portal_runtime;",
    ]);
    expect(sql).not.toMatch(/^\s*(REVOKE|DENY|ALTER ROLE)\b/m);
  });

  it("binds the dynamic branch to the approved cutoff population and persisted exact scope", () => {
    const sql = migration();
    expect(sql).toContain("IF @copy=0 AND @draftManual=0 SET @dynamic=1");
    expect(sql).toContain("IF OBJECT_ID(N'scheduling.v_catalog_schedule_draft_pins',N'V') IS NULL");
    expect(sql).toContain("@copy=1 AND pin.link_id IS NOT NULL");
    expect(sql).toContain("@draftManual=1 AND manual_pin.link_id IS NOT NULL");
    expect(sql).toContain("manual_pin.verified_target_id=claim.physical_target_id");
    expect(sql).toContain("NOT (@copy=1 AND @draft=1)");
    expect(sql).toContain("@asOf=schedule_approval.approved_at");
    expect(sql).toContain("COLLATE Latin1_General_100_BIN2 PRIMARY KEY");
    expect(sql).toMatch(/DECLARE @cutoff_sources table\([^;]*id char\(36\) COLLATE Latin1_General_100_BIN2 UNIQUE,\s*role varchar\(15\) COLLATE Latin1_General_100_BIN2,binding_hex char\(16\) COLLATE Latin1_General_100_BIN2,\s*profile_hex char\(16\) COLLATE Latin1_General_100_BIN2\);/);
    expect(sql).toContain("STRING_AGG(CONVERT(varchar(max),CONCAT");
    expect(sql).toContain("WITHIN GROUP (ORDER BY id)");
    expect(sql).toContain("portal-sag:catalog-schedule-population:v1");
    expect(sql).toContain("a.population_sha256=@digest");
    expect(sql).toContain("a.source_count=@source_count AND a.link_count=@link_count");
    expect(sql).toContain("@dynamic=1 AND EXISTS(SELECT 1 FROM @cutoff_links e");
    expect(sql).toContain("x.domain_key=ol.domain_key AND x.database_key=ol.database_key");
    expect(sql).toContain("x.schedule_key=@key AND x.database_key=ol.database_key");
    expect(sql).toContain("definition.manual_environment=domain_row.environment_id COLLATE Latin1_General_100_BIN2");
    expect(sql).toContain("ls.environment_id COLLATE Latin1_General_100_BIN2=ol.link_environment");
    expect(sql).toContain("ma.approved_at<=@asOf");
    expect(sql).toContain("modules.matched=modules.requested");
  });

  it("is byte-pinned and stays in the opt-in SQL 2019 lifecycle", () => {
    const sha256 = createHash("sha256").update(migration(), "utf8").digest("hex");
    expect(read("migration/sql/MANIFEST.sha256")).toContain(`${sha256}  ${filename}`);
    expect(read(".gitattributes")).toContain(`migration/sql/${filename} text eol=lf`);
    expect(read("migration/tools/Validate-SqlServer2019Scripts.ps1")).toContain(`'${filename}'`);
    expect(read("migration/tools/Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1"))
      .toMatch(/if\(\$IncludeScheduleLifecycle\)\{[^}]+\}[\s\S]*?version='073'/);
  });
});
