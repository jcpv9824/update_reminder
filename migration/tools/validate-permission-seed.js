#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require(path.resolve(__dirname, "../../api/node_modules/typescript"));

const sourcePath = path.resolve(__dirname, "../../api/src/lib/permissionModel.ts");
const sqlPath = path.resolve(__dirname, "../sql/007_indexes_constraints_permissions.sql");
const publicAssetMigrationPath = path.resolve(
  __dirname,
  "../sql/016_public_download_video_assets_and_source_cleanup.sql"
);

const source = fs.readFileSync(sourcePath, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const runtimeModule = { exports: {} };
new Function("exports", "module", "require", javascript)(runtimeModule.exports, runtimeModule, require);

const expected = new Map();
for (const moduleItem of runtimeModule.exports.PERMISSION_CATALOG) {
  for (const option of moduleItem.options) {
    for (const action of option.actions) {
      expected.set(`${option.permissionPrefix}.${action.id}`, {
        moduleKey: moduleItem.id,
        optionKey: option.id,
        actionKey: action.id,
        label: action.label,
      });
    }
  }
}

const sql = fs.readFileSync(sqlPath, "utf8");
const optionRow = /^\s*\(N'([^']+)', N'([^']+)', N'([^']+)', N'([^']+)', N'(\[.*\])'\)[,;]\s*$/gm;
const actual = new Map();
for (const match of sql.matchAll(optionRow)) {
  const [, moduleKey, optionKey, permissionPrefix, , actionsJson] = match;
  for (const action of JSON.parse(actionsJson)) {
    actual.set(`${permissionPrefix}.${action.id}`, {
      moduleKey,
      optionKey,
      actionKey: action.id,
      label: action.label,
    });
  }
}

// Migration 016 intentionally preserves the historical *_document permission
// keys while changing their final user-facing labels from Documento to Archivo.
// Apply that versioned metadata overlay before comparing the final catalog.
const publicAssetMigration = fs.readFileSync(publicAssetMigrationPath, "utf8");
const labelUpdate = publicAssetMigration.match(
  /UPDATE\s+security\.permissions\s+SET\s+label\s*=\s*CASE\s+action_key([\s\S]*?)END\s+WHERE\s+permission_key\s+IN/i
);
if (!labelUpdate) {
  throw new Error("Migration 016 public-asset permission label overlay was not found.");
}
for (const match of labelUpdate[1].matchAll(/WHEN\s+N'([^']+)'\s+THEN\s+N'([^']+)'/gi)) {
  const key = `implementation.public_downloads.${match[1]}`;
  const permission = actual.get(key);
  if (!permission) throw new Error(`Migration 016 updates an unknown permission: ${key}`);
  permission.label = match[2];
}

const errors = [];
for (const [key, expectedValue] of expected) {
  const actualValue = actual.get(key);
  if (!actualValue) {
    errors.push(`missing SQL permission: ${key}`);
  } else if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
    errors.push(`metadata mismatch: ${key}`);
  }
}
for (const key of actual.keys()) {
  if (!expected.has(key)) errors.push(`obsolete SQL permission: ${key}`);
}

if (errors.length > 0) {
  console.error(`Permission seed drift detected (${errors.length} error(s)).`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Permission seed matches the application catalog: ${expected.size} permission(s).`);
