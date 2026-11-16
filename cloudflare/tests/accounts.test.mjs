import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { proxySpeech } from "../src/audio.mjs";
import { edgeAPI } from "../src/edge.mjs";
import { Store } from "../src/store.mjs";
import { passwordHash, digest } from "../src/crypto.mjs";
let mf, db, admin;
let openaiMode = "json",
  providerCalls = 0;
let originCalls = 0,
  lastProviderPayload,
  lastAudioName;
async function provider(request) {
  if (new URL(request.url).hostname.endsWith("ipify.org")) {
    assert.equal(request.headers.get("Authorization"), null);
    return Response.json({ ip: "203.0.113.12" });
  }
  if (new URL(request.url).pathname === "/__diagnostics/network") {
    assert.equal(request.headers.get("Authorization"), null);
    assert.equal(request.headers.get("Cookie"), null);
    assert.match(
      request.headers.get("X-Diagnostic-Signature"),
      /^[a-f0-9]{64}$/,
    );
    return Response.json({
      schema: "network-reference-v1",
      scope: "same_zone_tunnel",
      observes_worker_tcp_source: false,
      headers: {
        "cf-ipcountry": "JP",
        "cf-ray": "abc-NRT",
        "cf-worker": "hilex.me",
      },
      sensitive_headers_present: {
        authorization: false,
        cookie: false,
        "x-api-key": false,
        "x-client-id": false,
      },
    });
  }
  if (new URL(request.url).hostname === "api.hilex.me") {
    originCalls++;
    assert.equal(request.headers.get("X-Edge-Secret"), secret);
    assert.equal(request.headers.get("Authorization"), null);
    assert.equal(request.headers.get("Cookie"), null);
    assert.match(request.headers.get("X-Edge-Lease"), /^[a-f0-9]{48}$/);
    if (new URL(request.url).pathname === "/__codec/decode")
      return new Response(testWav(1000), {
        headers: { "Content-Type": "audio/wav" },
      });
    return Response.json({ text: "local" });
  }
  assert.equal(new URL(request.url).hostname, "api.openai.com");
  assert.equal(request.headers.get("Authorization"), "Bearer test-openai-key");
  if (new URL(request.url).pathname === "/v1/audio/transcriptions") {
    const form = await request.formData();
    assert.equal(form.get("model"), "gpt-transcribe");
    lastAudioName = form.get("file").name;
    providerCalls++;
    if (openaiMode === "reject")
      return new Response("rejected", { status: 400 });
    if (form.get("stream") === "true")
      return new Response(
        'data: {"type":"transcript.text.done","text":"hello"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    return Response.json({ text: "hello", languages: [{ code: "en" }] });
  }
  const p = await request.json();
  lastProviderPayload = p;
  assert.equal(p.model, "gpt-6-luna");
  assert.equal(p.service_tier, "default");
  assert.equal(p.store, false);
  assert.equal(p.max_tokens, undefined);
  providerCalls++;
  if (openaiMode === "reject")
    return new Response("private upstream error", { status: 401 });
  if (openaiMode === "parameter-error")
    return Response.json(
      {
        error: {
          code: "unsupported_value",
          param: "reasoning_effort",
          message: "private tool contents",
        },
      },
      { status: 400, headers: { "x-request-id": "req_tools_test" } },
    );
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
      INFERENCE_CLIENT_IDS: JSON.stringify(["test-client-id"]),
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
  assert.match(await r.text(), /provider_stream_interrupted/);
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

function testWav(milliseconds = 1000) {
  const pcm = new Uint8Array(milliseconds * 32),
    wav = new Uint8Array(44 + pcm.length),
    view = new DataView(wav.buffer);
  for (const [at, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ])
    wav.set(new TextEncoder().encode(text), at);
  view.setUint32(4, wav.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, pcm.length, true);
  return wav;
}
async function audioUser(name, kind) {
  const r = await lunaUser(name);
  await db
    .prepare("UPDATE users SET services=? WHERE id=?")
    .bind(JSON.stringify(["qwen", kind]), r.uid)
    .run();
  await db
    .prepare("UPDATE keys SET services=? WHERE user_id=?")
    .bind(JSON.stringify(["qwen", kind]), r.uid)
    .run();
  return r;
}
async function audioLease(key, kind) {
  const r = await internal("acquire", {
    raw: key,
    service: kind,
    path: kind === "asr" ? "/v1/audio/transcriptions" : "/v1/audio/speech",
    metadata: {
      client_ip: "203.0.113.9",
      user_agent: "test-client",
      client_version: "1.2.3",
      device_id: "device-test",
    },
  });
  assert.equal(r.status, 200);
  return r.body.lease;
}
async function asrCall(lease, ms = 1000, extra = {}) {
  const form = new FormData();
  form.set("model", "gpt-transcribe");
  form.set("file", new Blob([testWav(ms)], { type: "audio/wav" }), "audio.wav");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const request = new Request(
    "https://accounts.test/internal/openai/transcriptions",
    { method: "POST", body: form },
  );
  return mf.dispatchFetch(request.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secret,
      "X-Gateway-Lease": lease,
      "Content-Type": request.headers.get("Content-Type"),
    },
    body: await request.arrayBuffer(),
  });
}
test("audio ASR measures PCM duration, atomically shares daily allowance, rejects replay and rolls over by day", async () => {
  const { uid, key } = await audioUser("audio-asr", "asr");
  await db
    .prepare("UPDATE users SET openai_asr_daily_seconds=1 WHERE id=?")
    .bind(uid)
    .run();
  const a = await audioLease(key, "asr"),
    b = await audioLease(key, "asr"),
    before = providerCalls;
  const responses = await Promise.all([asrCall(a), asrCall(b)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
  for (const r of responses) await r.text();
  assert.equal(providerCalls, before + 1);
  const rows = (
    await db
      .prepare("SELECT * FROM audio_usage WHERE user_id=?")
      .bind(uid)
      .all()
  ).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].charged_units, 1000);
  assert.equal(rows[0].settled, 1);
  assert.equal((await asrCall(rows[0].lease)).status, 409);
  await db
    .prepare("UPDATE audio_usage SET day='2000-01-01' WHERE user_id=?")
    .bind(uid)
    .run();
  assert.equal((await asrCall(await audioLease(key, "asr"))).status, 200);
});
test("ASR rejects malformed duration before provider use and streams final transcripts", async () => {
  const { key } = await audioUser("audio-asr-stream", "asr");
  const lease = await audioLease(key, "asr");
  assert.equal(
    (await asrCall(lease, 1000, { stream: "true", response_format: "text" }))
      .status,
    422,
  );
  const r = await asrCall(lease, 1000, { stream: "true" });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /transcript.text.done/);
  assert.equal(
    (
      await db
        .prepare("SELECT settled FROM audio_usage WHERE lease=?")
        .bind(lease)
        .first()
    ).settled,
    1,
  );
});
class MockRealtime extends EventTarget {
  constructor(mode = "success") {
    super();
    this.mode = mode;
    this.messages = [];
  }
  event(data) {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) }),
      ),
    );
  }
  accept() {
    this.event({ type: "session.created" });
  }
  send(raw) {
    const b = JSON.parse(raw);
    this.messages.push(b);
    if (b.type === "session.update") {
      assert.deepEqual(b.session.tools, []);
      assert.equal(b.session.audio.output.format.rate, 24000);
      this.event({ type: "session.updated" });
    } else if (b.type === "response.create") {
      assert.equal(b.response.conversation, "none");
      if (this.mode === "reject") this.event({ type: "error" });
      else if (this.mode === "disconnect")
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      else {
        this.event({ type: "response.output_audio.delta", delta: "AAAAAA==" });
        if (this.mode === "hold") return;
        this.event({
          type: "response.done",
          response: { status: "completed", id: "resp-audio" },
        });
      }
    }
  }
  close() {
    this.closed = true;
  }
}
async function ttsCall(lease, input = "你好🙂", mode = "success") {
  const ws = new MockRealtime(mode);
  const req = new Request("https://accounts.test/internal/openai/speech", {
    method: "POST",
    headers: { "X-Gateway-Lease": lease },
    body: JSON.stringify({
      model: "gpt-realtime-2.1-mini",
      input,
      response_format: "pcm",
    }),
  });
  return proxySpeech(
    req,
    { OPENAI_API_KEY: "test-key" },
    new Store(db),
    async (url, options) => {
      assert.match(url, /gpt-realtime-2.1-mini/);
      assert.equal(options.headers.Upgrade, "websocket");
      return { webSocket: ws };
    },
  );
}
test("Realtime TTS uses Unicode characters, refunds explicit rejections, retains unknown submissions and enforces daily caps", async () => {
  const { uid, key } = await audioUser("audio-tts", "tts");
  await db
    .prepare("UPDATE users SET openai_tts_daily_characters=3 WHERE id=?")
    .bind(uid)
    .run();
  const lease = await audioLease(key, "tts");
  const r = await ttsCall(lease);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  assert.equal(
    (
      await db
        .prepare("SELECT charged_units,settled FROM audio_usage WHERE lease=?")
        .bind(lease)
        .first()
    ).charged_units,
    3,
  );
  await assert.rejects(
    ttsCall(await audioLease(key, "tts"), "a"),
    (e) => e.status === 429,
  );
  await db
    .prepare("UPDATE users SET openai_tts_daily_characters=100 WHERE id=?")
    .bind(uid)
    .run();
  const rejected = await audioLease(key, "tts");
  await assert.rejects(ttsCall(rejected, "abc", "reject"));
  assert.equal(
    (
      await db
        .prepare("SELECT charged_units FROM audio_usage WHERE lease=?")
        .bind(rejected)
        .first()
    ).charged_units,
    0,
  );
  const unknown = await audioLease(key, "tts");
  await assert.rejects(ttsCall(unknown, "abc", "disconnect"));
  const row = await db
    .prepare("SELECT * FROM audio_usage WHERE lease=?")
    .bind(unknown)
    .first();
  assert.equal(row.charged_units, 3);
  assert.equal(row.settled, 0);
});
test("admin unified defaults, user overview, IP metadata and atomic bulk ban/unban", async () => {
  const defaults = await call("/admin/quota-defaults", undefined, {
    access: admin,
  });
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.openai_asr_daily_seconds, 1800);
  const patch = {
    ...defaults.body,
    luna_monthly_tokens: 10000000,
    openai_asr_daily_seconds: 2400,
    openai_tts_daily_characters: 600000,
  };
  assert.equal(
    (
      await call("/admin/quota-defaults", patch, {
        method: "PATCH",
        access: admin,
      })
    ).status,
    200,
  );
  const created = await call(
    "/admin/users",
    { username: "unified-defaults" },
    { access: admin },
  );
  assert.equal(created.body.user.openai_asr_daily_seconds, 2400);
  assert.equal(created.body.user.openai_tts_daily_characters, 600000);
  const overview = await call("/admin/overview?q=audio-asr", undefined, {
    access: admin,
  });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.matching >= 1);
  const target = overview.body.users.find((u) => u.username === "audio-asr");
  assert.equal(target.last_request_ip, "203.0.113.9");
  assert.equal(target.password, undefined);
  const details = await call(
    "/admin/users/" + target.id + "/details",
    undefined,
    { access: admin },
  );
  assert.equal(details.status, 200);
  assert.equal(details.body.requests[0].client_version, "1.2.3");
  assert.equal(details.body.ips[0].client_ip, "203.0.113.9");
  const ids = [target.id, created.body.user.id];
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        { ids, patch: { enabled: false } },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT enabled FROM users WHERE id=?")
        .bind(target.id)
        .first()
    ).enabled,
    0,
  );
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        { ids, patch: { enabled: true, openai_asr_daily_seconds: 1800 } },
        { access: admin },
      )
    ).status,
    200,
  );
  const me = await call("/account/me", undefined, { access: admin });
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        {
          ids: [created.body.user.id, me.body.user.id],
          patch: { enabled: false },
        },
        { access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT enabled FROM users WHERE id=?")
        .bind(created.body.user.id)
        .first()
    ).enabled,
    1,
  );
  assert.equal(
    (
      await call(
        "/admin/users/bulk",
        { ids, patch: { role: "admin" } },
        { access: admin },
      )
    ).status,
    422,
  );
  assert.equal(
    (await call("/admin/overview?day=2026-02-30", undefined, { access: admin }))
      .status,
    422,
  );
});

