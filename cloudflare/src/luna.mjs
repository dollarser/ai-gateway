import { webSearchResetsAt } from "./web-search-usage.mjs";
import { visionInput } from "./vision.mjs";
import { openaiHeaders } from "./openai-headers.mjs";
import { toolDiagnostic } from "./worker-logs.mjs";
import { lunaCost, budgetError } from "./budgets.mjs";
import { providerFailure } from "./provider-errors.mjs";
import { Denied, day } from "./store.mjs";

import {
  CLOUD_TEXT_CONTEXT_WINDOW,
  CLOUD_TEXT_MODELS,
  CLOUD_TEXT_PATHS,
  LUNA_MODEL,
} from "./cloud-text-models.mjs";
const webSearchPriceNanos = 10000000;
const webSearchContextTokens = 128000;
const month = () => day().slice(0, 7);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
export function budgetValue(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000)
    throw new Denied(422, "Luna 月额度应为 0–10 亿的整数 tokens");
  return value;
}
export async function lunaUsage(store, uid) {
  const period = month();
  const r = await store.first(
    "SELECT u.luna_monthly_tokens,coalesce(t.used_tokens,0) n,coalesce(t.reserved_tokens,0) reserved,coalesce(t.requests,0) requests,coalesce(t.prompt_tokens,0) prompt_tokens,coalesce(t.completion_tokens,0) completion_tokens FROM users u LEFT JOIN luna_user_month_totals t ON t.user_id=u.id AND t.month=? WHERE u.id=?",
    period,
    uid,
  );
  return cloudUsageValue(r, r, period);
}
export function cloudUsageValue(u, r, period = month()) {
  return {
    model: LUNA_MODEL,
    scope: "cloud_text_tokens",
    models: [...CLOUD_TEXT_MODELS.keys(), "text-embedding-3-small"],
    month: period,
    timezone: "Asia/Shanghai",
    resets_at: new Date(
      Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1) -
        8 * 3600000,
    ).toISOString(),
    monthly_tokens: u.luna_monthly_tokens,
    used_tokens: r.n,
    reserved_tokens: r.reserved,
    remaining_tokens: Math.max(0, u.luna_monthly_tokens - r.n),
    requests: r.requests,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
  };
}
export async function activeLease(store, lease) {
  if (typeof lease !== "string" || !lease || lease.length > 128)
    throw new Denied(422, "无效请求凭证");
  const r = await store.first(
    "SELECT r.*,u.luna_monthly_tokens FROM requests r JOIN users u ON u.id=r.user_id WHERE r.id=? AND (r.service='qwen' OR r.path='/v1/models') AND r.ended IS NULL AND r.started>unixepoch()-900 AND u.enabled=1 AND u.must_change=0 AND EXISTS(SELECT 1 FROM json_each(u.services) WHERE value='qwen')",
    lease,
  );
  if (!r) throw new Denied(403, "推理请求凭证已失效");
  return r;
}
export async function lunaCatalog(store, env, lease) {
  const r = await activeLease(store, lease);
  return lunaCatalogForUser(r, env);
}
export function lunaCatalogForUser(r, env) {
  return {
    data:
      env.OPENAI_API_KEY && r.luna_monthly_tokens > 0
        ? [...CLOUD_TEXT_MODELS].map(([id, model]) => ({
            id,
            object: "model",
            owned_by: "openai",
            endpoints: CLOUD_TEXT_PATHS,
            ...(id === LUNA_MODEL && { responses_tools: ["web_search"] }),
            tool_calling: {
              ...(model.reasoningNone && {
                chat_completions_reasoning_effort: "none",
              }),
              reasoning_tools_endpoint: "/v1/responses",
            },
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              modality: "text+image->text",
            },
          }))
        : [],
  };
}

