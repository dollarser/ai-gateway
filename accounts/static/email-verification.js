"use strict";
// Proofs are scoped to one visible form, email, account and manual send attempt.
window.emailVerification = (() => {
  const states = [];
  let active = null;
  const clearAll = () => states.forEach((state) => state.clear());
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      for (const [formId, action, endpoint, suffix] of [
        [
          "register-form",
          "registration_code",
          "/auth/registration-code",
          "registration",
        ],
        [
          "password-reset-form",
          "password_reset_code",
          "/auth/password-reset/code",
          "password-reset",
        ],
        [
          "email-binding-form",
          "email_binding_code",
          "/account/email/code",
          "binding",
        ],
      ]) {
        const form = document.getElementById(formId);
        if (!form) continue;
        const email = form.elements.email,
          verify = document.getElementById("verify-" + suffix),
          send = document.getElementById("send-" + suffix + "-code"),
          status = document.getElementById(
            "verification-" + suffix + "-status",
          ),
          sendLabel = send.textContent;
        let proof = null,
          revision = 0,
          working = false,
          sending = false,
          cooldown = 0;
        const identity = () =>
          typeof user === "undefined" ? null : (user?.id ?? null);
        const address = () => email.value.trim().toLowerCase();
        const visible = () => !document.hidden && !form.closest("[hidden]");
        const valid = () =>
          proof &&
          proof.email === address() &&
          proof.owner === identity() &&
          Date.now() < proof.expires &&
          visible();
        function render() {
          const remaining = Math.max(
            0,
            Math.ceil((cooldown - Date.now()) / 1000),
          );
          verify.disabled = working || sending || remaining > 0;
          send.disabled = sending || remaining > 0 || !valid();
          send.textContent = remaining ? remaining + " 秒后重发" : sendLabel;
          verify.textContent = working
            ? "验证中…"
            : valid()
              ? "重新验证"
              : "完成人机验证";
        }
        function clear(text = "请先完成人机验证，再点击发送验证码") {
          revision++;
          proof = null;
          if (active === state) {
            window.helixCaptcha.cancel();
            active = null;
          }
          status.textContent = text;
          render();
        }
        const state = { clear };
        states.push(state);
        verify.addEventListener("click", async () => {
          if (
            working ||
            sending ||
            cooldown > Date.now() ||
            !email.reportValidity()
          )
            return;
          clearAll();
          const version = revision,
            target = address(),
            owner = identity();
          working = true;
          active = state;
          render();
          try {
            const token = await window.helixCaptcha.getToken(action);
            if (
              revision !== version ||
              address() !== target ||
              identity() !== owner ||
              !visible()
            )
              return;
            // Leave a safety margin under Turnstile's five-minute validity.
            proof = {
              token,
              email: target,
              owner,
              expires: Date.now() + 240000,
            };
            status.textContent = "验证通过，请手动点击发送验证码";
          } catch (error) {
            if (revision === version) status.textContent = error.message;
          } finally {
            if (active === state) active = null;
            working = false;
            render();
          }
        });
        send.addEventListener("click", async () => {
          if (sending || cooldown > Date.now()) return;
          if (!valid() || !email.reportValidity()) {
            clear();
            return;
          }
          const token = proof.token,
            target = email.value,
            owner = identity();
          clear("本次验证凭据已使用，下次发送需重新验证");
          const version = revision;
          sending = true;
          render();
          try {
            const data = await api(endpoint, "POST", {
              email: target,
              captcha_token: token,
            });
            cooldown =
              Date.now() + Math.max(1, Number(data.retry_after) || 60) * 1000;
            if (revision === version && identity() === owner && visible()) {
              message(data.message);
              form.elements.code.focus();
            }
          } catch (error) {
            const retry = Number(error.retry_after);
            if (retry > 0) cooldown = Date.now() + retry * 1000;
            if (revision === version && visible()) message(error.message, true);
          } finally {
            sending = false;
            render();
          }
        });
        email.addEventListener("input", () => clear());
        email.addEventListener("change", () => clear());
        form.addEventListener("reset", () => clear());
        setInterval(() => {
          if (proof && !valid()) clear("验证已失效，请重新完成人机验证");
          else render();
        }, 1000);
        new MutationObserver(() => {
          if (!visible()) clear();
        }).observe(document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ["hidden"],
        });
        clear();
      }
    },
    { once: true },
  );
  window.addEventListener("pagehide", clearAll);
  window.addEventListener("pageshow", clearAll);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearAll();
  });
  return { clearAll };
})();
