import { app, type HttpResponseInit } from "@azure/functions";
import { loadRuntimeStatus } from "../lib/runtimeStatus";

app.http("runtimeStatus", {
  route: "portal-runtime-status",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => {
    try {
      return {
        status: 200,
        headers: { "Cache-Control": "no-store" },
        jsonBody: await loadRuntimeStatus(),
      };
    } catch {
      return {
        status: 503,
        headers: { "Cache-Control": "no-store" },
        jsonBody: { error: "La conexión de datos configurada no está disponible." },
      };
    }
  },
});

app.http("maintenanceMutationProbe", {
  route: "portal-maintenance-mutation-probe",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => ({
    status: 409,
    headers: { "Cache-Control": "no-store" },
    jsonBody: {
      error: "El modo mantenimiento no está bloqueando mutaciones.",
      code: "PORTAL_MAINTENANCE_INACTIVE",
    },
  }),
});
