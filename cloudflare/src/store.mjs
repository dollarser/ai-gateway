import { digest, token, now, passwordHash, checkPassword } from "./crypto.mjs";
export class Denied extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}
export const SERVICES = ["asr", "qwen", "tts"];
export const day = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export function publicUser(r) {
  if (!r) return null;
  const { password, csrf, family, ...u } = r;
  return { ...u, services: JSON.parse(r.services) };
}
export class Store {
  constructor(db) {
    this.db = db;
  }
  stmt(sql, ...args) {
    return this.db.prepare(sql).bind(...args);
  }
  first(sql, ...args) {
    return this.stmt(sql, ...args).first();
  }
  async all(sql, ...args) {
    return (await this.stmt(sql, ...args).all()).results;
  }
  run(sql, ...args) {
    return this.stmt(sql, ...args).run();
  }
  async audit(actor, action, target) {
    await this.run(
      "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
      actor,
      action,
      String(target),
      now(),
    );
  }
  async defaults() {
    return JSON.parse(
      (
        await this.first(
          "SELECT value FROM settings WHERE name='registration_defaults'",
        )
      ).value,
    );
  }
  async createUser(username, password, options = {}) {
    const encoded = await passwordHash(password);
    const o = {
      role: "user",
      services: SERVICES,
      rpm: 30,
      daily_requests: 1000,
      concurrency: 2,
      must_change: 1,
      email: null,
      ...options,
    };
    let row;
    try {
      row = await this.stmt(
        "INSERT INTO users(username,password,role,services,rpm,daily_requests,concurrency,must_change,created,email) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING *",
        username.toLowerCase(),
        encoded,
        o.role,
        JSON.stringify(o.services),
        o.rpm,
        o.daily_requests,
        o.concurrency,
        Number(o.must_change),
        now(),
        o.email,
      ).first();
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new Denied(409, "账号已存在");
      throw e;
    }
    await this.audit(options.actor ?? null, "create_user", row.id);
    return publicUser(row);
  }
  async rateLimit(ip, kind) {
    const login = kind === "login";
    const table = login ? "login_attempts" : "registration_attempts";
    const column = login ? "ip" : "ip_hash";
    const value = login ? ip : await digest(ip);
    const window = login ? 300 : 3600;
    const limit = login ? 10 : 5;
    const ts = now();
    const result = await this.run(
      `INSERT INTO ${table}(${column},ts) SELECT ?,? WHERE (SELECT count(*) FROM ${table} WHERE ${column}=? AND ts>?)<? ${login ? "" : `AND (SELECT count(*) FROM ${table} WHERE ts>?)<100`}`,
      value,
      ts,
      value,
      ts - window,
      limit,
      ...(login ? [] : [ts - window]),
    );
    if (!result.meta.changes) throw new Denied(429, "尝试过多，请稍后重试");
  }
  async newTokens(family, expiry, extra = []) {
    const access = token("ai-at-"),
      refresh = token("ai-rt-");
    const accessExpiry = Math.min(now() + 900, expiry);
    return {
      access,
      refresh,
      statements: [
        ...extra,
        this.stmt(
          "INSERT INTO access_tokens SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM auth_families WHERE id=? AND revoked=0)",
          await digest(access),
          family,
          accessExpiry,
          family,
        ),
        this.stmt(
          "INSERT INTO refresh_tokens SELECT ?,?,?,0 WHERE EXISTS(SELECT 1 FROM auth_families WHERE id=? AND revoked=0)",
          await digest(refresh),
          family,
          expiry,
          family,
        ),
      ],
      body: {
        token_type: "Bearer",
        access_token: access,
        expires_in: Math.max(0, Math.floor(accessExpiry - now())),
        refresh_token: refresh,
        refresh_expires_in: Math.max(0, Math.floor(expiry - now())),
      },
    };
  }
  async login(username, password, ip) {
    await this.rateLimit(ip, "login");
    const u = await this.first(
      "SELECT * FROM users WHERE username=?",
      username.trim().toLowerCase(),
    );
    const dummy = "00000000000000000000000000000000:" + "0".repeat(128);
    const valid = await checkPassword(password, u?.password ?? dummy);
    if (!u || !valid || !u.enabled) throw new Denied(401, "用户名或密码错误");
    const cookie = token(),
      csrf = token(),
      family = token(),
      expiry = now() + 30 * 86400;
    const t = await this.newTokens(family, expiry, [
      this.stmt(
        "INSERT INTO auth_families SELECT ?,?,?,0 FROM users WHERE id=? AND enabled=1 AND password=?",
        family,
        u.id,
        expiry,
        u.id,
        u.password,
      ),
    ]);
    t.statements.push(
      this.stmt(
        "INSERT INTO sessions(hash,user_id,csrf,expires,family_id) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_families WHERE id=?)",
        await digest(cookie),
        u.id,
        csrf,
        now() + 43200,
        family,
        family,
      ),
    );
    const result = await this.db.batch(t.statements);
    if (!result[0].meta.changes) throw new Denied(401, "账号状态已变更");
    await this.audit(u.id, "login", u.id);
    return { cookie, body: { user: publicUser(u), csrf, ...t.body } };
  }
  async access(raw) {
    const row = await this.first(
      "SELECT users.*,auth_families.id AS family FROM access_tokens JOIN auth_families ON auth_families.id=access_tokens.family_id JOIN users ON users.id=auth_families.user_id WHERE access_tokens.hash=? AND access_tokens.expires>? AND auth_families.expires>? AND auth_families.revoked=0 AND users.enabled=1",
      await digest(raw),
      now(),
      now(),
    );
    if (!row) throw new Denied(401, "登录凭证无效或已过期");
    return row;
  }
  async session(raw) {
    const row = await this.first(
      "SELECT users.*,sessions.csrf,sessions.family_id AS family FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>? AND enabled=1",
      await digest(raw),
      now(),
    );
    if (!row) throw new Denied(401, "请重新登录");
    return row;
  }
  async revokeFamily(id) {
    await this.db.batch([
      this.stmt("UPDATE auth_families SET revoked=1 WHERE id=?", id),
      this.stmt("DELETE FROM sessions WHERE family_id=?", id),
    ]);
  }
  async refresh(raw) {
    const hash = await digest(raw);
    const r = await this.first(
      "SELECT r.*,f.expires AS family_expires,f.revoked,u.enabled FROM refresh_tokens r JOIN auth_families f ON f.id=r.family_id JOIN users u ON u.id=f.user_id WHERE r.hash=?",
      hash,
    );
    if (
      !r ||
      r.revoked ||
      !r.enabled ||
      r.expires <= now() ||
      r.family_expires <= now()
    )
      throw new Denied(401, "刷新凭证无效或已过期");
    if (r.used) {
      await this.revokeFamily(r.family_id);
      throw new Denied(401, "刷新凭证已使用，该登录已撤销");
    }
    const t = await this.newTokens(r.family_id, r.family_expires);
    // Conditional consumption and token creation occur in one atomic D1 batch.
    const statements = [
      this.stmt(
        "UPDATE refresh_tokens SET used=1 WHERE hash=? AND used=0 AND expires>? AND EXISTS(SELECT 1 FROM auth_families f JOIN users u ON u.id=f.user_id WHERE f.id=? AND f.revoked=0 AND f.expires>? AND u.enabled=1)",
        hash,
        now(),
        r.family_id,
        now(),
      ),
      this.stmt(
        "INSERT INTO access_tokens SELECT ?,?,? WHERE changes()=1",
        await digest(t.access),
        r.family_id,
        Math.min(now() + 900, r.family_expires),
      ),
      this.stmt(
        "INSERT INTO refresh_tokens SELECT ?,?,?,0 WHERE changes()=1",
        await digest(t.refresh),
        r.family_id,
        r.family_expires,
      ),
    ];
    const result = await this.db.batch(statements);
    if (!result[0].meta.changes) {
      await this.revokeFamily(r.family_id);
      throw new Denied(401, "刷新凭证已使用，该登录已撤销");
    }
    return t.body;
  }
  async invalidate(uid) {
    await this.db.batch([
      this.stmt("DELETE FROM sessions WHERE user_id=?", uid),
      this.stmt("UPDATE auth_families SET revoked=1 WHERE user_id=?", uid),
    ]);
  }
  async changePassword(uid, current, password) {
    const u = await this.first("SELECT * FROM users WHERE id=?", uid);
    if (!u || !(await checkPassword(current, u.password)))
      throw new Denied(403, "当前密码错误");
    const encoded = await passwordHash(password);
    const result = await this.db.batch([
      this.stmt(
        "UPDATE users SET password=?,must_change=0 WHERE id=? AND password=?",
        encoded,
        uid,
        u.password,
      ),
      this.stmt("DELETE FROM sessions WHERE user_id=? AND changes()=1", uid),
      this.stmt(
        "UPDATE auth_families SET revoked=1 WHERE user_id=? AND (SELECT password FROM users WHERE id=?)=?",
        uid,
        uid,
        encoded,
      ),
    ]);
    if (!result[0].meta.changes) throw new Denied(409, "密码已变更");
    await this.audit(uid, "change_password", uid);
  }
  async keys(uid) {
    return (
      await this.all(
        "SELECT id,name,prefix,services,expires,revoked,created FROM keys WHERE user_id=? ORDER BY id DESC",
        uid,
      )
    ).map((r) => ({ ...r, services: JSON.parse(r.services) }));
  }
  async createKey(actor, uid, b) {
    const u = await this.first("SELECT * FROM users WHERE id=?", uid);
    if (!u) throw new Denied(404, "账号不存在");
    if (b.services.some((s) => !JSON.parse(u.services).includes(s)))
      throw new Denied(403, "密钥权限不能超过账号权限");
    const raw = token("sk-acct-");
    const r = await this.stmt(
      "INSERT INTO keys(user_id,name,hash,prefix,services,expires,created) VALUES(?,?,?,?,?,?,?) RETURNING id",
      uid,
      b.name,
      await digest(raw),
      raw.slice(0, 16),
      JSON.stringify(b.services),
      now() + b.days * 86400,
      now(),
    ).first();
    await this.audit(actor, "create_key", r.id);
    return { key: raw, id: r.id, message: "密钥仅显示一次，请立即保存" };
  }
  async authCheck(ip) {
    const r = await this.first(
      "SELECT count(*) AS n FROM inference_auth_failures WHERE ip_hash=? AND ts>?",
      await digest(ip),
      now() - 60,
    );
    if (r.n >= 60) throw new Denied(429, "认证失败次数过多");
  }
  async acquire(raw, service, path) {
    if (!SERVICES.includes(service)) throw new Denied(400, "未知服务");
    let u,
      key = null,
      auth = "api_key";
    if (raw.startsWith("ai-at-")) {
      u = await this.access(raw);
      auth = "access_token";
    } else {
      key = await this.first(
        "SELECT * FROM keys WHERE hash=? AND revoked=0 AND expires>?",
        await digest(raw),
        now(),
      );
      if (!key) throw new Denied(401, "API Key 无效或已过期");
      u = await this.first("SELECT * FROM users WHERE id=?", key.user_id);
    }
    if (
      !u ||
      !u.enabled ||
      u.must_change ||
      !JSON.parse(u.services).includes(service) ||
      (key && !JSON.parse(key.services).includes(service))
    )
      throw new Denied(403, "没有该服务的权限或需要修改密码");
    const id = token(),
      ts = now();
    const check =
      auth === "access_token"
        ? "EXISTS(SELECT 1 FROM access_tokens a JOIN auth_families f ON f.id=a.family_id WHERE a.hash=? AND a.expires>? AND f.expires>? AND f.revoked=0)"
        : "EXISTS(SELECT 1 FROM keys WHERE hash=? AND revoked=0 AND expires>?)";
    const result = await this.run(
      "INSERT INTO requests(id,user_id,key_id,service,path,started,day,auth_type) SELECT ?,?,?,?,?,?,?,? WHERE " +
        check,
      id,
      u.id,
      key?.id ?? null,
      service,
      path,
      ts,
      day(),
      auth,
      await digest(raw),
      ts,
      ...(auth === "access_token" ? [ts] : []),
    );
    if (!result.meta.changes) throw new Denied(401, "凭证已失效");
    return id;
  }
  async remaining(lease) {
    const r = await this.first(
      "SELECT r.key_id,r.day,k.legacy_daily_tokens AS cap FROM requests r LEFT JOIN keys k ON k.id=r.key_id WHERE r.id=?",
      lease,
    );
    if (!r?.cap) return null;
    const spent = await this.first(
      "SELECT coalesce(sum(prompt_tokens+completion_tokens),0) AS n FROM requests WHERE key_id=? AND day=?",
      r.key_id,
      r.day,
    );
    const old = await this.first(
      "SELECT prompt_tokens+completion_tokens AS n FROM legacy_token_baseline WHERE key_id=? AND day=?",
      r.key_id,
      r.day,
    );
    return Math.max(0, r.cap - spent.n - (old?.n ?? 0));
  }
  async finish(b) {
    const t = b.trace ?? {};
    await this.run(
      "UPDATE requests SET ended=?,status=?,response_bytes=?,prompt_tokens=?,completion_tokens=?,request_id=?,client_request_id=?,helix_turn_id=?,helix_model_call_id=?,upstream_response_id=? WHERE id=? AND ended IS NULL",
      now(),
      b.status,
      b.size ?? 0,
      Math.max(0, b.prompt_tokens ?? 0),
      Math.max(0, b.completion_tokens ?? 0),
      ...[
        "request_id",
        "client_request_id",
        "helix_turn_id",
        "helix_model_call_id",
        "upstream_response_id",
      ].map((k) => (typeof t[k] === "string" ? t[k].slice(0, 256) : null)),
      b.lease,
    );
  }
  async usage(uid = null) {
    const filter = uid ? " AND user_id=?" : "";
    return {
      today: day(),
      totals: await this.all(
        "SELECT service,count(*) requests,coalesce(sum(response_bytes),0) response_bytes FROM requests WHERE day=?" +
          filter +
          " GROUP BY service",
        day(),
        ...(uid ? [uid] : []),
      ),
      requests: await this.all(
        "SELECT * FROM requests" +
          (uid ? " WHERE user_id=?" : "") +
          " ORDER BY started DESC LIMIT 100",
        ...(uid ? [uid] : []),
      ),
    };
  }
}
