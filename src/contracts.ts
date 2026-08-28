export const DIAGNOSTIC_ARCHIVE_VERSION = 1 as const;

export type DiagnosticCompleteness = "devtools-complete" | "in-page-partial";

export type DiagnosticHeader = {
  name: string;
  value: string;
};

export type DiagnosticRequest = {
  body?: string;
  bodyMimeType?: string;
  headers?: DiagnosticHeader[];
  method: string;
  url: string;
};

export type DiagnosticResponse = {
  body?: string;
  bodyMimeType?: string;
  contentSize?: number;
  headers?: DiagnosticHeader[];
  protocol?: string;
  status: number;
  statusText?: string;
  transferSize?: number;
};

export type DiagnosticNetworkEntry = {
  durationMs?: number;
  error?: {
    message: string;
    name: string;
  };
  id: string;
  initiator: "fetch" | "resource" | "xhr";
  request: DiagnosticRequest;
  response?: DiagnosticResponse;
  startedAt: number;
};

export type DiagnosticConsoleEntry = {
  at: number;
  level: "debug" | "error" | "info" | "log" | "warn";
  message: string;
  source?: {
    column?: number;
    line?: number;
    url?: string;
  };
};

export type DiagnosticTruncation = {
  bodies: number;
  console: number;
  network: number;
};

export type DiagnosticManifest = {
  cacheDisabled: boolean;
  completeness: DiagnosticCompleteness;
  consoleEntries: number;
  endedAt?: number;
  environment?: string;
  id: string;
  maxBytes: number;
  networkEntries: number;
  preserveLog: boolean;
  project: string;
  reason?: string;
  redacted: true;
  release?: string;
  replayId?: string;
  startedAt: number;
  traceId?: string;
  truncation: DiagnosticTruncation;
};

export type DiagnosticArchive = {
  console: DiagnosticConsoleEntry[];
  manifest: DiagnosticManifest;
  network: DiagnosticNetworkEntry[];
  version: typeof DIAGNOSTIC_ARCHIVE_VERSION;
};

export type DiagnosticAuditFinding = {
  code:
    | "authorization-value"
    | "cookie-value"
    | "credential-query"
    | "jwt"
    | "payment-card-number"
    | "sensitive-field";
  location: string;
};

export type DiagnosticAuditResult = {
  findings: DiagnosticAuditFinding[];
  safeToShare: boolean;
};

export type DiagnosticBodyCapturePolicy = {
  /** Decide per request whether bodies may be inspected. Required so body
   * capture can never be enabled globally by a single boolean. */
  allow: (request: {
    method: string;
    sameOrigin: boolean;
    url: string;
  }) => boolean;
  maxBodyBytes?: number;
  request?: boolean;
  response?: boolean;
};
