import { strict as assert } from "node:assert";
import {
  createWorkerDiagnosticReporter,
  createWorkerDiagnosticReceiver,
} from "@absolutejs/diagnostics/worker";
let count = 0;
const receiver = createWorkerDiagnosticReceiver({
  jobId: "consumer",
  onRecord: (r) => {
    assert.equal(r.fields.password, "[REDACTED]");
    count++;
  },
});
const reporter = createWorkerDiagnosticReporter({
  jobId: "consumer",
  send: (f) => {
    assert.equal(receiver.receive(f), "accepted");
  },
});
assert.equal(reporter.emit("checkpoint", { password: "hidden" }), true);
assert.equal(count, 1);
receiver.close();
assert.equal(receiver.snapshot().closed, true);
console.log(
  "Published worker subpath redacts and delivers a bounded owned record",
);

const terminalRecords: string[] = [];
const terminalReceiver = createWorkerDiagnosticReceiver({
  jobId: "terminal-consumer",
  maxMessages: 2,
  onRecord: (r) => terminalRecords.push(r.event),
});
const terminalReporter = createWorkerDiagnosticReporter({
  jobId: "terminal-consumer",
  maxMessages: 2,
  terminalReserveBytes: 64,
  send: (f) => assert.equal(terminalReceiver.receive(f), "accepted"),
});
assert.equal(terminalReporter.emit("progress", {}), true);
assert.equal(terminalReporter.emit("overflow", {}), false);
assert.equal(terminalReporter.emitTerminal("failed", { step: 42 }), true);
assert.deepEqual(terminalRecords, ["progress", "failed"]);
assert.equal(terminalReporter.snapshot().terminalSent, true);
assert.equal(terminalReporter.emitTerminal("retry", {}), false);
console.log(
  "Built worker subpath preserves a terminal record after ordinary saturation",
);
