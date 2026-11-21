import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const filename = "082_catalog_schedule_activation_seals.sql";
const read = (file: string) => readFileSync(new URL(`../../../migration/${file}`, import.meta.url), "utf8");
const sql = read(`sql/${filename}`);

describe("freeze activation aggregate in SQL", () => {
  it("allows only the initial seal with current definition and both transaction day locks", () => {
    expect(read("sql/MANIFEST.sha256")).toContain(`${createHash("sha256").update(sql).digest("hex")}  ${filename}`);
    expect(sql).toContain("A snapshot cannot be inserted already sealed.");
    expect(sql).toContain("o.sealed_at IS NULL AND n.sealed_at IS NOT NULL");
    expect(sql).toContain("INSTEAD OF UPDATE AS");
    expect(sql).toContain("DECLARE @sealedAt datetime2(3)=SYSUTCDATETIME()");
    expect(sql).toContain("SET sealed_at=@sealedAt");
    expect(sql).toContain("n.definition_version=o.definition_version");
    expect(sql).toContain("s.row_version=n.definition_version");
    expect(sql).toContain("transaction_isolation_level=4");
    expect(sql).toContain("portal.catalog-task.v1:database:");
    expect(sql).toContain("portal.catalog-task.v1:domain:");
    expect(sql).not.toMatch(/^\s*(?:GRANT|DENY|REVOKE|ALTER ROLE)\b/im);
  });
  it("never silently certifies preexisting rows or allows child modifications", () => {
    expect(sql).toContain("Existing snapshots require separate reconciliation");
    expect(sql.match(/WHERE s.sealed_at IS NOT NULL/g)).toHaveLength(2);
    expect(sql.match(/IF EXISTS\(SELECT 1 FROM deleted\) OR EXISTS/g)).toHaveLength(2);
    expect(sql).toContain("evidence_state=''unverifiable''");
    expect(sql).toContain("p.target_kind=t.target_kind");
    const runner = read("tools/Apply-PortalSAGWeb-PendingMigrationsThroughSession.ps1");
    expect(runner).toContain("COL_LENGTH(N'scheduling.catalog_schedule_activation_snapshots',N'sealed_at')=7");
    expect(runner).toContain("version='082'");
  });

  it("ships an opt-in, rollback-only fixture locked to the QA Portal database", () => {
    const fixture = read("tools/qa/catalog_schedule_activation_seals.sql");
    const runner = read("tools/Test-CatalogScheduleActivationSealsQa.ps1");
    expect(fixture).toContain("DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'");
    expect(fixture).toContain("migration_version='082' AND succeeded=1");
    expect(fixture).toContain("WHILE @scenario<=8");
    expect(fixture).toContain("IF @expected IS NULL OR @caught<>@expected THROW;");
    expect(fixture).toContain("ROLLBACK TRANSACTION");
    expect(fixture).not.toMatch(/\bCOMMIT\b|\bGRANT\b|\bREVOKE\b|\bDENY\b|\bOPENQUERY\b/i);
    expect(runner.indexOf("if(!$ExecuteFixtures)")).toBeLessThan(runner.indexOf("active.json"));
    expect(runner).toContain("$PSCmdlet.ShouldProcess('PortalSAGWeb-TEST'");
    expect(runner).toContain("$row.rolledBack -ne $true");
  });

  it("requires independent QA sessions and server-observed overlap for the contention rehearsal", () => {
    const fixture = read("tools/qa/catalog_schedule_day_lock_contention.sql");
    const runner = read("tools/Test-CatalogScheduleDayLockContentionQa.ps1");
    expect(fixture).toContain("DB_NAME() COLLATE Latin1_General_100_BIN2<>N'PortalSAGWeb-TEST'");
    expect(fixture).toContain("@daysAgo NOT BETWEEN 211 AND 999");
    expect(fixture).toContain("portal.catalog-task.v1:database:");
    expect(fixture).toContain("portal.catalog-task.v1:domain:");
    expect(fixture.match(/@LockOwner=N'Transaction'/g)).toHaveLength(2);
    expect(fixture).toContain("ROLLBACK TRANSACTION");
    expect(fixture).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COMMIT|GRANT|REVOKE|DENY)\b/i);
    expect(runner.indexOf("if(!$ExecuteContention)")).toBeLessThan(runner.indexOf("active.json"));
    expect(runner).toContain("$holder.controller -eq $observer.controller");
    expect(runner).toContain("$held.connectionId -eq $seen.connectionId");
    expect(runner).toContain("$seen.observedUtcMs -ge $held.releasedUtcMs");
    expect(runner).toContain("$again.observedUtcMs -lt $held.releasedUtcMs");
  });
});
