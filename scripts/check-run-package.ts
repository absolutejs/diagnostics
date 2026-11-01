import { strict as assert } from "node:assert";
import { createDiagnosticRunLifecycle } from "@absolutejs/diagnostics/run";

const clean = createDiagnosticRunLifecycle();
assert.equal(
  clean.finish("completed", { sourceUnchanged: true }).processExitCode,
  undefined,
);
assert.equal(clean.exited(0).status, "completed");
const lateFailure = createDiagnosticRunLifecycle();
lateFailure.finish("completed", { sourceUnchanged: true });
assert.equal(lateFailure.exited(143, "SIGTERM").status, "interrupted");
assert.equal(lateFailure.snapshot().assertionStatus, "completed");
const changed = createDiagnosticRunLifecycle();
assert.equal(
  changed.finish("completed", { sourceUnchanged: false }).status,
  "invalid",
);
console.log(
  "Built run subpath: clean exit, late failure and source invalidation pass",
);

const { createDiagnosticResourceBudget } =
  await import("@absolutejs/diagnostics/run");
let time = 500;
const budget = createDiagnosticResourceBudget({
  maxElapsedMs: 10,
  maxResidentBytes: 100,
  now: () => time,
});
if (budget.observe().residentSamples !== 0)
  throw Error("Unobserved memory was fabricated");
time += 10;
if (budget.observe({ residentBytes: 101 }).reason !== "elapsed-budget")
  throw Error("Built resource budget contract failed");
if (!Object.isFrozen(budget.snapshot())) throw Error("Mutable budget snapshot");
console.log("Built resource-budget subpath passed");
