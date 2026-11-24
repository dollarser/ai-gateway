import { writeWorkerLog } from "./worker-logs.mjs";

export async function timePhase(details, phase, operation) {
  if (!details) return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    details[phase] =
      (details[phase] ?? 0) + Math.round(performance.now() - started);
  }
}

export function logInferenceTiming(trace, status, start) {
  if (!trace.timing) return;
  writeWorkerLog(
    "inference_timing",
    {
      request_id: trace.request_id,
      path: trace.path,
      model: trace.model,
      provider: trace.provider,
      protocol: trace.protocol,
      operation: trace.operation,
      release_sha: trace.release_sha,
      status,
      duration_ms: Math.round(performance.now() - start),
      details: { ...trace.timing, first_byte_ms: trace.first_byte_ms },
    },
    "info",
  );
}
