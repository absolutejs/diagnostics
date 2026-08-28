import type {
  DiagnosticArchive,
  DiagnosticAuditFinding,
  DiagnosticAuditResult,
  DiagnosticHeader,
} from "./contracts";

export const REDACTED = "[REDACTED]";

const DEFAULT_MAX_BODY_BYTES = 16_384;
const SENSITIVE_HEADER =
  /^(?:authorization|cookie|proxy-authorization|set-cookie|x-api-key|x-auth-token)$/iu;
const SENSITIVE_FIELD =
  /(?:access[_-]?token|api[_-]?key|authorization|card(?:number)?|client[_-]?secret|cookie|credential|cryptogram|cv[cv]|email|encrypted[_-]?data|ephemeral[_-]?public[_-]?key|first[_-]?name|id[_-]?token|last[_-]?name|nonce|pass(?:code|word|wd)?|payment[_-]?(?:data|token)|phone|public[_-]?key[_-]?hash|refresh[_-]?token|secret|security[_-]?code|session|signature|token(?:ization)?(?:[_-]?key)?|transaction[_-]?identifier)/iu;
const SENSITIVE_QUERY =
  /^(?:access_token|api_?key|authorization|code|cookie|credential|id_token|nonce|password|payment_?data|payment_?token|refresh_token|secret|session|signature|token|tokenization_?key)$/iu;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/giu;
const PAYMENT_CARD_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/gu;

const validPaymentCard = (value: string): boolean => {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19) return false;
  // Unix epoch milliseconds are commonly serialized as 13 digits and happen
  // to pass Luhn roughly one time in ten. They are not payment-card evidence.
  if (digits.length === 13) {
    const numeric = Number(digits);
    if (numeric >= 946_684_800_000 && numeric <= 4_102_444_800_000) {
      return false;
    }
  }
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const character = digits[index];
    if (character === undefined) return false;
    let digit = Number(character);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

export type RedactionOptions = {
  maxBodyBytes?: number;
  /** Query parameter names whose values may remain. All other values are
   * removed, even when the parameter name does not look credential-bearing. */
  preserveQueryValues?: string[];
};

export type HarRedactionOptions = RedactionOptions & {
  retainRequestBody?: (context: { mimeType: string; url: string }) => boolean;
  retainResponseBody?: (context: { mimeType: string; url: string }) => boolean;
};

const truncateUtf8 = (value: string, maximum: number): string => {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximum) return value;
  const suffix = "…[TRUNCATED]";
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  return `${new TextDecoder().decode(bytes.slice(0, Math.max(0, maximum - suffixBytes)))}${suffix}`;
};

export const redactText = (value: string): string =>
  value
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(PAYMENT_CARD_CANDIDATE, (candidate) =>
      validPaymentCard(candidate) ? REDACTED : candidate,
    )
    .replace(
      /\b((?:access_?token|api_?key|authorization|client_?secret|cookie|id_?token|password|refresh_?token|secret|session|signature|token(?:ization_?key)?)\s*[:=]\s*)(?!\[REDACTED\])[^,;\s]+/giu,
      `$1${REDACTED}`,
    );

export const redactUrl = (
  value: string,
  options: RedactionOptions = {},
): string => {
  try {
    const url = new URL(value, "https://diagnostics.invalid");
    const absolute = /^[a-z][a-z\d+.-]*:/iu.test(value);
    const preserved = new Set(options.preserveQueryValues ?? []);
    for (const name of [...url.searchParams.keys()]) {
      if (!preserved.has(name) || SENSITIVE_QUERY.test(name)) {
        url.searchParams.set(name, REDACTED);
      }
    }
    url.hash = "";
    return absolute ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return value.replace(/[?#].*$/u, "");
  }
};

export const redactHeaders = (
  headers: readonly DiagnosticHeader[] | undefined,
): DiagnosticHeader[] | undefined => {
  if (headers === undefined) return undefined;
  return headers.map(({ name, value }) => ({
    name,
    value: SENSITIVE_HEADER.test(name) ? REDACTED : redactText(value),
  }));
};

const redactUnknown = (
  value: unknown,
  key: string | undefined,
  seen: Set<object>,
  depth: number,
): unknown => {
  if (key !== undefined && SENSITIVE_FIELD.test(key)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 12) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const redacted = Array.isArray(value)
    ? value.map((item) => redactUnknown(item, undefined, seen, depth + 1))
    : Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [
          childKey,
          redactUnknown(child, childKey, seen, depth + 1),
        ]),
      );
  seen.delete(value);
  return redacted;
};

