import { expect, test } from "bun:test";
import { createDiagnosticRunLifecycle } from "../src/run";

test("success stays provisional until an observed zero exit, with immutable snapshots", () => {
  let clock = 10;
  const run = createDiagnosticRunLifecycle(() => clock),
    initial = run.snapshot();
  clock = 20;
  const finished = run.finish("completed", { sourceUnchanged: true });
  expect(initial.status).toBe("running");
  expect(Object.isFrozen(finished)).toBe(true);
  expect(finished.processExitCode).toBeUndefined();
  clock = 30;
  expect(run.exited(0)).toEqual({
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    sourceUnchanged: true,
    processExitCode: 0,
    processExitedAt: 30,
  });
  expect(run.exited(7)).toBe(run.snapshot());
  expect(run.snapshot().processExitCode).toBe(0);
});

test.each([
  [7, undefined],
  [143, "SIGTERM"],
  [0, "SIGINT"],
] as const)("late exit %s / %s invalidates success", (code, signal) => {
  const run = createDiagnosticRunLifecycle();
  run.finish("completed", { sourceUnchanged: true });
  const result = run.exited(code, signal);
  expect(result.status).toBe("interrupted");
  expect(result.assertionStatus).toBe("completed");
  expect(result.processExitCode).toBe(code);
  expect(run.finish("completed", { sourceUnchanged: true })).toBe(result);
});

test("early zero exit is incomplete and failure/source invalidation cannot be erased", () => {
  expect(createDiagnosticRunLifecycle().exited(0).status).toBe("interrupted");
  for (const outcome of ["completed", "failed"] as const) {
    const run = createDiagnosticRunLifecycle();
    run.finish(outcome, { sourceUnchanged: false, error: "original failure" });
    expect(run.exited(7).status).toBe(
      outcome === "completed" ? "invalid" : "failed",
    );
    expect(run.snapshot().error).toBe("original failure");
  }
});

test("rejects invalid host evidence without mutating state and bounds error text", () => {
  expect(() => createDiagnosticRunLifecycle(() => NaN)).toThrow();
  const run = createDiagnosticRunLifecycle(),
    initial = run.snapshot();
  for (const code of [NaN, Infinity, -1, 256, 1.5])
    expect(() => run.exited(code)).toThrow();
  expect(() => run.exited(1, "unbounded user text")).toThrow();
  expect(run.snapshot()).toBe(initial);
  expect(
    run.finish("failed", { sourceUnchanged: true, error: "x".repeat(4000) })
      .error?.length,
  ).toBe(2000);
});
