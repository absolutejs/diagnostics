import type { BrowserDiagnostics, BrowserDiagnosticSession } from "./browser";
import type { SupportBundle, SupportMarker } from "./contracts";
import {
  createSupportBundle,
  downloadSupportBundle,
  type CreateSupportBundleOptions,
} from "./support";
import { redactText } from "./redact";

export type SupportModePhase =
  "idle" | "recording" | "reviewing" | "sending" | "sent";

export type SupportModeSnapshot = {
  bundle?: SupportBundle;
  error?: string;
  markers: SupportMarker[];
  phase: SupportModePhase;
  endsAt?: number;
  startedAt?: number;
};

export type SupportModeControllerOptions = {
  context?: () =>
    | Promise<Record<string, unknown> | undefined>
    | Record<string, unknown>
    | undefined;
  diagnostics: BrowserDiagnostics;
  expiresInMs?: number;
  issueFingerprints?: () => Promise<string[]> | string[];
  maxDurationMs?: number;
  submit?: (bundle: SupportBundle) => Promise<{ id?: string } | void>;
  traceIds?: () => Promise<string[]> | string[];
};

export type SupportModeController = {
  discard: () => void;
  download: (filename?: string) => void;
  mark: (
    label: string,
    data?: Record<string, boolean | number | string>,
  ) => void;
  send: () => Promise<SupportBundle>;
  snapshot: () => SupportModeSnapshot;
  start: (reason: string) => SupportModeSnapshot;
  stop: () => Promise<SupportBundle>;
  subscribe: (listener: (state: SupportModeSnapshot) => void) => () => void;
};

const messageFrom = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);

export const createSupportModeController = (
  options: SupportModeControllerOptions,
): SupportModeController => {
  let phase: SupportModePhase = "idle";
  let session: BrowserDiagnosticSession | undefined;
  let bundle: SupportBundle | undefined;
  let error: string | undefined;
  let startedAt: number | undefined;
  let endsAt: number | undefined;
  let markers: SupportMarker[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(state: SupportModeSnapshot) => void>();

  const snapshot = (): SupportModeSnapshot => ({
    ...(bundle === undefined ? {} : { bundle }),
    ...(error === undefined ? {} : { error }),
    markers: structuredClone(markers),
    phase,
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
  });
  const publish = (): SupportModeSnapshot => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
    return state;
  };
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (ticker !== undefined) clearInterval(ticker);
    timer = undefined;
    ticker = undefined;
  };

  const stop = async (): Promise<SupportBundle> => {
    if (bundle !== undefined) return bundle;
    if (session === undefined || phase !== "recording") {
      throw new Error("No support recording is active.");
    }
    clearTimer();
    const archive = await session.stop();
    session = undefined;
    const [context, issueFingerprints, traceIds] = await Promise.all([
      options.context?.(),
      options.issueFingerprints?.(),
      options.traceIds?.(),
    ]);
    const createOptions: CreateSupportBundleOptions = {
      archive,
      markers,
      ...(context === undefined ? {} : { context }),
      ...(issueFingerprints === undefined ? {} : { issueFingerprints }),
      ...(traceIds === undefined ? {} : { traceIds }),
      ...(options.expiresInMs === undefined
        ? {}
        : { expiresAt: Date.now() + options.expiresInMs }),
    };
    bundle = createSupportBundle(createOptions);
    phase = "reviewing";
    error = undefined;
    publish();
    return bundle;
  };

  return {
    discard: () => {
      clearTimer();
      void session?.stop();
      session = undefined;
      bundle = undefined;
      error = undefined;
      markers = [];
      phase = "idle";
      startedAt = undefined;
      endsAt = undefined;
      publish();
    },
    download: (filename) => {
      if (bundle === undefined) throw new Error("Stop the recording first.");
      downloadSupportBundle(bundle, filename);
    },
    mark: (label, data) => {
      if (phase !== "recording") {
        throw new Error("Markers require an active support recording.");
      }
      markers.push({
        at: Date.now(),
        ...(data === undefined ? {} : { data }),
        label,
      });
      if (markers.length > 500) markers = markers.slice(-500);
      publish();
    },
    send: async () => {
      const ready = bundle ?? (await stop());
      if (options.submit === undefined) {
        throw new Error("No support bundle submit transport is configured.");
      }
      phase = "sending";
      error = undefined;
      publish();
      try {
        await options.submit(ready);
        phase = "sent";
        publish();
        return ready;
      } catch (caught) {
        phase = "reviewing";
        error = messageFrom(caught);
        publish();
        throw caught;
      }
    },
    snapshot,
    start: (reason) => {
      if (phase !== "idle") throw new Error("Support Mode is already active.");
      const trimmed = reason.trim();
      if (trimmed === "") throw new Error("A support reason is required.");
      session = options.diagnostics.start({ reason: trimmed.slice(0, 512) });
      bundle = undefined;
      error = undefined;
      markers = [];
      phase = "recording";
      startedAt = Date.now();
      const maximum = options.maxDurationMs ?? 10 * 60_000;
      if (maximum > 0) {
        endsAt = Date.now() + maximum;
        timer = setTimeout(() => {
          void stop().catch((caught: unknown) => {
            error = messageFrom(caught);
            publish();
          });
        }, maximum);
        ticker = setInterval(publish, 1_000);
      }
      return publish();
    },
    stop,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
};

export type SupportReportElement = HTMLElement & {
  controller?: SupportModeController;
};

/** Define an accessible native support-report element without imposing a UI
 * framework on the host application. Calling this function is SSR-safe. */
