import { Denied } from "./store.mjs";

// The provider alone fetches remote images. Never fetch user URLs in the gateway.
export function visionInput(responses) {
  let count = 0;
  const parts = new WeakSet();
  return {
    check(v, role) {
      if (!["image_url", "input_image"].includes(v.type)) return false;
      const image = responses ? v : v.image_url;
      const url = responses ? v.image_url : image?.url;
      const keys = responses
        ? ["type", "image_url", "detail"]
        : ["type", "image_url"];
      if (
        v.type !== (responses ? "input_image" : "image_url") ||
        role !== "user" ||
        Object.keys(v).some((k) => !keys.includes(k)) ||
        !image ||
        typeof image !== "object" ||
        Array.isArray(image) ||
        (!responses &&
          Object.keys(image).some((k) => !["url", "detail"].includes(k))) ||
        typeof url !== "string" ||
        !["auto", "low", "high", "original"].includes(image.detail ?? "auto")
      )
        throw new Denied(
          422,
          "图片须使用 user 消息中的标准图片字段及有效 detail",
        );
      if (url.startsWith("data:")) {
        const data = url.match(
          /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/,
        );
        if (!data || data[2].length % 4)
          throw new Denied(422, "图片须为 PNG/JPEG/WebP/GIF Base64 data URL");
      } else {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          /* rejected below */
        }
        if (
          !parsed ||
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          url.length > 8192
        )
          throw new Denied(422, "图片地址须为不含凭据的 HTTPS URL");
      }
      if (++count > 2)
        throw new Denied(413, "每次请求最多包含 2 张图片（含历史消息）");
      parts.add(v);
      return true;
    },
    inputBytes(payload) {
      // Conservative reservation, not an exact image tokenizer. Settle actual
      // provider usage afterwards; Base64 bytes must not count as text tokens.
      const text = JSON.stringify(payload, (_key, value) =>
        value && typeof value === "object" && parts.has(value)
          ? { type: "image-placeholder" }
          : value,
      );
      return new TextEncoder().encode(text).length + count * 100000;
    },
  };
}
