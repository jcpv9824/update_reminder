import { expect, it } from "vitest";
import { mapCatalogObservedInventoryRows, readCatalogMasterInventorySql, readCatalogObservedInventorySql } from "../lib/catalogMasterInventorySqlRepository";
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

it("uses the same exact authorized/revision/identity contracts for observed inventory and does not infer operational links", () => {
  const sql = readCatalogObservedInventorySql;
  expect(sql).toContain("r.revoked_at IS NULL");
  expect(sql).toContain("ids.[value])=b.source_id");
  expect(sql).toContain("r.match_key_version=@matchKeyVersion");
  expect(sql).toContain("r.verified_until>@now");
  expect(sql).toContain("AND s.document_type=n.document_type AND s.document_number_token=n.token");
  expect(sql).toContain("AND x.issuer IS NULL AND x.document_number_token=n.token");
  expect(sql).toContain("GROUP BY x.source_key HAVING COUNT_BIG(*)>1");
  expect(sql).toContain("AND x.token=m.token AND x.customer_key<>m.customer_key");
  expect(sql).toContain("m.active_code IN ('S','N')");
  expect(readCatalogMasterInventorySql).toContain("m.active_code='S'");
  expect(sql).toMatch(/'sag_admin_v2'\s+AND r.expected_sag_company_rows IS NOT NULL/);
  expect(sql).not.toContain("sag_admin_v1");
  expect(sql).not.toMatch(/core\.(domains|databases|database_access_profiles|catalog_operational_link_evidence)\b/);
  expect(sql).not.toMatch(/StringConnection|login_name|server_host|location_token|secret\b/i);
  expect(readCatalogMasterInventorySql).toContain("core.catalog_operational_link_evidence");
  expect(readCatalogMasterInventorySql).not.toContain("core.catalog_sag_company_database_names");
});

it("separates customer-host identities, and only names databases with exact sealed, available Company evidence", () => {
  const sql = readCatalogObservedInventorySql;
  expect(sql).toContain("GROUP BY customer_key,customerName,observedHost");
  expect(sql).toContain("COUNT(DISTINCT CASE WHEN environment<>'unknown' THEN environment END)>1 THEN 'multiple'");
  expect(sql).not.toMatch(/catalog_sag_company_location_(observations|seals)/);
  expect(sql).toContain("c.customer_record_id=m.source_record_id AND c.is_available=1");
  expect(sql).toContain("databaseNames.company_record_id=c.company_record_id");
  expect(sql).toContain("GROUP BY m.customer_key,m.customerName,m.observedHost,LOWER(databaseNames.database_name COLLATE Latin1_General_100_BIN2)");
  expect(sql).not.toMatch(/company_name|c\.display_name/);
  expect(sql).toContain("WHEN @partial=1 OR @total=0 THEN 'partial'");
});

it("allows only display host, database label and observed metadata in the observed inventory DTO", () => {
  const base = { id: "a".repeat(64), customerName: "Empresa ERP", environment: "production" } as const;
  const safeDomain = { ...base, name: "sag.example.test", secret: "synthetic-password", token: "synthetic-token", internalId: 24 };
  const deniedDomain = { ...base, id: "b".repeat(64), name: "https://user:pw@example.test/a?key=secret" };
  expect(mapCatalogObservedInventoryRows("domains", [safeDomain, deniedDomain])).toEqual({ partial: true,
    items: [{ ...base, name: "sag.example.test" }] });
  expect(mapCatalogObservedInventoryRows("databases", [{ ...base, name: "QA_DB-01", detail: "sag.example.test" },
    { ...base, name: "Initial Catalog=x;Password=y", detail: "sag.example.test" },
    { ...base, name: "QA_DB-02", detail: "10.1.2.3" }])).toEqual({ partial: true,
    items: [{ ...base, name: "QA_DB-01", detail: "sag.example.test" }] });
});
