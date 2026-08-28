import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createBrowserDiagnostics } from "../src/browser";

describe("browser diagnostics", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test("is explicitly started, bounded, and redacts before retaining bodies", async () => {
    window.location.href = "https://app.example.test/";
    const originalFetch = window.fetch;
    const observed: { propagatedDiagnosticId: string | null } = {
      propagatedDiagnosticId: null,
    };
    window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed.propagatedDiagnosticId = new Headers(init?.headers).get(
        "x-absolutejs-diagnostic-id",
      );
      return new Response(
        JSON.stringify({ paymentToken: "response-wallet-secret", ok: true }),
        {
          headers: {
            "content-type": "application/json",
            "server-timing": "db;dur=12.5",
            traceparent:
              "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          },
          status: 200,
        },
      );
    }) as unknown as typeof window.fetch;
    const underlyingFetch = window.fetch;
    const diagnostics = createBrowserDiagnostics({
      bodyCapture: {
        allow: ({ sameOrigin }) => sameOrigin,
        request: true,
        response: true,
      },
      maxConsoleEntries: 2,
      maxNetworkEntries: 2,
      project: "test",
      propagateDiagnosticId: true,
    });
    expect(diagnostics.active()).toBeUndefined();

    const session = diagnostics.start({ reason: "test reproduction" });
    await window.fetch(`${location.origin}/checkout?token=url-secret`, {
      body: JSON.stringify({ password: "request-secret", safe: true }),
      headers: {
        authorization: "Bearer header-secret",
        "content-type": "application/json",
      },
      method: "POST",
    });
    const archive = await session.stop();

    expect(window.fetch).toBe(underlyingFetch);
    expect(archive.manifest.completeness).toBe("in-page-partial");
    expect(archive.manifest.reason).toBe("test reproduction");
    expect(observed.propagatedDiagnosticId).toBe(session.id);
    expect(archive.network.some((entry) => entry.initiator === "fetch")).toBe(
      true,
    );
    const serialized = JSON.stringify(archive);
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("request-secret");
    expect(serialized).not.toContain("response-wallet-secret");
    expect(serialized).not.toContain("header-secret");
    const fetchEntry = archive.network.find(
      (entry) => entry.initiator === "fetch",
    );
    expect(fetchEntry?.response?.serverTiming).toEqual([
      { duration: 12.5, name: "db" },
    ]);
    expect(fetchEntry?.response?.trace?.traceId).toBe(
      "0af7651916cd43dd8448eb211c80319c",
    );
    expect(session.serializeHar()).toContain('"version":"1.2"');

    window.fetch = originalFetch;
  });
});
