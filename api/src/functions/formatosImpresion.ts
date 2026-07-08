import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, loadUserProfile } from "../lib/auth";
import { writeAuditLog } from "../lib/audit";
import { getContainer } from "../lib/cosmos";
import { badRequest, conflict, created, forbidden, notFound, ok, serverError } from "../lib/http";
import { getPagination, paginateArray } from "../lib/pagination";
import { canManagePrintFormats } from "../lib/permissions";
import type { FormatoImpresionRecord, FuenteFormatoRecord } from "../types/models";

const MAX_PDF_BYTES = 1_500_000;

const FuenteSchema = z.object({
  nombre: z.string().min(1, "El nombre de la Fuente es obligatorio.").max(160),
  descripcion: z.string().max(1000).optional(),
  activa: z.boolean().default(true),
  orden: z.number().int().min(0).nullable().optional(),
});

const FuenteUpdateSchema = FuenteSchema.partial();

const PdfSchema = z.object({
  pdfBase64: z.string().min(1, "El PDF es obligatorio."),
  pdfNombreOriginal: z.string().min(1, "El nombre del PDF es obligatorio.").max(240),
});

const FormatoSchema = z.object({
  nombre: z.string().min(1, "El nombre del formato es obligatorio.").max(200),
  fuenteId: z.string().min(1, "La Fuente es obligatoria."),
  descripcion: z.string().min(1, "La descripción es obligatoria.").max(1600),
  activo: z.boolean().default(true),
  orden: z.number().int().min(0).nullable().optional(),
}).merge(PdfSchema);

const FormatoUpdateSchema = FormatoSchema.partial();

async function getUserOrFail(req: HttpRequest) {
  const auth = await requireUser(req);
  const profile = await loadUserProfile(auth);
  if (!profile) throw Object.assign(new Error("Usuario no registrado."), { status: 403 });
  return profile;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("es-CO");
}

function sortByOrdenNombre<T extends { orden?: number | null; nombre: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.orden ?? 999999) - (b.orden ?? 999999) || a.nombre.localeCompare(b.nombre, "es"));
}

function sanitizeFuente(record: FuenteFormatoRecord) {
  return record;
}

