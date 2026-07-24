import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import { getPagination, paginateArray } from "../lib/pagination";
import {
  canCreatePrintFormat,
  canCreatePrintFormatSource,
  canDeletePrintFormat,
  canDeletePrintFormatSource,
  canEditPrintFormat,
  canEditPrintFormatSource,
  canReplacePrintFormatPdf,
  canViewPrintFormats,
} from "../lib/managementAccess";
import { loadRoleDefinitions } from "../lib/roleDefinitionStore";
import { readSqlPrintFormats } from "../lib/printFormatsSqlRepository";
import { createPublicDownloadBlobUrl, deletePublicDownloadBlobIfUnreferenced, isPublicDownloadBlobStorageConfigured, storePublicDownloadBlob } from "../lib/publicDownloadStorage";
import { formatHasSource, getFormatSourceIds, getFormatSourceNames, normalizeSourceIds, withFormatSources } from "../lib/printFormatSources";
import type { FormatoImpresionRecord, FuenteFormatoRecord } from "../types/models";
import { findSqlLicenseModule } from "../lib/licensingSqlWriteRepository";
import {
  createSqlPrintFormat,
  createSqlPrintSource,
  deleteSqlPrintFormat,
  deleteSqlPrintSource,
  updateSqlPrintFormat,
  updateSqlPrintSource,
} from "../lib/printFormatsSqlWriteRepository";

const MAX_PDF_BYTES = 1_500_000;
const TamanoFormatoSchema = z.enum(["carta", "oficio", "a4", "legal", "personalizado"]);

const FuenteSchema = z.object({
  nombre: z.string().min(1, "El nombre del tipo de fuente es obligatorio.").max(160),
  activa: z.boolean().default(true),
});

const FuenteUpdateSchema = FuenteSchema.partial();

const PdfSchema = z.object({
  pdfBase64: z.string().min(1, "El PDF es obligatorio."),
  pdfNombreOriginal: z.string().min(1, "El nombre del PDF es obligatorio.").max(240),
});

const FormatoFieldsSchema = z.object({
  nombre: z.string().min(1, "El nombre del formato es obligatorio.").max(200),
  fuenteId: z.string().trim().min(1).optional(),
  fuenteIds: z.array(z.string().trim().min(1)).min(1, "Seleccione al menos un tipo de fuente.").max(50).optional(),
  descripcion: z.string().min(1, "La descripción es obligatoria.").max(1600),
  tamanoFormato: TamanoFormatoSchema.nullable().optional(),
  tamanoFormatoPersonalizado: z.string().trim().max(80).nullable().optional(),
  requiereLicencia: z.boolean().optional(),
  licenciaModuloId: z.string().trim().max(160).nullable().optional(),
  activo: z.boolean().default(true),
});

const FormatoSchema = FormatoFieldsSchema.merge(PdfSchema).refine(
  (value) => Boolean(value.fuenteIds?.length || value.fuenteId),
  { message: "Seleccione al menos un tipo de fuente." }
);

const FormatoUpdateSchema = FormatoFieldsSchema.partial().merge(PdfSchema.partial());

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("es-CO");
}

