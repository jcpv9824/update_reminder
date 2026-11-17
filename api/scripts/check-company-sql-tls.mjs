// Prueba de extremo a extremo, SOLO LECTURA, de la conexión a la base de una
// compañía de SAG Web (SQL Server 2019) con el código real del portal:
//   1) Por NOMBRE del servidor: debe completar TLS con certificado válido, iniciar
//      sesión y revisar parametros_web (sin escribir nada).
//   2) Por IP del mismo servidor: debe RECHAZARSE por certificado (el nombre del
//      certificado no coincide con una IP), sin enviar la contraseña en claro.
//
// Uso (después de `npm run build`), en una terminal interactiva:
//   node scripts/check-company-sql-tls.mjs
// Pide servidor,puerto, base, usuario y contraseña. La contraseña no se muestra,
// no se guarda y no se imprime. Usar SOLO con una base de PRUEBAS.
import { createInterface } from "node:readline";
import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { checkCompanyDatabase } = require("../dist/src/lib/companyStorageSetup.js");
const { CompanyDatabaseSchema } = require("../dist/src/lib/companyDatabase.js");

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => { if (text.includes(question)) rl.output.write(text); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function attempt(label, database, expectOk) {
  try {
    const parsed = CompanyDatabaseSchema.parse(database);
    const result = await checkCompanyDatabase(parsed);
    const verdict = expectOk ? "PASS" : "FAIL (se esperaba rechazo)";
    console.log(`${verdict} ${label}: conexión TLS e inicio de sesión correctos; parametros_web revisada (hay logo: ${result.current.hasLogo ? "sí" : "no"}).`);
    return expectOk;
  } catch (error) {
    const message = error?.message ?? "error desconocido";
    const isCertificate = /certificado/i.test(message);
    if (!expectOk && isCertificate) {
      console.log(`PASS ${label}: rechazada por certificado, como se esperaba.`);
      return true;
    }
    console.log(`${expectOk ? "FAIL" : "FAIL (rechazo distinto al de certificado)"} ${label}: ${message}`);
    return false;
  }
}

const server = (await ask("Servidor,puerto (por NOMBRE, ej. data14.sagerp.co,54103): ")).trim();
const databaseName = (await ask("Base de datos de PRUEBAS: ")).trim();
const username = (await ask("Usuario de SQL: ")).trim();
const password = await ask("Contraseña (no se muestra): ", true);

const [host, port] = server.split(",");
let ok = await attempt(`por nombre (${host})`, { server, databaseName, username, password }, true);

try {
  const { address } = await lookup(host, { family: 4 });
  ok = (await attempt(`por IP (${address})`, { server: `${address}${port ? `,${port}` : ""}`, databaseName, username, password }, false)) && ok;
} catch {
  console.log("SKIP por IP: no se pudo resolver la IP del servidor.");
}

process.exit(ok ? 0 : 1);
