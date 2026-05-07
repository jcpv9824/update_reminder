import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, created, forbidden, ok, serverError } from "../lib/http";
import type { UserRecord } from "../types/models";

const SetupSchema = z.object({
  setupSecret: z.string().min(8),
  id: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
});

// Endpoint protegido por la variable SETUP_SECRET para crear el primer admin.
app.http("setupFirstAdmin", {
  route: "setup/first-admin",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req: HttpRequest): Promise<HttpResponseInit> => {
    try {
      const expected = process.env.SETUP_SECRET;
      if (!expected) return forbidden("La inicialización está deshabilitada.");
      const body = await req.json();
      const parsed = SetupSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (parsed.data.setupSecret !== expected) return forbidden("Clave de inicialización incorrecta.");

      const container = getContainer("users");
      const now = new Date().toISOString();
      const record: UserRecord = {
        id: parsed.data.id,
        displayName: parsed.data.displayName,
        email: parsed.data.email,
        roles: ["admin"],
        active: true,
        createdAt: now,
        createdBy: "system",
        updatedAt: now,
        updatedBy: "system",
        lastLoginAt: null,
      };
      try {
        await container.items.create(record);
      } catch (e: any) {
        if (e?.code === 409) {
          // Ya existe: actualízalo agregando rol admin si no lo tiene.
          const { resource } = await container.item(record.id, record.id).read<UserRecord>();
          if (resource) {
            const roles = Array.from(new Set([...(resource.roles ?? []), "admin"]));
            const updated = { ...resource, roles, active: true, updatedAt: now, updatedBy: "system" };
            await container.item(record.id, record.id).replace(updated);
            return ok(updated);
          }
        }
        throw e;
      }
      await writeAuditLog({ entityType: "user", entityId: record.id, action: "user_created", performedBy: "system", performedByEmail: "system", after: record, metadata: { firstAdmin: true } });
      return created(record);
    } catch (e) {
      return serverError(e);
    }
  },
});
