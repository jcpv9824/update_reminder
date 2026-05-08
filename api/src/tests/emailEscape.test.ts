import { describe, it, expect } from "vitest";
import { escapeHtml, renderResetPasswordEmail } from "../lib/emailService";

describe("emailService — escape HTML", () => {
  it("escapeHtml convierte caracteres peligrosos", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeHtml("o'reilly")).toBe("o&#39;reilly");
  });

  it("renderResetPasswordEmail escapa nombre y correo del usuario", () => {
    const tpl = renderResetPasswordEmail({
      displayName: '<img src=x onerror="alert(1)"/>',
      email: 'a"b@x.com',
      resetUrl: "https://app.example.com/reset-password?token=abc",
      expiresInMinutes: 30,
    });
    expect(tpl.html).not.toContain('<img src=x');
    expect(tpl.html).toContain("&lt;img");
    expect(tpl.html).toContain("a&quot;b@x.com");
    expect(tpl.subject).toContain("Restablecer contraseña");
    expect(tpl.html).toContain("vence en 30 minutos");
  });
});
