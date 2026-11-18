import { verifyCaptcha } from "./captcha.mjs";
import { Denied, publicUser } from "./store.mjs";
import { now } from "./crypto.mjs";
import {
  registrationEmail,
  requestRegistrationCode,
  verifyRegistrationCode,
} from "./registration.mjs";
const fail = (status, message, code) => {
  const e = new Denied(status, message);
  e.code = code;
  throw e;
};
export async function bindAccountEmail(store, env, user, rawEmail, code) {
  if (user.must_change)
    fail(403, "请先修改初始密码", "password_change_required");
  if (user.email_verified_at)
    fail(409, "邮箱已验证绑定", "email_already_verified");
  const email = registrationEmail(rawEmail);
  if (
    await store.first(
      "SELECT id FROM users WHERE id<>? AND email=? COLLATE NOCASE",
      user.id,
      email,
    )
  )
    fail(409, "该邮箱已被其他账号占用", "email_in_use");
  const proof = await verifyRegistrationCode(store, env, email, code, user),
    ts = now();
  let results;
  try {
    results = await store.db.batch([
      store.stmt(
        "UPDATE users SET email=?,email_verified_at=? WHERE id=? AND enabled=1 AND must_change=0 AND email_verified_at IS NULL AND NOT EXISTS(SELECT 1 FROM users other WHERE other.id<>? AND lower(other.email)=?) AND EXISTS(SELECT 1 FROM account_email_codes c WHERE c.user_id=users.id AND c.email_hash=? AND c.id=? AND c.code_hash=? AND c.state='sent' AND c.expires>? AND c.attempts<=5)",
        email,
        ts,
        user.id,
        user.id,
        email,
        proof.emailHash,
        proof.id,
        proof.hash,
        ts,
      ),
      store.stmt(
        "UPDATE account_email_codes SET state='consumed',code_hash='' WHERE user_id=? AND id=? AND changes()=1",
        user.id,
        proof.id,
      ),
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) SELECT ?,?,?,? WHERE changes()=1",
        user.id,
        "bind_email",
        String(user.id),
        ts,
      ),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      fail(409, "该邮箱已被其他账号占用", "email_in_use");
    throw e;
  }
  if (!results[0].meta.changes)
    fail(409, "账号或验证码状态已变更，请刷新后重试", "email_binding_changed");
  return {
    user: publicUser(
      await store.first("SELECT * FROM users WHERE id=?", user.id),
    ),
    message: "邮箱已验证并绑定，可用于登录和找回密码",
  };
}
export async function accountEmailRoute(request, store, env, user, body, send) {
  const path = new URL(request.url).pathname;
  if (!["/account/email/code", "/account/email/bind"].includes(path))
    return null;
  if (request.method !== "POST") throw new Denied(405, "仅支持 POST");
  const b = await body(request),
    fields = path.endsWith("/code")
      ? ["email", "captcha_token"]
      : ["email", "code"];
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    Object.keys(b).some((k) => !fields.includes(k))
  )
    throw new Denied(422, "无效邮箱绑定字段");
  if (path.endsWith("/code"))
    await verifyCaptcha(
      request,
      env,
      store,
      b.captcha_token,
      "email_binding_code",
    );
  const value = path.endsWith("/code")
    ? await requestRegistrationCode(
        store,
        env,
        b.email,
        request.headers.get("CF-Connecting-IP") || "local",
        send,
        user,
      )
    : await bindAccountEmail(store, env, user, b.email, b.code);
  return Response.json(value, { headers: { "Cache-Control": "no-store" } });
}
