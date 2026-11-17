import { lookup } from "node:dns/promises";
import { connect as netConnect, isIP, type Socket } from "node:net";

/*
  Protección de conexiones salientes hacia destinos que escribe una persona
  (servidor SQL de la compañía, servidor del almacenamiento).

  Se resuelve el nombre y se rechaza si apunta a la red interna: loopback,
  redes privadas, CGNAT, link-local (incluye el servicio de metadatos de
  Azure 169.254.169.254), multicast o direcciones no enrutables. Así el
  portal no puede usarse para llegar a servicios internos.
*/

export type HostResolver = (host: string) => Promise<string[]>;

export const resolveHost: HostResolver = async (host) => {
  if (isIP(host)) return [host];
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((total, part) => (total * 256) + Number(part), 0);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function inRange(address: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToNumber(address) & mask) >>> 0) === ((ipv4ToNumber(base) & mask) >>> 0);
}

export function isInternalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return BLOCKED_IPV4.some((range) => inRange(address, range));
  if (version === 6) {
    const value = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isInternalAddress(mapped[1]);
    return value === "::" || value === "::1"
      || /^f[cd][0-9a-f]{2}:/.test(value)      // fc00::/7 privadas
      || /^fe[89ab][0-9a-f]:/.test(value)      // fe80::/10 link-local
      || /^ff[0-9a-f]{2}:/.test(value);        // multicast
  }
  return true; // lo que no es una IP válida no se usa
}

/** Devuelve true si el nombre resuelve solo a direcciones públicas. */
export async function resolvesToPublicAddresses(host: string, resolver: HostResolver = resolveHost): Promise<boolean> {
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((address) => !isInternalAddress(address));
}

/** Coincide con una lista de servidores aprobados; admite comodín de subdominio («*.sagweb.co»). */
export function hostMatchesAllowList(host: string, allowList: string[]): boolean {
  const value = host.toLowerCase();
  return allowList.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith("*.")) return value.endsWith(rule.slice(1)) && value.length > rule.length - 1;
    return value === rule;
  });
}

/* ------------------------------------------------------------------ */
/* Filtro en la CONEXIÓN REAL (evita que la dirección cambie entre la  */
/* comprobación y la conexión: se conecta solo a lo que se validó).    */
/* ------------------------------------------------------------------ */

export class InternalDestinationError extends Error {
  readonly code = "EINTERNALDESTINATION";
  constructor() {
    super("Destination resolves to an internal or invalid address.");
  }
}

/** Resuelve el nombre y devuelve las direcciones SOLO si todas son públicas. */
export async function resolvePublicAddresses(host: string, resolver: HostResolver = resolveHost): Promise<string[]> {
  const addresses = await resolver(host);
  if (addresses.length === 0 || addresses.some((address) => isInternalAddress(address))) {
    throw new InternalDestinationError();
  }
  return addresses;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * Función `lookup` para agentes HTTPS / sockets de Node: es la que usa el
 * transporte al conectarse, así que la dirección filtrada es la conectada.
 * El nombre original se conserva para la validación TLS (SNI y certificado).
 */
export function createGuardedLookup(resolver: HostResolver = resolveHost) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback): void => {
    const all = typeof options === "object" && options !== null && options.all === true;
    resolvePublicAddresses(hostname, resolver).then(
      (addresses) => {
        const records = addresses.map((address) => ({ address, family: isIP(address) }));
        if (all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}

export type SocketConnector = (options: { host: string; port: number; localAddress?: string }, lookup: unknown, signal: AbortSignal) => Promise<Socket>;
type ConnectFn = (options: { host: string; port: number; family: number; localAddress?: string }) => Socket;

/**
 * Conector para tedious (driver de mssql): resuelve, filtra y se conecta solo a
 * direcciones públicas validadas. También cubre el redireccionamiento (routing)
 * del servidor, porque tedious vuelve a llamar al conector con el nuevo destino.
 */
export function createGuardedSqlConnector(
  resolver: HostResolver = resolveHost,
  connectFn: ConnectFn = (options) => netConnect(options),
): SocketConnector {
  return async (options, _lookup, signal) => {
    signal.throwIfAborted();
    const addresses = await resolvePublicAddresses(options.host, resolver);
    const errors: unknown[] = [];
    for (const address of addresses) {
      try {
        return await new Promise<Socket>((resolve, reject) => {
          const socket = connectFn({ host: address, port: options.port, family: isIP(address), localAddress: options.localAddress });
          const cleanup = () => {
            signal.removeEventListener("abort", onAbort);
            socket.removeListener("error", onError);
            socket.removeListener("connect", onConnect);
          };
          const onAbort = () => { cleanup(); socket.destroy(); reject(signal.reason); };
          const onError = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
          const onConnect = () => { cleanup(); resolve(socket); };
          signal.addEventListener("abort", onAbort, { once: true });
          socket.on("error", onError);
          socket.on("connect", onConnect);
        });
      } catch (error) {
        signal.throwIfAborted();
        errors.push(error);
      }
    }
    throw new AggregateError(errors, "Could not connect (guarded sequence)");
  };
}
