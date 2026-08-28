import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  DiagnosticAuditResult,
  DiagnosticConsoleEntry,
} from "./contracts";
import {
  auditDiagnosticText,
  redactHarText,
  redactText,
  redactUrl,
  redactValue,
  type HarRedactionOptions,
} from "./redact";

export type PlaywrightHarCaptureOptions = {
  cacheDisabled?: boolean;
  channel?: string;
  consoleOutputPath?: string;
  harRedaction?: HarRedactionOptions;
  headless?: boolean;
  metadataOutputPath?: string;
  outputPath: string;
  /** Existing Chrome profile. Omit for an isolated temporary context. */
  userDataDir?: string;
  url: string;
};

export type PlaywrightCaptureMarker = {
  atUtc: string;
  data?: Record<string, boolean | number | string>;
  label: string;
};

export type PlaywrightHarCaptureResult = {
  audit: DiagnosticAuditResult;
  console: DiagnosticConsoleEntry[];
  endedAtUtc: string;
  markers: PlaywrightCaptureMarker[];
  outputPath: string;
  startedAtUtc: string;
};

export type PlaywrightHarCaptureSession = {
  context: BrowserContext;
  mark: (
    label: string,
    data?: Record<string, boolean | number | string>,
  ) => void;
  page: Page;
  startedAtUtc: string;
  stop: () => Promise<PlaywrightHarCaptureResult>;
};

const jsonValue = async (value: {
  jsonValue: () => Promise<unknown>;
}): Promise<unknown> => {
  try {
    return await value.jsonValue();
  } catch {
    return "[UNSERIALIZABLE]";
  }
};

const serializeConsoleValues = (values: unknown[]): string =>
  redactText(
    values
      .map((value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ")
      .slice(0, 32_768),
  );

export const launchPlaywrightHarCapture = async (
  options: PlaywrightHarCaptureOptions,
): Promise<PlaywrightHarCaptureSession> => {
  const { chromium } = await import("playwright");
  const startedAtUtc = new Date().toISOString();
  const rawPath = `${options.outputPath}.raw-${crypto.randomUUID()}.har`;
  await mkdir(dirname(options.outputPath), { recursive: true });

  let browser: Browser | undefined;
  let context: BrowserContext;
  const contextOptions = {
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    headless: options.headless ?? false,
    recordHar: {
      content: "embed" as const,
      mode: "full" as const,
      path: rawPath,
    },
    viewport: null,
  };
  if (options.userDataDir === undefined) {
    browser = await chromium.launch({
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      headless: options.headless ?? false,
    });
    context = await browser.newContext({
      recordHar: contextOptions.recordHar,
      viewport: null,
    });
  } else {
    context = await chromium.launchPersistentContext(
      options.userDataDir,
      contextOptions,
    );
  }

  const consoleEntries: DiagnosticConsoleEntry[] = [];
  const markers: PlaywrightCaptureMarker[] = [];
  let stopped: Promise<PlaywrightHarCaptureResult> | undefined;

  const instrument = async (page: Page): Promise<void> => {
    if (options.cacheDisabled !== false) {
      const session = await context.newCDPSession(page);
      await session.send("Network.enable");
      await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    }
    page.on("console", async (message) => {
      const values = await Promise.all(message.args().map(jsonValue));
      const location = message.location();
      const level = message.type();
      consoleEntries.push({
        at: Date.now(),
        level:
          level === "debug" ||
          level === "error" ||
          level === "info" ||
          level === "log" ||
          level === "warning"
            ? level === "warning"
              ? "warn"
              : level
            : "log",
        message: serializeConsoleValues(
          values.length === 0 ? [message.text()] : values,
        ),
        ...(location.url === ""
          ? {}
          : {
              source: {
                column: location.columnNumber,
                line: location.lineNumber,
                url: redactUrl(location.url),
              },
            }),
      });
    });
    page.on("pageerror", (error) => {
      consoleEntries.push({
        at: Date.now(),
        level: "error",
        message: redactText(
          `${error.name}: ${error.message}\n${error.stack ?? ""}`,
        ),
      });
    });
  };

  context.on("page", (page) => {
    void instrument(page).catch((caught: unknown) => {
      consoleEntries.push({
        at: Date.now(),
        level: "error",
        message: redactText(
          caught instanceof Error
            ? `Diagnostics instrumentation failed: ${caught.message}`
            : `Diagnostics instrumentation failed: ${String(caught)}`,
        ),
      });
    });
  });
  for (const existing of context.pages()) await instrument(existing);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(options.url, { waitUntil: "domcontentloaded" });

  const stop = (): Promise<PlaywrightHarCaptureResult> => {
    if (stopped !== undefined) return stopped;
    stopped = (async () => {
      try {
        await context.close();
        await browser?.close();
        const endedAtUtc = new Date().toISOString();
        const raw = await readFile(rawPath, "utf8");
        const redacted = redactHarText(raw, options.harRedaction);
        const consoleText = `${consoleEntries
          .map(
            (entry) =>
              `[${new Date(entry.at).toISOString()}] console.${entry.level}: ${entry.message}`,
          )
          .join("\n")}\n`;
        const audit = auditDiagnosticText(`${redacted.text}\n${consoleText}`);
        if (!audit.safeToShare) {
          throw new Error(
            `Diagnostic redaction audit failed: ${audit.findings
              .map((finding) => finding.code)
              .join(", ")}`,
          );
        }
        await writeFile(options.outputPath, `${redacted.text}\n`);
        if (options.consoleOutputPath !== undefined) {
          await mkdir(dirname(options.consoleOutputPath), { recursive: true });
          await writeFile(options.consoleOutputPath, consoleText);
        }
        if (options.metadataOutputPath !== undefined) {
          await mkdir(dirname(options.metadataOutputPath), { recursive: true });
          await writeFile(
            options.metadataOutputPath,
            `${JSON.stringify(
              {
                cacheDisabled: options.cacheDisabled !== false,
                completeness: "devtools-complete",
                endedAtUtc,
                markers,
                preserveLog: true,
                redacted: true,
                startedAtUtc,
              },
              null,
              2,
            )}\n`,
          );
        }
        return {
          audit,
          console: consoleEntries,
          endedAtUtc,
          markers,
          outputPath: options.outputPath,
          startedAtUtc,
        };
      } finally {
        await unlink(rawPath).catch(() => undefined);
      }
    })();
    return stopped;
  };

  return {
    context,
    mark: (label, data) =>
      markers.push({
        atUtc: new Date().toISOString(),
        ...(data === undefined
          ? {}
          : {
              data: redactValue(data) as Record<
                string,
                boolean | number | string
              >,
            }),
        label: redactText(label),
      }),
    page,
    startedAtUtc,
    stop,
  };
};
