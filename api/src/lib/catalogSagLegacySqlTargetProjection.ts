export type CatalogSagLegacySqlTargetEvidence = Readonly<
  { status: "candidate"; host: string; port: number; databaseName: string } |
  { status: "unverified"; host: null; port: null; databaseName: null }
>;

const asciiAlphaNumeric = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const dnsAscii = asciiAlphaNumeric + ".-";
const databaseAscii = asciiAlphaNumeric + "_. -";

/**
 * SQL Server 2019, fixed dbo.Companies alias `co`. This is the narrower legacy
 * `DNS,port;catalog=...;user=...;password=...` format, not a SqlClient parser.
 * Only the four `sagTarget` columns may be selected. A candidate neither proves
 * physical identity nor authorizes a connection. The raw and ignored fields
 * remain inside this source-side expression.
 */
export const catalogSagLegacySqlTargetOuterApply = `
OUTER APPLY (
  SELECT
    CONVERT(varchar(10),CASE WHEN accepted.is_candidate=1 THEN 'candidate' ELSE 'unverified' END) AS status,
    CONVERT(varchar(253),CASE WHEN accepted.is_candidate=1 THEN LOWER(parsed.host) END) AS host,
    CASE WHEN accepted.is_candidate=1 THEN decimal_port.number END AS port,
    CONVERT(nvarchar(128),CASE WHEN accepted.is_candidate=1 THEN pairs.database_name END) AS databaseName
  FROM (VALUES(CASE WHEN DATALENGTH(co.StringConnection) BETWEEN 1 AND 8192
    THEN CONVERT(nvarchar(max),co.StringConnection) COLLATE Latin1_General_100_BIN2 END)) AS raw(wire)
  CROSS APPLY (VALUES(STRING_ESCAPE(CASE WHEN DATALENGTH(raw.wire) BETWEEN 2 AND 8192
    THEN LTRIM(RTRIM(raw.wire)) END,'json') COLLATE Latin1_General_100_BIN2)) AS escaped(wire)
  -- Remove doubled literal backslashes only in the inspection copy. An actual C0 control or
  -- double quote then has a single JSON escape; C1, apostrophes and braces are literal.
  CROSS APPLY (VALUES(REPLACE(escaped.wire COLLATE Latin1_General_100_BIN2,NCHAR(92)+NCHAR(92),N''))) AS inspection(wire)
  CROSS APPLY (VALUES(CASE WHEN RIGHT(escaped.wire,1)=N';'
    THEN LEFT(escaped.wire,LEN(escaped.wire)-1) ELSE escaped.wire END)) AS body(wire)
  CROSS APPLY (VALUES(REPLACE(body.wire,N';',N'","'))) AS json_parts(wire)
  CROSS APPLY (VALUES(CASE WHEN DATALENGTH(json_parts.wire)-DATALENGTH(body.wire)=12
    AND inspection.wire NOT LIKE N'%'+NCHAR(92)+N'["bfnrtu]%'
    AND inspection.wire NOT LIKE N'%'+NCHAR(39)+N'%'
    AND inspection.wire NOT LIKE N'%[{}]%'
    AND inspection.wire NOT LIKE N'%['+NCHAR(127)+N'-'+NCHAR(159)+N']%'
    THEN CONCAT(N'["',json_parts.wire,N'"]')
    ELSE N'[]' END)) AS payload(json_array)
  -- JSON array indexes preserve the first segment and empty segments without SQL 2022 split ordinals.
  CROSS APPLY (
    SELECT
      COUNT_BIG(*) AS segment_count,
      MAX(CASE WHEN segment.[key]=N'0' THEN segment.value END) AS address,
      SUM(CASE WHEN field.kind='catalog' AND nonempty.is_present=1 THEN 1 ELSE 0 END) AS catalog_count,
      SUM(CASE WHEN field.kind='user' AND nonempty.is_present=1 THEN 1 ELSE 0 END) AS user_count,
      SUM(CASE WHEN field.kind='secret' AND nonempty.is_present=1 THEN 1 ELSE 0 END) AS secret_count,
      MAX(catalog_scalar.database_name) AS database_name
    FROM OPENJSON(payload.json_array) AS segment
    CROSS APPLY (VALUES(CHARINDEX(N'=',segment.value))) AS equals(pos)
    CROSS APPLY (VALUES(LTRIM(RTRIM(LEFT(segment.value,CASE WHEN equals.pos>0 THEN equals.pos-1 ELSE 0 END))))) AS label(raw_key)
    CROSS APPLY (VALUES(CASE WHEN label.raw_key COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^A-Za-z ]%'
      THEN LOWER(label.raw_key COLLATE Latin1_General_100_BIN2) END)) AS ascii_label(key_name)
    CROSS APPLY (VALUES(CASE WHEN segment.[key]<>N'0' AND equals.pos>1 THEN
      CASE WHEN ascii_label.key_name IN (N'initial catalog',N'database') THEN 'catalog'
        WHEN ascii_label.key_name IN (N'user id',N'uid',N'user') THEN 'user'
        WHEN ascii_label.key_name IN (N'password',N'pwd') THEN 'secret' END
      END)) AS field(kind)
    CROSS APPLY (VALUES(CASE WHEN DATALENGTH(LTRIM(RTRIM(SUBSTRING(segment.value,equals.pos+1,4096))))>0
      THEN 1 ELSE 0 END)) AS nonempty(is_present)
    CROSS APPLY (VALUES(CASE WHEN field.kind='catalog' THEN
      LTRIM(RTRIM(SUBSTRING(segment.value,equals.pos+1,4096))) END)) AS catalog_scalar(database_name)
  ) AS pairs
  CROSS APPLY (VALUES(pairs.address COLLATE Latin1_General_100_BIN2)) AS address(text)
  CROSS APPLY (VALUES(CHARINDEX(N',',address.text))) AS comma(pos)
  CROSS APPLY (VALUES(
    LTRIM(RTRIM(LEFT(address.text,CASE WHEN comma.pos>0 THEN comma.pos-1 ELSE 0 END))),
    LTRIM(RTRIM(SUBSTRING(address.text,comma.pos+1,4096)))
  )) AS parsed(host,port_text)
  CROSS APPLY (VALUES(TRY_CONVERT(int,CONVERT(nvarchar(5),parsed.port_text)))) AS decimal_port(number)
  CROSS APPLY (VALUES(CASE WHEN
    pairs.segment_count=4
    AND pairs.catalog_count=1 AND pairs.user_count=1 AND pairs.secret_count=1
    AND comma.pos>0
    AND DATALENGTH(parsed.port_text) BETWEEN 2 AND 10
    AND parsed.port_text COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[^0-9]%'
    AND decimal_port.number BETWEEN 1 AND 65535
    AND DATALENGTH(parsed.host) BETWEEN 6 AND 506 AND CHARINDEX(N'.',parsed.host)>0
    -- Map exact allowed characters to one marker, then reject any residual UTF-16 content.
    -- Avoid SQL LIKE character classes mixing ranges with literal hyphens.
    AND DATALENGTH(REPLACE(TRANSLATE(parsed.host COLLATE Latin1_General_100_BIN2,
      N'${dnsAscii}',REPLICATE(N'.',${dnsAscii.length})),N'.',N''))=0
    AND parsed.host COLLATE Latin1_General_100_BIN2 NOT LIKE N'.%'
    AND parsed.host COLLATE Latin1_General_100_BIN2 NOT LIKE N'%.'
    AND parsed.host COLLATE Latin1_General_100_BIN2 NOT LIKE N'%..%'
    AND RIGHT(parsed.host,CHARINDEX(N'.',REVERSE(parsed.host)+N'.')-1) COLLATE Latin1_General_100_BIN2 LIKE N'[A-Za-z]%'
    AND NOT EXISTS (SELECT 1 FROM STRING_SPLIT(parsed.host,N'.') AS dns
      WHERE DATALENGTH(dns.value) NOT BETWEEN 2 AND 126
        OR dns.value COLLATE Latin1_General_100_BIN2 LIKE N'-%' OR dns.value COLLATE Latin1_General_100_BIN2 LIKE N'%-')
    AND DATALENGTH(pairs.database_name) BETWEEN 2 AND 256
    AND DATALENGTH(REPLACE(TRANSLATE(pairs.database_name COLLATE Latin1_General_100_BIN2,
      N'${databaseAscii}',REPLICATE(N'.',${databaseAscii.length})),N'.',N''))=0
    AND pairs.database_name COLLATE Latin1_General_100_BIN2 LIKE N'%[A-Za-z0-9]%'
    THEN 1 ELSE 0 END)) AS accepted(is_candidate)
) AS sagTarget`;

