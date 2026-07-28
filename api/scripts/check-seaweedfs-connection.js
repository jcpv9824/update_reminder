const crypto = require("node:crypto");
const {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function objectPrefix() {
  const prefix = (process.env.OBJECT_STORAGE_PREFIX?.trim() || "portal-sag/runtime")
    .replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..") || !/^[a-zA-Z0-9/_-]+$/.test(prefix)) {
    throw new Error("OBJECT_STORAGE_PREFIX is invalid.");
  }
  return prefix;
}

function safeError(error) {
  let message = String(error?.message || "SeaweedFS S3 request failed.");
  for (const secret of [
    process.env.SEAWEEDFS_ACCESS_KEY_ID,
    process.env.SEAWEEDFS_SECRET_ACCESS_KEY,
  ]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return {
    name: error?.name || "Error",
    statusCode: error?.$metadata?.httpStatusCode || null,
    message: message
      .replace(/AKIA[A-Z0-9]+/g, "[redacted]")
      .slice(0, 300),
  };
}

async function bodyBytes(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isNotFound(error) {
  return error?.name === "NotFound" ||
    error?.name === "NoSuchKey" ||
    error?.$metadata?.httpStatusCode === 404;
}

async function main() {
  const endpoint = required("SEAWEEDFS_ENDPOINT");
  const region = required("SEAWEEDFS_REGION");
  const bucket = required("SEAWEEDFS_BUCKET");
  const accessKeyId = required("SEAWEEDFS_ACCESS_KEY_ID");
  const secretAccessKey = required("SEAWEEDFS_SECRET_ACCESS_KEY");
  const mode = process.env.SEAWEEDFS_PROBE_MODE === "write" ? "write" : "readonly";
  const forcePathStyle = required("SEAWEEDFS_FORCE_PATH_STYLE").toLowerCase();
  if (forcePathStyle !== "true") {
    throw new Error("SEAWEEDFS_FORCE_PATH_STYLE must be true.");
  }
  const prefix = objectPrefix();
  const connectionTestPrefix = `${prefix}/connection-tests`;

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  let temporaryKey = null;
  try {
    let bucketHeadAllowed = false;
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      bucketHeadAllowed = true;
    } catch {
      // Bucket-level diagnostics are optional; runtime access is object-scoped.
    }

    let listPrefixAllowed = false;
    let prefixHasObjects = null;
    try {
      const list = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        MaxKeys: 1,
      }));
      listPrefixAllowed = true;
      prefixHasObjects = Number(list.KeyCount || 0) > 0;
    } catch {
      // Least-privilege runtime credentials may intentionally omit ListBucket.
    }

    let versioning = "not_authorized";
    try {
      const result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      versioning = result.Status || "disabled";
    } catch {
      // Versioning inspection is useful but not required by the runtime identity.
    }

    const result = {
      authenticated: bucketHeadAllowed || listPrefixAllowed,
      bucketHeadAllowed,
      listPrefixAllowed,
      prefixHasObjects,
      versioning,
      writeReadDeleteProbe: "not_requested",
      readonlyObjectAccess: "not_tested_without_known_object_key",
    };

    if (mode === "write") {
      const bytes = crypto.randomBytes(48);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      temporaryKey = `${connectionTestPrefix}/${crypto.randomUUID()}.bin`;

      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: temporaryKey,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: "application/octet-stream",
        Metadata: { sha256 },
      }));

      const head = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: temporaryKey,
      }));
      if (
        Number(head.ContentLength) !== bytes.length ||
        head.Metadata?.sha256?.toLowerCase() !== sha256
      ) {
        throw new Error("Temporary object metadata verification failed.");
      }

      const downloaded = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: temporaryKey,
      }));
      const received = await bodyBytes(downloaded.Body);
      if (crypto.createHash("sha256").update(received).digest("hex") !== sha256) {
        throw new Error("Temporary object download hash verification failed.");
      }

      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey }));
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: temporaryKey }));
        throw new Error("Temporary object still exists after deletion.");
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      temporaryKey = null;
      result.authenticated = true;
      result.writeReadDeleteProbe = "passed";
    }

    console.log("SeaweedFS S3 validation completed.");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("SeaweedFS S3 connection failed.");
    console.error(JSON.stringify(safeError(error)));
    process.exitCode = 1;
  } finally {
    if (temporaryKey) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey }));
      } catch {
        // Never hide the primary error; infrastructure can remove the isolated test prefix if needed.
      }
    }
    client.destroy();
  }
}

main().catch((error) => {
  console.error("SeaweedFS S3 connection failed.");
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
});
