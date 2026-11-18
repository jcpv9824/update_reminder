import { createHmac } from "node:crypto";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

export type CatalogMatchKeyEvidence = Readonly<{ vaultSecretVersion: Buffer; keyVerifier: Buffer }>;

/** A realm- and version-bound proof of a random key, never a customer matching token or a key. */
export function buildCatalogMatchKeyEvidence(
  environment: CatalogEnvironment, keyVersion: number, secretVersion: string, key: Buffer,
): CatalogMatchKeyEvidence {
  if ((environment !== "qa" && environment !== "production") || !Buffer.isBuffer(key) || key.length !== 32 ||
    !Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 32767 || !/^[a-f0-9]{32}$/i.test(secretVersion)) {
    throw new Error("invalid_catalog_match_key_evidence");
  }
  const version = secretVersion.toLowerCase();
  const keyVerifier = createHmac("sha256", key).update(
    `portal-sag/catalog-match-key-enrollment/v1\0${environment}\0${keyVersion}\0${version}`, "utf8",
  ).digest();
  return { keyVerifier, vaultSecretVersion: Buffer.from(version, "hex") };
}
