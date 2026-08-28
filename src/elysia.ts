import { Elysia, t } from "elysia";
import {
  DIAGNOSTIC_ARCHIVE_VERSION,
  type DiagnosticArchive,
  type SupportBundle,
} from "./contracts";
import { serializeDiagnosticHar } from "./har";
import {
  auditDiagnosticText,
  redactDiagnosticArchive,
  redactHarText,
  type HarRedactionOptions,
  type RedactionOptions,
} from "./redact";
import { createSupportBundle } from "./support";
import { parseTraceparent } from "./trace";
import type { DiagnosticTraceContext } from "./contracts";

const DEFAULT_MAX_UPLOAD_BYTES = 5_000_000;

export type DiagnosticRequestCorrelation = {
  diagnosticId?: string;
  startedAt: number;
  trace?: DiagnosticTraceContext;
};

export type DiagnosticCorrelationPluginOptions = {
  exposeTraceparent?: boolean;
  onRequest?: (
    correlation: DiagnosticRequestCorrelation,
    request: Request,
  ) => Promise<void> | void;
  serverTiming?: boolean;
};

const SAFE_CORRELATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

/** Make the browser diagnostic id and W3C trace context available to Elysia
 * handlers without accepting arbitrary user data as correlation metadata. */
export const diagnosticCorrelationPlugin = (
  options: DiagnosticCorrelationPluginOptions = {},
) =>
  new Elysia({ name: "@absolutejs/diagnostics/correlation" })
    .derive("plugin", async ({ request }) => {
      const rawDiagnosticId = request.headers.get("x-absolutejs-diagnostic-id");
      const diagnosticId =
        rawDiagnosticId !== null && SAFE_CORRELATION_ID.test(rawDiagnosticId)
          ? rawDiagnosticId
          : undefined;
      const trace = parseTraceparent(request.headers.get("traceparent"));
      const diagnosticCorrelation: DiagnosticRequestCorrelation = {
        ...(diagnosticId === undefined ? {} : { diagnosticId }),
        startedAt: performance.now(),
        ...(trace === undefined ? {} : { trace }),
      };
      await options.onRequest?.(diagnosticCorrelation, request);
      return { diagnosticCorrelation };
    })
    .afterHandle("plugin", ({ diagnosticCorrelation, set }) => {
      if (options.serverTiming !== false) {
        const duration = Math.max(
          0,
          performance.now() - diagnosticCorrelation.startedAt,
        ).toFixed(2);
        const existing = set.headers["server-timing"];
        set.headers["server-timing"] =
          `${existing ? `${existing}, ` : ""}absolute;dur=${duration}`;
      }
      if (
        options.exposeTraceparent === true &&
        diagnosticCorrelation.trace !== undefined
      ) {
        const trace = diagnosticCorrelation.trace;
        set.headers.traceparent = `${trace.version}-${trace.traceId}-${trace.parentId}-${trace.flags}`;
      }
    });

export type StoredDiagnosticCapture = {
  archive?: DiagnosticArchive;
  downloadCount?: number;
  expiresAt?: number;
  har?: string;
  id: string;
  maxDownloads?: number;
  receivedAt: number;
  supportBundle?: SupportBundle;
};

export type DiagnosticCaptureStore = {
  get?: (id: string) => Promise<StoredDiagnosticCapture | null>;
  put: (capture: StoredDiagnosticCapture) => Promise<void>;
  /** Atomically enforce expiry/download limits when supported by the store. */
  consume?: (id: string, at: number) => Promise<StoredDiagnosticCapture | null>;
  delete?: (id: string) => Promise<void>;
};

export type DiagnosticLifecycleEvent = {
  at: number;
  id: string;
  kind:
    | "diagnostic.captured"
    | "diagnostic.deleted"
    | "diagnostic.downloaded"
    | "diagnostic.expired";
};

export type DiagnosticsPluginOptions = {
  authorize?: (request: Request) => boolean | Promise<boolean>;
  clock?: () => number;
  harRedaction?: HarRedactionOptions;
  downloadSigningKey?: string | Uint8Array;
  downloadTtlMs?: number;
  maxUploadBytes?: number;
  maxDownloads?: number;
  path?: string;
  onLifecycleEvent?: (event: DiagnosticLifecycleEvent) => Promise<void> | void;
  redaction?: RedactionOptions;
  retentionMs?: number;
  store: DiagnosticCaptureStore;
};

