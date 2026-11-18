import { describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ make: vi.fn(), get: vi.fn(), publish: vi.fn(), binding: vi.fn() }));
vi.mock("../lib/catalogSagV2PublisherPool", async original => ({
  ...await original<typeof import("../lib/catalogSagV2PublisherPool")>(), createCatalogSagV2PublisherPoolLoader: f.make,
}));
vi.mock("../lib/catalogSagV2ClaimedPublication", () => ({ publishClaimedCatalogSagV2: f.publish }));
vi.mock("../lib/catalogSourceBindingsSqlRepository", async original => ({
  ...await original<typeof import("../lib/catalogSourceBindingsSqlRepository")>(), readSqlCatalogSourceBindingForClaim: f.binding,
}));

import { prepareCatalogSagV2Publication } from "../lib/catalogSagV2PublicationRuntime";
import type { CatalogRefreshClaim } from "../lib/catalogRefreshQueueSqlRepository";
import { readCatalogRefreshConfiguration } from "../lib/catalogSourcePublication";

const settings: NodeJS.ProcessEnv = {
  PORTAL_SAG_ENVIRONMENT: "qa", PORTAL_CATALOG_READ_ENABLED: "true", PORTAL_CATALOG_AUTOMATION_ENABLED: "true",
  PORTAL_CATALOG_SAG_V2_ENABLED: "true", PORTAL_CATALOG_MATCH_KEY_VERSION: "2",
  PORTAL_CATALOG_MATCH_KEY_SECRET_NAME: "synthetic-match-ref", PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "ab".repeat(16),
  PORTAL_CATALOG_SAG_ISSUER_MAP: '[{"countryId":1,"issuerScope":"CO:NIT"}]',
  SQL_DATABASE: "PortalSAGWeb-TEST", SQL_SERVER_HOST: "qa.sagweb.co,54103",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_USERNAME: "publisher-fixture",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_NAME: "publisher-fixture-ref",
  PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: "ef".repeat(16),
};

describe("SAG v2 runtime preparation", () => {
  it("leaves v2 off with incomplete configuration and does not connect from the shared HTTP configuration reader", async () => {
    const off = { ...settings, PORTAL_CATALOG_SAG_V2_PUBLISHER_PASSWORD_SECRET_VERSION: undefined };
    expect(readCatalogRefreshConfiguration(settings)?.includeSagV2).toBe(true);
    expect(readCatalogRefreshConfiguration(off)?.includeSagV2).toBeUndefined();
    expect(await prepareCatalogSagV2Publication(off)).toBeNull();
    expect(f.make).not.toHaveBeenCalled();
  });

  it("waits for the ready pool, reuses it for the exact claim, and rejects drift without closing another tick's pool", async () => {
    const pool = { request: vi.fn() };
    const close = vi.fn();
    f.make.mockReturnValue({ get: f.get, close });
    f.get.mockRejectedValueOnce(new Error("fixture bootstrap error")).mockResolvedValue(pool);
    expect(await prepareCatalogSagV2Publication(settings)).toBeNull();
    const handle = await prepareCatalogSagV2Publication(settings);
    expect(handle?.isCurrent(settings)).toBe(true);
    expect(f.make).toHaveBeenCalledOnce();
    const claim = { environment: "qa", sourceId: "84ac4729-ae25-4a43-9e12-338efe4d14de" } as CatalogRefreshClaim;
    const result = { outcome: "unconfirmed", queue: "lease-recovery" };
    f.publish.mockImplementation(async (_claim, io) => {
      expect(io.readBindings).toBe(f.binding);
      await expect(io.getDedicatedPool("qa")).resolves.toBe(pool);
      await expect(io.getDedicatedPool("production")).rejects.toThrow(/^catalog_sag_v2_publisher_unavailable$/);
      return result;
    });
    expect(await handle?.publish(claim, settings)).toEqual(result);
    const changed = { ...settings, PORTAL_CATALOG_MATCH_KEY_SECRET_VERSION: "cd".repeat(16) };
    expect(handle?.isCurrent(changed)).toBe(false);
    expect(await handle?.publish(claim, changed)).toEqual({ outcome: "ineligible", queue: "untouched" });
    expect(f.publish).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
