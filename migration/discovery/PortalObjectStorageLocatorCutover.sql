/*
  Operator-reviewed single SQL batch, not part of the automatic migration runner.
  Caller must bind @ExpectedDatabase nvarchar(128), @Action varchar(12),
  @CommitChanges bit, and @Manifest nvarchar(max), as parameters (never print the manifest).
  @Action is 'cutover' or 'rollback'. @CommitChanges=0 exercises the transaction and rolls back.

  Manifest: a verified JSON array (each size and SHA-256 obtained by re-reading S3):
    fileId (decimal string), contentSha256 (64 lowercase hex), byteCount,
    sourceContainer, sourceBlob, sourceBucket/null, sourceKey/null, sourceEtag/null,
    destinationBucket, destinationKey, destinationEtag.
  SourceBucket/Key/Etag are the pre-cutover SQL values, not inferred from Azure response headers.
  DestinationKey must be <base>/Archivos/migration/files/<fileId>-<contentSha256>.

  Preconditions: verified target credentials, backup and tested restore, maintenance window,
  paused writes/timers/workers and expired upload URLs, reviewed protected manifest.
  Rollback requires all post-cutover S3 writes/staging to be reconciled before this batch.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF @ExpectedDatabase IS NULL OR @ExpectedDatabase COLLATE Latin1_General_100_BIN2
    NOT IN (N'PortalSAGWeb', N'PortalSAGWeb-TEST')
   OR DB_NAME() COLLATE Latin1_General_100_BIN2 <> @ExpectedDatabase COLLATE Latin1_General_100_BIN2
   OR DATALENGTH(DB_NAME()) <> DATALENGTH(@ExpectedDatabase)
    THROW 53060, N'Wrong database for the object locator manifest.', 1;
IF @Action IS NULL OR @Action COLLATE Latin1_General_100_BIN2 NOT IN ('cutover','rollback')
   OR (@Action='cutover' AND DATALENGTH(@Action)<>7) OR (@Action='rollback' AND DATALENGTH(@Action)<>8)
   OR @CommitChanges IS NULL OR @@TRANCOUNT<>0
    THROW 53061, N'Invalid locator action or transaction scope.', 1;
IF COALESCE(ISJSON(@Manifest),0)<>1 OR LEFT(LTRIM(@Manifest),1)<>N'[' OR DATALENGTH(@Manifest)>8000000
    THROW 53062, N'The object locator manifest is invalid or exceeds its size limit.', 1;
IF CONVERT(int,SERVERPROPERTY('ProductMajorVersion'))<>15
   OR (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID())<>150
    THROW 53063, N'This locator batch requires SQL Server 2019 and compatibility level 150.', 1;

DECLARE @raw TABLE(
    fileId nvarchar(max), contentSha256 nvarchar(max), byteCount nvarchar(max),
    sourceContainer nvarchar(max), sourceBlob nvarchar(max), sourceBucket nvarchar(max),
    sourceKey nvarchar(max), sourceEtag nvarchar(max), destinationBucket nvarchar(max),
    destinationKey nvarchar(max), destinationEtag nvarchar(max)
);
IF EXISTS (SELECT 1 FROM OPENJSON(@Manifest) WHERE [type]<>5)
    THROW 53064, N'The manifest must contain only locator objects.', 1;
INSERT @raw
SELECT r.* FROM OPENJSON(@Manifest) AS j
CROSS APPLY OPENJSON(j.[value]) WITH(
    fileId nvarchar(max), contentSha256 nvarchar(max), byteCount nvarchar(max),
    sourceContainer nvarchar(max), sourceBlob nvarchar(max), sourceBucket nvarchar(max),
    sourceKey nvarchar(max), sourceEtag nvarchar(max), destinationBucket nvarchar(max),
    destinationKey nvarchar(max), destinationEtag nvarchar(max)
) AS r;
DECLARE @expected bigint=(SELECT COUNT_BIG(*) FROM @raw);
IF @expected NOT BETWEEN 1 AND 5000 OR EXISTS(
  SELECT 1 FROM @raw
  WHERE fileId IS NULL OR DATALENGTH(fileId) NOT BETWEEN 2 AND 38 OR fileId COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%'
     OR COALESCE(TRY_CONVERT(bigint,CONVERT(nvarchar(19),fileId)),0)<=0 OR LEFT(fileId,1)=N'0'
     OR contentSha256 IS NULL OR DATALENGTH(contentSha256)<>128
     OR contentSha256 COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9a-f]%'
     OR byteCount IS NULL OR DATALENGTH(byteCount) NOT BETWEEN 2 AND 38 OR byteCount COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%'
     OR COALESCE(TRY_CONVERT(bigint,CONVERT(nvarchar(19),byteCount)),0)<=0
     OR sourceContainer IS NULL OR DATALENGTH(sourceContainer) NOT BETWEEN 2 AND 200 OR LEN(sourceContainer)=0
     OR sourceBlob IS NULL OR DATALENGTH(sourceBlob) NOT BETWEEN 2 AND 2048 OR LEN(sourceBlob)=0
     OR DATALENGTH(sourceBucket)>510 OR DATALENGTH(sourceKey)>2048 OR DATALENGTH(sourceEtag)>400
     OR destinationBucket IS NULL OR DATALENGTH(destinationBucket) NOT BETWEEN 6 AND 126
     OR destinationBucket COLLATE Latin1_General_100_BIN2 LIKE N'%[^a-z0-9.-]%'
     OR destinationKey IS NULL OR DATALENGTH(destinationKey)>2048
     OR CONVERT(varbinary(2048), destinationKey) <> CONVERT(varbinary(2048),
          CONCAT(@ExpectedDatabase,N'/Archivos/migration/files/',fileId,N'-',contentSha256))
     OR destinationEtag IS NULL OR DATALENGTH(destinationEtag) NOT BETWEEN 2 AND 400 OR LEN(destinationEtag)=0
)
    THROW 53065, N'A manifest locator failed length, prefix, hash, or identity validation.', 1;
IF EXISTS (SELECT 1 FROM @raw GROUP BY CONVERT(varchar(19),fileId) HAVING COUNT_BIG(*)>1)
   OR (SELECT COUNT(DISTINCT CONVERT(nvarchar(63), destinationBucket)) FROM @raw)<>1
    THROW 53066, N'The manifest has duplicate file identities or more than one destination bucket.', 1;

DECLARE @map TABLE(
    fileId bigint PRIMARY KEY, contentSha256 binary(32) NOT NULL, byteCount bigint NOT NULL,
    sourceContainer nvarchar(100) NOT NULL, sourceBlob nvarchar(1024) NOT NULL, sourceBucket nvarchar(255),
    sourceKey nvarchar(1024), sourceEtag nvarchar(200), destinationBucket nvarchar(63) NOT NULL,
    destinationKey nvarchar(1024) NOT NULL, destinationEtag nvarchar(200) NOT NULL
);
INSERT @map
SELECT fileId,CONVERT(binary(32),contentSha256,2),byteCount,sourceContainer,sourceBlob,
       sourceBucket,sourceKey,sourceEtag,destinationBucket,destinationKey,destinationEtag
FROM @raw;

BEGIN TRY
  BEGIN TRANSACTION;
  DECLARE @guideProvider varchar(30)=CASE @Action WHEN 'cutover' THEN 'azure_blob' ELSE 's3' END;
  DECLARE @targetProvider varchar(30)=CASE @Action WHEN 'cutover' THEN 's3' ELSE 'azure_blob' END;
  DECLARE @guideCount bigint,@claimCount bigint,@liveCount bigint;
  DECLARE @publicFileIds TABLE(fileId bigint NOT NULL PRIMARY KEY);
  IF @PublicEndpointsOnly=1
  BEGIN
    IF EXISTS(
        SELECT 1 FROM content.public_download_documents AS d WITH(TABLOCKX,HOLDLOCK)
        LEFT JOIN content.public_download_files AS v WITH(TABLOCKX,HOLDLOCK)
          ON v.document_key=d.document_key AND v.is_current=1
        WHERE d.active=1 AND d.status<>'deleted' AND v.file_key IS NULL
      ) OR EXISTS(
        SELECT 1 FROM content.public_files AS p WITH(TABLOCKX,HOLDLOCK)
        LEFT JOIN content.public_file_versions AS v WITH(TABLOCKX,HOLDLOCK)
          ON v.public_file_key=p.public_file_key AND v.is_current=1
        WHERE p.active=1 AND p.status<>'deleted' AND v.file_key IS NULL
      )
      THROW 53073, N'Active public endpoint files differ from the scoped manifest.', 1;
    INSERT @publicFileIds (fileId)
      SELECT v.file_key FROM content.public_download_documents AS d WITH(TABLOCKX,HOLDLOCK)
      INNER JOIN content.public_download_files AS v WITH(TABLOCKX,HOLDLOCK)
        ON v.document_key=d.document_key AND v.is_current=1
      WHERE d.active=1 AND d.status<>'deleted'
      UNION
      SELECT v.file_key FROM content.public_files AS p WITH(TABLOCKX,HOLDLOCK)
      INNER JOIN content.public_file_versions AS v WITH(TABLOCKX,HOLDLOCK)
        ON v.public_file_key=p.public_file_key AND v.is_current=1
      WHERE p.active=1 AND p.status<>'deleted';
    IF EXISTS(SELECT fileId FROM @publicFileIds EXCEPT SELECT fileId FROM @map)
       OR EXISTS(SELECT fileId FROM @map EXCEPT SELECT fileId FROM @publicFileIds)
      THROW 53073, N'Active public endpoint files differ from the scoped manifest.', 1;
  END;

  -- Exclusive table locks close the SQL race window; storage writers still must be stopped.
  SELECT @liveCount=COUNT_BIG(*) FROM content.files AS f WITH (TABLOCKX,HOLDLOCK)
   WHERE storage_provider=@guideProvider AND
        (@PublicEndpointsOnly=0 OR EXISTS(SELECT 1 FROM @publicFileIds AS p WHERE p.fileId=f.file_key));
  SELECT @guideCount=COUNT_BIG(*) FROM content.guide_sessions WITH (TABLOCKX,HOLDLOCK) WHERE upload_storage_provider=@guideProvider;
  SELECT @claimCount=COUNT_BIG(*) FROM content.object_deletion_claims WITH (TABLOCKX,HOLDLOCK) WHERE storage_provider=@guideProvider;
  IF @guideCount<>0 OR @claimCount<>0
      THROW 53067, N'Guide staging or deletion claims still depend on the provider; reconcile them first.', 1;
  IF @liveCount<>@expected
      THROW 53068, N'Provider file count differs from the manifest; inventory the delta before proceeding.', 1;

  DECLARE @verified bigint;
  SELECT @verified=COUNT_BIG(*)
  FROM content.files AS f INNER JOIN @map AS m ON m.fileId=f.file_key
  WHERE f.storage_provider=@guideProvider AND f.content_sha256=m.contentSha256 AND f.byte_count=m.byteCount
    AND CONVERT(varbinary(200),f.storage_container)=CONVERT(varbinary(200),m.sourceContainer)
    AND CONVERT(varbinary(2048),f.blob_name)=CONVERT(varbinary(2048),m.sourceBlob)
    AND EXISTS (
        SELECT CONVERT(varbinary(510),f.storage_bucket), CONVERT(varbinary(2048),f.object_key), CONVERT(varbinary(400),f.object_etag)
        INTERSECT
        SELECT CONVERT(varbinary(510),CASE WHEN @Action='cutover' THEN m.sourceBucket ELSE m.destinationBucket END),
               CONVERT(varbinary(2048),CASE WHEN @Action='cutover' THEN m.sourceKey ELSE m.destinationKey END),
               CONVERT(varbinary(400),CASE WHEN @Action='cutover' THEN m.sourceEtag ELSE m.destinationEtag END)
    );
  IF @verified<>@expected
      THROW 53069, N'One or more rows do not match the verified locator manifest.', 1;

  UPDATE f SET storage_provider=@targetProvider,
      storage_bucket=CASE WHEN @Action='cutover' THEN m.destinationBucket ELSE m.sourceBucket END,
      object_key=CASE WHEN @Action='cutover' THEN m.destinationKey ELSE m.sourceKey END,
      object_etag=CASE WHEN @Action='cutover' THEN m.destinationEtag ELSE m.sourceEtag END
  FROM content.files AS f INNER JOIN @map AS m ON m.fileId=f.file_key;
  DECLARE @updated bigint=ROWCOUNT_BIG();
  IF @updated<>@expected OR EXISTS (SELECT 1 FROM content.files AS f WHERE f.storage_provider=@guideProvider
      AND (@PublicEndpointsOnly=0 OR EXISTS(SELECT 1 FROM @publicFileIds AS p WHERE p.fileId=f.file_key)))
      THROW 53070, N'The locator update did not cover all rows for the previous provider.', 1;
  IF @expected<>(
    SELECT COUNT_BIG(*)
    FROM content.files AS f INNER JOIN @map AS m ON m.fileId=f.file_key
    WHERE f.storage_provider=@targetProvider AND f.content_sha256=m.contentSha256 AND f.byte_count=m.byteCount
      AND CONVERT(varbinary(200),f.storage_container)=CONVERT(varbinary(200),m.sourceContainer)
      AND CONVERT(varbinary(2048),f.blob_name)=CONVERT(varbinary(2048),m.sourceBlob)
      AND EXISTS (
          SELECT CONVERT(varbinary(510),f.storage_bucket), CONVERT(varbinary(2048),f.object_key), CONVERT(varbinary(400),f.object_etag)
          INTERSECT
          SELECT CONVERT(varbinary(510),CASE WHEN @Action='cutover' THEN m.destinationBucket ELSE m.sourceBucket END),
                 CONVERT(varbinary(2048),CASE WHEN @Action='cutover' THEN m.destinationKey ELSE m.sourceKey END),
                 CONVERT(varbinary(400),CASE WHEN @Action='cutover' THEN m.destinationEtag ELSE m.sourceEtag END)
      )
  )
      THROW 53072, N'Post-update locators did not reconcile with the verified manifest.', 1;

  IF @CommitChanges=1 COMMIT TRANSACTION; ELSE ROLLBACK TRANSACTION;
  SELECT @ExpectedDatabase AS [database],@Action AS [action],@CommitChanges AS committed,@expected AS verified_files;
END TRY
BEGIN CATCH
  IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
  IF ERROR_NUMBER() BETWEEN 53067 AND 53070 OR ERROR_NUMBER() IN (53072,53073) THROW;
  THROW 53071, N'Locator transaction failed and was rolled back; details withheld.', 1;
END CATCH;
