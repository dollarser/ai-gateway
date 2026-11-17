import { Denied } from "./store.mjs";
const paths = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/audio/transcriptions",
  "/v1/realtime",
]);
export function openaiRoute(env, lease, requestId, transport = fetch) {
  const mode = env.OPENAI_TRANSPORT ?? "worker";
  if (!["worker", "local"].includes(mode))
    throw new Denied(503, "OpenAI 转发模式配置无效");
  if (mode === "worker") return transport;
  if (!env.INTERNAL_SECRET) throw new Denied(503, "OpenAI 本机转发凭证未配置");
  return async (url, options) => {
    const upstream = new URL(url);
    if (
      upstream.origin !== "https://api.openai.com" ||
      !paths.has(upstream.pathname)
    )
      throw new Denied(502, "OpenAI 转发目标无效");
    const target = new URL("https://" + (env.API_HOST ?? "api.hilex.me"));
    target.pathname = "/__openai" + upstream.pathname;
    target.search = upstream.search;
    const headers = new Headers(options.headers);
    headers.set("X-Edge-Secret", env.INTERNAL_SECRET);
    headers.set("X-Edge-Lease", lease);
    headers.set("X-Edge-Request-ID", requestId);
    const response = await transport(target.toString(), {
      ...options,
      headers,
      redirect: "manual",
    });
    if (response.headers?.has("X-OpenAI-Relay-Failure"))
      throw new Error("OpenAI relay upstream outcome unknown");
    return response;
  };
}
