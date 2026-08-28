import { describe, expect, test } from "bun:test";
import {
  diagnosticCorrelationPlugin,
  diagnosticsPlugin,
  type StoredDiagnosticCapture,
} from "../src/elysia";
import { archiveFixture } from "./fixtures";

describe("diagnostics Elysia relay", () => {
  test("exposes bounded request correlation and server timing", async () => {
    const seen: unknown[] = [];
    const app = diagnosticCorrelationPlugin({
      exposeTraceparent: true,
      onRequest: (correlation) => {
        seen.push(correlation);
      },
    }).get("/work", ({ diagnosticCorrelation }) => diagnosticCorrelation);
    const traceparent =
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const response = await app.handle(
      new Request("http://localhost/work", {
        headers: {
          traceparent,
          "x-absolutejs-diagnostic-id": "diagnostic-one",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("absolute;dur=");
    expect(response.headers.get("traceparent")).toBe(traceparent);
    expect(seen[0]).toMatchObject({
      diagnosticId: "diagnostic-one",
      trace: { traceId: "0af7651916cd43dd8448eb211c80319c" },
    });
  });

  test("defaults closed", async () => {
    const app = diagnosticsPlugin({
      store: { put: () => Promise.resolve() },
    });
    const response = await app.handle(
      new Request("http://localhost/api/diagnostics", {
        body: JSON.stringify({ archive: archiveFixture() }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
  });

  test("redacts again before storing and retrieves authorized captures", async () => {
    const captures = new Map<string, StoredDiagnosticCapture>();
    const app = diagnosticsPlugin({
      authorize: (request) => request.headers.get("x-support") === "allowed",
      clock: () => 123,
      store: {
        get: (id) => Promise.resolve(captures.get(id) ?? null),
        put: (capture) => {
          captures.set(capture.id, capture);
          return Promise.resolve();
        },
      },
    });
    const response = await app.handle(
      new Request("http://localhost/api/diagnostics", {
        body: JSON.stringify({ archive: archiveFixture() }),
        headers: {
          "content-type": "application/json",
          "x-support": "allowed",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    const stored = captures.get(body.id);
    expect(stored?.receivedAt).toBe(123);
    expect(stored?.har).not.toContain("secret-token");

    const read = await app.handle(
      new Request(`http://localhost/api/diagnostics/${body.id}`, {
        headers: { "x-support": "allowed" },
      }),
    );
    expect(read.status).toBe(200);
  });

  test("issues short-lived signed downloads and supports explicit deletion", async () => {
    const captures = new Map<string, StoredDiagnosticCapture>();
    const lifecycle: string[] = [];
    let now = 1_000;
    const app = diagnosticsPlugin({
      authorize: (request) => request.headers.get("x-support") === "allowed",
      clock: () => now,
      downloadSigningKey: "a-secure-diagnostics-signing-key-1234567890",
      downloadTtlMs: 100,
      onLifecycleEvent: (event) => {
        lifecycle.push(event.kind);
      },
      retentionMs: 1_000,
      store: {
        consume: (id) => Promise.resolve(captures.get(id) ?? null),
        delete: (id) => {
          captures.delete(id);
          return Promise.resolve();
        },
        get: (id) => Promise.resolve(captures.get(id) ?? null),
        put: (capture) => {
          captures.set(capture.id, capture);
          return Promise.resolve();
        },
      },
    });
    const created = await app.handle(
      new Request("http://localhost/api/diagnostics", {
        body: JSON.stringify({ archive: archiveFixture() }),
        headers: {
          "content-type": "application/json",
          "x-support": "allowed",
        },
        method: "POST",
      }),
    );
    const body = (await created.json()) as { downloadUrl: string; id: string };
    expect(body.downloadUrl).toContain("token=");
    const download = await app.handle(
      new Request(`http://localhost${body.downloadUrl}`),
    );
    expect(download.status).toBe(200);

    now = 1_101;
    const expiredToken = await app.handle(
      new Request(`http://localhost${body.downloadUrl}`),
    );
    expect(expiredToken.status).toBe(403);
    const removed = await app.handle(
      new Request(`http://localhost/api/diagnostics/${body.id}`, {
        headers: { "x-support": "allowed" },
        method: "DELETE",
      }),
    );
    expect(removed.status).toBe(200);
    expect(captures.has(body.id)).toBe(false);
    expect(lifecycle).toEqual([
      "diagnostic.captured",
      "diagnostic.downloaded",
      "diagnostic.deleted",
    ]);
  });
});
