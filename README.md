# @absolutejs/diagnostics

Privacy-first, on-demand browser diagnostics for AbsoluteJS applications.

It records a bounded network and console timeline only after an explicit
support/operator action, exports a redacted HAR 1.2 document, and provides a
Playwright/CDP path when a vendor needs a complete DevTools capture. Request and
response bodies are off by default. Redaction happens before in-page entries
are retained and again at export or server ingest.

## Why this is separate from Beacon, Errors, and Replay

- `@absolutejs/beacon` stays tiny and always-on. It records redacted request
  breadcrumbs and actionable failures, not complete protocol archives.
- `@absolutejs/errors` groups and persists issues. It should link a diagnostic
  id, not own large support artifacts.
- `@absolutejs/replay` records privacy-masked DOM state. A DOM recording is not
  an HTTP archive.
- `@absolutejs/observability` can compose all four capabilities and correlate
  the diagnostic id with Beacon session, Replay, Errors, and traces.

## Install

```sh
bun add @absolutejs/diagnostics
```

Install only the optional capability you use:

```sh
bun add playwright # complete Chromium HAR capture
bun add elysia     # upload/retrieval relay
```

## In-page diagnostics

Creating a controller does not start recording:

```ts
import { createBrowserDiagnostics } from "@absolutejs/diagnostics/browser";

const diagnostics = createBrowserDiagnostics({
  project: "web",
  release: APP_RELEASE,
  replayId: () => replay.getReplayId(),
  traceId: () => currentTraceId(),
  ignoredUrlSubstrings: ["/api/diagnostics"],
});

// Call only after an explicit support/operator action.
const session = diagnostics.start({ reason: "payment provider reproduction" });

// Reproduce the problem, then stop and download a redacted HAR.
const archive = await session.stop();
session.downloadHar("payment-provider.redacted.har");
```

The recorder wraps the current `fetch`, XHR, and console functions, so it can
coexist with Beacon. It also consumes Resource Timing entries for static and
third-party resources visible to the page. `stop()` restores only wrappers it
still owns.

The in-page manifest always declares `completeness: "in-page-partial"` and
`cacheDisabled: false`. Application JavaScript cannot truthfully claim a full
HAR.

### Body capture is deliberately difficult to enable

There is no `captureBodies: true` switch. Supply a per-request allow function
and select request and/or response explicitly:

```ts
const diagnostics = createBrowserDiagnostics({
  project: "web",
  bodyCapture: {
    request: true,
    response: true,
    maxBodyBytes: 16_384,
    allow: ({ sameOrigin, url }) =>
      sameOrigin && new URL(url).pathname.startsWith("/api/support-safe/"),
  },
});
```

Strings and URL-encoded/JSON bodies are redacted immediately. Blob, stream,
multipart, and other binary request bodies are never inspected by the in-page
recorder.

## Complete HAR capture with Playwright/CDP

Use the Playwright entry point when a payment processor, identity provider, or
other vendor requests a real HAR with Preserve Log and Disable Cache:

```ts
import { launchPlaywrightHarCapture } from "@absolutejs/diagnostics/playwright";

const capture = await launchPlaywrightHarCapture({
  cacheDisabled: true,
  channel: "chrome",
  consoleOutputPath: "./support/browser-console.redacted.log",
  metadataOutputPath: "./support/capture-metadata.json",
  outputPath: "./support/network.redacted.har",
  url: "https://example.com/checkout",
  userDataDir: "/path/to/a/dedicated-support-profile",
  harRedaction: {
    // Bodies are removed unless a host explicitly retains them.
    retainResponseBody: ({ url }) =>
      new URL(url).hostname === "provider.example.com",
  },
});

capture.mark("payment-button-clicked");

// Reproduce using capture.page or the visible browser, then close gracefully.
const result = await capture.stop();
if (!result.audit.safeToShare) throw new Error("Do not send the export");
```

Playwright first records to a uniquely named raw temporary file. `stop()`
closes the context so Playwright flushes the HAR, creates the redacted output,
runs the sharing audit, and removes the raw temporary file in a `finally`
block. Call `stop()` rather than closing the browser window at the OS level.

The metadata declares `completeness: "devtools-complete"`, whether cache was
disabled, exact UTC start/end times, and any operator markers.

## Support Mode controller and native UI

`createSupportModeController` provides a consent-shaped state machine:
`idle → recording → reviewing → sending → sent`. Creating it never starts a
recording. A host can use the headless controller directly or connect the
framework-neutral native element.

```ts
import { createBrowserDiagnostics } from "@absolutejs/diagnostics/browser";
import {
  connectSupportReportElements,
  createSupportModeController,
} from "@absolutejs/diagnostics/ui";

const support = createSupportModeController({
  diagnostics: createBrowserDiagnostics({ project: "web" }),
  submit: async (bundle) => {
    const response = await fetch("/api/diagnostics", {
      body: JSON.stringify({ bundle }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  },
});

connectSupportReportElements(support);
```

```html
<absolute-support-report></absolute-support-report>
```

The element explains what will be recorded, requires an explicit Start click,
shows a persistent recording state, supports named markers, and exposes the
privacy-audit result before send.

## Correlated support bundles