// Allow bounded inputs and the explicitly metered Luna web search tool.
export function preparePayload(payload, responses) {
  const allowed = responses
    ? [
        "model",
        "input",
        "instructions",
        "max_output_tokens",
        "max_tool_calls",
        "include",
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
  const model = CLOUD_TEXT_MODELS.get(payload.model);
  if (!model) throw new Denied(400, "此 OpenAI 对话模型未接入");
  if (
    !model.reasoningNone &&
    (responses ? payload.reasoning?.effort : payload.reasoning_effort) ===
      "none"
  )
    throw new Denied(
      422,
      "此模型需要启用推理，请选择 low 或更高的 reasoning effort",
    );
  if (payload.stream !== undefined && typeof payload.stream !== "boolean")
    throw new Denied(422, "stream 必须为布尔值");
  if (responses) {
    if (!(typeof payload.input === "string" || Array.isArray(payload.input)))
      throw new Denied(422, "需要 input");
  } else if (!Array.isArray(payload.messages) || !payload.messages.length)
    throw new Denied(422, "需要 messages");
  const vision = visionInput(responses);
  function check(v, depth = 0, role) {
    if (depth > 32) throw new Denied(422, "输入嵌套过深");
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) check(x, depth + 1, role);
      return;
    }
    role = v.role ?? role;
    if (vision.check(v, role)) return;
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
      throw new Denied(422, "Luna 仅开放文本、图片和自定义函数");
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
      check(x, depth + 1, role);
    }
  }
  // Check input/tool descriptors only; JSON schemas may legitimately contain type.
  check(responses ? payload.input : payload.messages);
  const supportedSearch = responses && payload.model === LUNA_MODEL;
  if (
    payload.tools !== undefined &&
    (!Array.isArray(payload.tools) ||
      payload.tools.some(
        (tool) =>
          !tool ||
          (tool.type !== "function" &&
            !(supportedSearch && tool.type === "web_search")),
      ))
  )
    throw new Denied(
      422,
      "内置 web_search 仅支持 gpt-6-luna 的 Responses；其他工具仅允许自定义函数",
    );
  const searchTools =
    payload.tools?.filter((tool) => tool.type === "web_search") ?? [];
  const webSearch = searchTools.length > 0;
  if (
    searchTools.length > 1 ||
    (payload.max_tool_calls !== undefined &&
      (!webSearch || payload.max_tool_calls !== 1))
  )
    throw new Denied(422, "每个响应最多允许一次内置搜索工具调用");
  if (
    payload.include !== undefined &&
    (!webSearch ||
      !Array.isArray(payload.include) ||
      payload.include.length !== 1 ||
      payload.include[0] !== "web_search_call.action.sources")
  )
    throw new Denied(422, "include 仅支持 web_search_call.action.sources");
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
    ...(webSearch && { max_tool_calls: 1 }),
  };
  delete result.max_tokens;
  const compatibility = [];
  if (payload.tools) {
    result.tools = payload.tools.map((t) => {
      if (t.type === "web_search") {
        if (
          Object.keys(t).some(
            (key) => !["type", "search_context_size"].includes(key),
          ) ||
          (t.search_context_size !== undefined &&
            !["low", "medium", "high"].includes(t.search_context_size))
        )
          throw new Denied(
            422,
            "web_search 仅支持 search_context_size 为 low、medium 或 high",
          );
        return {
          type: "web_search",
          search_context_size: t.search_context_size ?? "low",
        };
      }
      const f = t.function ?? t;
      if (typeof f.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(f.name))
        throw new Denied(
          422,
          "工具 name 应为 1–64 位英文字母、数字、下划线或连字符",
        );
      if (
        f.parameters !== undefined &&
        (!f.parameters ||
          typeof f.parameters !== "object" ||
          Array.isArray(f.parameters))
      )
        throw new Denied(422, "工具 parameters 应为 JSON Schema 对象");
      const definition = {
        name: f.name,
        ...(f.description !== undefined ? { description: f.description } : {}),
        ...(f.parameters !== undefined ? { parameters: f.parameters } : {}),
        strict: f.strict ?? false,
      };
      if ((responses && t.function) || (!responses && !t.function))
        compatibility.push("tools-schema-normalized");
      return responses
        ? { type: "function", ...definition }
        : { type: "function", function: definition };
    });
  }
  if (
    result.tool_choice &&
    typeof result.tool_choice === "object" &&
    result.tool_choice.type === "function"
  ) {
    const name = result.tool_choice.name ?? result.tool_choice.function?.name;
    if (!result.tools?.some((t) => (t.function ?? t).name === name))
      throw new Denied(422, "tool_choice 必须引用当前 tools 中的函数");
    result.tool_choice = responses
      ? { type: "function", name }
      : { type: "function", function: { name } };
  }
  const chatTools =
    !responses &&
    (result.tools?.length ||
      payload.messages.some(
        (m) => m?.tool_calls?.length || m?.role === "tool",
      ));
  if (chatTools && !model.reasoningNone)
    throw new Denied(422, "此模型的函数调用请使用 /v1/responses");
  if (chatTools && result.reasoning_effort !== "none") {
    result.reasoning_effort = "none";
    compatibility.push("chat-tools-reasoning-none");
  }
  if (!responses && result.stream)
    result.stream_options = { include_usage: true };
  // A conservative upper bound for text tokenization, framing and function schemas.
  const suppliedInputBound =
    vision.inputBytes(result) +
    4096 +
    (responses
      ? Array.isArray(payload.input)
        ? payload.input.length
        : 1
      : payload.messages.length) *
      64;
  const inputLimit =
    CLOUD_TEXT_CONTEXT_WINDOW - max - (webSearch ? webSearchContextTokens : 0);
  if (suppliedInputBound > inputLimit)
    throw new Denied(
      413,
      "输入预留超过 " + inputLimit + " tokens，请缩短上下文或减少图片",
      "input_estimate_too_large",
    );
  const inputBound =
    suppliedInputBound + (webSearch ? webSearchContextTokens : 0);
  // Reserve an upper bound for input plus the full requested output limit.
  return {
    payload: result,
    inputBound,
    max,
    reservation: inputBound + max,
    webSearch,
    compatibility: [...new Set(compatibility)].join(","),
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
    input + output > CLOUD_TEXT_CONTEXT_WINDOW ||
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
export async function proxyLuna(
  request,
  env,
  store,
  ctx,
  payload,
  responses,
  transport = fetch,
  authorizedLease = null,
) {
  if (!env.OPENAI_API_KEY) throw new Denied(503, "尚未配置 OpenAI 服务密钥");
  const lease = request.headers.get("X-Gateway-Lease");
  const r = authorizedLease ?? (await activeLease(store, lease));
  const expectedPath = responses ? "/v1/responses" : "/v1/chat/completions";
  if (!authorizedLease && r.path !== expectedPath)
    throw new Denied(403, "请求凭证路径不匹配");
  const p = preparePayload(payload, responses);
  const today = day();
  const reserveCost =
    lunaCost(
      { input: p.inputBound, output: p.max, cached: 0, writes: p.inputBound },
      payload.model,
    ) + (p.webSearch ? webSearchPriceNanos : 0);
  try {
    await store.run(
      "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens,reserved_cost_nanos,charged_cost_nanos,model,web_search_day,web_search_calls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      lease,
      r.user_id,
      today.slice(0, 7),
      p.reservation,
      p.reservation,
      p.inputBound,
      p.max,
      reserveCost,
      reserveCost,
      payload.model,
      p.webSearch ? today : null,
      p.webSearch ? 1 : null,
    );
  } catch (e) {
    if (String(e).includes("web_search_daily_limit")) {
      const error = new Denied(429, "该账号今日网页搜索额度已用完或已停用");
      error.code = "web_search_daily_limit";
      error.resets_at = webSearchResetsAt(today);
      error.retryable = false;
      throw error;
    }
    const global = budgetError(e);
    if (global) throw global;
    if (String(e).includes("luna_budget_exhausted")) {
      const error = new Denied(
        429,
        "云文本模型本月余额不足以预留该请求，请降低输出上限或联系管理员",
      );
      error.code = "account_luna_budget_exhausted";
      error.retryable = false;
      throw error;
    }
    if (String(e).includes("UNIQUE"))
      throw new Denied(409, "该请求已提交，不能重复调用");
    throw e;
  }
  function responseCost(value) {
    const usage = usageTokens(value?.usage);
    if (!p.webSearch) return usage;
    const calls = value?.tool_usage?.web_search?.num_requests;
    return usage && integer(calls) ? { ...usage, searchCalls: calls } : null;
  }
  async function settle(cost, id = null) {
    if (!cost) return; // Unknown usage keeps its conservative reservation charged.
    await store.run(
      "UPDATE luna_usage SET charged_tokens=?,settled=1,prompt_tokens=?,completion_tokens=?,cached_tokens=?,cache_write_tokens=?,response_id=?,charged_cost_nanos=?,web_search_calls=? WHERE lease=? AND settled=0",
      cost.total,
      cost.input,
      cost.output,
      cost.cached,
      cost.writes,
      typeof id === "string" ? id.slice(0, 256) : null,
      lunaCost(cost, payload.model) +
        (cost.searchCalls ?? 0) * webSearchPriceNanos,
      cost.searchCalls ?? null,
      lease,
    );
  }
  const abort = new AbortController();
  let upstream;
  try {
    upstream = await transport("https://api.openai.com" + expectedPath, {
      method: "POST",
      headers: openaiHeaders(env.OPENAI_API_KEY, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(p.payload),
      signal: AbortSignal.any([
        abort.signal,
        request.signal,
        AbortSignal.timeout(840000),
      ]),
    });
  } catch {
    throw new Denied(502, "OpenAI 连接失败；未知用量暂按预留额度计入");
  }
  if (!upstream.ok) {
    // A definitive non-success response never delivers a model completion.
    const failure = await providerFailure(upstream, "luna");
    failure.tool_diagnostic = toolDiagnostic(
      p.payload,
      failure.upstream_error_param,
    );
    if (!p.webSearch || upstream.status < 500)
      await settle({
        total: 0,
        input: 0,
        output: 0,
        cached: 0,
        writes: 0,
        ...(p.webSearch && { searchCalls: 0 }),
      });
    failure.compatibility = p.compatibility;
    throw failure;
  }
  if (!p.payload.stream) {
    let value;
    try {
      value = await upstream.json();
    } catch {
      throw new Denied(502, "OpenAI 返回无效响应；预留额度待核对");
    }
    await settle(responseCost(value), value.id);
    return Response.json(value, {
      headers: {
        "Cache-Control": "no-store",
        ...(p.compatibility
          ? { "X-Inference-Compatibility": p.compatibility }
          : {}),
      },
    });
  }
  const reader = upstream.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    cost = null,
    id = null,
    terminal = false,
    done = false,
    providerFailed = false,
    sequence = -1;
  function accept(line) {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") {
      if (!responses) terminal = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (Number.isSafeInteger(event.sequence_number))
      sequence = Math.max(sequence, event.sequence_number);
    if (
      event.error ||
      ["error", "response.failed", "response.incomplete"].includes(event.type)
    )
      providerFailed = true;
    const value = responses ? event.response : event;
    if (value?.id) id = value.id;
    const parsed = responseCost(value);
    if (parsed && (!responses || event.type === "response.completed"))
      cost = parsed;
    if (
      responses &&
      event.type === "response.completed" &&
      (!value.status || value.status === "completed")
    )
      terminal = true;
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          if (pending.trim()) accept(pending);
          if (!providerFailed && (!terminal || (!cost && !p.webSearch)))
            throw new Error("Provider stream ended before completion");
          done = true;
          await settle(providerFailed && !terminal ? null : cost, id);
          controller.close();
          return;
        }
        pending += decoder.decode(r.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        if (pending.length > 1048576) throw new Error("Oversized SSE event");
        for (const line of lines) accept(line);
        controller.enqueue(r.value);
      } catch (e) {
        done = true;
        abort.abort();
        await reader.cancel().catch(() => {});
        try {
          await settle(terminal ? cost : null, id);
        } finally {
          const fields = {
            code: "provider_stream_interrupted",
            message: "模型响应未完整结束，已保留待核对额度",
            param: null,
          };
          const event = responses
            ? { type: "error", sequence_number: sequence + 1, ...fields }
            : { error: { ...fields, type: "server_error" } };
          controller.enqueue(
            new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n"),
          );
          controller.close();
        }
      }
    },
    async cancel() {
      if (done) return;
      done = true;
      abort.abort();
      await reader.cancel().catch(() => {});
      await settle(terminal ? cost : null, id);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      ...(p.compatibility
        ? { "X-Inference-Compatibility": p.compatibility }
        : {}),
      "Cache-Control": "no-store",
    },
  });
}
