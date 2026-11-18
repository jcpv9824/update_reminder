export const catalogSqlInstanceNamePattern = /^[A-Za-z][A-Za-z0-9_$#-]{0,15}$/;

/** Trusted local profile notation, not a connection string or a request-time address. */
export function parseCatalogOriginConnectionAddress(address: string | undefined, separatePort?: string) {
  const raw = address?.trim() ?? "";
  const parsed = /^(?:tcp:)?(?<server>[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?:\\(?<instance>[A-Za-z][A-Za-z0-9_$#-]{0,15}))?(?:\s*,\s*(?<port>[0-9]{1,5}))?$/i
    .exec(raw)?.groups
    // Older local profiles may put the assertion after the explicit port. It is still never a driver address.
    ?? /^(?:tcp:)?(?<server>[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)\s*,\s*(?<port>[0-9]{1,5})\\(?<instance>[A-Za-z][A-Za-z0-9_$#-]{0,15})$/i.exec(raw)?.groups;
  const portField = separatePort?.trim() || undefined;
  if (!parsed || parsed.server.includes("..") || (parsed.instance && !parsed.port && !portField) ||
    (portField && !/^[0-9]{1,5}$/.test(portField)) || (parsed.port && portField && Number(portField) !== Number(parsed.port))) return null;
  const port = Number(parsed.port ?? portField ?? "1433");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { server: parsed.server, port, ...(parsed.instance && { expectedInstanceName: parsed.instance }) };
}