const base64url = (value: Uint8Array): string =>
  Buffer.from(value).toString("base64url");

const sign = async (key: Uint8Array, value: string): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key).buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        imported,
        new TextEncoder().encode(value),
      ),
    ),
  );
};

const equal = (left: string, right: string): boolean => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const maximum = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

const diagnosticArchive = (value: unknown): value is DiagnosticArchive => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<DiagnosticArchive>;
  return (
    candidate.version === DIAGNOSTIC_ARCHIVE_VERSION &&
    Array.isArray(candidate.console) &&
    Array.isArray(candidate.network) &&
    candidate.manifest !== null &&
    typeof candidate.manifest === "object" &&
    typeof candidate.manifest.id === "string" &&
    candidate.manifest.id.length > 0
  );
};

const newId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const diagnosticsPlugin = (options: DiagnosticsPluginOptions) => {
  const path = options.path ?? "/api/diagnostics";
  const clock = options.clock ?? Date.now;
  const authorize = options.authorize ?? (() => false);
  const maximum = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const signingKey =
    typeof options.downloadSigningKey === "string"
      ? new TextEncoder().encode(options.downloadSigningKey)
      : options.downloadSigningKey;
  if (signingKey !== undefined && signingKey.byteLength < 32) {
    throw new Error(
      "Diagnostic download signing keys must be at least 32 bytes.",
    );
  }
  if (
    options.maxDownloads !== undefined &&
    options.store.consume === undefined
  ) {
    throw new Error("maxDownloads requires a store with atomic consume().");
  }
  const authorizeDownload = async (request: Request, id: string) => {
    if (await authorize(request)) return true;
    if (signingKey === undefined) return false;
    const url = new URL(request.url);
    const expires = url.searchParams.get("expires");
    const token = url.searchParams.get("token");
    if (expires === null || token === null) return false;
    const expiry = Number(expires);
    if (!Number.isSafeInteger(expiry) || expiry < clock()) return false;
    const expected = await sign(signingKey, `${id}.${expires}`);
    return equal(token, expected);
  };

  const app = new Elysia({ name: "@absolutejs/diagnostics" }).post(
    path,
    {
      body: t.Object({
        archive: t.Optional(t.Unknown()),
        bundle: t.Optional(t.Unknown()),
        har: t.Optional(t.String()),
      }),
    },
    async ({ body, request, set }) => {
      if (!(await authorize(request))) {
        set.status = 403;
        return { error: "Diagnostic capture is not authorized." };
      }
      if (
        body.archive === undefined &&
        body.bundle === undefined &&
        body.har === undefined
      ) {
        set.status = 400;
        return { error: "Provide archive, bundle, or har." };
      }
      const serializedSize = new TextEncoder().encode(
        JSON.stringify(body),
      ).byteLength;
      if (serializedSize > maximum) {
        set.status = 413;
        return { error: "Diagnostic capture exceeds the configured limit." };
      }

      let archive: DiagnosticArchive | undefined;
      let har: string | undefined;
      let supportBundle: SupportBundle | undefined;
      if (body.bundle !== undefined) {
        const candidate = body.bundle as Partial<SupportBundle>;
        if (
          candidate.archive === undefined ||
          !diagnosticArchive(candidate.archive) ||
          !Array.isArray(candidate.markers)
        ) {
          set.status = 400;
          return { error: "Diagnostic support bundle is invalid." };
        }
        try {
          supportBundle = createSupportBundle({
            archive: candidate.archive,
            ...(candidate.context === undefined
              ? {}
              : { context: candidate.context }),
            ...(candidate.manifest?.expiresAt === undefined
              ? {}
              : { expiresAt: candidate.manifest.expiresAt }),
            ...(candidate.correlations?.issueFingerprints === undefined
              ? {}
              : {
                  issueFingerprints: candidate.correlations.issueFingerprints,
                }),
            markers: candidate.markers,
            ...(candidate.correlations?.traceIds === undefined
              ? {}
              : { traceIds: candidate.correlations.traceIds }),
          });
          archive = supportBundle.archive;
          har = supportBundle.har;
        } catch {
          set.status = 422;
          return {
            error: "Diagnostic support bundle failed its privacy audit.",
          };
        }
      } else if (body.archive !== undefined) {
        if (!diagnosticArchive(body.archive)) {
          set.status = 400;
          return { error: "Diagnostic archive is invalid." };
        }
        archive = redactDiagnosticArchive(body.archive, options.redaction);
        har = serializeDiagnosticHar(archive, options.redaction);
      } else if (body.har !== undefined) {
        try {
          const result = redactHarText(body.har, options.harRedaction);
          if (!result.audit.safeToShare) {
            set.status = 422;
            return { error: "Diagnostic HAR failed the redaction audit." };
          }
          har = result.text;
        } catch {
          set.status = 400;
          return { error: "Diagnostic HAR is invalid." };
        }
      }
      if (har === undefined || !auditDiagnosticText(har).safeToShare) {
        set.status = 422;
        return { error: "Diagnostic export failed the redaction audit." };
      }

      const id = archive?.manifest.id ?? newId();
      const receivedAt = clock();
      const policyExpiry =
        options.retentionMs === undefined
          ? undefined
          : receivedAt + options.retentionMs;
      const requestedExpiry = supportBundle?.manifest.expiresAt;
      const expiresAt =
        policyExpiry === undefined
          ? requestedExpiry
          : requestedExpiry === undefined
            ? policyExpiry
            : Math.min(policyExpiry, requestedExpiry);
      await options.store.put({
        ...(archive === undefined ? {} : { archive }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        har,
        id,
        ...(options.maxDownloads === undefined
          ? {}
          : { downloadCount: 0, maxDownloads: options.maxDownloads }),
        receivedAt,
        ...(supportBundle === undefined ? {} : { supportBundle }),
      });
      await options.onLifecycleEvent?.({
        at: receivedAt,
        id,
        kind: "diagnostic.captured",
      });
      set.status = 201;
      if (signingKey === undefined) return { id, ok: true };
      const expires = receivedAt + (options.downloadTtlMs ?? 15 * 60_000);
      const token = await sign(signingKey, `${id}.${expires}`);
      return {
        downloadUrl: `${path}/${id}?expires=${expires}&token=${token}`,
        id,
        ok: true,
      };
    },
  );

  if (options.store.get === undefined && options.store.consume === undefined) {
    return app;
  }
  return app
    .get(`${path}/:id`, async ({ params, request, set }) => {
      if (!(await authorizeDownload(request, params.id))) {
        set.status = 403;
        return { error: "Diagnostic capture is not authorized." };
      }
      const now = clock();
      const capture =
        options.store.consume === undefined
          ? await options.store.get?.(params.id)
          : await options.store.consume(params.id, now);
      if (capture === null || capture === undefined) {
        set.status = 404;
        return { error: "Diagnostic capture was not found." };
      }
      if (capture.expiresAt !== undefined && capture.expiresAt <= now) {
        await options.store.delete?.(params.id);
        await options.onLifecycleEvent?.({
          at: now,
          id: params.id,
          kind: "diagnostic.expired",
        });
        set.status = 410;
        return { error: "Diagnostic capture has expired." };
      }
      await options.onLifecycleEvent?.({
        at: now,
        id: params.id,
        kind: "diagnostic.downloaded",
      });
      return capture;
    })
    .delete(`${path}/:id`, async ({ params, request, set }) => {
      if (!(await authorize(request))) {
        set.status = 403;
        return { error: "Diagnostic capture is not authorized." };
      }
      if (options.store.delete === undefined) {
        set.status = 405;
        return { error: "Diagnostic deletion is not supported by this store." };
      }
      await options.store.delete(params.id);
      await options.onLifecycleEvent?.({
        at: clock(),
        id: params.id,
        kind: "diagnostic.deleted",
      });
      return { deleted: true, id: params.id };
    });
};
