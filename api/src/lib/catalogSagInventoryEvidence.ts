/**
 * Relational evidence is not a verified SQL or web execution destination.
 * The fixed source SELECT projects an authority-only display candidate and
 * three ISO calendar days; no raw URL, date JSON, or company metadata enters.
 */
export type CatalogSagInventoryEvidence = Readonly<{
  domainCandidate: string | null;
  environment: "test" | "production" | "demo" | "unknown";
  licenseCodes: string[] | null;
  testStartedOn: string | null;
  productionStartedOn: string | null;
  demoStartedOn: string | null;
}>;

type EvidenceInput = Readonly<{
  domainCandidate: unknown;
  environment: unknown;
  licenseCodes: unknown;
  testStartedOn: unknown;
  productionStartedOn: unknown;
  demoStartedOn: unknown;
}>;

const approvedCodes = new Set("ABCDEFGHIJKLMNOPQRSUVWXYZ");

function calendarDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 10 ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value <= "0001-01-01") return null;
  const instant = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value ? value : null;
}

function hostname(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253 || /[^A-Za-z0-9.-]/.test(value)) return null;
  const labels = value.toLowerCase().split(".");
  if (labels.length < 2 || !/[a-z]/.test(labels[labels.length - 1]) ||
      labels.some(label => label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return labels.join(".");
}

function environment(value: unknown): CatalogSagInventoryEvidence["environment"] {
  if (typeof value !== "string" || value.length > 64) return "unknown";
  switch (value.trim().toLowerCase()) {
    case "test": case "testing": case "pruebas": case "prueba": case "qa": return "test";
    case "production": case "producción": case "produccion": case "prod": return "production";
    case "demo": return "demo";
    default: return "unknown";
  }
}

function licensedCodes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 26) return null;
  const codes = [...value];
  if (codes.some(code => typeof code !== "string" || !approvedCodes.has(code))) return null;
  return [...new Set(codes as string[])].sort();
}

export function normalizeCatalogSagInventoryEvidence(
  row: EvidenceInput,
  asOfDate: string,
): CatalogSagInventoryEvidence {
  const cutoff = calendarDate(asOfDate);
  if (cutoff === null) throw new Error("invalid_catalog_inventory_date");
  const date = (value: unknown) => {
    const parsed = calendarDate(value);
    return parsed !== null && parsed <= cutoff ? parsed : null;
  };
  return {
    domainCandidate: hostname(row.domainCandidate),
    environment: environment(row.environment),
    licenseCodes: licensedCodes(row.licenseCodes),
    testStartedOn: date(row.testStartedOn),
    productionStartedOn: date(row.productionStartedOn),
    demoStartedOn: date(row.demoStartedOn),
  };
}
