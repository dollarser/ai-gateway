import { Denied, day } from "./store.mjs";
import { activeLease } from "./luna.mjs";
import { budgetError } from "./budgets.mjs";
import { openaiHeaders } from "./openai-headers.mjs";
import { providerFailure } from "./provider-errors.mjs";
export const EMBEDDING_MODELS = {
  "text-embedding-3-small": { dimensions: 1536, price: 20 },
};
export function embeddingCatalog(user, env) {
  return env.OPENAI_API_KEY && user.luna_monthly_tokens > 0
    ? Object.entries(EMBEDDING_MODELS).map(([id, m]) => ({
        id,
        object: "model",
        owned_by: "openai",
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["embeddings"],
          modality: "text->embeddings",
        },
        embedding_dimensions: m.dimensions,
      }))
    : [];
}
export function prepareEmbedding(p) {
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) =>
        !["model", "input", "dimensions", "encoding_format", "user"].includes(
          k,
        ),
    )
  )
    throw new Denied(422, "嵌入请求字段无效");
  const model = EMBEDDING_MODELS[p.model];
  if (!model) throw new Denied(422, "未开放的 OpenAI 嵌入模型");
  if (
    p.dimensions !== undefined &&
    (!Number.isSafeInteger(p.dimensions) ||
      p.dimensions < 1 ||
      p.dimensions > model.dimensions)
  )
    throw new Denied(422, "嵌入维度超出模型范围");
  if (
    p.encoding_format !== undefined &&
    !["float", "base64"].includes(p.encoding_format)
  )
    throw new Denied(422, "encoding_format 须为 float 或 base64");
  if (
    p.user !== undefined &&
    (typeof p.user !== "string" || p.user.length > 128)
  )
    throw new Denied(422, "user 字段无效");
  const tokens = (x) =>
    Array.isArray(x) &&
    x.length > 0 &&
    x.every((v) => Number.isSafeInteger(v) && v >= 0);
  let inputs =
    typeof p.input === "string" || tokens(p.input) ? [p.input] : p.input;
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 32)
    throw new Denied(422, "每请求需要 1–32 条非空文本或 token 序列");
  let bound = 0;
  for (const x of inputs) {
    let n =
      typeof x === "string"
        ? new TextEncoder().encode(x).length
        : tokens(x)
          ? x.length
          : 0;
    if (!n || n > 8192)
      throw new Denied(
        422,
        "每条输入需非空，文本字节上界或 token 数不超过 8192",
      );
    bound += n;
  }
  if (bound > 32768)
    throw new Denied(413, "嵌入批次预留超过 32768 tokens，请拆分请求");
  return {
    payload: { ...p, encoding_format: p.encoding_format ?? "float" },
    bound,
    count: inputs.length,
    model,
    dimensions: p.dimensions ?? model.dimensions,
  };
}
export async function proxyEmbedding(
  request,
  env,
  store,
  payload,
  transport = fetch,
) {
  if (!env.OPENAI_API_KEY) throw new Denied(503, "尚未配置 OpenAI 服务密钥");
  const lease = request.headers.get("X-Gateway-Lease"),
    r = await activeLease(store, lease);
  if (r.path !== "/v1/embeddings") throw new Denied(403, "请求凭证路径不匹配");
  const p = prepareEmbedding(payload),
    month = day().slice(0, 7),
    cost = p.bound * p.model.price;
  try {
    await store.run(
      "INSERT INTO luna_usage(lease,user_id,month,reserved_tokens,charged_tokens,prompt_tokens,completion_tokens,reserved_cost_nanos,charged_cost_nanos,model) VALUES(?,?,?,?,?,?,0,?,?,?)",
      lease,
      r.user_id,
      month,
      p.bound,
      p.bound,
      p.bound,
      cost,
      cost,
      payload.model,
    );
  } catch (e) {
    const global = budgetError(e);
    if (global) throw global;
    if (String(e).includes("luna_budget_exhausted")) {
      const err = new Denied(429, "云文本 token 额度不足以预留嵌入请求");
      err.code = "account_luna_budget_exhausted";
      err.retryable = false;
      throw err;
    }
    if (String(e).includes("UNIQUE"))
      throw new Denied(409, "请求已提交，不能重复调用");
    throw e;
  }
  const settle = async (n) =>
    store.run(
      "UPDATE luna_usage SET charged_tokens=?,prompt_tokens=?,completion_tokens=0,charged_cost_nanos=?,settled=1 WHERE lease=? AND settled=0",
      n,
      n,
      n * p.model.price,
      lease,
    );
  let upstream;
  try {
    upstream = await transport("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: openaiHeaders(env.OPENAI_API_KEY, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(p.payload),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120000)]),
    });
  } catch {
    throw new Denied(502, "嵌入服务连接失败，未知用量保留预留额度");
  }
  if (!upstream.ok) {
    const e = await providerFailure(upstream, "embedding");
    await settle(0);
    throw e;
  }
  let value;
  try {
    value = await upstream.json();
  } catch {
    throw new Denied(502, "嵌入服务响应无效，预留用量待核对");
  }
  const n = value.usage?.prompt_tokens;
  const valid =
    Number.isSafeInteger(n) &&
    n >= 0 &&
    n <= p.bound &&
    Array.isArray(value.data) &&
    value.data.length === p.count &&
    value.data.every(
      (x, i) =>
        x.index === i &&
        (p.payload.encoding_format === "base64"
          ? typeof x.embedding === "string"
          : Array.isArray(x.embedding) &&
            x.embedding.length === p.dimensions &&
            x.embedding.every(Number.isFinite)),
    );
  if (!valid) throw new Denied(502, "嵌入结果或用量无效，预留用量待核对");
  await settle(n);
  return {
    response: Response.json(value, {
      headers: { "Cache-Control": "no-store" },
    }),
    inputTokens: n,
  };
}
