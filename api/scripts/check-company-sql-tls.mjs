// Prueba de extremo a extremo, SOLO LECTURA, de la conexión a la base de una
// compañía de SAG Web (SQL Server 2019) con el código real del portal:
//   1) Por NOMBRE del servidor: debe completar TLS con certificado válido, iniciar
//      sesión y revisar parametros_web (sin escribir nada).
//   2) Por IP del mismo servidor: debe RECHAZARSE por certificado (el nombre del
//      certificado no coincide con una IP), sin enviar la contraseña en claro.
// Solo sale con código 0 si las DOS pruebas dan PASS. Si alguna no se pudo
// hacer, sale con 1 (INCOMPLETO).
//
// Uso (después de `npm run build`), en una terminal INTERACTIVA:
//   node scripts/check-company-sql-tls.mjs
// La contraseña se lee tecla por tecla en modo crudo: nunca se escribe nada en
// pantalla mientras se teclea, no se guarda y no se imprime. Sin terminal
// interactiva, el script se niega a pedirla. Usar SOLO con una base de PRUEBAS.
import { createInterface } from "node:readline";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { checkCompanyDatabase } = require("../dist/src/lib/companyStorageSetup.js");
const { CompanyDatabaseSchema } = require("../dist/src/lib/companyDatabase.js");

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Este script necesita una terminal interactiva para pedir la contraseña sin mostrarla. No se ejecutó nada.");
  process.exit(1);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Lee la contraseña sin eco: en modo crudo no se escribe en pantalla ningún carácter tecleado. */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === CTRL_C) {
          cleanup();
          process.stdout.write("\nCancelado. No se ejecutó nada.\n");
          process.exit(130);
        }
        if (character === BACKSPACE || character === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function attempt(label, database, expectOk) {
  try {
    const parsed = CompanyDatabaseSchema.parse(database);
    const result = await checkCompanyDatabase(parsed);
    if (expectOk) {
      console.log(`PASS ${label}: conexión TLS e inicio de sesión correctos; parametros_web revisada (hay logo: ${result.current.hasLogo ? "sí" : "no"}).`);
      return true;
    }
    console.log(`FAIL ${label}: se conectó, pero se esperaba un rechazo por certificado.`);
    return false;
  } catch (error) {
    const message = error?.message ?? "error desconocido";
    if (!expectOk && /certificado/i.test(message)) {
      console.log(`PASS ${label}: rechazada por certificado, como se esperaba.`);
      return true;
    }
    console.log(`FAIL ${label}: ${message}`);
    return false;
  }
}

const server = (await ask("Servidor,puerto (por NOMBRE, ej. data14.sagerp.co,54103): ")).trim();
const databaseName = (await ask("Base de datos de PRUEBAS: ")).trim();
const username = (await ask("Usuario de SQL: ")).trim();
const password = await askHidden("Contraseña (no se muestra): ");

const [host, port] = server.split(",");
const byName = await attempt(`por nombre (${host})`, { server, databaseName, username, password }, true);

let byIp = false;
try {
  const { address } = await lookup(host, { family: 4 });
  byIp = await attempt(`por IP (${address})`, { server: `${address}${port ? `,${port}` : ""}`, databaseName, username, password }, false);
} catch {
  console.log("INCOMPLETO por IP: no se pudo resolver la IP del servidor. La prueba no está completa.");
}

if (byName && byIp) {
  console.log("RESULTADO: PASS (las dos pruebas).");
  process.exit(0);
}
console.log("RESULTADO: NO APROBADO (se requieren las dos pruebas en PASS).");
process.exit(1);
