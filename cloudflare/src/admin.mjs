import { adminModelRoute } from "./model-access.mjs";
import { networkAdminRoute } from "./network-admin.mjs";
import { operationsRoute } from "./operations.mjs";
import { Denied, publicUser, day } from "./store.mjs";
import { now } from "./crypto.mjs";
import { budgetValue } from "./luna.mjs";
import { AUDIO_FIELDS, audioQuotas, audioUsage } from "./audio.mjs";
import { diagnosticsRoute } from "./diagnostics.mjs";
export const QUOTA_FIELDS = [
  "rpm",
  "daily_requests",
  "concurrency",
  "luna_monthly_tokens",
  ...AUDIO_FIELDS,
];
function object(b, allowed) {
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).some((k) => !allowed.includes(k))
  )
    throw new Denied(422, "无效管理字段");
  return b;
}
export function quotaPatch(b, defaults = false) {
  object(b, QUOTA_FIELDS);
  audioQuotas(b);
  if (b.luna_monthly_tokens !== undefined) budgetValue(b.luna_monthly_tokens);
  for (const k of ["rpm", "daily_requests", "concurrency"])
    if (
      b[k] !== undefined &&
      (!Number.isSafeInteger(b[k]) ||
        b[k] < (defaults || k === "concurrency" ? 1 : 0) ||
        b[k] >
          (k === "concurrency"
            ? 8
            : defaults
              ? k === "rpm"
                ? 600
                : 1000000
              : 1000000000))
    )
      throw new Denied(422, "请求额度无效");
  return b;
}
function selectedDay(url) {
  const value = url.searchParams.get("day") ?? day();
  if (
    !/^20\d\d-\d\d-\d\d$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Denied(422, "日期无效");
  return value;
}
const result = (v) =>
  Response.json(v, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function adminRoute(request, store, u, readBody, env = {}) {
  const models = await adminModelRoute(request, store, u, readBody);
  if (models) return models;
  const network = await networkAdminRoute(request, env, store, u, readBody);
  if (network) return network;
  const operational = await operationsRoute(request, store, u, readBody, env);
  if (operational) return operational;
  const diagnostic = await diagnosticsRoute(request, store, u, readBody);
  if (diagnostic) return diagnostic;
  const url = new URL(request.url),
    p = url.pathname,
    method = request.method;
  if (p === "/admin/quota-defaults") {
    if (method === "GET")
      return result({
        ...(await store.defaults()),
        luna_monthly_tokens: JSON.parse(
          (
            await store.first(
              "SELECT value FROM settings WHERE name='luna_defaults'",
            )
          ).value,
        ).monthly_tokens,
        ...JSON.parse(
          (
            await store.first(
              "SELECT value FROM settings WHERE name='audio_defaults'",
            )
          ).value,
        ),
      });
    if (method === "PATCH") {
      const b = quotaPatch(await readBody(request), true);
      if (Object.keys(b).length !== QUOTA_FIELDS.length)
        throw new Denied(422, "默认额度字段不完整");
      await store.db.batch([
        store.stmt(
          "UPDATE settings SET value=? WHERE name='registration_defaults'",
          JSON.stringify({
            rpm: b.rpm,
            daily_requests: b.daily_requests,
            concurrency: b.concurrency,
          }),
        ),
        store.stmt(
          "UPDATE settings SET value=? WHERE name='luna_defaults'",
          JSON.stringify({ monthly_tokens: b.luna_monthly_tokens }),
        ),
        store.stmt(
          "UPDATE settings SET value=? WHERE name='audio_defaults'",
          JSON.stringify(
            Object.fromEntries(AUDIO_FIELDS.map((k) => [k, b[k]])),
          ),
        ),
        store.stmt(
          "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
          u.id,
          "update_quota_defaults",
          JSON.stringify(b),
          now(),
        ),
      ]);
      return result(b);
    }
  }
  if (p === "/admin/users/bulk" && method === "POST") {
    const b = object(await readBody(request), ["ids", "patch"]);
    if (
      !Array.isArray(b.ids) ||
      !b.ids.length ||
      b.ids.length > 100 ||
      b.ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(b.ids).size !== b.ids.length
    )
      throw new Denied(422, "应选择 1–100 个不同账号");
    object(b.patch, [...QUOTA_FIELDS, "enabled"]);
    if (!Object.keys(b.patch).length) throw new Denied(422, "没有更新字段");
    const quota = Object.fromEntries(
      Object.entries(b.patch).filter(([k]) => k !== "enabled"),
    );
    quotaPatch(quota);
    if (b.patch.enabled !== undefined && typeof b.patch.enabled !== "boolean")
      throw new Denied(422, "enabled 必须为布尔值");
    const placeholders = b.ids.map(() => "?").join(",");
    const count = await store.first(
      `SELECT count(*) n FROM users WHERE id IN (${placeholders})`,
      ...b.ids,
    );
    if (count.n !== b.ids.length)
      throw new Denied(404, "部分账号已不存在，请刷新后重选");
    const keys = Object.keys(b.patch),
      values = keys.map((k) =>
        k === "enabled" ? Number(b.patch[k]) : b.patch[k],
      );
    const statements = [
      store.stmt(
        `UPDATE users SET ${keys.map((k) => k + "=?").join(",")} WHERE id IN (${placeholders})`,
        ...values,
        ...b.ids,
      ),
    ];
    if (b.patch.enabled === false)
      statements.push(
        store.stmt(
          `DELETE FROM sessions WHERE user_id IN (${placeholders})`,
          ...b.ids,
        ),
        store.stmt(
          `UPDATE auth_families SET revoked=1 WHERE user_id IN (${placeholders})`,
          ...b.ids,
        ),
      );
    statements.push(
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
        u.id,
        "bulk_update_users",
        JSON.stringify({ ids: b.ids, patch: b.patch }),
        now(),
      ),
    );
    await store.db.batch(statements);
    return result({ ok: true, updated: b.ids.length });
  }
  if (p === "/admin/overview" && method === "GET") {
    const date = selectedDay(url),
      q = (url.searchParams.get("q") ?? "").trim(),
      status = url.searchParams.get("status") ?? "all";
    const page = Number(url.searchParams.get("page") ?? 1),
      pageSize = Number(url.searchParams.get("page_size") ?? 50);
    if (
      q.length > 254 ||
      !["all", "enabled", "disabled"].includes(status) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw new Denied(422, "筛选或分页参数无效");
    const where =
      "(?='' OR u.display_name LIKE ? OR coalesce(u.email,'') LIKE ? OR coalesce(u.last_login_ip,'') LIKE ? OR EXISTS(SELECT 1 FROM requests r WHERE r.user_id=u.id AND r.client_ip=?)) AND (?='all' OR u.enabled=?)";
    const args = [
      q,
      "%" + q + "%",
      "%" + q + "%",
      "%" + q + "%",
      q,
      status,
      status === "enabled" ? 1 : 0,
    ];
    const includeSummary = url.searchParams.get("summary") !== "0";
    const statements = [
      store.stmt(
        `WITH page_users AS (
           SELECT u.* FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?
         )
         SELECT u.*,
           (SELECT count(*) FROM requests WHERE user_id=u.id AND day=?)
             + coalesce((SELECT sum(total) FROM request_history WHERE user_id=u.id AND day=?),0) day_requests,
           coalesce((SELECT sum(prompt_tokens+completion_tokens) FROM requests WHERE user_id=u.id AND day=?),0)
             + coalesce((SELECT sum(prompt_tokens+completion_tokens) FROM request_history WHERE user_id=u.id AND day=?),0) day_tokens,
           coalesce((SELECT sum(charged_tokens) FROM luna_usage WHERE user_id=u.id AND month=?),0) luna_used_tokens,
           coalesce((SELECT sum(charged_units) FROM audio_usage WHERE user_id=u.id AND day=? AND kind='asr'),0) asr_used_ms,
           coalesce((SELECT sum(charged_units) FROM audio_usage WHERE user_id=u.id AND day=? AND kind='tts'),0) tts_used_characters,
           (SELECT client_ip FROM requests WHERE user_id=u.id AND client_ip IS NOT NULL ORDER BY started DESC LIMIT 1) last_request_ip,
           (SELECT max(started) FROM requests WHERE user_id=u.id) last_request_at,
           (SELECT count(*) FROM keys WHERE user_id=u.id AND revoked=0 AND expires>unixepoch()) active_keys
         FROM page_users u ORDER BY u.id DESC`,
        ...args,
        pageSize,
        (page - 1) * pageSize,
        date,
        date,
        date,
        date,
        date.slice(0, 7),
        date,
        date,
      ),
      store.stmt(`SELECT count(*) n FROM users u WHERE ${where}`, ...args),
    ];
    if (includeSummary) {
      statements.push(
        store.stmt(
          "SELECT count(*) total,coalesce(sum(enabled=1),0) enabled FROM users",
        ),
        store.stmt(
          "SELECT coalesce(sum(total),0) total,coalesce(sum(failed),0) failed,coalesce(sum(inflight),0) inflight,coalesce(sum(tokens),0) tokens FROM (SELECT count(*) total,coalesce(sum(status>=400),0) failed,coalesce(sum(ended IS NULL),0) inflight,coalesce(sum(prompt_tokens+completion_tokens),0) tokens FROM requests WHERE day=? UNION ALL SELECT total,failed,0 inflight,prompt_tokens+completion_tokens tokens FROM request_history WHERE day=?)",
          date,
          date,
        ),
        store.stmt(
          "SELECT coalesce(sum(CASE WHEN kind='asr' THEN charged_units ELSE 0 END),0) asr_ms,coalesce(sum(CASE WHEN kind='tts' THEN charged_units ELSE 0 END),0) tts_characters FROM audio_usage WHERE day=?",
          date,
        ),
      );
    }
    const [rows, matching, allUsers, requests, speech] =
      await store.db.batch(statements);
    const users = allUsers?.results[0];
    return result({
      day: date,
      timezone: "Asia/Shanghai",
      ...(includeSummary && {
        summary: {
          users,
          ...requests.results[0],
          enabled_users: users.enabled,
          ...speech.results[0],
        },
      }),
      users: rows.results.map(publicUser),
      matching: matching.results[0].n,
      page,
      page_size: pageSize,
    });
  }
  const match = p.match(/^\/admin\/users\/(\d+)\/details$/);
  if (match && method === "GET") {
    const uid = Number(match[1]),
      date = selectedDay(url),
      target = await store.first("SELECT * FROM users WHERE id=?", uid);
    if (!target) throw new Denied(404, "账号不存在");
    const requests = await store.all(
      "SELECT r.*,l.charged_tokens luna_tokens,a.kind audio_kind,a.charged_units audio_units,a.settled audio_settled FROM requests r LEFT JOIN luna_usage l ON l.lease=r.id LEFT JOIN audio_usage a ON a.lease=r.id WHERE r.user_id=? AND r.day=? ORDER BY r.started DESC LIMIT 100",
      uid,
      date,
    );
    const ips = await store.all(
      "SELECT client_ip,count(*) requests,max(started) last_seen FROM requests WHERE user_id=? AND client_ip IS NOT NULL GROUP BY client_ip ORDER BY last_seen DESC LIMIT 20",
      uid,
    );
    return result({
      user: publicUser(target),
      day: date,
      requests,
      ips,
      audio: await audioUsage(store, uid),
      keys: await store.keys(uid),
    });
  }
  return null;
}
