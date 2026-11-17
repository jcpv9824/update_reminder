import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  createGuardedLookup,
  createGuardedSqlConnector,
  hostMatchesAllowList,
  isInternalAddress,
  resolvesToPublicAddresses,
} from "../lib/outboundGuard";
import { createCompanyStorageS3Client, storageErrorMessage } from "../lib/companyLogo";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

function fakeSocket(): Socket {
  const socket = new EventEmitter() as unknown as Socket & { destroy: () => void; write: () => boolean };
  socket.destroy = () => undefined;
  socket.write = () => true;
  setTimeout(() => socket.emit("connect"), 0);
  return socket;
}

describe("outbound guard", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "no-es-ip",
  ])("treats %s as internal", (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each([
    "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::0:1", "[::1]",
    "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:0001", "::FFFF:127.0.0.1", "::ffff:a9fe:a9fe", "::ffff:169.254.169.254",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a00:1::",
    "2001:0:4136:e378::1", "2001:db8::1", "100::1", "FE80::1", "fe80::1%eth0", "FEC0::1", "FC00::1", "FD00:0:0:0::1", "FF02::1",
    "3fff::1", "::",
  ])("treats IPv6 %s as internal whatever its representation", (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each(["2001:4860:4860::8888", "2001:4860:4860:0:0:0:0:8888", "2606:4700:4700::1111", "64:ff9b::808:808", "2002:808:808::1"])(
    "treats IPv6 %s as public",
    (address) => {
      expect(isInternalAddress(address)).toBe(false);
    },
  );

  it.each(["20.30.40.50", "8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"])("treats %s as public", (address) => {
    expect(isInternalAddress(address)).toBe(false);
  });

  it("requires every resolved address to be public", async () => {
    expect(await resolvesToPublicAddresses("x", async () => ["20.30.40.50"])).toBe(true);
    expect(await resolvesToPublicAddresses("x", async () => ["20.30.40.50", "10.0.0.1"])).toBe(false);
    expect(await resolvesToPublicAddresses("x", async () => [])).toBe(false);
    expect(await resolvesToPublicAddresses("x", async () => { throw new Error("ENOTFOUND"); })).toBe(false);
  });

  it("matches exact hosts and subdomain wildcards only", () => {
    const list = ["storcube.sagweb.co", "*.sagweb.co"];
    expect(hostMatchesAllowList("storcube.sagweb.co", list)).toBe(true);
    expect(hostMatchesAllowList("S3.SAGWEB.CO", list)).toBe(true);
    expect(hostMatchesAllowList("sagweb.co", list)).toBe(false);
    expect(hostMatchesAllowList("evilsagweb.co", list)).toBe(false);
    expect(hostMatchesAllowList("sagweb.co.evil.com", list)).toBe(false);
  });

  it("the guarded lookup returns only validated public addresses to the transport", async () => {
    const lookup = createGuardedLookup(async () => ["20.30.40.50", "2001:4860:4860::8888"]);
    const all = await new Promise((resolve) => lookup("x", { all: true }, (_e, a) => resolve(a)));
    expect(all).toEqual([{ address: "20.30.40.50", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }]);
    const one = await new Promise((resolve) => lookup("x", {}, (_e, a, f) => resolve([a, f])));
    expect(one).toEqual(["20.30.40.50", 4]);
    const blocked = createGuardedLookup(async () => ["20.30.40.50", "10.0.0.1"]);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => blocked("x", { all: true }, (e) => resolve(e)));
    expect(error).toMatchObject({ code: "EINTERNALDESTINATION" });
  });

  it("the SQL connector connects only to the addresses it validated", async () => {
    const targets: Array<{ host: string; port: number }> = [];
    const connector = createGuardedSqlConnector(async () => ["20.30.40.50"], (options) => {
      targets.push({ host: options.host, port: options.port });
      return fakeSocket();
    });
    await connector({ host: "sql.ejemplo.co", port: 1433 }, undefined, new AbortController().signal);
    expect(targets).toEqual([{ host: "20.30.40.50", port: 1433 }]);

    const connect = vi.fn(() => fakeSocket());
    const blocked = createGuardedSqlConnector(async () => ["127.0.0.1"], connect);
    await expect(blocked({ host: "sql.ejemplo.co", port: 1433 }, undefined, new AbortController().signal)).rejects.toMatchObject({ code: "EINTERNALDESTINATION" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("the real S3 transport refuses a name that resolves to the internal network", async () => {
    const client = createCompanyStorageS3Client({
      bucket: "demo", accessKey: "AKIAEXAMPLE", secretKey: "SecretExample123",
      options: { endpoint: "localhost", port: 8333, basePath: "Archivos/", region: "us-east-1" },
    });
    try {
      const error = await client.send(new ListObjectsV2Command({ Bucket: "demo", MaxKeys: 1 })).catch((e) => e);
      expect(storageErrorMessage(error).message).toContain("red interna");
    } finally {
      client.destroy();
    }
  });
});
