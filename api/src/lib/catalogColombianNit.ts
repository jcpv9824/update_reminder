/**
 * A directory-only alternative key, not a replacement for the existing
 * exact document token or permission/task/schedule evidence.
 */
export function normalizeCatalogColombianNit(document: string | null,
  scope: Readonly<{ issuer: string; documentType: string }> | undefined): string | null {
  if (document === null || scope?.issuer !== "CO" || scope.documentType !== "NIT") return null;
  const base = document.replace(/\s/gu, "").split("-", 1)[0];
  return /^[0-9]{1,38}$/.test(base) ? base : null;
}
