import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canCreatePublicFile,
  canDeletePublicFile,
  canEditPublicFile,
  canReplacePublicFile,
  canViewPublicFilesAdmin,
} from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { decodePublicInlineFile } from "../lib/publicDownloadFiles";
import {
  createPrivateObjectUrl,
  deletePrivateObjectIfUnreferenced,
  isObjectStorageConfigured,
  storePrivateObject,
  type PrivateObjectLocator,
} from "../lib/objectStorage";
import { readSqlPublicFiles } from "../lib/publicFilesSqlRepository";
import {
  createSqlPublicFile,
  deleteSqlPublicFile,
  updateSqlPublicFile,
} from "../lib/publicFilesSqlWriteRepository";
import type { PublicFileRecord } from "../types/models";

const PublicFileSchema = z.object({
  titulo: z.string().min(1, "El título del archivo es obligatorio.").max(180),
  slug: z.string().max(140).optional(),
  descripcion: z.string().max(1200).optional(),
  activo: z.boolean().default(true),
  archivoBase64: z.string().min(1, "El archivo es obligatorio."),
  archivoNombreOriginal: z.string().min(1, "El nombre del archivo es obligatorio.").max(240),
  archivoMimeType: z.string().max(160).optional(),
});

const PublicFileUpdateSchema = PublicFileSchema.partial();

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("es-CO");
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return slug || `archivo-${randomUUID().slice(0, 8)}`;
}

function decodeFile(input: { archivoBase64: string; archivoNombreOriginal: string; archivoMimeType?: string }) {
  try {
    return decodePublicInlineFile(input);
  } catch (error) {
    return badRequest((error as Error).message);
  }
}

function isHttpResponse(value: unknown): value is HttpResponseInit {
  return typeof (value as HttpResponseInit)?.status === "number";
}

function sanitizePublicFile(record: PublicFileRecord) {
  const {
    archivoStorageBucket, archivoObjectKey, archivoObjectEtag,
    archivoStorageContainer, archivoBlobName, archivoBlobEtag, archivoSha256,
    archivoStorageProvider, ...rest
  } = record;
  return { ...rest, viewUrl: `/api/public/files/${record.slug}` };
}

async function storedFileFields(file: ReturnType<typeof decodePublicInlineFile>): Promise<Partial<PublicFileRecord>> {
  if (!isObjectStorageConfigured()) {
    throw Object.assign(new Error("Configure el almacenamiento de archivos antes de guardar archivos públicos."), { status: 503 });
  }
  const stored = await storePrivateObject(file);
  return {
    assetKind: file.assetKind,
    archivoNombreOriginal: file.filename,
    archivoMimeType: file.mimeType,
    archivoBytes: file.byteCount,
    archivoStorageProvider: stored.storageProvider,
    ...(stored.storageProvider === "s3"
      ? {
          archivoStorageBucket: stored.storageBucket,
          archivoObjectKey: stored.storageObjectKey,
          archivoObjectEtag: stored.storageObjectEtag,
        }
      : {
          archivoStorageContainer: stored.storageContainer,
          archivoBlobName: stored.storageBlobName,
          archivoBlobEtag: stored.storageBlobEtag,
        }),
    archivoSha256: stored.storageSha256,
  };
}

function objectLocator(record: Partial<PublicFileRecord>): PrivateObjectLocator | null {
  if (record.archivoStorageProvider === "s3" && record.archivoStorageBucket && record.archivoObjectKey) {
    return {
      storageProvider: "s3",
      storageBucket: record.archivoStorageBucket,
      storageObjectKey: record.archivoObjectKey,
      storageObjectEtag: record.archivoObjectEtag,
    };
  }
  if (record.archivoStorageProvider === "azure_blob" && record.archivoStorageContainer && record.archivoBlobName) {
    return {
      storageProvider: "azure_blob",
      storageContainer: record.archivoStorageContainer,
      storageBlobName: record.archivoBlobName,
      storageBlobEtag: record.archivoBlobEtag,
    };
  }
  return null;
}

async function compensateUnreferencedObject(record: Partial<PublicFileRecord>): Promise<void> {
  const locator = objectLocator(record);
  if (!locator) return;
  try {
    await deletePrivateObjectIfUnreferenced(locator);
  } catch {
    // The SQL failure remains authoritative; the orphan scan can retry cleanup.
  }
}

async function readFiles(): Promise<PublicFileRecord[]> {
  return (await readSqlPublicFiles()).sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));
}

async function readFile(id: string): Promise<PublicFileRecord | null> {
  return (await readFiles()).find((record) => record.id === id) ?? null;
}

async function hasDuplicateSlug(slug: string, exceptId?: string): Promise<boolean> {
  return (await readFiles()).some((item) => item.id !== exceptId && normalize(item.slug) === normalize(slug));
}

