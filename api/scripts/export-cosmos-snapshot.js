/* eslint-disable no-console */
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_CONTAINERS = [
  "users",
  "clients",
  "domains",
  "databases",
  "updateSchedules",
  "updateTasks",
  "licenseModules",
  "licenseAssignments",
  "auditLogs",
  "appSettings",
  "emailNotifications",
  "securityRateLimits",
  "authSessions",
  "roles",
  "fuentesFormatos",
  "formatosImpresion",
  "publicDownloads",
];

function usage() {
  console.log(`Exporta un snapshot de Cosmos DB para la migracion relacional.

Uso:
  npm run export:cosmos -- [opciones]

Variables requeridas:
  COSMOS_CONNECTION_STRING   Connection string de Cosmos DB.

Variables opcionales:
  COSMOS_DATABASE_NAME       Nombre de base Cosmos. Default: erp-update-scheduler.

Opciones:
  --out <path>               Carpeta de salida. Default: migration/backups/cosmos-export-YYYYMMDD-HHMMSS.
  --database <name>          Sobrescribe COSMOS_DATABASE_NAME.
  --containers <a,b,c>       Exporta solo esos contenedores.
  --continue-on-error        Continua si un contenedor falla y registra el error en manifest.
  --help                     Muestra esta ayuda.

Notas:
  - No consulta Key Vault ni exporta valores reales de secretos.
  - Exporta documentos Cosmos tal como los devuelve el SDK; puede incluir hashes y PII.
  - La carpeta migration/backups esta ignorada por git. No suba backups productivos al repositorio.
`);
}

function parseArgs(argv) {
  const args = {
    out: null,
    database: process.env.COSMOS_DATABASE_NAME || "erp-update-scheduler",
    containers: DEFAULT_CONTAINERS,
    continueOnError: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--database") {
      args.database = argv[++i];
    } else if (arg === "--containers") {
      args.containers = String(argv[++i] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--continue-on-error") {
      args.continueOnError = true;
    } else {
      throw new Error(`Opcion no reconocida: ${arg}`);
    }
  }

  if (!args.containers.length) throw new Error("Debe indicar al menos un contenedor.");
  return args;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sortDocuments(items) {
  return items.slice().sort((a, b) => {
    const left = String((a && a.id) || "");
    const right = String((b && b.id) || "");
    return left.localeCompare(right);
  });
}

async function exportContainer(database, containerName, outDir) {
  const container = database.container(containerName);
  const iterator = container.items.readAll().getAsyncIterator();
  const items = [];

  for await (const page of iterator) {
    if (Array.isArray(page.resources)) items.push(...page.resources);
  }

  const sorted = sortDocuments(items);
  const fileName = `${containerName}.json`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");

  return {
    file: fileName,
    count: sorted.length,
    sha256: sha256File(filePath),
    status: "ok",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const connectionString = process.env.COSMOS_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("Falta COSMOS_CONNECTION_STRING. Configure la variable antes de ejecutar el export.");
  }

  const repoRoot = path.resolve(__dirname, "..", "..");
  const outDir = path.resolve(
    process.cwd(),
    args.out || path.join(repoRoot, "migration", "backups", `cosmos-export-${timestampForPath()}`)
  );
  fs.mkdirSync(outDir, { recursive: true });

  const client = new CosmosClient(connectionString);
  const database = client.database(args.database);
  const exportedAt = new Date().toISOString();
  const manifest = {
    exportedAt,
    cosmosDatabase: args.database,
    outputDirectory: outDir,
    containers: {},
    warnings: [
      "Este snapshot puede contener PII, password hashes y nombres de secretos. No subir a git.",
      "El export no consulta Key Vault ni incluye valores reales de secretos.",
      "Cosmos DB debe seguir siendo la fuente de verdad hasta validar SQL.",
    ],
  };

  console.log(`Exportando Cosmos DB '${args.database}' a: ${outDir}`);
  for (const containerName of args.containers) {
    process.stdout.write(`- ${containerName}... `);
    try {
      const info = await exportContainer(database, containerName, outDir);
      manifest.containers[containerName] = info;
      console.log(`${info.count} documento(s), sha256=${info.sha256}`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      manifest.containers[containerName] = { status: "error", error: message };
      console.log(`ERROR: ${message}`);
      if (!args.continueOnError) {
        throw error;
      }
    }
  }

  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Manifest escrito: ${manifestPath}`);
  console.log("Export terminado. Mantenga esta carpeta fuera de git y trátela como dato sensible.");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