function sortByNombre<T extends { nombre: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

function sanitizeFuente(record: FuenteFormatoRecord) {
  const { descripcion: _legacyDescription, ...rest } = record as FuenteFormatoRecord & { descripcion?: string };
  return rest;
}

function sanitizeFormato(record: FormatoImpresionRecord) {
  const { pdfBase64, pdfBlobContainer, pdfBlobName, pdfSha256, pdfStorageProvider, ...rest } = record;
  return {
    ...rest,
    fuenteIds: getFormatSourceIds(record),
    fuenteNombres: getFormatSourceNames(record),
    pdfUrl: `/api/public/formatos-impresion/${record.id}/pdf`,
    downloadUrl: `/api/public/formatos-impresion/${record.id}/descargar`,
  };
}

function buildTamanoFormatoFields(input: Partial<z.infer<typeof FormatoFieldsSchema>>): Partial<FormatoImpresionRecord> {
  if (input.tamanoFormato === undefined && input.tamanoFormatoPersonalizado === undefined) return {};
  if (!input.tamanoFormato) return { tamanoFormato: undefined, tamanoFormatoPersonalizado: undefined };
  return {
    tamanoFormato: input.tamanoFormato,
    tamanoFormatoPersonalizado: input.tamanoFormato === "personalizado" ? (input.tamanoFormatoPersonalizado?.trim() || undefined) : undefined,
  };
}

async function buildLicenciaFields(input: {
  requiereLicencia?: boolean;
  licenciaModuloId?: string | null;
}): Promise<Partial<FormatoImpresionRecord> | HttpResponseInit> {
  if (!input.requiereLicencia) {
    return {
      requiereLicencia: false,
      licenciaModuloId: undefined,
      licenciaModuloNombre: undefined,
      licenciaModuloCodigo: undefined,
    };
  }
  const id = input.licenciaModuloId?.trim();
  if (!id) return badRequest("Seleccione el tipo de licencia requerido para el formato.");
  const resource = await findSqlLicenseModule(id);
  if (!resource || resource.status !== "active" || resource.active === false || resource.deletedAt) {
    return badRequest("El tipo de licencia seleccionado no está activo.");
  }
  return {
    requiereLicencia: true,
    licenciaModuloId: resource.id,
    licenciaModuloNombre: resource.name,
    licenciaModuloCodigo: resource.code,
  };
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "formato"}.pdf`;
}

function sanitizePdfName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "-");
}

function validatePdf(input: z.infer<typeof PdfSchema>): Buffer | HttpResponseInit {
  if (!input.pdfNombreOriginal.toLowerCase().endsWith(".pdf")) {
    return badRequest("Solo se aceptan archivos PDF.");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.pdfBase64, "base64");
  } catch {
    return badRequest("El PDF no tiene un contenido válido.");
  }
  if (bytes.length === 0) return badRequest("El PDF es obligatorio.");
  if (bytes.length > MAX_PDF_BYTES) return badRequest("El PDF supera el tamaño máximo permitido para este catálogo.");
  if (bytes.slice(0, 4).toString("utf8") !== "%PDF") return badRequest("El archivo cargado no parece ser un PDF válido.");
  return bytes;
}

function isHttpResponse(value: Buffer | HttpResponseInit): value is HttpResponseInit {
  return typeof (value as HttpResponseInit).status === "number";
}

async function readCatalog() {
  return readSqlPrintFormats();
}

async function readFuentes(): Promise<FuenteFormatoRecord[]> {
  return (await readCatalog()).sources;
}

async function readFormatos(): Promise<FormatoImpresionRecord[]> {
  return (await readCatalog()).formats;
}

async function readFuente(id: string): Promise<FuenteFormatoRecord | null> {
  return (await readFuentes()).find((item) => item.id === id) ?? null;
}

async function readFormato(id: string): Promise<FormatoImpresionRecord | null> {
  return (await readFormatos()).find((item) => item.id === id) ?? null;
}

async function attachSqlPdfStorage(record: FormatoImpresionRecord, bytes: Buffer): Promise<FormatoImpresionRecord> {
  if (!isPublicDownloadBlobStorageConfigured()) {
    throw Object.assign(new Error("Configure Azure Blob Storage antes de guardar formatos PDF en SQL."), { status: 503 });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = await storePublicDownloadBlob({ bytes, sha256, extension: ".pdf", mimeType: "application/pdf" });
  return {
    ...record,
    pdfBase64: undefined,
    pdfBytes: bytes.length,
    pdfStorageProvider: stored.archivoStorageProvider,
    pdfBlobContainer: stored.archivoBlobContainer,
    pdfBlobName: stored.archivoBlobName,
    pdfSha256: stored.archivoSha256,
  };
}

async function compensateUnreferencedPdf(record: FormatoImpresionRecord): Promise<void> {
  if (record.pdfStorageProvider !== "azure_blob" || !record.pdfBlobContainer || !record.pdfBlobName) return;
  try {
    await deletePublicDownloadBlobIfUnreferenced({
      containerName: record.pdfBlobContainer,
      blobName: record.pdfBlobName,
    });
  } catch {
    // Preserve the original SQL failure; the orphan scan can retry if SQL was unavailable.
  }
}
async function hasDuplicateFuenteName(nombre: string, exceptId?: string): Promise<boolean> {
  const fuentes = await readFuentes();
  return fuentes.some((fuente) => fuente.id !== exceptId && normalize(fuente.nombre) === normalize(nombre));
}

async function hasDuplicateFormatoName(nombre: string, fuenteIds: string[], exceptId?: string): Promise<boolean> {
  const formatos = await readFormatos();
  return formatos.some((formato) =>
    formato.id !== exceptId &&
    getFormatSourceIds(formato).some((id) => fuenteIds.includes(id)) &&
    normalize(formato.nombre) === normalize(nombre)
  );
}

async function readSelectedFuentes(ids: string[]): Promise<FuenteFormatoRecord[]> {
  const sources = await Promise.all(normalizeSourceIds(ids).map(readFuente));
  return sources.filter((source): source is FuenteFormatoRecord => Boolean(source));
}

async function pdfResponse(formato: FormatoImpresionRecord, disposition: "inline" | "attachment"): Promise<HttpResponseInit> {
  if (formato.pdfBlobContainer && formato.pdfBlobName) {
    return {
      status: 302,
      headers: {
        Location: await createPublicDownloadBlobUrl({
          containerName: formato.pdfBlobContainer,
          blobName: formato.pdfBlobName,
          mimeType: "application/pdf",
          filename: formato.pdfNombreOriginal,
          disposition,
        }),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    };
  }
  if (!formato.pdfBase64) throw new Error("El formato no tiene una ubicación PDF válida.");
  const bytes = Buffer.from(formato.pdfBase64, "base64");
  const filename = disposition === "attachment" ? slugify(formato.nombre) : sanitizePdfName(formato.pdfNombreOriginal);
  return {
    status: 200,
    body: bytes,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "public, max-age=300",
    },
  };
}

app.http("adminFuentesFormatosList", {
  route: "catalogo-formatos/admin/fuentes-formatos",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPrintFormats(user, await loadRoleDefinitions())) return forbidden();
      const search = req.query.get("search")?.trim().toLowerCase();
      let items = await readFuentes();
      if (search) items = items.filter((item) => item.nombre.toLowerCase().includes(search));
      items = sortByNombre(items);
      const pagination = getPagination(req);
      if (pagination.enabled) return ok(paginateArray(items.map(sanitizeFuente), pagination.page, pagination.pageSize));
      return ok(items.map(sanitizeFuente));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFuentesFormatosCreate", {
  route: "catalogo-formatos/admin/fuentes-formatos",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canCreatePrintFormatSource(user, await loadRoleDefinitions())) return forbidden();
      const parsed = FuenteSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (await hasDuplicateFuenteName(parsed.data.nombre)) return conflict("Ya existe un tipo de fuente con este nombre.");
      const now = new Date().toISOString();
      const record: FuenteFormatoRecord = {
        id: `fuente_formato_${randomUUID()}`,
        nombre: parsed.data.nombre.trim(),
        activa: parsed.data.activa,
        status: parsed.data.activa ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      return created(sanitizeFuente(await createSqlPrintSource(record, { id: user.id, email: user.email })));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFuentesFormatosGet", {
  route: "catalogo-formatos/admin/fuentes-formatos/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPrintFormats(user, await loadRoleDefinitions())) return forbidden();
      const record = await readFuente(req.params.id);
      if (!record) return notFound("Tipo de fuente no encontrado.");
      return ok(sanitizeFuente(record));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFuentesFormatosUpdate", {
  route: "catalogo-formatos/admin/fuentes-formatos/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canEditPrintFormatSource(user, await loadRoleDefinitions())) return forbidden();
      const id = req.params.id;
      const parsed = FuenteUpdateSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const current = await readFuente(id);
      if (!current) return notFound("Tipo de fuente no encontrado.");
      if (parsed.data.nombre !== undefined && await hasDuplicateFuenteName(parsed.data.nombre, id)) {
        return conflict("Ya existe un tipo de fuente con este nombre.");
      }
      const before = sanitizeFuente(current);
      const { descripcion: _legacyDescription, ...currentWithoutDescription } = current as FuenteFormatoRecord & { descripcion?: string };
      const updated: FuenteFormatoRecord = {
        ...currentWithoutDescription,
        ...(parsed.data.nombre !== undefined ? { nombre: parsed.data.nombre.trim() } : {}),
        ...(parsed.data.activa !== undefined ? { activa: parsed.data.activa, status: parsed.data.activa ? "active" : "inactive" } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      const result = await updateSqlPrintSource(current, updated, { id: user.id, email: user.email });
      return result ? ok(sanitizeFuente(result)) : notFound("Tipo de fuente no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFuentesFormatosDelete", {
  route: "catalogo-formatos/admin/fuentes-formatos/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canDeletePrintFormatSource(user, await loadRoleDefinitions())) return forbidden();
      const id = req.params.id;
      const current = await readFuente(id);
      if (!current) return notFound("Tipo de fuente no encontrado.");
      const result = await deleteSqlPrintSource(current, { id: user.id, email: user.email });
      if (!result.found) return notFound("Tipo de fuente no encontrado.");
      if (result.formats) return conflict("No se puede eliminar el tipo de fuente porque tiene formatos asociados.", { dependencies: { formatos: result.formats } });
      return ok({ ok: true });
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFormatosImpresionList", {
  route: "catalogo-formatos/admin/formatos-impresion",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPrintFormats(user, await loadRoleDefinitions())) return forbidden();
      const search = req.query.get("search")?.trim().toLowerCase();
      const fuenteId = req.query.get("fuente_id") ?? req.query.get("fuenteId");
      let items = await readFormatos();
      if (fuenteId) items = items.filter((item) => formatHasSource(item, fuenteId));
      if (search) items = items.filter((item) => `${item.nombre} ${item.descripcion} ${getFormatSourceNames(item).join(" ")}`.toLowerCase().includes(search));
      items = sortByNombre(items);
      const pagination = getPagination(req);
      const sanitized = items.map(sanitizeFormato);
      if (pagination.enabled) return ok(paginateArray(sanitized, pagination.page, pagination.pageSize));
      return ok(sanitized);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFormatosImpresionCreate", {
  route: "catalogo-formatos/admin/formatos-impresion",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canCreatePrintFormat(user, await loadRoleDefinitions())) return forbidden();
      const parsed = FormatoSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const pdf = validatePdf(parsed.data);
      if (isHttpResponse(pdf)) return pdf;
      const requestedSourceIds = normalizeSourceIds(parsed.data.fuenteIds ?? (parsed.data.fuenteId ? [parsed.data.fuenteId] : []));
      const fuentes = await readSelectedFuentes(requestedSourceIds);
      if (fuentes.length !== requestedSourceIds.length) return badRequest("Uno o más tipos de fuente seleccionados no existen.");
      if (fuentes.some((fuente) => !fuente.activa)) return badRequest("Solo puede crear formatos en tipos de fuente activos.");
      if (await hasDuplicateFormatoName(parsed.data.nombre, requestedSourceIds)) return conflict("Ya existe un formato con este nombre en uno de los tipos de fuente seleccionados.");
      const licenciaFields = await buildLicenciaFields({
        requiereLicencia: parsed.data.requiereLicencia ?? false,
        licenciaModuloId: parsed.data.licenciaModuloId,
      });
      if (typeof (licenciaFields as HttpResponseInit).status === "number") return licenciaFields as HttpResponseInit;
      const now = new Date().toISOString();
      let record = withFormatSources<FormatoImpresionRecord>({
        id: `formato_impresion_${randomUUID()}`,
        nombre: parsed.data.nombre.trim(),
        fuenteId: fuentes[0].id,
        fuenteNombre: fuentes[0].nombre,
        descripcion: parsed.data.descripcion.trim(),
        ...buildTamanoFormatoFields(parsed.data),
        ...(licenciaFields as Partial<FormatoImpresionRecord>),
        pdfBase64: pdf.toString("base64"),
        pdfNombreOriginal: sanitizePdfName(parsed.data.pdfNombreOriginal),
        pdfMimeType: "application/pdf",
        activo: parsed.data.activo,
        status: parsed.data.activo ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      }, fuentes);
      record = await attachSqlPdfStorage(record, pdf);
      try {
        return created(sanitizeFormato(await createSqlPrintFormat(record, { id: user.id, email: user.email })));
      } catch (error) {
        await compensateUnreferencedPdf(record);
        throw error;
      }
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFormatosImpresionGet", {
  route: "catalogo-formatos/admin/formatos-impresion/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canViewPrintFormats(user, await loadRoleDefinitions())) return forbidden();
      const record = await readFormato(req.params.id);
      if (!record) return notFound("Formato no encontrado.");
      return ok(sanitizeFormato(record));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFormatosImpresionUpdate", {
  route: "catalogo-formatos/admin/formatos-impresion/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      const roleDefinitions = await loadRoleDefinitions();
      const id = req.params.id;
      const body = await req.json() as any;
      const replacingPdfInput = body && (body.pdfBase64 !== undefined || body.pdfNombreOriginal !== undefined);
      if (!canEditPrintFormat(user, roleDefinitions)) return forbidden();
      if (replacingPdfInput && !canReplacePrintFormatPdf(user, roleDefinitions)) return forbidden();
      const parsed = FormatoUpdateSchema.safeParse(body);
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const current = await readFormato(id);
      if (!current) return notFound("Formato no encontrado.");
      const changingSources = parsed.data.fuenteIds !== undefined || parsed.data.fuenteId !== undefined;
      const requestedSourceIds = changingSources
        ? normalizeSourceIds(parsed.data.fuenteIds ?? (parsed.data.fuenteId ? [parsed.data.fuenteId] : []))
        : getFormatSourceIds(current);
      if (requestedSourceIds.length === 0) return badRequest("Seleccione al menos un tipo de fuente.");
      const fuentes = await readSelectedFuentes(requestedSourceIds);
      if (fuentes.length !== requestedSourceIds.length) return badRequest("Uno o más tipos de fuente seleccionados no existen.");
      const currentSourceIds = getFormatSourceIds(current);
      if (changingSources && fuentes.some((fuente) => !fuente.activa && !currentSourceIds.includes(fuente.id))) {
        return badRequest("Solo puede asignar formatos a tipos de fuente activos.");
      }
      const nextName = parsed.data.nombre ?? current.nombre;
      if (await hasDuplicateFormatoName(nextName, requestedSourceIds, id)) {
        return conflict("Ya existe un formato con este nombre en uno de los tipos de fuente seleccionados.");
      }
      const licenciaFields = await buildLicenciaFields({
        requiereLicencia: parsed.data.requiereLicencia ?? current.requiereLicencia ?? false,
        licenciaModuloId: parsed.data.licenciaModuloId !== undefined ? parsed.data.licenciaModuloId : current.licenciaModuloId,
      });
      if (typeof (licenciaFields as HttpResponseInit).status === "number") return licenciaFields as HttpResponseInit;
      let pdfBase64 = current.pdfBase64;
      let pdfNombreOriginal = current.pdfNombreOriginal;
      let replacedPdf = false;
      if (parsed.data.pdfBase64 !== undefined || parsed.data.pdfNombreOriginal !== undefined) {
        if (!parsed.data.pdfBase64 || !parsed.data.pdfNombreOriginal) return badRequest("Para reemplazar el PDF debe enviar archivo y nombre.");
        const pdf = validatePdf({ pdfBase64: parsed.data.pdfBase64, pdfNombreOriginal: parsed.data.pdfNombreOriginal });
        if (isHttpResponse(pdf)) return pdf;
        pdfBase64 = pdf.toString("base64");
        pdfNombreOriginal = sanitizePdfName(parsed.data.pdfNombreOriginal);
        replacedPdf = true;
      }
      const before = { ...current };
      let updated = withFormatSources<FormatoImpresionRecord>({
        ...current,
        nombre: nextName.trim(),
        fuenteId: fuentes[0].id,
        fuenteNombre: fuentes[0].nombre,
        ...(parsed.data.descripcion !== undefined ? { descripcion: parsed.data.descripcion.trim() } : {}),
        ...buildTamanoFormatoFields(parsed.data),
        ...(licenciaFields as Partial<FormatoImpresionRecord>),
        pdfBase64,
        pdfNombreOriginal,
        ...(parsed.data.activo !== undefined ? { activo: parsed.data.activo, status: parsed.data.activo ? "active" : "inactive" } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      }, fuentes);
      if (replacedPdf) updated = await attachSqlPdfStorage(updated, Buffer.from(pdfBase64!, "base64"));
      try {
        const result = await updateSqlPrintFormat(current, updated, { id: user.id, email: user.email }, replacedPdf);
        if (!result && replacedPdf) await compensateUnreferencedPdf(updated);
        return result ? ok(sanitizeFormato(result)) : notFound("Formato no encontrado.");
      } catch (error) {
        if (replacedPdf) await compensateUnreferencedPdf(updated);
        throw error;
      }
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFormatosImpresionReplacePdf", {
  route: "catalogo-formatos/admin/formatos-impresion/{id}/pdf",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canReplacePrintFormatPdf(user, await loadRoleDefinitions())) return forbidden();
      const id = req.params.id;
      const parsed = PdfSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const pdf = validatePdf(parsed.data);
      if (isHttpResponse(pdf)) return pdf;
      const current = await readFormato(id);
      if (!current) return notFound("Formato no encontrado.");
      const before = { ...current };
      let updated: FormatoImpresionRecord = {
        ...current,
        pdfBase64: pdf.toString("base64"),
        pdfNombreOriginal: sanitizePdfName(parsed.data.pdfNombreOriginal),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      updated = await attachSqlPdfStorage(updated, pdf);
      try {
        const result = await updateSqlPrintFormat(current, updated, { id: user.id, email: user.email }, true);
        if (!result) await compensateUnreferencedPdf(updated);
        return result ? ok(sanitizeFormato(result)) : notFound("Formato no encontrado.");
      } catch (error) {
        await compensateUnreferencedPdf(updated);
        throw error;
      }
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("adminFormatosImpresionDelete", {
  route: "catalogo-formatos/admin/formatos-impresion/{id}",
  methods: ["DELETE"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const user = await getUserOrFail(req);
      if (!canDeletePrintFormat(user, await loadRoleDefinitions())) return forbidden();
      const id = req.params.id;
      const current = await readFormato(id);
      if (!current) return notFound("Formato no encontrado.");
      return (await deleteSqlPrintFormat(current, { id: user.id, email: user.email }))
        ? ok({ ok: true }) : notFound("Formato no encontrado.");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicFuentesFormatosList", {
  route: "public/fuentes-formatos",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (): Promise<HttpResponseInit> => {
    try {
      const [fuentes, formatos] = await Promise.all([readFuentes(), readFormatos()]);
      const activeSourceIds = new Set(fuentes.filter((fuente) => fuente.activa).map((fuente) => fuente.id));
      const activeFormatos = formatos.filter((formato) =>
        formato.activo &&
        formato.status !== "deleted" &&
        getFormatSourceIds(formato).some((id) => activeSourceIds.has(id))
      );
      const counts = new Map<string, number>();
      activeFormatos.forEach((formato) => getFormatSourceIds(formato).forEach((id) => {
        if (activeSourceIds.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
      }));
      const items = sortByNombre(fuentes.filter((fuente) => fuente.activa && (counts.get(fuente.id) ?? 0) > 0))
        .map((fuente) => ({ ...sanitizeFuente(fuente), formatosActivos: counts.get(fuente.id) ?? 0 }));
      return ok(items);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicFormatosImpresionList", {
  route: "public/formatos-impresion",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const fuenteId = req.query.get("fuente_id") ?? req.query.get("fuenteId");
      const q = req.query.get("q")?.trim().toLowerCase();
      const fuentesActivas = new Set((await readFuentes()).filter((fuente) => fuente.activa).map((fuente) => fuente.id));
      let items = (await readFormatos()).filter((formato) =>
        formato.activo && getFormatSourceIds(formato).some((id) => fuentesActivas.has(id))
      );
      if (fuenteId) items = items.filter((item) => formatHasSource(item, fuenteId));
      if (q) items = items.filter((item) => `${item.nombre} ${item.descripcion} ${getFormatSourceNames(item).join(" ")}`.toLowerCase().includes(q));
      items = sortByNombre(items);
      const sanitized = items.map(sanitizeFormato);
      const pagination = getPagination(req);
      if (pagination.enabled) return ok(paginateArray(sanitized, pagination.page, pagination.pageSize));
      return ok(sanitized);
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicFormatosImpresionGet", {
  route: "public/formatos-impresion/{id}",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const record = await readFormato(req.params.id);
      if (!record || !record.activo) return notFound("Formato no encontrado.");
      const fuentes = await readSelectedFuentes(getFormatSourceIds(record));
      if (!fuentes.some((fuente) => fuente.activa)) return notFound("Formato no encontrado.");
      return ok(sanitizeFormato(record));
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicFormatosImpresionPdf", {
  route: "public/formatos-impresion/{id}/pdf",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const record = await readFormato(req.params.id);
      if (!record || !record.activo) return notFound("Formato no encontrado.");
      const fuentes = await readSelectedFuentes(getFormatSourceIds(record));
      if (!fuentes.some((fuente) => fuente.activa)) return notFound("Formato no encontrado.");
      return await pdfResponse(record, "inline");
    } catch (e) {
      return serverError(e);
    }
  },
});

app.http("publicFormatosImpresionDownload", {
  route: "public/formatos-impresion/{id}/descargar",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req): Promise<HttpResponseInit> => {
    try {
      const record = await readFormato(req.params.id);
      if (!record || !record.activo) return notFound("Formato no encontrado.");
      const fuentes = await readSelectedFuentes(getFormatSourceIds(record));
      if (!fuentes.some((fuente) => fuente.activa)) return notFound("Formato no encontrado.");
      return await pdfResponse(record, "attachment");
    } catch (e) {
      return serverError(e);
    }
  },
});
