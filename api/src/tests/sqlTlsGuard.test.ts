import { afterEach, describe, expect, it } from "vitest";
import { createServer, connect, type Server, type Socket } from "node:net";
import { createTdsWireInspector } from "../lib/outboundGuard";
import { CompanyDatabaseSchema, createCompanyDatabaseOpener } from "../lib/companyDatabase";

/*
  Regresión: Tedious 20 (TDS 7.x, SQL Server 2019) continúa al LOGIN7 sin TLS
  si el servidor responde en PRELOGIN que no soporta cifrado. El conector del
  portal debe cortar la conexión antes de enviar usuario y contraseña.
*/

const PASSWORD = "Clave-Secreta-De-Prueba-123";

/** Respuesta PRELOGIN como la de SQL Server 2019 (versión 15.0.2000) con el valor de cifrado indicado. */
function preloginResponse(encryption: number): Buffer {
  const tokens = Buffer.from([0x00, 0x00, 0x0b, 0x00, 0x06, 0x01, 0x00, 0x11, 0x00, 0x01, 0xff]);
  const data = Buffer.from([0x0f, 0x00, 0x07, 0xd0, 0x00, 0x00, encryption]);
  const payload = Buffer.concat([tokens, data]);
  const header = Buffer.alloc(8);
  header[0] = 0x04; // respuesta tabular
  header[1] = 0x01; // fin de mensaje
  header.writeUInt16BE(payload.length + 8, 2);
  header[6] = 0x01;
  return Buffer.concat([header, payload]);
}

type FakeServer = { server: Server; port: number; received: Buffer[] };

function startFakeSqlServer(encryption: number): Promise<FakeServer> {
  const received: Buffer[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let answered = false;
      socket.on("data", (chunk) => {
        received.push(chunk);
        if (!answered && chunk[0] === 0x12) {
          answered = true;
          socket.write(preloginResponse(encryption));
        }
      });
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, received });
    });
  });
}

let running: Server | null = null;
afterEach(async () => {
  await new Promise((resolve) => (running ? running.close(() => resolve(undefined)) : resolve(undefined)));
  running = null;
});

describe("SQL login never leaves without TLS (SQL Server 2019 / TDS 7.4)", () => {
  it.each([
    ["not supported (0x02)", 0x02],
    ["off (0x00)", 0x00],
  ])("aborts before LOGIN7 when the server answers encryption %s", async (_label, encryption) => {
    const fake = await startFakeSqlServer(encryption);
    running = fake.server;
    // El nombre «resuelve» a una IP pública (el filtro de destinos pasa) y la conexión
    // de la prueba se dirige al servidor falso local.
    const open = createCompanyDatabaseOpener(
      async () => ["20.30.40.50"],
      () => connect({ host: "127.0.0.1", port: fake.port }),
    );
    const error = await open(CompanyDatabaseSchema.parse({
      server: "sql.ejemplo.co,1433", databaseName: "SAGWebDemo", username: "usuario_sql", password: PASSWORD,
    })).catch((e) => e);

    // Primero lo que importa: nada distinto del PRELOGIN llegó al servidor.
    const wire = Buffer.concat(fake.received);
    expect(fake.received.some((chunk) => chunk[0] === 0x10)).toBe(false); // nunca LOGIN7
    expect(wire.includes(Buffer.from("usuario_sql", "utf16le"))).toBe(false);
    expect(wire.length).toBeGreaterThan(0);
    expect(wire[0]).toBe(0x12); // solo llegó el PRELOGIN
    expect(error?.message).toContain("no aceptó una conexión cifrada");
  });
});

describe("TDS wire inspector", () => {
  function prelogin(length = 20): Buffer {
    const packet = Buffer.alloc(length);
    packet[0] = 0x12;
    packet[1] = 0x01;
    packet.writeUInt16BE(length, 2);
    return packet;
  }
  function tlsRecord(type: number, length = 10): Buffer {
    const record = Buffer.alloc(5 + length);
    record[0] = type;
    record[1] = 0x03;
    record[2] = 0x03;
    record.writeUInt16BE(length, 3);
    return record;
  }

  it("accepts PRELOGIN packets and TLS records, even split across writes", () => {
    const accept = createTdsWireInspector();
    const stream = Buffer.concat([prelogin(), tlsRecord(0x16, 40), tlsRecord(0x17, 100), prelogin(9)]);
    for (let i = 0; i < stream.length; i += 3) expect(accept(stream.subarray(i, i + 3))).toBe(true);
  });

  it("rejects a plaintext LOGIN7 or SQL batch", () => {
    const login7 = Buffer.alloc(30);
    login7[0] = 0x10;
    login7.writeUInt16BE(30, 2);
    const accept = createTdsWireInspector();
    expect(accept(prelogin())).toBe(true);
    expect(accept(login7)).toBe(false);
    const batch = Buffer.alloc(12);
    batch[0] = 0x01;
    expect(createTdsWireInspector()(batch)).toBe(false);
  });

  it("rejects something that looks like TLS but is not", () => {
    const fake = tlsRecord(0x17);
    fake[1] = 0x09;
    expect(createTdsWireInspector()(fake)).toBe(false);
  });
});
