import { Denied } from "./store.mjs";
import { registrationEmail } from "./registration.mjs";
import { checkPassword } from "./crypto.mjs";
export async function changePasswordWithCredentials(store, body, ip) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (k) => !["email", "current_password", "new_password"].includes(k),
    )
  )
    throw new Denied(422, "修改密码字段无效");
  const { email, current_password: old, new_password: password } = body;
  if (
    typeof email !== "string" ||
    email.trim().length < 3 ||
    email.length > 254 ||
    typeof old !== "string" ||
    !old ||
    old.length > 128 ||
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 128
  )
    throw new Denied(422, "请填写登录邮箱、旧密码和 6–128 字符的新密码");
  const normalizedEmail = registrationEmail(email);
  const user = await store.findLoginUser(normalizedEmail);
  await store.rateLimit(
    ip,
    "login",
    user ? "account:" + user.id : normalizedEmail,
  );
  const valid = await checkPassword(
    old,
    user?.password ?? "0".repeat(32) + ":" + "0".repeat(128),
  );
  if (!user || !valid || !user.enabled) throw new Denied(401, "邮箱或密码错误");
  await store.changePassword(user.id, old, password);
  return {
    ok: true,
    message:
      "密码已修改，所有登录会话已退出，请使用登录邮箱和新密码重新登录。API Key 保持有效。",
  };
}
