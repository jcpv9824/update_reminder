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

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr || audit.stdout);
  throw new Error("npm audit did not return a valid JSON report.");
}

const vulnerabilities = report.vulnerabilities ?? {};
const minimumSeverity = 2;
const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

// The portal is a client-only BrowserRouter SPA. It does not use React Server
// Components, Server Actions, SSR, or React Router framework/RSC mode.
const allowedAdvisoryUrls = new Set([
  "https://github.com/advisories/GHSA-qwww-vcr4-c8h2",
]);

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
    advisoryUrls.some((url) => !allowedAdvisoryUrls.has(url))
  );
});

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

if (allowed.length > 0) {
  process.stdout.write(
    `Dependency audit passed with one reviewed RSC-only advisory exception (${allowed.join(", ")}).\n`,
  );
} else {
  process.stdout.write("Dependency audit passed with no moderate-or-higher findings.\n");
}
