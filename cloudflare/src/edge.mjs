import {
  ingressDiagnostics,
  providerTransport,
} from "./provider-diagnostics.mjs";
import { compressedDuration } from "./audio-duration.mjs";
import { Store, Denied } from "./store.mjs";
import { digest, token, now } from "./crypto.mjs";
import { LUNA_MODEL, lunaCatalog, proxyLuna } from "./luna.mjs";
import {
  ASR_MODEL,
  TTS_MODEL,
  audioModels,
  proxyTranscription,
  proxySpeech,
  wavDuration,
} from "./audio.mjs";
const json = (body, status = 200, headers = {}) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
export async function readBytes(request, limit) {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw new Denied(413, "请求体过大");
  const reader = request.body?.getReader(),
    chunks = [];
  let size = 0;
  const deadline = Date.now() + 60000;
  if (reader)
    while (true) {
      let timer;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel();
        throw new Denied(408, "请求体读取超时");
      }
      let r;
      try {
        r = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reader.cancel().catch(() => {});
              reject(new Denied(408, "请求体读取超时"));
            }, remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (r.done) break;
      size += r.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Denied(413, "请求体过大");
      }
      chunks.push(r.value);
    }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}
function credentials(request, env) {
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((s) => s.trim());
  const auth = request.headers.get("Authorization") ?? "",
    key = request.headers.get("X-API-Key") ?? "";
  let raw = /^Bearer /i.test(auth)
    ? auth.slice(7).trim()
    : (protocols.find((p) => p.startsWith("access-token."))?.slice(13) ??
      protocols.find((p) => p.startsWith("api-key."))?.slice(8) ??
      "");
  if (key && raw && key !== raw) throw new Denied(401, "不能同时提供不同凭证");
  raw = raw || key;
  if (raw.startsWith("ai-at-")) {
    if (key) throw new Denied(401, "登录凭证请使用 Bearer");
    const id =
      request.headers.get("X-Client-ID") ??
      protocols.find((p) => p.startsWith("client-id."))?.slice(10) ??
      "";
    let allowed;
    try {
      allowed = JSON.parse(env.INFERENCE_CLIENT_IDS ?? "[]");
    } catch {
      throw new Denied(503, "客户端凭证配置无效");
    }
    if (!Array.isArray(allowed) || !allowed.includes(id) || !id)
      throw new Denied(401, "账号调用需要有效 X-Client-ID");
  } else if (!raw.startsWith("sk-acct-") && !raw.startsWith("sk-qw-"))
    throw new Denied(401, "需要账号凭证或 API Key");
  return raw;
}
function privateHeaders(request, env, lease, id) {
  const headers = new Headers(request.headers);
  for (const k of [...headers.keys()])
    if (
      k.toLowerCase().startsWith("x-edge-") ||
      [
        "authorization",
        "x-api-key",
        "cookie",
        "x-gateway-lease",
        "host",
        "content-length",
        "cf-connecting-ip",
        "x-forwarded-for",
      ].includes(k.toLowerCase())
    )
      headers.delete(k);
  if (headers.has("Sec-WebSocket-Protocol")) {
    const offered = headers
      .get("Sec-WebSocket-Protocol")
      .split(",")
      .map((v) => v.trim());
    if (offered.includes("speech"))
      headers.set("Sec-WebSocket-Protocol", "speech");
    else headers.delete("Sec-WebSocket-Protocol");
  }
  headers.set("X-Edge-Secret", env.INTERNAL_SECRET);
  headers.set("X-Edge-Lease", lease);
  headers.set("X-Edge-Request-ID", id);
  return headers;
}
async function origin(request, env, lease, id, body, operation = null) {
  if (!env.INTERNAL_SECRET) throw new Denied(503, "源站凭证未配置");
  const url = new URL(request.url);
  if (operation) url.pathname = operation;
  const headers = privateHeaders(request, env, lease, id);
  if (operation) {
    headers.set("Content-Type", "application/octet-stream");
    headers.delete("Sec-WebSocket-Protocol");
  }
  try {
    return await fetch(url, {
      method: operation ? "POST" : request.method,
      headers,
      body: ["GET", "HEAD"].includes(operation ? "POST" : request.method)
        ? undefined
        : body,
      redirect: "manual",
      signal: AbortSignal.timeout(
        operation
          ? 65000
          : new URL(request.url).pathname === "/v1/models"
            ? 1500
            : 900000,
      ),
    });
  } catch {
    throw new Denied(
      503,
      "本机模型或编解码服务暂不可达；云文本和 PCM 合成可独立使用",
    );
  }
}
function internalRequest(request, lease, body, type = "application/json") {
  return new Request(request.url, {
    method: "POST",
    headers: {
      "X-Gateway-Lease": lease,
      ...(type ? { "Content-Type": type } : {}),
    },
    body,
  });
}
function badAudio(model, expected, local) {
  if (model === expected) return false;
  if (
    local ||
    ["funasr", "paraformer", "cosyvoice", "cosyvoice3"].includes(model)
  )
    return true;
  const error = new Denied(
    422,
    "请明确指定 model=" +
      expected +
      "；自建语音使用 X-Inference-Provider: local",
  );
  error.code = "invalid_audio_model";
  throw error;
}
async function track(response, store, lease, trace, ctx, start) {
  trace.compatibility = response.headers.get("X-Inference-Compatibility");
  trace.upstream_status = Number(
    response.headers.get("X-Upstream-Status") ?? response.status,
  );
  if (response.status >= 400) {
    trace.failure_stage = trace.failure_stage?.startsWith("codec_")
      ? trace.failure_stage
      : trace.provider === "local"
        ? "origin_request"
        : "provider_request";
    trace.error_code =
      response.headers.get("X-Error-Code") ?? "upstream_rejected";
  }
  const headers = new Headers(response.headers);
  for (const k of [...headers.keys()])
    if (k.toLowerCase().startsWith("x-edge-")) headers.delete(k);
  headers.set("X-Request-ID", trace.request_id);
  headers.set("X-Inference-Execution", "edge");
  headers.set("Cache-Control", "no-store");
  if (!response.body) {
    await store.finish({ lease, status: response.status, size: 0, trace });
    return new Response(null, { status: response.status, headers });
  }
  let size = 0,
    finished = false,
    body = "",
    pending = "",
    pt = 0,
    ct = 0,
    exactUsage = false,
    outputCharacters = 0;
  const decoder = new TextDecoder(),
    reader = response.body.getReader();
  const isSSE = (headers.get("Content-Type") ?? "").includes(
      "text/event-stream",
    ),
    isJSON = (headers.get("Content-Type") ?? "").includes("application/json");
  const accept = (obj) => {
    if (obj?.error || obj?.type === "error") {
      trace.stream_failed = true;
      trace.failure_stage = "response_stream";
      trace.error_code = "provider_stream_interrupted";
    }
    const value = obj?.response ?? obj,
      u = value?.usage;
    if (value?.id) trace.upstream_response_id = String(value.id).slice(0, 128);
    if (u) exactUsage = true;
    for (const c of Array.isArray(value?.choices) ? value.choices : []) {
      if (!c || typeof c !== "object") continue;
      const text = c.delta?.content ?? c.message?.content ?? c.text;
      if (typeof text === "string") outputCharacters += text.length;
      const reasoning = c.delta?.reasoning_content;
      if (typeof reasoning === "string") outputCharacters += reasoning.length;
    }
    if (u) {
      pt = u.prompt_tokens ?? u.input_tokens ?? 0;
      ct = u.completion_tokens ?? u.output_tokens ?? 0;
    }
  };
  const finish = async (status) => {
    if (finished) return;
    finished = true;
    if (trace.stream_failed && status < 400) status = 502;
    trace.duration_ms = Math.round(performance.now() - start);
    if (status < 400) trace.failure_stage = null;
    if (!isSSE && isJSON)
      try {
        accept(JSON.parse(body));
      } catch {}
    await store.finish({
      lease,
      status,
      size,
      prompt_tokens:
        Number.isSafeInteger(pt) && pt >= 0 && exactUsage
          ? pt
          : (trace.estimated_input_tokens ?? 0),
      completion_tokens:
        Number.isSafeInteger(ct) && ct >= 0 && exactUsage
          ? ct
          : Math.ceil(outputCharacters / 2),
      trace,
    });
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          await finish(response.status);
          controller.close();
          return;
        }
        if (size === 0)
          trace.first_byte_ms = Math.round(performance.now() - start);
        size += r.value.length;
        if (isJSON && body.length < 2 * 1024 * 1024)
          body += decoder.decode(r.value, { stream: true });
        if (isSSE) {
          pending += decoder.decode(r.value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop().slice(-65536);
          for (const l of lines)
            if (l.startsWith("data:"))
              try {
                accept(JSON.parse(l.slice(5)));
              } catch {}
        }
        controller.enqueue(r.value);
      } catch (e) {
        trace.failure_stage = "response_stream";
        trace.error_code = "stream_interrupted";
        ctx.waitUntil(finish(504));
        controller.error(e);
      }
    },
    async cancel() {
      trace.failure_stage = "response_stream";
      trace.error_code = "client_disconnected";
      try {
        await reader.cancel();
      } finally {
        ctx.waitUntil(finish(499));
      }
    },
  });
  return new Response(stream, { status: response.status, headers });
}
export async function edgeAPI(request, env, ctx) {
  const store = new Store(env.DB),
    url = new URL(request.url),
    path = url.pathname,
    id = token(),
    start = performance.now();
  let lease = null;
  const trace = {
    ...ingressDiagnostics(request),
    release_sha: env.RELEASE_SHA ?? null,
    request_id: id,
    provider: "edge",
    protocol: "http",
    failure_stage: "authentication",
  };
  try {
    if (path === "/healthz" && request.method === "GET") {
      await store.first("SELECT 1");
      return json(
        {
          release: env.RELEASE_SHA ?? null,
          ready: true,
          service: "inference-gateway",
          storage: "d1",
          execution: "edge",
        },
        200,
        { "X-Inference-Execution": "edge" },
      );
    }
    const ws = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const services = {
      "/v1/models": "catalog",
      "/v1/chat/completions": "qwen",
      "/v1/completions": "qwen",
      "/v1/responses": "qwen",
      "/v1/embeddings": "qwen",
      "/v1/audio/transcriptions": "asr",
      "/v1/audio/speech": "tts",
      "/ws/asr": "asr",
      "/ws/tts": "tts",
    };
    if (ws !== path.startsWith("/ws/")) throw new Denied(404, "接口协议不匹配");
    const service = services[path];
    if (
      !service ||
      request.method !== (ws || path === "/v1/models" ? "GET" : "POST")
    )
      throw new Denied(404, "未开放该接口");
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) await store.authCheck(ip);
    let raw;
    try {
      raw = credentials(request, env);
      lease = await store.acquire(raw, service, path, {
        client_ip: ip ?? null,
        user_agent: (request.headers.get("User-Agent") ?? "").slice(0, 512),
        client_version: (request.headers.get("X-Client-Version") ?? "").slice(
          0,
          128,
        ),
        device_id: (request.headers.get("X-Device-ID") ?? "").slice(0, 128),
      });
    } catch (e) {
      if (ip && e.status === 401)
        await store.run(
          "INSERT INTO inference_auth_failures(ip_hash,ts) VALUES(?,?)",
          await digest(ip),
          now(),
        );
      throw e;
    }
    trace.failure_stage = "validation";
    if (ws) {
      if (url.searchParams.get("model")?.startsWith("gpt-"))
        throw new Denied(422, "云语音使用 HTTP 接口，不能使用自建 WebSocket");
      trace.provider = "local";
      trace.protocol = "websocket";
      const r = await origin(request, env, lease, id, null);
      if (r.status === 101) return r;
      return track(r, store, lease, trace, ctx, start);
    }
    let bytes =
      request.method === "POST"
        ? await readBytes(
            request,
            service === "asr" ? 22 * 1024 * 1024 : 4 * 1024 * 1024,
          )
        : null;
    if (path === "/v1/models") {
      const r = await store.first(
        "SELECT u.*,k.services key_services FROM requests r JOIN users u ON u.id=r.user_id LEFT JOIN keys k ON k.id=r.key_id WHERE r.id=?",
        lease,
      );
      const permissions = ["qwen", "asr", "tts"].filter(
        (s) =>
          JSON.parse(r.services).includes(s) &&
          (!r.key_services || JSON.parse(r.key_services).includes(s)),
      );
      let data = [];
      if (permissions.includes("qwen"))
        data.push(...(await lunaCatalog(store, env, lease)).data);
      data.push(...(await audioModels(store, env, lease)));
      if (permissions.includes("qwen") && env.LOCAL_MODELS_ENABLED === "true") {
        const key = new Request(
          "https://" + url.hostname + "/__local-model-catalog",
        );
        const cache = globalThis.caches?.default;
        if (cache) {
          const cached = await cache.match(key);
          if (cached)
            try {
              data.push(...(await cached.json()));
            } catch {}
        }
        ctx.waitUntil(
          (async () => {
            try {
              const allModels = new URL(request.url);
              allModels.search = "?output_modalities=all";
              const r = await origin(
                new Request(allModels, request),
                env,
                lease,
                id,
                null,
              );
              if (r.ok) {
                const value = await r.json();
                if (Array.isArray(value.data) && cache)
                  await cache.put(
                    key,
                    Response.json(value.data, {
                      headers: { "Cache-Control": "max-age=30" },
                    }),
                  );
              }
            } catch {}
          })(),
        );
      }
      const values = url.searchParams.getAll("output_modalities"),
        selected = (values[0] ?? "text").split(",").map((v) => v.trim());
      const valid = [
        "text",
        "image",
        "embeddings",
        "audio",
        "video",
        "rerank",
        "decisions",
        "speech",
        "transcription",
        "all",
      ];
      if (
        values.length > 1 ||
        selected.some((v) => !valid.includes(v)) ||
        (selected.includes("all") && selected.length !== 1)
      )
        throw new Denied(400, "无效的 output_modalities");
      if (!selected.includes("all"))
        data = data.filter((m) =>
          selected.some((v) =>
            (m.architecture?.output_modalities ?? ["text"]).includes(v),
          ),
        );
      return track(
        json({ object: "list", data }),
        store,
        lease,
        trace,
        ctx,
        start,
      );
    }
    const local = request.headers.get("X-Inference-Provider") === "local";
    let response;
    if (path === "/v1/audio/transcriptions") {
      if (
        !(request.headers.get("Content-Type") ?? "").startsWith(
          "multipart/form-data",
        )
      ) {
        if (local)
          return track(
            await origin(request, env, lease, id, bytes),
            store,
            lease,
            { ...trace, provider: "local" },
            ctx,
            start,
          );
        throw new Denied(
          422,
          "识别需要 multipart/form-data，包含 model 和 file",
        );
      }
      let form;
      try {
        form = await new Request(request.url, {
          method: "POST",
          headers: { "Content-Type": request.headers.get("Content-Type") },
          body: bytes,
        }).formData();
      } catch {
        throw new Denied(422, "无效的识别表单");
      }
      trace.model = form.get("model");
      if (badAudio(trace.model, ASR_MODEL, local))
        return track(
          await origin(request, env, lease, id, bytes),
          store,
          lease,
          { ...trace, provider: "local" },
          ctx,
          start,
        );
      bytes = null;
      trace.provider = "openai";
      trace.protocol = form.get("stream") === "true" ? "sse" : "http";
      const file = form.get("file");
      if (
        !file ||
        typeof file.arrayBuffer !== "function" ||
        form.getAll("file").length !== 1
      )
        throw new Denied(422, "需要单个音频 file");
      const audio = new Uint8Array(await file.arrayBuffer());
      if (audio.length > 21 * 1024 * 1024)
        throw new Denied(413, "音频超过 21 MiB");
      let measuredMs,
        measurement = "pcm-frame-scan";
      try {
        measuredMs = wavDuration(audio);
      } catch (e) {
        if (e.status === 413) throw e;
        const scanned = compressedDuration(audio);
        if (scanned) {
          measuredMs = scanned.milliseconds;
          measurement = scanned.method;
          if (measuredMs > 300000) throw new Denied(413, "单次识别最多 5 分钟");
          form.set(
            "file",
            new File([file], scanned.filename, { type: scanned.mime }),
          );
        } else {
          measurement = "origin-decode";
          trace.failure_stage = "codec_decode";
          const decoded = await origin(
            request,
            env,
            lease,
            id,
            audio,
            "/__codec/decode",
          );
          if (!decoded.ok)
            return track(decoded, store, lease, trace, ctx, start);
          const normalized = await readBytes(decoded, 10 * 1024 * 1024);
          measuredMs = wavDuration(normalized);
          form.set(
            "file",
            new File([normalized], "audio.wav", { type: "audio/wav" }),
          );
        }
      }
      response = await proxyTranscription(
        internalRequest(request, lease, form, null),
        env,
        store,
        ctx,
        form,
        measuredMs,
        providerTransport(store, lease, trace, ctx, fetch, env),
      );
      response.headers.set("X-Audio-Processing", measurement);
    } else {
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Denied(422, "请求必须为 JSON 对象");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Denied(422, "请求必须为 JSON 对象");
      trace.model = payload.model;
      if (path === "/v1/audio/speech") {
        if (badAudio(payload.model, TTS_MODEL, local))
          return track(
            await origin(request, env, lease, id, bytes),
            store,
            lease,
            { ...trace, provider: "local" },
            ctx,
            start,
          );
        if ((payload.response_format ?? "pcm") !== "pcm") {
          const error = new Denied(
            422,
            "云语音合成仅支持 response_format=pcm（24kHz、16-bit little-endian、单声道）；请由客户端封装或编码",
          );
          error.code = "unsupported_audio_format";
          throw error;
        }
        trace.provider = "openai";
        trace.protocol = payload.stream ? "audio-stream" : "http";
        response = await proxySpeech(
          internalRequest(
            request,
            lease,
            JSON.stringify({ ...payload, response_format: "pcm" }),
          ),
          env,
          store,
          providerTransport(store, lease, trace, ctx, fetch, env),
          ctx,
        );
      } else if (payload.model === LUNA_MODEL) {
        trace.provider = "openai";
        trace.protocol = payload.stream ? "sse" : "http";
        if (!["/v1/chat/completions", "/v1/responses"].includes(path))
          throw new Denied(422, "Luna 使用 Chat Completions 或 Responses");
        response = await proxyLuna(
          internalRequest(request, lease, JSON.stringify(payload)),
          env,
          store,
          ctx,
          payload,
          path === "/v1/responses",
          providerTransport(store, lease, trace, ctx, fetch, env),
        );
      } else {
        if (path === "/v1/responses")
          throw new Denied(422, "Responses 当前仅支持 gpt-6-luna");
        trace.provider = "local";
        if (["/v1/chat/completions", "/v1/completions"].includes(path))
          trace.estimated_input_tokens = Math.ceil(bytes.length / 2);
        response = await origin(request, env, lease, id, bytes);
      }
    }
    return track(response, store, lease, trace, ctx, start);
  } catch (e) {
    let status =
      e instanceof Denied
        ? e.status
        : /quota_|audio_budget_exhausted|luna_budget_exhausted/.test(String(e))
          ? 429
          : /account_permission|key_permission/.test(String(e))
            ? 403
            : 503;
    if (Number.isInteger(e.upstream_status)) {
      trace.upstream_status = e.upstream_status;
      trace.failure_stage = "upstream_rejected";
    }
    trace.upstream_error_code = e.upstream_error_code;
    trace.upstream_error_param = e.upstream_error_param;
    trace.upstream_request_id =
      e.upstream_request_id ?? trace.upstream_request_id;
    trace.compatibility = e.compatibility;
    const quotaCodes = {
      quota_rpm: "account_rate_limited",
      quota_concurrency: "account_concurrency_limited",
      quota_daily: "account_daily_limit",
      quota_tokens: "key_token_budget_exhausted",
    };
    const quota = Object.keys(quotaCodes).find((k) => String(e).includes(k));
    if (quota) e.retryable = ["quota_rpm", "quota_concurrency"].includes(quota);
    trace.error_code =
      e.code ??
      (quota
        ? quotaCodes[quota]
        : status < 500
          ? "request_rejected"
          : "edge_unavailable");
    if (!(e instanceof Denied))
      console.error("edge_request_failed", e.name, id);
    trace.duration_ms = Math.round(performance.now() - start);
    if (lease) await store.finish({ lease, status, size: 0, trace });
    return json(
      {
        detail:
          e instanceof Denied
            ? e.message
            : status === 429
              ? "账号请求或模型额度已用尽"
              : status === 403
                ? "账号或密钥权限已变更"
                : "服务暂不可用",
        request_id: id,
        error_code: trace.error_code,
        retryable: e.retryable === true,
        ...(trace.upstream_error_code
          ? { upstream_error_code: trace.upstream_error_code }
          : {}),
        ...(trace.upstream_error_param
          ? { upstream_error_param: trace.upstream_error_param }
          : {}),
      },
      status,
      {
        "X-Request-ID": id,
        "X-Inference-Execution": "edge",
        ...(trace.compatibility
          ? { "X-Inference-Compatibility": trace.compatibility }
          : {}),
        ...(status === 429 && e.retryable !== false
          ? { "Retry-After": String(e.retry_after ?? 60) }
          : {}),
      },
    );
  }
}
