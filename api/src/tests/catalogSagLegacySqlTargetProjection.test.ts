import { describe, expect, it } from "vitest";
import { catalogSagLegacySqlTargetOuterApply, parseCatalogSagLegacySqlTargetEvidence,
  type CatalogSagLegacySqlTargetEvidence } from "../lib/catalogSagLegacySqlTargetProjection";

const candidate: CatalogSagLegacySqlTargetEvidence = { status: "candidate", host: "dev.example.invalid", port: 15433,
  databaseName: "Synthetic_2026" };
const unverified: CatalogSagLegacySqlTargetEvidence = { status: "unverified", host: null, port: null, databaseName: null };
const address = "dev.example.invalid,15433";
const db = "Initial Catalog=Synthetic_2026";
const user = "User ID=synthetic-only";
const skipped = "Password=fixture-only";
const wire = (...parts: string[]) => parts.join(";");
const standard = wire(address, db, user, skipped);
const completeBound = standard + "x".repeat(4096 - standard.length);
const verificationCases: readonly (readonly [string | null, CatalogSagLegacySqlTargetEvidence])[] = [
  [standard, candidate], [standard + ";", candidate], [completeBound, candidate], [completeBound + "x", unverified],
  [" DEV.Example.Invalid , 15433 ;  iNiTiaL CaTaLoG  = Synthetic_2026 ; uSeR Id= fixture ; pAsSwOrD = x=y== ;  ", candidate],
  [wire(address, "UID=fixture=a", "Pwd=contains=equals", "Database=Synthetic_2026"), candidate],
  [wire(address, "Database=Synthetic_2026", "User=fixture", "Pwd=Initial Catalog=not projected"), candidate],
  [wire(address, db, "UID=fixture\\n", "Pwd=\\u0000/\\f\\r\\t\\b\\\\"), candidate],
  [wire(address, db, user, "Pwd=literal" + "\\".repeat(3)), candidate],
  [wire(address, db, user, "Pwd=slash\\and/raw=value"), candidate],
  [wire(address, ";" + db, user, skipped), unverified], [standard + ";;", unverified], [standard + "; ;", unverified],
  [wire(address, db, user, "Password="), unverified], [wire(address, db, user, "Password=  "), unverified],
  [wire(address, db, "User ID=", skipped), unverified], [wire(address, "Database=", user, skipped), unverified],
  [wire(address, db, user, "Password"), unverified], [wire(address, db, skipped), unverified],
  [wire(address, db, user, skipped, "Encrypt=true"), unverified], [wire(address, db, "Login=fixture", skipped), unverified],
  [wire(address, db, "User  ID=fixture", skipped), unverified], [wire(address, db, "Usér ID=fixture", skipped), unverified],
  [wire(address, db, user, "Pwd=fixture", skipped), unverified], [wire(address, db, "Database=Synthetic_2026", user, skipped), unverified],
  [wire(address, db, "Uid=fixture", user, skipped), unverified],
  [wire(address, db, user, 'Password="fixture;Database=never-projected"'), unverified],
  [wire(address, db, user, "Password='fixture=synthetic'"), unverified],
  [wire(address, db, user, "Password={fixture;Database=never-projected}"), unverified],
  [wire(address, db, user, "Password=fixture;Database=never-projected"), unverified],
  [wire(address, db, user, "Password=fixture\u0000tail"), unverified],
  [wire(address, db, user, "Password=fixture\u009ftail"), unverified],
  [wire(address, db, user, "Password=fixture\u007ftail"), unverified],
  [wire(address, db, user, "Password=fixture\ttail"), unverified],
  [wire(address, db, user, "Password=fixture\ntail"), unverified],
  [wire(address, db, user, "Password=literal slash\\\u0000tail"), unverified],
  [wire(address, db, user, "Password=literal slash\\\ntail"), unverified],
  [wire(address, db, user, 'Password=literal slash\\"tail'), unverified],
  [wire(address, "Database=Synthetic_2026", "User=fixture", "Pwd=x;UID=duplicate"), unverified],
  [wire(address, "Database=Synthetic_2026", "User=fixture", "Pwd=x;;"), unverified],
  [wire("dev.exa\u0000mple.invalid,15433", db, user, skipped), unverified],
  [wire(address, "Database=Synthetic name-1.2", user, skipped), { ...candidate, databaseName: "Synthetic name-1.2" }],
  [wire(address, "Database=Synthetic=other", user, skipped), unverified],
  [wire(address, "Database=../Synthetic", user, skipped), unverified],
  [wire(address, "Database=Someá", user, skipped), unverified],
  [wire(address, "Database=" + "D".repeat(129), user, skipped), unverified],
  [wire("dev.example.invalid\\named,15433", db, user, skipped), unverified],
  [wire("dev.example.invalid,15433\\named", db, user, skipped), unverified],
  [wire("127.0.0.1,15433", db, user, skipped), unverified], [wire("0x7f.0x0.0x0.0x1,15433", db, user, skipped), unverified],
  [wire("[2001:db8::1],15433", db, user, skipped), unverified], [wire("tcp:dev.example.invalid,15433", db, user, skipped), unverified],
  [wire("Data Source=dev.example.invalid,15433", db, user, skipped), unverified],
  [wire("dev..invalid,15433", db, user, skipped), unverified], [wire("-dev.example.invalid,15433", db, user, skipped), unverified],
  [wire("a." + "a".repeat(64) + ".invalid,15433", db, user, skipped), unverified],
  [wire("dev.example.invalid,15433,15434", db, user, skipped), unverified],
  [wire("dev.example.invalid,65535", db, user, skipped), { ...candidate, port: 65535 }],
  [wire("dev.example.invalid,1", db, user, skipped), { ...candidate, port: 1 }],
  ...["", "+1433", "0", "65536", "1.0", "1433x", " 1  ", undefined].map(port => [
    wire(port === undefined ? "dev.example.invalid" : `dev.example.invalid,${port}`, db, user, skipped),
    port === " 1  " ? { ...candidate, port: 1 } : unverified,
  ] as const),
  [null, unverified], ["", unverified], ["     ", unverified],
  [wire("Dev-Sql.example.invalid,15433", "Database=_Synthetic.2026 - v2", user, skipped),
    { ...candidate, host: "dev-sql.example.invalid", databaseName: "_Synthetic.2026 - v2" }],
  [wire("dev@local.example.invalid,15433", db, user, skipped), unverified],
  [wire("dev#test.example.invalid,15433", db, user, skipped), unverified],
  [wire("dev[test].example.invalid,15433", db, user, skipped), unverified],
  [wire(address, "Database=Synthetic@localhost", user, skipped), unverified],
  [wire(address, "Database=[Synthetic]", user, skipped), unverified],
  [wire(address, "Database=Synthetic:2026", user, skipped), unverified],
  [wire(address, "Database=Synthetic＼2026", user, skipped), unverified],
];

