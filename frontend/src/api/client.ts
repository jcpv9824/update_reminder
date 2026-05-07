// Cliente HTTP para llamar al API de Azure Functions.
const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL ?? "/api";

function devHeaders(): Record<string, string> {
  // En modo desarrollo se usa un usuario de prueba almacenado en localStorage.
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("devUser");
    if (!raw) return {};
    const u = JSON.parse(raw);
    return {
      "x-dev-user-id": u.id ?? "",
      "x-dev-user-email": u.email ?? "",
      "x-dev-user-name": u.displayName ?? u.name ?? "",
      "x-dev-user-roles": Array.isArray(u.roles) ? u.roles.join(",") : (u.roles ?? ""),
    };
  } catch {
    return {};
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...devHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    let mensaje = `Error ${res.status}`;
    try {
      const data = await res.json();
      mensaje = data.error ?? mensaje;
    } catch {/* */}
    throw new Error(mensaje);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
