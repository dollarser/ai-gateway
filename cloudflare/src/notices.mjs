import { Denied } from "./store.mjs";
import { now, token } from "./crypto.mjs";
const reply = (value) =>
  Response.json(value, { headers: { "Cache-Control": "no-store" } });
const visible =
  "n.state='published' AND n.starts_at<=? AND (n.expires_at IS NULL OR n.expires_at>?) AND (n.audience='all' OR EXISTS(SELECT 1 FROM json_each(n.recipients) j WHERE j.value=?))";
function object(b, fields) {
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).some((k) => !fields.includes(k))
  )
    throw new Denied(422, "无效通告字段");
  return b;
}
function paging(url) {
  const page = Number(url.searchParams.get("page") || 1),
    state = url.searchParams.get("state") || "all";
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000 ||
    !["all", "unread"].includes(state)
  )
    throw new Denied(422, "无效分页参数");
  return { page, state };
}
const publicFields =
  "n.id,n.title,n.body,n.priority,n.starts_at,n.expires_at,n.published_at,n.version";
async function list(store, user, url, countOnly = false) {
  const { page, state } = paging(url),
    ts = now(),
    args = [user.id, ts, ts, user.id];
  const join =
    " FROM customer_notices n LEFT JOIN customer_notice_reads r ON r.notice_id=n.id AND r.user_id=? WHERE " +
    visible;
  const counts = await store.first(
    "SELECT count(*) total,coalesce(sum(r.read_at IS NULL),0) unread" + join,
    ...args,
  );
  if (countOnly) return { unread: counts.unread, poll_after_seconds: 86400 };
  const items = await store.all(
    "SELECT " +
      publicFields +
      ",r.read_at" +
      join +
      (state === "unread" ? " AND r.read_at IS NULL" : "") +
      " ORDER BY n.published_at DESC,n.id DESC LIMIT 30 OFFSET ?",
    ...args,
    (page - 1) * 30,
  );
  return { ...counts, page, page_size: 30, items, poll_after_seconds: 86400 };
}
async function content(store, b) {
  object(b, [
    "title",
    "body",
    "priority",
    "audience",
    "user_ids",
    "starts_at",
    "expires_at",
    "version",
  ]);
  if (
    typeof b.title !== "string" ||
    !b.title.trim() ||
    b.title.length > 160 ||
    typeof b.body !== "string" ||
    !b.body.trim() ||
    b.body.length > 8000
  )
    throw new Denied(422, "标题限160字符，正文限8000字符");
  const priority = b.priority ?? "normal",
    audience = b.audience ?? "all",
    ids = b.user_ids ?? [],
    start = b.starts_at ?? now(),
    end = b.expires_at ?? null;
  if (
    !["normal", "important"].includes(priority) ||
    !["all", "users"].includes(audience) ||
    !Array.isArray(ids) ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    (audience === "users" && !ids.length) ||
    (audience === "all" && ids.length) ||
    !Number.isFinite(start) ||
    start < 0 ||
    (end !== null && (!Number.isFinite(end) || end <= start))
  )
    throw new Denied(422, "接收范围或时间无效");
  if (ids.length) {
    const rows = await store.all(
      "SELECT id FROM users WHERE id IN (" + ids.map(() => "?").join(",") + ")",
      ...ids,
    );
    if (rows.length !== ids.length) throw new Denied(422, "接收账号不存在");
  }
  return [
    b.title.trim(),
    b.body.trim(),
    priority,
    audience,
    JSON.stringify(ids),
    start,
    end,
  ];
}
export async function noticesRoute(request, store, user, readBody) {
  const url = new URL(request.url),
    p = url.pathname,
    m = request.method;
  if (p.startsWith("/account/notices")) {
    if (user.must_change) throw new Denied(403, "请先修改初始密码");
    if (p === "/account/notices" && m === "GET")
      return reply(await list(store, user, url));
    if (p === "/account/notices/unread-count" && m === "GET")
      return reply(await list(store, user, url, true));
    if (p === "/account/notices/read" && m === "POST") {
      const b = object(await readBody(request), ["ids"]);
      if (
        !Array.isArray(b.ids) ||
        !b.ids.length ||
        b.ids.length > 100 ||
        new Set(b.ids).size !== b.ids.length ||
        b.ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{48}$/.test(id))
      )
        throw new Denied(422, "无效通告ID");
      const ts = now(),
        rows = await store.all(
          "SELECT n.id FROM customer_notices n WHERE " +
            visible +
            " AND n.id IN (" +
            b.ids.map(() => "?").join(",") +
            ")",
          ts,
          ts,
          user.id,
          ...b.ids,
        );
      if (rows.length !== b.ids.length)
        throw new Denied(404, "通告不存在或已失效");
      await store.db.batch(
        b.ids.map((id) =>
          store.stmt(
            "INSERT OR IGNORE INTO customer_notice_reads(notice_id,user_id,read_at) SELECT n.id,?,? FROM customer_notices n WHERE n.id=? AND " +
              visible,
            user.id,
            ts,
            id,
            ts,
            ts,
            user.id,
          ),
        ),
      );
      return reply({
        ok: true,
        ...(await list(store, user, new URL("https://local/"), true)),
      });
    }
    throw new Denied(404, "通告接口不存在");
  }
  if (!p.startsWith("/admin/notices")) return null;
  // Defense in depth: worker session validation also enforces this.
  if (user.role !== "admin" || user.must_change)
    throw new Denied(403, "需要管理员权限");
  if (p === "/admin/notices" && m === "GET") {
    const { page } = paging(url),
      items = await store.all(
        "SELECT * FROM customer_notices ORDER BY created DESC,id DESC LIMIT 30 OFFSET ?",
        (page - 1) * 30,
      ),
      total = (await store.first("SELECT count(*) n FROM customer_notices")).n;
    return reply({
      page,
      page_size: 30,
      total,
      items: items.map((n) => ({
        ...n,
        user_ids: JSON.parse(n.recipients),
        recipients: undefined,
      })),
    });
  }
  if (p === "/admin/notices" && m === "POST") {
    const values = await content(store, await readBody(request)),
      id = token(),
      ts = now();
    await store.db.batch([
      store.stmt(
        "INSERT INTO customer_notices(id,title,body,priority,audience,recipients,starts_at,expires_at,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
        id,
        ...values,
        ts,
        ts,
      ),
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
        user.id,
        "create_notice",
        id,
        ts,
      ),
    ]);
    return reply({ id, state: "draft", version: 1 });
  }
  const match = p.match(
    /^\/admin\/notices\/([a-f0-9]{48})(?:\/(publish|withdraw))?$/,
  );
  if (!match) throw new Denied(404, "通告不存在");
  const [, id, action] = match,
    b = await readBody(request);
  if (!action && m === "PATCH") {
    const values = await content(store, b);
    if (!Number.isSafeInteger(b.version)) throw new Denied(422, "需要草稿版本");
    const r = await store.run(
      "UPDATE customer_notices SET title=?,body=?,priority=?,audience=?,recipients=?,starts_at=?,expires_at=?,updated=?,version=version+1 WHERE id=? AND state='draft' AND version=?",
      ...values,
      now(),
      id,
      b.version,
    );
    if (!r.meta.changes) throw new Denied(409, "草稿已变更或已发布，请刷新");
    await store.audit(user.id, "edit_notice", id);
    return reply({ id, version: b.version + 1 });
  }
  if (action && m === "POST") {
    object(b, ["version"]);
    if (!Number.isSafeInteger(b.version)) throw new Denied(422, "需要通告版本");
    const ts = now(),
      r = await store.run(
        action === "publish"
          ? "UPDATE customer_notices SET state='published',published_at=?,updated=?,version=version+1 WHERE id=? AND state='draft' AND version=? AND (expires_at IS NULL OR expires_at>?)"
          : "UPDATE customer_notices SET state='withdrawn',updated=?,version=version+1 WHERE id=? AND state='published' AND version=?",
        ...(action === "publish"
          ? [ts, ts, id, b.version, ts]
          : [ts, id, b.version]),
      );
    if (!r.meta.changes)
      throw new Denied(409, "通告状态已变更或已过期，请刷新");
    await store.audit(user.id, action + "_notice", id);
    return reply({
      id,
      state: action === "publish" ? "published" : "withdrawn",
      version: b.version + 1,
    });
  }
  throw new Denied(404, "通告接口不存在");
}
