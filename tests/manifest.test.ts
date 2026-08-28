import { expect, test } from "bun:test";
import { manifest } from "../src/manifest";

test("declares an opt-in observability manifest", () => {
  expect(manifest.contract).toBe(2);
  expect(manifest.identity.name).toBe("@absolutejs/diagnostics");
  expect(manifest.wiring[0]?.id).toBe("browser");
});
