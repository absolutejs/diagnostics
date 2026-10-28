import { expect, test } from "bun:test";
import {
  createWorkerDiagnosticReporter,
  createWorkerDiagnosticReceiver,
  type WorkerDiagnosticFrame,
} from "../src/worker";
const frames = () => {
  const sent: WorkerDiagnosticFrame[] = [];
  return {
    sent,
    reporter: createWorkerDiagnosticReporter({
      jobId: "job-1",
      send: (f) => sent.push(f),
    }),
  };
};
test("worker frames are redacted, correlated, owned, and ignore ordinary task results", () => {
  const { sent, reporter } = frames();
  const input = { password: "hidden", nested: { value: 3 } };
  expect(reporter.emit("physics.checkpoint", input)).toBe(true);
  input.nested.value = 9;
  const records: any[] = [];
  const r = createWorkerDiagnosticReceiver({
    jobId: "job-1",
    onRecord: (x) => records.push(x),
  });
  expect(r.receive({ id: 1, value: 42 })).toBe("unrelated");
  expect(r.receive({ ...sent[0], jobId: "job-2" })).toBe("unrelated");
  expect(r.snapshot().attempts).toBe(0);
  expect(r.receive(sent[0])).toBe("accepted");
  expect(records[0].fields).toEqual({
    password: "[REDACTED]",
    nested: { value: 3 },
  });
  records[0].fields.nested.value = 100;
  expect(JSON.parse(sent[0]!.json).nested.value).toBe(3);
  expect(r.receive(sent[0])).toBe("rejected");
});
test("message attempts are bounded even when producer fields are invalid", () => {
  const sent: unknown[] = [];
  const r = createWorkerDiagnosticReporter({
    jobId: "j",
    maxMessages: 2,
    send: (f) => sent.push(f),
  });
  expect(r.emit("bad event", {})).toBe(false);
  expect(r.emit("fine", null as any)).toBe(false);
  expect(r.emit("fine", {})).toBe(false);
  expect(sent).toHaveLength(0);
  expect(r.snapshot()).toMatchObject({
    attempts: 2,
    dropped: 2,
    exhausted: true,
  });
});
test("UTF-8 byte limits and aggregate limits apply before callback delivery", () => {
  const sent: WorkerDiagnosticFrame[] = [];
  const r = createWorkerDiagnosticReporter({
    jobId: "j",
    maxMessageBytes: 20,
    maxTotalBytes: 30,
    send: (f) => sent.push(f),
  });
  expect(r.emit("sample", { x: "界界界界界" })).toBe(false);
  expect(r.emit("sample", { x: "界" })).toBe(true);
  expect(r.emit("sample", { x: "界" })).toBe(true);
  expect(r.emit("sample", { x: "界" })).toBe(false);
  expect(sent).toHaveLength(2);
  expect(r.snapshot().sentBytes).toBe(22);
  const receiver = createWorkerDiagnosticReceiver({
    jobId: "j",
    maxMessageBytes: 20,
    maxTotalBytes: 15,
    onRecord: () => {},
  });
  expect(receiver.receive(sent[0])).toBe("accepted");
  expect(receiver.receive(sent[1])).toBe("rejected");
});
test("callbacks and serialization errors are accounted without escaping into computation", () => {
  const r = createWorkerDiagnosticReporter({
    jobId: "j",
    send: () => {
      throw undefined;
    },
  });
  expect(r.emit("step", {})).toBe(false);
  const bad = {
    get x(): number {
      throw Error("getter");
    },
  };
  expect(r.emit("step", bad)).toBe(false);
  expect(r.snapshot()).toMatchObject({
    attempts: 2,
    errors: 2,
    dropped: 2,
    sent: 0,
  });
  const { sent, reporter } = frames();
  reporter.emit("step", {});
  const receiver = createWorkerDiagnosticReceiver({
    jobId: "job-1",
    onRecord: () => {
      throw Error("sink");
    },
  });
  expect(receiver.receive(sent[0])).toBe("accepted");
  expect(receiver.snapshot()).toMatchObject({ accepted: 1, errors: 1 });
});
test("receiver rejects malformed data before JSON parsing and enforces its own budget", () => {
  const { sent, reporter } = frames();
  reporter.emit("step", {});
  const good = sent[0]!;
  const r = createWorkerDiagnosticReceiver({
    jobId: "job-1",
    maxMessages: 8,
    maxMessageBytes: 20,
    onRecord: () => {
      throw Error("must not run");
    },
  });
  for (const f of [
    { ...good, json: "x".repeat(21) },
    { ...good, json: "[" },
    { ...good, json: "[]" },
    { ...good, sequence: 0 },
    { ...good, sequence: NaN },
    { ...good, sequence: 9 },
    { ...good, event: "bad name" },
    { ...good, json: 42 },
  ])
    expect(r.receive(f)).toBe("rejected");
  expect(r.snapshot()).toMatchObject({
    attempts: 8,
    rejected: 8,
    accepted: 0,
    exhausted: true,
  });
  expect(r.receive(good)).toBe("closed");
});
test("loss, stale ordering, close and callback reentrancy have explicit bounded accounting", () => {
  const { sent, reporter } = frames();
  for (let i = 0; i < 3; i++) reporter.emit("step", { i });
  let r: ReturnType<typeof createWorkerDiagnosticReceiver>;
  r = createWorkerDiagnosticReceiver({
    jobId: "job-1",
    onRecord: () => {
      expect(r.receive(sent[2])).toBe("rejected");
    },
  });
  expect(r.receive(sent[2])).toBe("accepted");
  expect(r.snapshot().missingSequences).toBe(2);
  expect(r.snapshot().errors).toBe(0);
  expect(r.receive(sent[0])).toBe("rejected");
  r.close();
  expect(r.receive(sent[1])).toBe("closed");
  reporter.close();
  expect(reporter.emit("step", {})).toBe(false);
  expect(reporter.snapshot().attempts).toBe(3);
});
test("receiver redacts a producer that bypassed the reporter", () => {
  let got: unknown;
  const { sent, reporter } = frames();
  reporter.emit("step", {});
  const r = createWorkerDiagnosticReceiver({
    jobId: "job-1",
    onRecord: (r) => (got = r.fields),
  });
  expect(r.receive({ ...sent[0], json: '{"password":"hidden"}' })).toBe(
    "accepted",
  );
  expect(got).toEqual({ password: "[REDACTED]" });
});
test("invalid configuration is rejected without sending or receiving", () => {
  for (const opt of [
    { maxMessages: 0 },
    { maxMessages: 257 },
    { maxMessageBytes: NaN },
    { maxTotalBytes: 1048577 },
    { jobId: "bad id" },
  ]) {
    expect(() =>
      createWorkerDiagnosticReporter({ jobId: "j", send: () => {}, ...opt }),
    ).toThrow();
    expect(() =>
      createWorkerDiagnosticReceiver({
        jobId: "j",
        onRecord: () => {},
        ...opt,
      }),
    ).toThrow();
  }
});

test("channel identity and callbacks are captured rather than following mutable options", () => {
  const sent: WorkerDiagnosticFrame[] = [];
  const options = {
    jobId: "original",
    send: (f: WorkerDiagnosticFrame) => {
      sent.push(f);
    },
  };
  const reporter = createWorkerDiagnosticReporter(options);
  options.jobId = "changed";
  options.send = () => {
    throw Error("changed");
  };
  expect(reporter.emit("checkpoint", {})).toBe(true);
  expect(sent[0]!.jobId).toBe("original");
});
