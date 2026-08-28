import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { BrowserDiagnosticsOptions } from "./browser";

export const manifest = defineManifest<BrowserDiagnosticsOptions>()({
  contract: 2,
  identity: {
    accent: "#2563eb",
    category: "observability",
    description:
      "Privacy-first, explicitly started browser diagnostics with bounded network and console recording, redacted HAR 1.2 export, a Playwright/CDP path for complete browser captures, and an optional Elysia relay. Request and response bodies are off by default.",
    docsUrl: "https://github.com/absolutejs/diagnostics",
    name: "@absolutejs/diagnostics",
    tagline: "Capture the support evidence a vendor actually asks for.",
  },
  requires: {
    peers: [
      {
        name: "elysia",
        range: "^2.0.0-beta.6",
        reason: "Optional server upload and retrieval relay",
      },
      {
        name: "playwright",
        range: ">=1.50.0 <2",
        reason: "Optional complete DevTools HAR capture",
      },
    ],
  },
  settings: Type.Object({
    maxBytes: Type.Optional(
      Type.Integer({
        default: 2_000_000,
        description:
          "Maximum in-memory diagnostic timeline size. Oldest entries are discarded beyond the limit.",
        maximum: 20_000_000,
        minimum: 100_000,
        title: "Capture size limit",
      }),
    ),
    maxConsoleEntries: Type.Optional(
      Type.Integer({
        default: 500,
        maximum: 5_000,
        minimum: 1,
        title: "Console entry limit",
      }),
    ),
    maxNetworkEntries: Type.Optional(
      Type.Integer({
        default: 1_000,
        maximum: 10_000,
        minimum: 1,
        title: "Network entry limit",
      }),
    ),
    project: Type.String({
      default: "web",
      description: "Project identity included in the diagnostic manifest.",
      title: "Project",
    }),
  }),
  wiring: [
    {
      description:
        "Create the dormant diagnostics controller at browser startup. A support or operator action must explicitly call start().",
      id: "browser",
      client: {
        client: {
          code: [
            "const diagnostics = createBrowserDiagnostics(${settings});",
            "",
            "// Start only after an explicit support/operator action:",
            "// const session = diagnostics.start({ reason: 'support reproduction' });",
          ].join("\n"),
          imports: [
            {
              from: "@absolutejs/diagnostics/browser",
              names: ["createBrowserDiagnostics"],
            },
          ],
          placement: "client-entry",
        },
      },
      title: "Install opt-in browser diagnostics",
    },
  ],
});
