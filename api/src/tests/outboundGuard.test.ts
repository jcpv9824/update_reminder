import { describe, expect, it } from "vitest";
import { hostMatchesAllowList, isInternalAddress, resolvesToPublicAddresses } from "../lib/outboundGuard";

describe("outbound guard", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "no-es-ip",
  ])("treats %s as internal", (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

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
});
