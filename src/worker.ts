import { redactValue } from "./redact";

const CHANNEL = "absolutejs.diagnostics.worker/1";
export type WorkerDiagnosticFrame = Readonly<{
  channel: typeof CHANNEL;
  jobId: string;
  sequence: number;
  event: string;
  json: string;
}>;
export type WorkerDiagnosticRecord = Readonly<{
  jobId: string;
  sequence: number;
  event: string;
  fields: Record<string, unknown>;
}>;
export type WorkerDiagnosticLimits = {
  /** Attempt budget, including invalid/dropped messages; default 32, maximum 256. */
  maxMessages?: number;
  /** UTF-8 JSON bytes per message; default 16384, maximum 65536. */
  maxMessageBytes?: number;
  /** UTF-8 JSON bytes per channel; default 262144, maximum 1048576. */
  maxTotalBytes?: number;
};
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_.:-]{1,96}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function config(jobId: string, options: WorkerDiagnosticLimits) {
  if (!identifier(jobId)) throw new TypeError("Invalid diagnostic job id");
  const maxMessages = options.maxMessages ?? 32;
  const maxMessageBytes = options.maxMessageBytes ?? 16384;
  const maxTotalBytes = options.maxTotalBytes ?? 262144;
  for (const [name, value, cap] of [
    ["maxMessages", maxMessages, 256],
    ["maxMessageBytes", maxMessageBytes, 65536],
    ["maxTotalBytes", maxTotalBytes, 1048576],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > cap)
      throw new RangeError(`Invalid ${name}`);
  }
  return { maxMessages, maxMessageBytes, maxTotalBytes };
}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** No worker, listener, network connection, storage, or retry queue is created.
 * Caller supplies trusted, already bounded fields and its own send callback.
 * Limits bound wire payload and attempts, not arbitrary producer object traversal.
 * Callbacks must be synchronous. Callback/serialization failures cannot escape into the measured computation.
 * Correlation identifiers/event names must contain no sensitive user data. */
export function createWorkerDiagnosticReporter(
  options: WorkerDiagnosticLimits & {
    jobId: string;
    send: (frame: WorkerDiagnosticFrame) => void;
  },
) {
  const jobId = options.jobId;
  const limits = config(jobId, options);
  if (typeof options.send !== "function")
    throw new TypeError("send is required");
  const send = options.send;
  let attempts = 0,
    sent = 0,
    dropped = 0,
    errors = 0,
    sentBytes = 0,
    closed = false;
  return {
    emit(event: string, fields: Record<string, unknown>): boolean {
      if (closed || attempts >= limits.maxMessages) return false;
      const sequence = ++attempts;
      try {
        if (!identifier(event) || !object(fields)) {
          dropped++;
          return false;
        }
        const json = JSON.stringify(redactValue(fields));
        if (json.length > limits.maxMessageBytes) {
          dropped++;
          return false;
        }
        const size = bytes(json);
        if (
          size > limits.maxMessageBytes ||
          sentBytes + size > limits.maxTotalBytes
        ) {
          dropped++;
          return false;
        }
        // Count attempted transmission even if the callback throws after posting.
        sentBytes += size;
        send(
          Object.freeze({
            channel: CHANNEL,
            jobId,
            sequence,
            event,
            json,
          }),
        );
        sent++;
        return true;
      } catch {
        errors++;
        dropped++;
        return false;
      }
    },
    close() {
      closed = true;
    },
    snapshot() {
      return {
        attempts,
        sent,
        dropped,
        errors,
        sentBytes,
        closed,
        exhausted:
          attempts >= limits.maxMessages || sentBytes >= limits.maxTotalBytes,
      };
    },
  };
}

/** Bind to one active job. Unrelated task messages are ignored. Call close on
 * cancellation/completion. The callback receives owned, redacted parsed fields;
 * it is responsible for existing diagnostic persistence/delivery policy. This is
 * not an authentication boundary or a guarantee that a worker's claims are true. */
export function createWorkerDiagnosticReceiver(
  options: WorkerDiagnosticLimits & {
    jobId: string;
    onRecord: (record: WorkerDiagnosticRecord) => void;
  },
) {
  const jobId = options.jobId;
  const limits = config(jobId, options);
  if (typeof options.onRecord !== "function")
    throw new TypeError("onRecord is required");
  const onRecord = options.onRecord;
  let attempts = 0,
    accepted = 0,
    rejected = 0,
    errors = 0,
    receivedBytes = 0,
    lastSequence = 0,
    missingSequences = 0,
    closed = false;
  return {
    receive(value: unknown): "unrelated" | "accepted" | "rejected" | "closed" {
      if (!object(value) || value.channel !== CHANNEL || value.jobId !== jobId)
        return "unrelated";
      if (closed || attempts >= limits.maxMessages) return "closed";
      attempts++;
      try {
        const { sequence, event, json } = value;
        if (
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          sequence < 1 ||
          sequence > limits.maxMessages ||
          sequence <= lastSequence ||
          !identifier(event) ||
          typeof json !== "string" ||
          json.length > limits.maxMessageBytes
        ) {
          rejected++;
          return "rejected";
        }
        const size = bytes(json);
        if (
          size > limits.maxMessageBytes ||
          receivedBytes + size > limits.maxTotalBytes
        ) {
          rejected++;
          return "rejected";
        }
        receivedBytes += size;
        const parsed: unknown = JSON.parse(json);
        if (!object(parsed)) {
          rejected++;
          return "rejected";
        }
        const fields = redactValue(parsed) as Record<string, unknown>;
        missingSequences += sequence - lastSequence - 1;
        lastSequence = sequence;
        accepted++;
        try {
          onRecord({ jobId, sequence, event, fields });
        } catch {
          errors++;
        }
        return "accepted";
      } catch {
        errors++;
        rejected++;
        return "rejected";
      }
    },
    close() {
      closed = true;
    },
    snapshot() {
      return {
        attempts,
        accepted,
        rejected,
        errors,
        receivedBytes,
        lastSequence,
        missingSequences,
        closed,
        exhausted:
          attempts >= limits.maxMessages ||
          receivedBytes >= limits.maxTotalBytes,
      };
    },
  };
}
