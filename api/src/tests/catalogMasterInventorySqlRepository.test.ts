import { expect, it } from "vitest";
import { readCatalogMasterInventorySql } from "../lib/catalogMasterInventorySqlRepository";
import { readCatalogOnceClosureProofSql } from "../lib/catalogOnceClosureSql";
import { readCatalogSchedulePopulationSql } from "../lib/catalogSchedulePopulationCoverage";

it("shows positive SAG v2 licensing only from a sealed revision, without widening other inventory rows", () => {
  const sql = readCatalogMasterInventorySql;
  expect(sql).toContain("@view='licenses' AND b.source_role='sag-admin'");
  expect(sql).toMatch(/'sag_admin_v2'\s+AND r.expected_sag_company_rows IS NOT NULL/);
  expect(sql).toMatch(/'sag_admin_v1'\s+AND r.expected_sag_company_rows IS NULL/);
  expect(sql).toContain("r.sealed_at<=@now");
  expect(sql).toContain("r.attempt_ordinal=h.attempt_ordinal");
  expect(sql).toContain("AND a.binding_version=h.binding_version AND a.profile_version=h.profile_version");
  expect(sql).toContain("WHEN @partial=1 OR @total=0 THEN 'partial'");
  expect(sql).toContain("N'Correspondencia no verificada'");
  expect(readCatalogSchedulePopulationSql).not.toContain("sag_admin_v2");
  expect(readCatalogOnceClosureProofSql).not.toContain("sag_admin_v2");
});
