"use strict";
document.addEventListener("DOMContentLoaded", () => {
  const action = new URL(location.href).searchParams.get("action");
  const status = document.getElementById("captcha-page-status"),
    button = document.getElementById("captcha-page-start");
  const actions = [
    "registration_code",
    "password_reset_code",
    "email_binding_code",
  ];
  if (!actions.includes(action)) {
    status.textContent = "无效的验证用途，请返回客户端重试";
    button.disabled = true;
    return;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const token = await window.helixCaptcha.getToken(action);
      if (!token) throw new Error("此页面需要已启用的人机验证");
      if (
        !window.HelixCaptcha ||
        typeof window.HelixCaptcha.postMessage !== "function"
      )
        throw new Error("请从客户端的安全验证窗口打开此页面");
      window.HelixCaptcha.postMessage(
        JSON.stringify({ type: "captcha-completed", action, token }),
      );
      status.textContent = "验证成功，请返回客户端继续操作";
    } catch (e) {
      status.textContent = e.message;
      button.disabled = false;
    }
  });
});
