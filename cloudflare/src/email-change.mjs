import { Denied } from "./store.mjs";
import { checkPassword, digest, equal, now, token } from "./crypto.mjs";
import {
  registrationEmail,
  emailSendReservation,
  codeHash,
  randomCode,
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
    "换绑验证码无效、已过期或已使用，请重新发起",
    "email_change_invalid",
  );
const scope = (uid, hash) => "email-change\n" + uid + "\n" + hash;

export async function requestEmailChange(store, env, user, body, ip, send) {
  const email = registrationEmail(body.email);
  if (
    typeof body.current_password !== "string" ||
    !body.current_password ||
    body.current_password.length > 128
  )
    fail(422, "请填写当前密码", "current_password_required");
  await store.rateLimit(ip, "login", "account:" + user.id);
  const current = await store.first("SELECT * FROM users WHERE id=?", user.id);
  if (
    !current?.enabled ||
    !(await checkPassword(body.current_password, current.password))
  )
    fail(403, "当前密码错误", "current_password_invalid");
  if (current.must_change)
    fail(403, "请先修改初始密码", "password_change_required");
  if (!current.email_verified_at || !current.email)
    fail(
      409,
      "请先完成当前邮箱验证，再使用换绑功能",
      "email_verification_required",
    );
  if (email === current.email.toLowerCase())
    fail(422, "新邮箱不能与当前邮箱相同", "email_unchanged");
  if (
    await store.first(
      "SELECT id FROM users WHERE email=? COLLATE NOCASE",
      email,
    )
  )
    fail(409, "邮箱已被使用", "email_in_use");
  const config = mailConfiguration(env);
  if (!config) fail(503, "邮件服务暂不可用", "email_delivery_unavailable");
  const policy = JSON.parse(
    (
      await store.first(
        "SELECT value FROM settings WHERE name='registration_policy'",
      )
    ).value,
  );
  const ts = now(),
    hash = await digest(email),
    id = token(),
    code = randomCode();
  const rows = await store.db.batch([
    emailSendReservation(store, policy, await digest(ip), hash, ts, user.id),
    store.stmt(
      "INSERT INTO email_change_challenges(user_id,id,old_email,new_email,email_hash,code_hash,password_version,created,expires) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1 AND EXISTS(SELECT 1 FROM users WHERE id=? AND enabled=1 AND must_change=0 AND password=? AND email=? AND email_verified_at IS NOT NULL) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,old_email=excluded.old_email,new_email=excluded.new_email,email_hash=excluded.email_hash,code_hash=excluded.code_hash,password_version=excluded.password_version,created=excluded.created,expires=excluded.expires,attempts=0,state='pending',consumed_by=NULL",
      user.id,
      id,
      current.email,
      email,
      hash,
      await codeHash(env, scope(user.id, hash), id, code),
      await digest(current.password),
      ts,
      ts + 600,
      user.id,
      current.password,
      current.email,
    ),
  ]);
  if (!rows[0].meta.changes)
    fail(429, "验证码发送过于频繁，请稍后重试", "email_rate_limited");
  if (!rows[1].meta.changes)
    fail(409, "账号状态已改变，请重新发起", "email_change_invalid");
  try {
    await send(config, email, code, "email-change");
  } catch {
    await store.run(
      "UPDATE email_change_challenges SET state='failed',code_hash='' WHERE user_id=? AND id=? AND state='pending'",
      user.id,
      id,
    );
    writeWorkerLog(
      "mail_delivery_failure",
      { operation: "email_change", error_code: "email_delivery_unavailable" },
      "warn",
    );
    fail(
      503,
      "验证码邮件发送失败，请稍后重新验证并手动发送",
      "email_delivery_unavailable",
    );
  }
  const sent = await store.run(
    "UPDATE email_change_challenges SET state='sent' WHERE user_id=? AND id=? AND state='pending'",
    user.id,
    id,
  );
  if (!sent.meta.changes) invalid();
  return {
    message: "换绑验证码已发送至新邮箱",
    expires_in: 600,
    retry_after: 60,
  };
}

export async function confirmEmailChange(store, env, user, body, send, ctx) {
  const email = registrationEmail(body.email),
    code = body.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code))
    fail(422, "请输入六位换绑验证码", "email_change_code_required");
  const ts = now();
  const proof = await store
    .stmt(
      "UPDATE email_change_challenges SET attempts=attempts+1 WHERE user_id=? AND new_email=? AND state='sent' AND expires>? AND attempts<5 RETURNING *",
      user.id,
      email,
      ts,
    )
    .first();
  if (
    !proof ||
    !equal(
      await codeHash(env, scope(user.id, proof.email_hash), proof.id, code),
      proof.code_hash,
    )
  )
    invalid();
  const current = await store.first("SELECT * FROM users WHERE id=?", user.id);
  if (
    !current?.enabled ||
    current.must_change ||
    !current.email_verified_at ||
    current.email !== proof.old_email ||
    (await digest(current.password)) !== proof.password_version
  )
    invalid();
  const commit = token();
  const guard =
    "EXISTS(SELECT 1 FROM email_change_challenges c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND c.id=? AND c.state='consumed' AND c.consumed_by=? AND u.email=? AND u.password=?)";
  const args = [user.id, proof.id, commit, email, current.password];
  let result;
  try {
    result = await store.db.batch([
      store.stmt(
        "UPDATE users SET email=?,email_verified_at=? WHERE id=? AND email=? AND password=? AND enabled=1 AND must_change=0 AND EXISTS(SELECT 1 FROM email_change_challenges c WHERE c.user_id=users.id AND c.id=? AND c.new_email=? AND c.code_hash=? AND c.state='sent' AND c.expires>? AND c.attempts<=5)",
        email,
        ts,
        user.id,
        proof.old_email,
        current.password,
        proof.id,
        email,
        proof.code_hash,
        ts,
      ),
      store.stmt(
        "UPDATE email_change_challenges SET state='consumed',code_hash='',consumed_by=? WHERE user_id=? AND id=? AND changes()=1",
        commit,
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
      store.stmt(
        "DELETE FROM password_reset_codes WHERE user_id=? AND " + guard,
        user.id,
        ...args,
      ),
      store.stmt(
        "DELETE FROM account_email_codes WHERE user_id=? AND " + guard,
        user.id,
        ...args,
      ),
      store.stmt(
        "INSERT INTO audit(actor,action,target,ts) SELECT ?,'change_email',?,? WHERE " +
          guard,
        user.id,
        String(user.id),
        ts,
        ...args,
      ),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      fail(409, "新邮箱已被使用，请换一个邮箱", "email_in_use");
    throw error;
  }
  if (!result[0].meta.changes) invalid();
  const config = mailConfiguration(env);
  ctx.waitUntil(
    (config
      ? send(config, proof.old_email, "", "email-changed")
      : Promise.reject(new Error("mail_unconfigured"))
    ).catch(() => {
      writeWorkerLog(
        "mail_delivery_failure",
        {
          operation: "email_change_notification",
          error_code: "email_delivery_unavailable",
        },
        "warn",
      );
    }),
  );
  return {
    ok: true,
    email,
    api_keys_revoked: false,
    message:
      "登录邮箱已更新，所有设备均已退出，请使用新邮箱重新登录。API Key 保持有效。",
  };
}
