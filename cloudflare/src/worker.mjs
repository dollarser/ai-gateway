import { CLOUD_TEXT_MODELS } from "./cloud-text-models.mjs";
import {
  enabledModels,
  filterUserModels,
  requirePublicModel,
  validateModelAllowlist,
} from "./model-access.mjs";
import { usageSnapshot } from "./usage-snapshot.mjs";
import { changePasswordWithCredentials } from "./credential-password.mjs";
import { captchaInfo, verifyCaptcha } from "./captcha.mjs";
import { requestPasswordReset, resetPassword } from "./password-reset.mjs";
import { openaiRoute } from "./openai-route.mjs";
import {
  writeWorkerLog,
  accountPath,
  logInferenceFailure,
  failureCategory,
} from "./worker-logs.mjs";
import { requestEmailChange, confirmEmailChange } from "./email-change.mjs";
import { accountEmailRoute } from "./email-binding.mjs";
import {
  verificationEnabled,
  registrationEmail,
  requestRegistrationCode,
  verifyRegistrationCode,
} from "./registration.mjs";
import { mailConfiguration } from "./smtp-core.mjs";
import { sendRegistrationEmail } from "./mail.mjs";
import { noticesRoute } from "./notices.mjs";
import { enqueueAlerts, deliverNotifications } from "./notifications.mjs";
import { monitor, maintenance } from "./operations.mjs";
import {
  Store,
  Denied,
  SERVICES,
  publicUser,
  day,
  normalizeDisplayName,
} from "./store.mjs";
import { digest, equal, now, token, passwordHash } from "./crypto.mjs";
import { budgetValue, lunaUsage, lunaCatalog, proxyLuna } from "./luna.mjs";
import {
  AUDIO_FIELDS,
  ASR_MODEL,
  TTS_MODEL,
  audioQuotas,
  audioUsage,
  audioModels,
  proxyTranscription,
  proxySpeech,
} from "./audio.mjs";
import { adminRoute } from "./admin.mjs";
import { edgeAPI } from "./edge.mjs";
const COOKIE = "__Host-ai_session";
const json = (v, status = 200, headers = {}) =>
  Response.json(v, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
function fail(status, message) {
  throw new Denied(status, message);
}
function validate(body, fields) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !fields.includes(k))
  )
    fail(422, "无效字段");
  return body;
}
function text(value, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max)
    fail(422, "字符串字段长度无效");
  return value;
}
function services(value) {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    value.some((x) => !SERVICES.includes(x))
  )
    fail(422, "服务权限无效");
  return value;
}
function quotas(b, defaults = false) {
  for (const k of ["rpm", "daily_requests", "concurrency"])
    if (
      b[k] !== undefined &&
      (!Number.isSafeInteger(b[k]) ||
        b[k] < (k === "concurrency" || defaults ? 1 : 0) ||
        b[k] >
          (k === "concurrency"
            ? 8
            : defaults
              ? k === "rpm"
                ? 600
                : 1000000
              : 1000000000))
    )
      fail(422, "额度字段无效");
  return b;
}
async function body(request, limit = 16384) {
  if (Number(request.headers.get("Content-Length") || 0) > limit)
    fail(413, "请求体过大");
  const reader = request.body?.getReader();
  let n = 0;
  const chunks = [];
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > limit) {
        await reader.cancel();
        fail(413, "请求体过大");
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  try {
    return n ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    fail(400, "无效 JSON");
  }
}
function bearer(request) {
  const auth = request.headers.get("Authorization") || "";
  return /^Bearer /i.test(auth) ? auth.slice(7).trim() : "";
}
async function userSession(request, store, admin = false) {
  const raw = bearer(request);
  let u;
  if (raw) {
    if (!raw.startsWith("ai-at-")) fail(401, "账号管理需要登录 access_token");
    u = await store.access(raw);
  } else {
    const cookie =
      (request.headers.get("Cookie") || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(COOKIE + "="))
        ?.slice(COOKIE.length + 1) || "";
    if (!cookie) fail(401, "请先登录");
    u = await store.session(cookie);
    if (
      !["GET", "HEAD"].includes(request.method) &&
      !equal(request.headers.get("X-CSRF-Token") || "", u.csrf)
    )
      fail(403, "CSRF 校验失败");
  }
  if (admin && (u.role !== "admin" || u.must_change))
    fail(403, "需要管理员权限；首次登录请先修改密码");
  return u;
}
async function internal(request, env, store, path, ctx) {
  if (
    request.method !== "POST" ||
    !env.INTERNAL_SECRET ||
    !equal(bearer(request), env.INTERNAL_SECRET)
  )
    fail(401, "内部服务认证失败");
  if (
    [
      "/internal/openai/chat-completions",
      "/internal/openai/responses",
    ].includes(path)
  ) {
    const responses = path.endsWith("/responses");
    const payload = await body(request, 4 * 1024 * 1024);
    if (CLOUD_TEXT_MODELS.has(payload?.model))
      await requirePublicModel(
        store,
        payload.model,
        responses ? "/v1/responses" : "/v1/chat/completions",
        request.headers.get("X-Gateway-Lease"),
      );
    return proxyLuna(
      request,
      env,
      store,
      ctx,
      payload,
      responses,
      openaiRoute(
        env,
        request.headers.get("X-Gateway-Lease"),
        request.headers.get("X-Request-ID") ??
          request.headers.get("X-Gateway-Lease"),
      ),
    );
  }
  if (path === "/internal/openai/transcriptions") {
    await requirePublicModel(
      store,
      ASR_MODEL,
      "/v1/audio/transcriptions",
      request.headers.get("X-Gateway-Lease"),
    );
    return proxyTranscription(
      request,
      env,
      store,
      ctx,
      null,
      null,
      openaiRoute(
        env,
        request.headers.get("X-Gateway-Lease"),
        request.headers.get("X-Gateway-Lease"),
      ),
    );
  }
  if (path === "/internal/openai/speech") {
    await requirePublicModel(
      store,
      TTS_MODEL,
      "/v1/audio/speech",
      request.headers.get("X-Gateway-Lease"),
    );
    return proxySpeech(
      request,
      env,
      store,
      openaiRoute(
        env,
        request.headers.get("X-Gateway-Lease"),
        request.headers.get("X-Gateway-Lease"),
      ),
      ctx,
    );
  }
  const b = await body(request);
  if (path === "/internal/openai-models") {
    validate(b, ["lease"]);
    text(b.lease, 1, 128);
    const r = await store.first(
      "SELECT r.*,u.services,u.enabled,u.must_change,u.allowed_model_ids,k.services key_services,k.revoked,k.expires FROM requests r JOIN users u ON u.id=r.user_id LEFT JOIN keys k ON k.id=r.key_id WHERE r.id=? AND r.ended IS NULL AND r.path='/v1/models' AND r.started>unixepoch()-900",
      b.lease,
    );
    if (
      !r ||
      !r.enabled ||
      r.must_change ||
      (r.key_id && (r.revoked || r.expires <= now()))
    )
      fail(403, "目录请求凭证已失效");
    const permissions = SERVICES.filter(
      (s) =>
        JSON.parse(r.services).includes(s) &&
        (!r.key_services || JSON.parse(r.key_services).includes(s)),
    );
    const luna = permissions.includes("qwen")
      ? await lunaCatalog(store, env, b.lease)
      : { data: [] };
    const enabled = filterUserModels(
      await enabledModels(store),
      r.allowed_model_ids,
    );
    return json({
      data: [...luna.data, ...(await audioModels(store, env, b.lease))].filter(
        (model) => enabled.has(model.id),
      ),
      services: permissions,
    });
  }
  if (path === "/internal/luna-models") {
    validate(b, ["lease"]);
    const lease = text(b.lease, 1, 128);
    const catalog = await lunaCatalog(store, env, lease);
    const owner = await store.first(
      "SELECT u.allowed_model_ids FROM requests r JOIN users u ON u.id=r.user_id WHERE r.id=?",
      lease,
    );
    const enabled = filterUserModels(
      await enabledModels(store),
      owner.allowed_model_ids,
    );
    return json({
      data: catalog.data.filter((model) => enabled.has(model.id)),
    });
  }
  if (path === "/internal/acquire") {
    validate(b, ["raw", "service", "path", "metadata"]);
    if (b.metadata !== undefined) {
      validate(b.metadata, [
        "client_ip",
        "user_agent",
        "client_version",
        "device_id",
      ]);
      for (const [k, v] of Object.entries(b.metadata))
        if (v !== null) text(v, 0, k === "user_agent" ? 512 : 128);
    }
    text(b.raw, 1, 256);
    text(b.path, 1, 256);
    return json({
      lease: await store.acquire(b.raw, b.service, b.path, b.metadata ?? {}),
    });
  }
  if (path === "/internal/token-remaining") {
    validate(b, ["lease"]);
    return json({ remaining: await store.remaining(text(b.lease, 1, 128)) });
  }
  if (path === "/internal/finish") {
    validate(b, [
      "lease",
      "status",
      "size",
      "prompt_tokens",
      "completion_tokens",
      "trace",
    ]);
    text(b.lease, 1, 128);
    for (const key of ["status", "size", "prompt_tokens", "completion_tokens"])
      if (b[key] !== undefined && (!Number.isSafeInteger(b[key]) || b[key] < 0))
        fail(422, "用量字段无效");
    if (!Number.isInteger(b.status) || b.status < 100 || b.status > 599)
      fail(422, "状态码无效");
    await store.finish(b);
    return json({ ok: true });
  }
  if (path === "/internal/check-auth") {
    validate(b, ["ip"]);
    await store.authCheck(text(b.ip, 1, 128));
    return json({ ok: true });
  }
  if (path === "/internal/record-auth-failure") {
    validate(b, ["ip"]);
    await store.run(
      "INSERT INTO inference_auth_failures(ip_hash,ts) VALUES(?,?)",
      await digest(text(b.ip, 1, 128)),
      now(),
    );
    return json({ ok: true });
  }
  fail(404, "未知内部接口");
}
async function route(request, env, ctx) {
  const url = new URL(request.url),
    p = url.pathname,
    method = request.method;
  const store = new Store(env.DB);
  if (url.hostname === (env.API_HOST ?? "api.hilex.me"))
    return edgeAPI(request, env, ctx);
  if (p.startsWith("/internal/")) return internal(request, env, store, p, ctx);
  if (p === "/healthz" && method === "GET") {
    await store.first("SELECT 1");
    return json({
      release: env.RELEASE_SHA ?? null,
      ready: true,
      service: "accounts",
      storage: "d1",
    });
  }
  const origin = env.ACCOUNT_ORIGIN || url.origin;
  // A configured custom domain owns the portal. Local Wrangler is also allowed for testing.
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.origin !== origin
  )
    fail(404, "未知账号域名");
  if (
    !["GET", "HEAD"].includes(method) &&
    request.headers.get("Origin") &&
    request.headers.get("Origin") !== origin
  )
    fail(403, "origin denied");
  // HTML is protected here as well as every management API. Assets must not
  // serve /admin independently, including its directory/index aliases.
  const adminPage =
    ["/admin", "/admin/", "/admin/index.html"].includes(p) ||
    /^\/admin\/users\/[1-9]\d*$/.test(p);
  if (adminPage && ["GET", "HEAD"].includes(method)) {
    try {
      await userSession(request, store, true);
    } catch (error) {
      if (error.status !== 401) throw error;
      return new Response(null, {
        status: 302,
        headers: {
          Location: p.startsWith("/admin/users/")
            ? "/?next=" + encodeURIComponent(p)
            : "/?next=admin",
          "Cache-Control": "no-store",
        },
      });
    }
  }
  if (
    (method === "GET" || (adminPage && method === "HEAD")) &&
    (adminPage ||
      p === "/" ||
      p === "/static/app.js" ||
      p === "/static/portal-common.js" ||
      p === "/static/admin-portal.js" ||
      p === "/static/notice-manager.js" ||
      p === "/static/password-reset.js" ||
      p === "/static/captcha.js" ||
      p === "/static/email-verification.js" ||
      p === "/static/email-change.js" ||
      p === "/static/captcha-page.js" ||
      p === "/auth/captcha" ||
      p === "/static/style.css" ||
      p === "/static/admin.js" ||
      p === "/static/notices.js")
  ) {
    const asset = new URL(request.url);
    asset.pathname = adminPage
      ? "/admin/"
      : p === "/auth/captcha"
        ? "/captcha"
        : p;
    const assetRequest = new Request(asset, request);
    if (p === "/" || adminPage) {
      assetRequest.headers.delete("If-None-Match");
      assetRequest.headers.delete("If-Modified-Since");
    }
    const response = await env.ASSETS.fetch(assetRequest);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return new Response(response.body, { status: response.status, headers });
  }
  if (p === "/auth/captcha-info" && method === "GET")
    return json(captchaInfo(env));
  if (p === "/auth/registration-info" && method === "GET")
    return json({
      services: SERVICES,
      today: day(),
      defaults: await store.defaults(),
      email_verification: verificationEnabled(env),
      email_verification_available: !!mailConfiguration(env),
      registration_enabled: JSON.parse(
        (
          await store.first(
            "SELECT value FROM settings WHERE name='registration_policy'",
          )
        ).value,
      ).enabled,
    });
  if (p === "/auth/registration-code" && method === "POST") {
    const b = validate(await body(request), ["email", "captcha_token"]);
    await verifyCaptcha(
      request,
      env,
      store,
      b.captcha_token,
      "registration_code",
    );
    return json(
      await requestRegistrationCode(
        store,
        env,
        b.email,
        request.headers.get("CF-Connecting-IP") || "local",
        sendRegistrationEmail,
      ),
    );
  }
  if (p === "/auth/register" && method === "POST") {
    const b = validate(await body(request), [
      "email",
      "password",
      "code",
      "display_name",
    ]);
    text(b.email, 3, 254);
    text(b.password, 6, 128);
    const email = registrationEmail(b.email);
    const display_name =
      b.display_name === undefined || b.display_name === ""
        ? "用户"
        : normalizeDisplayName(b.display_name);
    const emailVerification = verificationEnabled(env)
      ? await verifyRegistrationCode(store, env, email, b.code)
      : null;
    await store.rateLimit(
      request.headers.get("CF-Connecting-IP") || "local",
      "register",
      email,
    );
    const user = await store.createUser(display_name, b.password, {
      email,
      emailVerification,
      must_change: 0,
      ...(await store.defaults()),
    });
    return json({ user, message: "注册成功，请使用邮箱和密码登录" }, 201);
  }
  if (p === "/auth/password-reset/code" && method === "POST") {
    const b = validate(await body(request), ["email", "captcha_token"]);
    await verifyCaptcha(
      request,
      env,
      store,
      b.captcha_token,
      "password_reset_code",
    );
    return json(
      await requestPasswordReset(
        store,
        env,
        b.email,
        request.headers.get("CF-Connecting-IP") || "local",
        sendRegistrationEmail,
        ctx,
      ),
    );
  }
  if (p === "/auth/password-reset" && method === "POST") {
    const b = validate(await body(request), [
      "email",
      "code",
      "new_password",
      "revoke_api_keys",
    ]);
    return json(
      await resetPassword(store, env, b, sendRegistrationEmail, ctx),
      200,
      {
        "Set-Cookie": `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      },
    );
  }
  if (p === "/auth/password" && method === "POST") {
    const result = await changePasswordWithCredentials(
      store,
      await body(request),
      request.headers.get("CF-Connecting-IP") || "local",
    );
    return json(result, 200, {
      "Set-Cookie": `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }
  if (p === "/auth/login" && method === "POST") {
    const b = validate(await body(request), ["email", "password"]);
    const email = registrationEmail(b.email);
    text(b.password, 1, 128);
    const r = await store.login(
      email,
      b.password,
      request.headers.get("CF-Connecting-IP") || "local",
    );
    return json(r.body, 200, {
      "Set-Cookie": `${COOKIE}=${r.cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    });
  }
  if (p === "/auth/refresh" && method === "POST") {
    const b = validate(await body(request), ["refresh_token"]);
    return json(await store.refresh(text(b.refresh_token, 20, 256)));
  }
  if (p === "/auth/logout" && method === "POST") {
    const b = validate(await body(request), ["refresh_token"]);
    if (b.refresh_token) {
      const r = await store.first(
        "SELECT family_id FROM refresh_tokens WHERE hash=?",
        await digest(text(b.refresh_token, 20, 256)),
      );
      if (r) await store.revokeFamily(r.family_id);
    } else {
      const u = await userSession(request, store);
      if (u.family) await store.revokeFamily(u.family);
    }
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }
  const u = await userSession(
    request,
    store,
    p.startsWith("/admin/") || p.startsWith("/account/keys"),
  );
  if (p === "/account/email/change/code" && method === "POST") {
    const b = validate(await body(request), [
      "email",
      "current_password",
      "captcha_token",
    ]);
    await verifyCaptcha(
      request,
      env,
      store,
      b.captcha_token,
      "email_change_code",
    );
    return json(
      await requestEmailChange(
        store,
        env,
        u,
        b,
        request.headers.get("CF-Connecting-IP") || "local",
        sendRegistrationEmail,
      ),
    );
  }
  if (p === "/account/email/change" && method === "POST") {
    const b = validate(await body(request), ["email", "code"]);
    return json(
      await confirmEmailChange(store, env, u, b, sendRegistrationEmail, ctx),
      200,
      {
        "Set-Cookie": `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      },
    );
  }
  if (p.startsWith("/account/email/")) {
    const response = await accountEmailRoute(
      request,
      store,
      env,
      u,
      body,
      sendRegistrationEmail,
    );
    if (response) return response;
  }
  if (p.startsWith("/account/notices") || p.startsWith("/admin/notices")) {
    const response = await noticesRoute(request, store, u, (r) =>
      body(r, 65536),
    );
    if (response) return response;
  }
  if (p.startsWith("/admin/")) {
    const response = await adminRoute(request, store, u, body, env);
    if (response) return response;
  }
  if (p === "/account/audio-usage" && method === "GET")
    return json(await audioUsage(store, u.id));
  if (p === "/account/me" && method === "GET")
    return json({ user: publicUser(u), csrf: bearer(request) ? null : u.csrf });
  if (p === "/account/profile" && method === "PATCH") {
    const b = validate(await body(request), ["display_name"]);
    const updated = await store.changeDisplayName(u.id, b.display_name);
    return json({
      user: updated,
      message: "显示名已更新，登录邮箱和账号 ID 不变",
    });
  }
  if (p === "/account/password" && method === "POST") {
    const b = validate(await body(request), [
      "current_password",
      "new_password",
    ]);
    await store.changePassword(
      u.id,
      text(b.current_password, 1, 128),
      text(b.new_password, 6, 128),
    );
    return json({ ok: true, message: "密码已修改，请重新登录" });
  }
  if (p === "/account/luna-usage" && method === "GET")
    return json(await lunaUsage(store, u.id));
  if (p === "/admin/luna-defaults") {
    if (method === "GET")
      return json(
        JSON.parse(
          (
            await store.first(
              "SELECT value FROM settings WHERE name='luna_defaults'",
            )
          ).value,
        ),
      );
    if (method === "PATCH") {
      const b = validate(await body(request), ["monthly_tokens"]);
      budgetValue(b.monthly_tokens);
      await store.db.batch([
        store.stmt(
          "UPDATE settings SET value=? WHERE name='luna_defaults'",
          JSON.stringify(b),
        ),
        store.stmt(
          "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
          u.id,
          "update_luna_defaults",
          JSON.stringify(b),
          now(),
        ),
      ]);
      return json(b);
    }
  }
  if (p === "/account/usage-snapshot" && method === "GET")
    return json(await usageSnapshot(store, u));
  if (p === "/account/usage" && method === "GET")
    return json(await store.usage(u.id));
  if (p === "/admin/usage" && method === "GET") {
    const uid = url.searchParams.get("user_id");
    if (uid !== null && !/^[1-9]\d*$/.test(uid)) fail(422, "用户 ID 无效");
    const usage = await store.usage(uid ? Number(uid) : null);
    if (uid) {
      const target = await store.first(
        "SELECT id FROM users WHERE id=?",
        Number(uid),
      );
      if (!target) fail(404, "账号不存在");
      usage.luna = await lunaUsage(store, Number(uid));
      usage.audio = await audioUsage(store, Number(uid));
    }
    return json(usage);
  }
  if (p === "/admin/audit" && method === "GET")
    return json(
      await store.all("SELECT * FROM audit ORDER BY id DESC LIMIT 100"),
    );
  if (p === "/admin/registration-defaults") {
    if (method === "GET") return json(await store.defaults());
    if (method === "PATCH") {
      const b = quotas(
        validate(await body(request), ["rpm", "daily_requests", "concurrency"]),
        true,
      );
      if (Object.keys(b).length !== 3) fail(422, "默认额度字段不完整");
      await store.run(
        "UPDATE settings SET value=? WHERE name='registration_defaults'",
        JSON.stringify(b),
      );
      await store.audit(
        u.id,
        "update_registration_defaults",
        "registration_defaults",
      );
      return json(b);
    }
  }
  if (p === "/admin/users" && method === "GET")
    return json(
      (await store.all("SELECT * FROM users ORDER BY id")).map(publicUser),
    );
  if (p === "/admin/users" && method === "POST") {
    const b = quotas(
      validate(await body(request), [
        "display_name",
        "email",
        "luna_monthly_tokens",
        ...AUDIO_FIELDS,
        "services",
        "rpm",
        "daily_requests",
        "concurrency",
      ]),
    );
    b.display_name = normalizeDisplayName(b.display_name ?? "用户");
    if (b.email !== undefined) b.email = registrationEmail(b.email);
    if (b.services !== undefined) {
      services(b.services);
      if (!b.services.length) fail(422, "至少一个服务");
    }
    audioQuotas(b);
    if (b.luna_monthly_tokens !== undefined) budgetValue(b.luna_monthly_tokens);
    const temporary_password = token();
    const user = await store.createUser(b.display_name, temporary_password, {
      ...b,
      actor: u.id,
    });
    return json({ user, temporary_password, message: "首次登录必须修改密码" });
  }
  const missingEmail = p.match(/^\/admin\/users\/(\d+)\/login-email$/);
  if (missingEmail && method === "PUT") {
    const b = validate(await body(request), ["email"]),
      uid = Number(missingEmail[1]);
    const email = registrationEmail(b.email);
    let results;
    try {
      results = await store.db.batch([
        store.stmt(
          "UPDATE users SET email=?,email_verified_at=NULL WHERE id=? AND email IS NULL",
          email,
          uid,
        ),
        store.stmt(
          "INSERT INTO audit(actor,action,target,ts) SELECT ?,'set_login_email',?,? WHERE changes()=1",
          u.id,
          String(uid),
          now(),
        ),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        const e = new Denied(409, "邮箱已被使用");
        e.code = "email_in_use";
        throw e;
      }
      throw error;
    }
    if (!results[0].meta.changes)
      fail(409, "账号不存在或已经设置邮箱，不能覆盖已有邮箱");
    return json({
      user: publicUser(
        await store.first("SELECT * FROM users WHERE id=?", uid),
      ),
      message: "登录邮箱已设置，账号本人仍需完成邮箱验证码验证",
    });
  }
  const match = p.match(/^\/admin\/users\/(\d+)(\/reset-password)?$/);
  if (match) {
    const uid = Number(match[1]),
      target = await store.first("SELECT * FROM users WHERE id=?", uid);
    if (!target) fail(404, "账号不存在");
    if (match[2] && method === "POST") {
      if (uid === u.id) fail(400, "请使用修改密码功能");
      const temporary_password = token();
      const encoded = await passwordHash(temporary_password);
      await store.db.batch([
        store.stmt(
          "UPDATE users SET password=?,must_change=1 WHERE id=?",
          encoded,
          uid,
        ),
        store.stmt("DELETE FROM sessions WHERE user_id=?", uid),
        store.stmt("UPDATE auth_families SET revoked=1 WHERE user_id=?", uid),
        store.stmt("UPDATE keys SET revoked=1 WHERE user_id=?", uid),
      ]);
      await store.audit(u.id, "reset_password", uid);
      return json({
        temporary_password,
        message: "登录会话和所有 API Key 已撤销",
      });
    }
    if (!match[2] && method === "PATCH") {
      const b = quotas(
        validate(await body(request), [
          "enabled",
          "allowed_model_ids",
          "luna_monthly_tokens",
          ...AUDIO_FIELDS,
          "services",
          "rpm",
          "daily_requests",
          "concurrency",
        ]),
      );
      audioQuotas(b);
      if ("allowed_model_ids" in b) validateModelAllowlist(b.allowed_model_ids);
      if (b.services !== undefined) services(b.services);
      if (b.enabled !== undefined && typeof b.enabled !== "boolean")
        fail(422, "enabled 必须为布尔值");
      if (b.luna_monthly_tokens !== undefined) {
        b.luna_monthly_tokens = budgetValue(b.luna_monthly_tokens);
      }
      const keys = Object.keys(b);
      if (!keys.length) fail(422, "没有更新字段");
      const values = keys.map((k) =>
        k === "services"
          ? JSON.stringify(b[k])
          : k === "allowed_model_ids"
            ? b[k] === null
              ? null
              : JSON.stringify(b[k])
            : k === "enabled"
              ? Number(b[k])
              : b[k],
      );
      const statements = [
        store.stmt(
          `UPDATE users SET ${keys.map((k) => k + "=?").join(",")} WHERE id=?`,
          ...values,
          uid,
        ),
      ];
      if (b.enabled === false)
        statements.push(
          store.stmt("DELETE FROM sessions WHERE user_id=?", uid),
          store.stmt("UPDATE auth_families SET revoked=1 WHERE user_id=?", uid),
        );
      if ("allowed_model_ids" in b)
        statements.push(
          store.stmt(
            "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
            u.id,
            "update_user_model_allowlist",
            JSON.stringify({
              user_id: uid,
              allowed_model_ids: b.allowed_model_ids,
            }),
            now(),
          ),
        );
      await store.db.batch(statements);
      await store.audit(
        u.id,
        "update_user",
        String(uid) +
          (b.luna_monthly_tokens !== undefined
            ? ":luna_monthly_tokens=" + b.luna_monthly_tokens
            : ""),
      );
      return json(
        publicUser(await store.first("SELECT * FROM users WHERE id=?", uid)),
      );
    }
  }
  const km = p.match(/^\/(account|admin)\/keys(?:\/(\d+))?$/);
  if (km) {
    const target = km[1] === "account" ? u.id : Number(km[2]);
    if (method === "GET" && target) return json(await store.keys(target));
    if (method === "POST" && target) {
      const b = validate(await body(request), ["name", "services", "days"]);
      text(b.name, 1, 80);
      services(b.services);
      if (!b.services.length) fail(422, "至少一个服务");
      if (b.days === undefined) b.days = 90;
      if (!Number.isInteger(b.days) || b.days < 1 || b.days > 365)
        fail(422, "有效期无效");
      return json(await store.createKey(u.id, target, b));
    }
    if (method === "DELETE" && km[2]) {
      const r = await store.run(
        "UPDATE keys SET revoked=1 WHERE id=?",
        Number(km[2]),
      );
      if (!r.meta.changes) fail(404, "密钥不存在");
      await store.audit(u.id, "revoke_key", km[2]);
      return json({ ok: true });
    }
  }
  fail(404, "接口不存在");
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // Planned schema cutovers block new public work, while existing signed
    // internal settlements may complete and preserve usage accounting.
    if (env.ACCOUNT_MAINTENANCE === "true" && !path.startsWith("/internal/"))
      return json(
        {
          detail: "账号结构升级中，请稍后重试",
          error_code: "maintenance",
          retryable: true,
          ready: false,
          release: env.RELEASE_SHA ?? null,
        },
        503,
        { "Retry-After": "60" },
      );
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof Denied) {
        const providerRequestId = Number.isInteger(e.upstream_status)
          ? token()
          : null;
        if (providerRequestId)
          logInferenceFailure(
            {
              request_id: providerRequestId,
              path: accountPath(new URL(request.url).pathname),
              provider: "openai",
              failure_stage: "upstream_rejected",
              error_code: e.code,
              release_sha: env.RELEASE_SHA,
            },
            e,
            e.status,
          );
        return json(
          {
            detail: e.message,
            error_code: e.code ?? "request_rejected",
            retryable: e.retryable === true,
            ...(providerRequestId ? { request_id: providerRequestId } : {}),
          },
          e.status,
          {
            ...(providerRequestId ? { "X-Request-ID": providerRequestId } : {}),
            ...(e.status === 429 && e.retryable !== false
              ? { "Retry-After": String(e.retry_after ?? 60) }
              : {}),
            "X-Error-Code":
              e.code ??
              (e.status < 500 ? "request_rejected" : "provider_unavailable"),
            ...(e.upstream_status
              ? { "X-Upstream-Status": String(e.upstream_status) }
              : {}),
          },
        );
      }
      const message = String(e);
      if (/quota_/.test(message))
        return json({ detail: "账号请求或并发额度已用尽" }, 429, {
          "Retry-After": "60",
        });
      if (/account_permission|key_permission/.test(message))
        return json({ detail: "账号或密钥权限无效" }, 403);
      if (/last_admin/.test(message))
        return json({ detail: "不能禁用最后一个管理员" }, 409);
      const requestId = token();
      writeWorkerLog("account_internal_failure", {
        request_id: requestId,
        path: accountPath(new URL(request.url).pathname),
        error_type: ["TypeError", "Error", "SyntaxError"].includes(e.name)
          ? e.name
          : "Error",
        status: 503,
        failure_category: failureCategory(e),
        release_sha: env.RELEASE_SHA,
      });
      return json(
        { detail: "账号服务暂时不可用", request_id: requestId },
        503,
        { "X-Request-ID": requestId },
      );
    }
  },
  async scheduled(event, env, ctx) {
    if (env.ACCOUNT_MAINTENANCE === "true") return;
    const store = new Store(env.DB);
    ctx.waitUntil(
      (async () => {
        await env.DB.batch([
          store.stmt(
            "UPDATE requests SET ended=?,status=504 WHERE ended IS NULL AND started<?",
            now(),
            now() - 920,
          ),
          store.stmt(
            "DELETE FROM registration_codes WHERE email_hash IN (SELECT email_hash FROM registration_codes WHERE expires<? OR state IN ('consumed','failed') LIMIT 500)",
            now(),
          ),
          store.stmt(
            "DELETE FROM email_send_attempts WHERE id IN (SELECT id FROM email_send_attempts WHERE ts<? LIMIT 1000)",
            now() - 3600,
          ),
          store.stmt(
            "DELETE FROM account_email_codes WHERE user_id IN(SELECT user_id FROM account_email_codes WHERE expires<? OR state IN ('consumed','failed') LIMIT 500)",
            now(),
          ),
          store.stmt(
            "DELETE FROM email_change_challenges WHERE user_id IN (SELECT user_id FROM email_change_challenges WHERE expires<? OR state IN ('consumed','failed') LIMIT 500)",
            now(),
          ),
          store.stmt(
            "DELETE FROM password_reset_codes WHERE user_id IN (SELECT user_id FROM password_reset_codes WHERE expires<? OR state IN ('consumed','failed') LIMIT 500)",
            now(),
          ),
          store.stmt(
            "DELETE FROM captcha_redemptions WHERE token_hash IN (SELECT token_hash FROM captcha_redemptions WHERE created<? LIMIT 1000)",
            now() - 600,
          ),
          store.stmt(
            "DELETE FROM captcha_attempts WHERE bucket<?",
            Math.floor(now() / 60) - 2,
          ),
          store.stmt("DELETE FROM login_attempts WHERE ts<?", now() - 300),
          store.stmt(
            "DELETE FROM registration_attempts WHERE ts<?",
            now() - 3600,
          ),
          store.stmt(
            "DELETE FROM inference_auth_failures WHERE ts<?",
            now() - 60,
          ),
        ]);
        await monitor(store);
        await enqueueAlerts(store, env);
        await deliverNotifications(store, env);
        await maintenance(store);
      })(),
    );
  },
};
