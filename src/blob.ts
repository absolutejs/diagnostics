import type {
  DiagnosticCaptureStore,
  DiagnosticLifecycleEvent,
  StoredDiagnosticCapture,
} from "./elysia";

export type DiagnosticBlob = {
  key: string;
};

export type DiagnosticBlobList = {
  cursor?: string;
  objects: DiagnosticBlob[];
  truncated: boolean;
};

/** Structural subset implemented by every @absolutejs/blob adapter. */
export type DiagnosticBlobStore = {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  list: (options?: {
    cursor?: string;
    limit?: number;
    prefix?: string;
  }) => Promise<DiagnosticBlobList>;
  put: (
    key: string,
    body: string | Uint8Array,
    options?: {
      contentType?: string;
      maxBytes?: number;
      metadata?: Record<string, string>;
    },
  ) => Promise<unknown>;
};

export type DiagnosticBlobCaptureStore = DiagnosticCaptureStore & {
  purgeExpired: (at?: number) => Promise<number>;
};

export type DiagnosticBlobCaptureStoreOptions = {
  blob: DiagnosticBlobStore;
  clock?: () => number;
  maxBytes?: number;
  onLifecycleEvent?: (event: DiagnosticLifecycleEvent) => Promise<void> | void;
  prefix?: string;
  /** Enable the in-process serialized consume implementation only when one
   * application process owns downloads for this prefix. Clustered hosts must
   * provide a transactional DiagnosticCaptureStore.consume implementation. */
  singleWriter?: boolean;
};

const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

const captureValue = (value: unknown): value is StoredDiagnosticCapture => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<StoredDiagnosticCapture>;
  return (
    typeof candidate.id === "string" &&
    VALID_ID.test(candidate.id) &&
    typeof candidate.receivedAt === "number" &&
    (candidate.har === undefined || typeof candidate.har === "string")
  );
};

export const createDiagnosticBlobCaptureStore = (
  options: DiagnosticBlobCaptureStoreOptions,
): DiagnosticBlobCaptureStore => {
  const prefix = (options.prefix ?? "diagnostics").replace(/^\/+|\/+$/gu, "");
  const clock = options.clock ?? Date.now;
  const maximum = options.maxBytes ?? 10_000_000;
  const keyFor = (id: string): string => {
    if (!VALID_ID.test(id)) throw new Error("Invalid diagnostic capture id.");
    return `${prefix}/${id}.json`;
  };
  const locks = new Map<string, Promise<void>>();
  const withLock = async <Value>(
    id: string,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const previous = locks.get(id) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    locks.set(id, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(id) === queued) locks.delete(id);
    }
  };
  const get = async (id: string): Promise<StoredDiagnosticCapture | null> => {
    const bytes = await options.blob.get(keyFor(id));
    if (bytes === null) return null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return captureValue(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const put = async (capture: StoredDiagnosticCapture): Promise<void> => {
    const serialized = JSON.stringify(capture);
    if (new TextEncoder().encode(serialized).byteLength > maximum) {
      throw new Error("Diagnostic capture exceeds the blob-store limit.");
    }
    await options.blob.put(keyFor(capture.id), serialized, {
      contentType: "application/json",
      maxBytes: maximum,
      metadata: {
        ...(capture.expiresAt === undefined
          ? {}
          : { expiresAt: String(capture.expiresAt) }),
        receivedAt: String(capture.receivedAt),
      },
    });
  };
  const remove = (id: string): Promise<void> => options.blob.delete(keyFor(id));

  const consume = (id: string, at: number) =>
    withLock(id, async () => {
      const capture = await get(id);
      if (capture === null) return null;
      if (capture.expiresAt !== undefined && capture.expiresAt <= at) {
        await remove(id);
        return null;
      }
      if (
        capture.maxDownloads !== undefined &&
        (capture.downloadCount ?? 0) >= capture.maxDownloads
      ) {
        await remove(id);
        return null;
      }
      if (capture.maxDownloads !== undefined) {
        const consumed = {
          ...capture,
          downloadCount: (capture.downloadCount ?? 0) + 1,
        };
        if (consumed.downloadCount >= capture.maxDownloads) {
          await remove(id);
        } else {
          await put(consumed);
        }
        return consumed;
      }
      return capture;
    });

  return {
    ...(options.singleWriter === true ? { consume } : {}),
    delete: remove,
    get,
    purgeExpired: async (at = clock()) => {
      let cursor: string | undefined;
      let purged = 0;
      do {
        const page = await options.blob.list({
          ...(cursor === undefined ? {} : { cursor }),
          limit: 500,
          prefix: `${prefix}/`,
        });
        for (const object of page.objects) {
          const id = object.key
            .slice(`${prefix}/`.length)
            .replace(/\.json$/u, "");
          if (!VALID_ID.test(id)) continue;
          const capture = await get(id);
          if (capture?.expiresAt !== undefined && capture.expiresAt <= at) {
            await remove(id);
            await options.onLifecycleEvent?.({
              at,
              id,
              kind: "diagnostic.expired",
            });
            purged += 1;
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return purged;
    },
    put,
  };
};
