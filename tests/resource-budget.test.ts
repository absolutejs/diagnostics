import { expect, test } from "bun:test";
import { createDiagnosticResourceBudget } from "../src/run";

test("elapsed deadline is relative, exact and independent of a nonzero clock origin", () => {
  let at = 1234.5;
  const b = createDiagnosticResourceBudget({ maxElapsedMs: 10, now: () => at });
  expect(b.snapshot()).toEqual({
    startedAtMs: 1234.5,
    elapsedMs: 0,
    observations: 0,
    residentSamples: 0,
    exhausted: false,
  });
  at += 9.5;
  expect(b.observe().exhausted).toBe(false);
  at += 0.5;
  expect(b.observe().reason).toBe("elapsed-budget");
});
test("missing memory remains unknown, while a zero resident sample is observed", () => {
  const b = createDiagnosticResourceBudget({
    maxElapsedMs: 100,
    maxResidentBytes: 10,
    now: () => 0,
  });
  expect(b.observe()).not.toHaveProperty("peakResidentBytes");
  expect(b.snapshot().residentSamples).toBe(0);
  expect(b.observe({ residentBytes: 0 }).peakResidentBytes).toBe(0);
  expect(b.snapshot().residentSamples).toBe(1);
});
test("resident maximum is inclusive and exhaustion persists after memory falls", () => {
  let at = 0;
  const b = createDiagnosticResourceBudget({
    maxElapsedMs: 100,
    maxResidentBytes: 10,
    now: () => at,
  });
  expect(b.observe({ residentBytes: 10 }).exhausted).toBe(false);
  expect(b.observe({ residentBytes: 11 }).reason).toBe("resident-budget");
  at = 101;
  const result = b.observe({ residentBytes: 1 });
  expect(result.reason).toBe("resident-budget");
  expect(result.peakResidentBytes).toBe(11);
  expect(result.elapsedMs).toBe(101);
});
test("simultaneous first failures have stable deadline precedence", () => {
  let at = 0;
  const b = createDiagnosticResourceBudget({
    maxElapsedMs: 10,
    maxResidentBytes: 10,
    now: () => at,
  });
  at = 10;
  expect(b.observe({ residentBytes: 11 }).reason).toBe("elapsed-budget");
});
test("policy and historical snapshots cannot be mutated through caller references", () => {
  let at = 0;
  const options = { maxElapsedMs: 10, maxResidentBytes: 10, now: () => at };
  const b = createDiagnosticResourceBudget(options),
    first = b.snapshot();
  options.maxElapsedMs = 1000;
  options.maxResidentBytes = 1000;
  expect(b.observe({ residentBytes: 11 }).reason).toBe("resident-budget");
  expect(first.exhausted).toBe(false);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(b.snapshot())).toBe(true);
});
test("invalid samples and clocks leave the accepted snapshot unchanged", () => {
  let at = 10;
  const b = createDiagnosticResourceBudget({ maxElapsedMs: 10, now: () => at });
  const before = b.observe({ residentBytes: 2 });
  for (const residentBytes of [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => b.observe({ residentBytes })).toThrow();
    expect(b.snapshot()).toBe(before);
  }
  for (const bad of [9, NaN, Infinity, -Infinity]) {
    at = bad;
    expect(() => b.observe()).toThrow();
    expect(b.snapshot()).toBe(before);
  }
  at = 11;
  expect(b.observe().elapsedMs).toBe(1);
});
test("invalid policies reject before a budget can start", () => {
  for (const maxElapsedMs of [0, -1, NaN, Infinity])
    expect(() => createDiagnosticResourceBudget({ maxElapsedMs })).toThrow();
  for (const maxResidentBytes of [
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() =>
      createDiagnosticResourceBudget({ maxElapsedMs: 1, maxResidentBytes }),
    ).toThrow();
  for (const at of [-1, NaN, Infinity])
    expect(() =>
      createDiagnosticResourceBudget({ maxElapsedMs: 1, now: () => at }),
    ).toThrow();
});
test("observation tracks memory even when no memory limit was requested", () => {
  const b = createDiagnosticResourceBudget({ maxElapsedMs: 1, now: () => 0 });
  expect(b.observe({ residentBytes: 123 }).exhausted).toBe(false);
  expect(b.snapshot().peakResidentBytes).toBe(123);
  expect(JSON.parse(JSON.stringify(b.snapshot()))).toEqual(b.snapshot());
});
