import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAlertsSettings } from "../types/models";

const fake = vi.hoisted(() => ({ request: vi.fn(), defaults: vi.fn(), apiKey: vi.fn() }));
vi.mock("../lib/settingsService", () => ({ getSmtpPassword: async () => "synthetic-only", loadEmailAlertsSettings: vi.fn() }));
vi.mock("@sendgrid/client", () => ({ default: { Client: class {
  setDefaultRequest = fake.defaults;
  setApiKey = fake.apiKey;
  request = fake.request;
} } }));
vi.mock("@sendgrid/mail", () => ({ default: { MailService: class {
  private client!: { request: typeof fake.request };
  setClient(client: { request: typeof fake.request }) { this.client = client; }
  setApiKey() { /* synthetic */ }
  send(message: unknown) { return this.client.request(message); }
} } }));
import { sendEmail } from "../lib/emailService";

const settings = { emailProvider: "smtp", smtpHost: "127.0.0.1", smtpPort: 1,
  smtpUser: "synthetic", smtpSecure: false, emailFrom: "qa@example.test", emailFromName: "QA" } as EmailAlertsSettings;
const message = { to: "qa@example.test", subject: "Prueba sintética", text: "Prueba" };

describe("email provider bounded lease window", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("does not open a transport if the final lease check fails", async () => {
    const beforeSend = vi.fn().mockResolvedValue(false);
    expect(await sendEmail(message, settings, { outboxClaimed: true, beforeSend })).toMatchObject({ ok: false, leaseLost: true });
    expect(beforeSend).toHaveBeenCalledOnce();
  });

  it.each([false, true])("closes a real local SMTP socket at the hard deadline (secure=%s)", async secure => {
    const sockets = new Set<Socket>();
    let sawCommand!: () => void;
    const commandSeen = new Promise<void>(resolve => { sawCommand = resolve; });
    let socketClosed!: () => void;
    const closed = new Promise<void>(resolve => { socketClosed = resolve; });
    let observed = Buffer.alloc(0);
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); socketClosed(); });
      socket.on("error", () => undefined);
      if (!secure) socket.write("220 local-synthetic SMTP\r\n");
      socket.once("data", data => { observed = data; sawCommand(); }); // No EHLO/TLS response.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local test port");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const delivery = sendEmail(message, { ...settings, smtpPort: address.port, smtpSecure: secure }, {
        outboxClaimed: true, beforeSend: async () => true,
      });
      await commandSeen;
      if (secure) {
        expect(observed[0]).toBe(0x16); // Actual TLS ClientHello, never plaintext SMTP.
        expect(observed.includes(Buffer.from("synthetic"))).toBe(false);
      } else expect(observed.toString()).toMatch(/^(EHLO|HELO) /);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await delivery).toMatchObject({ ok: false, provider: "smtp" });
      await closed;
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("uses a per-delivery SendGrid client whose real request signal aborts at the deadline", async () => {
    vi.stubEnv("SENDGRID_API_KEY", "synthetic-not-a-real-key");
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fake.defaults.mockImplementation((value: { signal: AbortSignal }) => { signal = value.signal; });
    fake.request.mockImplementation(() => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const delivery = sendEmail(message, { ...settings, emailProvider: "sendgrid" }, {
      outboxClaimed: true, beforeSend: async () => true,
    });
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalled());
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(true);
    expect(await delivery).toMatchObject({ ok: false, provider: "sendgrid" });
  });

  it("preserves the actual AbortSignal through the installed SendGrid request builder", async () => {
    const module = await vi.importActual<typeof import("@sendgrid/client")>("@sendgrid/client");
    const { Client } = module.default as typeof module.default & { Client: new () => typeof module.default };
    const client = new Client();
    const controller = new AbortController();
    client.setDefaultRequest({ signal: controller.signal, timeout: 60_000 } as unknown as Parameters<typeof client.setDefaultRequest>[0]);
    const request = client.createRequest({ url: "/v3/mail/send", method: "POST" });
    expect(request).toHaveProperty("signal", controller.signal);
    expect(request).toHaveProperty("timeout", 60_000);
  });

  it("returns controlled provider errors without persisting driver/request details", async () => {
    vi.stubEnv("SENDGRID_API_KEY", "synthetic-not-a-real-key");
    fake.request.mockRejectedValue(new Error("synthetic-private-host-and-auth-data"));
    const result = await sendEmail(message, { ...settings, emailProvider: "sendgrid" }, { outboxClaimed: true, beforeSend: async () => true });
    expect(result).toEqual({ ok: false, provider: "sendgrid", error: "No se pudo confirmar el envío SendGrid." });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });
});
