import { Denied, day } from "./store.mjs";

export const LUNA_MODEL = "gpt-6-luna";
const month = () => day().slice(0, 7);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
export function budgetValue(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000)
    throw new Denied(422, "Luna 月额度应为 0–10 亿的整数 tokens");
  return value;
}
export async function lunaUsage(store, uid) {
  const period = month();
  const u = await store.first(
    "SELECT luna_monthly_tokens FROM users WHERE id=?",
    uid,
  );
  const r = await store.first(
    "SELECT coalesce(sum(charged_tokens),0) n,coalesce(sum(CASE WHEN settled=0 THEN charged_tokens ELSE 0 END),0) reserved,count(*) requests,coalesce(sum(prompt_tokens),0) prompt_tokens,coalesce(sum(completion_tokens),0) completion_tokens FROM luna_usage WHERE user_id=? AND month=?",
    uid,
    period,
  );
  return {
    model: LUNA_MODEL,
    month: period,
    timezone: "Asia/Shanghai",
    monthly_tokens: u.luna_monthly_tokens,
    used_tokens: r.n,
    reserved_tokens: r.reserved,
    remaining_tokens: Math.max(0, u.luna_monthly_tokens - r.n),
    requests: r.requests,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
  };
}
async function activeLease(store, lease) {
  if (typeof lease !== "string" || !lease || lease.length > 128)
    throw new Denied(422, "无效请求凭证");
  const r = await store.first(
    "SELECT r.*,u.luna_monthly_tokens FROM requests r JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.service='qwen' AND r.ended IS NULL AND r.started>unixepoch()-900 AND u.enabled=1 AND u.must_change=0 AND EXISTS(SELECT 1 FROM json_each(u.services) WHERE value='qwen')",
    lease,
  );
  if (!r) throw new Denied(403, "推理请求凭证已失效");
  return r;
}
export async function lunaCatalog(store, env, lease) {
  const r = await activeLease(store, lease);
  return {
    data:
      env.OPENAI_API_KEY && r.luna_monthly_tokens > 0
        ? [
            {
              id: LUNA_MODEL,
              object: "model",
              owned_by: "openai",
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
                modality: "text->text",
              },
            },
          ]
        : [],
  };
}
// No URL/file/image inputs, server-side tools, hidden conversation state, or paid
// processing tiers: every billable input must be present in this bounded request.
export function preparePayload(payload, responses) {
  const allowed = responses
    ? [
        "model",
        "input",
        "instructions",
        "max_output_tokens",
        "stream",
        "reasoning",
        "text",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "temperature",
        "top_p",
        "metadata",
      ]
    : [
        "model",
        "messages",
        "max_completion_tokens",
        "max_tokens",
        "stream",
        "stream_options",
        "reasoning_effort",
        "response_format",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "temperature",
        "top_p",
        "stop",
        "seed",
        "frequency_penalty",
        "presence_penalty",
        "metadata",
        "user",
      ];
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some((k) => !allowed.includes(k))
  )
    throw new Denied(422, "Luna 包含未开放的字段");
  if (payload.model !== LUNA_MODEL) throw new Denied(400, "仅开放 gpt-6-luna");
  if (payload.stream !== undefined && typeof payload.stream !== "boolean")
    throw new Denied(422, "stream 必须为布尔值");
  if (responses) {
    if (!(typeof payload.input === "string" || Array.isArray(payload.input)))
      throw new Denied(422, "需要 input");
  } else if (!Array.isArray(payload.messages) || !payload.messages.length)
    throw new Denied(422, "需要 messages");
  function check(v, depth = 0) {
    if (depth > 32) throw new Denied(422, "输入嵌套过深");
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) check(x, depth + 1);
      return;
    }
    if (
      v.type &&
      ![
        "text",
        "input_text",
        "output_text",
        "message",
        "function_call",
        "function_call_output",
        "function",
      ].includes(v.type)
    )
      throw new Denied(422, "Luna 额度当前仅支持文本和自定义函数");
    for (const [k, x] of Object.entries(v)) {
      if (responses && k === "id")
        throw new Denied(
          422,
          "Responses 输入必须包含完整文本，不能引用已存储条目",
        );
      if (
        [
          "image_url",
          "file_id",
          "file_url",
          "input_audio",
          "audio",
          "encrypted_content",
        ].includes(k)
      )
        throw new Denied(422, "Luna 额度当前仅支持文本输入");
      check(x, depth + 1);
    }
  }
  // Check input/tool descriptors only; JSON schemas may legitimately contain type.
  check(responses ? payload.input : payload.messages);
  if (
    payload.tools !== undefined &&
    (!Array.isArray(payload.tools) ||
      payload.tools.some((t) => !t || t.type !== "function"))
  )
    throw new Denied(422, "仅开放客户端自定义函数工具");
  if (
    payload.max_tokens !== undefined &&
    payload.max_completion_tokens !== undefined
  )
    throw new Denied(422, "输出 token 上限不能重复设置");
  const field = responses ? "max_output_tokens" : "max_completion_tokens";
  const max = payload[field] ?? payload.max_tokens ?? 4096;
  if (!Number.isSafeInteger(max) || max < 1 || max > 16384)
    throw new Denied(422, "输出 token 上限应为 1–16384");
  const result = {
    ...payload,
    [field]: max,
    service_tier: "default",
    store: false,
  };
  delete result.max_tokens;
  if (!responses && result.stream)
    result.stream_options = { include_usage: true };
  // A conservative upper bound for text tokenization, framing and function schemas.
  const inputBound =
    new TextEncoder().encode(JSON.stringify(result)).length +
    4096 +
    (responses
      ? Array.isArray(payload.input)
        ? payload.input.length
        : 1
      : payload.messages.length) *
      64;
  if (inputBound > 250000)
    throw new Denied(413, "Luna 文本输入过长，请缩短上下文");
  // Reserve an upper bound for input plus the full requested output limit.
  return {
    payload: result,
    inputBound,
    max,
    reservation: inputBound + max,
  };
}
// Cached inputs count toward the token allowance like other input tokens.
export function usageTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  const details =
    usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const cached = details.cached_tokens ?? 0;
  const writes =
    details.cache_write_tokens ?? details.cache_creation_tokens ?? 0;
  if (
    ![input, output, cached, writes].every(integer) ||
    cached + writes > input ||
    input > 1000000 ||
    output > 128000
  )
    return null;
  return {
    input,
    output,
    cached,
    writes,
    total: input + output,
  };
}
export async function proxyLuna(request, env, store, ctx, payload, responses) {
  if (!env.OPENAI_API_KEY) throw new Denied(503, "尚未配置 OpenAI 服务密钥");
  const lease = request.headers.get("X-Gateway-Lease");
  const r = await activeLease(store, lease);
  const expectedPath = responses ? "/v1/responses" : "/v1/chat/completions";
  if (r.path !== expectedPath) throw new Denied(403, "请求凭证路径不匹配");
  const p = preparePayload(payload, responses);
  try {
    await store.run(
      "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens) VALUES(?,?,?,?,?,?,?)",
      lease,
      r.user_id,
      month(),
      p.reservation,
      p.reservation,
      p.inputBound,
      p.max,
    );
  } catch (e) {
    if (String(e).includes("luna_budget_exhausted"))
      throw new Denied(
        429,
        "GPT-6 Luna 本月余额不足以预留该请求，请降低输出上限或联系管理员",
      );
    if (String(e).includes("UNIQUE"))
      throw new Denied(409, "该请求已提交，不能重复调用");
    throw e;
  }
  async function settle(cost, id = null) {
    if (!cost) return; // Unknown usage keeps its conservative reservation charged.
    await store.run(
      "UPDATE luna_usage SET charged_tokens=?,settled=1,prompt_tokens=?,completion_tokens=?,cached_tokens=?,cache_write_tokens=?,response_id=? WHERE lease=? AND settled=0",
      cost.total,
      cost.input,
      cost.output,
      cost.cached,
      cost.writes,
      typeof id === "string" ? id.slice(0, 256) : null,
      lease,
    );
  }
  let upstream;
  try {
    upstream = await fetch("https://api.openai.com" + expectedPath, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(p.payload),
      signal: AbortSignal.timeout(840000),
    });
  } catch {
    throw new Denied(502, "OpenAI 连接失败；未知用量暂按预留额度计入");
  }
  if (!upstream.ok) {
    // A definitive non-success response never delivers a model completion.
    let code = "";
    try {
      const error = await upstream.json();
      const value = error?.error?.code;
      if (typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value))
        code = "（" + value + "）";
    } catch {
      /* Do not expose raw upstream errors or request content. */
    }
    await settle({ total: 0, input: 0, output: 0, cached: 0, writes: 0 });
    throw new Denied(
      upstream.status === 429 ? 429 : upstream.status === 400 ? 400 : 502,
      upstream.status === 429
        ? "OpenAI 请求频率或账户余额受限"
        : "OpenAI 拒绝了请求，请检查模型权限或请求参数" + code,
    );
  }
  if (!p.payload.stream) {
    let value;
    try {
      value = await upstream.json();
    } catch {
      throw new Denied(502, "OpenAI 返回无效响应；预留额度待核对");
    }
    await settle(usageTokens(value.usage), value.id);
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  }
  // The pump keeps reading the provider after client cancellation so the final
  // usage event can settle the account. Failed/truncated streams keep the reserve.
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const pump = (async () => {
    let connected = true,
      pending = "",
      cost = null,
      id = null;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        if (pending.length > 1048576) throw new Error("oversized SSE event");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            const value = responses ? event.response : event;
            if (value?.id) id = value.id;
            const parsed = usageTokens(value?.usage);
            if (parsed && (!responses || event.type === "response.completed"))
              cost = parsed;
          } catch {
            /* SSE [DONE], comments and non-JSON lines. */
          }
        }
        if (connected)
          try {
            await writer.write(chunk);
          } catch {
            connected = false;
          }
      }
    } catch {
      /* Keep the reservation if no authoritative final usage arrived. */
    } finally {
      try {
        await settle(cost, id);
      } finally {
        if (connected)
          try {
            await writer.close();
          } catch {
            /* disconnected */
          }
      }
    }
  })();
  ctx.waitUntil(pump);
  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
