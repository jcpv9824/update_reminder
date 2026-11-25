// Isolated QA helper. It performs a real Portal login for the pre-existing
// synthetic applicant without putting a password, token or fixture in the SPA.
import { createServer } from "node:http";
const host = "127.0.0.1";
const port = 5174;
const email = "qa-isolated-schedule-http@example.invalid";
const password = process.env.SCHEDULE_QA_APPLICANT_PASSWORD;
if (process.env.PORTAL_SAG_ENVIRONMENT !== "qa" || !password) {
  throw new Error("Expected an isolated QA applicant password in process memory.");
}
const origin = `http://${host}:${port}`;
const portalOrigin = `http://${host}:5173`;
const portal = `${portalOrigin}/frecuencias`;
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "same-origin",
  "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": `default-src 'none'; form-action 'self' ${portalOrigin}; frame-ancestors 'none'` };
createServer(async (req, res) => {
  if (req.headers.host !== `${host}:${port}`) { res.writeHead(403, headers).end(); return; }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" }).end(
      '<!doctype html><html lang="es"><title>QA aislado</title><h1>Programaciones · QA aislado</h1><form method="post" action="/sign-in"><button>Entrar como solicitante de prueba</button></form></html>');
    return;
  }
  if (req.method !== "POST" || req.url !== "/sign-in" || req.headers.origin !== origin) {
    res.writeHead(403, headers).end(); return;
  }
  try {
    const health = await fetch(`http://${host}:7071/api/portal-runtime-status`, { signal: AbortSignal.timeout(15_000) });
    const info = await health.json();
    if (!health.ok || info.backend !== "sql" || info.sqlConnected !== true || info.timerDisableState !== "all") {
      res.writeHead(503, headers).end("El entorno aislado de QA no se pudo verificar."); return;
    }
    const response = await fetch(`http://${host}:7071/api/auth/login`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(20_000) });
    const cookies = response.headers.getSetCookie();
    await response.body?.cancel();
    if (!response.ok || !cookies.length) { res.writeHead(403, headers).end("No se pudo iniciar la sesión ficticia de QA."); return; }
    res.writeHead(303, { ...headers, "Set-Cookie": cookies, Location: portal }).end();
  } catch {
    res.writeHead(503, headers).end("El Portal de QA no está disponible.");
  }
}).listen(port, host, () => process.stdout.write(`QA sign-in available on ${origin}\n`));
