export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";
const LEGACY_TOKEN_KEY = "erp_update_token";

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

// El access token vive solo en memoria. La limpieza elimina JWT heredados de
// versiones anteriores sin volver a utilizarlos.
try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch {/* entorno sin storage */}

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
  try { localStorage.removeItem(LEGACY_TOKEN_KEY); } catch {/* entorno sin storage */}
}

function devHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("devUser");
    if (!raw) return {};
    const user = JSON.parse(raw);
    return {
      "x-dev-user-id": user.id ?? "",
      "x-dev-user-email": user.email ?? "",
      "x-dev-user-name": user.displayName ?? user.name ?? "",
      "x-dev-user-roles": Array.isArray(user.roles) ? user.roles.join(",") : (user.roles ?? ""),
    };
  } catch {
    return {};
  }
}

async function execute(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    ...devHeaders(),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
}

export async function restoreSession(force = false): Promise<boolean> {
  if (accessToken && !force) return true;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await execute("POST", "/auth/refresh");
      if (!response.ok) {
        setToken(null);
        return false;
      }
      const data = await response.json() as { token?: string };
      if (!data.token) {
        setToken(null);
        return false;
      }
      setToken(data.token);
      return true;
    } catch {
      setToken(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response = await execute(method, path, body);
  const canRefresh = response.status === 401
    && path !== "/auth/login"
    && path !== "/auth/refresh"
    && path !== "/auth/forgot-password"
    && path !== "/auth/reset-password";
  if (canRefresh && await restoreSession(true)) {
    response = await execute(method, path, body);
  }

  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      const data = await response.json();
      message = data.error ?? message;
    } catch {/* respuesta no JSON */}
    if (response.status === 401) setToken(null);
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
