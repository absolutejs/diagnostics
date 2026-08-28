import { describe, expect, test } from "bun:test";
import { diagnosticsPlugin, type StoredDiagnosticCapture } from "../src/elysia";
import { archiveFixture } from "./fixtures";

describe("diagnostics Elysia relay", () => {
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
});
