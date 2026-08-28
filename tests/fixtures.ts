import {
  DIAGNOSTIC_ARCHIVE_VERSION,
  type DiagnosticArchive,
} from "../src/contracts";

export const archiveFixture = (): DiagnosticArchive => ({
  console: [
    {
      at: 1_780_000_000_100,
      level: "error",
      message:
        "authorization=secret-value and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    },
  ],
  manifest: {
    cacheDisabled: false,
    completeness: "in-page-partial",
    consoleEntries: 1,
    endedAt: 1_780_000_001_000,
    id: "123e4567-e89b-12d3-a456-426614174000",
    maxBytes: 2_000_000,
    networkEntries: 1,
    preserveLog: true,
    project: "test",
    redacted: true,
    startedAt: 1_780_000_000_000,
    truncation: { bodies: 0, console: 0, network: 0 },
  },
  network: [
    {
      durationMs: 42,
      id: "request-1",
      initiator: "fetch",
      request: {
        body: JSON.stringify({ password: "hunter2", safe: "visible" }),
        bodyMimeType: "application/json",
        headers: [
          { name: "authorization", value: "Bearer secret-token" },
          { name: "accept", value: "application/json" },
        ],
        method: "POST",
        url: "https://example.com/pay?token=secret-token&plan=yearly#fragment",
      },
      response: {
        body: JSON.stringify({ paymentToken: "wallet-secret", ok: false }),
        bodyMimeType: "application/json",
        headers: [{ name: "set-cookie", value: "session=secret" }],
        status: 200,
        statusText: "OK",
      },
      startedAt: 1_780_000_000_100,
    },
  ],
  version: DIAGNOSTIC_ARCHIVE_VERSION,
});
