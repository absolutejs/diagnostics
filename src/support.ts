import {
  SUPPORT_BUNDLE_VERSION,
  type DiagnosticArchive,
  type SupportBundle,
  type SupportCorrelations,
  type SupportMarker,
} from "./contracts";
import { serializeDiagnosticHar } from "./har";
import {
  auditDiagnosticText,
  redactDiagnosticArchive,
  redactText,
  redactValue,
  type RedactionOptions,
} from "./redact";

export type CreateSupportBundleOptions = {
  archive: DiagnosticArchive;
  context?: Record<string, unknown>;
  expiresAt?: number;
  issueFingerprints?: string[];
  markers?: SupportMarker[];
  redaction?: RedactionOptions;
  traceIds?: string[];
};

const uniqueBounded = (
  values: readonly string[] | undefined,
): string[] | undefined => {
  if (values === undefined) return undefined;
  const unique = [
    ...new Set(values.map((value) => redactText(value).slice(0, 255))),
  ].slice(0, 100);
  return unique.length === 0 ? undefined : unique;
};

export const createSupportBundle = (
  options: CreateSupportBundleOptions,
): SupportBundle => {
  const archive = redactDiagnosticArchive(options.archive, options.redaction);
  const har = serializeDiagnosticHar(archive, options.redaction);
  const endedAt = archive.manifest.endedAt ?? Date.now();
  if (options.expiresAt !== undefined && options.expiresAt <= endedAt) {
    throw new Error("Support bundle expiry must be after the capture ends.");
  }
  const issueFingerprints = uniqueBounded(options.issueFingerprints);
  const traceIds = uniqueBounded([
    ...(options.traceIds ?? []),
    ...(archive.manifest.traceId === undefined
      ? []
      : [archive.manifest.traceId]),
    ...archive.network.flatMap((entry) => [
      ...(entry.trace === undefined ? [] : [entry.trace.traceId]),
      ...(entry.response?.trace === undefined
        ? []
        : [entry.response.trace.traceId]),
    ]),
  ]);
  const correlations: SupportCorrelations = {
    diagnosticId: archive.manifest.id,
    ...(issueFingerprints === undefined ? {} : { issueFingerprints }),
    ...(archive.manifest.replayId === undefined
      ? {}
      : { replayId: archive.manifest.replayId }),
    ...(traceIds === undefined ? {} : { traceIds }),
  };
  const markers = (options.markers ?? []).slice(0, 500).map((marker) => ({
    at: marker.at,
    ...(marker.data === undefined
      ? {}
      : {
          data: redactValue(marker.data) as Record<
            string,
            boolean | number | string
          >,
        }),
    label: redactText(marker.label).slice(0, 512),
  }));
  const candidate = {
    archive,
    ...(options.context === undefined
      ? {}
      : {
          context: redactValue(options.context) as Record<string, unknown>,
        }),
    correlations,
    har,
    manifest: {
      endedAt,
      ...(archive.manifest.environment === undefined
        ? {}
        : { environment: archive.manifest.environment }),
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
      id: archive.manifest.id,
      project: archive.manifest.project,
      ...(archive.manifest.reason === undefined
        ? {}
        : { reason: redactText(archive.manifest.reason) }),
      redacted: true as const,
      ...(archive.manifest.release === undefined
        ? {}
        : { release: archive.manifest.release }),
      startedAt: archive.manifest.startedAt,
    },
    markers,
    version: SUPPORT_BUNDLE_VERSION,
  };
  const serialized = JSON.stringify(candidate);
  const audit = auditDiagnosticText(serialized);
  if (!audit.safeToShare) {
    throw new Error(
      `Support bundle redaction audit failed: ${audit.findings
        .map((finding) => finding.code)
        .join(", ")}`,
    );
  }
  return {
    ...candidate,
    audit,
  };
};

export const serializeSupportBundle = (
  bundle: SupportBundle,
  space = 2,
): string => {
  const text = JSON.stringify(bundle, null, space);
  const audit = auditDiagnosticText(text);
  if (!audit.safeToShare)
    throw new Error("Support bundle is not safe to share.");
  return text;
};

export const downloadSupportBundle = (
  bundle: SupportBundle,
  filename = `support-${bundle.manifest.id}.json`,
): void => {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Support bundle download requires a browser document.");
  }
  const url = URL.createObjectURL(
    new Blob([serializeSupportBundle(bundle)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
};
