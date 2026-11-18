import { describe, expect, it } from "vitest";
import { catalogTaskCurrentLinkSql, catalogTaskHasActiveRepresentativeSql,
  catalogTaskHasVisibleLinkSql, catalogTaskActiveLinkProjectionSql,
  catalogTaskHistoryEnvironmentSql } from "../lib/catalogWorkflowTaskEligibilitySql";

describe("shared current catalog workflow eligibility SQL", () => {
  const statement = catalogTaskCurrentLinkSql("e", "link", "@portalEnvironment");

  it("requires nonretired active aliases and a processed or future cutoff", () => {
    for (const predicate of ["@portalEnvironment IS NOT NULL", "e.retired_at IS NULL",
      "e.cutoff_at>@now OR e.cutoff_evaluated_at IS NOT NULL",
      "link.catalog_execution_key=e.catalog_execution_key", "link.execution_kind=e.execution_kind",
      "link.link_state='active' AND link.retired_at IS NULL"]) expect(statement).toContain(predicate);
  });

  it("requires exact current 042 bridge identity, source, canonical record and scope", () => {
    for (const predicate of [
      "current_bridge.link_id=TRY_CONVERT(uniqueidentifier,link.link_id) AND DATALENGTH(link.link_id)=72",
      "current_bridge.client_key=link.client_key AND current_bridge.domain_key=link.domain_key",
      "current_bridge.database_key IS NULL AND link.database_key IS NULL",
      "current_bridge.database_key=link.database_key",
      "current_bridge.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(current_bridge.target_kind)=DATALENGTH(e.execution_kind)",
      "current_bridge.portal_environment COLLATE Latin1_General_100_BIN2=@portalEnvironment COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(current_bridge.portal_environment)=DATALENGTH(@portalEnvironment)",
      "current_bridge.link_environment=link.link_environment COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(current_bridge.link_environment)=DATALENGTH(link.link_environment)",
      "current_bridge.catalog_source_key=link.catalog_source_key",
      "current_bridge.source_record_id=TRY_CONVERT(int,link.catalog_record_id)",
      "CONVERT(nvarchar(11),current_bridge.source_record_id) COLLATE Latin1_General_100_BIN2=link.catalog_record_id COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(CONVERT(nvarchar(11),current_bridge.source_record_id))=DATALENGTH(link.catalog_record_id)",
      "current_bridge.retired_at IS NULL AND current_bridge.owner_retired_at IS NULL",
      "current_bridge.evidence_state='verified' AND current_bridge.verified_until>@now",
      "current_revision.revision_key=current_bridge.revision_key AND current_revision.observed_at<=@now",
    ]) expect(statement).toContain(predicate);
  });

  it("never reclassifies a known external UUID as local, including retired or other-environment UUIDs", () => {
    const local = statement.slice(statement.indexOf("link.catalog_source_key IS NULL"), statement.indexOf("OR (link.catalog_source_key IS NOT NULL"));
    expect(local).toContain("NOT EXISTS");
    expect(local).toContain("FROM core.catalog_operational_links AS known_external");
    expect(local).toContain("known_external.link_id=TRY_CONVERT(uniqueidentifier,link.link_id)");
    expect(local).not.toContain("retired_at");
    expect(local).not.toContain("portal_environment");
  });

  it("requires active hierarchy and exact current physical proof for both target kinds", () => {
    for (const predicate of ["current_client.status='active'", "current_domain.status='active'",
      "current_db.status='active'", "current_profile.active=1",
      "current_db.client_key=current_client.client_key AND current_db.domain_key=current_domain.domain_key",
      "current_physical.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2",
      "DATALENGTH(current_physical.portal_environment)=DATALENGTH(@portalEnvironment)",
      "current_physical.target_kind=e.execution_kind COLLATE Latin1_General_100_BIN2",
      "current_physical.retired_at IS NULL AND current_physical.verified_at<=@now AND current_physical.valid_until>@now",
      "current_target.target_id=TRY_CONVERT(uniqueidentifier,e.verified_target_id)", "DATALENGTH(e.verified_target_id)=72",
      "current_domain.environment_id COLLATE Latin1_General_100_BIN2=link.link_environment COLLATE Latin1_General_100_BIN2",
      "current_db.environment_id COLLATE Latin1_General_100_BIN2=link.link_environment COLLATE Latin1_General_100_BIN2",
      "current_physical.domain_route_fingerprint=HASHBYTES('SHA2_256'",
      "DATALENGTH(current_domain.domain_name_normalized)", "current_domain.publishable_domain",
      "current_physical.access_profile_key=current_profile.access_profile_key",
      "current_physical.access_profile_version=current_profile.row_version",
      "current_target.database_name_fingerprint=HASHBYTES('SHA2_256',CONVERT(varbinary(max),current_profile.initial_catalog))",
    ]) expect(statement).toContain(predicate);
    expect(statement).not.toMatch(/\bd\./);
  });

  it("supports the credential representative with no repository-specific parameter dependency", () => {
    const credential = catalogTaskCurrentLinkSql("e", "visible_link", "@environment");
    expect(credential).toContain("visible_link.link_state='active'");
    expect(new Set(credential.match(/@[A-Za-z]+/g))).toEqual(new Set(["@environment", "@now"]));
  });

  it.each([["task", "link", "@portalEnvironment"], ["e", "untrusted", "@portalEnvironment"],
    ["e", "link", "'production'"], ["e;", "link", "@environment"]])("rejects nonconstant template inputs %j %j %j", (e, l, env) => {
    expect(() => catalogTaskCurrentLinkSql(e, l, env)).toThrow("catalog_task_sql_template_invalid");
  });

  it("evaluates read evidence once and never lets an alternate alias satisfy legacy write scope", () => {
    expect(catalogTaskHasVisibleLinkSql).toContain("active_catalog_link.catalog_execution_link_key IS NOT NULL");
    expect(catalogTaskHasVisibleLinkSql).not.toContain("catalog_operational_link_evidence");
    expect(catalogTaskActiveLinkProjectionSql).toContain(statement);
    expect(catalogTaskHasActiveRepresentativeSql).toContain(catalogTaskCurrentLinkSql("catalog_execution", "catalog_link", "@portalEnvironment"));
    expect(catalogTaskHasActiveRepresentativeSql).toContain("catalog_link.client_key=task.client_key");
    expect(catalogTaskHasActiveRepresentativeSql).toContain("catalog_link.domain_key=task.domain_key");
    expect(catalogTaskHasActiveRepresentativeSql).toContain("task.target_type='domain' OR catalog_link.database_key=task.database_key");
    expect(catalogTaskHasActiveRepresentativeSql).not.toContain("active_catalog_link");
    expect(catalogTaskHasActiveRepresentativeSql).toMatch(/^NOT EXISTS/);
  });

  it("keeps a filter-independent canonical representative and discovers only same-alias paired matches", () => {
    const order = catalogTaskActiveLinkProjectionSql.slice(catalogTaskActiveLinkProjectionSql.lastIndexOf("ORDER BY"));
    expect(order).toContain("CASE WHEN link.client_key=task.client_key AND link.domain_key=task.domain_key");
    expect(order).toContain("link.catalog_execution_link_key");
    expect(order).not.toMatch(/@clientId|@domainId/);
    expect(catalogTaskActiveLinkProjectionSql).toMatch(/MAX\(CASE WHEN \(@clientId IS NULL OR client\.source_id=@clientId\)\s+AND \(@domainId IS NULL OR domain_row\.source_id=@domainId\) THEN 1 ELSE 0 END\) OVER \(\) AS matches_filters/);
    expect(catalogTaskActiveLinkProjectionSql.match(/MAX\(/g)).toHaveLength(1);
  });

  it("retains completed legacy history but scopes catalog history by immutable target environment", () => {
    expect(catalogTaskHistoryEnvironmentSql).toMatch(/^\(NOT EXISTS/);
    expect(catalogTaskHistoryEnvironmentSql).toContain("history_execution.task_key=task.task_key");
    expect(catalogTaskHistoryEnvironmentSql).toContain("history_target.target_id=TRY_CONVERT(uniqueidentifier,history_execution.verified_target_id)");
    expect(catalogTaskHistoryEnvironmentSql).toContain("DATALENGTH(history_execution.verified_target_id)=72");
    expect(catalogTaskHistoryEnvironmentSql).toContain("history_target.target_kind=history_execution.execution_kind COLLATE Latin1_General_100_BIN2");
    expect(catalogTaskHistoryEnvironmentSql).toContain("history_target.portal_environment=@portalEnvironment COLLATE Latin1_General_100_BIN2");
    expect(catalogTaskHistoryEnvironmentSql).toContain("DATALENGTH(history_target.portal_environment)=DATALENGTH(@portalEnvironment)");
    for (const excluded of ["retired_at", "verified_until", "valid_until", "cutoff_at", "link_state", "catalog_operational_link_evidence"]) {
      expect(catalogTaskHistoryEnvironmentSql).not.toContain(excluded);
    }
  });
});
