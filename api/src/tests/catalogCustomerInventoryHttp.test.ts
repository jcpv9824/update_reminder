import type { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { createCatalogCustomerInventoryHttp, type CatalogCustomerInventoryEvidence } from "../lib/catalogCustomerInventoryHttp";
import type { CatalogSagInventoryEvidence } from "../lib/catalogSagInventoryEvidence";

const id = "7115bf63-9ee5-4407-820b-b4e82baa45ee";
const req = (query = "") => ({ params: { id }, query: new URLSearchParams(query) }) as unknown as HttpRequest;
const fact: CatalogSagInventoryEvidence = {
  domainCandidate: "example.test", environment: "test", licenseCodes: ["A", "B"],
  testStartedOn: "2026-10-15", productionStartedOn: null, demoStartedOn: null,
};
const fixture: CatalogCustomerInventoryEvidence = {
  state: "verified", verifiedAt: "2026-11-17T03:00:00.000Z", items: [fact, fact, {
    ...fact, environment: "production", testStartedOn: null, productionStartedOn: "2026-11-10", licenseCodes: ["B"],
  }], licenseModules: [{ code: "A", moduleId: "internal-id", name: "Módulo aprobado", description: "Descripción" }],
};
function setup(source: CatalogCustomerInventoryEvidence | null = fixture) {
  const allowed = new Set(["authorized-erp"]);
  const deps = { enabled: vi.fn(() => true),
    authorize: vi.fn<Parameters<typeof createCatalogCustomerInventoryHttp>[0]["authorize"]>()
      .mockResolvedValue({ actorId: "actor" }),
    readAllowedSourceIds: vi.fn(async () => allowed),
    readEvidence: vi.fn<() => Promise<CatalogCustomerInventoryEvidence | null>>().mockResolvedValue(source),
  };
  return { deps, allowed, handle: createCatalogCustomerInventoryHttp(deps) };
}

describe("read-only customer inventory routes", () => {
  it("does not cross-disclose host details to licensing or licensing details to domains", async () => {
    const { handle, deps, allowed } = setup();
    const domains = await handle(req(), "domains");
    expect(domains.jsonBody).toEqual({ state: "verified", verifiedAt: fixture.verifiedAt, partial: false, items: [{
      host: "example.test", observations: [
        { environment: "production", startedOn: "2026-11-10" }, { environment: "test", startedOn: "2026-10-15" },
      ],
    }] });
    const licenses = await handle(req(), "licenses");
    expect(licenses.jsonBody).toEqual({ state: "verified", verifiedAt: fixture.verifiedAt, partial: true, items: [
      { code: "A", moduleName: "Módulo aprobado", moduleDescription: "Descripción", environments: ["test"] },
      { code: "B", environments: ["production", "test"] },
    ] });
    expect(licenses.headers).toEqual({ "Cache-Control": "no-store" });
    expect(deps.readEvidence).toHaveBeenCalledWith(id, allowed);
  });

  it("requires the view-specific decision; browser parameters cannot widen the authorized scope", async () => {
    const { handle, deps } = setup();
    deps.authorize.mockResolvedValueOnce({ status: 403 });
    expect((await handle(req(), "licenses")).status).toBe(403);
    expect(deps.authorize).toHaveBeenCalledWith(expect.anything(), "licenses");
    expect((await handle(req("sourceId=other"), "domains")).status).toBe(400);
    expect(deps.readEvidence).not.toHaveBeenCalled();
  });

  it("does not confuse a missing client, unavailable revision and verified empty evidence", async () => {
    const { handle, deps } = setup();
    deps.readEvidence.mockResolvedValueOnce(null);
    expect((await handle(req(), "domains")).status).toBe(404);
    deps.readEvidence.mockResolvedValueOnce({ ...fixture, state: "unavailable" });
    expect((await handle(req(), "domains")).jsonBody).toEqual({ state: "unavailable", verifiedAt: null, partial: true, items: [] });
    deps.readEvidence.mockResolvedValueOnce({ ...fixture, items: [] });
    expect((await handle(req(), "domains")).jsonBody).toEqual({
      state: "verified", verifiedAt: fixture.verifiedAt, partial: false, items: [],
    });
  });

  it("preserves stale evidence and does not pick arbitrarily between conflicting dates", async () => {
    const { handle } = setup({ ...fixture, state: "stale", items: [fact, { ...fact, testStartedOn: "2026-09-02" }] });
    expect((await handle(req(), "domains")).jsonBody).toMatchObject({
      state: "stale", partial: true, items: [{ host: "example.test", observations: [{ environment: "test", startedOn: null }] }],
    });
  });
});
