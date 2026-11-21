import { HttpRequest } from "@azure/functions";
import { describe, expect, it, vi } from "vitest";
import { catalogCopyProposalListSql, createCatalogCopyProposalListHttp } from "../lib/catalogScheduleCopyProposalList";

const proposal = { id: "05d95fc4-21c3-4adc-8c8d-d23716fe679c", name: "Copia", date: "2030-06-22", status: "scheduled" as const };
const request = (query = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/schedules/original/catalog-copy-proposals${query}`,
  params: { id: "original" } });

describe("requester-only copy proposal listing", () => {
  it("rejects unauthenticated and forged actor inputs before reading state", async () => {
    const list = vi.fn();
    const notAllowed = createCatalogCopyProposalListHttp({ authorize: async () => ({ status: 403 }), list });
    expect((await notAllowed(request())).status).toBe(403);
    const allowed = createCatalogCopyProposalListHttp({ authorize: async () => ({ actorId: "actual" }), list });
    expect((await allowed(request("?actorId=someone-else"))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
  it("projects only the user's proposal DTO and no receipt or internal matching details", async () => {
    const list = vi.fn().mockResolvedValue([{ ...proposal, reviewId: "not public", clientId: "internal" }]);
    const allowed = createCatalogCopyProposalListHttp({ authorize: async () => ({ actorId: "actual" }), list });
    expect(await allowed(request())).toEqual({ status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: { items: [proposal] } });
    expect(list).toHaveBeenCalledExactlyOnceWith("actual", "original");
  });
  it("scopes SQL by actor and environment and requires both approval and snapshot for an active status", () => {
    expect(catalogCopyProposalListSql).toContain("TOP (20)");
    expect(catalogCopyProposalListSql).toContain("p.requester_source_id=@actor COLLATE Latin1_General_100_BIN2");
    expect(catalogCopyProposalListSql).toContain("p.portal_environment=@env");
    expect(catalogCopyProposalListSql).toContain("a.schedule_version=copy.row_version");
    expect(catalogCopyProposalListSql).toContain("proof.definition_version=copy.row_version");
    expect(catalogCopyProposalListSql).toContain("WHEN proof.activation_state='frozen' THEN 'active'");
    expect(catalogCopyProposalListSql).not.toMatch(/review_id|request_sha256/);
  });
});
