import { token, hex } from "./crypto.mjs";
const NUMERIC = [
  "count",
  "total",
  "failures",
  "window_minutes",
  "older_than_minutes",
  "p95_ms",
  "samples",
  "used_usd",
  "limit_usd",
];
function destination(env) {
  if (!env.ALERT_WEBHOOK_URL) return null;
  const u = new URL(env.ALERT_WEBHOOK_URL);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    u.hostname === "localhost" ||
    u.hostname.endsWith(".localhost") ||
    u.hostname.endsWith(".local") ||
    /^[\d.]+$/.test(u.hostname) ||
    u.hostname.includes(":")
  )
    throw new Error("invalid_destination");
  return u;
}
export function notificationConfiguration(env) {
  try {
    const u = destination(env);
    return {
      configured: true,
      external_configured: !!u,
      transport: u ? "in_app_and_https_json_webhook" : "in_app",
      destination_url: "https://accounts.hilex.me/#alerts",
      destination_host: u?.hostname ?? null,
      signed: !!env.ALERT_WEBHOOK_SECRET,
    };
  } catch {
    return {
      configured: true,
      external_configured: false,
      transport: "in_app",
      destination_url: "https://accounts.hilex.me/#alerts",
      external_error: "invalid_destination",
    };
  }
}
export async function enqueueAlerts(store, env) {
  if (!notificationConfiguration(env).configured) return;
  await store.run(
    "UPDATE alert_deliveries SET status='cancelled' WHERE event_state='open' AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM operational_alerts a WHERE a.kind=alert_deliveries.kind AND a.episode=alert_deliveries.episode AND a.state IN ('resolved','acknowledged'))",
  );
  const alerts = await store.all(
    "SELECT * FROM operational_alerts WHERE state IN ('open','resolved')",
  );
  for (const alert of alerts) {
    if (
      alert.state === "resolved" &&
      !(await store.first(
        "SELECT id FROM alert_deliveries WHERE kind=? AND episode=? AND event_state='open' AND status='sent' LIMIT 1",
        alert.kind,
        alert.episode,
      ))
    )
      continue;
    let details = {};
    try {
      const raw = JSON.parse(alert.details);
      details = Object.fromEntries(
        NUMERIC.filter((k) => Number.isFinite(raw[k]) && raw[k] >= 0).map(
          (k) => [k, raw[k]],
        ),
      );
    } catch {}
    const id = token(),
      now = Date.now() / 1000;
    const payload = {
      schema: "ai-gateway-alert-v1",
      id,
      kind: alert.kind,
      state: alert.state,
      episode: alert.episode,
      observed_at: new Date(alert.last_seen * 1000).toISOString(),
      details,
      dashboard: "https://accounts.hilex.me/#alerts",
    };
    await store.run(
      "INSERT INTO alert_deliveries(id,kind,episode,event_state,created,payload) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM alert_deliveries WHERE kind=? AND episode=? AND event_state=? AND (created>? OR status IN ('pending','sending')))",
      id,
      alert.kind,
      alert.episode,
      alert.state,
      now,
      JSON.stringify(payload),
      alert.kind,
      alert.episode,
      alert.state,
      alert.state === "resolved" ? 0 : now - 3600,
    );
  }
}
export async function deliverNotifications(store, env, transport = fetch) {
  if (!notificationConfiguration(env).configured) return;
  const configuration = notificationConfiguration(env);
  const url = configuration.external_configured
      ? destination(env).toString()
      : null,
    ts = Date.now() / 1000;
  const rows = await store.all(
    "SELECT * FROM alert_deliveries WHERE status IN ('pending','failed','sending') AND next_attempt<=? AND lease_until<? AND attempts<3 ORDER BY created LIMIT 10",
    ts,
    ts,
  );
  for (const row of rows) {
    const claimedRows = await store.db.batch([
      store.stmt(
        "UPDATE alert_deliveries SET status='sending',lease_until=?,last_attempt=?,attempts=attempts+1,channel=? WHERE id=? AND status IN ('pending','failed','sending') AND lease_until<? AND attempts<3",
        ts + 30,
        ts,
        url ? "webhook" : "in_app",
        row.id,
        ts,
      ),
      store.stmt(
        "INSERT OR IGNORE INTO notification_inbox(id,kind,event_state,created,payload) SELECT id,kind,event_state,created,payload FROM alert_deliveries WHERE id=? AND changes()=1",
        row.id,
      ),
    ]);
    const claimed = claimedRows[0];
    if (!claimed.meta.changes) continue;
    let status = "failed",
      code = null,
      http = null,
      retry = true;
    try {
      if (configuration.external_error) {
        code = configuration.external_error;
        retry = false;
      } else if (!url) {
        status = "sent";
        retry = false;
      } else {
        const headers = {
          "Content-Type": "application/json",
          "Idempotency-Key": row.id,
        };
        if (env.ALERT_WEBHOOK_SECRET) {
          const stamp = String(Math.floor(ts)),
            key = await crypto.subtle.importKey(
              "raw",
              new TextEncoder().encode(env.ALERT_WEBHOOK_SECRET),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            );
          headers["X-Alert-Timestamp"] = stamp;
          headers["X-Alert-Signature"] = hex(
            await crypto.subtle.sign(
              "HMAC",
              key,
              new TextEncoder().encode(stamp + "." + row.payload),
            ),
          );
        }
        const response = await transport(url, {
          method: "POST",
          headers,
          body: row.payload,
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        http = response.status;
        await response.body?.cancel();
        if (response.ok) {
          status = "sent";
          retry = false;
        } else {
          code = "http_" + http;
          retry = http === 408 || http === 429 || http >= 500;
        }
      }
    } catch (e) {
      code = ["TimeoutError", "AbortError"].includes(e?.name)
        ? "timeout"
        : e?.name === "TypeError"
          ? "transport_error"
          : "delivery_error";
    }
    const attempt = row.attempts + 1;
    await store.run(
      "UPDATE alert_deliveries SET status=?,lease_until=0,response_status=?,error_code=?,delivered_at=?,next_attempt=?,attempts=? WHERE id=?",
      status,
      http,
      code,
      status === "sent" ? Date.now() / 1000 : null,
      Date.now() / 1000 + Math.min(3600, 60 * 2 ** attempt),
      retry ? attempt : status === "sent" ? attempt : 3,
      row.id,
    );
  }
}
export async function notificationStatus(store, env) {
  return {
    ...notificationConfiguration(env),
    deliveries: await store.all(
      "SELECT id,kind,event_state,created,last_attempt,attempts,status,next_attempt,response_status,error_code,delivered_at,channel FROM alert_deliveries ORDER BY created DESC LIMIT 20",
    ),
  };
}
export async function enqueueTest(store, user) {
  const id = token(),
    ts = Date.now() / 1000;
  const r = await store.run(
    "INSERT INTO alert_deliveries(id,kind,episode,event_state,created,payload) SELECT ?,'test',0,'open',?,? WHERE NOT EXISTS(SELECT 1 FROM alert_deliveries WHERE kind='test' AND created>?)",
    id,
    ts,
    JSON.stringify({
      schema: "ai-gateway-alert-v1",
      id,
      kind: "test",
      state: "open",
      observed_at: new Date().toISOString(),
      details: {},
      dashboard: "https://accounts.hilex.me/#alerts",
    }),
    ts - 60,
  );
  if (!r.meta.changes) return null;
  await store.audit(user.id, "test_alert_delivery", id);
  return id;
}

export async function siteInbox(
  store,
  user,
  { page = 1, unread = false } = {},
) {
  const counts = await store.first(
    "SELECT count(*) total,coalesce(sum(r.read_at IS NULL),0) unread FROM notification_inbox n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=?",
    user.id,
  );
  const items = await store.all(
    "SELECT n.id,n.kind,n.event_state,n.created,n.payload,r.read_at FROM notification_inbox n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=?" +
      (unread ? " WHERE r.read_at IS NULL" : "") +
      " ORDER BY n.created DESC,n.id DESC LIMIT 30 OFFSET ?",
    user.id,
    (page - 1) * 30,
  );
  return {
    ...counts,
    page,
    page_size: 30,
    items: items.map((r) => {
      let payload = {};
      try {
        payload = JSON.parse(r.payload);
      } catch {}
      return {
        id: r.id,
        kind: r.kind,
        state: r.event_state,
        created: r.created,
        read_at: r.read_at,
        payload,
      };
    }),
  };
}
