import { hex, token } from "./crypto.mjs";
const TARGETS = ["api64.ipify.org", "api.ipify.org"];
export function validIP(value) {
  if (typeof value !== "string" || value.length > 45) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value))
    return value
      .split(".")
      .every((n) => Number(n) <= 255 && String(Number(n)) === n);
  if (!value.includes(":") || !/^[a-fA-F0-9:.]+$/.test(value)) return false;
  try {
    return new URL("http://[" + value + "]/").hostname.startsWith("[");
  } catch {
    return false;
  }
}
async function boundedJSON(response, limit) {
  const reader = response.body?.getReader();
  if (!reader)
    throw Object.assign(new Error(), { diagnosticCode: "missing_body" });
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw Object.assign(new Error(), { diagnosticCode: "body_too_large" });
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error(), { diagnosticCode: "invalid_json" });
  }
}
export async function referenceIP(transport = fetch) {
  const attempts = [];
  for (const target of TARGETS) {
    const start = performance.now();
    let phase = "connect",
      http = null;
    try {
      const r = await transport("https://" + target + "?format=json", {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      http = r.status;
      if (!r.ok) {
        await r.body?.cancel();
        attempts.push({
          target,
          status: "http_error",
          stage: "headers",
          error: "http_" + http,
          http_status: http,
          duration_ms: Math.round(performance.now() - start),
        });
        continue;
      }
      phase = "read";
      const value = await boundedJSON(r, 256);
      phase = "validate";
      if (!validIP(value.ip))
        throw Object.assign(new Error(), { diagnosticCode: "invalid_ip" });
      const result = {
        target,
        ip: value.ip,
        status: "observed_reference",
        stage: "complete",
        error: null,
        http_status: http,
        duration_ms: Math.round(performance.now() - start),
      };
      attempts.push(result);
      return { ...result, attempts };
    } catch (e) {
      const timeout = ["TimeoutError", "AbortError"].includes(e?.name);
      attempts.push({
        target,
        ip: null,
        status: timeout ? "timeout" : "failed",
        stage: phase,
        error: timeout
          ? "timeout"
          : (e.diagnosticCode ??
            (e?.name === "TypeError" ? "fetch_type_error" : "transport_error")),
        http_status: http,
        duration_ms: Math.round(performance.now() - start),
      });
    }
  }
  return { ...attempts.at(-1), attempts };
}
export async function controlledObservation(env, transport = fetch) {
  const start = performance.now();
  let stage = "configuration",
    http = null;
  try {
    if (!env.INTERNAL_SECRET)
      return { status: "unconfigured", stage, error: "missing_signing_secret" };
    const host = env.API_HOST ?? "api.hilex.me";
    if (!/^[a-zA-Z0-9.-]+$/.test(host))
      throw Object.assign(new Error(), {
        diagnosticCode: "invalid_receiver_host",
      });
    const timestamp = String(Math.floor(Date.now() / 1000)),
      nonce = token(),
      path = "/__diagnostics/network";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.INTERNAL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = hex(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          "diag-v1\n" + timestamp + "\n" + nonce + "\nGET\n" + path,
        ),
      ),
    );
    stage = "connect";
    const r = await transport("https://" + host + path, {
      headers: {
        "X-Diagnostic-Time": timestamp,
        "X-Diagnostic-Nonce": nonce,
        "X-Diagnostic-Signature": signature,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    http = r.status;
    if (!r.ok) {
      await r.body?.cancel();
      return {
        status: "http_error",
        stage: "headers",
        error: "http_" + http,
        http_status: http,
      };
    }
    stage = "read";
    const data = await boundedJSON(r, 4096);
    stage = "validate";
    if (
      data.schema !== "network-reference-v1" ||
      data.scope !== "same_zone_tunnel" ||
      data.observes_worker_tcp_source !== false
    )
      throw Object.assign(new Error(), {
        diagnosticCode: "invalid_receiver_schema",
      });
    const headers = {};
    for (const key of ["cf-connecting-ip", "cf-connecting-ipv6", "x-real-ip"])
      if (validIP(data.headers?.[key])) headers[key] = data.headers[key];
    for (const key of ["cf-ipcountry", "cf-ray", "cf-worker"]) {
      const value = data.headers?.[key];
      if (typeof value === "string" && /^[a-zA-Z0-9.-]{1,253}$/.test(value))
        headers[key] = value;
    }
    return {
      status: "observed_metadata",
      stage: "complete",
      scope: "same_zone_tunnel",
      observes_worker_tcp_source: false,
      headers,
      sensitive_headers_present: Object.fromEntries(
        ["authorization", "cookie", "x-api-key", "x-client-id"].map((k) => [
          k,
          data.sensitive_headers_present?.[k] === true,
        ]),
      ),
      http_status: http,
      duration_ms: Math.round(performance.now() - start),
    };
  } catch (e) {
    return {
      status: ["TimeoutError", "AbortError"].includes(e?.name)
        ? "timeout"
        : "failed",
      stage,
      error:
        e.diagnosticCode ??
        (e?.name === "TypeError" ? "fetch_type_error" : "receiver_error"),
      http_status: http,
      duration_ms: Math.round(performance.now() - start),
    };
  }
}
export async function collectObservation(
  store,
  lease,
  trace,
  env = {},
  transport = fetch,
  trigger = "provider_403",
) {
  const created = Math.floor(Date.now() / 1000);
  const [ip, controlled] = await Promise.all([
    referenceIP(transport),
    env.PROVIDER_DIAGNOSTICS_ENABLED === "true"
      ? controlledObservation(env, transport)
      : Promise.resolve({ status: "disabled" }),
  ]);
  if (lease)
    await store.run(
      "UPDATE requests SET egress_probe_ip=?,egress_probe_at=?,egress_probe_target=?,egress_probe_status=?,egress_probe_stage=?,egress_probe_error=?,egress_probe_http_status=?,egress_probe_duration_ms=? WHERE id=?",
      ip.ip ?? null,
      created,
      ip.target,
      ip.status,
      ip.stage,
      ip.error,
      ip.http_status,
      ip.duration_ms,
      lease,
    );
  const result = {
    reference: ip,
    controlled,
    limitation:
      "Separate reference connections; not the source IP or headers observed by OpenAI.",
  };
  const observationId = token();
  await store.run(
    "INSERT INTO network_observations(id,lease,created,trigger,ingress_colo,client_country,result) VALUES(?,?,?,?,?,?,?)",
    observationId,
    lease,
    created,
    trigger,
    trace.ingress_colo ?? null,
    trace.client_country ?? null,
    JSON.stringify(result),
  );
  return { ...result, observation_id: observationId };
}