export const redactBody = (
  value: string,
  mimeType = "",
  options: RedactionOptions = {},
): string => {
  const maximum = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let redacted: string;
  if (/json/iu.test(mimeType) || /^\s*[\[{]/u.test(value)) {
    try {
      redacted = JSON.stringify(
        redactUnknown(JSON.parse(value), undefined, new Set(), 0),
      );
    } catch {
      redacted = redactText(value);
    }
  } else if (/x-www-form-urlencoded/iu.test(mimeType)) {
    const parameters = new URLSearchParams(value);
    for (const name of [...parameters.keys()]) {
      parameters.set(
        name,
        SENSITIVE_FIELD.test(name)
          ? REDACTED
          : redactText(parameters.get(name) ?? ""),
      );
    }
    redacted = parameters.toString();
  } else {
    redacted = redactText(value);
  }
  return truncateUtf8(redacted, maximum);
};

export const redactDiagnosticArchive = (
  archive: DiagnosticArchive,
  options: RedactionOptions = {},
): DiagnosticArchive => ({
  ...archive,
  console: archive.console.map((entry) => ({
    ...entry,
    message: redactText(entry.message),
    ...(entry.source === undefined
      ? {}
      : {
          source: {
            ...entry.source,
            ...(entry.source.url === undefined
              ? {}
              : { url: redactUrl(entry.source.url, options) }),
          },
        }),
  })),
  manifest: { ...archive.manifest, redacted: true },
  network: archive.network.map((entry) => {
    const requestHeaders = redactHeaders(entry.request.headers);
    const responseHeaders = redactHeaders(entry.response?.headers);
    return {
      ...entry,
      ...(entry.error === undefined
        ? {}
        : {
            error: {
              ...entry.error,
              message: redactText(entry.error.message),
            },
          }),
      request: {
        ...entry.request,
        ...(entry.request.body === undefined
          ? {}
          : {
              body: redactBody(
                entry.request.body,
                entry.request.bodyMimeType,
                options,
              ),
            }),
        ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
        url: redactUrl(entry.request.url, options),
      },
      ...(entry.response === undefined
        ? {}
        : {
            response: {
              ...entry.response,
              ...(entry.response.body === undefined
                ? {}
                : {
                    body: redactBody(
                      entry.response.body,
                      entry.response.bodyMimeType,
                      options,
                    ),
                  }),
              ...(responseHeaders === undefined
                ? {}
                : { headers: responseHeaders }),
            },
          }),
    };
  }),
});

export const auditDiagnosticText = (value: string): DiagnosticAuditResult => {
  const findings: DiagnosticAuditFinding[] = [];
  const checks: Array<{
    code: DiagnosticAuditFinding["code"];
    pattern: RegExp;
  }> = [
    {
      code: "authorization-value",
      pattern:
        /"name"\s*:\s*"authorization"\s*,\s*"value"\s*:\s*"(?!\[REDACTED\])/iu,
    },
    {
      code: "cookie-value",
      pattern:
        /"name"\s*:\s*"(?:cookie|set-cookie)"\s*,\s*"value"\s*:\s*"(?!\[REDACTED\])/iu,
    },
    {
      code: "credential-query",
      pattern:
        /[?&](?:access_token|api_?key|authorization|id_token|password|payment_?token|refresh_token|secret|session|signature|token|tokenization_?key)=(?!(?:%5B|%\[|\[)REDACTED)/iu,
    },
    { code: "jwt", pattern: JWT },
    {
      code: "sensitive-field",
      pattern:
        /"(?:clientSecret|cvv|password|paymentData|paymentToken|refreshToken|sessionId|signature|tokenizationKey)"\s*:\s*"(?!\[REDACTED\])/iu,
    },
  ];
  for (const check of checks) {
    check.pattern.lastIndex = 0;
    if (check.pattern.test(value)) {
      findings.push({ code: check.code, location: "serialized-export" });
    }
  }
  PAYMENT_CARD_CANDIDATE.lastIndex = 0;
  for (const match of value.matchAll(PAYMENT_CARD_CANDIDATE)) {
    if (validPaymentCard(match[0])) {
      findings.push({
        code: "payment-card-number",
        location: "serialized-export",
      });
      break;
    }
  }
  return { findings, safeToShare: findings.length === 0 };
};

type HarRecord = Record<string, unknown>;

const records = (value: unknown): HarRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is HarRecord =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];

const stringField = (record: HarRecord, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

const collectHarSecret = (secrets: Set<string>, value: unknown): void => {
  if (typeof value === "string" && value.length >= 16) secrets.add(value);
};

/** Redact a DevTools/Playwright HAR without flattening its protocol timings.
 * Bodies are removed by default and can only be retained through an explicit
 * per-request allow function. */
export const redactHarObject = (
  input: unknown,
  options: HarRedactionOptions = {},
): unknown => {
  const har = structuredClone(input) as HarRecord;
  const log =
    har.log !== null && typeof har.log === "object"
      ? (har.log as HarRecord)
      : undefined;
  const entries = records(log?.entries);
  const rawSecrets = new Set<string>();

  for (const entry of entries) {
    const request = entry.request as HarRecord | undefined;
    const response = entry.response as HarRecord | undefined;
    if (request === undefined) continue;
    const rawUrl = stringField(request, "url");

    for (const side of [request, response]) {
      if (side === undefined) continue;
      for (const header of records(side.headers)) {
        const name = stringField(header, "name");
        const value = stringField(header, "value");
        if (SENSITIVE_HEADER.test(name)) collectHarSecret(rawSecrets, value);
        header.value = SENSITIVE_HEADER.test(name)
          ? REDACTED
          : redactText(value);
      }
      for (const cookie of records(side.cookies)) {
        collectHarSecret(rawSecrets, cookie.value);
        cookie.value = REDACTED;
      }
    }

    for (const parameter of records(request.queryString)) {
      const name = stringField(parameter, "name");
      const value = stringField(parameter, "value");
      if (
        SENSITIVE_QUERY.test(name) ||
        !options.preserveQueryValues?.includes(name)
      ) {
        collectHarSecret(rawSecrets, value);
        parameter.value = REDACTED;
      } else {
        parameter.value = redactText(value);
      }
    }
    request.url = redactUrl(rawUrl, options);

    const postData = request.postData as HarRecord | undefined;
    if (postData !== undefined && typeof postData.text === "string") {
      const mimeType = stringField(postData, "mimeType");
      collectHarSecret(rawSecrets, postData.text);
      postData.text = options.retainRequestBody?.({ mimeType, url: rawUrl })
        ? redactBody(postData.text, mimeType, options)
        : "[REDACTED REQUEST BODY]";
      for (const parameter of records(postData.params)) {
        const name = stringField(parameter, "name");
        const value = stringField(parameter, "value");
        if (SENSITIVE_FIELD.test(name)) collectHarSecret(rawSecrets, value);
        parameter.value = SENSITIVE_FIELD.test(name)
          ? REDACTED
          : redactText(value);
      }
    }

    const content = response?.content as HarRecord | undefined;
    if (content !== undefined && typeof content.text === "string") {
      const mimeType = stringField(content, "mimeType");
      content.text = options.retainResponseBody?.({ mimeType, url: rawUrl })
        ? redactBody(content.text, mimeType, options)
        : "[REDACTED RESPONSE BODY]";
      delete content.encoding;
    }
  }

  let serialized = JSON.stringify(har);
  for (const secret of rawSecrets) {
    serialized = serialized
      .split(secret)
      .join(REDACTED)
      .split(encodeURIComponent(secret))
      .join(encodeURIComponent(REDACTED));
  }
  return JSON.parse(serialized) as unknown;
};

export const redactHarText = (
  value: string,
  options: HarRedactionOptions = {},
): { audit: DiagnosticAuditResult; text: string } => {
  const text = JSON.stringify(redactHarObject(JSON.parse(value), options));
  const audit = auditDiagnosticText(text);
  return { audit, text };
};
