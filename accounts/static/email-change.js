"use strict";
const emailChangeForm = document.getElementById("email-change-form");
document.getElementById("open-email-change").addEventListener("click", () => {
  window.emailVerification.clearAll();
  emailChangeForm.reset();
  emailChangeForm.hidden = false;
  emailChangeForm.elements.email.focus();
});
document.getElementById("cancel-email-change").addEventListener("click", () => {
  window.emailVerification.clearAll();
  emailChangeForm.reset();
  emailChangeForm.hidden = true;
});
emailChangeForm.addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target,
      email = f.elements.email.value;
    const result = await api("/account/email/change", "POST", {
      email,
      code: f.elements.code.value.trim(),
    });
    window.emailVerification.clearAll();
    document.querySelectorAll("form").forEach((form) => form.reset());
    csrf = "";
    user = null;
    document.getElementById("identity").textContent = "";
    document.getElementById("workspace").hidden = true;
    emailChangeForm.hidden = true;
    document.getElementById("login").hidden = false;
    document.getElementById("login-form").elements.email.value = email;
    document.getElementById("notice-items").replaceChildren();
    history.replaceState(null, "", location.pathname);
    message(result.message);
  }),
);

function clearHiddenEmailPassword() {
  if (document.hidden || emailChangeForm.closest("[hidden]"))
    emailChangeForm.elements.current_password.value = "";
}
window.addEventListener("pagehide", () => {
  emailChangeForm.elements.current_password.value = "";
});
document.addEventListener("visibilitychange", clearHiddenEmailPassword);
new MutationObserver(clearHiddenEmailPassword).observe(document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ["hidden"],
});
