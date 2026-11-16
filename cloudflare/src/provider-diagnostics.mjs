import { openaiRoute } from "./openai-route.mjs";
import { writeWorkerLog } from "./worker-logs.mjs";
import { collectObservation } from "./network-observations.mjs";
export { validIP } from "./network-observations.mjs";
const safe = (s) =>
  typeof s === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(s) ? s : null;
export function ingressDiagnostics(request) {
  return {
    ingress_colo: safe(request.cf?.colo),
    client_country: safe(request.cf?.country),
    ingress_ray: safe(request.headers.get("cf-ray")),
  };
}
export async function probeEgress(store, lease, transport = fetch) {
  return collectObservation(store, lease, {}, {}, transport);
}
export function providerTransport(
  store,
  lease,
  trace,
  ctx,
  transport = fetch,
  env = {},
) {
  const routed = openaiRoute(env, lease, trace.request_id, transport);
  return async (url, options) => {
    trace.upstream_attempted = 1;
    const r = await routed(url, options);
    trace.upstream_request_id = safe(
      r.headers?.get(
        env.OPENAI_TRANSPORT === "local"
          ? "x-openai-request-id"
          : "x-request-id",
      ),
    );
    trace.upstream_cf_ray = safe(
      r.headers?.get(
        env.OPENAI_TRANSPORT === "local" ? "x-openai-cf-ray" : "cf-ray",
      ),
    );
    const sample =
      r.status === 403
        ? "provider_403"
        : r.status >= 200 &&
            r.status < 300 &&
            env.PROVIDER_DIAGNOSTICS_ENABLED === "true"
          ? "upstream_accepted"
          : r.status === 101 && env.PROVIDER_DIAGNOSTICS_ENABLED === "true"
            ? "upstream_accepted"
            : null;
    if (sample && ctx && env.OPENAI_TRANSPORT !== "local")
      ctx.waitUntil(
        (async () => {
          const stamp = Math.floor(Date.now() / 1000),
            slot =
              "network-v2:" +
              sample +
              ":" +
              (trace.ingress_colo ?? "unknown") +
              ":" +
              Math.floor(stamp / 300);
          const reserved = await store.run(
            "INSERT OR IGNORE INTO diagnostic_probe_slots(slot,created) VALUES(?,?)",
            slot,
            stamp,
          );
          if (reserved?.meta?.changes === 0) {
            await store.run(
              "UPDATE requests SET egress_probe_at=?,egress_probe_status='sampled_out' WHERE id=?",
              stamp,
              lease,
            );
            return;
          }
          await collectObservation(store, lease, trace, env, transport, sample);
        })().catch(() => {
          writeWorkerLog("network_observation_failure", {
            request_id: trace.request_id,
            error_code: "observation_write_failed",
          });
        }),
      );
    return r;
  };
}
