"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const action = new URL(location.href).searchParams.get("action");
  const dialog = document.getElementById("captcha-dialog");
  const status = document.getElementById("captcha-page-status");
  const retry = document.getElementById("captcha-page-start");
  let closed = false,
    running = false;
  const viewport = window.visualViewport;
  const fit = () => {
    const width = viewport?.width || innerWidth;
    const height = viewport?.height || innerHeight;
    // A WebView may shrink/pan only the visual viewport when its keyboard
    // opens. The UA dialog centering still uses the larger layout viewport.
    dialog.style.width = Math.max(1, Math.min(400, width - 24)) + "px";
    dialog.style.maxWidth = Math.max(1, width - 24) + "px";
    dialog.style.maxHeight = Math.max(1, height - 24) + "px";
    dialog.style.left = (viewport?.offsetLeft || 0) + width / 2 + "px";
    dialog.style.top = (viewport?.offsetTop || 0) + height / 2 + "px";
  };
  fit();
  window.addEventListener("resize", fit);
  viewport?.addEventListener("resize", fit);
  viewport?.addEventListener("scroll", fit);
  const bridge = () =>
    window.HelixCaptcha &&
    typeof window.HelixCaptcha.postMessage === "function";
  const cancel = () => {
    if (closed) return;
    closed = true;
    window.helixCaptcha.cancel();
    dialog.close();
    if (bridge())
      window.HelixCaptcha.postMessage(
        JSON.stringify({ type: "captcha-cancelled", action }),
      );
  };
  document.getElementById("captcha-cancel").addEventListener("click", cancel);
  dialog.addEventListener("cancel", cancel);
  dialog.showModal();
  async function start() {
    if (closed || running) return;
    running = true;
    retry.hidden = true;
    status.hidden = false;
    status.textContent = "正在加载…";
    retry.disabled = false;
    try {
      if (
        ![
          "registration_code",
          "password_reset_code",
          "email_binding_code",
        ].includes(action)
      ) {
        retry.disabled = true;
        throw new Error("无效的验证用途，请返回客户端重试");
      }
      if (!bridge()) throw new Error("请从客户端的安全验证窗口打开此页面");
      const token = await window.helixCaptcha.getToken(action);
      if (closed) return;
      if (!token) throw new Error("人机验证未启用，请稍后重试");
      closed = true;
      window.HelixCaptcha.postMessage(
        JSON.stringify({ type: "captcha-completed", action, token }),
      );
    } catch (error) {
      if (closed) return;
      status.hidden = false;
      status.textContent = error.message || "人机验证失败，请重试";
      retry.hidden = false;
    } finally {
      running = false;
    }
  }
  retry.addEventListener("click", start);
  void start();
});