test("voice-only keys discover only their permitted cloud models", async () => {
  const { uid, key } = await audioUser("catalog-asr-only", "asr");
  await db
    .prepare("UPDATE keys SET services='[\"asr\"]' WHERE user_id=?")
    .bind(uid)
    .run();
  const grant = await internal("acquire", {
    raw: key,
    service: "catalog",
    path: "/v1/models",
  });
  assert.equal(grant.status, 200);
  const catalog = await internal("openai-models", { lease: grant.body.lease });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.services, ["asr"]);
  assert.deepEqual(
    catalog.body.data.map((m) => m.id),
    ["gpt-transcribe"],
  );
});
test("diagnostics persist safe metadata and request ID lookup is admin-only", async () => {
  const { key } = await lunaUser("diagnostic-test");
  const lease = await lunaLease(key);
  await internal("finish", {
    lease,
    status: 422,
    trace: {
      request_id: "diagnostic-request",
      model: "gpt-wrong",
      provider: "local",
      protocol: "http",
      failure_stage: "validation",
      error_code: "invalid_audio_model",
      duration_ms: 12,
    },
  });
  const rows = await call(
    "/admin/requests?request_id=diagnostic-request",
    undefined,
    { access: admin },
  );
  assert.equal(rows.status, 200);
  assert.equal(rows.body[0].failure_stage, "validation");
  assert.equal(rows.body[0].duration_ms, 12);
  assert.equal(rows.body[0].model, "gpt-wrong");
  assert.equal(
    (await call("/admin/requests?request_id=diagnostic-request")).status,
    401,
  );
});
test("quota reconciliation is audited, compare-and-set protected, bounded and idempotent", async () => {
  const { uid, key } = await audioUser("quota-review", "tts");
  const lease = await audioLease(key, "tts");
  await assert.rejects(ttsCall(lease, "abc", "disconnect"));
  await internal("finish", { lease, status: 502 });
  const b = {
    id: "quota-review-operation",
    kind: "audio",
    lease,
    expected_units: 3,
    units: 1,
    reason: "verified provider test usage",
  };
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).status,
    409,
  );
  await db
    .prepare("UPDATE requests SET ended=unixepoch()-120 WHERE id=?")
    .bind(lease)
    .run();
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).status,
    200,
  );
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).body
      .replayed,
    true,
  );
  assert.equal(
    (
      await call(
        "/admin/quota-adjustments",
        { ...b, units: 0 },
        { access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/quota-adjustments",
        { ...b, id: "another-id" },
        { access: admin },
      )
    ).status,
    409,
  );
  const row = await db
    .prepare("SELECT charged_units,settled FROM audio_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.charged_units, 1);
  assert.equal(row.settled, 1);
  const review = await call(
    "/admin/quota-review?state=settled&user_id=" + uid,
    undefined,
    { access: admin },
  );
  assert.equal(review.body[0].lease, lease);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM quota_adjustments WHERE lease=?")
        .bind(lease)
        .first()
    ).n,
    1,
  );
});
test("Realtime streaming emits PCM before settlement, and still settles the same character budget", async () => {
  const { key } = await audioUser("tts-stream", "tts");
  const lease = await audioLease(key, "tts");
  const req = new Request("https://accounts.test/internal/openai/speech", {
    method: "POST",
    headers: { "X-Gateway-Lease": lease },
    body: JSON.stringify({
      model: "gpt-realtime-2.1-mini",
      input: "你好🙂",
      response_format: "pcm",
      stream: true,
    }),
  });
  const jobs = [];
  const r = await proxySpeech(
    req,
    { OPENAI_API_KEY: "test-key" },
    new Store(db),
    async () => ({ webSocket: new MockRealtime() }),
    {
      waitUntil(p) {
        jobs.push(p);
      },
    },
  );
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  await Promise.all(jobs);
  const row = await db
    .prepare("SELECT charged_units,settled FROM audio_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.charged_units, 3);
  assert.equal(row.settled, 1);
});

async function apiCall(path, key, payload, headers = {}) {
  const r = await mf.dispatchFetch("https://api.hilex.me" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, headers: r.headers, body: await r.json() };
}
test("edge API authenticates directly, discovers cloud models without origin and settles Luna once", async () => {
  const { uid, key } = await lunaUser("edge-luna");
  const origins = originCalls;
  const models = await apiCall("/v1/models", key);
  assert.equal(models.status, 200);
  assert.equal(models.headers.get("X-Inference-Execution"), "edge");
  assert.equal(models.body.data[0].id, "gpt-6-luna");
  assert.equal(originCalls, origins);
  const r = await apiCall("/v1/chat/completions", key, {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.status, 200);
  assert.equal(originCalls, origins);
  const rows = (
    await db.prepare("SELECT * FROM requests WHERE user_id=?").bind(uid).all()
  ).results;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.ended));
  assert.equal(rows.find((r) => r.model === "gpt-6-luna").prompt_tokens, 100);
  assert.equal((await apiCall("/v1/models", "invalid")).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch("https://api.hilex.me/__codec/decode", {
        method: "POST",
        body: "raw",
      })
    ).status,
    404,
  );
});
test("edge ASR WAV skips origin; compressed inputs use only the protected codec", async () => {
  const { key } = await audioUser("edge-asr", "asr");
  const initial = originCalls;
  async function run(bytes, name) {
    const form = new FormData();
    form.set("model", "gpt-transcribe");
    form.set("file", new Blob([bytes]), name);
    const req = new Request("https://api.hilex.me/v1/audio/transcriptions", {
      method: "POST",
      body: form,
    });
    const r = await mf.dispatchFetch(req.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": req.headers.get("Content-Type"),
      },
      body: await req.arrayBuffer(),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  }
  assert.equal((await run(testWav(1000), "audio.wav")).text, "hello");
  assert.equal(originCalls, initial);
  await run(new TextEncoder().encode("compressed fixture"), "audio.mp3");
  assert.equal(originCalls, initial + 1);
  const fixtures = JSON.parse(
    await readFile("tests/audio-fixtures.json", "utf8"),
  );
  for (const f of fixtures) {
    await run(new Uint8Array(Buffer.from(f.base64, "base64")), "wrong.wav");
    assert.equal(originCalls, initial + 1);
    assert.notEqual(lastAudioName, "audio.wav");
  }
});
test("edge forwards legacy local requests with server-only headers and prevents credential confusion", async () => {
  const { key } = await audioUser("edge-local", "tts");
  const r = await apiCall(
    "/v1/audio/speech",
    key,
    { input: "legacy" },
    {
      "X-Inference-Provider": "local",
      "X-Edge-Secret": "attacker",
      Cookie: "sensitive",
    },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.text, "local");
  assert.equal(
    (await apiCall("/v1/audio/speech", key, { model: "tts-1", input: "hi" }))
      .status,
    422,
  );
  assert.equal(
    (
      await apiCall("/v1/models", key, undefined, {
        "X-API-Key": "sk-acct-conflict",
      })
    ).status,
    401,
  );
});
test("edge TTS defaults to PCM, supports streaming, rejects other formats before provider calls", async () => {
  const { uid, key } = await audioUser("edge-tts", "tts");
  const original = globalThis.fetch;
  const jobs = [];
  let realtimeCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/v1/realtime?")) {
      realtimeCalls++;
      return { webSocket: new MockRealtime() };
    }
    return provider(new Request(url, { ...options, duplex: "half" }));
  };
  try {
    const env = {
      DB: db,
      OPENAI_API_KEY: "test-openai-key",
      INTERNAL_SECRET: secret,
    };
    async function run(body) {
      const r = await edgeAPI(
        new Request("https://api.hilex.me/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-realtime-2.1-mini",
            input: "hi",
            ...body,
          }),
        }),
        env,
        {
          waitUntil(p) {
            jobs.push(p);
          },
        },
      );
      return r;
    }
    const before = originCalls;
    for (const payload of [
      {},
      { response_format: "pcm" },
      { response_format: "pcm", stream: true },
    ]) {
      const r = await run(payload);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("Content-Type"), "audio/pcm");
      assert.equal(r.headers.get("X-Audio-Sample-Rate"), "24000");
      assert.ok((await r.arrayBuffer()).byteLength > 0);
    }
    for (const fmt of ["mp3", "opus", "flac", "wav"])
      for (const stream of [false, true]) {
        const r = await run({ response_format: fmt, stream });
        assert.equal(r.status, 422);
        assert.equal((await r.json()).error_code, "unsupported_audio_format");
      }
    await Promise.all(jobs);
    assert.equal(originCalls, before);
    assert.equal(realtimeCalls, 3);
    assert.equal(
      (
        await db
          .prepare(
            "SELECT sum(charged_units) n,count(*) requests FROM audio_usage WHERE user_id=?",
          )
          .bind(uid)
          .first()
      ).n,
      6,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) n FROM audio_usage WHERE user_id=?")
          .bind(uid)
          .first()
      ).n,
      3,
    );
    const models = await apiCall("/v1/models?output_modalities=all", key);
    const speech = models.body.data.find(
      (m) => m.id === "gpt-realtime-2.1-mini",
    );
    assert.deepEqual(speech.audio.response_formats, ["pcm"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Edge Luna tools normalize arguments and retain safe provider diagnostics with zero charge", async () => {
  const { uid, key } = await lunaUser("edge-tools");
  const payload = {
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "lookup" }],
    reasoning_effort: "medium",
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
  const ok = await apiCall("/v1/chat/completions", key, payload);
  assert.equal(ok.status, 200);
  assert.equal(lastProviderPayload.reasoning_effort, "none");
  assert.match(
    ok.headers.get("X-Inference-Compatibility"),
    /chat-tools-reasoning-none/,
  );
  openaiMode = "parameter-error";
  try {
    const r = await apiCall("/v1/chat/completions", key, payload);
    assert.equal(r.status, 400);
    assert.equal(r.body.upstream_error_param, "reasoning_effort");
    assert.ok(!JSON.stringify(r.body).includes("private tool contents"));
    const row = await db
      .prepare(
        "SELECT r.*,l.charged_tokens,l.settled FROM requests r JOIN luna_usage l ON l.lease=r.id WHERE r.request_id=?",
      )
      .bind(r.body.request_id)
      .first();
    assert.equal(row.upstream_error_code, "unsupported_value");
    assert.equal(row.upstream_error_param, "reasoning_effort");
    assert.equal(row.upstream_request_id, "req_tools_test");
    assert.equal(row.failure_stage, "upstream_rejected");
    assert.equal(row.upstream_status, 400);
    assert.equal(row.charged_tokens, 0);
    assert.equal(row.settled, 1);
  } finally {
    openaiMode = "json";
  }
});

