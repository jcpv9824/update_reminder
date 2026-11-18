import { isIP } from "node:net";
import type { CatalogEnvironment } from "./catalogSourceConfiguration";

const DNS = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validHost = (host: unknown): host is string => typeof host === "string" && host.length <= 253 &&
  host.trim() === host && DNS.test(host) && isIP(host) === 0 && /[a-z]/i.test(host.slice(host.lastIndexOf(".") + 1));
const validPort = (port: unknown): port is number => typeof port === "number" &&
  Number.isInteger(port) && port >= 1 && port <= 65535;
const validEnvironment = (value: unknown): value is CatalogEnvironment => value === "qa" || value === "production";
const route = (environment: CatalogEnvironment, host: string, port: number) => `${environment}:${host.toLowerCase()}:${port}`;

/**
 * Accepts only server-owned configuration, never browser-supplied registry data.
 * An alias needs its own approved entry. A resolved ID permits a verification
 * attempt; only a matching live database fingerprint can prove identity.
 */
export function resolveCatalogSqlInstanceRoute(config: string | undefined, environment: CatalogEnvironment,
  host: string, port: number): string | null {
  if (!config || config.length > 131_072 || !validEnvironment(environment) || !validHost(host) || !validPort(port)) return null;
  let entries: unknown;
  try { entries = JSON.parse(config); } catch { return null; }
  if (!Array.isArray(entries) || entries.length > 256) return null;

  const approved = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 4 ||
        !["environment", "host", "port", "instanceId"].every(key => Object.hasOwn(entry, key))) return null;
    const { environment, host, port, instanceId } = entry as Record<string, unknown>;
    if (!validEnvironment(environment) || !validHost(host) || !validPort(port) || typeof instanceId !== "string" ||
        instanceId.length !== 36 || !UUID.test(instanceId) || instanceId === "00000000-0000-0000-0000-000000000000") return null;
    const key = route(environment, host, port);
    if (approved.has(key)) return null;
    approved.set(key, instanceId.toLowerCase());
  }
  return approved.get(route(environment, host, port)) ?? null;
}
