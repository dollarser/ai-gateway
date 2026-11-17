import { test } from "node:test";
import assert from "node:assert/strict";
import { smtpSession, mailConfiguration } from "../src/smtp-core.mjs";
const config = {
  smtp_host: "smtp.qiye.aliyun.com",
  smtp_port: 465,
  smtp_secure: true,
  smtp_username: "sender@example.com",
  smtp_password: "test-only-credential",
  from_email: "sender@example.com",
  from_name: "Helix AI",
};
function peer(lines) {
  const writes = [];
  let closed = false;
  return {
    writes,
    get closed() {
      return closed;
    },
    socket: {
      opened: Promise.resolve(),
      readable: new ReadableStream({
        start(c) {
          for (const line of lines) c.enqueue(new TextEncoder().encode(line));
          c.close();
        },
      }),
      writable: new WritableStream({
        write(v) {
          writes.push(new TextDecoder().decode(v));
        },
      }),
      async close() {
        closed = true;
      },
    },
  };
}
test("SMTP TLS session parses fragmented multiline replies and sends only fixed verification content", async () => {
  const p = peer([
    "220 mail ready\r",
    "\n250-test\r\n250 AUTH LOGIN\r\n334 username\r\n334 password\r\n235 ok\r\n250 ok\r\n250 ok\r\n354 go\r\n250 queued\r\n",
  ]);
  await smtpSession(p.socket, config, "reader@example.com", "012345");
  assert.equal(p.closed, true);
  assert.equal(p.writes[0], "EHLO accounts.hilex.me\r\n");
  assert.equal(p.writes[1], "AUTH LOGIN\r\n");
  assert.equal(p.writes[3], btoa(config.smtp_password) + "\r\n");
  assert.match(p.writes[5], /^RCPT TO:<reader@example.com>/);
  assert.match(p.writes[7], /Content-Transfer-Encoding: base64/);
  assert.equal(p.writes.at(-1), "QUIT\r\n");
  const body = p.writes[7]
    .split("\r\n\r\n")[1]
    .replace(/\r\n\.\r\n$/, "")
    .replaceAll("\r\n", "");
  assert.match(
    new TextDecoder().decode(
      Uint8Array.from(atob(body), (s) => s.charCodeAt(0)),
    ),
    /012345/,
  );
});
test("SMTP authentication and truncated replies fail without leaking server text", async () => {
  const p = peer([
    "220 ok\r\n250 ok\r\n334 user\r\n334 password\r\n535 private rejected content\r\n",
  ]);
  await assert.rejects(
    smtpSession(p.socket, config, "reader@example.com", "123456"),
    { message: "smtp_auth_failed" },
  );
  assert.equal(p.closed, true);
  assert.ok(!p.writes.some((s) => s.startsWith("MAIL FROM")));
  const truncated = peer(["220 incomplete"]);
  await assert.rejects(
    smtpSession(truncated.socket, config, "reader@example.com", "123456"),
    { message: "smtp_closed" },
  );
  const rejected = peer([
    "220 ok\r\n250 ok\r\n334 u\r\n334 p\r\n235 ok\r\n250 ok\r\n550 not allowed\r\n",
  ]);
  await assert.rejects(
    smtpSession(rejected.socket, config, "reader@example.com", "123456"),
    { message: "smtp_rejected" },
  );
});
test("SMTP configuration requires TLS, matching sender and independent verification secret", () => {
  const valid = {
    REGISTRATION_SMTP: JSON.stringify(config),
    EMAIL_CODE_SECRET: "x".repeat(64),
  };
  assert.ok(mailConfiguration(valid));
  assert.equal(mailConfiguration({}), null);
  for (const change of [
    { smtp_secure: false },
    { smtp_port: 25 },
    { smtp_password: "" },
    { from_email: "another@example.com" },
    { from_name: "bad\r\nheader" },
  ])
    assert.equal(
      mailConfiguration({
        ...valid,
        REGISTRATION_SMTP: JSON.stringify({ ...config, ...change }),
      }),
      null,
    );
});

test("Reset emails distinguish recovery codes and password-change notifications without sending passwords", async () => {
  for (const [purpose, code, expected] of [
    ["password-reset", "012345", "密码重置验证码"],
    ["password-changed", "keys-retained", "API Key 保持有效"],
    ["password-changed", "keys-revoked", "所有 API Key 已停用"],
  ]) {
    const p = peer([
      "220 ready\r\n250 ok\r\n334 user\r\n334 pass\r\n235 ok\r\n250 ok\r\n250 ok\r\n354 data\r\n250 queued\r\n",
    ]);
    await smtpSession(p.socket, config, "reader@example.com", code, purpose);
    const mail = p.writes[7],
      body = mail
        .split("\r\n\r\n")[1]
        .replace(/\r\n\.\r\n$/, "")
        .replaceAll("\r\n", "");
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(body), (s) => s.charCodeAt(0)),
    );
    assert.ok(text.includes(expected));
    assert.match(
      mail,
      purpose === "password-reset"
        ? /Subject: Helix AI password reset code/
        : /Subject: Helix AI password changed/,
    );
    if (purpose === "password-changed") assert.ok(!text.includes("012345"));
  }
});