test("OpenAI 403 records reference probe and provider identifiers without changing refund", async () => {
  const { uid, key } = await lunaUser("edge-egress-diagnostics");
  const original = globalThis.fetch,
    jobs = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("api64.ipify.org")) {
      assert.deepEqual(options.headers, { Accept: "application/json" });
      return Response.json({ ip: "203.0.113.42" });
    }
    return Response.json(
      { error: { code: "unsupported_country_region_territory" } },
      {
        status: 403,
        headers: { "x-request-id": "req_geo", "cf-ray": "abc-NRT" },
      },
    );
  };
  try {
    const request = new Request("https://api.hilex.me/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "cf-ray": "def-NRT",
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    Object.defineProperty(request, "cf", {
      value: { colo: "NRT", country: "JP" },
    });
    const r = await edgeAPI(
      request,
      { DB: db, OPENAI_API_KEY: "test-key" },
      { waitUntil: (p) => jobs.push(p) },
    );
    assert.equal(r.status, 502);
    const error = await r.json();
    await Promise.all(jobs);
    assert.equal(
      error.upstream_error_code,
      "unsupported_country_region_territory",
    );
    assert.equal(error.egress_probe_ip, undefined);
    const row = await db
      .prepare(
        "SELECT r.*,l.charged_tokens,l.settled FROM requests r JOIN luna_usage l ON l.lease=r.id WHERE r.request_id=?",
      )
      .bind(error.request_id)
      .first();
    assert.equal(row.ingress_colo, "NRT");
    assert.equal(row.client_country, "JP");
    assert.equal(row.ingress_ray, "def-NRT");
    assert.equal(row.upstream_request_id, "req_geo");
    assert.equal(row.upstream_cf_ray, "abc-NRT");
    assert.equal(row.egress_probe_ip, "203.0.113.42");
    assert.equal(row.egress_probe_status, "observed_reference");
    assert.equal(row.egress_probe_target, "api64.ipify.org");
    assert.equal(row.charged_tokens, 0);
    assert.equal(row.settled, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Global budget controls are admin-only, atomic across accounts, and zero prevents provider calls", async () => {
  const saved = await call("/admin/operations", undefined, { access: admin });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.limits.luna_monthly_usd, 200);
  assert.equal((await call("/admin/operations")).status, 401);
  const limits = { ...saved.body.limits, luna_monthly_usd: 0 };
  try {
    assert.equal(
      (
        await call("/admin/global-limits", limits, {
          method: "PATCH",
          access: admin,
        })
      ).status,
      200,
    );
    const { key } = await lunaUser("global-zero"),
      before = providerCalls;
    const r = await apiCall("/v1/chat/completions", key, {
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.status, 429);
    assert.equal(r.body.error_code, "global_budget_exhausted");
    assert.equal(r.body.retryable, false);
    assert.equal(providerCalls, before);
    await call(
      "/admin/global-limits",
      { ...limits, luna_monthly_usd: 0.01 },
      { method: "PATCH", access: admin },
    );
    const { key: k1, uid } = await lunaUser("global-race-one"),
      { key: k2, uid: uid2 } = await lunaUser("global-race-two");
    const leases = [await lunaLease(k1), await lunaLease(k2)];
    const insert = (lease, user) =>
      db
        .prepare(
          "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens,reserved_cost_nanos,charged_cost_nanos) VALUES(?,?,?,100,100,50,50,9000000,9000000)",
        )
        .bind(lease, user, "2099-01")
        .run();
    const attempts = await Promise.allSettled([
      insert(leases[0], uid),
      insert(leases[1], uid2),
    ]);
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    const first = attempts.findIndex((r) => r.status === "fulfilled");
    await db
      .prepare("DELETE FROM luna_usage WHERE lease=?")
      .bind(leases[first])
      .run();
    await assert.rejects(insert(leases[1 - first], first === 0 ? uid2 : uid));
    // Account deletion must not erase global spend. Synthetic test spend can be explicitly removed.
    await db
      .prepare("DELETE FROM luna_spend WHERE month=?")
      .bind("2099-01")
      .run();
  } finally {
    await call("/admin/global-limits", saved.body.limits, {
      method: "PATCH",
      access: admin,
    });
  }
});

test("Registration burst and account identity limits apply across IPs; open registration remains available", async () => {
  const store = new Store(db),
    ts = Date.now() / 1000;
  for (let n = 0; n < 10; n++)
    await store.rateLimit("identity-ip-" + n, "login", " victim@example.org ");
  await assert.rejects(
    store.rateLimit("new-identity-ip", "login", "VICTIM@example.org"),
    (e) => e.status === 429,
  );
  await db.prepare("DELETE FROM registration_attempts").run();
  const saved = JSON.parse(
    (
      await store.first(
        "SELECT value FROM settings WHERE name='registration_policy'",
      )
    ).value,
  );
  await store.run(
    "UPDATE settings SET value=? WHERE name='registration_policy'",
    JSON.stringify({ ...saved, global_minute: 2 }),
  );
  try {
    await store.rateLimit("register-one", "register", "one@example.org");
    await store.rateLimit("register-two", "register", "two@example.org");
    await assert.rejects(
      store.rateLimit("register-three", "register", "three@example.org"),
      (e) => e.status === 429,
    );
  } finally {
    await store.run(
      "UPDATE settings SET value=? WHERE name='registration_policy'",
      JSON.stringify(saved),
    );
    await db.prepare("DELETE FROM registration_attempts").run();
  }
});

test("Maintenance preserves live refresh replay evidence and financial ledgers while archiving old nonbillable requests", async () => {
  const { maintenance, monitor } = await import("../src/operations.mjs");
  const store = new Store(db);
  const { uid } = await lunaUser("retention-test");
  const old = Date.now() / 1000 - 100 * 86400;
  await store.run(
    "INSERT INTO requests(id,user_id,service,path,started,day,ended,status,response_bytes,client_ip) VALUES('old-archive',?,'qwen','/v1/models',?,'2026-01-01',?,200,12,'203.0.113.3')",
    uid,
    old,
    old + 1,
  );
  await maintenance(store);
  assert.equal(
    await store.first("SELECT * FROM requests WHERE id='old-archive'"),
    null,
  );
  assert.equal(
    (
      await store.first(
        "SELECT total,response_bytes FROM request_history WHERE user_id=?",
        uid,
      )
    ).total,
    1,
  );
  await maintenance(store);
  assert.equal(
    (
      await store.first(
        "SELECT total FROM request_history WHERE user_id=?",
        uid,
      )
    ).total,
    1,
  );
  await monitor(store);
  const ops = await call("/admin/operations", undefined, { access: admin });
  assert.equal(ops.status, 200);
  assert.ok(Array.isArray(ops.body.alerts));
});

test("Cancelling PCM output closes the upstream Realtime session and preserves submitted usage", async () => {
  const { key } = await audioUser("tts-cancel", "tts");
  const lease = await audioLease(key, "tts");
  const ws = new MockRealtime("hold"),
    jobs = [];
  const request = new Request("https://worker/internal/openai/speech", {
    method: "POST",
    headers: { "X-Gateway-Lease": lease },
    body: JSON.stringify({
      model: "gpt-realtime-2.1-mini",
      input: "cancel me",
      stream: true,
      response_format: "pcm",
    }),
  });
  const r = await proxySpeech(
    request,
    { OPENAI_API_KEY: "key" },
    new Store(db),
    async () => ({ webSocket: ws }),
    { waitUntil: (p) => jobs.push(p) },
  );
  const reader = r.body.getReader();
  assert.ok((await reader.read()).value.length);
  await reader.cancel();
  await Promise.all(jobs);
  assert.equal(ws.closed, true);
  const row = await db
    .prepare("SELECT settled,charged_units FROM audio_usage WHERE lease=?")
    .bind(lease)
    .first();
  assert.equal(row.settled, 0);
  assert.equal(row.charged_units, 9);
});

test("Retention keeps live used refresh tokens and old financial requests; cost reconciliation is audited", async () => {
  const { maintenance } = await import("../src/operations.mjs");
  const store = new Store(db),
    ts = Date.now() / 1000;
  const { uid, key } = await lunaUser("financial-retention");
  await store.run(
    "INSERT INTO auth_families(id,user_id,expires,revoked) VALUES('live-replay-family',?,?,0)",
    uid,
    ts + 3600,
  );
  await store.run(
    "INSERT INTO refresh_tokens(hash,family_id,expires,used) VALUES('retained-used','live-replay-family',?,1)",
    ts + 3600,
  );
  const lease = await lunaLease(key);
  await store.run(
    "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens,reserved_cost_nanos,charged_cost_nanos) VALUES(?,?,?,1000,1000,500,500,1000000,1000000)",
    lease,
    uid,
    "2026-01",
  );
  await store.run(
    "UPDATE requests SET started=?,ended=?,status=504,client_ip='203.0.113.8' WHERE id=?",
    ts - 100 * 86400,
    ts - 100 * 86400 + 1,
    lease,
  );
  await maintenance(store);
  assert.ok(
    await store.first(
      "SELECT * FROM refresh_tokens WHERE hash='retained-used'",
    ),
  );
  assert.equal(
    (await store.first("SELECT client_ip FROM requests WHERE id=?", lease))
      .client_ip,
    null,
  );
  const b = {
    id: "cost-adjustment-id",
    kind: "luna",
    lease,
    expected_units: 1000,
    units: 0,
    reason: "Confirmed rejected request, zero provider usage",
    expected_cost_nanos: 1000000,
    cost_nanos: 0,
  };
  const adjusted = await call("/admin/quota-adjustments", b, { access: admin });
  assert.equal(adjusted.status, 200);
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    0,
  );
  assert.equal(
    (await call("/admin/quota-adjustments", b, { access: admin })).body
      .replayed,
    true,
  );
});

