-- Aggregate-only preflight. Does not emit filenames, locators, or credentials.
SELECT DB_NAME() AS database_name, storage_provider, COUNT_BIG(*) AS file_rows,
       SUM(CONVERT(decimal(38,0), byte_count)) AS total_bytes,
       COUNT_BIG(CASE WHEN content_sha256 IS NULL THEN 1 END) AS missing_hash
FROM content.files
GROUP BY storage_provider;

SELECT upload_storage_provider, [status], COUNT_BIG(*) AS session_rows
FROM content.guide_sessions
WHERE upload_storage_provider IS NOT NULL
GROUP BY upload_storage_provider, [status];

SELECT storage_provider, COUNT_BIG(*) AS deletion_claims
FROM content.object_deletion_claims
GROUP BY storage_provider;
