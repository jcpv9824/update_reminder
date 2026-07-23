import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { getDataBackend } from "../lib/dataBackend";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import {
  canCreatePublicDownloadDocument,
  canCreatePublicDownloadSection,
  canDeletePublicDownloadDocument,
  canDeletePublicDownloadSection,
  canEditPublicDownloadDocument,
  canEditPublicDownloadSection,
  canReplacePublicDownloadFile,
  canViewPublicDownloadsAdmin,
} from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import {
  decodePublicDownloadFile,
  MAX_LEGACY_COSMOS_FILE_BYTES,
} from "../lib/publicDownloadFiles";
import {
  createPublicDownloadBlobUrl,
  deletePublicDownloadBlobIfUnreferenced,
  isPublicDownloadBlobStorageConfigured,
  storePublicDownloadBlob,
} from "../lib/publicDownloadStorage";
import { readSqlPublicDownloads } from "../lib/publicDownloadsSqlRepository";
import {
  createSqlPublicDownloadDocument,
  createSqlPublicDownloadSection,
  deleteSqlPublicDownloadDocument,
  deleteSqlPublicDownloadSection,
  updateSqlPublicDownloadDocument,
  updateSqlPublicDownloadSection,
} from "../lib/publicDownloadsSqlWriteRepository";
import type { PublicDownloadDocumentRecord, PublicDownloadSectionRecord } from "../types/models";

const CONTAINER = "publicDownloads";

const SectionSchema = z.object({
  nombre: z.string().min(1, "El nombre de la sección es obligatorio.").max(160),
  slug: z.string().max(120).optional(),
  descripcion: z.string().max(1000).optional(),
  activa: z.boolean().default(true),
});

const SectionUpdateSchema = SectionSchema.partial();

const DocumentSchema = z.object({
  sectionId: z.string().min(1, "La sección es obligatoria."),
  titulo: z.string().min(1, "El título del archivo es obligatorio.").max(180),
  slug: z.string().max(140).optional(),
  descripcion: z.string().max(1200).optional(),
  activo: z.boolean().default(true),
  archivoBase64: z.string().min(1, "El archivo es obligatorio."),
  archivoNombreOriginal: z.string().min(1, "El nombre del archivo es obligatorio.").max(240),
  archivoMimeType: z.string().max(160).optional(),
});

const DocumentUpdateSchema = DocumentSchema.partial().extend({
  sectionId: z.string().min(1).optional(),
});

type PublicDownloadRecord = PublicDownloadSectionRecord | PublicDownloadDocumentRecord;

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

function sanitizeSection(record: PublicDownloadSectionRecord) {
  const { type, _rid, _self, _etag, _attachments, _ts, ...rest } = record as PublicDownloadSectionRecord & Record<string, unknown>;
  return rest;
}

function sanitizeDocument(record: PublicDownloadDocumentRecord) {
  const {
    type, archivoBase64, archivoBlobContainer, archivoBlobName, archivoBlobEtag, archivoSha256,
    archivoStorageProvider, _rid, _self, _etag, _attachments, _ts, ...rest
  } = record as PublicDownloadDocumentRecord & Record<string, unknown>;
  return {
    ...rest,
    assetKind: record.assetKind ?? (record.archivoMimeType.toLowerCase().startsWith("video/") ? "video" : "document"),
    downloadUrl: `/api/public/downloads/${record.sectionSlug}/${record.slug}`,
    legacyDownloadUrl: `/api/public/descargas/${record.slug}`,
  };
}

function auditDocument(record: PublicDownloadDocumentRecord) {
  const sanitized = sanitizeDocument(record);
  const { downloadUrl, legacyDownloadUrl, ...snapshot } = sanitized;
  return snapshot;
}

async function storedFileFields(file: ReturnType<typeof decodePublicDownloadFile>): Promise<Partial<PublicDownloadDocumentRecord>> {
  const shared = {
    assetKind: file.assetKind,
    archivoNombreOriginal: file.filename,
    archivoMimeType: file.mimeType,
    archivoBytes: file.byteCount,
    archivoSha256: file.sha256,
  };
  if (isPublicDownloadBlobStorageConfigured()) {
    return {
      ...shared,
      ...(await storePublicDownloadBlob(file)),
      archivoBase64: undefined,
    };
  }
  if (getDataBackend() === "sql") {
    throw Object.assign(new Error("Configure Azure Blob Storage antes de guardar archivos en SQL."), { status: 503 });
  }
  if (file.assetKind === "video" || file.byteCount > MAX_LEGACY_COSMOS_FILE_BYTES) {
    throw Object.assign(new Error("Configure el almacenamiento privado de archivos para cargar videos o archivos de este tamaño."), { status: 503 });
  }
  return { ...shared, archivoBase64: file.bytes.toString("base64") };
}