test("Old Worker inserts and in-flight settlements cannot bypass the new global cost ledger", async () => {
  const { uid, key } = await lunaUser("legacy-cost-compat");
  const lease = await lunaLease(key);
  const store = new Store(db);
  await store.run(
    "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens) VALUES(?,?,?,1000,1000,500,500)",
    lease,
    uid,
    "2026-11",
  );
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    312500,
  );
  await store.run(
    "UPDATE luna_usage SET charged_tokens=120,settled=1,prompt_tokens=100,completion_tokens=20,cached_tokens=40 WHERE lease=?",
    lease,
  );
  assert.equal(
    (
      await store.first(
        "SELECT cost_nanos FROM luna_spend WHERE lease=?",
        lease,
      )
    ).cost_nanos,
    16400,
  );
  assert.equal(
    (
      await store.first(
        "SELECT charged_cost_nanos FROM luna_usage WHERE lease=?",
        lease,
      )
    ).charged_cost_nanos,
    16400,
  );
});

test("Optional global audio limits survive account usage deletion", async () => {
  const store = new Store(db),
    saved = JSON.parse(
      (
        await store.first(
          "SELECT value FROM settings WHERE name='global_limits'",
        )
      ).value,
    );
  const { uid, key } = await audioUser("global-audio-ledger", "tts");
  const leases = [await audioLease(key, "tts"), await audioLease(key, "tts")];
  const insert = (lease) =>
    store.run(
      "INSERT INTO audio_usage(lease,user_id,day,kind,reserved_units,charged_units) VALUES(?,?,'2099-01-01','tts',100,100)",
      lease,
      uid,
    );
  try {
    await store.run(
      "UPDATE settings SET value=? WHERE name='global_limits'",
      JSON.stringify({ ...saved, tts_daily_characters: 150 }),
    );
    await insert(leases[0]);
    await store.run("DELETE FROM audio_usage WHERE lease=?", leases[0]);
    await assert.rejects(insert(leases[1]), (e) =>
      String(e).includes("global_audio_budget_exhausted"),
    );
  } finally {
    await store.run(
      "UPDATE settings SET value=? WHERE name='global_limits'",
      JSON.stringify(saved),
    );
    await store.run("DELETE FROM audio_spend WHERE day='2099-01-01'");
  }
});

