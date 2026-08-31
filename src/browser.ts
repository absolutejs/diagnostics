import {
  DIAGNOSTIC_ARCHIVE_VERSION,
  type DiagnosticArchive,
  type DiagnosticBodyCapturePolicy,
  type DiagnosticConsoleEntry,
  type DiagnosticHeader,
  type DiagnosticNetworkEntry,
  type DiagnosticResponse,
  type DiagnosticTruncation,
} from "./contracts";
import { downloadDiagnosticHar, serializeDiagnosticHar } from "./har";
import {
  redactBody,
  redactHeaders,
  redactText,
  redactUrl,
  type RedactionOptions,
} from "./redact";
import { parseServerTiming, parseTraceparent } from "./trace";

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MAX_CONSOLE_ENTRIES = 500;
const DEFAULT_MAX_NETWORK_ENTRIES = 1_000;

export type BrowserDiagnosticsOptions = {
  bodyCapture?: DiagnosticBodyCapturePolicy;
  environment?: string;
  ignoredUrlSubstrings?: string[];
  maxBytes?: number;
  maxConsoleEntries?: number;
  maxNetworkEntries?: number;
  preserveQueryValues?: string[];
  project: string;
  /** Add the diagnostic id to same-origin requests. Off by default because
   * request mutation can affect caches, signatures, and CORS behavior. */
  propagateDiagnosticId?: boolean;
  release?: string;
  replayId?: () => string | undefined;
  traceId?: () => string | undefined;
};

export type StartBrowserDiagnosticOptions = {
  reason?: string;
};

export type BrowserDiagnosticSession = {
  downloadHar: (filename?: string) => void;
  id: string;
  serializeHar: () => string;
  snapshot: () => DiagnosticArchive;
  stop: () => Promise<DiagnosticArchive>;
};

export type BrowserDiagnostics = {
  active: () => BrowserDiagnosticSession | undefined;
  start: (options?: StartBrowserDiagnosticOptions) => BrowserDiagnosticSession;
};

// Performance timings are IEEE-754 floats, so a 10.7ms duration serializes as
// `10.700000000186265`. That trailing noise is not information — nobody debugs
// on femtoseconds — and it is actively harmful: a 15-digit run of it passes the
// redaction audit's Luhn check often enough that a capture full of resource
// timings reliably fails as a "payment card number". Round on the way in.
const MS_PRECISION = 1_000;
const roundMs = (value: number): number =>
  Math.round(value * MS_PRECISION) / MS_PRECISION;

const randomId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const utf8Size = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const errorValue = (caught: unknown): { message: string; name: string } =>
  caught instanceof Error
    ? { message: redactText(caught.message), name: caught.name }
    : { message: redactText(String(caught)), name: "Error" };

const contentType = (headers: Headers): string | undefined =>
  headers.get("content-type") ?? undefined;

const headerEntries = (headers: Headers): DiagnosticHeader[] =>
  redactHeaders(
    [...headers.entries()].map(([name, value]) => ({ name, value })),
  ) ?? [];

