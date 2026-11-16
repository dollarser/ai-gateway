import { Denied } from "./store.mjs";
import { ingressDiagnostics } from "./provider-diagnostics.mjs";
import { collectObservation } from "./network-observations.mjs";
const reply = (value) =>
  Response.json(value, { headers: { "Cache-Control": "no-store" } });
const fields =
  "request_id,started,ended,model,provider,protocol,status,upstream_status,error_code,upstream_error_code,upstream_error_param,upstream_request_id,upstream_cf_ray,ingress_ray,ingress_colo,client_country,release_sha,upstream_attempted,egress_probe_ip,egress_probe_at,egress_probe_target,egress_probe_status,egress_probe_stage,egress_probe_error,egress_probe_http_status,egress_probe_duration_ms";
function queryId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))
    throw new Denied(422, "请求 ID 无效");
  return id;
}
function redactObservation(value) {
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    return { status: "invalid_stored_observation" };
  }
  const ref = data.reference ?? {},
    control = data.controlled ?? {};
  return {
    reference: {
      target: ref.target ?? null,
      ip: ref.ip ?? null,
      status: ref.status ?? null,
      stage: ref.stage ?? null,
      error: ref.error ?? null,
      http_status: ref.http_status ?? null,
      duration_ms: ref.duration_ms ?? null,
    },
    controlled: {
      status: control.status ?? null,
      stage: control.stage ?? null,
      error: control.error ?? null,
      http_status: control.http_status ?? null,
      duration_ms: control.duration_ms ?? null,
      scope: control.scope ?? null,
      observes_worker_tcp_source: false,
      headers: Object.fromEntries(
        Object.entries(control.headers ?? {}).filter(([k]) =>
          ["cf-ipcountry", "cf-ray", "cf-worker"].includes(k),
        ),
      ),
      ip_headers_present: Object.fromEntries(
        ["cf-connecting-ip", "cf-connecting-ipv6", "x-real-ip"].map((k) => [
          k,
          typeof control.headers?.[k] === "string",
        ]),
      ),
      sensitive_headers_present: control.sensitive_headers_present ?? {},
    },
    limitation:
      "Reference IP and same-zone metadata are not OpenAI connection evidence.",
  };
}
export async function networkAdminRoute(request, env, store, user, readBody) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/admin/network-stats" && request.method === "GET") {
    const hours = Number(url.searchParams.get("hours") ?? 24);
    if (![1, 24, 168].includes(hours))
      throw new Denied(422, "时间窗口支持 1/24/168 小时");
    const filter = [],
      args = [Date.now() / 1000 - hours * 3600];
    for (const [key, column, pattern] of [
      ["country", "client_country", /^[A-Z0-9]{2}$/],
      ["colo", "ingress_colo", /^[A-Z]{3}$/],
      ["model", "model", /^[a-zA-Z0-9_.-]{1,128}$/],
    ]) {
      const value = url.searchParams.get(key);
      if (value) {
        if (!pattern.test(value)) throw new Denied(422, "统计筛选字段无效");
        filter.push(column + "=?");
        args.push(value);
      }
    }
    const where =
      "provider='openai' AND started>?" +
      (filter.length ? " AND " + filter.join(" AND ") : "");
    const rows = await store.all(
      "SELECT coalesce(client_country,'UNKNOWN') country,coalesce(ingress_colo,'UNKNOWN') colo,coalesce(model,'UNKNOWN') model,coalesce(protocol,'UNKNOWN') protocol,count(*) requests,sum(CASE WHEN status=200 THEN 1 ELSE 0 END) successful,sum(CASE WHEN status>=400 THEN 1 ELSE 0 END) failed,sum(CASE WHEN ended IS NULL THEN 1 ELSE 0 END) inflight,sum(CASE WHEN upstream_error_code='unsupported_country_region_territory' OR error_code='provider_region_restricted' THEN 1 ELSE 0 END) region_restricted,sum(CASE WHEN upstream_attempted=1 OR upstream_status IS NOT NULL THEN 1 ELSE 0 END) provider_attempts,round(avg(duration_ms)) average_duration_ms,round(avg(first_byte_ms)) average_first_byte_ms,max(started) last_seen FROM requests WHERE " +
        where +
        " GROUP BY client_country,ingress_colo,model,protocol ORDER BY requests DESC LIMIT 201",
      ...args,
    );
    const summary = await store.first(
      "SELECT count(*) requests,coalesce(sum(status=200),0) successful,coalesce(sum(upstream_error_code='unsupported_country_region_territory' OR error_code='provider_region_restricted'),0) region_restricted FROM requests WHERE " +
        where,
      ...args,
    );
    const obsArgs = [Date.now() / 1000 - hours * 3600],
      obsWhere = ["o.created>?"];
    for (const [key, column] of [
      ["country", "o.client_country"],
      ["colo", "o.ingress_colo"],
      ["model", "r.model"],
    ]) {
      const value = url.searchParams.get(key);
      if (value) {
        obsWhere.push(column + "=?");
        obsArgs.push(value);
      }
    }
    const observations = await store.all(
      "SELECT o.id,o.created,o.trigger,o.ingress_colo,o.client_country,o.result,r.client_ip private_client_ip FROM network_observations o LEFT JOIN requests r ON r.id=o.lease WHERE " +
        obsWhere.join(" AND ") +
        " ORDER BY o.created DESC LIMIT 20",
      ...obsArgs,
    );
    return reply({
      hours,
      generated_at: new Date().toISOString(),
      scope: "retained_gateway_requests",
      summary,
      truncated: rows.length > 200,
      groups: rows.slice(0, 200).map((r) => ({
        ...r,
        success_rate:
          r.requests - r.inflight > 0
            ? r.successful / (r.requests - r.inflight)
            : 0,
        region_error_rate:
          r.requests - r.inflight > 0
            ? r.region_restricted / (r.requests - r.inflight)
            : 0,
      })),
      observations: observations.map(({ private_client_ip, result, ...r }) => {
        const sanitized = redactObservation(result);
        if (private_client_ip && sanitized.reference?.ip === private_client_ip)
          sanitized.reference.ip = "<redacted-client-ip>";
        return { ...r, result: sanitized };
      }),
      limitations: [
        "country is client geolocation; colo is ingress, not proven execution/egress",
        "rates include local validation/budget failures and in-flight requests; provider_attempts is separate",
        "historical missing metadata is UNKNOWN; no claim of OpenAI source location",
      ],
    });
  }
  if (path === "/admin/diagnostic-bundle" && request.method === "GET") {
    const id = queryId(url.searchParams.get("request_id") ?? "");
    const row = await store.first(
      "SELECT " + fields + " FROM requests WHERE request_id=?",
      id,
    );
    if (!row) throw new Denied(404, "找不到该服务端请求 ID");
    const client = await store.first(
      "SELECT client_ip FROM requests WHERE request_id=?",
      id,
    );
    if (row.egress_probe_ip && row.egress_probe_ip === client?.client_ip)
      row.egress_probe_ip = "<redacted-client-ip>";
    const observation = await store.first(
      "SELECT created,trigger,result FROM network_observations WHERE lease=(SELECT id FROM requests WHERE request_id=?) ORDER BY created DESC LIMIT 1",
      id,
    );
    const sanitizedObservation = observation
      ? redactObservation(observation.result)
      : null;
    if (
      sanitizedObservation?.reference?.ip === client?.client_ip &&
      client?.client_ip
    )
      sanitizedObservation.reference.ip = "<redacted-client-ip>";
    const packet = {
      schema: "provider-diagnostic-v1",
      generated_at: new Date().toISOString(),
      request: {
        ...row,
        started_at_utc: new Date(row.started * 1000).toISOString(),
        ended_at_utc: row.ended
          ? new Date(row.ended * 1000).toISOString()
          : null,
      },
      observation: observation
        ? {
            created: observation.created,
            trigger: observation.trigger,
            result: sanitizedObservation,
          }
        : null,
      limitations: [
        "No conversation, audio, credentials, client IP, account identity, device or user agent included.",
        "Reference probes use separate connections; OpenAI must confirm its own source classification.",
      ],
    };
    await store.audit(user.id, "export_provider_diagnostic", id);
    return Response.json(packet, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition":
          'attachment; filename="provider-diagnostic-' + id + '.json"',
      },
    });
  }
  if (path === "/admin/network-probe" && request.method === "POST") {
    const body = await readBody(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length
    )
      throw new Denied(422, "手动诊断不接受用户内容");
    const trace = ingressDiagnostics(request),
      stamp = Math.floor(Date.now() / 1000);
    const reserved = await store.run(
      "INSERT OR IGNORE INTO diagnostic_probe_slots(slot,created) VALUES(?,?)",
      "manual-network:" + Math.floor(stamp / 60),
      stamp,
    );
    if (!reserved.meta.changes) throw new Denied(429, "手动诊断每分钟最多一次");
    const result = await collectObservation(
      store,
      null,
      trace,
      { ...env, PROVIDER_DIAGNOSTICS_ENABLED: "true" },
      fetch,
      "admin_manual",
    );
    await store.audit(
      user.id,
      "manual_network_probe",
      "synthetic_reference_only",
    );
    return reply({
      observation_id: result.observation_id,
      context: trace,
      result: redactObservation(JSON.stringify(result)),
      limitation:
        "This probe describes the current administrator request, not an earlier model request.",
    });
  }
  return null;
}
