"use strict";
window.helixCaptcha = (() => {
  let scriptPromise = null,
    pending = null,
    busy = false;
  async function configuration() {
    const r = await fetch("/auth/captcha-info", {
        cache: "no-store",
        credentials: "omit",
      }),
      v = await r.json();
    if (!r.ok) throw new Error(v.detail || "人机验证暂不可用");
    return v;
  }
  function load() {
    if (window.turnstile) return Promise.resolve();
    if (!scriptPromise)
      scriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.async = true;
        const timer = setTimeout(() => {
          s.remove();
          scriptPromise = null;
          reject(new Error("人机验证加载超时，请重试"));
        }, 15000);
        s.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        s.onerror = () => {
          clearTimeout(timer);
          s.remove();
          scriptPromise = null;
          reject(new Error("人机验证加载失败，请检查网络"));
        };
        document.head.append(s);
      });
    return scriptPromise;
  }
  async function getToken(action) {
    if (busy) throw new Error("请先完成当前人机验证");
    busy = true;
    try {
      const info = await configuration();
      if (info.enabled === false) return undefined;
      if (!info.actions.includes(action)) throw new Error("无效的人机验证用途");
      await load();
      const dialog = document.getElementById("captcha-dialog"),
        container = document.getElementById("captcha-widget");
      return await new Promise((resolve, reject) => {
        let id;
        const finish = (token, error) => {
          if (!pending) return;
          pending = null;
          if (id !== undefined) window.turnstile.remove(id);
          container.replaceChildren();
          dialog.close();
          if (error) reject(error);
          else resolve(token);
        };
        pending = () => finish(null, new Error("人机验证已取消"));
        dialog.showModal();
        try {
          id = window.turnstile.render(container, {
            sitekey: info.site_key,
            action,
            size: "flexible",
            language: "zh-cn",
            callback: (token) => finish(token),
            "expired-callback": () =>
              finish(null, new Error("人机验证已过期，请重新验证")),
            "error-callback": () => {
              finish(null, new Error("人机验证失败，请重新验证"));
              return true;
            },
          });
        } catch (e) {
          finish(null, new Error("人机验证无法加载，请重试"));
        }
      });
    } finally {
      busy = false;
    }
  }
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const dialog = document.getElementById("captcha-dialog");
      document
        .getElementById("captcha-cancel")
        .addEventListener("click", () => pending?.());
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        pending?.();
      });
    },
    { once: true },
  );
  return { getToken };
})();
