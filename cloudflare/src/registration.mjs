import { writeWorkerLog } from "./worker-logs.mjs";
import { digest, hex, now, token, equal } from "./crypto.mjs";
import { Denied } from "./store.mjs";
import { mailConfiguration } from "./smtp-core.mjs";
const failure = (status, message, code) => {
  const e = new Denied(status, message);
  e.code = code;
  throw e;
};
export const verificationEnabled = (env) =>
  env.EMAIL_VERIFICATION_ENABLED !== "false";
export function registrationEmail(value) {
  if (typeof value !== "string" || value.length > 254)
    failure(422, "邮箱格式无效", "invalid_email");
  const email = value.trim().toLowerCase(),
    parts = email.split("@");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    parts[0].length > 64 ||
    parts[0].startsWith(".") ||
    parts[0].endsWith(".") ||
    parts[0].includes("..") ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]) ||
    !parts[1].includes(".") ||
    parts[1]
      .split(".")
      .some((s) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s))
  )
    failure(422, "邮箱格式无效", "invalid_email");
  return email;
}
export async function codeHash(env, emailHash, id, code) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.EMAIL_CODE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(emailHash + "\n" + id + "\n" + code),
    ),
  );
}
function randomCode() {
  const x = new Uint32Array(1);
  do {
    crypto.getRandomValues(x);
  } while (x[0] >= 4294000000);
  return String(x[0] % 1000000).padStart(6, "0");
}
export async function requestRegistrationCode(
  store,
  env,
  rawEmail,
  ip,
  send,
  bindingUser = null,
) {
  const email = registrationEmail(rawEmail),
    config = mailConfiguration(env);
  if ((!bindingUser && !verificationEnabled(env)) || !config)
    failure(
      503,
      "邮箱验证服务暂不可用，请稍后重试",
      "email_delivery_unavailable",
    );
  const policy = JSON.parse(
    (
      await store.first(
        "SELECT value FROM settings WHERE name='registration_policy'",
      )
    ).value,
  );
  if (!policy.enabled && !bindingUser)
    failure(403, "当前暂停公开注册", "registration_disabled");
  if (bindingUser) {
    if (bindingUser.must_change)
      failure(403, "请先修改初始密码", "password_change_required");
    if (bindingUser.email_verified_at)
      failure(409, "邮箱已验证绑定", "email_already_verified");
    if (
      await store.first(
        "SELECT id FROM users WHERE id<>? AND (lower(email)=? OR lower(username)=?)",
        bindingUser.id,
        email,
        email,
      )
    )
      failure(409, "该邮箱已被其他账号占用", "email_in_use");
  }
  const table = bindingUser ? "account_email_codes" : "registration_codes";
  const ts = now(),
    emailHash = await digest(email),
    ipHash = await digest(ip),
    id = token(),
    code = randomCode(),
    hash = await codeHash(
      env,
      bindingUser ? "bind:" + bindingUser.id + ":" + emailHash : emailHash,
      id,
      code,
    );
  const rows = await store.db.batch([
    store.stmt(
      "INSERT INTO email_send_attempts(ip_hash,email_hash,ts,user_id) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM email_send_attempts WHERE email_hash=? AND ts>?) AND (SELECT count(*) FROM email_send_attempts WHERE email_hash=? AND ts>?)<3 AND (SELECT count(*) FROM email_send_attempts WHERE ip_hash=? AND ts>?)<? AND (SELECT count(*) FROM email_send_attempts WHERE ts>?)<? AND (SELECT count(*) FROM email_send_attempts WHERE ts>?)<? AND (? IS NULL OR (SELECT count(*) FROM email_send_attempts WHERE user_id=? AND ts>?)<3)",
      ipHash,
      emailHash,
      ts,
      bindingUser?.id ?? null,
      emailHash,
      ts - 60,
      emailHash,
      ts - 3600,
      ipHash,
      ts - 3600,
      policy.ip_hourly,
      ts - 3600,
      policy.global_hourly,
      ts - 60,
      policy.global_minute,
      bindingUser?.id ?? null,
      bindingUser?.id ?? null,
      ts - 3600,
    ),
    store.stmt(
      bindingUser
        ? "INSERT INTO account_email_codes(user_id,email_hash,id,code_hash,created,expires) SELECT ?,?,?,?,?,? WHERE changes()=1 ON CONFLICT(user_id) DO UPDATE SET email_hash=excluded.email_hash,id=excluded.id,code_hash=excluded.code_hash,created=excluded.created,expires=excluded.expires,attempts=0,state='pending'"
        : "INSERT INTO registration_codes(email_hash,id,code_hash,created,expires) SELECT ?,?,?,?,? WHERE changes()=1 ON CONFLICT(email_hash) DO UPDATE SET id=excluded.id,code_hash=excluded.code_hash,created=excluded.created,expires=excluded.expires,attempts=0,state='pending'",
      ...(bindingUser ? [bindingUser.id] : []),
      emailHash,
      id,
      hash,
      ts,
      ts + 600,
    ),
  ]);
  if (!rows[0].meta.changes)
    failure(429, "验证码发送过于频繁，请稍后重试", "email_rate_limited");
  const result = {
    message: bindingUser
      ? "验证码已发送，请检查收件箱及垃圾邮件"
      : "若此邮箱可注册，验证码将发送到您的邮箱，请检查收件箱及垃圾邮件",
    expires_in: 600,
    retry_after: 60,
  };
  if (
    !bindingUser &&
    (await store.first(
      "SELECT id FROM users WHERE username=? OR email=?",
      email,
      email,
    ))
  ) {
    await store.run(
      `UPDATE ${table} SET state='failed' WHERE email_hash=? AND id=?`,
      emailHash,
      id,
    );
    return result;
  }
  try {
    await send(config, email, code);
  } catch (e) {
    await store.run(
      `UPDATE ${table} SET state='failed' WHERE email_hash=? AND id=?`,
      emailHash,
      id,
    );
    writeWorkerLog(
      "mail_delivery_failure",
      {
        diagnostic_id: id,
        operation: bindingUser ? "email_binding" : "registration",
        smtp_provider: config.provider,
        error_code: [
          "smtp_timeout",
          "smtp_auth_failed",
          "smtp_rejected",
          "smtp_closed",
          "smtp_protocol",
          "smtp_line_limit",
          "smtp_reply_limit",
        ].includes(e?.message)
          ? e.message
          : "smtp_transport_error",
      },
      "warn",
    );
    failure(
      503,
      "验证码邮件发送失败，请稍后重试",
      "email_delivery_unavailable",
    );
  }
  await store.run(
    `UPDATE ${table} SET state='sent' WHERE email_hash=? AND id=? AND state='pending'`,
    emailHash,
    id,
  );
  return result;
}
export async function verifyRegistrationCode(
  store,
  env,
  email,
  code,
  bindingUser = null,
) {
  if (!mailConfiguration(env))
    failure(
      503,
      "邮箱验证服务暂不可用，请稍后重试",
      "email_delivery_unavailable",
    );
  if (typeof code !== "string" || !/^\d{6}$/.test(code))
    failure(422, "请输入六位邮箱验证码", "email_verification_required");
  const emailHash = await digest(email),
    ts = now(),
    row = await store
      .stmt(
        `UPDATE ${bindingUser ? "account_email_codes" : "registration_codes"} SET attempts=attempts+1 WHERE email_hash=? AND state='sent' AND expires>? AND attempts<5 ${bindingUser ? "AND user_id=?" : ""} RETURNING id,code_hash`,
        emailHash,
        ts,
        ...(bindingUser ? [bindingUser.id] : []),
      )
      .first();
  if (!row)
    failure(
      400,
      "验证码无效、已过期或尝试次数过多，请重新获取",
      "email_verification_invalid",
    );
  const hash = await codeHash(
    env,
    bindingUser ? "bind:" + bindingUser.id + ":" + emailHash : emailHash,
    row.id,
    code,
  );
  if (!equal(hash, row.code_hash))
    failure(
      400,
      "验证码无效、已过期或尝试次数过多，请重新获取",
      "email_verification_invalid",
    );
  return { emailHash, id: row.id, hash };
}
