import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { passwordHash, digest } from "../src/crypto.mjs";
let mf, db, admin;
const secret = "test-internal-secret-".repeat(3);
async function call(path, body, options = {}) {
  const {
    method = body === undefined ? "GET" : "POST",
    access,
    cookie,
    csrf,
    headers = {},
  } = options;
  const r = await mf.dispatchFetch("https://accounts.test" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(access ? { Authorization: "Bearer " + access } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
const internal = (path, body) =>
  call("/internal/" + path, body, { access: secret });
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: ".test-build/worker.js",
    compatibilityDate: "2026-07-01",
    d1Databases: ["DB"],
    bindings: {
      INTERNAL_SECRET: secret,
      ACCOUNT_ORIGIN: "https://accounts.test",
    },
    serviceBindings: {
      ASSETS: async () => new Response("<html>portal</html>"),
    },
  });
  db = await mf.getD1Database("DB");
  let schema = await readFile("migrations/0001_accounts.sql", "utf8");
  const [ddl, ...triggers] = schema.split(/(?=CREATE TRIGGER)/);
  for (const s of [
    ...ddl
      .replace(/^--.*$/gm, "")
      .split(";")
      .filter((s) => s.trim()),
    ...triggers,
  ])
    await db.prepare(s).run();
  await db
    .prepare(
      "INSERT INTO users(username,password,role,services,rpm,daily_requests,concurrency,must_change,created) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "admin",
      await passwordHash("admin-password"),
      "admin",
      '["qwen","asr","tts"]',
      0,
      0,
      8,
      0,
      Date.now() / 1000,
    )
    .run();
  const result = await call("/auth/login", {
    username: "admin",
    password: "admin-password",
  });
  assert.equal(result.status, 200);
  admin = result.body.access_token;
});
after(async () => {
  await mf?.dispose();
});
test("registration, login, cookie CSRF and key ownership", async () => {
  const email = "person@example.com";
  let r = await call("/auth/register", {
    email,
    password: "long-password",
    role: "admin",
  });
  assert.equal(r.status, 422);
  r = await call("/auth/register", { email, password: "long-password" });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, "user");
  assert.equal(r.body.user.must_change, 0);
  const login = await call("/auth/login", {
    username: email,
    password: "long-password",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(
    login.headers.get("set-cookie"),
    /Secure; HttpOnly; SameSite=Strict/,
  );
  assert.equal((await call("/account/me", undefined, { cookie })).status, 200);
  assert.equal(
    (
      await call(
        "/account/password",
        { current_password: "long-password", new_password: "new-password" },
        { cookie },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/account/keys", undefined, {
        access: login.body.access_token,
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/account/me", undefined, { access: "sk-acct-invalid" }))
      .status,
    401,
  );
  const refresh = await call("/auth/refresh", {
    refresh_token: login.body.refresh_token,
  });
  assert.equal(refresh.status, 200);
  assert.equal(
    (await call("/auth/refresh", { refresh_token: login.body.refresh_token }))
      .status,
    401,
  );
  assert.equal(
    (
      await call("/account/me", undefined, {
        access: refresh.body.access_token,
      })
    ).status,
    401,
  );
});
test("internal endpoints reject missing credentials and tampered bodies", async () => {
  assert.equal(
    (
      await call("/internal/acquire", {
        raw: "x",
        service: "asr",
        path: "/v1/audio/transcriptions",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await internal("acquire", {
        raw: "x",
        service: "asr",
        path: "/",
        sql: "select 1",
      })
    ).status,
    422,
  );
  assert.equal(
    (await internal("sql", { query: "select * from users" })).status,
    404,
  );
});
test("atomic concurrency, persistent usage, idempotent finish and key revocation", async () => {
  const created = await call(
    "/admin/users",
    { username: "quota-user", concurrency: 1, rpm: 0, daily_requests: 0 },
    { access: admin },
  );
  assert.equal(created.status, 200);
  const uid = created.body.user.id;
  // New admin-created accounts must change password before using inference.
  let k = await call(
    "/admin/keys/" + uid,
    { name: "test", services: ["asr"], days: 1 },
    { access: admin },
  );
  assert.equal(k.status, 200);
  assert.equal(
    (
      await internal("acquire", {
        raw: k.body.key,
        service: "asr",
        path: "/v1/audio/transcriptions",
      })
    ).status,
    403,
  );
  const login = await call("/auth/login", {
    username: "quota-user",
    password: created.body.temporary_password,
  });
  assert.equal(
    (
      await call(
        "/account/password",
        {
          current_password: created.body.temporary_password,
          new_password: "new-password",
        },
        { access: login.body.access_token },
      )
    ).status,
    200,
  );
  const args = {
    raw: k.body.key,
    service: "asr",
    path: "/v1/audio/transcriptions",
  };
  const results = await Promise.all([
    internal("acquire", args),
    internal("acquire", args),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  const lease = results.find((r) => r.status === 200).body.lease;
  assert.equal(
    (
      await internal("finish", {
        lease,
        status: 200,
        size: 42,
        prompt_tokens: 3,
      })
    ).status,
    200,
  );
  await internal("finish", { lease, status: 500, size: 999 });
  const usage = await call("/admin/usage?user_id=" + uid, undefined, {
    access: admin,
  });
  assert.equal(usage.body.requests[0].response_bytes, 42);
  assert.equal(usage.body.requests[0].status, 200);
  assert.equal(
    (
      await call("/admin/keys/" + k.body.id, undefined, {
        method: "DELETE",
        access: admin,
      })
    ).status,
    200,
  );
  assert.equal((await internal("acquire", args)).status, 401);
});
test("last admin is protected and account fields cannot change roles", async () => {
  const me = await call("/account/me", undefined, { access: admin });
  const uid = me.body.user.id;
  assert.equal(
    (
      await call(
        "/admin/users/" + uid,
        { enabled: false },
        { method: "PATCH", access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/users/" + uid,
        { role: "admin" },
        { method: "PATCH", access: admin },
      )
    ).status,
    422,
  );
});
test("legacy Python password encoding matches Worker verification", async () => {
  // Python hashlib.scrypt(password=b"test-password", salt=bytes.fromhex("00"*16), n=16384,r=8,p=1).
  const encoded = await passwordHash("test-password", "0".repeat(32));
  const expected = await readFile("tests/python-password.txt", "utf8");
  assert.equal(encoded, expected.trim());
});
test("parallel refresh reuse revokes the token family atomically", async () => {
  const login = await call(
    "/auth/login",
    { username: "admin", password: "admin-password" },
    { headers: { "CF-Connecting-IP": "192.0.2.50" } },
  );
  const results = await Promise.all([
    call("/auth/refresh", { refresh_token: login.body.refresh_token }),
    call("/auth/refresh", { refresh_token: login.body.refresh_token }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  assert.equal(
    (
      await call("/account/me", undefined, {
        access: results.find((r) => r.status === 200).body.access_token,
      })
    ).status,
    401,
  );
});
test("daily quota is shared across keys and zero RPM remains unlimited", async () => {
  const created = await call(
    "/admin/users",
    { username: "daily-user", concurrency: 4, rpm: 0, daily_requests: 1 },
    { access: admin },
  );
  assert.equal(created.status, 200);
  const uid = created.body.user.id;
  const login = await call(
    "/auth/login",
    { username: "daily-user", password: created.body.temporary_password },
    { headers: { "CF-Connecting-IP": "192.0.2.51" } },
  );
  await call(
    "/account/password",
    {
      current_password: created.body.temporary_password,
      new_password: "long-password",
    },
    { access: login.body.access_token },
  );
  const a = await call(
    "/admin/keys/" + uid,
    { name: "a", services: ["asr"] },
    { access: admin },
  );
  const b = await call(
    "/admin/keys/" + uid,
    { name: "b", services: ["asr"] },
    { access: admin },
  );
  const first = await internal("acquire", {
    raw: a.body.key,
    service: "asr",
    path: "/v1/audio/transcriptions",
  });
  assert.equal(first.status, 200);
  await internal("finish", { lease: first.body.lease, status: 200 });
  assert.equal(
    (
      await internal("acquire", {
        raw: b.body.key,
        service: "asr",
        path: "/v1/audio/transcriptions",
      })
    ).status,
    429,
  );
});

test("invalid account services and key expiry cannot corrupt stored permissions", async () => {
  const me = await call("/account/me", undefined, { access: admin });
  const uid = me.body.user.id;
  const before = (await db.prepare("SELECT count(*) AS n FROM users").first())
    .n;
  for (const value of [null, false, [], "asr"]) {
    const result = await call(
      "/admin/users",
      { username: "invalid-services", services: value },
      { access: admin },
    );
    assert.equal(result.status, 422);
  }
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM users").first()).n,
    before,
  );
  assert.equal(
    (
      await call(
        "/admin/users/" + uid,
        { services: null },
        { method: "PATCH", access: admin },
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await call(
        "/account/keys",
        { name: "invalid", services: ["asr"], days: null },
        { access: admin },
      )
    ).status,
    422,
  );
  const after = await call("/account/me", undefined, { access: admin });
  assert.deepEqual(after.body.user.services, me.body.user.services);
});
