import { writeWorkerLog } from "./worker-logs.mjs";
import { mailConfiguration } from "./smtp-core.mjs";
import {
  notificationStatus,
  siteInbox,
  enqueueTest,
  deliverNotifications,
} from "./notifications.mjs";
import { Denied, day } from "./store.mjs";
import { now } from "./crypto.mjs";
import { globalUsage, validateLimits } from "./budgets.mjs";
const reply = (v) =>
  Response.json(v, { headers: { "Cache-Control": "no-store" } });
export async function operationalAlert(store, kind, details) {
  const ts = now();
  // Resolved alerts reopen only when a later monitoring window is still unhealthy.
  const row = await store
    .stmt(
      "INSERT INTO operational_alerts(kind,first_seen,last_seen,details) VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET last_seen=excluded.last_seen,occurrences=occurrences+1,details=excluded.details,episode=CASE WHEN operational_alerts.state='resolved' THEN operational_alerts.episode+1 ELSE operational_alerts.episode END,first_seen=CASE WHEN operational_alerts.state='resolved' THEN excluded.first_seen ELSE operational_alerts.first_seen END,state=CASE WHEN operational_alerts.state='acknowledged' AND operational_alerts.acknowledged_at>excluded.last_seen-3600 THEN operational_alerts.state ELSE 'open' END RETURNING first_seen,occurrences,episode",
      kind,
      ts,
      ts,
      JSON.stringify(details),
    )
    .first();
  if (row.occurrences === 1 || row.first_seen === ts)
    writeWorkerLog(
      "operational_alert",
      { kind, details, episode: row.episode, occurrences: row.occurrences },
      "warn",
    );
}
export async function monitor(store) {
  const ts = now(),
    window = ts - 900;
  const recent = await store.first(
    "SELECT count(*) total,coalesce(sum(status>=500),0) failures,coalesce(sum(upstream_error_code='unsupported_country_region_territory'),0) regions,coalesce(sum(duration_ms IS NOT NULL),0) samples,coalesce(sum(protocol='audio-stream' AND first_byte_ms IS NOT NULL),0) audio_samples FROM requests WHERE ended>?",
    window,
  );
  const pending = await store.first(
    "SELECT count(*) n FROM (SELECT l.lease FROM luna_usage l JOIN requests r ON r.id=l.lease WHERE l.settled=0 AND r.started<? UNION ALL SELECT a.lease FROM audio_usage a JOIN requests r ON r.id=a.lease WHERE a.settled=0 AND r.started<?)",
    window,
    window,
  );
  const samples = { n: recent.samples };
  const p95 =
    samples.n >= 20
      ? await store.first(
          "SELECT duration_ms n FROM requests WHERE ended>? AND duration_ms IS NOT NULL ORDER BY duration_ms LIMIT 1 OFFSET ?",
          window,
          Math.max(0, Math.ceil(samples.n * 0.95) - 1),
        )
      : null;
  const audioSamples = { n: recent.audio_samples };
  const audioP95 =
    audioSamples.n >= 10
      ? await store.first(
          "SELECT first_byte_ms n FROM requests WHERE ended>? AND protocol='audio-stream' AND first_byte_ms IS NOT NULL ORDER BY first_byte_ms LIMIT 1 OFFSET ?",
          window,
          Math.max(0, Math.ceil(audioSamples.n * 0.95) - 1),
        )
      : null;
  const budget = await globalUsage(store);
  const checks = [
    [
      "slow_first_audio",
      audioSamples.n >= 10 && audioP95.n > 10000,
      { p95_ms: audioP95?.n ?? 0, samples: audioSamples.n },
    ],
    [
      "provider_region_restricted",
      recent.regions > 0,
      { count: recent.regions, window_minutes: 15 },
    ],
    [
      "provider_error_rate",
      recent.total >= 20 && recent.failures / recent.total >= 0.1,
      { total: recent.total, failures: recent.failures, window_minutes: 15 },
    ],
    [
      "pending_usage",
      pending.n > 0,
      { count: pending.n, older_than_minutes: 15 },
    ],
    [
      "high_latency",
      samples.n >= 20 && p95.n > 120000,
      { p95_ms: p95?.n ?? 0, samples: samples.n },
    ],
    [
      "luna_budget",
      budget.limits.luna_monthly_usd > 0 &&
        budget.luna.used_usd >= budget.limits.luna_monthly_usd * 0.8,
      {
        used_usd: budget.luna.used_usd,
        limit_usd: budget.limits.luna_monthly_usd,
      },
    ],
  ];
  for (const [kind, active, details] of checks)
    if (active) await operationalAlert(store, kind, details);
    else
      await store.run(
        "UPDATE operational_alerts SET state='resolved' WHERE kind=? AND state!='resolved'",
        kind,
      );
  return { recent, p95_ms: p95?.n ?? null, pending: pending.n, budget };
}
export async function maintenance(store) {
  const ts = now(),
    cutoff = ts - 90 * 86400;
  const unlinked =
    "NOT EXISTS(SELECT 1 FROM luna_usage l WHERE l.lease=r.id) AND NOT EXISTS(SELECT 1 FROM audio_usage a WHERE a.lease=r.id) AND NOT EXISTS(SELECT 1 FROM quota_adjustments q WHERE q.lease=r.id)";
  const ids =
    "SELECT r.id FROM requests r WHERE r.ended<" +
    Math.floor(cutoff) +
    " AND " +
    unlinked +
    " UNION SELECT r.id FROM requests r WHERE r.path='/v1/models' AND r.ended IS NOT NULL AND r.day<'" +
    day() +
    "' AND " +
    unlinked +
    " LIMIT 500";
  const selected =
    "SELECT * FROM requests WHERE id IN(" + ids + ") ORDER BY started";
  await store.db.batch([
    store.stmt(
      "DELETE FROM access_tokens WHERE hash IN(SELECT hash FROM access_tokens WHERE expires<? LIMIT 1000)",
      ts,
    ),
    // Used refresh tokens are retained until expiry for family replay detection.
    store.stmt(
      "DELETE FROM refresh_tokens WHERE hash IN(SELECT hash FROM refresh_tokens WHERE expires<? LIMIT 1000)",
      ts - 86400,
    ),
    store.stmt(
      "DELETE FROM sessions WHERE hash IN(SELECT hash FROM sessions WHERE expires<? LIMIT 1000)",
      ts,
    ),
    store.stmt(
      "DELETE FROM auth_families WHERE id IN(SELECT id FROM auth_families WHERE expires<? AND NOT EXISTS(SELECT 1 FROM access_tokens WHERE family_id=auth_families.id) AND NOT EXISTS(SELECT 1 FROM refresh_tokens WHERE family_id=auth_families.id) AND NOT EXISTS(SELECT 1 FROM sessions WHERE family_id=auth_families.id) LIMIT 1000)",
      ts - 86400,
    ),
    store.stmt("DELETE FROM identity_attempts WHERE ts<?", ts - 3600),
    store.stmt(
      "DELETE FROM alert_deliveries WHERE id IN(SELECT id FROM alert_deliveries WHERE created<? AND (status IN ('sent','cancelled') OR attempts>=3) LIMIT 1000)",
      ts - 30 * 86400,
    ),
    store.stmt("DELETE FROM diagnostic_probe_slots WHERE created<?", ts - 3600),
    store.stmt(
      "DELETE FROM network_observations WHERE id IN(SELECT id FROM network_observations WHERE created<? LIMIT 1000)",
      ts - 7 * 86400,
    ),
    store.stmt(
      "UPDATE requests SET client_ip=NULL,user_agent=NULL,device_id=NULL WHERE id IN(SELECT id FROM requests WHERE started<? AND (client_ip IS NOT NULL OR user_agent IS NOT NULL OR device_id IS NOT NULL) LIMIT 1000)",
      ts - 30 * 86400,
    ),
    store.stmt(
      "INSERT INTO request_history(user_id,day,service,total,failed,response_bytes,prompt_tokens,completion_tokens) SELECT user_id,day,service,count(*),sum(CASE WHEN status>=400 THEN 1 ELSE 0 END),sum(response_bytes),sum(prompt_tokens),sum(completion_tokens) FROM (" +
        selected +
        ") GROUP BY user_id,day,service ON CONFLICT(user_id,day,service) DO UPDATE SET total=total+excluded.total,failed=failed+excluded.failed,response_bytes=response_bytes+excluded.response_bytes,prompt_tokens=prompt_tokens+excluded.prompt_tokens,completion_tokens=completion_tokens+excluded.completion_tokens",
    ),
    store.stmt(
      "DELETE FROM requests WHERE id IN(SELECT id FROM (" + selected + "))",
    ),
  ]);
}
export async function operationsRoute(
  request,
  store,
  user,
  readBody,
  env = {},
) {
  const p = new URL(request.url).pathname,
    m = request.method;
  if (p === "/admin/notifications" && m === "GET") {
    const u = new URL(request.url),
      page = Number(u.searchParams.get("page") ?? 1),
      state = u.searchParams.get("state") ?? "all";
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 1000 ||
      !["all", "unread"].includes(state)
    )
      throw new Denied(422, "通知筛选无效");
    return reply(
      await siteInbox(store, user, { page, unread: state === "unread" }),
    );
  }
  if (p === "/admin/notifications/read" && m === "POST") {
    const b = await readBody(request);
    if (
      !b ||
      Object.keys(b).length !== 1 ||
      !Array.isArray(b.ids) ||
      !b.ids.length ||
      b.ids.length > 100 ||
      new Set(b.ids).size !== b.ids.length ||
      b.ids.some(
        (id) => typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id),
      )
    )
      throw new Denied(422, "通知 ID 无效");
    const marks = b.ids.map(() => "?").join(",");
    const count = await store.first(
      "SELECT count(*) n FROM notification_inbox WHERE id IN(" + marks + ")",
      ...b.ids,
    );
    if (count.n !== b.ids.length) throw new Denied(404, "部分通知已过期");
    await store.run(
      "INSERT OR IGNORE INTO notification_reads(notification_id,user_id,read_at) SELECT id,?,? FROM notification_inbox WHERE id IN(" +
        marks +
        ")",
      user.id,
      now(),
      ...b.ids,
    );
    return reply(await siteInbox(store, user));
  }
  if (p === "/admin/operations" && m === "GET")
    return reply({
      ...(await globalUsage(store)),
      notifications: await notificationStatus(store, env),
      email_delivery: {
        configured: !!mailConfiguration(env),
        provider: mailConfiguration(env)?.provider ?? null,
        transactional: ["alicloud-directmail", "generic-smtp"].includes(
          mailConfiguration(env)?.provider,
        ),
      },
      registration: JSON.parse(
        (
          await store.first(
            "SELECT value FROM settings WHERE name='registration_policy'",
          )
        ).value,
      ),
      alerts: await store.all(
        "SELECT * FROM operational_alerts ORDER BY last_seen DESC",
      ),
      retention: { ip_days: 30, unbilled_request_days: 90, batch_size: 500 },
    });
  if (p === "/admin/global-limits" && m === "PATCH") {
    const b = validateLimits(await readBody(request));
    await store.db.batch([
      store.stmt(
        "UPDATE settings SET value=? WHERE name='global_limits'",
        JSON.stringify(b),
      ),
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
        user.id,
        "update_global_limits",
        JSON.stringify(b),
        now(),
      ),
    ]);
    return reply(await globalUsage(store));
  }
  if (p === "/admin/registration-policy" && m === "PATCH") {
    const b = await readBody(request),
      keys = ["enabled", "ip_hourly", "global_hourly", "global_minute"];
    if (
      !b ||
      typeof b !== "object" ||
      Object.keys(b).length !== keys.length ||
      Object.keys(b).some((k) => !keys.includes(k)) ||
      typeof b.enabled !== "boolean" ||
      keys
        .slice(1)
        .some((k) => !Number.isSafeInteger(b[k]) || b[k] < 1 || b[k] > 100000)
    )
      throw new Denied(422, "注册策略无效");
    await store.db.batch([
      store.stmt(
        "UPDATE settings SET value=? WHERE name='registration_policy'",
        JSON.stringify(b),
      ),
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
        user.id,
        "update_registration_policy",
        JSON.stringify(b),
        now(),
      ),
    ]);
    return reply(b);
  }
  if (p === "/admin/alerts/acknowledge" && m === "POST") {
    const b = await readBody(request);
    if (
      !b ||
      Object.keys(b).length !== 1 ||
      typeof b.kind !== "string" ||
      !/^[a-z_]{1,64}$/.test(b.kind)
    )
      throw new Denied(422, "告警类型无效");
    const r = await store.run(
      "UPDATE operational_alerts SET state='acknowledged',acknowledged_at=? WHERE kind=? AND state='open'",
      now(),
      b.kind,
    );
    if (!r.meta.changes) throw new Denied(409, "告警已变更");
    await store.audit(user.id, "acknowledge_alert", b.kind);
    return reply({ ok: true });
  }
  if (p === "/admin/notifications/test" && m === "POST") {
    const b = await readBody(request);
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      Object.keys(b).length
    )
      throw new Denied(422, "测试通知不接受自定义内容");
    if (!(await notificationStatus(store, env)).configured)
      throw new Denied(409, "通知接收端未就绪");
    const id = await enqueueTest(store, user);
    if (!id) throw new Denied(429, "测试通知每分钟最多一次");
    await deliverNotifications(store, env);
    return reply({ id, ...(await notificationStatus(store, env)) });
  }
  return null;
}
