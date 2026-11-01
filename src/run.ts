export type DiagnosticRunStatus =
  "running" | "completed" | "failed" | "invalid" | "interrupted";

export type DiagnosticRunSnapshot = Readonly<{
  status: DiagnosticRunStatus;
  startedAt: number;
  finishedAt?: number;
  sourceUnchanged?: boolean;
  error?: string;
  assertionStatus?: "completed";
  processExitCode?: number;
  processSignal?: string;
  processExitedAt?: number;
}>;

/** A host-neutral lifecycle for bounded diagnostic jobs. Completion of assertions
 * is distinct from process termination. No listeners, I/O or global state are
 * installed: the host persists snapshots and supplies its actual exit evidence.
 * An unobserved process kill or power loss cannot be inferred as a clean exit. */
export function createDiagnosticRunLifecycle(now: () => number = Date.now) {
  const time = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) throw Error("Invalid run clock");
    return value;
  };
  let state: DiagnosticRunSnapshot = Object.freeze({
    status: "running",
    startedAt: time(),
  });
  const snapshot = () => state;
  return {
    snapshot,
    finish(
      outcome: "completed" | "failed",
      evidence: { sourceUnchanged: boolean; error?: string },
    ) {
      if (state.status !== "running") return state;
      if (outcome !== "completed" && outcome !== "failed")
        throw Error("Invalid run outcome");
      if (typeof evidence.sourceUnchanged !== "boolean")
        throw Error("Source identity evidence required");
      state = Object.freeze({
        ...state,
        status:
          outcome === "completed" && !evidence.sourceUnchanged
            ? "invalid"
            : outcome,
        finishedAt: time(),
        sourceUnchanged: evidence.sourceUnchanged,
        ...(evidence.error === undefined
          ? {}
          : { error: evidence.error.slice(0, 2000) }),
      });
      return state;
    },
    exited(code: number, signal?: string) {
      if (!Number.isInteger(code) || code < 0 || code > 255)
        throw Error("Invalid process exit code");
      if (signal !== undefined && !/^SIG[A-Z0-9]{1,24}$/.test(signal))
        throw Error("Invalid process signal");
      if (state.processExitCode !== undefined) return state;
      const at = time();
      const interrupted =
        state.status === "running" ||
        (state.status === "completed" && (code !== 0 || signal !== undefined));
      state = Object.freeze({
        ...state,
        ...(interrupted
          ? {
              status: "interrupted" as const,
              finishedAt: state.finishedAt ?? at,
              error: `Process exited (${code}${signal ? `, ${signal}` : ""}) ${state.status === "running" ? "before run completion" : "after assertions completed"}`,
              ...(state.status === "completed"
                ? { assertionStatus: "completed" as const }
                : {}),
            }
          : {}),
        processExitCode: code,
        processExitedAt: at,
        ...(signal === undefined ? {} : { processSignal: signal }),
      });
      return state;
    },
  };
}

export type DiagnosticResourceSnapshot = Readonly<{
  startedAtMs: number;
  elapsedMs: number;
  observations: number;
  residentSamples: number;
  peakResidentBytes?: number;
  exhausted: boolean;
  reason?: "elapsed-budget" | "resident-budget";
}>;

/** Sampled, host-neutral resource policy. The host supplies resident bytes and
 * owns scheduling, termination and persistence. Missing samples do not prove
 * memory safety; short peaks between observations cannot be detected here.
 * Use a monotonic clock in milliseconds, never a wall-clock timestamp. */
export function createDiagnosticResourceBudget(options: {
  maxElapsedMs: number;
  maxResidentBytes?: number;
  now?: () => number;
}) {
  if (
    !options ||
    !Number.isFinite(options.maxElapsedMs) ||
    options.maxElapsedMs <= 0 ||
    (options.maxResidentBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResidentBytes) ||
        options.maxResidentBytes <= 0)) ||
    (options.now !== undefined && typeof options.now !== "function")
  )
    throw Error("Invalid diagnostic resource budget");
  // Capture policy values: later caller mutation must not move a running limit.
  const maxElapsedMs = options.maxElapsedMs,
    maxResidentBytes = options.maxResidentBytes;
  const now = options.now ?? (() => performance.now());
  const startedAtMs = now();
  if (!Number.isFinite(startedAtMs) || startedAtMs < 0)
    throw Error("Invalid resource clock");
  let lastAtMs = startedAtMs;
  let state: DiagnosticResourceSnapshot = Object.freeze({
    startedAtMs,
    elapsedMs: 0,
    observations: 0,
    residentSamples: 0,
    exhausted: false,
  });
  return {
    snapshot: () => state,
    observe(
      sample: { residentBytes?: number } = {},
    ): DiagnosticResourceSnapshot {
      if (
        !sample ||
        (sample.residentBytes !== undefined &&
          (!Number.isSafeInteger(sample.residentBytes) ||
            sample.residentBytes < 0))
      )
        throw Error("Invalid resident memory sample");
      const at = now();
      if (!Number.isFinite(at) || at < lastAtMs)
        throw Error("Nonmonotonic resource clock");
      const elapsedMs = at - startedAtMs;
      if (!Number.isFinite(elapsedMs))
        throw Error("Unrepresentable resource duration");
      const peakResidentBytes =
        sample.residentBytes === undefined
          ? state.peakResidentBytes
          : Math.max(state.peakResidentBytes ?? 0, sample.residentBytes);
      // First observed exhaustion is latched. If both limits first fail in the
      // same observation, the elapsed deadline takes deterministic precedence.
      const reason =
        state.reason ??
        (elapsedMs >= maxElapsedMs
          ? "elapsed-budget"
          : maxResidentBytes !== undefined &&
              peakResidentBytes !== undefined &&
              peakResidentBytes > maxResidentBytes
            ? "resident-budget"
            : undefined);
      lastAtMs = at;
      state = Object.freeze({
        startedAtMs,
        elapsedMs,
        observations: Math.min(Number.MAX_SAFE_INTEGER, state.observations + 1),
        residentSamples: Math.min(
          Number.MAX_SAFE_INTEGER,
          state.residentSamples + (sample.residentBytes === undefined ? 0 : 1),
        ),
        ...(peakResidentBytes === undefined ? {} : { peakResidentBytes }),
        exhausted: reason !== undefined,
        ...(reason === undefined ? {} : { reason }),
      });
      return state;
    },
  };
}
