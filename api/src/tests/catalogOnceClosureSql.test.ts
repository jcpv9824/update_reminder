import { describe, expect, it } from "vitest";
import { readCatalogOnceClosureProofSql } from "../lib/catalogOnceClosureSql";

function proofSql() { return readCatalogOnceClosureProofSql.replace(/\s+/g, " "); }

describe("catalog once cutoff closure proof", () => {
  it("reads one normalized candidate without writes, alternate clocks, or tenant-facing proofs", () => {
    const sql = proofSql();
    expect(sql).toContain("@now datetime2(7)=SYSUTCDATETIME()");
    expect(sql).toContain("DATEADD(hour,5,CONVERT(datetime2(3),@taskDate))");
    expect(sql).toContain("@now<@cutoffAt");
    expect(sql).toContain("portal.catalog-task.v1:database:");
    expect(sql).toContain("portal.catalog-task.v1:domain:");
    expect(sql).toMatch(/s\.source_id AS scheduleId,\s*LOWER\(CONVERT\(char\(16\),o\.schedule_version,2\)\) AS scheduleVersion,\s*c\.source_id AS clientId/);
    expect(sql).not.toMatch(/\b(?:INSERT INTO|DELETE FROM|UPDATE scheduling|MERGE INTO)\b|\bWITH\s*\([^)]*\b(?:NOLOCK|READPAST)\b/i);
    expect(sql).not.toMatch(/password_value|secret_reference|connection_string/i);
  });

  it("materializes the twelve closed stages instead of recursively expanding licensing proof joins", () => {
    const sql = proofSql();
    const stages = ["candidate", "populationLinks", "manifest", "cutoffHeads", "witnessFence", "validPairs",
      "licenseContexts", "licenseClaims", "numbers", "licenseCodes", "licenseModules", "licensedPairs"];
    for (const stage of stages) {
      expect(sql).toContain(`DECLARE @${stage} TABLE(`);
      expect(sql.match(new RegExp(`INSERT @${stage}\\b`, "g"))).toHaveLength(1);
    }
    expect(sql).not.toContain(";WITH candidate AS");
    expect(sql).toContain("FROM @validPairs p");
    expect(sql).toContain("JOIN @cutoffHeads");
    expect(sql).toContain("domain_name nvarchar(500) COLLATE DATABASE_DEFAULT");
    expect(sql).toContain("issuer char(2) COLLATE Latin1_General_100_BIN2");
    expect(sql).toContain("operation_id nvarchar(200) COLLATE Latin1_General_100_BIN2");
  });

  it("never falls back to an earlier proof and supports a separately proven licensing selection", () => {
    const sql = proofSql();
    expect(sql).toContain("o.observation_key=@observationKey");
    expect(sql).toContain("newer.observation_key>o.observation_key");
    expect(sql).toContain("o.pair_count BETWEEN 1 AND 5000");
    expect(sql).toContain("o.valid_until>@cutoffAt");
    expect(sql).toContain("s.row_version=o.schedule_version");
    expect(sql).toContain("s.selection_mode='manual'");
    expect(sql).toContain("op.operation_id=o.operation_id");
    expect(sql).toContain("pop.population_id=o.population_id");
    expect(sql).toContain("witnessFence.source_fence=o.source_fence");
    expect(sql).toContain("s.selection_mode='licensing'");
    expect(sql).toContain("approval.approved_at<=@cutoffAt");
    expect(sql).toContain("license_match_mode='any'");
    expect(sql).toContain("license_match_mode='all'");
    expect(sql).toContain("JOIN scheduling.licensing_scope ls");
    expect(sql).not.toContain("scheduling.licensing_scopes");
    expect(sql).toContain("pop.population_sha256=HASHBYTES");
  });

  it("uses the exact witnessed state at cutoff rather than losing it on a later normal refresh", () => {
    const sql = proofSql();
    expect(sql).toContain("h.attempt_status='succeeded'");
    expect(sql).toContain("h.attempted_at<=@cutoffAt");
    expect(sql).toContain("r.observed_at<=@cutoffAt");
    expect(sql).toContain("r.sealed_at<=@cutoffAt");
    expect(sql).toContain("r.verified_until>@cutoffAt");
    expect(sql).toContain("r.profile_version=p.row_version");
    expect(sql).toContain("r.binding_version=b.row_version");
    expect(sql).toContain("r.match_key_version=mk.match_key_version");
    expect(sql).toContain("r.has_sag_inventory_evidence=1");
    expect(sql).toContain("catalog_once_source_witnesses");
    expect(sql).toContain("catalog_source_head_events");
    expect(sql).toContain("event.recorded_at<=@cutoffAt");
    expect(sql).toContain("ORDER BY event.head_event_key DESC");
    expect(sql).not.toContain("JOIN settings.catalog_customer_revision_heads h");
  });

  it("requires all exact active attachments, not receipts; counts successful post-cutoff tasks only while current", () => {
    const sql = proofSql();
    expect(sql).toContain("catalog_once_observation_pairs");
    expect(sql).toContain("ae.detached_at IS NULL");
    expect(sql).toContain("h.source_role='erp-customers'");
    expect(sql).toContain("a.revision_key<=h.revision_key");
    expect(sql).toContain("x.link_state='active'");
    expect(sql).toContain("e.retired_at IS NULL");
    expect(sql).toContain("t.status='completed'");
    expect(sql).toContain("t.completed_with_problems=0");
    expect(sql).toContain("t.result COLLATE Latin1_General_100_BIN2=N'success' AND DATALENGTH(t.result)=14");
    expect(sql).toContain("t.completed_at>=@dayStart");
    expect(sql).toContain("t.completed_at<=@now");
    expect(sql).toContain("t.completed_at>t.reopened_at");
    expect(sql).toContain("ORDER BY hist.task_status_history_key DESC");
    expect(sql).toContain("completion.performed_at=t.completed_at");
    expect(sql).toContain("evidence.[key] COLLATE Latin1_General_100_BIN2=N'explicitCompletionSuccess'");
    expect(sql).toContain("HAVING COUNT_BIG(*)=1 AND MAX(CASE WHEN evidence.[type]=3");
    expect(sql).toContain("evidence.[value] COLLATE Latin1_General_100_BIN2=N'true'");
    expect(sql).toContain("completion.performed_by COLLATE Latin1_General_100_BIN2=t.completed_by COLLATE Latin1_General_100_BIN2");
    expect(sql).not.toContain("t.completed_at<=@cutoffAt");
    expect(sql).not.toContain("catalog_task_origin_receipts");
  });
});
