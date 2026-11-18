import { app, type HttpResponseInit } from "@azure/functions";
import { readPortalBrandImage } from "../lib/objectStorage";

app.http("portalBrandImage", {
  route: "public/brand/{name}",
  authLevel: "anonymous",
  methods: ["GET"],
  handler: async ({ params }): Promise<HttpResponseInit> => {
    if (params.name !== "login" && params.name !== "sidebar") {
      return { status: 404, headers: { "Cache-Control": "no-store" } };
    }
    try {
      return {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
        body: await readPortalBrandImage(params.name),
      };
    } catch {
      // Do not disclose the bucket, keys, URLs, or provider error details.
      return { status: 503, headers: { "Cache-Control": "no-store" } };
    }
  },
});