const consoleMessage = (values: unknown[]): string =>
  redactText(
    values
      .map((value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return `${value.name}: ${value.message}`;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ")
      .slice(0, 8_192),
  );

const requestDescriptor = (
  input: RequestInfo | URL,
  init?: RequestInit,
): { headers: Headers; method: string; url: string } => {
  const request = input instanceof Request ? input : undefined;
  return {
    headers: new Headers(init?.headers ?? request?.headers),
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    url:
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
  };
};

const stringBody = (body: BodyInit | null | undefined): string | undefined => {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
};

export const createBrowserDiagnostics = (
  options: BrowserDiagnosticsOptions,
): BrowserDiagnostics => {
  let current: BrowserDiagnosticSession | undefined;

  const start = (
    startOptions: StartBrowserDiagnosticOptions = {},
  ): BrowserDiagnosticSession => {
    if (current !== undefined) return current;
    const id = randomId();
    const startedAt = Date.now();
    const maximumBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maximumConsole =
      options.maxConsoleEntries ?? DEFAULT_MAX_CONSOLE_ENTRIES;
    const maximumNetwork =
      options.maxNetworkEntries ?? DEFAULT_MAX_NETWORK_ENTRIES;
    const redaction: RedactionOptions = {
      ...(options.bodyCapture?.maxBodyBytes === undefined
        ? {}
        : { maxBodyBytes: options.bodyCapture.maxBodyBytes }),
      ...(options.preserveQueryValues === undefined
        ? {}
        : { preserveQueryValues: options.preserveQueryValues }),
    };
    const ignored = options.ignoredUrlSubstrings ?? [];
    const network: DiagnosticNetworkEntry[] = [];
    const consoleEntries: DiagnosticConsoleEntry[] = [];
    const truncation: DiagnosticTruncation = {
      bodies: 0,
      console: 0,
      network: 0,
    };
    const pending = new Set<Promise<void>>();
    const cleanups: Array<() => void> = [];
    let endedAt: number | undefined;
    let stopped = false;

    const ignoredUrl = (url: string): boolean =>
      ignored.some((candidate) => url.includes(candidate));

    const trim = (): void => {
      while (network.length > maximumNetwork) {
        network.shift();
        truncation.network += 1;
      }
      while (consoleEntries.length > maximumConsole) {
        consoleEntries.shift();
        truncation.console += 1;
      }
      while (
        network.length + consoleEntries.length > 1 &&
        utf8Size({ console: consoleEntries, network }) > maximumBytes
      ) {
        const networkAt = network[0]?.startedAt ?? Number.POSITIVE_INFINITY;
        const consoleAt = consoleEntries[0]?.at ?? Number.POSITIVE_INFINITY;
        if (networkAt <= consoleAt) {
          network.shift();
          truncation.network += 1;
        } else {
          consoleEntries.shift();
          truncation.console += 1;
        }
      }
    };

    const addNetwork = (entry: DiagnosticNetworkEntry): void => {
      network.push(entry);
      trim();
    };
    const addConsole = (entry: DiagnosticConsoleEntry): void => {
      consoleEntries.push(entry);
      trim();
    };
    const runPending = (promise: Promise<void>): void => {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    };

    const bodyAllowed = (method: string, url: string): boolean => {
      if (options.bodyCapture === undefined) return false;
      try {
        const parsed = new URL(url, location.href);
        return options.bodyCapture.allow({
          method,
          sameOrigin: parsed.origin === location.origin,
          url: parsed.href,
        });
      } catch {
        return false;
      }
    };

    if (typeof window !== "undefined") {
      const originalFetch = window.fetch;
      const wrappedFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        let descriptor = requestDescriptor(input, init);
        if (ignoredUrl(descriptor.url)) return originalFetch(input, init);
        let forwardedInit = init;
        if (options.propagateDiagnosticId === true) {
          try {
            const parsed = new URL(descriptor.url, location.href);
            if (parsed.origin === location.origin) {
              const propagatedHeaders = new Headers(descriptor.headers);
              if (!propagatedHeaders.has("x-absolutejs-diagnostic-id")) {
                propagatedHeaders.set("x-absolutejs-diagnostic-id", id);
              }
              forwardedInit = { ...init, headers: propagatedHeaders };
              descriptor = requestDescriptor(input, forwardedInit);
            }
          } catch {
            // An invalid URL is left untouched and captured without correlation.
          }
        }
        const requestTrace = parseTraceparent(
          descriptor.headers.get("traceparent"),
        );
        const entry: DiagnosticNetworkEntry = {
          id: randomId(),
          initiator: "fetch",
          request: {
            headers: headerEntries(descriptor.headers),
            method: descriptor.method,
            url: redactUrl(descriptor.url, redaction),
          },
          startedAt: Date.now(),
          ...(requestTrace === undefined ? {} : { trace: requestTrace }),
        };
        const requestBody = stringBody(init?.body);
        if (
          requestBody !== undefined &&
          options.bodyCapture?.request === true &&
          bodyAllowed(descriptor.method, descriptor.url)
        ) {
          const mimeType = contentType(descriptor.headers);
          if (mimeType !== undefined) entry.request.bodyMimeType = mimeType;
          entry.request.body = redactBody(
            requestBody,
            entry.request.bodyMimeType,
            redaction,
          );
        }
        addNetwork(entry);
        try {
          const response = await originalFetch(input, forwardedInit);
          entry.durationMs = Date.now() - entry.startedAt;
          const serverTiming = parseServerTiming(
            response.headers.get("server-timing"),
          );
          const responseTrace = parseTraceparent(
            response.headers.get("traceparent"),
          );
          entry.response = {
            headers: headerEntries(response.headers),
            status: response.status,
            statusText: response.statusText,
            ...(serverTiming === undefined ? {} : { serverTiming }),
            ...(responseTrace === undefined ? {} : { trace: responseTrace }),
          };
          if (
            options.bodyCapture?.response === true &&
            bodyAllowed(descriptor.method, descriptor.url)
          ) {
            const capture = response
              .clone()
              .text()
              .then((body) => {
                if (entry.response === undefined) return;
                const mimeType = contentType(response.headers);
                if (mimeType !== undefined)
                  entry.response.bodyMimeType = mimeType;
                entry.response.body = redactBody(
                  body,
                  entry.response.bodyMimeType,
                  redaction,
                );
                trim();
              })
              .catch(() => {
                truncation.bodies += 1;
              });
            runPending(capture);
          }
          return response;
        } catch (caught) {
          entry.durationMs = Date.now() - entry.startedAt;
          entry.error = errorValue(caught);
          throw caught;
        }
      }) as typeof window.fetch;
      window.fetch = wrappedFetch;
      cleanups.push(() => {
        if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      });

      if (typeof XMLHttpRequest !== "undefined") {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetRequestHeader =
          XMLHttpRequest.prototype.setRequestHeader;
        const metadata = new WeakMap<
          XMLHttpRequest,
          { headers: DiagnosticHeader[]; method: string; url: string }
        >();
        const wrappedOpen = function (
          this: XMLHttpRequest,
          method: string,
          url: string | URL,
          ...rest: unknown[]
        ) {
          metadata.set(this, {
            headers: [],
            method: method.toUpperCase(),
            url: String(url),
          });
          return originalOpen.apply(this, [method, url, ...rest] as Parameters<
            typeof originalOpen
          >);
        } as typeof XMLHttpRequest.prototype.open;
        const wrappedSetRequestHeader = function (
          this: XMLHttpRequest,
          name: string,
          value: string,
        ) {
          metadata
            .get(this)
            ?.headers.push(...(redactHeaders([{ name, value }]) ?? []));
          return originalSetRequestHeader.call(this, name, value);
        };
        const wrappedSend = function (
          this: XMLHttpRequest,
          body?: Document | XMLHttpRequestBodyInit | null,
        ) {
          const descriptor = metadata.get(this);
          if (descriptor !== undefined && !ignoredUrl(descriptor.url)) {
            if (options.propagateDiagnosticId === true) {
              try {
                const parsed = new URL(descriptor.url, location.href);
                if (
                  parsed.origin === location.origin &&
                  !descriptor.headers.some(
                    (header) =>
                      header.name.toLowerCase() ===
                      "x-absolutejs-diagnostic-id",
                  )
                ) {
                  originalSetRequestHeader.call(
                    this,
                    "x-absolutejs-diagnostic-id",
                    id,
                  );
                  descriptor.headers.push({
                    name: "x-absolutejs-diagnostic-id",
                    value: id,
                  });
                }
              } catch {
                // An invalid URL is sent unchanged.
              }
            }
            const requestTrace = parseTraceparent(
              descriptor.headers.find(
                (header) => header.name.toLowerCase() === "traceparent",
              )?.value,
            );
            const entry: DiagnosticNetworkEntry = {
              id: randomId(),
              initiator: "xhr",
              request: {
                headers: descriptor.headers,
                method: descriptor.method,
                url: redactUrl(descriptor.url, redaction),
              },
              startedAt: Date.now(),
              ...(requestTrace === undefined ? {} : { trace: requestTrace }),
            };
            if (
              typeof body === "string" &&
              options.bodyCapture?.request === true &&
              bodyAllowed(descriptor.method, descriptor.url)
            ) {
              entry.request.body = redactBody(body, "", redaction);
            }
            addNetwork(entry);
            this.addEventListener(
              "loadend",
              () => {
                entry.durationMs = Date.now() - entry.startedAt;
                const rawHeaders = this.getAllResponseHeaders();
                const parsedHeaders = rawHeaders
                  .split(/\r?\n/u)
                  .flatMap((line) => {
                    const separator = line.indexOf(":");
                    return separator <= 0
                      ? []
                      : [
                          {
                            name: line.slice(0, separator).trim(),
                            value: line.slice(separator + 1).trim(),
                          },
                        ];
                  });
                const safeHeaders = redactHeaders(parsedHeaders);
                const serverTiming = parseServerTiming(
                  this.getResponseHeader("server-timing"),
                );
                const responseTrace = parseTraceparent(
                  this.getResponseHeader("traceparent"),
                );
                const response: DiagnosticResponse = {
                  ...(safeHeaders === undefined
                    ? {}
                    : { headers: safeHeaders }),
                  status: this.status,
                  statusText: this.statusText,
                  ...(serverTiming === undefined ? {} : { serverTiming }),
                  ...(responseTrace === undefined
                    ? {}
                    : { trace: responseTrace }),
                };
                entry.response = response;
                if (
                  options.bodyCapture?.response === true &&
                  bodyAllowed(descriptor.method, descriptor.url) &&
                  (this.responseType === "" || this.responseType === "text")
                ) {
                  const mimeType =
                    this.getResponseHeader("content-type") ?? undefined;
                  if (mimeType !== undefined) response.bodyMimeType = mimeType;
                  response.body = redactBody(
                    this.responseText,
                    response.bodyMimeType,
                    redaction,
                  );
                }
                if (this.status === 0) {
                  entry.error = {
                    message: "XMLHttpRequest completed with status 0",
                    name: "XMLHttpRequestError",
                  };
                }
                trim();
              },
              { once: true },
            );
          }
          return originalSend.call(this, body);
        };
        XMLHttpRequest.prototype.open = wrappedOpen;
        XMLHttpRequest.prototype.setRequestHeader = wrappedSetRequestHeader;
        XMLHttpRequest.prototype.send = wrappedSend;
        cleanups.push(() => {
          if (XMLHttpRequest.prototype.open === wrappedOpen) {
            XMLHttpRequest.prototype.open = originalOpen;
          }
          if (XMLHttpRequest.prototype.send === wrappedSend) {
            XMLHttpRequest.prototype.send = originalSend;
          }
          if (
            XMLHttpRequest.prototype.setRequestHeader ===
            wrappedSetRequestHeader
          ) {
            XMLHttpRequest.prototype.setRequestHeader =
              originalSetRequestHeader;
          }
        });
      }

      const consoleLevels = ["debug", "error", "info", "log", "warn"] as const;
      for (const level of consoleLevels) {
        const original = console[level].bind(console);
        const wrapped = (...values: unknown[]): void => {
          addConsole({
            at: Date.now(),
            level,
            message: consoleMessage(values),
          });
          original(...values);
        };
        console[level] = wrapped;
        cleanups.push(() => {
          if (console[level] === wrapped) console[level] = original;
        });
      }

      const onError = (event: ErrorEvent): void => {
        addConsole({
          at: Date.now(),
          level: "error",
          message: redactText(
            event.error instanceof Error
              ? `${event.error.name}: ${event.error.message}\n${event.error.stack ?? ""}`
              : event.message,
          ),
          source: {
            column: event.colno,
            line: event.lineno,
            url: redactUrl(event.filename, redaction),
          },
        });
      };
      const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
        const error = errorValue(event.reason);
        addConsole({
          at: Date.now(),
          level: "error",
          message: `${error.name}: ${error.message}`,
        });
      };
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onUnhandledRejection);
      cleanups.push(() => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      });

      if (typeof PerformanceObserver !== "undefined") {
        const observer = new PerformanceObserver((list) => {
          for (const raw of list.getEntries()) {
            if (raw.entryType !== "resource" || ignoredUrl(raw.name)) continue;
            const resource = raw as PerformanceResourceTiming;
            addNetwork({
              durationMs: roundMs(resource.duration),
              id: randomId(),
              initiator: "resource",
              request: {
                method: "GET",
                url: redactUrl(resource.name, redaction),
              },
              response: {
                contentSize: resource.decodedBodySize,
                ...(resource.serverTiming.length === 0
                  ? {}
                  : {
                      serverTiming: resource.serverTiming.map((timing) => ({
                        ...(timing.description === ""
                          ? {}
                          : { description: timing.description.slice(0, 512) }),
                        ...(timing.duration < 0
                          ? {}
                          : { duration: roundMs(timing.duration) }),
                        name: timing.name,
                      })),
                    }),
                status: resource.responseStatus ?? 0,
                transferSize: resource.transferSize,
              },
              startedAt: roundMs(performance.timeOrigin + resource.startTime),
            });
          }
        });
        try {
          observer.observe({ buffered: true, type: "resource" });
          cleanups.push(() => observer.disconnect());
        } catch {
          observer.disconnect();
        }
      }
    }

    const snapshot = (): DiagnosticArchive => {
      const replayId = options.replayId?.();
      const traceId = options.traceId?.();
      return {
        console: structuredClone(consoleEntries),
        manifest: {
          cacheDisabled: false,
          completeness: "in-page-partial",
          consoleEntries: consoleEntries.length,
          ...(endedAt === undefined ? {} : { endedAt }),
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
          id,
          maxBytes: maximumBytes,
          networkEntries: network.length,
          preserveLog: true,
          project: options.project,
          ...(startOptions.reason === undefined
            ? {}
            : { reason: startOptions.reason }),
          redacted: true,
          ...(options.release === undefined
            ? {}
            : { release: options.release }),
          ...(replayId === undefined ? {} : { replayId }),
          startedAt,
          ...(traceId === undefined ? {} : { traceId }),
          truncation: { ...truncation },
        },
        network: structuredClone(network),
        version: DIAGNOSTIC_ARCHIVE_VERSION,
      };
    };

    const stop = async (): Promise<DiagnosticArchive> => {
      if (!stopped) {
        stopped = true;
        for (const cleanup of cleanups.splice(0)) cleanup();
        await Promise.allSettled([...pending]);
        endedAt = Date.now();
        current = undefined;
      }
      return snapshot();
    };
    const session: BrowserDiagnosticSession = {
      downloadHar: (filename) => downloadDiagnosticHar(snapshot(), filename),
      id,
      serializeHar: () => serializeDiagnosticHar(snapshot()),
      snapshot,
      stop,
    };
    current = session;
    return session;
  };

  return { active: () => current, start };
};
