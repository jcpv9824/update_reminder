import type { HttpResponseInit } from "@azure/functions";

export function ok(body: unknown): HttpResponseInit {
  return { status: 200, jsonBody: body };
}

export function created(body: unknown): HttpResponseInit {
  return { status: 201, jsonBody: body };
}

export function noContent(): HttpResponseInit {
  return { status: 204 };
}

export function badRequest(message: string): HttpResponseInit {
  return { status: 400, jsonBody: { error: message } };
}

export function conflict(message: string, details?: Record<string, unknown>): HttpResponseInit {
  return { status: 409, jsonBody: { error: message, message, ...details } };
}

export function unauthorized(): HttpResponseInit {
  return { status: 401, jsonBody: { error: "No autenticado." } };
}

export function forbidden(message = "No tiene permisos."): HttpResponseInit {
  return { status: 403, jsonBody: { error: message } };
}

export function notFound(message = "No encontrado."): HttpResponseInit {
  return { status: 404, jsonBody: { error: message } };
}

export function serverError(err: unknown): HttpResponseInit {
  const e = err as any;
  const status = typeof e?.status === "number" ? e.status : 500;
  const message = e?.message ?? "Error interno del servidor.";
  return { status, jsonBody: { error: message } };
}
