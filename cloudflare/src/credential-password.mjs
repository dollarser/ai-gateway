import { Denied } from "./store.mjs";
import { checkPassword } from "./crypto.mjs";
export async function changePasswordWithCredentials(store, body, ip) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (k) => !["username", "current_password", "new_password"].includes(k),
    )
  )
    throw new Denied(422, "修改密码字段无效");
  const { username, current_password: old, new_password: password } = body;
  if (
    typeof username !== "string" ||
    username.trim().length < 3 ||
    username.length > 254 ||
    typeof old !== "string" ||
    !old ||
    old.length > 128 ||
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 128
  )
    throw new Denied(422, "请填写原用户名、旧密码和 6–128 字符的新密码");
  await store.rateLimit(ip, "login", username);
  const user = await store.first(
    "SELECT * FROM users WHERE username=?",
    username.trim().toLowerCase(),
  );
  const valid = await checkPassword(
    old,
    user?.password ?? "0".repeat(32) + ":" + "0".repeat(128),
  );
  if (!user || !valid || !user.enabled)
    throw new Denied(401, "用户名或密码错误");
  await store.changePassword(user.id, old, password);
  return {
    ok: true,
    message:
      "密码已修改，所有登录会话已退出，请使用原用户名和新密码重新登录。API Key 保持有效。",
  };
}
