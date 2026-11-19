/** Deployment-owned opt-in only; absence preserves the dedicated principal. */
export type CatalogSagV2PublisherMode = "dedicated" | "portal-owner";

export function readCatalogSagV2PublisherMode(env: NodeJS.ProcessEnv): CatalogSagV2PublisherMode | null {
  const value = env.PORTAL_CATALOG_SAG_V2_PUBLISHER_MODE;
  return value === undefined ? "dedicated" : value === "portal-owner" ? "portal-owner" : null;
}

/** The owner path has no no-target publication or general-purpose SQL operation. */
export const CATALOG_SAG_V2_OWNER_PROCEDURES = Object.freeze({
  reserve: "settings.reserve_catalog_sag_v2_owner_attempt",
  publishWithTargets: "settings.publish_catalog_sag_v2_owner_with_targets",
  fail: "settings.fail_catalog_sag_v2_owner_attempt",
} as const);