const fixtureDocument = JSON.stringify(verificationCases.map(([wire, expected]) => ({ wire, ...expected })));
const fixtureLiteral = "CONVERT(nvarchar(max),N'')+" + (fixtureDocument.match(/[\s\S]{1,2000}/g) ?? [])
  .map(part => "N'" + part.replaceAll("'", "''") + "'").join("+");

/** Run this fixed read-only batch on an approved synthetic SQL 2019 target; only aggregate evidence leaves it. */
export const catalogSagLegacySqlTargetFixtureSql = `SELECT COUNT_BIG(*) AS casesChecked, SUM(CASE WHEN
  sagTarget.status=co.expectedStatus
  AND ((sagTarget.host IS NULL AND co.expectedHost IS NULL) OR sagTarget.host COLLATE Latin1_General_100_BIN2=co.expectedHost COLLATE Latin1_General_100_BIN2)
  AND ((sagTarget.port IS NULL AND co.expectedPort IS NULL) OR sagTarget.port=co.expectedPort)
  AND ((sagTarget.databaseName IS NULL AND co.expectedDatabase IS NULL)
    OR sagTarget.databaseName COLLATE Latin1_General_100_BIN2=co.expectedDatabase COLLATE Latin1_General_100_BIN2)
  THEN 0 ELSE 1 END) AS failures
FROM OPENJSON(${fixtureLiteral}) WITH (
  StringConnection nvarchar(max) '$.wire',
  expectedStatus varchar(10) '$.status',
  expectedHost varchar(253) '$.host',
  expectedPort int '$.port',
  expectedDatabase nvarchar(128) '$.databaseName'
) AS co
${catalogSagLegacySqlTargetOuterApply};`;

