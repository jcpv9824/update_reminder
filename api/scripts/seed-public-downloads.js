/* eslint-disable no-console */
const { CosmosClient } = require("@azure/cosmos");
const fs = require("fs");
const path = require("path");

const DATABASE_NAME = process.env.COSMOS_DATABASE_NAME || "erp-update-scheduler";
const CONTAINER_NAME = "publicDownloads";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, "..");

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function readFilePayload(filePath) {
  const absolute = path.resolve(filePath);
  const bytes = fs.readFileSync(absolute);
  const extension = path.extname(absolute).toLowerCase();
  return {
    archivoNombreOriginal: path.basename(absolute),
    archivoMimeType: MIME_TYPES[extension] || "application/octet-stream",
    archivoBase64: bytes.toString("base64"),
    archivoBytes: bytes.length,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sectionRecord(input) {
  const now = nowIso();
  return {
    type: "section",
    id: input.id,
    nombre: input.nombre,
    slug: input.slug,
    descripcion: input.descripcion,
    activa: true,
    status: "active",
    createdAt: now,
    createdBy: "seed-public-downloads",
    updatedAt: now,
    updatedBy: "seed-public-downloads",
  };
}

function documentRecord(input, section, payload) {
  const now = nowIso();
  return {
    type: "document",
    id: input.id,
    sectionId: section.id,
    sectionName: section.nombre,
    sectionSlug: section.slug,
    titulo: input.titulo,
    slug: input.slug,
    descripcion: input.descripcion,
    ...payload,
    activo: true,
    status: "active",
    createdAt: now,
    createdBy: "seed-public-downloads",
    updatedAt: now,
    updatedBy: "seed-public-downloads",
  };
}

async function upsertPreservingCreated(container, record) {
  let existing = null;
  try {
    const result = await container.item(record.id, record.id).read();
    existing = result.resource || null;
  } catch {
    existing = null;
  }
  const next = existing
    ? {
        ...existing,
        ...record,
        createdAt: existing.createdAt || record.createdAt,
        createdBy: existing.createdBy || record.createdBy,
        updatedAt: nowIso(),
      }
    : record;
  await container.items.upsert(next);
  return next;
}

async function main() {
  const connectionString = process.env.COSMOS_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("Falta COSMOS_CONNECTION_STRING.");
  }

  const files = {
    usersList: path.join(
      WORKSPACE_ROOT,
      "Step-by-step",
      "Documentos de paso a paso",
      "Flujo de procesos para Cliente en SAG clásico que usará módulos especiales en SAG Web",
      "Lista de usuarios - [NOMBRE DE LA COMPAÑÍA].xlsx"
    ),
    logoGuide: path.join(
      WORKSPACE_ROOT,
      "Step-by-step",
      "Documentos de paso a paso",
      "Flujo de procesos de migración de SAG Clásico a SAG Web",
      "08 - Guía - Configurar logo y formato de impresión.pdf"
    ),
  };

  for (const filePath of Object.values(files)) {
    if (!fs.existsSync(filePath)) throw new Error(`No existe el archivo: ${filePath}`);
  }

  const client = new CosmosClient(connectionString);
  const database = client.database(DATABASE_NAME);
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER_NAME,
    partitionKey: { paths: ["/id"] },
  });

  const moduloEspecial = sectionRecord({
    id: "public_download_section_modulo_especial_sag_web",
    nombre: "Módulo Especial SAG Web",
    slug: "modulo-especial-sag-web",
    descripcion: "Documentos públicos para clientes que usarán módulos especiales en SAG Web.",
  });
  const migracion = sectionRecord({
    id: "public_download_section_migracion_sag_clasico_sag_web",
    nombre: "Migración SAG Clásico a SAG Web",
    slug: "migracion-sag-clasico-a-sag-web",
    descripcion: "Guías públicas del proceso de migración de SAG Clásico a SAG Web.",
  });

  await upsertPreservingCreated(container, moduloEspecial);
  await upsertPreservingCreated(container, migracion);

  const documents = [
    documentRecord({
      id: "public_download_document_lista_usuarios_modulo_especial",
      titulo: "Lista de usuarios - [NOMBRE DE LA COMPAÑÍA]",
      slug: "lista-usuarios-modulo-especial",
      descripcion: "Plantilla para listar usuarios del cliente en el flujo de módulos especiales.",
    }, moduloEspecial, readFilePayload(files.usersList)),
    documentRecord({
      id: "public_download_document_guia_configurar_logo_formato_impresion",
      titulo: "08 - Guía - Configurar logo y formato de impresión",
      slug: "guia-configurar-logo-formato-impresion",
      descripcion: "Guía para configurar logo y formato de impresión durante la migración a SAG Web.",
    }, migracion, readFilePayload(files.logoGuide)),
  ];

  for (const doc of documents) {
    const saved = await upsertPreservingCreated(container, doc);
    console.log(`${saved.titulo}: /api/public/downloads/${saved.sectionSlug}/${saved.slug}`);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
