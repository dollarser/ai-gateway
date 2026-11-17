import { Denied } from "./store.mjs";
import { digest, now, token, equal, passwordHash } from "./crypto.mjs";
import {
  registrationEmail,
  randomCode,
  codeHash,
  emailSendReservation,
} from "./registration.mjs";
import { mailConfiguration } from "./smtp-core.mjs";
import { writeWorkerLog } from "./worker-logs.mjs";
const fail = (status, message, code) => {
  const error = new Denied(status, message);
  error.code = code;
  throw error;
};
const invalid = () =>
  fail(
    400,
    "验证码无效、已过期或尝试次数过多，请重新获取",
    "password_reset_invalid",
  );
function configuration(env) {
  const config = mailConfiguration(env);
  if (!config || !env.EMAIL_CODE_SECRET)
    fail(503, "邮箱找回服务暂不可用，请稍后重试", "email_delivery_unavailable");
  return config;
}
async function eligibleUser(store, email) {
  return store.first(
    "SELECT * FROM users WHERE lower(email)=? AND email_verified_at IS NOT NULL AND enabled=1",
    email,
  );
}
export async function requestPasswordReset(
  store,
  env,
  rawEmail,
  ip,
  send,
  ctx,
) {
  const email = registrationEmail(rawEmail),
    config = configuration(env),
    ts = now();
  const policy = JSON.parse(
    (
      await store.first(
        "SELECT value FROM settings WHERE name='registration_policy'",
      )
    ).value,
  );
  const emailHash = await digest(email),
    ipHash = await digest(ip),
    user = await eligibleUser(store, email);
  const id = token(),
    code = randomCode();
  const hash = await codeHash(
    env,
    "reset:" + (user?.id ?? "unknown") + ":" + emailHash,
    id,
    code,
  );
  const statements = [
    emailSendReservation(
      store,
      policy,
      ipHash,
      emailHash,
      ts,
      user?.id ?? null,
    ),
  ];
  if (user)
    statements.push(
      store.stmt(
        "INSERT INTO password_reset_codes(user_id,email_hash,id,code_hash,password_version,created,expires) SELECT ?,?,?,?,?,?,? WHERE changes()=1 ON CONFLICT(user_id) DO UPDATE SET email_hash=excluded.email_hash,id=excluded.id,code_hash=excluded.code_hash,password_version=excluded.password_version,created=excluded.created,expires=excluded.expires,attempts=0,state='pending'",
        user.id,
        emailHash,
        id,
        hash,
        await digest(user.password),
        ts,
        ts + 600,
      ),
    );
  const rows = await store.db.batch(statements);
  if (!rows[0].meta.changes)
    fail(429, "验证码发送过于频繁，请稍后重试", "email_rate_limited");
  // Return uniformly without waiting for SMTP, including unknown/unverified users.
  // Codes become usable only after SMTP acceptance. No account existence is exposed.
  if (user)
    ctx.waitUntil(
      (async () => {
        try {
          await send(config, email, code, "password-reset");
          await store.run(
            "UPDATE password_reset_codes SET state='sent' WHERE user_id=? AND id=? AND state='pending'",
            user.id,
            id,
          );
        } catch {
          await store.run(
            "UPDATE password_reset_codes SET state='failed',code_hash='' WHERE user_id=? AND id=? AND state='pending'",
            user.id,
            id,
          );
          writeWorkerLog(
            "mail_delivery_failure",
            {
              operation: "password_reset",
              diagnostic_id: id,
              error_code: "email_delivery_unavailable",
            },
            "warn",
          );
        }
      })(),
    );
  return {
    message:
      "若该邮箱已验证并绑定可用账号，您将收到密码重置验证码，请检查收件箱及垃圾邮件",
    expires_in: 600,
    retry_after: 60,
  };
}
export async function resetPassword(store, env, payload, send, ctx) {
  const {
    email: rawEmail,
    code,
    new_password: password,
    revoke_api_keys: revoke = false,
  } = payload;
  const email = registrationEmail(rawEmail),
    config = configuration(env);
  if (
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 128
  )
    fail(422, "密码应为 6–128 字符", "invalid_password");
  if (typeof revoke !== "boolean")
    fail(422, "revoke_api_keys 必须为布尔值", "invalid_reset_options");
  if (typeof code !== "string" || !/^\d{6}$/.test(code))
    fail(422, "请输入六位密码重置验证码", "password_reset_code_required");
  const emailHash = await digest(email),
    ts = now();
  const proof = await store
    .stmt(
      "UPDATE password_reset_codes SET attempts=attempts+1 WHERE email_hash=? AND state='sent' AND expires>? AND attempts<5 RETURNING user_id,id,code_hash,password_version",
      emailHash,
      ts,
    )
    .first();
  if (!proof) invalid();
  const hash = await codeHash(
    env,
    "reset:" + proof.user_id + ":" + emailHash,
    proof.id,
    code,
  );
  if (!equal(hash, proof.code_hash)) invalid();
  const user = await eligibleUser(store, email);
  if (
    !user ||
    user.id !== proof.user_id ||
    (await digest(user.password)) !== proof.password_version
  )
    invalid();
  const encoded = await passwordHash(password),
    commitTs = now();
  const guard =
    "EXISTS(SELECT 1 FROM password_reset_codes c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND c.id=? AND c.state='consumed' AND u.password=?)";
  const args = [user.id, proof.id, encoded];
  const rows = await store.db.batch([
    store.stmt(
      "UPDATE users SET password=?,must_change=0 WHERE id=? AND enabled=1 AND password=? AND lower(email)=? AND email_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM password_reset_codes c WHERE c.user_id=users.id AND c.id=? AND c.email_hash=? AND c.code_hash=? AND c.password_version=? AND c.state='sent' AND c.expires>? AND c.attempts<=5)",
      encoded,
      user.id,
      user.password,
      email,
      proof.id,
      emailHash,
      hash,
      proof.password_version,
      commitTs,
    ),
    store.stmt(
      "UPDATE password_reset_codes SET state='consumed',code_hash='' WHERE user_id=? AND id=? AND changes()=1",
      user.id,
      proof.id,
    ),
    store.stmt(
      "DELETE FROM sessions WHERE user_id=? AND " + guard,
      user.id,
      ...args,
    ),
    store.stmt(
      "UPDATE auth_families SET revoked=1 WHERE user_id=? AND " + guard,
      user.id,
      ...args,
    ),
    ...(revoke
      ? [
          store.stmt(
            "UPDATE keys SET revoked=1 WHERE user_id=? AND " + guard,
            user.id,
            ...args,
          ),
        ]
      : []),
    store.stmt(
      "INSERT INTO audit(actor,action,target,ts) SELECT ?,?,?,? WHERE " + guard,
      user.id,
      revoke ? "self_reset_password_revoke_keys" : "self_reset_password",
      String(user.id),
      commitTs,
      ...args,
    ),
  ]);
  if (!rows[0].meta.changes) invalid();
  ctx.waitUntil(
    send(
      config,
      email,
      revoke ? "keys-revoked" : "keys-retained",
      "password-changed",
    ).catch(() => {
      writeWorkerLog(
        "mail_delivery_failure",
        {
          operation: "password_reset_notification",
          error_code: "email_delivery_unavailable",
        },
        "warn",
      );
    }),
  );
  return {
    ok: true,
    api_keys_revoked: revoke,
    message:
      "密码已重置，原登录会话均已退出，请使用原登录名和新密码重新登录。" +
      (revoke ? "所有 API Key 已停用。" : "API Key 保持有效。"),
  };
}
