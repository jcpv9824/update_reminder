// Convierte un valor de dominio (URL completa o no) en su forma publicable
// que se pega en sistemas externos de hosting/admin.
// Espejo del helper del backend (api/src/lib/domainFormat.ts).
export function formatDomainForPublishing(input: unknown): string {
  if (input == null) return "";
  let s: string;
  try {
    s = String(input);
  } catch {
    return "";
  }
  s = s.trim();
  if (!s) return "";
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//, "");
  const at = s.lastIndexOf("@");
  if (at !== -1 && (at < s.indexOf("/") || s.indexOf("/") === -1)) {
    s = s.slice(at + 1);
  }
  const cortePath = s.search(/[\/?#]/);
  if (cortePath !== -1) s = s.slice(0, cortePath);
  s = s.replace(/:\d+$/, "");
  s = s.trim().toLowerCase();
  return s;
}
