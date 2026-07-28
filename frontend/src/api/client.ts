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

export type ApiRequestOptions = {
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
};

async function execute(method: string, path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...devHeaders(),
    ...options.headers,
  };
  // Keep bodyless reads "simple" so authenticated API redirects can continue
  // to private Blob SAS URLs without triggering a cross-origin preflight.
  if (body !== undefined || !["GET", "HEAD"].includes(method.toUpperCase())) {
    headers["Content-Type"] = "application/json";
    headers["X-Requested-With"] = "XMLHttpRequest";
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: options.credentials ?? "include",
  });
}

function canRefreshRequest(status: number, path: string): boolean {
  return status === 401
    && path !== "/auth/login"
    && path !== "/auth/refresh"
    && path !== "/auth/forgot-password"
    && path !== "/auth/reset-password";
}

async function responseError(response: Response): Promise<Error & { status?: number }> {
  let message = `Error ${response.status}`;
  try {
    const data = await response.clone().json();
    message = data.error ?? message;
  } catch {/* respuesta no JSON */}
  if (response.status === 401) setToken(null);
  const error = new Error(message) as Error & { status?: number };
  error.status = response.status;
  return error;
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

async function authenticatedResponse(method: string, path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<Response> {
  let response = await execute(method, path, body, options);
  if (canRefreshRequest(response.status, path) && await restoreSession(true)) {
    response = await execute(method, path, body, options);
  }
  if (!response.ok) {
    throw await responseError(response);
  }
  return response;
}

async function request<T>(method: string, path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<T> {
  const response = await authenticatedResponse(method, path, body, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string, options?: ApiRequestOptions) => request<T>("GET", path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: ApiRequestOptions) => request<T>("POST", path, body, options),
  put: <T>(path: string, body?: unknown, options?: ApiRequestOptions) => request<T>("PUT", path, body, options),
  del: <T>(path: string, options?: ApiRequestOptions) => request<T>("DELETE", path, undefined, options),
  getText: async (path: string, options: ApiRequestOptions = {}) => (
    await authenticatedResponse("GET", path, undefined, { credentials: "omit", ...options })
  ).text(),
  getBlob: async (path: string, options: ApiRequestOptions = {}) => (
    await authenticatedResponse("GET", path, undefined, { credentials: "omit", ...options })
  ).blob(),
};

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

export type SignedUploadRequest = {
  url: string;
  method: "PUT";
  headers?: Record<string, string>;
  file: File;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
};

export function uploadToSignedUrl({
  url,
  method,
  headers = {},
  file,
  onProgress,
  signal,
}: SignedUploadRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    function finish(callback: () => void) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    }
    function abort() {
      xhr.abort();
      finish(() => reject(new DOMException("La carga fue cancelada.", "AbortError")));
    }

    xhr.open(method, url);
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(resolve);
      } else {
        finish(() => reject(new Error("No se pudo cargar el video al almacenamiento.")));
      }
    };
    xhr.onerror = () => finish(() => reject(new Error("No se pudo cargar el video al almacenamiento.")));
    xhr.onabort = () => finish(() => reject(new DOMException("La carga fue cancelada.", "AbortError")));

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
