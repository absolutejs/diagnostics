import type {
  DiagnosticArchive,
  DiagnosticHeader,
  DiagnosticNetworkEntry,
} from "./contracts";
import {
  auditDiagnosticText,
  redactDiagnosticArchive,
  type RedactionOptions,
} from "./redact";

export type HarNameValue = { name: string; value: string };

export type HarEntry = {
  _absolutejs?: {
    error?: { message: string; name: string };
    initiator: DiagnosticNetworkEntry["initiator"];
  };
  cache: Record<string, never>;
  request: {
    bodySize: number;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    headersSize: number;
    httpVersion: string;
    method: string;
    postData?: { mimeType: string; text: string };
    queryString: HarNameValue[];
    url: string;
  };
  response: {
    bodySize: number;
    content: { mimeType: string; size: number; text?: string };
    cookies: HarNameValue[];
    headers: HarNameValue[];
    headersSize: number;
    httpVersion: string;
    redirectURL: string;
    status: number;
    statusText: string;
  };
  startedDateTime: string;
  time: number;
  timings: {
    blocked: number;
    connect: number;
    dns: number;
    receive: number;
    send: number;
    ssl: number;
    wait: number;
  };
};

export type HarArchive = {
  log: {
    _absolutejs: DiagnosticArchive["manifest"];
    browser?: { name: string; version: string };
    creator: { name: string; version: string };
    entries: HarEntry[];
    pages: Array<{
      id: string;
      pageTimings: Record<string, never>;
      startedDateTime: string;
      title: string;
    }>;
    version: "1.2";
  };
};

const utf8Size = (value: string | undefined): number =>
  value === undefined ? 0 : new TextEncoder().encode(value).byteLength;

const queryString = (value: string): HarNameValue[] => {
  try {
    return [...new URL(value, "https://diagnostics.invalid").searchParams].map(
      ([name, parameter]) => ({ name, value: parameter }),
    );
  } catch {
    return [];
  }
};

const headers = (value: DiagnosticHeader[] | undefined): HarNameValue[] =>
  value?.map((header) => ({ ...header })) ?? [];

const toEntry = (entry: DiagnosticNetworkEntry): HarEntry => {
  const duration = Math.max(0, entry.durationMs ?? 0);
  const response = entry.response;
  return {
    _absolutejs: {
      initiator: entry.initiator,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    },
    cache: {},
    request: {
      bodySize: utf8Size(entry.request.body),
      cookies: [],
      headers: headers(entry.request.headers),
      headersSize: -1,
      httpVersion: "",
      method: entry.request.method,
      ...(entry.request.body === undefined
        ? {}
        : {
            postData: {
              mimeType:
                entry.request.bodyMimeType ?? "application/octet-stream",
              text: entry.request.body,
            },
          }),
      queryString: queryString(entry.request.url),
      url: entry.request.url,
    },
    response: {
      bodySize: response?.contentSize ?? utf8Size(response?.body),
      content: {
        mimeType: response?.bodyMimeType ?? "application/octet-stream",
        size: response?.contentSize ?? utf8Size(response?.body),
        ...(response?.body === undefined ? {} : { text: response.body }),
      },
      cookies: [],
      headers: headers(response?.headers),
      headersSize: -1,
      httpVersion: response?.protocol ?? "",
      redirectURL: "",
      status: response?.status ?? 0,
      statusText: response?.statusText ?? "",
    },
    startedDateTime: new Date(entry.startedAt).toISOString(),
    time: duration,
    timings: {
      blocked: -1,
      connect: -1,
      dns: -1,
      receive: 0,
      send: 0,
      ssl: -1,
      wait: duration,
    },
  };
};

export const diagnosticArchiveToHar = (
  input: DiagnosticArchive,
  options: RedactionOptions = {},
): HarArchive => {
  const archive = redactDiagnosticArchive(input, options);
  return {
    log: {
      _absolutejs: archive.manifest,
      creator: { name: "@absolutejs/diagnostics", version: "0.1.0" },
      entries: archive.network.map(toEntry),
      pages: [
        {
          id: archive.manifest.id,
          pageTimings: {},
          startedDateTime: new Date(archive.manifest.startedAt).toISOString(),
          title: archive.manifest.reason ?? archive.manifest.project,
        },
      ],
      version: "1.2",
    },
  };
};

export const serializeDiagnosticHar = (
  archive: DiagnosticArchive,
  options: RedactionOptions & { space?: number } = {},
): string => {
  const text = JSON.stringify(
    diagnosticArchiveToHar(archive, options),
    null,
    options.space ?? 0,
  );
  const audit = auditDiagnosticText(text);
  if (!audit.safeToShare) {
    throw new Error(
      `Diagnostic HAR redaction audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`,
    );
  }
  return text;
};

export const downloadDiagnosticHar = (
  archive: DiagnosticArchive,
  filename = `diagnostics-${archive.manifest.id}.har`,
): void => {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("HAR download requires a browser document.");
  }
  const url = URL.createObjectURL(
    new Blob([serializeDiagnosticHar(archive)], {
      type: "application/json",
    }),
  );
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
};
