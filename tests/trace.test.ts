import { describe, expect, test } from "bun:test";
import { parseServerTiming, parseTraceparent } from "../src/trace";

describe("diagnostic trace correlation", () => {
  test("parses valid W3C traceparent and rejects invalid identifiers", () => {
    expect(
      parseTraceparent(
        "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      ),
    ).toEqual({
      flags: "01",
      parentId: "b7ad6b7169203331",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      version: "00",
    });
    expect(
      parseTraceparent(
        "00-00000000000000000000000000000000-b7ad6b7169203331-01",
      ),
    ).toBeUndefined();
  });

  test("parses bounded Server-Timing metrics", () => {
    expect(
      parseServerTiming('db;dur=53.2, cache;desc="hit", total;dur=80'),
    ).toEqual([
      { duration: 53.2, name: "db" },
      { description: "hit", name: "cache" },
      { duration: 80, name: "total" },
    ]);
  });
});
