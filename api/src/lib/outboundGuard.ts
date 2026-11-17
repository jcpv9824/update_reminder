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

/**
 * Convierte una IPv6 (cualquier representación válida: comprimida, expandida,
 * mayúsculas, con IPv4 incrustada) a sus 16 bytes. Devuelve null si no se puede
 * interpretar con certeza (por ejemplo, con identificador de zona «%eth0»).
 */
export function ipv6ToBytes(address: string): number[] | null {
  let value = address.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.includes("%") || isIP(value) !== 6) return null;
  let tail: number[] = [];
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (embedded) {
    if (isIP(embedded[1]) !== 4) return null;
    tail = embedded[1].split(".").map(Number);
    value = value.slice(0, -embedded[1].length);
    if (value.endsWith(":") && !value.endsWith("::")) value = value.slice(0, -1);
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const needed = 8 - tail.length / 2;
  const missing = needed - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const word = parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  bytes.push(...tail);
  return bytes.length === 16 ? bytes : null;
}

function internalIpv6(bytes: number[]): boolean {
  const v4 = (offset: number) => bytes.slice(offset, offset + 4).join(".");
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isInternalAddress(v4(12)); // ::ffff:a.b.c.d
  if (zeros(0, 12)) return true;                                    // ::, ::1, ::a.b.c.d (obsoleta)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return zeros(4, 12) ? isInternalAddress(v4(12)) : true;         // NAT64 64:ff9b::/96 y 64:ff9b:1::/48
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isInternalAddress(v4(2)); // 6to4 2002::/16
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentación
  if (bytes[0] === 0x01 && zeros(1, 8)) return true;                // 100::/64 descarte
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return true; // documentación 3fff::/20
  // Solo se considera pública la unicast global 2000::/3; todo lo demás
  // (fc00::/7 privadas, fe80::/10 link-local, fec0::/10, ff00::/8 multicast…) no.
  return (bytes[0] & 0xe0) !== 0x20;
}

export function isInternalAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return BLOCKED_IPV4.some((range) => inRange(address, range));
  if (version === 6) {
    const bytes = ipv6ToBytes(address);
    return bytes === null ? true : internalIpv6(bytes);
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
          const onConnect = () => { cleanup(); resolve(guardTdsSocket(socket)); };
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

/* ------------------------------------------------------------------ */
/* TLS obligatorio ANTES de enviar credenciales SQL (TDS 7.x / SQL 2019) */
/* ------------------------------------------------------------------ */

export class PlaintextSqlLoginError extends Error {
  readonly code = "EPLAINTEXTLOGIN";
  constructor() {
    super("Plaintext SQL traffic blocked: TLS was not negotiated before login.");
  }
}

/**
 * Revisa todo lo que el cliente escribe en el socket TCP. En TDS 7.x solo hay
 * dos cosas legítimas en el cable: paquetes PRELOGIN (tipo 0x12, que también
 * envuelven el saludo TLS) y registros TLS ya cifrados (tipos 0x14–0x17,
 * versión 3.x). Cualquier otra cosa —en particular LOGIN7 (0x10), que lleva
 * usuario y contraseña— significa que el driver iba a enviarla SIN cifrar
 * (por ejemplo, porque el servidor respondió que no soporta cifrado). En ese
 * caso se corta la conexión antes de escribir un solo byte.
 */
export function createTdsWireInspector() {
  let pending = Buffer.alloc(0);
  let remaining = 0;
  return function accept(chunk: Buffer): boolean {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining > 0) {
        const take = Math.min(remaining, chunk.length - offset);
        remaining -= take;
        offset += take;
        continue;
      }
      pending = Buffer.concat([pending, chunk.subarray(offset, offset + 1)]);
      offset += 1;
      const type = pending[0];
      if (type === 0x12) {
        if (pending.length < 8) continue;
        const length = pending.readUInt16BE(2);
        if (length < 8) return false;
        remaining = length - 8;
      } else if (type >= 0x14 && type <= 0x17) {
        if (pending.length < 5) continue;
        if (pending[1] !== 0x03) return false;
        remaining = pending.readUInt16BE(3);
      } else {
        return false;
      }
      pending = Buffer.alloc(0);
    }
    return true;
  };
}

/** Envuelve el socket: lo que no pase el inspector no se escribe y la conexión se corta. */
export function guardTdsSocket(socket: Socket): Socket {
  const accept = createTdsWireInspector();
  const originalWrite = socket.write.bind(socket) as (...args: unknown[]) => boolean;
  let blocked = false;
  (socket as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    if (blocked) return false;
    const encoding = typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : undefined;
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk as Uint8Array);
    if (!accept(buffer)) {
      blocked = true;
      socket.destroy(new PlaintextSqlLoginError());
      return false;
    }
    return originalWrite(chunk, ...rest);
  };
  return socket;
}
