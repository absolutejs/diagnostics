import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createBrowserDiagnostics } from "../src/browser";
import { createSupportBundle } from "../src/support";
import {
  connectSupportReportElements,
  createSupportModeController,
  type SupportReportElement,
} from "../src/ui";
import { compareSupportBundles } from "../src/viewer";
import { archiveFixture } from "./fixtures";

describe("support bundles", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test("correlates and redacts one audited artifact", () => {
    const archive = archiveFixture();
    archive.manifest.replayId = "123e4567-e89b-12d3-a456-426614174001";
    archive.network[0]!.trace = {
      flags: "01",
      parentId: "b7ad6b7169203331",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      version: "00",
    };
    const bundle = createSupportBundle({
      archive,
      context: { password: "do-not-retain", screen: "checkout" },
      issueFingerprints: ["issue-1", "issue-1"],
      markers: [{ at: 123, label: "token=private-value" }],
    });
    const serialized = JSON.stringify(bundle);

    expect(bundle.audit.safeToShare).toBe(true);
    expect(bundle.correlations.issueFingerprints).toEqual(["issue-1"]);
    expect(bundle.correlations.traceIds).toEqual([
      "0af7651916cd43dd8448eb211c80319c",
    ]);
    expect(serialized).not.toContain("do-not-retain");
    expect(serialized).not.toContain("private-value");
  });

  test("runs an explicit record-review-send state machine", async () => {
    const originalFetch = window.fetch;
    window.fetch = (async () =>
      new Response("ok")) as unknown as typeof window.fetch;
    const submitted: string[] = [];
    const controller = createSupportModeController({
      diagnostics: createBrowserDiagnostics({ project: "support-test" }),
      submit: (bundle) => {
        submitted.push(bundle.manifest.id);
        return Promise.resolve();
      },
    });

    expect(controller.snapshot().phase).toBe("idle");
    controller.start("checkout failed");
    controller.mark("clicked pay");
    await window.fetch("/checkout");
    const bundle = await controller.stop();
    expect(controller.snapshot().phase).toBe("reviewing");
    expect(bundle.markers[0]?.label).toBe("clicked pay");
    await controller.send();
    expect(controller.snapshot().phase).toBe("sent");
    expect(submitted).toEqual([bundle.manifest.id]);
    controller.discard();
    expect(controller.snapshot().phase).toBe("idle");
    window.fetch = originalFetch;
  });

  test("compares successful and failed support captures", () => {
    const left = createSupportBundle({ archive: archiveFixture() });
    const changed = archiveFixture();
    changed.network[0]!.response!.status = 502;
    changed.network.push({
      id: "new-request",
      initiator: "fetch",
      request: { method: "GET", url: "https://example.com/new" },
      response: { status: 200 },
      startedAt: changed.manifest.startedAt + 200,
    });
    const right = createSupportBundle({ archive: changed });
    const comparison = compareSupportBundles(left, right);
    expect(comparison.failedRequestDelta).toBe(1);
    expect(comparison.networkDelta).toBe(1);
    expect(comparison.statusChanges[0]).toMatchObject({ from: 200, to: 502 });
  });

  test("connects an accessible native report element", async () => {
    const controller = createSupportModeController({
      diagnostics: createBrowserDiagnostics({ project: "ui-test" }),
    });
    const tagName = "absolute-support-report-test";
    const element = document.createElement(tagName) as SupportReportElement;
    document.body.append(element);
    const disconnect = connectSupportReportElements(controller, { tagName });

    expect(element.controller).toBe(controller);
    const input = element.shadowRoot?.querySelector("input");
    const button = element.shadowRoot?.querySelector("button");
    expect(input).toBeDefined();
    expect(button?.textContent).toBe("Start recording");
    input!.value = "voice call failed";
    button?.click();
    await Promise.resolve();
    expect(controller.snapshot().phase).toBe("recording");
    controller.discard();
    disconnect();
    element.remove();
  });
});
