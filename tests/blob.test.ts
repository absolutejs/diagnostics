import { describe, expect, test } from "bun:test";
import {
  createDiagnosticBlobCaptureStore,
  type DiagnosticBlobStore,
} from "../src/blob";

const memoryBlob = (): DiagnosticBlobStore => {
  const values = new Map<string, Uint8Array>();
  return {
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(values.get(key) ?? null),
    list: ({ prefix = "" } = {}) =>
      Promise.resolve({
        objects: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    put: (key, body) => {
      values.set(
        key,
        typeof body === "string" ? new TextEncoder().encode(body) : body,
      );
      return Promise.resolve({});
    },
  };
};

describe("diagnostic blob capture lifecycle", () => {
  test("enforces expiry, download limits, and idempotent deletion", async () => {
    const store = createDiagnosticBlobCaptureStore({
      blob: memoryBlob(),
      singleWriter: true,
    });
    await store.put({
      downloadCount: 0,
      expiresAt: 200,
      har: "{}",
      id: "capture-1",
      maxDownloads: 1,
      receivedAt: 100,
    });
    expect((await store.consume?.("capture-1", 150))?.downloadCount).toBe(1);
    expect(await store.consume?.("capture-1", 151)).toBeNull();

    await store.put({
      expiresAt: 200,
      id: "capture-2",
      receivedAt: 100,
    });
    expect(await store.purgeExpired(201)).toBe(1);
    expect(await store.get?.("capture-2")).toBeNull();
    await store.delete?.("capture-2");
  });
});