test("Network statistics retain successful and failed cohorts and bundles exclude customer identifiers", async () => {
  const store = new Store(db),
    { uid } = await lunaUser("network-stats"),
    ts = Date.now() / 1000;
  for (let n = 0; n < 4; n++)
    await store.run(
      "INSERT INTO requests(id,user_id,service,path,started,ended,day,status,provider,model,protocol,request_id,upstream_status,upstream_error_code,ingress_colo,client_country,client_ip,user_agent,release_sha,upstream_attempted,egress_probe_ip) VALUES(?,?,'qwen','/v1/chat/completions',?,?,'2026-11-16',?,'openai','network-fixture','http',?,?,?,?,?,'203.0.113.77','PRIVATE_USER_AGENT','test-release',1,'203.0.113.77')",
      "network-fixture-" + n,
      uid,
      ts - 10 + n,
      ts - 9 + n,
      n < 2 ? 200 : 502,
      "network-safe-" + n,
      n < 2 ? 200 : 403,
      n < 2 ? null : "unsupported_country_region_territory",
      n < 2 ? "NRT" : "LAX",
      n < 2 ? "JP" : "HK",
    );
  await store.run(
    "INSERT INTO network_observations(id,lease,created,trigger,result) VALUES('network-observation','network-fixture-2',?,'provider_403',?)",
    Math.floor(ts),
    JSON.stringify({
      reference: {
        ip: "203.0.113.77",
        target: "api.ipify.org",
        status: "observed_reference",
      },
      controlled: {
        headers: { "cf-connecting-ip": "203.0.113.77", "cf-ipcountry": "HK" },
      },
    }),
  );
  assert.equal((await call("/admin/network-stats")).status, 401);
  const response = await call(
    "/admin/network-stats?hours=1&model=network-fixture",
    undefined,
    { access: admin },
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.requests, 4);
  assert.equal(
    response.body.groups.find((r) => r.country === "JP").success_rate,
    1,
  );
  assert.equal(
    response.body.groups.find((r) => r.country === "HK").region_error_rate,
    1,
  );
  assert.equal(
    (await call("/admin/network-stats?hours=999", undefined, { access: admin }))
      .status,
    422,
  );
  const packet = await call(
    "/admin/diagnostic-bundle?request_id=network-safe-2",
    undefined,
    { access: admin },
  );
  assert.equal(packet.status, 200);
  const text = JSON.stringify(packet.body);
  for (const value of ["203.0.113.77", "PRIVATE_USER_AGENT", "network-stats"])
    assert.ok(!text.includes(value));
  assert.equal(packet.body.request.release_sha, "test-release");
  assert.equal(
    packet.body.observation.result.controlled.ip_headers_present[
      "cf-connecting-ip"
    ],
    true,
  );
  const normal = await store.createUser(
    "network-normal",
    "password-for-normal",
    { must_change: 0 },
  );
  const login = await store.login(
    "network-normal",
    "password-for-normal",
    "network-normal-ip",
  );
  assert.equal(
    (
      await call("/admin/network-stats", undefined, {
        access: login.body.access_token,
      })
    ).status,
    403,
  );
  const privateRoute = await mf.dispatchFetch(
    "https://api.hilex.me/__diagnostics/network",
  );
  assert.equal(privateRoute.status, 404);
  const probe = await call("/admin/network-probe", {}, { access: admin });
  assert.equal(probe.status, 200);
  assert.equal(
    probe.body.result.controlled.status,
    "observed_metadata",
    JSON.stringify(probe.body),
  );
  assert.equal(
    (await call("/admin/network-probe", {}, { access: admin })).status,
    429,
  );
});