export const defineSupportReportElement = (
  tagName = "absolute-support-report",
): CustomElementConstructor | undefined => {
  if (
    typeof customElements === "undefined" ||
    typeof HTMLElement === "undefined"
  ) {
    return undefined;
  }
  const existing = customElements.get(tagName);
  if (existing !== undefined) return existing;

  class AbsoluteSupportReportElement extends HTMLElement {
    #controller: SupportModeController | undefined;
    #unsubscribe: (() => void) | undefined;
    readonly #root = this.attachShadow({ mode: "open" });

    get controller(): SupportModeController | undefined {
      return this.#controller;
    }

    set controller(value: SupportModeController | undefined) {
      this.#unsubscribe?.();
      this.#controller = value;
      this.#unsubscribe = value?.subscribe((state) => this.#render(state));
      this.#render(value?.snapshot() ?? { markers: [], phase: "idle" });
    }

    connectedCallback(): void {
      this.#render(
        this.#controller?.snapshot() ?? { markers: [], phase: "idle" },
      );
    }

    disconnectedCallback(): void {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
    }

    #button(
      label: string,
      action: () => unknown | Promise<unknown>,
    ): HTMLButtonElement {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        void Promise.resolve()
          .then(action)
          .catch((caught: unknown) => {
            this.dispatchEvent(
              new CustomEvent("absolute-support-error", {
                bubbles: true,
                composed: true,
                detail: {
                  message: redactText(messageFrom(caught)),
                },
              }),
            );
          });
      });
      return button;
    }

    #render(state: SupportModeSnapshot): void {
      this.#root.replaceChildren();
      const style = document.createElement("style");
      style.textContent = `
        :host { color: CanvasText; display: block; font: 14px/1.45 system-ui, sans-serif; }
        section { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 12px; max-width: 48rem; padding: 1rem; }
        h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
        p { margin: .4rem 0; }
        label { display: grid; gap: .35rem; }
        input { border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 6px; font: inherit; padding: .55rem; }
        .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .8rem; }
        button { border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); border-radius: 7px; cursor: pointer; font: inherit; padding: .5rem .75rem; }
        .recording { color: #b42318; font-weight: 650; }
        .error { color: #b42318; }
      `;
      const section = document.createElement("section");
      section.setAttribute("aria-labelledby", `${tagName}-title`);
      const title = document.createElement("h2");
      title.id = `${tagName}-title`;
      title.textContent = "Report a problem";
      section.append(title);
      const status = document.createElement("p");
      status.setAttribute("aria-live", "polite");
      const actions = document.createElement("div");
      actions.className = "actions";

      if (this.#controller === undefined) {
        status.textContent = "Support reporting is not configured.";
      } else if (state.phase === "idle") {
        const explanation = document.createElement("p");
        explanation.textContent =
          "Recording starts only after you choose Start. Sensitive fields are redacted before the report is retained.";
        const label = document.createElement("label");
        label.textContent = "What went wrong?";
        const input = document.createElement("input");
        input.maxLength = 512;
        input.required = true;
        label.append(input);
        actions.append(
          this.#button("Start recording", () => {
            if (!input.reportValidity()) return;
            this.#controller?.start(input.value);
          }),
        );
        section.append(explanation, label);
      } else if (state.phase === "recording") {
        status.className = "recording";
        const remaining =
          state.endsAt === undefined
            ? ""
            : ` · stops in ${Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1_000))}s`;
        status.textContent = `Recording diagnostic activity · ${state.markers.length} marker${state.markers.length === 1 ? "" : "s"}${remaining}`;
        actions.append(
          this.#button("Add marker", () => {
            const label = globalThis.prompt?.("Marker label")?.trim();
            if (label) this.#controller?.mark(label);
          }),
          this.#button("Stop and review", () => this.#controller?.stop()),
          this.#button("Discard", () => this.#controller?.discard()),
        );
      } else {
        const safe = state.bundle?.audit.safeToShare === true;
        status.textContent =
          state.phase === "sending"
            ? "Sending the redacted support report…"
            : state.phase === "sent"
              ? "Support report sent."
              : safe
                ? "Recording stopped. The privacy audit passed."
                : "Recording stopped, but the report is not safe to send.";
        if (state.bundle !== undefined) {
          const details = document.createElement("p");
          const truncation = state.bundle.archive.manifest.truncation;
          details.textContent = `${state.bundle.archive.network.length} network entries · ${state.bundle.archive.console.length} console entries · ${truncation.network + truncation.console + truncation.bodies} truncated items · ${state.bundle.audit.findings.length} privacy findings`;
          section.append(details);
        }
        if (state.error !== undefined) {
          const error = document.createElement("p");
          error.className = "error";
          error.textContent = state.error;
          section.append(error);
        }
        if (state.phase === "reviewing") {
          actions.append(
            this.#button("Download", () => this.#controller?.download()),
            this.#button("Send", () => this.#controller?.send()),
            this.#button("Discard", () => this.#controller?.discard()),
          );
        } else if (state.phase === "sent") {
          actions.append(
            this.#button("Done", () => this.#controller?.discard()),
          );
        }
      }
      section.append(status, actions);
      this.#root.append(style, section);
    }
  }

  customElements.define(tagName, AbsoluteSupportReportElement);
  return AbsoluteSupportReportElement;
};

/** Connect existing and subsequently-added support-report elements. */
export const connectSupportReportElements = (
  controller: SupportModeController,
  options: { root?: Document | HTMLElement; tagName?: string } = {},
): (() => void) => {
  const tagName = options.tagName ?? "absolute-support-report";
  defineSupportReportElement(tagName);
  const root = options.root ?? document;
  const connect = (candidate: ParentNode): void => {
    if (candidate instanceof HTMLElement && candidate.matches(tagName)) {
      (candidate as SupportReportElement).controller = controller;
    }
    for (const element of candidate.querySelectorAll(tagName)) {
      (element as SupportReportElement).controller = controller;
    }
  };
  connect(root);
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) connect(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
};