`createSupportBundle()` produces one audited JSON artifact containing the
redacted in-page archive and HAR plus marker, replay, release, environment,
issue-fingerprint, and W3C trace correlations. It does not embed Replay data,
server logs, or issue records; those remain in their purpose-built stores and
are joined by id.

Request-level trace correlation recognizes valid `traceparent` headers and
records exposed `Server-Timing` metrics. Diagnostic-id propagation is
same-origin, opt-in, and off by default because mutating requests can affect
caches or signed requests.

The optional Elysia correlation plugin makes the bounded correlation available
to handlers and appends server timing:

```ts
import { diagnosticCorrelationPlugin } from "@absolutejs/diagnostics/elysia";

app.use(
  diagnosticCorrelationPlugin({
    onRequest: ({ diagnosticId, trace }) =>
      logs.info("support request", { diagnosticId, traceId: trace?.traceId }),
  }),
);
```

## Redaction and audit

```ts
import {
  auditDiagnosticText,
  redactHarText,
} from "@absolutejs/diagnostics/redact";

const { text, audit } = redactHarText(rawHar, {
  // Every query value is removed by default. Preserve only known-safe values.
  preserveQueryValues: ["plan"],
});

if (!audit.safeToShare) {
  console.error(audit.findings.map((finding) => finding.code));
}
```

Defaults remove or mask:

- `Authorization`, `Cookie`, `Set-Cookie`, proxy credentials, and API-key
  headers
- every URL query value and every fragment
- bearer values and JWT-shaped strings
- tokens, sessions, credentials, passwords, signatures, wallet payloads,
  payment fields, card fields, and common personal-contact fields
- request and response bodies in DevTools HAR captures
- body content beyond the configured byte limit

The sharing audit reports finding codes and locations, never the suspected
secret value.

## Elysia relay

The relay defaults closed. A host must provide authorization and storage:

```ts
import { diagnosticsPlugin } from "@absolutejs/diagnostics/elysia";

app.use(
  diagnosticsPlugin({
    authorize: (request) => supportSessionAuthorizes(request),
    store: {
      put: (capture) =>
        privateBlobStore.put(
          `diagnostics/${capture.id}.json`,
          JSON.stringify(capture),
        ),
      get: (id) => loadPrivateCapture(id),
    },
  }),
);
```

The relay enforces a byte limit, validates the archive shape, redacts again,
audits the serialized HAR, and only then calls the store. Wire storage to
`@absolutejs/blob` or another private store with an explicit retention policy.

### Secure lifecycle storage

`createDiagnosticBlobCaptureStore()` adapts any `@absolutejs/blob` store. The
relay can enforce retention, atomic download limits, short-lived HMAC-signed
download URLs, explicit deletion, and mandatory lifecycle audit hooks.

```ts
import { createDiagnosticBlobCaptureStore } from "@absolutejs/diagnostics/blob";

const store = createDiagnosticBlobCaptureStore({
  blob,
  prefix: "support",
  singleWriter: true, // only when one process owns this prefix
});
app.use(
  diagnosticsPlugin({
    authorize: requireSupportAccess,
    downloadSigningKey: process.env.DIAGNOSTIC_SIGNING_KEY!,
    maxDownloads: 1,
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    store,
    onLifecycleEvent: (event) => audit.append(event),
  }),
);
```

`maxDownloads` is accepted only when the store implements atomic `consume()`;
the plugin refuses unsafe configuration rather than pretending a normal `get()`
is sufficient. The Blob adapter exposes serialized `consume()` only with
`singleWriter: true`. Clustered applications must supply a transactional store
implementation instead of relying on an object-store read/modify/write race.

## Operator viewer and comparison

`@absolutejs/diagnostics/viewer` builds a chronological network, console, and
marker timeline. `compareSupportBundles(left, right)` reports request-set,
status, failure-count, timing, console, and marker differences—useful for
comparing a successful card attempt with a failed wallet attempt.

## Browser limitations

A normal webpage cannot observe:

- protected cookies and browser-owned authorization data
- most cross-origin response headers or bodies
- native Apple Pay or browser-wallet network traffic
- browser cache, connection, and service-worker protocol details with DevTools
  fidelity
- requests made by another device during a QR handoff

Therefore an in-page export is useful but partial. Use Playwright/CDP for a
complete desktop-browser HAR. Capturing native iPhone Safari with Web Inspector
still requires Apple's supported Mac-connected workflow; this package cannot
bypass platform security boundaries.

## API

```ts
createBrowserDiagnostics(options) => BrowserDiagnostics
diagnosticArchiveToHar(archive, redaction?) => HarArchive
serializeDiagnosticHar(archive, redaction?) => string
downloadDiagnosticHar(archive, filename?) => void
redactDiagnosticArchive(archive, options?) => DiagnosticArchive
redactHarText(rawHar, options?) => { text, audit }
auditDiagnosticText(serialized) => { safeToShare, findings }
launchPlaywrightHarCapture(options) => Promise<PlaywrightHarCaptureSession>
diagnosticsPlugin(options) => Elysia
```

## License

BSL-1.1 with a named carveout against competing hosted diagnostics,
error-tracking, session-replay, and observability services. Change date:
August 28, 2030, then Apache 2.0.
