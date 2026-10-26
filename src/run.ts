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