function sanitizeFormato(record: FormatoImpresionRecord) {
  const { pdfBase64, ...rest } = record;
  return {
    ...rest,
    pdfUrl: `/api/public/formatos-impresion/${record.id}/pdf`,
    downloadUrl: `/api/public/formatos-impresion/${record.id}/descargar`,
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

async function readFuentes(): Promise<FuenteFormatoRecord[]> {
  const { resources } = await getContainer("fuentesFormatos").items.readAll<FuenteFormatoRecord>().fetchAll();
  return resources.filter((item) => item.status !== "deleted");
}

async function readFormatos(): Promise<FormatoImpresionRecord[]> {
  const { resources } = await getContainer("formatosImpresion").items.readAll<FormatoImpresionRecord>().fetchAll();
  return resources.filter((item) => item.status !== "deleted");
}

async function readFuente(id: string): Promise<FuenteFormatoRecord | null> {
  const { resource } = await getContainer("fuentesFormatos").item(id, id).read<FuenteFormatoRecord>();
  return resource && resource.status !== "deleted" ? resource : null;
}

async function readFormato(id: string): Promise<FormatoImpresionRecord | null> {
  const { resource } = await getContainer("formatosImpresion").item(id, id).read<FormatoImpresionRecord>();
  return resource && resource.status !== "deleted" ? resource : null;
}

async function hasDuplicateFuenteName(nombre: string, exceptId?: string): Promise<boolean> {
  const fuentes = await readFuentes();
  return fuentes.some((fuente) => fuente.id !== exceptId && normalize(fuente.nombre) === normalize(nombre));
}

async function hasDuplicateFormatoName(nombre: string, fuenteId: string, exceptId?: string): Promise<boolean> {
  const formatos = await readFormatos();
  return formatos.some((formato) =>
    formato.id !== exceptId &&
    formato.fuenteId === fuenteId &&
    normalize(formato.nombre) === normalize(nombre)
  );
}

function pdfResponse(formato: FormatoImpresionRecord, disposition: "inline" | "attachment"): HttpResponseInit {
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
      if (!canManagePrintFormats(user)) return forbidden();
      const search = req.query.get("search")?.trim().toLowerCase();
      let items = await readFuentes();
      if (search) items = items.filter((item) => `${item.nombre} ${item.descripcion ?? ""}`.toLowerCase().includes(search));
      items = sortByOrdenNombre(items);
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
      if (!canManagePrintFormats(user)) return forbidden();
      const parsed = FuenteSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      if (await hasDuplicateFuenteName(parsed.data.nombre)) return conflict("Ya existe una Fuente con este nombre.");
      const now = new Date().toISOString();
      const record: FuenteFormatoRecord = {
        id: `fuente_formato_${randomUUID()}`,
        nombre: parsed.data.nombre.trim(),
        descripcion: parsed.data.descripcion?.trim() || undefined,
        activa: parsed.data.activa,
        orden: parsed.data.orden ?? null,
        status: parsed.data.activa ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      await getContainer("fuentesFormatos").items.create(record);
      await writeAuditLog({
        entityType: "fuenteFormato",
        entityId: record.id,
        action: "fuente_formato_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: record,
      });
      return created(sanitizeFuente(record));
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
      if (!canManagePrintFormats(user)) return forbidden();
      const record = await readFuente(req.params.id);
      if (!record) return notFound("Fuente no encontrada.");
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
      if (!canManagePrintFormats(user)) return forbidden();
      const id = req.params.id;
      const parsed = FuenteUpdateSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const current = await readFuente(id);
      if (!current) return notFound("Fuente no encontrada.");
      if (parsed.data.nombre !== undefined && await hasDuplicateFuenteName(parsed.data.nombre, id)) {
        return conflict("Ya existe una Fuente con este nombre.");
      }
      const before = { ...current };
      const updated: FuenteFormatoRecord = {
        ...current,
        ...(parsed.data.nombre !== undefined ? { nombre: parsed.data.nombre.trim() } : {}),
        ...(parsed.data.descripcion !== undefined ? { descripcion: parsed.data.descripcion.trim() || undefined } : {}),
        ...(parsed.data.activa !== undefined ? { activa: parsed.data.activa, status: parsed.data.activa ? "active" : "inactive" } : {}),
        ...(parsed.data.orden !== undefined ? { orden: parsed.data.orden ?? null } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("fuentesFormatos").item(id, id).replace(updated);
      if (before.nombre !== updated.nombre) {
        const formatos = await readFormatos();
        await Promise.all(formatos.filter((formato) => formato.fuenteId === id).map((formato) =>
          getContainer("formatosImpresion").item(formato.id, formato.id).replace({ ...formato, fuenteNombre: updated.nombre, updatedAt: updated.updatedAt, updatedBy: user.id })
        ));
      }
      await writeAuditLog({
        entityType: "fuenteFormato",
        entityId: id,
        action: "fuente_formato_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: updated,
      });
      return ok(sanitizeFuente(updated));
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
      if (!canManagePrintFormats(user)) return forbidden();
      const id = req.params.id;
      const current = await readFuente(id);
      if (!current) return notFound("Fuente no encontrada.");
      const formatos = await readFormatos();
      const asociados = formatos.filter((formato) => formato.fuenteId === id).length;
      if (asociados > 0) return conflict("No se puede eliminar la Fuente porque tiene formatos asociados.", { dependencies: { formatos: asociados } });
      const deleted: FuenteFormatoRecord = {
        ...current,
        activa: false,
        status: "deleted",
        deletedAt: new Date().toISOString(),
        deletedBy: user.id,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("fuentesFormatos").item(id, id).replace(deleted);
      await writeAuditLog({
        entityType: "fuenteFormato",
        entityId: id,
        action: "fuente_formato_deleted",
        performedBy: user.id,
        performedByEmail: user.email,
        before: current,
        after: deleted,
      });
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
      if (!canManagePrintFormats(user)) return forbidden();
      const search = req.query.get("search")?.trim().toLowerCase();
      const fuenteId = req.query.get("fuente_id") ?? req.query.get("fuenteId");
      let items = await readFormatos();
      if (fuenteId) items = items.filter((item) => item.fuenteId === fuenteId);
      if (search) items = items.filter((item) => `${item.nombre} ${item.descripcion} ${item.fuenteNombre}`.toLowerCase().includes(search));
      items = sortByOrdenNombre(items);
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
      if (!canManagePrintFormats(user)) return forbidden();
      const parsed = FormatoSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const pdf = validatePdf(parsed.data);
      if (isHttpResponse(pdf)) return pdf;
      const fuente = await readFuente(parsed.data.fuenteId);
      if (!fuente) return badRequest("La Fuente seleccionada no existe.");
      if (!fuente.activa) return badRequest("Solo puede crear formatos en Fuentes activas.");
      if (await hasDuplicateFormatoName(parsed.data.nombre, fuente.id)) return conflict("Ya existe un formato con este nombre dentro de la Fuente seleccionada.");
      const now = new Date().toISOString();
      const record: FormatoImpresionRecord = {
        id: `formato_impresion_${randomUUID()}`,
        nombre: parsed.data.nombre.trim(),
        fuenteId: fuente.id,
        fuenteNombre: fuente.nombre,
        descripcion: parsed.data.descripcion.trim(),
        pdfBase64: pdf.toString("base64"),
        pdfNombreOriginal: sanitizePdfName(parsed.data.pdfNombreOriginal),
        pdfMimeType: "application/pdf",
        activo: parsed.data.activo,
        orden: parsed.data.orden ?? null,
        status: parsed.data.activo ? "active" : "inactive",
        createdAt: now,
        createdBy: user.id,
        updatedAt: now,
        updatedBy: user.id,
      };
      await getContainer("formatosImpresion").items.create(record);
      await writeAuditLog({
        entityType: "formatoImpresion",
        entityId: record.id,
        action: "formato_impresion_created",
        performedBy: user.id,
        performedByEmail: user.email,
        after: record,
        metadata: { pdfLoaded: true },
      });
      return created(sanitizeFormato(record));
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
      if (!canManagePrintFormats(user)) return forbidden();
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
      if (!canManagePrintFormats(user)) return forbidden();
      const id = req.params.id;
      const parsed = FormatoUpdateSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const current = await readFormato(id);
      if (!current) return notFound("Formato no encontrado.");
      let fuenteId = parsed.data.fuenteId ?? current.fuenteId;
      const fuente = await readFuente(fuenteId);
      if (!fuente) return badRequest("La Fuente seleccionada no existe.");
      if (parsed.data.fuenteId && !fuente.activa) return badRequest("Solo puede asignar formatos a Fuentes activas.");
      const nextName = parsed.data.nombre ?? current.nombre;
      if (await hasDuplicateFormatoName(nextName, fuente.id, id)) {
        return conflict("Ya existe un formato con este nombre dentro de la Fuente seleccionada.");
      }
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
      const updated: FormatoImpresionRecord = {
        ...current,
        nombre: nextName.trim(),
        fuenteId: fuente.id,
        fuenteNombre: fuente.nombre,
        ...(parsed.data.descripcion !== undefined ? { descripcion: parsed.data.descripcion.trim() } : {}),
        pdfBase64,
        pdfNombreOriginal,
        ...(parsed.data.activo !== undefined ? { activo: parsed.data.activo, status: parsed.data.activo ? "active" : "inactive" } : {}),
        ...(parsed.data.orden !== undefined ? { orden: parsed.data.orden ?? null } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("formatosImpresion").item(id, id).replace(updated);
      await writeAuditLog({
        entityType: "formatoImpresion",
        entityId: id,
        action: replacedPdf ? "formato_impresion_pdf_replaced" : "formato_impresion_updated",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: updated,
        metadata: replacedPdf ? { previousPdfName: before.pdfNombreOriginal, newPdfName: updated.pdfNombreOriginal } : undefined,
      });
      return ok(sanitizeFormato(updated));
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
      if (!canManagePrintFormats(user)) return forbidden();
      const id = req.params.id;
      const parsed = PdfSchema.safeParse(await req.json());
      if (!parsed.success) return badRequest(parsed.error.issues[0].message);
      const pdf = validatePdf(parsed.data);
      if (isHttpResponse(pdf)) return pdf;
      const current = await readFormato(id);
      if (!current) return notFound("Formato no encontrado.");
      const before = { ...current };
      const updated: FormatoImpresionRecord = {
        ...current,
        pdfBase64: pdf.toString("base64"),
        pdfNombreOriginal: sanitizePdfName(parsed.data.pdfNombreOriginal),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("formatosImpresion").item(id, id).replace(updated);
      await writeAuditLog({
        entityType: "formatoImpresion",
        entityId: id,
        action: "formato_impresion_pdf_replaced",
        performedBy: user.id,
        performedByEmail: user.email,
        before,
        after: updated,
        metadata: { previousPdfName: before.pdfNombreOriginal, newPdfName: updated.pdfNombreOriginal },
      });
      return ok(sanitizeFormato(updated));
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
      if (!canManagePrintFormats(user)) return forbidden();
      const id = req.params.id;
      const current = await readFormato(id);
      if (!current) return notFound("Formato no encontrado.");
      const deleted: FormatoImpresionRecord = {
        ...current,
        activo: false,
        status: "deleted",
        deletedAt: new Date().toISOString(),
        deletedBy: user.id,
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      };
      await getContainer("formatosImpresion").item(id, id).replace(deleted);
      await writeAuditLog({
        entityType: "formatoImpresion",
        entityId: id,
        action: "formato_impresion_deleted",
        performedBy: user.id,
        performedByEmail: user.email,
        before: current,
        after: deleted,
      });
      return ok({ ok: true });
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
      const activeFormatos = formatos.filter((formato) => formato.activo && formato.status !== "deleted");
      const counts = new Map<string, number>();
      activeFormatos.forEach((formato) => counts.set(formato.fuenteId, (counts.get(formato.fuenteId) ?? 0) + 1));
      const items = sortByOrdenNombre(fuentes.filter((fuente) => fuente.activa && (counts.get(fuente.id) ?? 0) > 0))
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
      let items = (await readFormatos()).filter((formato) => formato.activo && fuentesActivas.has(formato.fuenteId));
      if (fuenteId) items = items.filter((item) => item.fuenteId === fuenteId);
      if (q) items = items.filter((item) => `${item.nombre} ${item.descripcion}`.toLowerCase().includes(q));
      items = sortByOrdenNombre(items);
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
      const fuente = await readFuente(record.fuenteId);
      if (!fuente?.activa) return notFound("Formato no encontrado.");
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
      const fuente = await readFuente(record.fuenteId);
      if (!fuente?.activa) return notFound("Formato no encontrado.");
      return pdfResponse(record, "inline");
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
      const fuente = await readFuente(record.fuenteId);
      if (!fuente?.activa) return notFound("Formato no encontrado.");
      return pdfResponse(record, "attachment");
    } catch (e) {
      return serverError(e);
    }
  },
});
