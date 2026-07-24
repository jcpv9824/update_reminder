import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canCreatePublicDownloadDocument,
  canDeletePublicDownloadDocument,
  canEditPublicDownloadDocument,
  canReplacePublicDownloadFile,
  canViewPublicDownloadsAdmin,
} from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { decodePublicDownloadFile } from "../lib/publicDownloadFiles";
import {
  createPrivateObjectUrl,
  deletePrivateObjectIfUnreferenced,
  isObjectStorageConfigured,
  storePrivateObject,
} from "../lib/objectStorage";
import { readSqlPublicDownloads } from "../lib/publicDownloadsSqlRepository";
import {
  createSqlPublicDownload,
  deleteSqlPublicDownload,
  updateSqlPublicDownload,
} from "../lib/publicDownloadsSqlWriteRepository";
import type { PublicDownloadDocumentRecord } from "../types/models";

const DownloadSchema = z.object({
  titulo: z.string().min(1, "El título del archivo es obligatorio.").max(180),
  slug: z.string().max(140).optional(),
  descripcion: z.string().max(1200).optional(),
  activo: z.boolean().default(true),
  archivoBase64: z.string().min(1, "El archivo es obligatorio."),
  archivoNombreOriginal: z.string().min(1, "El nombre del archivo es obligatorio.").max(240),
  archivoMimeType: z.string().max(160).optional(),
});

const DownloadUpdateSchema = DownloadSchema.partial();

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
  return slug || `descarga-${randomUUID().slice(0, 8)}`;
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "-");
}

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function decodeFile(input: { archivoBase64: string; archivoNombreOriginal: string; archivoMimeType?: string }) {
  try {
    return decodePublicDownloadFile(input);
  } catch (error) {
    return badRequest((error as Error).message);
  }
}

function isHttpResponse(value: unknown): value is HttpResponseInit {
  return typeof (value as HttpResponseInit)?.status === "number";
}

function sanitizeDownload(record: PublicDownloadDocumentRecord) {
  const {
    type, archivoBase64, archivoStorageBucket, archivoObjectKey, archivoObjectEtag, archivoSha256,
    archivoStorageProvider,
    _rid, _self, _etag, _attachments, _ts, ...rest
  } = record as PublicDownloadDocumentRecord & Record<string, unknown>;
  return {
    ...rest,
    assetKind: record.assetKind ?? (record.archivoMimeType.toLowerCase().startsWith("video/") ? "video" : "document"),
    downloadUrl: `/api/public/downloads/${record.slug}`,
    legacyDownloadUrl: `/api/public/descargas/${record.slug}`,
  };
}

async function storedFileFields(file: ReturnType<typeof decodePublicDownloadFile>): Promise<Partial<PublicDownloadDocumentRecord>> {
  const shared = {
    assetKind: file.assetKind,
    archivoNombreOriginal: file.filename,
    archivoMimeType: file.mimeType,
    archivoBytes: file.byteCount,
    archivoSha256: file.sha256,
  };
  if (!isObjectStorageConfigured()) {
    throw Object.assign(new Error("Configure el almacenamiento de archivos antes de guardar descargas públicas."), { status: 503 });
  }
  const stored = await storePrivateObject(file);
  return {
    ...shared,
    archivoStorageProvider: stored.storageProvider,
    archivoStorageBucket: stored.storageBucket,
    archivoObjectKey: stored.storageObjectKey,
    archivoObjectEtag: stored.storageObjectEtag,
    archivoSha256: stored.storageSha256,
    archivoBase64: undefined,
  };
}

async function compensateUnreferencedObject(record: Partial<PublicDownloadDocumentRecord>): Promise<void> {
  if (record.archivoStorageProvider !== "s3" || !record.archivoStorageBucket || !record.archivoObjectKey) return;
  try {
    await deletePrivateObjectIfUnreferenced({ bucket: record.archivoStorageBucket, objectKey: record.archivoObjectKey });
  } catch {
    // The SQL failure remains authoritative; the orphan scan can retry cleanup.
  }
}

async function readDownloads(): Promise<PublicDownloadDocumentRecord[]> {
  return (await readSqlPublicDownloads()).sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));
}

async function readDownload(id: string): Promise<PublicDownloadDocumentRecord | null> {
  return (await readDownloads()).find((record) => record.id === id) ?? null;
}

async function hasDuplicateSlug(slug: string, exceptId?: string): Promise<boolean> {
  return (await readDownloads()).some((item) => item.id !== exceptId && normalize(item.slug) === normalize(slug));
}

