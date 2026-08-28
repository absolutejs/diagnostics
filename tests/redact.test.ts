import { describe, expect, test } from "bun:test";
import { serializeDiagnosticHar } from "../src/har";
import {
  auditDiagnosticText,
  redactDiagnosticArchive,
  redactHarText,
  redactUrl,
} from "../src/redact";
import { archiveFixture } from "./fixtures";

describe("diagnostic redaction", () => {
  test("removes credentials, payment data, card numbers, and query values", () => {
    const redacted = redactDiagnosticArchive(archiveFixture());
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("wallet-secret");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).toContain("[REDACTED]");
    expect(auditDiagnosticText(serialized).safeToShare).toBe(true);
  });

  test("removes every query value unless explicitly safe", () => {
    expect(redactUrl("https://example.com/x?plan=yearly&id=42")).toBe(
      "https://example.com/x?plan=%5BREDACTED%5D&id=%5BREDACTED%5D",
    );
    expect(
      redactUrl("https://example.com/x?plan=yearly&token=nope", {
        preserveQueryValues: ["plan", "token"],
      }),
    ).toBe("https://example.com/x?plan=yearly&token=%5BREDACTED%5D");
  });

  test("exports a parseable, audited HAR 1.2 document", () => {
    const text = serializeDiagnosticHar(archiveFixture());
    const har = JSON.parse(text);

    expect(har.log.version).toBe("1.2");
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.cookies).toEqual([]);
    expect(har.log.entries[0].request.headers[0].value).toBe("[REDACTED]");
    expect(auditDiagnosticText(text).safeToShare).toBe(true);
  });

  test("redacts a true DevTools HAR without flattening timings", () => {
    const rawToken = "raw-token-value-123456789";
    const raw = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              cookies: [{ name: "session", value: "cookie-secret-value-123" }],
              headers: [{ name: "Authorization", value: `Bearer ${rawToken}` }],
              method: "POST",
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({ token: rawToken }),
              },
              queryString: [{ name: "token", value: rawToken }],
              url: `https://provider.test/token?token=${rawToken}`,
            },
            response: {
              content: {
                mimeType: "text/html",
                text: `<script>window.token='${rawToken}'</script>`,
              },
              cookies: [{ name: "provider", value: "provider-cookie-value" }],
              headers: [{ name: "set-cookie", value: "provider-cookie-value" }],
              status: 200,
            },
            time: 285.257,
            timings: { receive: 10, send: 1, wait: 274.257 },
          },
        ],
        version: "1.2",
      },
    });
    const result = redactHarText(raw, {
      retainRequestBody: () => true,
      retainResponseBody: () => true,
    });

    expect(result.audit.safeToShare).toBe(true);
    expect(result.text).not.toContain(rawToken);
    expect(result.text).not.toContain("provider-cookie-value");
    const har = JSON.parse(result.text);
    expect(har.log.entries[0].time).toBe(285.257);
    expect(har.log.entries[0].timings.wait).toBe(274.257);
  });

  test("rejects unredacted authorization data", () => {
    const result = auditDiagnosticText(
      JSON.stringify({
        headers: [{ name: "authorization", value: "Bearer still-secret" }],
      }),
    );
    expect(result.safeToShare).toBe(false);
    expect(result.findings[0]?.code).toBe("authorization-value");
  });

  test("redacts valid payment card numbers but permits epoch timestamps", () => {
    const text = JSON.stringify({
      cardNumber: "4111111111111111",
      occurredAt: 1_787_942_400_000,
    });
    const redacted = redactHarText(
      JSON.stringify({
        log: {
          entries: [
            {
              request: {
                headers: [],
                method: "POST",
                postData: { mimeType: "application/json", text },
                queryString: [],
                url: "https://example.test/payment",
              },
              response: { content: {}, cookies: [], headers: [], status: 200 },
            },
          ],
          version: "1.2",
        },
      }),
      { retainRequestBody: () => true },
    );

    expect(redacted.text).not.toContain("4111111111111111");
    expect(redacted.text).toContain("1787942400000");
    expect(redacted.audit.safeToShare).toBe(true);
  });
});
