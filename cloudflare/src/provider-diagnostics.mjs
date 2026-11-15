// A separate destination observes its own connection, never OpenAI's exact peer IP.
const TARGET = "api64.ipify.org";
const safe = (s) =>
  typeof s === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(s) ? s : null;
export function ingressDiagnostics(request) {
  return {
    ingress_colo: safe(request.cf?.colo),
    client_country: safe(request.cf?.country),
    ingress_ray: safe(request.headers.get("cf-ray")),
  };
}
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
export async function probeEgress(store, lease, transport = fetch) {
  let ip = null,
    status = "failed";
  const at = Math.floor(Date.now() / 1000);
  try {
    const r = await transport("https://" + TARGET + "?format=json", {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      status = "http_error";
    } else {
      const reader = r.body?.getReader();
      if (!reader) throw new Error("missing body");
      let text = "",
        length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 256) throw new Error("large body");
          text += new TextDecoder().decode(value);
        }
      } finally {
        await reader.cancel();
      }
      const value = JSON.parse(text).ip;
      if (validIP(value)) {
        ip = value;
        status = "observed_reference";
      } else status = "invalid_response";
    }
  } catch (e) {
    status =
      e?.name === "TimeoutError" || e?.name === "AbortError"
        ? "timeout"
        : "failed";
  }
  // Independent update survives stream completion; finish() must not overwrite it.
  await store.run(
    "UPDATE requests SET egress_probe_ip=?,egress_probe_at=?,egress_probe_target=?,egress_probe_status=? WHERE id=?",
    ip,
    at,
    TARGET,
    status,
    lease,
  );
}
export function providerTransport(store, lease, trace, ctx, transport = fetch) {
  return async (url, options) => {
    const r = await transport(url, options);
    trace.upstream_request_id = safe(r.headers?.get("x-request-id"));
    trace.upstream_cf_ray = safe(r.headers?.get("cf-ray"));
    if (r.status === 403 && ctx)
      ctx.waitUntil(
        probeEgress(store, lease, transport).catch(() => {
          console.error("egress_probe_write_failed");
        }),
      );
    return r;
  };
}
