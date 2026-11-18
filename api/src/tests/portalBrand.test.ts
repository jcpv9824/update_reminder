import { beforeEach, describe, expect, it, vi } from "vitest";

const portalBrand = vi.hoisted(() => ({
  register: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@azure/functions", () => ({ app: { http: portalBrand.register } }));
vi.mock("../lib/objectStorage", () => ({ readPortalBrandImage: portalBrand.read }));
import "../functions/portalBrand";

const route = portalBrand.register.mock.calls[0][1];

describe("portal brand endpoint", () => {
  beforeEach(() => { portalBrand.read.mockReset(); });

  it("serves only the public PNG bytes, without a signed URL", async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    portalBrand.read.mockResolvedValue(png);
    const response = await route.handler({ params: { name: "login" } });
    expect(response).toEqual({
      status: 200,
      body: png,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
    expect(route).toMatchObject({ authLevel: "anonymous", methods: ["GET"], route: "public/brand/{name}" });
    expect(portalBrand.read).toHaveBeenCalledOnce();
    expect(portalBrand.read).toHaveBeenCalledWith("login");
  });

  it("rejects any unlisted object without calling storage and keeps provider failures private", async () => {
    expect(await route.handler({ params: { name: "../private" } })).toMatchObject({ status: 404 });
    expect(portalBrand.read).not.toHaveBeenCalled();
    portalBrand.read.mockRejectedValue(new Error("private-provider-details"));
    expect(await route.handler({ params: { name: "sidebar" } })).toEqual({
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  });
});