test("Alert deliveries are deduplicated, signed, retried and expose only safe status", async () => {
  const { enqueueAlerts, deliverNotifications, notificationStatus } =
    await import("../src/notifications.mjs");
  const store = new Store(db),
    ts = Date.now() / 1000;
  await store.run("DELETE FROM alert_deliveries");
  await store.run("UPDATE operational_alerts SET state='resolved'");
  await store.run(
    "INSERT OR REPLACE INTO operational_alerts(kind,first_seen,last_seen,state,details,episode) VALUES('delivery_fixture',?,?,'open',?,1)",
    ts,
    ts,
    JSON.stringify({ count: 3, private: "PRIVATE_SENTINEL" }),
  );
  const env = {
    ALERT_WEBHOOK_URL: "https://alerts.example.test/ingest?token=PRIVATE_URL",
    ALERT_WEBHOOK_SECRET: "test-webhook-signing-secret",
  };
  await enqueueAlerts(store, env);
  await enqueueAlerts(store, env);
  assert.equal(
    (
      await store.first(
        "SELECT count(*) n FROM alert_deliveries WHERE kind='delivery_fixture'",
      )
    ).n,
    1,
  );
  let attempts = 0,
    deliveryId;
  const transport = async (url, options) => {
    attempts++;
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.redirect, "manual");
    assert.ok(options.headers["X-Alert-Signature"]);
    const body = JSON.parse(options.body);
    assert.ok(!options.body.includes("PRIVATE_SENTINEL"));
    assert.equal(body.details.count, 3);
    if (!deliveryId) deliveryId = options.headers["Idempotency-Key"];
    else assert.equal(options.headers["Idempotency-Key"], deliveryId);
    if (attempts === 1) throw new DOMException("PRIVATE_URL", "TimeoutError");
    return new Response(null, { status: 204 });
  };
  await deliverNotifications(store, env, transport);
  assert.equal(
    (
      await store.first(
        "SELECT error_code FROM alert_deliveries WHERE id=?",
        deliveryId,
      )
    ).error_code,
    "timeout",
  );
  await store.run(
    "UPDATE alert_deliveries SET next_attempt=0 WHERE id=?",
    deliveryId,
  );
  await Promise.all([
    deliverNotifications(store, env, transport),
    deliverNotifications(store, env, transport),
  ]);
  assert.equal(attempts, 2);
  const status = await notificationStatus(store, env);
  assert.equal(status.deliveries[0].status, "sent");
  assert.ok(!JSON.stringify(status).includes("PRIVATE_URL"));
  assert.equal(status.destination_host, "alerts.example.test");
  assert.equal(
    (await call("/admin/notifications/test", {}, { access: admin })).status,
    200,
  );
});

