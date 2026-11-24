import { ASR_MODEL, TTS_MODEL } from "./audio.mjs";
import {
  CLOUD_TEXT_MODELS,
  CLOUD_TEXT_PATHS,
  LUNA_MODEL,
} from "./cloud-text-models.mjs";
import { EMBEDDING_MODELS } from "./embeddings.mjs";
import { Denied } from "./store.mjs";
import { now } from "./crypto.mjs";

export const LOCAL_ASR = "funasr";
export const LOCAL_TTS = "cosyvoice";

const definitions = [
  ...[...CLOUD_TEXT_MODELS].map(([id, model]) => ({
    id,
    name: model.name,
    service: "qwen",
    provider: "openai",
    endpoints: CLOUD_TEXT_PATHS,
  })),
  {
    id: "Qwen3.8-27B",
    name: "Qwen3.8-27B",
    service: "qwen",
    provider: "local",
    endpoints: ["/v1/chat/completions", "/v1/completions"],
  },
  ...Object.keys(EMBEDDING_MODELS).map((id) => ({
    id,
    name: id,
    service: "qwen",
    provider: "openai",
    endpoints: ["/v1/embeddings"],
  })),
  {
    id: "Qwen/Qwen3-Embedding-0.6B",
    name: "Qwen3 Embedding 0.6B",
    service: "qwen",
    provider: "local",
    endpoints: ["/v1/embeddings"],
  },
  {
    id: ASR_MODEL,
    name: "OpenAI 语音识别",
    service: "asr",
    provider: "openai",
    endpoints: ["/v1/audio/transcriptions"],
  },
  {
    id: LOCAL_ASR,
    name: "Paraformer 语音识别",
    service: "asr",
    provider: "local",
    endpoints: ["/v1/audio/transcriptions", "/ws/asr"],
    aliases: ["paraformer"],
    input: ["audio"],
    output: ["transcription"],
  },
  {
    id: TTS_MODEL,
    name: "OpenAI 语音合成",
    service: "tts",
    provider: "openai",
    endpoints: ["/v1/audio/speech"],
  },
  {
    id: LOCAL_TTS,
    name: "CosyVoice 语音合成",
    service: "tts",
    provider: "local",
    endpoints: ["/v1/audio/speech", "/ws/tts"],
    aliases: ["cosyvoice3"],
    input: ["text"],
    output: ["audio", "speech"],
  },
];
const registry = new Map(definitions.map((model) => [model.id, model]));
const aliases = new Map(
  definitions.flatMap((m) => (m.aliases ?? []).map((id) => [id, m.id])),
);

async function modelDefaults(store) {
  const rows = await store.all(
    "SELECT name,value FROM settings WHERE name IN ('new_account_model_ids','global_limits')",
  );
  const settings = Object.fromEntries(
    rows.map(({ name, value }) => [name, JSON.parse(value)]),
  );
  return {
    enabled: new Set(settings.new_account_model_ids),
    cloudPaused: settings.global_limits.cloud_enabled === false,
  };
}

export async function discoverableModels(store, encoded) {
  const enabled = new Set(JSON.parse(encoded ?? "[]"));
  if ([...enabled].some((id) => registry.get(id)?.provider === "openai")) {
    const setting = await store.first(
      "SELECT json_extract(value,'$.cloud_enabled') enabled FROM settings WHERE name='global_limits'",
    );
    if (setting?.enabled === 0)
      for (const id of enabled)
        if (registry.get(id)?.provider === "openai") enabled.delete(id);
  }
  return enabled;
}

export function localVoiceCatalog(permissions, enabled) {
  return definitions
    .filter(
      (m) => m.input && permissions.includes(m.service) && enabled.has(m.id),
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      object: "model",
      owned_by: "local",
      endpoints: m.endpoints,
      architecture: {
        input_modalities: m.input,
        output_modalities: m.output,
        modality: m.input.join("+") + "->" + m.output.join("+"),
      },
    }));
}

export function validateModelAllowlist(value) {
  if (
    !Array.isArray(value) ||
    value.length > registry.size ||
    new Set(value).size !== value.length ||
    value.some((id) => !registry.has(id))
  )
    throw new Denied(422, "模型白名单必须为有效的模型 ID 列表");
}

export async function requirePublicModel(store, requested, path, lease) {
  const id = aliases.get(requested) ?? requested;
  const model = registry.get(id);
  if (!model || !model.endpoints.includes(path)) {
    const error = new Denied(422, "此接口不支持指定的模型");
    error.code = "unsupported_model";
    throw error;
  }
  if (typeof lease !== "string" || !lease || lease.length > 128)
    throw new Denied(422, "无效请求凭证");
  const cloudText = model.provider === "openai" && model.service === "qwen";
  const cloudAudio = model.provider === "openai" && !cloudText;
  const flag = await store.first(
    `SELECT r.user_id, EXISTS(SELECT 1 FROM json_each(u.allowed_model_ids) WHERE value=?) allowed
      ${cloudAudio ? ", EXISTS(SELECT 1 FROM audio_usage a WHERE a.lease=r.id) replayed" : ""}
    FROM requests r JOIN users u ON u.id=r.user_id
    WHERE r.id=? AND r.path=? AND r.ended IS NULL AND u.enabled=1 AND u.must_change=0
      ${cloudText ? "AND r.service='qwen' AND r.started>unixepoch()-900 AND EXISTS(SELECT 1 FROM json_each(u.services) WHERE value='qwen')" : ""}`,
    id,
    lease,
    path,
  );
  if (!flag) throw new Denied(403, "推理请求凭证已失效");
  if (!flag.allowed) {
    const error = new Denied(403, "该账号没有此模型的使用权限");
    error.code = "model_not_allowed";
    throw error;
  }
  return flag;
}

export async function adminModelRoute(request, store, user, readBody) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/admin/models") return null;
  if (request.method === "GET") {
    const { enabled, cloudPaused } = await modelDefaults(store);
    return Response.json(
      {
        models: definitions.map((model) => ({
          ...model,
          enabled: enabled.has(model.id),
          ...(model.provider === "openai" && { cloud_paused: cloudPaused }),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (request.method !== "PATCH") throw new Denied(405, "方法不受支持");
  const update = await readBody(request);
  if (
    !update ||
    !registry.has(update.id) ||
    typeof update.enabled !== "boolean" ||
    Object.keys(update).some((key) => !["id", "enabled"].includes(key))
  )
    throw new Denied(422, "模型或开关值无效");

  await store.db.batch([
    store.stmt(
      update.enabled
        ? "UPDATE settings SET value=json_insert(value,'$[#]',?) WHERE name='new_account_model_ids' AND NOT EXISTS(SELECT 1 FROM json_each(settings.value) WHERE value=?)"
        : "UPDATE settings SET value=(SELECT json_group_array(value) FROM json_each(settings.value) WHERE value<>?) WHERE name='new_account_model_ids'",
      update.id,
      ...(update.enabled ? [update.id] : []),
    ),
    store.stmt(
      "INSERT INTO audit(actor,action,target,ts) VALUES(?,?,?,?)",
      user.id,
      update.enabled ? "enable_default_model" : "disable_default_model",
      update.id,
      now(),
    ),
  ]);
  return Response.json(
    { id: update.id, enabled: update.enabled },
    { headers: { "Cache-Control": "no-store" } },
  );
}
