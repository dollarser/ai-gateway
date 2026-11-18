"use strict";
window.helixCaptcha = (() => {
  let scriptPromise = null,
    pending = null,
    busy = false,
    attempt = null;
  async function configuration() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch("/auth/captcha-info", {
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        }),
        v = await r.json();
      if (!r.ok) throw new Error(v.detail || "人机验证暂不可用");
      return v;
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error("人机验证加载超时，请重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
    const current = (attempt = { cancelled: false });
    const check = () => {
      if (current.cancelled) throw new Error("人机验证已取消");
    };
    try {
      const info = await configuration();
      check();
      if (info.enabled === false) return undefined;
      if (!info.actions.includes(action)) throw new Error("无效的人机验证用途");
      await load();
      check();
      const dialog = document.getElementById("captcha-dialog"),
        container = document.getElementById("captcha-widget");
      return await new Promise((resolve, reject) => {
        let id,
          settled = false;
        const finish = (token, error) => {
          if (settled) return;
          settled = true;
          pending = null;
          if (id !== undefined) window.turnstile.remove(id);
          container.replaceChildren();
          if (dialog.dataset.embedded !== "true" || token) dialog.close();
          if (error) reject(error);
          else resolve(token);
        };
        pending = () => finish(null, new Error("人机验证已取消"));
        try {
          if (!dialog.open) dialog.showModal();
          if (dialog.dataset.embedded === "true")
            document.getElementById("captcha-page-status").hidden = true;
          id = window.turnstile.render(container, {
            sitekey: info.site_key,
            action,
            size: container.clientWidth < 300 ? "compact" : "flexible",
            retry: "never",
            "refresh-expired": "never",
            "refresh-timeout": "never",
            language: "zh-cn",
            callback: (token) => finish(token),
            "expired-callback": () =>
              finish(null, new Error("人机验证已过期，请重新验证")),
            "timeout-callback": () =>
              finish(null, new Error("人机验证超时，请重新验证")),
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
      attempt = null;
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
  return {
    getToken,
    cancel() {
      if (attempt) attempt.cancelled = true;
      pending?.();
    },
  };
})();
