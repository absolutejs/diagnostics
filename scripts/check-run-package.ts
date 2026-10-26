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
  "Published run subpath: clean exit, late failure and source invalidation pass",
);
