import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { passwordHash, digest } from "../src/crypto.mjs";
let mf, db, admin;
let openaiMode = "json",
  providerCalls = 0;
async function provider(request) {
  assert.equal(new URL(request.url).hostname, "api.openai.com");
  assert.equal(request.headers.get("Authorization"), "Bearer test-openai-key");
  const p = await request.json();
  assert.equal(p.model, "gpt-6-luna");
  assert.equal(p.service_tier, "default");
  assert.equal(p.store, false);
  assert.equal(p.max_tokens, undefined);
  providerCalls++;
  if (openaiMode === "reject")
    return new Response("private upstream error", { status: 401 });
  if (openaiMode === "unknown") return new Response("invalid-json");
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 40 },
  };
  if (p.stream) {
    const responseMode = new URL(request.url).pathname === "/v1/responses";
    const event = responseMode
      ? {
          type: "response.completed",
          response: {
            id: "resp-test",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 40 },
            },
          },
        }
      : { id: "chat-test", choices: [], usage };
    const value =
      openaiMode === "truncated"
        ? 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        : "data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n";
    return new Response(value, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return Response.json({
    id: "chat-test",
    choices: [{ message: { role: "assistant", content: "hello" } }],
    usage,
  });
}
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
      OPENAI_API_KEY: "test-openai-key",
      ACCOUNT_ORIGIN: "https://accounts.test",
    },
    outboundService: provider,
    serviceBindings: {
      ASSETS: async () => new Response("<html>portal</html>"),
    },
  });
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    let schema = await readFile("migrations/" + file, "utf8");
    const [ddl, ...triggers] = schema.split(/(?=CREATE TRIGGER)/);
    for (const s of [
      ...ddl
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((s) => s.trim()),
      ...triggers,
    ])
      await db.prepare(s).run();
  }
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