test("Permanent webhook failures stop retries and acknowledgement expires after one hour", async () => {
  const { deliverNotifications } = await import("../src/notifications.mjs"),
    { operationalAlert } = await import("../src/operations.mjs");
  const store = new Store(db),
    ts = Date.now() / 1000;
  await store.run(
    "INSERT INTO alert_deliveries(id,kind,episode,event_state,created,payload) VALUES('permanent-delivery','permanent_fixture',1,'open',?,'{}')",
    ts,
  );
  let calls = 0;
  const env = { ALERT_WEBHOOK_URL: "https://alerts.example.test/hook" };
  const transport = async () => {
    calls++;
    return new Response(null, { status: 401 });
  };
  await deliverNotifications(store, env, transport);
  await deliverNotifications(store, env, transport);
  assert.equal(calls, 1);
  const row = await store.first(
    "SELECT attempts,error_code FROM alert_deliveries WHERE id='permanent-delivery'",
  );
  assert.equal(row.attempts, 3);
  assert.equal(row.error_code, "http_401");
  await operationalAlert(store, "acknowledgement_fixture", { count: 1 });
  assert.equal(
    (
      await call(
        "/admin/alerts/acknowledge",
        { kind: "acknowledgement_fixture" },
        { access: admin },
      )
    ).status,
    200,
  );
  await operationalAlert(store, "acknowledgement_fixture", { count: 2 });
  assert.equal(
    (
      await store.first(
        "SELECT state FROM operational_alerts WHERE kind='acknowledgement_fixture'",
      )
    ).state,
    "acknowledged",
  );
  await store.run(
    "UPDATE operational_alerts SET acknowledged_at=? WHERE kind='acknowledgement_fixture'",
    ts - 7200,
  );
  await operationalAlert(store, "acknowledgement_fixture", { count: 3 });
  assert.equal(
    (
      await store.first(
        "SELECT state FROM operational_alerts WHERE kind='acknowledgement_fixture'",
      )
    ).state,
    "open",
  );
});

test("Project inbox is the default destination without self HTTP calls and read state is per administrator", async () => {
  const { deliverNotifications, notificationStatus } =
      await import("../src/notifications.mjs"),
    store = new Store(db),
    ts = Date.now() / 1000;
  const status = await notificationStatus(store, {});
  assert.equal(status.configured, true);
  assert.equal(status.external_configured, false);
  assert.equal(status.destination_url, "https://accounts.hilex.me/#alerts");
  await store.run(
    "INSERT INTO alert_deliveries(id,kind,episode,event_state,created,payload) VALUES('site-message-fixture','test',0,'open',?,?)",
    ts,
    JSON.stringify({
      kind: "test",
      details: { count: 1 },
      dashboard: "https://accounts.hilex.me/#alerts",
    }),
  );
  let posts = 0;
  await deliverNotifications(store, {}, async () => {
    posts++;
    throw new Error("No HTTP for internal destination");
  });
  assert.equal(posts, 0);
  const delivered = await store.first(
    "SELECT status,channel FROM alert_deliveries WHERE id='site-message-fixture'",
  );
  assert.equal(delivered.status, "sent");
  assert.equal(delivered.channel, "in_app");
  assert.equal((await call("/admin/notifications")).status, 401);
  const before = await call("/admin/notifications?state=unread", undefined, {
    access: admin,
  });
  assert.ok(before.body.items.some((n) => n.id === "site-message-fixture"));
  assert.equal(
    (
      await call(
        "/admin/notifications/read",
        { ids: ["site-message-fixture"] },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/admin/notifications/read",
        { ids: ["site-message-fixture"] },
        { access: admin },
      )
    ).status,
    200,
  );
  const after = await call("/admin/notifications?state=unread", undefined, {
    access: admin,
  });
  assert.equal(after.body.unread, before.body.unread - 1);
  const other = await store.createUser(
    "inbox-admin-two",
    "inbox-test-password",
    { role: "admin", must_change: 0 },
  );
  const access = (
    await store.login(
      "inbox-admin-two",
      "inbox-test-password",
      "inbox-admin-ip",
    )
  ).body.access_token;
  const theirs = await call("/admin/notifications?state=unread", undefined, {
    access,
  });
  assert.ok(theirs.body.items.some((n) => n.id === "site-message-fixture"));
  const normal = (
    await store.login(
      "network-normal",
      "password-for-normal",
      "inbox-normal-ip",
    )
  ).body.access_token;
  assert.equal(
    (await call("/admin/notifications", undefined, { access: normal })).status,
    403,
  );
  assert.equal(
    (await call("/admin/notifications/read", { ids: [] }, { access: admin }))
      .status,
    422,
  );
});

