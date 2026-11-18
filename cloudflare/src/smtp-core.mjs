// SMTP over a caller-provided TLS stream. Never expose peer replies or credentials.
const encoder = new TextEncoder();
function base64(s) {
  return btoa(String.fromCharCode(...encoder.encode(s)));
}
export async function smtpSession(
  socket,
  config,
  recipient,
  code,
  purpose = "verification",
) {
  socket.closed?.catch(() => {});
  const reader = socket.readable.getReader(),
    writer = socket.writable.getWriter();
  let buffer = "",
    bytes = 0;
  const deadline = Date.now() + 15000;
  async function bounded(p) {
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("smtp_timeout")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function line() {
    while (!buffer.includes("\r\n")) {
      const { done, value } = await bounded(reader.read());
      if (done) throw new Error("smtp_closed");
      bytes += value.length;
      if (bytes > 32768) throw new Error("smtp_reply_limit");
      buffer += new TextDecoder().decode(value);
      if (buffer.length > 8192) throw new Error("smtp_line_limit");
    }
    const end = buffer.indexOf("\r\n"),
      result = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return result;
  }
  async function reply(expected) {
    let first;
    for (let i = 0; i < 100; i++) {
      const s = await line(),
        m = /^(\d{3})([ -])/.exec(s);
      if (!m || (first && first !== m[1])) throw new Error("smtp_protocol");
      first = m[1];
      if (m[2] === " ") {
        if (Number(first) !== expected)
          throw new Error(
            expected === 235 ? "smtp_auth_failed" : "smtp_rejected",
          );
        return;
      }
    }
    throw new Error("smtp_reply_limit");
  }
  const write = (s) => bounded(writer.write(encoder.encode(s + "\r\n")));
  try {
    await bounded(socket.opened ?? Promise.resolve());
    await reply(220);
    await write("EHLO accounts.hilex.me");
    await reply(250);
    await write("AUTH LOGIN");
    await reply(334);
    await write(base64(config.smtp_username));
    await reply(334);
    await write(base64(config.smtp_password));
    await reply(235);
    await write("MAIL FROM:<" + config.from_email + ">");
    await reply(250);
    await write("RCPT TO:<" + recipient + ">");
    await reply(250);
    await write("DATA");
    await reply(354);
    const content =
      purpose === "email-changed"
        ? "您的 Helix AI 登录邮箱已变更，原登录会话均已退出，API Key 保持有效。如果不是您本人操作，请立即联系管理员并检查账号安全。"
        : purpose === "email-change"
          ? "您的 Helix AI 换绑邮箱验证码为：" +
            code +
            "\n验证码 10 分钟内有效，请勿向他人透露。只有您发起修改登录邮箱时才使用此码；如果不是本人操作，请忽略此邮件。"
          : purpose === "password-reset"
            ? "您的 Helix AI 密码重置验证码为：" +
              code +
              "\n验证码 10 分钟内有效，请勿向他人透露。只有您发起找回密码时才使用此码。如果不是您本人操作，请忽略此邮件，密码不会因此改变。"
            : purpose === "password-changed"
              ? "您的 Helix AI 账号密码已通过邮箱验证重置，原登录会话均已退出。\n" +
                (code === "keys-revoked"
                  ? "所有 API Key 已停用。"
                  : "API Key 保持有效。") +
                "\n如果不是您本人操作，请立即联系管理员并检查邮箱安全。此邮件不包含密码。"
              : "您的 Helix AI 邮箱验证码为：" +
                code +
                "\n验证码 10 分钟内有效，请勿向他人透露。\n如果不是您本人操作，请忽略此邮件。";
    const body = base64(content)
      .match(/.{1,76}/g)
      .join("\r\n");
    const message = [
      "From: =?UTF-8?B?" +
        base64(config.from_name || "Helix AI") +
        "?= <" +
        config.from_email +
        ">",
      "To: <" + recipient + ">",
      "Subject: Helix AI " +
        (purpose === "email-changed"
          ? "login email changed"
          : purpose === "email-change"
            ? "email change code"
            : purpose === "password-reset"
              ? "password reset code"
              : purpose === "password-changed"
                ? "password changed"
                : "email verification code"),
      "Date: " + new Date().toUTCString(),
      "Message-ID: <" +
        crypto.randomUUID() +
        "@" +
        config.from_email.split("@")[1] +
        ">",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
      ".",
    ].join("\r\n");
    await write(message);
    await reply(250);
    // A 250 reply after DATA is acceptance; QUIT failure must not invalidate a delivered code.
    try {
      await write("QUIT");
    } catch {}
  } finally {
    try {
      await socket.close();
    } catch {}
    try {
      reader.releaseLock();
      writer.releaseLock();
    } catch {}
  }
}
export function mailConfiguration(env) {
  try {
    const c = JSON.parse(env.REGISTRATION_SMTP || "null");
    if (
      !c ||
      typeof c.smtp_host !== "string" ||
      !/^[a-z0-9.-]+$/i.test(c.smtp_host) ||
      c.smtp_port !== 465 ||
      c.smtp_secure !== true ||
      typeof c.smtp_password !== "string" ||
      !c.smtp_password ||
      c.smtp_password.length > 1024 ||
      typeof c.smtp_username !== "string" ||
      c.smtp_username !== c.from_email ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(c.from_email) ||
      /[\r\n]/.test(c.from_name || "") ||
      (c.from_name || "").length > 80 ||
      !env.EMAIL_CODE_SECRET ||
      env.EMAIL_CODE_SECRET.length < 32
    )
      return null;
    const provider =
      c.provider ||
      (c.smtp_host.includes("qiye.aliyun")
        ? "legacy-enterprise"
        : "generic-smtp");
    if (
      !["legacy-enterprise", "generic-smtp", "alicloud-directmail"].includes(
        provider,
      )
    )
      return null;
    if (
      provider === "alicloud-directmail" &&
      ![
        "smtpdm.aliyun.com",
        "smtpdm-ap-southeast-1.aliyuncs.com",
        "smtpdm-us-east-1.aliyuncs.com",
        "smtpdm-eu-central-1.aliyuncs.com",
      ].includes(c.smtp_host)
    )
      return null;
    return { ...c, provider };
  } catch {
    return null;
  }
}
