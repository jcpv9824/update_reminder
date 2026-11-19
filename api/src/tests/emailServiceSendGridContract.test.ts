import sendGridClient from "@sendgrid/client";
import { expect, it } from "vitest";

// Keep the real, statically loaded SDK separate from the mocked transport suite.
it("preserves the actual AbortSignal through the installed SendGrid request builder", () => {
  const { Client } = sendGridClient as typeof sendGridClient & { Client: new () => typeof sendGridClient };
  const client = new Client();
  const controller = new AbortController();
  client.setDefaultRequest({ signal: controller.signal, timeout: 60_000 } as unknown as Parameters<typeof client.setDefaultRequest>[0]);
  const request = client.createRequest({ url: "/v3/mail/send", method: "POST" });
  expect(request).toHaveProperty("signal", controller.signal);
  expect(request).toHaveProperty("timeout", 60_000);
});