test("Customer notices isolate recipients, synchronize reads and enforce draft lifecycle", async () => {
  const store = new Store(db),
    password = "customer-notice-password";
  const a = await store.createUser("notice-reader-a", password, {
      must_change: 0,
    }),
    b = await store.createUser("notice-reader-b", password, { must_change: 0 });
  const access = (await store.login(a.username, password, "notice-a-ip")).body
      .access_token,
    other = (await store.login(b.username, password, "notice-b-ip")).body
      .access_token;
  const draft = {
    title: "服务公告 <script>",
    body: "纯文本\n新功能已上线",
    audience: "all",
    priority: "important",
  };
  const create = await call("/admin/notices", draft, { access: admin });
  assert.equal(create.status, 200);
  const id = create.body.id;
  assert.equal((await call("/account/notices")).status, 401);
  assert.equal((await call("/admin/notices", draft, { access })).status, 403);
  assert.equal(
    (await call("/account/notices", undefined, { access })).body.total,
    0,
  );
  const edit = await call(
    "/admin/notices/" + id,
    { ...draft, title: "已更新", version: 1 },
    { access: admin, method: "PATCH" },
  );
  assert.equal(edit.body.version, 2);
  assert.equal(
    (
      await call(
        "/admin/notices/" + id,
        { ...draft, version: 1 },
        { access: admin, method: "PATCH" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/publish",
        { version: 1 },
        { access: admin },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/publish",
        { version: 2 },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id,
        { ...draft, version: 3 },
        { access: admin, method: "PATCH" },
      )
    ).status,
    409,
  );
  let listed = (await call("/account/notices", undefined, { access })).body;
  assert.equal(listed.unread, 1);
  assert.equal(listed.items[0].title, "已更新");
  assert.equal(listed.items[0].body, draft.body);
  assert.equal(listed.items[0].user_ids, undefined);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await call("/account/notices/read", { ids: [id] }, { access })).status,
      200,
    );
  assert.equal(
    (await call("/account/notices/unread-count", undefined, { access })).body
      .unread,
    0,
  );
  assert.equal(
    (await call("/account/notices?state=unread", undefined, { access })).body
      .items.length,
    0,
  );
  assert.equal(
    (await call("/account/notices/unread-count", undefined, { access: other }))
      .body.unread,
    1,
  );
  // New accounts also see still-active all-account notices.
  const c = await store.createUser("notice-late-reader", password, {
      must_change: 0,
    }),
    late = (await store.login(c.username, password, "notice-late-ip")).body
      .access_token;
  assert.equal(
    (await call("/account/notices", undefined, { access: late })).body.total,
    1,
  );
  const target = (
    await call(
      "/admin/notices",
      { ...draft, audience: "users", user_ids: [a.id] },
      { access: admin },
    )
  ).body.id;
  await call(
    "/admin/notices/" + target + "/publish",
    { version: 1 },
    { access: admin },
  );
  assert.equal(
    (await call("/account/notices", undefined, { access })).body.total,
    2,
  );
  assert.equal(
    (await call("/account/notices", undefined, { access: other })).body.total,
    1,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [target] }, { access: other }))
      .status,
    404,
  );
  const future = (
    await call(
      "/admin/notices",
      { ...draft, starts_at: Date.now() / 1000 + 3600 },
      { access: admin },
    )
  ).body.id;
  await call(
    "/admin/notices/" + future + "/publish",
    { version: 1 },
    { access: admin },
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [future] }, { access })).status,
    404,
  );
  const expires = (
    await call(
      "/admin/notices",
      {
        ...draft,
        starts_at: Date.now() / 1000 - 100,
        expires_at: Date.now() / 1000 + 10,
      },
      { access: admin },
    )
  ).body.id;
  await call(
    "/admin/notices/" + expires + "/publish",
    { version: 1 },
    { access: admin },
  );
  await store.run(
    "UPDATE customer_notices SET expires_at=? WHERE id=?",
    Date.now() / 1000 - 1,
    expires,
  );
  assert.equal(
    (await call("/account/notices", undefined, { access })).body.total,
    2,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [expires] }, { access }))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/withdraw",
        { version: 3 },
        { access: admin },
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/account/notices", undefined, { access: other })).body.total,
    0,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [id] }, { access })).status,
    404,
  );
  assert.equal(
    (
      await call(
        "/admin/notices/" + id + "/publish",
        { version: 4 },
        { access: admin },
      )
    ).status,
    409,
  );
  for (const bad of [
    { ...draft, user_ids: [a.id] },
    { ...draft, audience: "users", user_ids: [] },
    { ...draft, audience: "users", user_ids: [9999999] },
    { ...draft, priority: "critical" },
    { ...draft, starts_at: 10, expires_at: 9 },
    { ...draft, body: "x".repeat(8001) },
  ])
    assert.equal(
      (await call("/admin/notices", bad, { access: admin })).status,
      422,
    );
  assert.equal(
    (await call("/account/notices?page=0", undefined, { access })).status,
    422,
  );
  assert.equal(
    (await call("/account/notices/read", { ids: [] }, { access })).status,
    422,
  );
  const long = await call(
    "/admin/notices",
    { ...draft, body: "通知".repeat(4000) },
    { access: admin },
  );
  assert.equal(long.status, 200);
  assert.ok(
    (
      await store.first(
        "SELECT count(*) n FROM audit WHERE action='publish_notice'",
      )
    ).n >= 3,
  );
  // Paging does not lose records with identical publication timestamps.
  for (let i = 0; i < 32; i++)
    await store.run(
      "INSERT INTO customer_notices(id,title,body,state,starts_at,created,updated,published_at) VALUES(?,?,?,'published',0,0,0,1)",
      i.toString(16).padStart(48, "0"),
      "page " + i,
      "text",
    );
  const first = (await call("/account/notices", undefined, { access: other }))
      .body,
    second = (
      await call("/account/notices?page=2", undefined, { access: other })
    ).body;
  assert.equal(first.items.length, 30);
  assert.equal(second.items.length, 2);
  assert.equal(
    new Set([...first.items, ...second.items].map((n) => n.id)).size,
    32,
  );
});