async function forcedDownloadResponse(record: PublicDownloadDocumentRecord): Promise<HttpResponseInit> {
  if (record.archivoStorageProvider === "s3" && record.archivoStorageBucket && record.archivoObjectKey) {
    return {
      status: 302,
      headers: {
        Location: await createPrivateObjectUrl({
          bucket: record.archivoStorageBucket,
          objectKey: record.archivoObjectKey,
          mimeType: record.archivoMimeType,
          filename: record.archivoNombreOriginal,
          disposition: "attachment",
        }),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    };
  }
  if (!record.archivoBase64) throw new Error("El archivo no tiene una ubicación de almacenamiento válida.");
  const bytes = Buffer.from(record.archivoBase64, "base64");
  const asciiFallback = sanitizeFileName(record.archivoNombreOriginal.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
  return {
    status: 200,
    body: bytes,
    headers: {
      "Content-Type": record.archivoMimeType || "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeContentDispositionFilename(record.archivoNombreOriginal)}`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  };
}

app.http("adminPublicDownloadsList", {
  route: "public-downloads/admin/files",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPublicDownloadsAdmin(user, await loadRoleDefinitions())) return forbidden();
      return ok((await readDownloads()).map(sanitizeDownload));
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("adminPublicDownloadsCreate", {
  route: "public-downloads/admin/files",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canCreatePublicDownloadDocument(user, await loadRoleDefinitions())) return forbidden();
      const parsed = DownloadSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const file = decodeFile(parsed.data);
      if (isHttpResponse(file)) return file;
      const slug = slugify(parsed.data.slug || parsed.data.titulo);
      if (await hasDuplicateSlug(slug)) return conflict("Ya existe una descarga con este endpoint.");
      const now = new Date().toISOString();
      const fileFields = await storedFileFields(file);
      const record: PublicDownloadDocumentRecord & { type: "document" } = {
        type: "document",
        id: `public_download_${randomUUID()}`,
        titulo: parsed.data.titulo.trim(),
        slug,
        descripcion: parsed.data.descripcion?.trim() || undefined,
        ...(fileFields as Pick<PublicDownloadDocumentRecord,
          "assetKind" | "archivoNombreOriginal" | "archivoMimeType" | "archivoBytes">),
        activo: parsed.data.activo,
        status: parsed.data.activo ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      try {
        return created(sanitizeDownload(await createSqlPublicDownload(record, { id: user.id, email: user.email })));
      } catch (error) {
        await compensateUnreferencedObject(record);
        throw error;
      }
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("adminPublicDownloadsUpdate", {
  route: "public-downloads/admin/files/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      const body = await req.json() as Record<string, unknown>;
      const replacingFile = body && (
        body.archivoBase64 !== undefined ||
        body.archivoNombreOriginal !== undefined ||
        body.archivoMimeType !== undefined
      );
      if (!canEditPublicDownloadDocument(user, roleDefinitions)) return forbidden();
      if (replacingFile && !canReplacePublicDownloadFile(user, roleDefinitions)) return forbidden();
      const current = await readDownload(req.params.id);
      if (!current) return notFound("Descarga no encontrada.");
      const parsed = DownloadUpdateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const nextSlug = parsed.data.slug !== undefined || parsed.data.titulo !== undefined
        ? slugify(parsed.data.slug || parsed.data.titulo || current.slug)
        : current.slug;
      if (await hasDuplicateSlug(nextSlug, current.id)) return conflict("Ya existe una descarga con este endpoint.");
      let fileFields: Partial<PublicDownloadDocumentRecord> = {};
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
      const updated: PublicDownloadDocumentRecord & { type: "document" } = {
        ...(current as PublicDownloadDocumentRecord & { type: "document" }),
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
        const result = await updateSqlPublicDownload(current, updated, { id: user.id, email: user.email }, replacingFile);
        if (!result && replacingFile) await compensateUnreferencedObject(updated);
        return result ? ok(sanitizeDownload(result)) : notFound("Descarga no encontrada.");
      } catch (error) {
        if (replacingFile) await compensateUnreferencedObject(updated);
        throw error;
      }
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("adminPublicDownloadsDelete", {
  route: "public-downloads/admin/files/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canDeletePublicDownloadDocument(user, await loadRoleDefinitions())) return forbidden();
      const current = await readDownload(req.params.id);
      if (!current) return notFound("Descarga no encontrada.");
      return (await deleteSqlPublicDownload(current, { id: user.id, email: user.email }))
        ? ok({ ok: true }) : notFound("Descarga no encontrada.");
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("publicDownloadsList", {
  route: "public/downloads",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => {
    try {
      return ok((await readDownloads()).filter((record) => record.activo).map(sanitizeDownload));
    } catch (error) {
      return serverError(error);
    }
  },
});

async function findActiveDownload(slug: string): Promise<PublicDownloadDocumentRecord | null> {
  return (await readDownloads()).find((item) => item.activo && normalize(item.slug) === normalize(slug)) ?? null;
}

async function handleDownload(slug: string): Promise<HttpResponseInit> {
  const record = await findActiveDownload(slug);
  return record ? forcedDownloadResponse(record) : notFound("Descarga no encontrada.");
}

app.http("publicDownloadBySlug", {
  route: "public/downloads/{downloadSlug}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      return await handleDownload(req.params.downloadSlug);
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("publicDownloadLegacyBySectionAndSlug", {
  route: "public/downloads/{sectionSlug}/{downloadSlug}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      return await handleDownload(req.params.downloadSlug);
    } catch (error) {
      return serverError(error);
    }
  },
});

app.http("publicDownloadLegacySpanishBySlug", {
  route: "public/descargas/{downloadSlug}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      return await handleDownload(req.params.downloadSlug);
    } catch (error) {
      return serverError(error);
    }
  },
});
