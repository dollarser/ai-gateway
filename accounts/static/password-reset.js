"use strict";
function closePasswordReset() {
  $("password-reset").hidden = true;
  $("password-reset-form").reset();
  window.emailVerification.clearAll();
  $("login").hidden = false;
}
$("show-password-reset").addEventListener("click", () => {
  $("login").hidden = true;
  $("register").hidden = true;
  $("password-reset").hidden = false;
  const email = $("login-form").elements.email.value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    $("password-reset-form").elements.email.value = email;
  message("");
  $("password-reset-form").elements.email.focus();
});
$("reset-back-login").addEventListener("click", () => {
  closePasswordReset();
  message("");
});
$("password-reset-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    if (f.elements.new_password.value !== f.elements.confirm_password.value)
      throw new Error("两次输入的密码不一致");
    const data = await api("/auth/password-reset", "POST", {
      email: f.elements.email.value,
      code: f.elements.code.value.trim(),
      new_password: f.elements.new_password.value,
      revoke_api_keys: f.elements.revoke_api_keys.checked,
    });
    closePasswordReset();
    csrf = "";
    user = null;
    $("login-form").elements.password.value = "";
    $("login-form").elements.email.focus();
    message(data.message);
  }),
);

$("show-credential-password").addEventListener("click", () => {
  closePasswordReset();
  $("login").hidden = true;
  $("credential-password").hidden = false;
  $("credential-password-form").elements.email.value =
    $("login-form").elements.email.value;
  message("");
  $("credential-password-form").elements.email.focus();
});
function closeCredentialPassword() {
  $("credential-password-form").reset();
  $("credential-password").hidden = true;
  $("login").hidden = false;
}
$("credential-back-login").addEventListener("click", () => {
  closeCredentialPassword();
  message("");
});
$("credential-password-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    if (f.elements.new_password.value !== f.elements.confirm_password.value)
      throw new Error("两次输入的密码不一致");
    const result = await api("/auth/password", "POST", {
      email: f.elements.email.value,
      current_password: f.elements.current_password.value,
      new_password: f.elements.new_password.value,
    });
    const email = f.elements.email.value;
    closeCredentialPassword();
    csrf = "";
    user = null;
    $("login-form").elements.email.value = email;
    $("login-form").elements.password.value = "";
    message(result.message);
  }),
);
