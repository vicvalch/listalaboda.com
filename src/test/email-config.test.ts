import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { parseAppOrigin, parseEmailConfig, parseSender } = await import("@/lib/email/config");

const SECRET = "re_test_do_not_print_me";

const resendSource = {
  APP_ORIGIN: "https://bodas.example.com",
  EMAIL_FROM: "ListaLaBoda <invitaciones@bodas.example.com>",
  RESEND_API_KEY: SECRET,
};

describe("trusted app origin", () => {
  it("accepts an exact https origin (trailing slash tolerated) and local http", () => {
    expect(parseAppOrigin("https://bodas.example.com")).toBe("https://bodas.example.com");
    expect(parseAppOrigin("https://bodas.example.com/")).toBe("https://bodas.example.com");
    expect(parseAppOrigin("http://localhost:3100")).toBe("http://localhost:3100");
    expect(parseAppOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it.each([
    "bodas.example.com",
    "http://bodas.example.com",
    "https://bodas.example.com/app",
    "https://bodas.example.com?x=1",
    "https://bodas.example.com/#x",
    "https://user:pass@bodas.example.com",
    "javascript:alert(1)",
    "ftp://bodas.example.com",
    "",
  ])("refuses %j (non-https, a path, credentials or not a URL)", (value) => {
    expect(parseAppOrigin(value)).toBeNull();
  });
});

describe("sender", () => {
  it("accepts `Name <address>` or a bare address, normalizing the domain", () => {
    expect(parseSender("ListaLaBoda <invitaciones@Bodas.Example.com>")).toBe(
      "ListaLaBoda <invitaciones@bodas.example.com>",
    );
    expect(parseSender("invitaciones@bodas.example.com")).toBe("invitaciones@bodas.example.com");
  });

  it.each([
    "ListaLaBoda <invitaciones@bodas.example.com>\r\nBcc: x@example.com",
    "<invitaciones@bodas.example.com>",
    "Lista <no es correo>",
    'Lista "x" <invitaciones@bodas.example.com>',
    "no es correo",
  ])("refuses %j", (value) => {
    expect(parseSender(value)).toBeNull();
  });
});

describe("email configuration", () => {
  it("defaults to Resend, with the key, sender and trusted origin", () => {
    expect(parseEmailConfig(resendSource)).toEqual({
      ok: true,
      config: {
        appOrigin: "https://bodas.example.com",
        from: "ListaLaBoda <invitaciones@bodas.example.com>",
        transport: { kind: "resend", apiKey: SECRET },
      },
    });
  });

  it.each(["APP_ORIGIN", "EMAIL_FROM", "RESEND_API_KEY"])("is missing without %s (fails safely)", (name) => {
    expect(parseEmailConfig({ ...resendSource, [name]: "  " })).toEqual({ ok: false, problem: "missing" });
  });

  it("refuses an unknown transport or invalid values, never echoing them", () => {
    for (const source of [
      { ...resendSource, EMAIL_TRANSPORT: "smtp" },
      { ...resendSource, APP_ORIGIN: "http://bodas.example.com" },
      { ...resendSource, EMAIL_FROM: "nadie" },
      { ...resendSource, RESEND_API_KEY: "re_key with spaces" },
    ]) {
      const result = parseEmailConfig(source);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("the local outbox needs an absolute directory AND a localhost origin", () => {
    const outbox = {
      APP_ORIGIN: "http://localhost:3100",
      EMAIL_FROM: "invitaciones@example.com",
      EMAIL_TRANSPORT: "outbox",
      EMAIL_OUTBOX_DIR: "/tmp/outbox",
    };
    expect(parseEmailConfig(outbox)).toEqual({
      ok: true,
      config: {
        appOrigin: "http://localhost:3100",
        from: "invitaciones@example.com",
        transport: { kind: "outbox", dir: "/tmp/outbox" },
      },
    });
    // A deployment can't be switched to writing emails to disk.
    expect(parseEmailConfig({ ...outbox, APP_ORIGIN: "https://bodas.example.com" })).toEqual({
      ok: false,
      problem: "invalid",
    });
    expect(parseEmailConfig({ ...outbox, EMAIL_OUTBOX_DIR: "relative/outbox" })).toEqual({
      ok: false,
      problem: "invalid",
    });
    expect(parseEmailConfig({ ...outbox, EMAIL_OUTBOX_DIR: "" })).toEqual({ ok: false, problem: "missing" });
  });

  it("never exposes the API key through a NEXT_PUBLIC_ name", () => {
    const result = parseEmailConfig({
      ...resendSource,
      RESEND_API_KEY: undefined,
      NEXT_PUBLIC_RESEND_API_KEY: SECRET,
    });
    expect(result).toEqual({ ok: false, problem: "missing" });
  });
});
