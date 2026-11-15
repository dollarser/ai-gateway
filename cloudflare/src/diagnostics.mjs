import { Denied } from "./store.mjs";
import { now } from "./crypto.mjs";
const reply = (b) =>
  Response.json(b, { headers: { "Cache-Control": "no-store" } });
function queryId(v) {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(v))
    throw new Denied(422, "请求 ID 无效");
  return v;
}
export async function diagnosticsRoute(request, store, user, readBody) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/admin/requests" && request.method === "GET") {
    const id = queryId(url.searchParams.get("request_id") ?? "");
    return reply(
      await store.all(
        "SELECT r.*,u.username FROM requests r JOIN users u ON u.id=r.user_id WHERE r.request_id=? OR r.id=? OR r.client_request_id=? ORDER BY r.started DESC LIMIT 100",
        id,
        id,
        id,
      ),
    );
  }
  if (path === "/admin/quota-review" && request.method === "GET") {
    const state = url.searchParams.get("state") ?? "pending",
      uid = url.searchParams.get("user_id");
    if (
      !["pending", "settled", "all"].includes(state) ||
      (uid !== null && !/^[1-9]\d*$/.test(uid))
    )
      throw new Denied(422, "核对筛选字段无效");
    const rows = await store.all(
      `SELECT q.*,u.username,r.request_id,r.status,r.ended,r.ended+60 adjustable_after,r.model FROM (SELECT 'luna' kind,'tokens' unit,lease,user_id,month period,reserved_tokens reserved_units,charged_tokens charged_units,settled,response_id FROM luna_usage UNION ALL SELECT 'audio' kind,CASE kind WHEN 'asr' THEN 'milliseconds' ELSE 'characters' END unit,lease,user_id,day period,reserved_units,charged_units,settled,response_id FROM audio_usage) q JOIN users u ON u.id=q.user_id JOIN requests r ON r.id=q.lease WHERE (?='all' OR q.settled=?) AND (? IS NULL OR q.user_id=?) ORDER BY r.started DESC LIMIT 100`,
      state,
      state === "settled" ? 1 : 0,
      uid,
      uid,
    );
    return reply(rows);
  }
  if (path === "/admin/quota-adjustments" && request.method === "POST") {
    const b = await readBody(request),
      fields = ["id", "kind", "lease", "expected_units", "units", "reason"];
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      Object.keys(b).length !== fields.length ||
      Object.keys(b).some((k) => !fields.includes(k))
    )
      throw new Denied(422, "核对字段无效");
    queryId(b.id);
    queryId(b.lease);
    if (
      !["luna", "audio"].includes(b.kind) ||
      ![b.units, b.expected_units].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      typeof b.reason !== "string" ||
      b.reason.trim().length < 5 ||
      b.reason.length > 500
    )
      throw new Denied(422, "请填写有效用量及至少五字符的核对原因");
    const old = await store.first(
      "SELECT * FROM quota_adjustments WHERE id=?",
      b.id,
    );
    if (old) {
      if (
        old.kind !== b.kind ||
        old.lease !== b.lease ||
        old.new_units !== b.units ||
        old.previous_units !== b.expected_units ||
        old.reason !== b.reason ||
        old.actor !== user.id
      )
        throw new Denied(409, "核对操作 ID 已被其他内容使用");
      return reply({ ok: true, id: b.id, replayed: true });
    }
    const table = b.kind === "luna" ? "luna_usage" : "audio_usage",
      charge = b.kind === "luna" ? "charged_tokens" : "charged_units",
      reserve = b.kind === "luna" ? "reserved_tokens" : "reserved_units";
    const row = await store.first(
      `SELECT q.*,r.ended FROM ${table} q JOIN requests r ON r.id=q.lease WHERE q.lease=?`,
      b.lease,
    );
    if (!row) throw new Denied(404, "额度账本不存在");
    if (
      !row.ended ||
      row.ended > now() - 60 ||
      row[charge] !== b.expected_units ||
      b.units > Math.max(row[reserve], row[charge])
    )
      throw new Denied(
        409,
        "请求尚未结束一分钟、用量已变更或核对值超出原预留，请刷新核对",
      );
    const result = await store.db.batch([
      store.stmt(
        `UPDATE ${table} SET ${charge}=?,settled=1 WHERE lease=? AND ${charge}=? AND EXISTS(SELECT 1 FROM requests WHERE id=? AND ended<=?) AND NOT EXISTS(SELECT 1 FROM quota_adjustments WHERE id=?)`,
        b.units,
        b.lease,
        b.expected_units,
        b.lease,
        now() - 60,
        b.id,
      ),
      store.stmt(
        "INSERT INTO quota_adjustments(id,kind,lease,actor,user_id,previous_units,new_units,reason,created) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
        b.id,
        b.kind,
        b.lease,
        user.id,
        row.user_id,
        b.expected_units,
        b.units,
        b.reason,
        now(),
      ),
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) SELECT ?,?,?,? WHERE changes()=1",
        user.id,
        "adjust_quota_usage",
        JSON.stringify({
          id: b.id,
          kind: b.kind,
          lease: b.lease,
          previous: b.expected_units,
          units: b.units,
          reason: b.reason,
        }),
        now(),
      ),
    ]);
    if (!result[0].meta.changes)
      throw new Denied(409, "用量已变更，请刷新后核对");
    return reply({ ok: true, id: b.id });
  }
  return null;
}
