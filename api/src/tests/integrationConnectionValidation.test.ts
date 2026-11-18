import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  configure: vi.fn(), addMiddleware: vi.fn(), send: vi.fn(), destroy: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      middlewareStack = { addRelativeTo: s3.addMiddleware };
      constructor(config: unknown) { s3.configure(config); }
      send(input: unknown) { return s3.send(input); }
      destroy() { s3.destroy(); }
    },
  };
});

import { validateSeaweedFSConnection } from "../lib/integrationConnectionValidation";

const fixture = {
  endpoint: "https://storcube.sagweb.co:8333",
  region: "us-east-1",
  bucket: "qa-objects",
  databaseName: "PortalSAGWeb-TEST",
  forcePathStyle: true,
  accessKey: "fixture-access",
  secretKey: "fixture-secret",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SEAWEEDFS_ENDPOINT", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("SeaweedFS profile validation", () => {
  it("probes only the requested Portal prefix and applies storcube canonical signing", async () => {
    let original: Buffer;
    let sha256: string;
    let deleted = false;
    s3.send.mockImplementation((command: { constructor: { name: string }; input: {
      Body: Buffer; Metadata: { sha256: string };
    } }) => {
      switch (command.constructor.name) {
        case "PutObjectCommand":
          original = command.input.Body;
          sha256 = command.input.Metadata.sha256;
          return {};
        case "HeadObjectCommand":
          if (deleted) throw Object.assign(new Error("missing"), { name: "NotFound" });
          return { ContentLength: original.length, Metadata: { sha256 } };
        case "GetObjectCommand": return { Body: { transformToByteArray: async () => original } };
        case "DeleteObjectCommand": deleted = true; return {};
        default: throw new Error("unexpected operation");
      }
    });
    const result = await validateSeaweedFSConnection(fixture, "tester");
    expect(result.succeeded).toBe(true);
    const [put, ...other] = s3.send.mock.calls.map(([command]) => command.input);
    expect(put.Key).toMatch(/^PortalSAGWeb-TEST\/Archivos\/connection-tests\/[0-9a-f-]+\.probe$/);
    expect(put.IfNoneMatch).toBe("*");
    expect(other.every((command) => command.Key === put.Key)).toBe(true);
    expect(s3.configure).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: fixture.endpoint, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED",
    }));
    const [canonicalHost, options] = s3.addMiddleware.mock.calls[0];
    expect(options).toMatchObject({ relation: "before", toMiddleware: "httpSigningMiddleware" });
    const request = { hostname: "storcube.sagweb.co", headers: { host: "storcube.sagweb.co:8333" } };
    const handler = vi.fn().mockResolvedValue({});
    await canonicalHost(handler)({ request });
    expect(handler).toHaveBeenCalledWith({ request: { ...request, headers: { host: "storcube.sagweb.co" } } });
    expect(s3.destroy).toHaveBeenCalledOnce();
  });

  it("rejects endpoints not authorized by the runtime before sending any request", async () => {
    for (const endpoint of ["https://other.example.com", "https://storcube.sagweb.co:8443", "https://127.0.0.1"]) {
      expect(await validateSeaweedFSConnection({ ...fixture, endpoint }, "tester"))
        .toMatchObject({ succeeded: false });
    }
    expect(s3.configure).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });
});
