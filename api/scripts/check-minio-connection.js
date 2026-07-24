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

function safeError(error) {
  return {
    name: error?.name || "Error",
    statusCode: error?.$metadata?.httpStatusCode || null,
    message: String(error?.message || "MinIO request failed.")
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
  const endpoint = required("OBJECT_STORAGE_ENDPOINT");
  const region = required("OBJECT_STORAGE_REGION");
  const bucket = required("OBJECT_STORAGE_BUCKET");
  const accessKeyId = required("OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = required("OBJECT_STORAGE_SECRET_ACCESS_KEY");
  const mode = process.env.MINIO_PROBE_MODE === "write" ? "write" : "readonly";
  const prefix = "portal-sag/connection-tests";

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  let temporaryKey = null;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    const list = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "portal-sag/",
      MaxKeys: 1,
    }));

    let versioning = "not_authorized";
    try {
      const result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
      versioning = result.Status || "disabled";
    } catch {
      // Versioning inspection is useful but not required by the runtime identity.
    }

    const result = {
      authenticated: true,
      bucketReachable: true,
      listPrefixAllowed: true,
      prefixHasObjects: Number(list.KeyCount || 0) > 0,
      versioning,
      writeReadDeleteProbe: "not_requested",
    };

    if (mode === "write") {
      const bytes = crypto.randomBytes(48);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      temporaryKey = `${prefix}/${crypto.randomUUID()}.bin`;

      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: temporaryKey,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: "application/octet-stream",
        Metadata: { sha256 },
        IfNoneMatch: "*",
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
      result.writeReadDeleteProbe = "passed";
    }

    console.log("MinIO connection succeeded.");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("MinIO connection failed.");
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
  console.error("MinIO connection failed.");
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
});