async function inlineResponse(record: PublicFileRecord): Promise<HttpResponseInit> {
  const locator = objectLocator(record);
  if (!locator) {
    throw new Error("El archivo público no tiene una ubicación de almacenamiento válida.");
  }
  return {
    status: 302,
    headers: {
      Location: await createPrivateObjectUrl({
        ...locator,
        mimeType: record.archivoMimeType,
        filename: record.archivoNombreOriginal,
        disposition: "inline",
      }),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  };
}

app.http("adminPublicFilesList", {
  route: "public-files/admin",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPublicFilesAdmin(user, await loadRoleDefinitions())) return forbidden();
      return ok((await readFiles()).map(sanitizePublicFile));
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("adminPublicFilesCreate", {
  route: "public-files/admin",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canCreatePublicFile(user, await loadRoleDefinitions())) return forbidden();
      const parsed = PublicFileSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const file = decodeFile(parsed.data);
      if (isHttpResponse(file)) return file;
      const slug = slugify(parsed.data.slug || parsed.data.titulo);
      if (await hasDuplicateSlug(slug)) return conflict("Ya existe un archivo público con este endpoint.");
      const now = new Date().toISOString();
      const fields = await storedFileFields(file);
      const record: PublicFileRecord = {
        id: `public_file_${randomUUID()}`,
        titulo: parsed.data.titulo.trim(),
        slug,
        descripcion: parsed.data.descripcion?.trim() || undefined,
        ...(fields as Pick<PublicFileRecord,
          "assetKind" | "archivoNombreOriginal" | "archivoMimeType" | "archivoBytes">),
        activo: parsed.data.activo,
        status: parsed.data.activo ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      try {
        return created(sanitizePublicFile(await createSqlPublicFile(record, { id: user.id, email: user.email })));
      } catch (error) {
        await compensateUnreferencedObject(record);
        throw error;
      }
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("adminPublicFilesUpdate", {
  route: "public-files/admin/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roles = await loadRoleDefinitions();
      const body = await req.json() as Record<string, unknown>;
      const replacingFile = body && (
        body.archivoBase64 !== undefined ||
        body.archivoNombreOriginal !== undefined ||
        body.archivoMimeType !== undefined
      );
      if (!canEditPublicFile(user, roles)) return forbidden();
      if (replacingFile && !canReplacePublicFile(user, roles)) return forbidden();
      const current = await readFile(req.params.id);
      if (!current) return notFound("Archivo público no encontrado.");
      const parsed = PublicFileUpdateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const nextSlug = parsed.data.slug !== undefined || parsed.data.titulo !== undefined
        ? slugify(parsed.data.slug || parsed.data.titulo || current.slug)
        : current.slug;
      if (await hasDuplicateSlug(nextSlug, current.id)) return conflict("Ya existe un archivo público con este endpoint.");
      let fileFields: Partial<PublicFileRecord> = {};
      if (replacingFile) {
        if (!parsed.data.archivoBase64 || !parsed.data.archivoNombreOriginal) {
          return badRequest("Para reemplazar el archivo debe enviar archivo y nombre.");
        }
        const file = decodeFile({
          archivoBase64: parsed.data.archivoBase64,
          archivoNombreOriginal: parsed.data.archivoNombreOriginal,
          archivoMimeType: parsed.data.archivoMimeType,
        });
        if (isHttpResponse(file)) return file;
        fileFields = await storedFileFields(file);
      }
      const updated: PublicFileRecord = {
        ...current,
        ...(parsed.data.titulo !== undefined ? { titulo: parsed.data.titulo.trim() } : {}),
        slug: nextSlug,
        ...(parsed.data.descripcion !== undefined ? { descripcion: parsed.data.descripcion.trim() || undefined } : {}),
        ...(parsed.data.activo !== undefined
          ? { activo: parsed.data.activo, status: parsed.data.activo ? "active" : "inactive" }
          : {}),
        ...fileFields,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      try {
        const result = await updateSqlPublicFile(current, updated, { id: user.id, email: user.email }, replacingFile);
        if (!result && replacingFile) await compensateUnreferencedObject(updated);
        return result ? ok(sanitizePublicFile(result)) : notFound("Archivo público no encontrado.");
      } catch (error) {
        if (replacingFile) await compensateUnreferencedObject(updated);
        throw error;
      }
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("adminPublicFilesDelete", {
  route: "public-files/admin/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canDeletePublicFile(user, await loadRoleDefinitions())) return forbidden();
      const current = await readFile(req.params.id);
      if (!current) return notFound("Archivo público no encontrado.");
      return (await deleteSqlPublicFile(current, { id: user.id, email: user.email }))
        ? ok({ ok: true }) : notFound("Archivo público no encontrado.");
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("publicFilesList", {
  route: "public/files",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => {
    try {
      return ok((await readFiles()).filter((record) => record.activo).map(sanitizePublicFile));
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("publicFileBySlug", {
  route: "public/files/{fileSlug}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const record = (await readFiles()).find((item) =>
        item.activo && normalize(item.slug) === normalize(req.params.fileSlug)
      );
      return record ? inlineResponse(record) : notFound("Archivo público no encontrado.");
    } catch (error) {
      return serverError(error);
    }
  },
});
