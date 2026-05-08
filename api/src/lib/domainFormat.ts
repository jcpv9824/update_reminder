// Convierte un valor de dominio (URL completa o no) en su forma publicable
// que se pega en sistemas externos de hosting/admin.
//
// Reglas:
//   - quita protocolo http:// o https://
//   - quita puerto :54678
//   - quita path /algo, query ?x=1, y hash #y
//   - quita slash final
//   - trim + lowercase
//   - nunca lanza: si la entrada es inválida, devuelve la mejor limpieza posible
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
  // Quitar protocolo case-insensitive.
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//, "");
  // Quitar credenciales si vienen en la URL (user:pass@host).
  const at = s.lastIndexOf("@");
  if (at !== -1 && at < s.indexOf("/") || (at !== -1 && s.indexOf("/") === -1)) {
    s = s.slice(at + 1);
  }
  // Quitar todo lo que esté después de la primera "/" (path), "?" (query) o "#" (hash).
  const cortePath = s.search(/[\/?#]/);
  if (cortePath !== -1) s = s.slice(0, cortePath);
  // Quitar puerto.
  s = s.replace(/:\d+$/, "");
  // Quitar espacios residuales y bajar a minúsculas.
  s = s.trim().toLowerCase();
  return s;
}