async function lunaUser(name, monthly = 10000000) {
  const uid = (
    await db
      .prepare(
        "INSERT INTO users(username,password,role,services,rpm,daily_requests,concurrency,must_change,created,luna_monthly_tokens) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id",
      )
      .bind(
        name,
        "unused",
        "user",
        '["qwen"]',
        0,
        0,
        8,
        0,
        Date.now() / 1000,
        monthly,
      )
      .first()
  ).id;
  const key = "sk-acct-" + name;
  await db
    .prepare(
      "INSERT INTO keys(user_id,name,hash,prefix,services,expires,created) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      uid,
      name,
      await digest(key),
      "test-prefix",
      '["qwen"]',
      Date.now() / 1000 + 86400,
      Date.now() / 1000,
    )
    .run();
  return { uid, key };
}
async function lunaLease(key, path = "/v1/chat/completions") {
  const r = await internal("acquire", { raw: key, service: "qwen", path });
  assert.equal(r.status, 200);
  return r.body.lease;
}
function lunaCall(lease, payload = {}, responses = false) {
  return call(
    "/internal/openai/" + (responses ? "responses" : "chat-completions"),
    {
      model: "gpt-6-luna",
      ...(responses
        ? { input: "hi" }
        : { messages: [{ role: "user", content: "hi" }] }),
      ...payload,
    },
    { access: secret, headers: { "X-Gateway-Lease": lease } },
  );
}
test("Luna uses provider usage, shares account budget, refuses lease replay and never leaks upstream errors", async () => {
  const { uid, key } = await lunaUser("luna-json");
  const lease = await lunaLease(key);
  assert.equal(
    (await internal("luna-models", { lease })).body.data[0].id,
    "gpt-6-luna",
  );
  openaiMode = "json";
  let r = await lunaCall(lease);
  assert.equal(r.status, 200);
  const row = await db
    .prepare("SELECT * FROM luna_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.charged_tokens, 120);
  assert.equal(row.settled, 1);
  assert.equal((await lunaCall(lease)).status, 409);
  assert.equal(
    (
      await db
        .prepare("SELECT luna_monthly_tokens FROM users WHERE id=?")
        .bind(uid)
        .first()
    ).luna_monthly_tokens,
    10000000,
  );
  openaiMode = "reject";
  const rejected = await lunaLease(key);
  r = await lunaCall(rejected);
  assert.equal(r.status, 502);
  assert.doesNotMatch(
    JSON.stringify(r.body),
    /private upstream|test-openai-key/,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT charged_tokens FROM luna_usage WHERE lease=?")
        .bind(rejected)
        .first()
    ).charged_tokens,
    0,
  );
  openaiMode = "json";
});
test("Luna reservations are atomic across keys and access tokens, zero disables, prior months do not spend this month", async () => {
  const { uid, key } = await lunaUser("luna-budget", 6000);
  openaiMode = "unknown";
  const secondKey = "sk-acct-luna-second-key";
  await db
    .prepare(
      "INSERT INTO keys(user_id,name,hash,prefix,services,expires,created) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(
      uid,
      "second",
      await digest(secondKey),
      "test-prefix",
      '["qwen"]',
      Date.now() / 1000 + 86400,
      Date.now() / 1000,
    )
    .run();
  const family = "luna-test-family",
    access = "ai-at-luna-budget-test";
  await db
    .prepare("INSERT INTO auth_families VALUES(?,?,?,0)")
    .bind(family, uid, Date.now() / 1000 + 86400)
    .run();
  await db
    .prepare("INSERT INTO access_tokens VALUES(?,?,?)")
    .bind(await digest(access), family, Date.now() / 1000 + 86400)
    .run();
  const a = await lunaLease(secondKey),
    b = await lunaLease(access);
  const results = await Promise.all([
    lunaCall(a, { max_completion_tokens: 1 }),
    lunaCall(b, { max_completion_tokens: 1 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [429, 502]);
  await db
    .prepare("UPDATE luna_usage SET month='2000-01' WHERE user_id=?")
    .bind(uid)
    .run();
  assert.equal(
    (await lunaCall(await lunaLease(key), { max_completion_tokens: 1 })).status,
    502,
  );
  await db
    .prepare("UPDATE users SET luna_monthly_tokens=0 WHERE id=?")
    .bind(uid)
    .run();
  assert.equal(
    (await lunaCall(await lunaLease(key), { max_completion_tokens: 1 })).status,
    429,
  );
  openaiMode = "json";
});
test("Luna blocks bypass fields, non-text input and wrong service leases before calling provider", async () => {
  const { key } = await lunaUser("luna-validation");
  const lease = await lunaLease(key),
    before = providerCalls;
  for (const p of [
    { model: "gpt-6-astra" },
    { n: 20 },
    { service_tier: "priority" },
    { max_completion_tokens: 0 },
    { tools: [{ type: "web_search" }] },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/img" },
            },
          ],
        },
      ],
    },
  ])
    assert.ok([400, 422].includes((await lunaCall(lease, p)).status));
  assert.equal((await lunaCall("nonexistent")).status, 403);
  const wrong = await lunaLease(key, "/v1/models");
  assert.equal((await lunaCall(wrong)).status, 403);
  assert.equal(providerCalls, before);
  // Chat tool-call IDs link client-side function results, not stored provider state.
  const valid = await lunaCall(lease, {
    reasoning_effort: "none",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_client",
            type: "function",
            function: { name: "weather", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_client", content: "sunny" },
    ],
  });
  assert.equal(valid.status, 200);
});
test("Luna streams settle authoritative usage for Chat and Responses; truncated streams retain budget", async () => {
  const { key } = await lunaUser("luna-stream");
  for (const responses of [false, true]) {
    const lease = await lunaLease(
      key,
      responses ? "/v1/responses" : "/v1/chat/completions",
    );
    const r = await mf.dispatchFetch(
      "https://accounts.test/internal/openai/" +
        (responses ? "responses" : "chat-completions"),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
          "X-Gateway-Lease": lease,
        },
        body: JSON.stringify({
          model: "gpt-6-luna",
          ...(responses
            ? { input: "hi" }
            : { messages: [{ role: "user", content: "hi" }] }),
          stream: true,
        }),
      },
    );
    assert.equal(r.status, 200);
    assert.match(await r.text(), /data:/);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT charged_tokens,settled FROM luna_usage WHERE lease=?",
          )
          .bind(lease)
          .first()
      ).charged_tokens,
      120,
    );
  }
  openaiMode = "truncated";
  const lease = await lunaLease(key);
  const r = await mf.dispatchFetch(
    "https://accounts.test/internal/openai/chat-completions",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "X-Gateway-Lease": lease },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    },
  );
  await r.text();
  const row = await db
    .prepare("SELECT * FROM luna_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.settled, 0);
  assert.equal(row.charged_tokens, row.reserved_tokens);
  openaiMode = "json";
});
test("Luna budgets can only be changed by admins and new account defaults are applied", async () => {
  const me = await call("/account/me", undefined, { access: admin });
  assert.equal(
    (
      await call(
        "/admin/users/" + me.body.user.id,
        { luna_monthly_tokens: -1 },
        { method: "PATCH", access: admin },
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await call(
        "/admin/luna-defaults",
        { monthly_tokens: 2500000 },
        { method: "PATCH", access: admin },
      )
    ).status,
    200,
  );
  const r = await call(
    "/admin/users",
    { username: "luna-default" },
    { access: admin },
  );
  assert.equal(r.body.user.luna_monthly_tokens, 2500000);
  assert.equal(
    (
      await call(
        "/admin/users/" + r.body.user.id,
        { luna_monthly_tokens: 250000 },
        { method: "PATCH", access: admin },
      )
    ).body.luna_monthly_tokens,
    250000,
  );
  const balance = await call("/account/luna-usage", undefined, {
    access: admin,
  });
  assert.equal(balance.status, 200);
  assert.equal(balance.body.monthly_tokens, 10000000);
});