async function compensateUnreferencedBlob(record: Partial<PublicDownloadDocumentRecord>): Promise<void> {
  if (record.archivoStorageProvider !== "azure_blob" || !record.archivoBlobContainer || !record.archivoBlobName) return;
  try {
    await deletePublicDownloadBlobIfUnreferenced({
      containerName: record.archivoBlobContainer,
      blobName: record.archivoBlobName,
    });
  } catch {
    // The database error remains authoritative; an orphan scan can retry cleanup if SQL was unavailable.
  }
}

async function readAllCosmos(): Promise<PublicDownloadRecord[]> {
  const { resources } = await getContainer(CONTAINER).items.readAll<PublicDownloadRecord>().fetchAll();
  return resources.filter((item: any) => item.status !== "deleted");
}

function parityView(records: PublicDownloadRecord[]) {
  return records.map((record) => ("sectionId" in record ? {
    type: "document", id: record.id, sectionId: record.sectionId, sectionSlug: record.sectionSlug,
    titulo: record.titulo, slug: record.slug, descripcion: record.descripcion ?? null,
    assetKind: record.assetKind ?? (record.archivoMimeType.startsWith("video/") ? "video" : "document"),
    archivoNombreOriginal: record.archivoNombreOriginal, archivoMimeType: record.archivoMimeType,
    archivoBytes: record.archivoBytes, activo: record.activo, status: record.status,
  } : {
    type: "section", id: record.id, nombre: record.nombre, slug: record.slug,
    descripcion: record.descripcion ?? null, activa: record.activa, status: record.status,
  })).sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`, "en"));
}

async function readAll(): Promise<PublicDownloadRecord[]> {
  const backend = getDataBackend();
  if (backend === "sql") return readSqlPublicDownloads();
  const cosmos = await readAllCosmos();
  if (backend === "dual-read") {
    const sqlRecords = await readSqlPublicDownloads();
    if (JSON.stringify(parityView(cosmos)) !== JSON.stringify(parityView(sqlRecords))) {
      console.warn("Public Downloads dual-read parity mismatch.");
    }
  }
  return cosmos;
}

async function readSections(): Promise<PublicDownloadSectionRecord[]> {
  return (await readAll())
    .filter((item): item is PublicDownloadSectionRecord => (item as any).type === "section")
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

async function readDocuments(): Promise<PublicDownloadDocumentRecord[]> {
  return (await readAll())
    .filter((item): item is PublicDownloadDocumentRecord => (item as any).type === "document")
    .sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));
}

async function readSection(id: string): Promise<PublicDownloadSectionRecord | null> {
  if (getDataBackend() === "sql") return (await readSections()).find((section) => section.id === id) ?? null;
  const { resource } = await getContainer(CONTAINER).item(id, id).read<PublicDownloadSectionRecord>();
  return resource && (resource as any).type === "section" && resource.status !== "deleted" ? resource : null;
}

async function readDocument(id: string): Promise<PublicDownloadDocumentRecord | null> {
  if (getDataBackend() === "sql") return (await readDocuments()).find((document) => document.id === id) ?? null;
  const { resource } = await getContainer(CONTAINER).item(id, id).read<PublicDownloadDocumentRecord>();
  return resource && (resource as any).type === "document" && resource.status !== "deleted" ? resource : null;
}

async function hasDuplicateSectionSlug(slug: string, exceptId?: string): Promise<boolean> {
  return (await readSections()).some((item) => item.id !== exceptId && normalize(item.slug) === normalize(slug));
}

async function hasDuplicateDocumentSlug(slug: string, exceptId?: string): Promise<boolean> {
  return (await readDocuments()).some((item) => item.id !== exceptId && normalize(item.slug) === normalize(slug));
}

async function syncSectionNameOnDocuments(section: PublicDownloadSectionRecord): Promise<void> {
  const docs = (await readDocuments()).filter((doc) => doc.sectionId === section.id);
  await Promise.all(docs.map((doc) => getContainer(CONTAINER).item(doc.id, doc.id).replace({
    ...doc,
    sectionName: section.nombre,
    sectionSlug: section.slug,
    updatedAt: section.updatedAt,
    updatedBy: section.updatedBy,
  })));
}

async function downloadResponse(record: PublicDownloadDocumentRecord): Promise<HttpResponseInit> {
  if (record.archivoBlobContainer && record.archivoBlobName) {
    return {
      status: 302,
      headers: {
        Location: await createPublicDownloadBlobUrl({
          containerName: record.archivoBlobContainer,
          blobName: record.archivoBlobName,
          mimeType: record.archivoMimeType,
          filename: record.archivoNombreOriginal,
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

app.http("adminPublicDownloadSectionsList", {
  route: "public-downloads/admin/sections",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPublicDownloadsAdmin(user, await loadRoleDefinitions())) return forbidden();
      return ok((await readSections()).map(sanitizeSection));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadSectionsCreate", {
  route: "public-downloads/admin/sections",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canCreatePublicDownloadSection(user, await loadRoleDefinitions())) return forbidden();
      const parsed = SectionSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const slug = slugify(parsed.data.slug || parsed.data.nombre);
      if (await hasDuplicateSectionSlug(slug)) return conflict("Ya existe una sección con este endpoint.");
      const now = new Date().toISOString();
      const record: PublicDownloadSectionRecord & { type: "section" } = {
        type: "section",
        id: `public_download_section_${randomUUID()}`,
        nombre: parsed.data.nombre.trim(),
        slug,
        descripcion: parsed.data.descripcion?.trim() || undefined,
        activa: parsed.data.activa,
        status: parsed.data.activa ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      if (getDataBackend() === "sql") {
        return created(sanitizeSection(await createSqlPublicDownloadSection(record, { id: user.id, email: user.email })));
      }
      await getContainer(CONTAINER).items.create(record);
      await writeAuditLog({ entityType: "publicDownloadSection", entityId: record.id, action: "public_download_section_created", performedBy: user.id, performedByEmail: user.email, after: record });
      return created(sanitizeSection(record));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadSectionsUpdate", {
  route: "public-downloads/admin/sections/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canEditPublicDownloadSection(user, await loadRoleDefinitions())) return forbidden();
      const current = await readSection(req.params.id);
      if (!current) return notFound("Sección no encontrada.");
      const parsed = SectionUpdateSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const nextSlug = parsed.data.slug !== undefined || parsed.data.nombre !== undefined
        ? slugify(parsed.data.slug || parsed.data.nombre || current.slug)
        : current.slug;
      if (await hasDuplicateSectionSlug(nextSlug, current.id)) return conflict("Ya existe una sección con este endpoint.");
      const before = { ...current };
      const updated: PublicDownloadSectionRecord & { type: "section" } = {
        ...(current as PublicDownloadSectionRecord & { type: "section" }),
        ...(parsed.data.nombre !== undefined ? { nombre: parsed.data.nombre.trim() } : {}),
        slug: nextSlug,
        ...(parsed.data.descripcion !== undefined ? { descripcion: parsed.data.descripcion.trim() || undefined } : {}),
        ...(parsed.data.activa !== undefined ? { activa: parsed.data.activa, status: parsed.data.activa ? "active" : "inactive" } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      if (getDataBackend() === "sql") {
        const result = await updateSqlPublicDownloadSection(updated, { id: user.id, email: user.email });
        return result ? ok(sanitizeSection(result)) : notFound("Sección no encontrada.");
      }
      await getContainer(CONTAINER).item(updated.id, updated.id).replace(updated);
      if (before.nombre !== updated.nombre || before.slug !== updated.slug) await syncSectionNameOnDocuments(updated);
      await writeAuditLog({ entityType: "publicDownloadSection", entityId: updated.id, action: "public_download_section_updated", performedBy: user.id, performedByEmail: user.email, before, after: updated });
      return ok(sanitizeSection(updated));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadSectionsDelete", {
  route: "public-downloads/admin/sections/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canDeletePublicDownloadSection(user, await loadRoleDefinitions())) return forbidden();
      const current = await readSection(req.params.id);
      if (!current) return notFound("Sección no encontrada.");
      if (getDataBackend() === "sql") {
        const result = await deleteSqlPublicDownloadSection(current.id, { id: user.id, email: user.email });
        if (!result.found) return notFound("Sección no encontrada.");
        if (result.documents) return conflict("No se puede eliminar la sección porque tiene documentos asociados.", { dependencies: { documents: result.documents } });
        return ok({ ok: true });
      }
      const docs = (await readDocuments()).filter((doc) => doc.sectionId === current.id);
      if (docs.length > 0) return conflict("No se puede eliminar la sección porque tiene documentos asociados.", { dependencies: { documents: docs.length } });
      const deleted = { ...(current as PublicDownloadSectionRecord & { type: "section" }), activa: false, status: "deleted" as const, deletedAt: new Date().toISOString(), deletedBy: user.id, updatedAt: new Date().toISOString(), updatedBy: user.id };
      await getContainer(CONTAINER).item(deleted.id, deleted.id).replace(deleted);
      await writeAuditLog({ entityType: "publicDownloadSection", entityId: deleted.id, action: "public_download_section_deleted", performedBy: user.id, performedByEmail: user.email, before: current, after: deleted });
      return ok({ ok: true });
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadDocumentsList", {
  route: "public-downloads/admin/documents",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPublicDownloadsAdmin(user, await loadRoleDefinitions())) return forbidden();
      return ok((await readDocuments()).map(sanitizeDocument));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadDocumentsCreate", {
  route: "public-downloads/admin/documents",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canCreatePublicDownloadDocument(user, await loadRoleDefinitions())) return forbidden();
      const parsed = DocumentSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const section = await readSection(parsed.data.sectionId);
      if (!section) return badRequest("La sección seleccionada no existe.");
      if (!section.activa) return badRequest("Solo puede crear archivos en secciones activas.");
      const file = decodeFile(parsed.data);
      if (isHttpResponse(file)) return file;
      const slug = slugify(parsed.data.slug || parsed.data.titulo);
      if (await hasDuplicateDocumentSlug(slug)) return conflict("Ya existe un documento con este endpoint.");
      const now = new Date().toISOString();
      const fileFields = await storedFileFields(file);
      const record: PublicDownloadDocumentRecord & { type: "document" } = {
        type: "document",
        id: `public_download_document_${randomUUID()}`,
        sectionId: section.id,
        sectionName: section.nombre,
        sectionSlug: section.slug,
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
      if (getDataBackend() === "sql") {
        try {
          return created(sanitizeDocument(await createSqlPublicDownloadDocument(record, { id: user.id, email: user.email })));
        } catch (error) {
          await compensateUnreferencedBlob(record);
          throw error;
        }
      }
      await getContainer(CONTAINER).items.create(record);
      await writeAuditLog({ entityType: "publicDownloadDocument", entityId: record.id, action: "public_download_document_created", performedBy: user.id, performedByEmail: user.email, after: auditDocument(record), metadata: { fileLoaded: true, assetKind: record.assetKind } });
      return created(sanitizeDocument(record));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadDocumentsUpdate", {
  route: "public-downloads/admin/documents/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      const body = await req.json() as any;
      const replacingFile = body && (body.archivoBase64 !== undefined || body.archivoNombreOriginal !== undefined || body.archivoMimeType !== undefined);
      if (!canEditPublicDownloadDocument(user, roleDefinitions)) return forbidden();
      if (replacingFile && !canReplacePublicDownloadFile(user, roleDefinitions)) return forbidden();
      const current = await readDocument(req.params.id);
      if (!current) return notFound("Archivo no encontrado.");
      const parsed = DocumentUpdateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const section = parsed.data.sectionId ? await readSection(parsed.data.sectionId) : await readSection(current.sectionId);
      if (!section) return badRequest("La sección seleccionada no existe.");
      if (parsed.data.sectionId && !section.activa) return badRequest("Solo puede mover archivos a secciones activas.");
      const nextSlug = parsed.data.slug !== undefined || parsed.data.titulo !== undefined
        ? slugify(parsed.data.slug || parsed.data.titulo || current.slug)
        : current.slug;
      if (await hasDuplicateDocumentSlug(nextSlug, current.id)) return conflict("Ya existe un documento con este endpoint.");
      let fileFields: Partial<PublicDownloadDocumentRecord> = {};
      let replacedFile = false;
      if (parsed.data.archivoBase64 !== undefined || parsed.data.archivoNombreOriginal !== undefined || parsed.data.archivoMimeType !== undefined) {
        if (!parsed.data.archivoBase64 || !parsed.data.archivoNombreOriginal) return badRequest("Para reemplazar el archivo debe enviar archivo y nombre.");
        const file = decodeFile({
          archivoBase64: parsed.data.archivoBase64,
          archivoNombreOriginal: parsed.data.archivoNombreOriginal,
          archivoMimeType: parsed.data.archivoMimeType,
        });
        if (isHttpResponse(file)) return file;
        fileFields = await storedFileFields(file);
        replacedFile = true;
      }
      const before = auditDocument(current);
      const updated: PublicDownloadDocumentRecord & { type: "document" } = {
        ...(current as PublicDownloadDocumentRecord & { type: "document" }),
        sectionId: section.id,
        sectionName: section.nombre,
        sectionSlug: section.slug,
        ...(parsed.data.titulo !== undefined ? { titulo: parsed.data.titulo.trim() } : {}),
        slug: nextSlug,
        ...(parsed.data.descripcion !== undefined ? { descripcion: parsed.data.descripcion.trim() || undefined } : {}),
        ...(parsed.data.activo !== undefined ? { activo: parsed.data.activo, status: parsed.data.activo ? "active" : "inactive" } : {}),
        ...fileFields,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      if (getDataBackend() === "sql") {
        try {
          const result = await updateSqlPublicDownloadDocument(current, updated, { id: user.id, email: user.email }, replacedFile);
          if (!result && replacedFile) await compensateUnreferencedBlob(updated);
          return result ? ok(sanitizeDocument(result)) : notFound("Archivo no encontrado.");
        } catch (error) {
          if (replacedFile) await compensateUnreferencedBlob(updated);
          throw error;
        }
      }
      await getContainer(CONTAINER).item(updated.id, updated.id).replace(updated);
      await writeAuditLog({
        entityType: "publicDownloadDocument",
        entityId: updated.id,
        action: replacedFile ? "public_download_document_file_replaced" : "public_download_document_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: auditDocument(updated),
        metadata: replacedFile ? { previousFileName: before.archivoNombreOriginal, newFileName: updated.archivoNombreOriginal, assetKind: updated.assetKind } : undefined,
      });
      return ok(sanitizeDocument(updated));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminPublicDownloadDocumentsDelete", {
  route: "public-downloads/admin/documents/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canDeletePublicDownloadDocument(user, await loadRoleDefinitions())) return forbidden();
      const current = await readDocument(req.params.id);
      if (!current) return notFound("Archivo no encontrado.");
      if (getDataBackend() === "sql") {
        return (await deleteSqlPublicDownloadDocument(current, { id: user.id, email: user.email }))
          ? ok({ ok: true }) : notFound("Archivo no encontrado.");
      }
      const deleted = { ...(current as PublicDownloadDocumentRecord & { type: "document" }), activo: false, status: "deleted" as const, deletedAt: new Date().toISOString(), deletedBy: user.id, updatedAt: new Date().toISOString(), updatedBy: user.id };
      await getContainer(CONTAINER).item(deleted.id, deleted.id).replace(deleted);
      await writeAuditLog({ entityType: "publicDownloadDocument", entityId: deleted.id, action: "public_download_document_deleted", performedBy: user.id, performedByEmail: user.email, before: auditDocument(current), after: auditDocument(deleted) });
      return ok({ ok: true });
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicDownloadsList", {
  route: "public/downloads",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => {
    try {
      const sections = (await readSections()).filter((section) => section.activa);
      const docs = (await readDocuments()).filter((doc) => doc.activo);
      return ok(sections.map((section) => ({
        ...sanitizeSection(section),
        documents: docs.filter((doc) => doc.sectionId === section.id).map(sanitizeDocument),
      })).filter((section) => section.documents.length > 0));
    } catch (e) {
      return serverError(e);
    }
  },
});

async function findActiveDocument(sectionSlug: string | null, documentSlug: string): Promise<PublicDownloadDocumentRecord | null> {
  const docs = await readDocuments();
  const doc = docs.find((item) =>
    item.activo &&
    normalize(item.slug) === normalize(documentSlug) &&
    (!sectionSlug || normalize(item.sectionSlug) === normalize(sectionSlug))
  );
  if (!doc) return null;
  const section = await readSection(doc.sectionId);
  return section?.activa ? doc : null;
}

app.http("publicDownloadBySectionAndSlug", {
  route: "public/downloads/{sectionSlug}/{documentSlug}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const doc = await findActiveDocument(req.params.sectionSlug, req.params.documentSlug);
      if (!doc) return notFound("Documento no encontrado.");
      return await downloadResponse(doc);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicDownloadBySlug", {
  route: "public/descargas/{documentSlug}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const doc = await findActiveDocument(null, req.params.documentSlug);
      if (!doc) return notFound("Documento no encontrado.");
      return await downloadResponse(doc);
    } catch (e) {
      return serverError(e);
    }
  },
});
