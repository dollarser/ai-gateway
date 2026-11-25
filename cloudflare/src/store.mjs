import { digest, token, now, passwordHash, checkPassword } from "./crypto.mjs";
export class Denied extends Error {
  constructor(status, detail, code) {
    super(detail);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
export function normalizeDisplayName(value) {
  const name = typeof value === "string" ? value.normalize("NFC").trim() : "";
  if (!name || [...name].length > 80 || /[\p{C}]/u.test(name)) {
    const e = new Denied(422, "显示名须为 1–80 个可见字符");
    e.code = "display_name_invalid";
    throw e;
  }
  return name;
}
export const SERVICES = ["asr", "qwen", "tts"];
export const day = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export function publicUser(r) {
  if (!r) return null;
  const { password, csrf, family, ...u } = r;
  return {
    ...u,
    email_binding_required: !r.email_verified_at,
    luna_monthly_tokens: r.luna_monthly_tokens ?? 0,
    services: JSON.parse(r.services),
    allowed_model_ids: JSON.parse(r.allowed_model_ids ?? "null"),
  };
}
export class Store {
  constructor(db, timing = null) {
    this.db = db;
    this.timing = timing;
  }
  stmt(sql, ...args) {
    return this.db.prepare(sql).bind(...args);
  }
  async measured(promise, started, phase) {
    try {
      const result = await promise;
      if (result?.meta) {
        const t = this.timing;
        t.db_rows_read = (t.db_rows_read ?? 0) + (result.meta.rows_read ?? 0);
        t.db_rows_written =
          (t.db_rows_written ?? 0) + (result.meta.rows_written ?? 0);
        t.db_meta_ops = (t.db_meta_ops ?? 0) + 1;
      }
      return result;
    } finally {
      const t = this.timing;
      const elapsed = Math.round(performance.now() - started);
      t.db_ops = (t.db_ops ?? 0) + 1;
      t.db_ms = (t.db_ms ?? 0) + elapsed;
      if (phase) t[phase] = (t[phase] ?? 0) + elapsed;
    }
  }
  first(sql, ...args) {
    if (!this.timing) return this.stmt(sql, ...args).first();
    const started = performance.now();
    return this.measured(this.stmt(sql, ...args).first(), started);
  }
  async all(sql, ...args) {
    if (!this.timing) return (await this.stmt(sql, ...args).all()).results;
    const started = performance.now();
    return (await this.measured(this.stmt(sql, ...args).all(), started))
      .results;
  }
  run(sql, ...args) {
    if (!this.timing) return this.stmt(sql, ...args).run();
    const phase = /^INSERT INTO (luna_usage|audio_usage)\b/.test(sql)
      ? "reserve_ms"
      : /^UPDATE (luna_usage|audio_usage|requests) SET (charged_|model=)/.test(
            sql,
          )
        ? "settle_ms"
        : null;
    const started = performance.now();
    return this.measured(this.stmt(sql, ...args).run(), started, phase);
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
  async createUser(display_name, password, options = {}) {
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
    if (o.email !== null) o.email = o.email.trim().toLowerCase();
    const lunaDefaults = JSON.parse(
      (
        await this.first(
          "SELECT value FROM settings WHERE name='luna_defaults'",
        )
      ).value,
    );
    const lunaLimit = o.luna_monthly_tokens ?? lunaDefaults.monthly_tokens;
    const audioDefaults = JSON.parse(
      (
        await this.first(
          "SELECT value FROM settings WHERE name='audio_defaults'",
        )
      ).value,
    );
    let row;
    try {
      const verification = o.emailVerification;
      const insert = this.stmt(
        "INSERT INTO users(display_name,password,role,services,rpm,daily_requests,concurrency,must_change,created,email,luna_monthly_tokens,openai_asr_daily_seconds,openai_tts_daily_characters,email_verified_at,allowed_model_ids) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT value FROM settings WHERE name='new_account_model_ids')" +
          (verification
            ? " WHERE EXISTS(SELECT 1 FROM registration_codes WHERE email_hash=? AND id=? AND code_hash=? AND state='sent' AND expires>? AND attempts<=5)"
            : "") +
          " RETURNING *",
        normalizeDisplayName(display_name),
        encoded,
        o.role,
        JSON.stringify(o.services),
        o.rpm,
        o.daily_requests,
        o.concurrency,
        Number(o.must_change),
        now(),
        o.email,
        lunaLimit,
        o.openai_asr_daily_seconds ?? audioDefaults.openai_asr_daily_seconds,
        o.openai_tts_daily_characters ??
          audioDefaults.openai_tts_daily_characters,
        verification ? now() : null,
        ...(verification
          ? [verification.emailHash, verification.id, verification.hash, now()]
          : []),
      );
      if (verification) {
        const results = await this.db.batch([
          insert,
          this.stmt(
            "UPDATE registration_codes SET state='consumed',code_hash='' WHERE email_hash=? AND id=? AND changes()=1",
            verification.emailHash,
            verification.id,
          ),
        ]);
        row = results[0].results[0];
        if (!row) {
          const e = new Denied(400, "验证码无效或已使用，请重新获取");
          e.code = "email_verification_invalid";
          throw e;
        }
      } else row = await insert.first();
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        const error = new Denied(409, "邮箱已被使用");
        error.code = "email_in_use";
        throw error;
      }
      throw e;
    }
    await this.audit(options.actor ?? null, "create_user", row.id);
    return publicUser(row);
  }
  async rateLimit(ip, kind, identity = "") {
    const login = kind === "login";
    const table = login ? "login_attempts" : "registration_attempts";
    const column = login ? "ip" : "ip_hash";
    const value = login ? ip : await digest(ip);
    const window = login ? 300 : 3600;
    const policy = login
      ? null
      : JSON.parse(
          (
            await this.first(
              "SELECT value FROM settings WHERE name='registration_policy'",
            )
          ).value,
        );
    if (policy && !policy.enabled) throw new Denied(403, "当前暂停公开注册");
    const limit = login ? 10 : policy.ip_hourly;
    const ts = now(),
      identityHash = await digest(identity.trim().toLowerCase());
    const rows = await this.db.batch([
      this.stmt(
        `INSERT INTO ${table}(${column},ts) SELECT ?,? WHERE (SELECT count(*) FROM ${table} WHERE ${column}=? AND ts>?)<? AND (SELECT count(*) FROM identity_attempts WHERE kind=? AND hash=? AND ts>?)<? ${login ? "" : `AND (SELECT count(*) FROM ${table} WHERE ts>?)<? AND (SELECT count(*) FROM ${table} WHERE ts>?)<?`}`,
        value,
        ts,
        value,
        ts - window,
        limit,
        kind,
        identityHash,
        ts - window,
        login ? 10 : 3,
        ...(login
          ? []
          : [ts - window, policy.global_hourly, ts - 60, policy.global_minute]),
      ),
      this.stmt(
        "INSERT INTO identity_attempts(kind,hash,ts) SELECT ?,?,? WHERE changes()=1",
        kind,
        identityHash,
        ts,
      ),
    ]);
    const result = rows[0];
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
  async findLoginUser(email) {
    if (typeof email !== "string" || !email.includes("@")) return null;
    return this.first(
      "SELECT * FROM users WHERE email=? COLLATE NOCASE",
      email.trim().toLowerCase(),
    );
  }
  async changeDisplayName(uid, value) {
    const display_name = normalizeDisplayName(value),
      u = await this.first("SELECT * FROM users WHERE id=?", uid);
    if (!u || !u.enabled) throw new Denied(401, "账号不可用");
    if (u.must_change) throw new Denied(403, "请先修改初始密码");
    if (display_name === u.display_name) return publicUser(u);
    const ts = now(),
      cutoff = ts - 86400;
    const limited = () => {
      const e = new Denied(429, "显示名每 24 小时可修改一次");
      e.code = "display_name_change_limited";
      e.retryable = false;
      return e;
    };
    if (u.display_name_updated_at > cutoff) throw limited();
    const result = await this.db.batch([
      this.stmt(
        "UPDATE users SET display_name=?,display_name_updated_at=? WHERE id=? AND password=? AND enabled=1 AND must_change=0 AND (display_name_updated_at=0 OR display_name_updated_at<=?)",
        display_name,
        ts,
        uid,
        u.password,
        cutoff,
      ),
      this.stmt(
        "INSERT INTO audit(actor,action,target,ts) SELECT ?,'change_display_name',?,? WHERE changes()=1",
        uid,
        JSON.stringify({
          user_id: uid,
          from: u.display_name,
          to: display_name,
        }),
        ts,
      ),
    ]);
    if (!result[0].meta.changes) {
      const latest = await this.first(
        "SELECT display_name_updated_at FROM users WHERE id=?",
        uid,
      );
      if (latest?.display_name_updated_at > cutoff) throw limited();
      throw new Denied(409, "账号状态已变化，请刷新后重试");
    }
    return publicUser(await this.first("SELECT * FROM users WHERE id=?", uid));
  }
  async login(email, password, ip) {
    const u = await this.findLoginUser(email);
    await this.rateLimit(ip, "login", u ? "account:" + u.id : email);
    const dummy = "00000000000000000000000000000000:" + "0".repeat(128);
    const valid = await checkPassword(password, u?.password ?? dummy);
    if (!u || !valid || !u.enabled) throw new Denied(401, "邮箱或密码错误");
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
    t.statements.push(
      this.stmt(
        "UPDATE users SET last_login_ip=?,last_login_at=? WHERE id=? AND EXISTS(SELECT 1 FROM auth_families WHERE id=?)",
        ip === "local" ? null : ip.slice(0, 128),
        now(),
        u.id,
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
  async catalogUser(raw) {
    const u = raw.startsWith("ai-at-")
      ? await this.access(raw)
      : await this.first(
          "SELECT u.*,k.services key_services FROM keys k JOIN users u ON u.id=k.user_id WHERE k.hash=? AND k.revoked=0 AND k.expires>?",
          await digest(raw),
          now(),
        );
    if (!u) throw new Denied(401, "凭证无效或已过期");
    if (!u.enabled || u.must_change)
      throw new Denied(403, "账号已禁用或需要修改密码");
    const permitted = SERVICES.filter(
      (s) =>
        JSON.parse(u.services).includes(s) &&
        (!u.key_services || JSON.parse(u.key_services).includes(s)),
    );
    if (!permitted.length) throw new Denied(403, "没有模型服务权限");
    return { ...u, permitted };
  }
  async acquire(raw, service, path, metadata = {}) {
    if (!SERVICES.includes(service) && service !== "catalog")
      throw new Denied(400, "未知服务");
    let u,
      key = null,
      auth = "api_key";
    if (raw.startsWith("ai-at-")) {
      u = await this.access(raw);
      auth = "access_token";
    } else {
      const row = await this.first(
        "SELECT u.*,k.id AS auth_key_id,k.services AS auth_key_services FROM keys k JOIN users u ON u.id=k.user_id WHERE k.hash=? AND k.revoked=0 AND k.expires>?",
        await digest(raw),
        now(),
      );
      if (!row) throw new Denied(401, "API Key 无效或已过期");
      u = row;
      key = {
        id: row.auth_key_id,
        user_id: row.id,
        services: row.auth_key_services,
      };
    }
    if (service === "catalog") {
      if (path !== "/v1/models") throw new Denied(400, "目录凭证路径无效");
      service =
        ["qwen", "asr", "tts"].find(
          (s) =>
            u &&
            JSON.parse(u.services).includes(s) &&
            (!key || JSON.parse(key.services).includes(s)),
        ) ?? "";
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
      "INSERT INTO requests(id,user_id,key_id,service,path,started,day,auth_type,client_ip,user_agent,client_version,device_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE " +
        check,
      id,
      u.id,
      key?.id ?? null,
      service,
      path,
      ts,
      day(),
      auth,
      metadata.client_ip ?? null,
      metadata.user_agent ?? null,
      metadata.client_version ?? null,
      metadata.device_id ?? null,
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
    const fields = [
      "model",
      "provider",
      "protocol",
      "failure_stage",
      "error_code",
      "upstream_error_code",
      "upstream_error_param",
      "upstream_request_id",
      "compatibility",
      "ingress_colo",
      "client_country",
      "ingress_ray",
      "upstream_cf_ray",
      "release_sha",
    ];
    const extra = fields.map((k) =>
      typeof t[k] === "string" && /^[a-zA-Z0-9_.:,/\[\]-]{1,256}$/.test(t[k])
        ? t[k]
        : null,
    );
    const numeric = (k) =>
      Number.isSafeInteger(t[k]) && t[k] >= 0 ? t[k] : null;
    await this.run(
      "UPDATE requests SET model=?,provider=?,protocol=?,failure_stage=?,error_code=?,upstream_error_code=?,upstream_error_param=?,upstream_request_id=?,compatibility=?,ingress_colo=?,client_country=?,ingress_ray=?,upstream_cf_ray=?,release_sha=?,upstream_attempted=?,upstream_status=?,duration_ms=?,first_byte_ms=?,ended=?,status=?,response_bytes=?,prompt_tokens=?,completion_tokens=?,request_id=?,client_request_id=?,helix_turn_id=?,helix_model_call_id=?,upstream_response_id=? WHERE id=? AND ended IS NULL",
      ...extra,
      t.upstream_attempted === 1 ? 1 : 0,
      numeric("upstream_status"),
      numeric("duration_ms"),
      numeric("first_byte_ms"),
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
    const filter = uid ? " AND user_id=?" : "",
      today = day();
    const rows = await this.db.batch([
      this.stmt(
        "SELECT service,count(*) requests,coalesce(sum(response_bytes),0) response_bytes FROM requests WHERE day=?" +
          filter +
          " GROUP BY service",
        today,
        ...(uid ? [uid] : []),
      ),
      this.stmt(
        "SELECT * FROM requests" +
          (uid ? " WHERE user_id=?" : "") +
          " ORDER BY started DESC LIMIT 100",
        ...(uid ? [uid] : []),
      ),
    ]);
    return { today, totals: rows[0].results, requests: rows[1].results };
  }
}
