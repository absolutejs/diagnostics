import type {
  DiagnosticServerTiming,
  DiagnosticTraceContext,
} from "./contracts";
import { redactText } from "./redact";

const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/iu;

export const parseTraceparent = (
  value: string | null | undefined,
): DiagnosticTraceContext | undefined => {
  if (value === null || value === undefined) return undefined;
  const match = TRACEPARENT.exec(value.trim());
  if (match === null) return undefined;
  const [, version, traceId, parentId, flags] = match;
  if (
    version === undefined ||
    traceId === undefined ||
    parentId === undefined ||
    flags === undefined ||
    /^0+$/u.test(traceId) ||
    /^0+$/u.test(parentId) ||
    version.toLowerCase() === "ff"
  ) {
    return undefined;
  }
  return {
    flags: flags.toLowerCase(),
    parentId: parentId.toLowerCase(),
    traceId: traceId.toLowerCase(),
    version: version.toLowerCase(),
  };
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('\\"', '"')
    : trimmed;
};

export const parseServerTiming = (
  value: string | null | undefined,
): DiagnosticServerTiming[] | undefined => {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const timings = value.split(",").flatMap((item) => {
    const [rawName, ...parameters] = item.split(";");
    const name = rawName?.trim();
    if (!name) return [];
    const timing: DiagnosticServerTiming = {
      name: redactText(name).slice(0, 128),
    };
    for (const parameter of parameters) {
      const [rawKey, ...rawValue] = parameter.split("=");
      const key = rawKey?.trim().toLowerCase();
      const joined = rawValue.join("=");
      if (key === "dur") {
        const duration = Number(joined);
        if (Number.isFinite(duration) && duration >= 0)
          timing.duration = duration;
      } else if (key === "desc" && joined !== "") {
        timing.description = redactText(unquote(joined)).slice(0, 512);
      }
    }
    return [timing];
  });
  return timings.length === 0 ? undefined : timings;
};
