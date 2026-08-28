import { Elysia, t } from "elysia";
import {
  DIAGNOSTIC_ARCHIVE_VERSION,
  type DiagnosticArchive,
} from "./contracts";
import { serializeDiagnosticHar } from "./har";
import {
  auditDiagnosticText,
  redactDiagnosticArchive,
  redactHarText,
  type HarRedactionOptions,
  type RedactionOptions,
} from "./redact";

const DEFAULT_MAX_UPLOAD_BYTES = 5_000_000;

export type StoredDiagnosticCapture = {
  archive?: DiagnosticArchive;
  har?: string;
  id: string;
  receivedAt: number;
};

export type DiagnosticCaptureStore = {
  get?: (id: string) => Promise<StoredDiagnosticCapture | null>;
  put: (capture: StoredDiagnosticCapture) => Promise<void>;
};

export type DiagnosticsPluginOptions = {
  authorize?: (request: Request) => boolean | Promise<boolean>;
  clock?: () => number;
  harRedaction?: HarRedactionOptions;
  maxUploadBytes?: number;
  path?: string;
  redaction?: RedactionOptions;
  store: DiagnosticCaptureStore;
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

  const app = new Elysia({ name: "@absolutejs/diagnostics" }).post(
    path,
    {
      body: t.Object({
        archive: t.Optional(t.Unknown()),
        har: t.Optional(t.String()),
      }),
    },
    async ({ body, request, set }) => {
      if (!(await authorize(request))) {
        set.status = 403;
        return { error: "Diagnostic capture is not authorized." };
      }
      if (body.archive === undefined && body.har === undefined) {
        set.status = 400;
        return { error: "Provide archive or har." };
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
      if (body.archive !== undefined) {
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
      await options.store.put({
        ...(archive === undefined ? {} : { archive }),
        har,
        id,
        receivedAt: clock(),
      });
      set.status = 201;
      return { id, ok: true };
    },
  );

  if (options.store.get === undefined) return app;
  return app.get(`${path}/:id`, async ({ params, request, set }) => {
    if (!(await authorize(request))) {
      set.status = 403;
      return { error: "Diagnostic capture is not authorized." };
    }
    const capture = await options.store.get?.(params.id);
    if (capture === null || capture === undefined) {
      set.status = 404;
      return { error: "Diagnostic capture was not found." };
    }
    return capture;
  });
};
