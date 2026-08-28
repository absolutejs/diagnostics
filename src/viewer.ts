import type {
  DiagnosticConsoleEntry,
  DiagnosticNetworkEntry,
  SupportBundle,
  SupportMarker,
} from "./contracts";

export type SupportTimelineItem =
  | { at: number; entry: DiagnosticConsoleEntry; kind: "console" }
  | { at: number; entry: DiagnosticNetworkEntry; kind: "network" }
  | { at: number; entry: SupportMarker; kind: "marker" };

export type SupportBundleComparison = {
  consoleDelta: number;
  durationDeltaMs: number;
  failedRequestDelta: number;
  markerDelta: number;
  networkDelta: number;
  onlyInLeft: string[];
  onlyInRight: string[];
  statusChanges: Array<{
    from: number;
    method: string;
    to: number;
    url: string;
  }>;
};

export const buildSupportTimeline = (
  bundle: SupportBundle,
): SupportTimelineItem[] =>
  [
    ...bundle.archive.console.map((entry): SupportTimelineItem => ({
      at: entry.at,
      entry,
      kind: "console",
    })),
    ...bundle.archive.network.map((entry): SupportTimelineItem => ({
      at: entry.startedAt,
      entry,
      kind: "network",
    })),
    ...bundle.markers.map((entry): SupportTimelineItem => ({
      at: entry.at,
      entry,
      kind: "marker",
    })),
  ].sort((left, right) => left.at - right.at);

const requestKey = (entry: DiagnosticNetworkEntry): string =>
  `${entry.request.method} ${entry.request.url}`;

const requestStatuses = (
  bundle: SupportBundle,
): Map<string, DiagnosticNetworkEntry> =>
  new Map(bundle.archive.network.map((entry) => [requestKey(entry), entry]));

export const compareSupportBundles = (
  left: SupportBundle,
  right: SupportBundle,
): SupportBundleComparison => {
  const leftRequests = requestStatuses(left);
  const rightRequests = requestStatuses(right);
  const onlyInLeft = [...leftRequests.keys()].filter(
    (key) => !rightRequests.has(key),
  );
  const onlyInRight = [...rightRequests.keys()].filter(
    (key) => !leftRequests.has(key),
  );
  const statusChanges = [...leftRequests].flatMap(([key, leftEntry]) => {
    const rightEntry = rightRequests.get(key);
    const from = leftEntry.response?.status ?? 0;
    const to = rightEntry?.response?.status ?? 0;
    if (rightEntry === undefined || from === to) return [];
    return [
      {
        from,
        method: leftEntry.request.method,
        to,
        url: leftEntry.request.url,
      },
    ];
  });
  const failed = (bundle: SupportBundle): number =>
    bundle.archive.network.filter(
      (entry) =>
        entry.error !== undefined ||
        (entry.response?.status ?? 0) === 0 ||
        (entry.response?.status ?? 0) >= 400,
    ).length;
  return {
    consoleDelta: right.archive.console.length - left.archive.console.length,
    durationDeltaMs:
      right.manifest.endedAt -
      right.manifest.startedAt -
      (left.manifest.endedAt - left.manifest.startedAt),
    failedRequestDelta: failed(right) - failed(left),
    markerDelta: right.markers.length - left.markers.length,
    networkDelta: right.archive.network.length - left.archive.network.length,
    onlyInLeft,
    onlyInRight,
    statusChanges,
  };
};

export const renderSupportBundleViewer = (
  target: HTMLElement,
  bundle: SupportBundle,
): (() => void) => {
  const root = document.createElement("section");
  root.setAttribute("aria-label", "Support diagnostic timeline");
  const style = document.createElement("style");
  style.textContent = `
    [data-absolute-support-viewer] { color: CanvasText; font: 13px/1.4 system-ui, sans-serif; overflow: auto; }
    [data-absolute-support-viewer] table { border-collapse: collapse; min-width: 52rem; width: 100%; }
    [data-absolute-support-viewer] caption { font-weight: 650; padding: .75rem 0; text-align: left; }
    [data-absolute-support-viewer] th, [data-absolute-support-viewer] td { border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding: .45rem .55rem; text-align: left; vertical-align: top; }
    [data-absolute-support-viewer] th { position: sticky; top: 0; background: Canvas; }
    [data-absolute-support-viewer] meter { width: 10rem; }
    [data-absolute-support-viewer] .failed { color: #b42318; font-weight: 650; }
  `;
  root.dataset.absoluteSupportViewer = "";
  const summary = document.createElement("p");
  summary.textContent = `${bundle.archive.network.length} network entries · ${bundle.archive.console.length} console entries · ${bundle.markers.length} markers`;
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = `Support timeline for ${bundle.manifest.reason ?? bundle.manifest.project}`;
  const header = document.createElement("tr");
  for (const label of ["UTC time", "Kind", "Details", "Duration"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    header.append(cell);
  }
  const head = document.createElement("thead");
  head.append(header);
  const body = document.createElement("tbody");
  const maximumDuration = Math.max(
    1,
    ...bundle.archive.network.map((entry) => entry.durationMs ?? 0),
  );
  for (const item of buildSupportTimeline(bundle)) {
    const row = document.createElement("tr");
    const time = document.createElement("td");
    time.textContent = new Date(item.at).toISOString();
    const kind = document.createElement("td");
    kind.textContent = item.kind;
    const details = document.createElement("td");
    details.textContent =
      item.kind === "network"
        ? `${item.entry.request.method} ${item.entry.request.url} → ${item.entry.response?.status ?? "pending"}`
        : item.kind === "console"
          ? `${item.entry.level}: ${item.entry.message}`
          : item.entry.label;
    if (
      item.kind === "network" &&
      ((item.entry.response?.status ?? 0) >= 400 ||
        item.entry.error !== undefined)
    ) {
      details.className = "failed";
    }
    const duration = document.createElement("td");
    if (item.kind === "network") {
      const milliseconds = Math.max(0, item.entry.durationMs ?? 0);
      const meter = document.createElement("meter");
      meter.max = maximumDuration;
      meter.value = milliseconds;
      meter.setAttribute(
        "aria-label",
        `${milliseconds.toFixed(2)} milliseconds`,
      );
      const label = document.createTextNode(` ${milliseconds.toFixed(2)}ms`);
      duration.append(meter, label);
    }
    row.append(time, kind, details, duration);
    body.append(row);
  }
  table.append(caption, head, body);
  root.append(style, summary, table);
  target.replaceChildren(root);
  return () => {
    if (root.parentNode === target) root.remove();
  };
};
