import { createHash } from "node:crypto";

const opaqueId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function normalIdentity(value: string): string {
  if (!opaqueId.test(value) || value === "00000000-0000-0000-0000-000000000000") {
    throw new Error("catalog_target_identity_invalid");
  }
  return value.toLowerCase();
}

function fingerprint(kind: "database" | "domain", group: string, id: string): Buffer {
  return createHash("sha256").update(JSON.stringify([
    "portal-sag/catalog-physical-target/v1", kind, normalIdentity(group), normalIdentity(id),
  ]), "utf8").digest();
}

/** The instance namespace must be verified independently, not taken from an entered hostname. */
export function fingerprintCatalogSqlTarget(input: { instanceId: string; databaseGuid: string }): Buffer {
  return fingerprint("database", input.instanceId, input.databaseGuid);
}

/** The operational registry supplies an approved deployment ID, not a SAG display URL. */
export function fingerprintCatalogWebTarget(input: { providerScopeId: string; deploymentId: string }): Buffer {
  return fingerprint("domain", input.providerScopeId, input.deploymentId);
}

/** Constant SQL, with the verified domain row aliased as d. Mirrors migration 036. */
export const catalogDomainRouteFingerprintSql = `HASHBYTES('SHA2_256',
  CONVERT(varbinary(max),N'portal-sag:web-route:v1|')
  + CONVERT(binary(4),DATALENGTH(d.domain_name_normalized))
  + CONVERT(varbinary(max),d.domain_name_normalized)
  + CASE WHEN d.publishable_domain IS NULL THEN CONVERT(varbinary(max),0x00)
    ELSE CONVERT(varbinary(max),0x01)+CONVERT(binary(4),DATALENGTH(d.publishable_domain))
      +CONVERT(varbinary(max),d.publishable_domain) END)`;
