import { Denied } from "./store.mjs";
import { digest, now } from "./crypto.mjs";
export const CAPTCHA_ACTIONS = [
  "registration_code",
  "password_reset_code",
  "email_binding_code",
];
const fail = (status, message, code) => {
  const e = new Denied(status, message);
  e.code = code;
  throw e;
};
export function captchaInfo(env) {
  if (env.CAPTCHA_ENABLED === "false")
    return { enabled: false, provider: "turnstile" };
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)
    fail(503, "人机验证暂不可用，请稍后重试", "captcha_unavailable");
  return {
    enabled: true,
    provider: "turnstile",
    site_key: env.TURNSTILE_SITE_KEY,
    actions: CAPTCHA_ACTIONS,
    challenge_url:
      (env.ACCOUNT_ORIGIN || "https://accounts.hilex.me") + "/auth/captcha",
  };
}
export async function verifyCaptcha(
  request,
  env,
  store,
  token,
  action,
  transport = fetch,
) {
  const info = captchaInfo(env);
  if (!info.enabled) return;
  if (!CAPTCHA_ACTIONS.includes(action))
    fail(422, "无效验证用途", "captcha_invalid");
  if (typeof token !== "string" || !token || token.length > 2048)
    fail(400, "请先完成人机验证", "captcha_required");
  const ip = request.headers.get("CF-Connecting-IP") || "local",
    ts = now(),
    bucket = Math.floor(ts / 60);
  const rows = await store.db.batch([
    store.stmt(
      "INSERT INTO captcha_attempts(scope,bucket,attempts) VALUES(?,?,1) ON CONFLICT(scope,bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<20",
      await digest(ip),
      bucket,
    ),
    store.stmt(
      "INSERT INTO captcha_attempts(scope,bucket,attempts) SELECT 'global',?,1 WHERE changes()=1 ON CONFLICT(scope,bucket) DO UPDATE SET attempts=attempts+1 WHERE attempts<500",
      bucket,
    ),
    // Atomically claim the token before Siteverify, closing cross-colo replay races.
    store.stmt(
      "INSERT OR IGNORE INTO captcha_redemptions(token_hash,created) SELECT ?,? WHERE changes()=1",
      await digest(token),
      ts,
    ),
  ]);
  if (!rows[0].meta.changes || !rows[1].meta.changes)
    fail(429, "人机验证请求过于频繁，请稍后重试", "captcha_rate_limited");
  if (!rows[2].meta.changes)
    fail(400, "验证已使用或失效，请重新验证", "captcha_invalid");
  let result;
  try {
    const r = await transport(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          ...(ip !== "local" ? { remoteip: ip } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!r.ok) throw new Error("siteverify unavailable");
    result = await r.json();
  } catch {
    fail(503, "人机验证服务暂不可用，请重新验证后重试", "captcha_unavailable");
  }
  if (
    result.success !== true ||
    result.hostname !==
      new URL(env.ACCOUNT_ORIGIN || "https://accounts.hilex.me").hostname ||
    result.action !== action
  )
    fail(400, "人机验证失败、过期或用途不匹配，请重新验证", "captcha_invalid");
}