/** Validate only the sanitized tuple handed back by the fixed SQL projection. */
export function parseCatalogSagLegacySqlTargetEvidence(value: unknown): CatalogSagLegacySqlTargetEvidence | null {
  if (!value || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Reflect.ownKeys(value).length !== 4) return null;
  const fields = ["status", "host", "port", "databaseName"] as const;
  const descriptors = fields.map(key => Object.getOwnPropertyDescriptor(value, key));
  if (!descriptors.every(item => item?.enumerable === true && Object.hasOwn(item, "value"))) return null;
  const [status, host, port, databaseName] = descriptors.map(item => item!.value) as unknown[];
  if (status === "unverified") return host === null && port === null && databaseName === null
    ? { status, host, port, databaseName } : null;
  if (status !== "candidate" || typeof host !== "string" || host.length < 3 || host.length > 253 ||
    !/^[a-z0-9.-]+$/.test(host) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof databaseName !== "string" || databaseName.length < 1 || databaseName.length > 128 ||
    databaseName !== databaseName.trim() || !/^[A-Za-z0-9_. -]+$/.test(databaseName) || !/[A-Za-z0-9]/.test(databaseName)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !/^[a-z]/.test(labels.at(-1)!) || labels.some(label =>
    label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return { status, host, port, databaseName };
}