describe("SAG Admin legacy SQL target projection", () => {
  it("exposes a fixed, row-preserving, typed OUTER APPLY with no secret output or SQL 2022 ordinals", () => {
    expect(catalogSagLegacySqlTargetOuterApply).toMatch(/^\s*OUTER APPLY\s*\(\s*SELECT/);
    expect(catalogSagLegacySqlTargetOuterApply).toMatch(/AS status,[\s\S]*AS host,[\s\S]*AS port,[\s\S]*AS databaseName/);
    expect(catalogSagLegacySqlTargetOuterApply).toMatch(/\) AS sagTarget\s*$/);
    expect(catalogSagLegacySqlTargetOuterApply).toContain("co.StringConnection");
    expect(catalogSagLegacySqlTargetOuterApply).not.toMatch(/co\.(?:Name|Token)|SELECT\s+\*|STRING_SPLIT\([^)]*,[^)]*,/i);
    expect(catalogSagLegacySqlTargetOuterApply).not.toMatch(/\bAS\s+(?:password|pwd|userId|username|rawConnectionString)\b/i);
    expect(catalogSagLegacySqlTargetOuterApply).toContain("Latin1_General_100_BIN2");
    expect(catalogSagLegacySqlTargetFixtureSql).toMatch(/COUNT_BIG\(\*\) AS casesChecked[\s\S]*AS failures/);
    expect(verificationCases.length).toBeGreaterThan(50);
  });

  it("accepts only canonical sanitized candidate evidence or a fully null unverified tuple", () => {
    expect(parseCatalogSagLegacySqlTargetEvidence(candidate)).toEqual(candidate);
    expect(parseCatalogSagLegacySqlTargetEvidence(unverified)).toEqual(unverified);
    for (const invalid of [null, { ...candidate, password: "synthetic prohibited field" },
      { ...candidate, databaseName: "unexpected=fixture" }, { ...candidate, host: "127.0.0.1" },
      { ...candidate, host: "0x7f.0x0.0x0.0x1" }, { ...candidate, host: "Dev.EXAMPLE.invalid" },
      { ...candidate, host: "dev.example.invalid\\named" }, { ...candidate, host: "dev...invalid" },
      { ...candidate, host: "a." + "a".repeat(64) + ".invalid" }, { ...candidate, host: "dev" },
      { ...candidate, port: "15433" }, { ...candidate, port: 0 }, { ...candidate, port: 65536 },
      { ...candidate, databaseName: null }, { ...candidate, status: "verified" }, { ...unverified, host: candidate.host },
      { ...unverified, port: candidate.port }, { ...unverified, databaseName: candidate.databaseName }]) {
      expect(parseCatalogSagLegacySqlTargetEvidence(invalid)).toBeNull();
    }
  });

  it("uses a bounded built-in control scan and no per-code-unit row generator", () => {
    expect(catalogSagLegacySqlTargetOuterApply).toContain("STRING_ESCAPE(");
    expect(catalogSagLegacySqlTargetOuterApply).not.toMatch(/CROSS\s+JOIN\s+\(VALUES|UNICODE\(SUBSTRING/);
  });

  it("validates route characters using explicit literal alphabets rather than mixed SQL LIKE ranges", () => {
    expect(catalogSagLegacySqlTargetOuterApply).toContain("TRANSLATE(parsed.host");
    expect(catalogSagLegacySqlTargetOuterApply).toContain("TRANSLATE(pairs.database_name");
    expect(catalogSagLegacySqlTargetOuterApply).not.toMatch(/NOT LIKE N'%\[\^A-Za-z0-9/);
  });
});
