import { spawnSync } from "node:child_process";

const omitDev = process.argv.includes("--omit-dev");
const npmCli = process.env.npm_execpath;
const audit = spawnSync(
  npmCli ? process.execPath : "npm",
  [
    ...(npmCli ? [npmCli] : []),
    "audit",
    ...(omitDev ? ["--omit=dev"] : []),
    "--json",
  ],
  { encoding: "utf8" },
);

if (audit.error) {
  throw audit.error;
}

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr || audit.stdout);
  failClosed("npm audit did not return a valid JSON report. The audit is NOT approved.");
}

// Falla cerrada: si npm no pudo hacer la auditoría (registro caído, sin red,
// error de npm), NO se da por aprobada. Un informe válido trae
// auditReportVersion, metadata.vulnerabilities y el objeto vulnerabilities.
if (
  !report ||
  typeof report !== "object" ||
  report.error ||
  typeof report.auditReportVersion !== "number" ||
  typeof report.metadata?.vulnerabilities !== "object" ||
  report.metadata.vulnerabilities === null ||
  typeof report.vulnerabilities !== "object" ||
  report.vulnerabilities === null
) {
  failClosed("npm audit could not complete (incomplete or error report). The audit is NOT approved.");
}

// npm audit sale con 0 sin hallazgos y con 1 cuando hay hallazgos. Si salió con
// error y no trae ningún hallazgo, la auditoría no se completó.
if (audit.status !== 0 && Object.keys(report.vulnerabilities).length === 0) {
  failClosed(`npm audit exited with code ${audit.status} without findings. The audit is NOT approved.`);
}

const vulnerabilities = report.vulnerabilities;
const minimumSeverity = 2;
const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

// The API has no permanent advisory exceptions.
const allowedAdvisoryUrls = new Set([]);

// TEMPORARY exceptions. Each one covers exactly ONE advisory, only in the full
// audit (never with --omit-dev: if the package ever reaches production
// dependencies, it blocks), and only until its expiry date. After that date the
// audit blocks again on its own. Review and delete each entry when a fixed
// version is published.
const TEMPORARY_EXCEPTIONS = [
  {
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    packageName: "picomatch",
    expires: "2026-12-15",
    approvedBy: "Juan Camilo (2026-11-17)",
    reason:
      "ReDoS in picomatch <=4.0.7 with no fixed release yet. It only arrives through " +
      "build/test tooling (vite, vitest, tinyglobby, fdir); it is not installed in " +
      "production and never receives user input.",
  },
];

const today = (process.env.AUDIT_TODAY ?? new Date().toISOString()).slice(0, 10);
const activeExceptions = omitDev
  ? []
  : TEMPORARY_EXCEPTIONS.filter((exception) => today <= exception.expires);
const expiredExceptions = omitDev
  ? []
  : TEMPORARY_EXCEPTIONS.filter((exception) => today > exception.expires);
const exceptionUrls = new Set(activeExceptions.map((exception) => exception.url));

function collectAdvisoryUrls(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);

  const vulnerability = vulnerabilities[name];
  if (!vulnerability) return [];

  return (vulnerability.via ?? []).flatMap((item) => {
    if (typeof item === "string") {
      return collectAdvisoryUrls(item, seen);
    }
    return typeof item?.url === "string" ? [item.url] : [];
  });
}

const blocked = Object.entries(vulnerabilities).filter(([name, vulnerability]) => {
  if ((severityRank[vulnerability.severity] ?? 4) < minimumSeverity) return false;

  const advisoryUrls = collectAdvisoryUrls(name);
  return (
    advisoryUrls.length === 0 ||
    advisoryUrls.some((url) => !allowedAdvisoryUrls.has(url) && !exceptionUrls.has(url))
  );
});

for (const exception of expiredExceptions) {
  process.stderr.write(
    `Temporary exception for ${exception.packageName} (${exception.url}) expired on ${exception.expires}; it no longer applies.\n`,
  );
}

if (blocked.length > 0) {
  for (const [name, vulnerability] of blocked) {
    process.stderr.write(
      `${name}: ${vulnerability.severity} dependency vulnerability is not allowlisted.\n`,
    );
  }
  process.exit(1);
}

const allowed = Object.keys(vulnerabilities).filter(
  (name) => collectAdvisoryUrls(name).length > 0,
);
const usedExceptions = activeExceptions.filter((exception) =>
  allowed.some((name) => collectAdvisoryUrls(name).includes(exception.url)),
);

if (allowed.length > 0) {
  process.stdout.write(
    `Dependency audit passed with reviewed advisory exceptions (${allowed.join(", ")}).\n`,
  );
  for (const exception of usedExceptions) {
    process.stdout.write(
      `  TEMPORARY exception in use: ${exception.packageName} ${exception.url} until ${exception.expires}. ${exception.reason}\n`,
    );
  }
} else {
  process.stdout.write("Dependency audit passed with no moderate-or-higher findings.\n");
}
