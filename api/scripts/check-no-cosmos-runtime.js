const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "src");
const forbidden = [
  { label: "Azure Cosmos SDK import", pattern: /@azure\/cosmos/i },
  { label: "Cosmos runtime setting", pattern: /\bCOSMOS_(?:CONNECTION_STRING|DATABASE_NAME)\b/ },
  { label: "retired backend mode", pattern: /\b(?:cosmos|dual-read)\b/i },
  { label: "retired adapter import", pattern: /(?:from|require\()\s*["'][^"']*\/cosmos["']/i },
];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests") return [];
      return sourceFiles(fullPath);
    }
    return /\.(?:ts|js)$/.test(entry.name) ? [fullPath] : [];
  });
}

const failures = [];
for (const file of sourceFiles(sourceRoot)) {
  const content = fs.readFileSync(file, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) {
      failures.push(`${path.relative(root, file)}: ${rule.label}`);
    }
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.dependencies?.["@azure/cosmos"] || packageJson.devDependencies?.["@azure/cosmos"]) {
  failures.push("package.json: Azure Cosmos SDK dependency");
}

if (failures.length > 0) {
  console.error("Retired Cosmos runtime dependency detected:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("SQL-only runtime guard passed.");
