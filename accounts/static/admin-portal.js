"use strict";
let keyTarget = null;
const lunaFields = (f) =>
  user?.luna_monthly_tokens === undefined
    ? {}
    : Object.fromEntries(
        [
          "luna_monthly_tokens",
          "openai_asr_daily_seconds",
          "openai_tts_daily_characters",
        ].map((k) => [k, Number(f.elements[k].value)]),
      );

const adminSections = ["admin", "keys", "costs", "alerts", "notices"];
async function tab(name) {
  if (!adminSections.includes(name)) name = "admin";
  for (const item of adminSections) $(item + "-panel").hidden = item !== name;
  if (name !== "keys") {
    $("key-value").textContent = "";
    $("key-secret").hidden = true;
  }
  if (name !== "admin") {
    $("user-password").textContent = "";
    $("user-secret").hidden = true;
  }
  for (const button of document.querySelectorAll("[data-tab]")) {
    if (button.dataset.tab === name)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "admin") await loadUsers();
  if (name === "keys") await loadKeys();
  if (name === "costs") void window.adminCosts.load();
  if (name === "alerts") await window.adminUI.loadInbox();
  if (name === "notices") await window.noticeManager.load();
}
async function loadUsers() {
  await window.adminUI.load();
}
async function refresh() {
  const data = await api("/account/me");
  user = data.user;
  csrf = data.csrf;
  if (user.role !== "admin" || user.must_change) {
    location.replace("/");
    return;
  }
  $("identity").textContent = user.display_name + " · 管理员";
  for (const field of document.querySelectorAll(
    "[name=luna_monthly_tokens],[name=openai_asr_daily_seconds],[name=openai_tts_daily_characters]",
  )) {
    field.disabled = user.luna_monthly_tokens === undefined;
    field.closest("label").hidden = field.disabled;
  }
  for (const box of $("key-services").querySelectorAll("input")) {
    box.disabled = !user.services.includes(box.value);
    box.checked = !box.disabled;
  }
  $("workspace").hidden = false;
  await tab(location.hash.slice(1));
}
document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener(
    "click",
    run(() => {
      if (location.hash !== "#" + b.dataset.tab) location.hash = b.dataset.tab;
    }),
  ),
);
$("logout").addEventListener(
  "click",
  run(async () => {
    await api("/auth/logout", "POST");
    location.replace("/");
  }),
);
window.addEventListener(
  "hashchange",
  run(() => tab(location.hash.slice(1))),
);
document.addEventListener(
  "DOMContentLoaded",
  () =>
    refresh().catch((error) => {
      if (!user) location.replace("/?next=admin");
      else message(error.message, true);
    }),
  { once: true },
);
async function loadKeys() {
  const keys = await api(
    keyTarget ? "/admin/keys/" + keyTarget : "/account/keys",
  );
  $("keys-list").replaceChildren();
  for (const key of keys)
    row(
      "keys-list",
      [
        key.name + " / " + key.prefix + "…",
        key.services.join(", "),
        date(key.expires),
        key.revoked
          ? "已撤销"
          : key.expires < Date.now() / 1000
            ? "已过期"
            : "有效",
      ],
      key.revoked
        ? []
        : [
            action(
              "撤销",
              async () => {
                if (confirm("撤销此密钥？使用它的应用将无法继续调用。")) {
                  await api("/account/keys/" + key.id, "DELETE");
                  await loadKeys();
                }
              },
              true,
            ),
          ],
    );
}
$("key-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    const data = await api(
      keyTarget ? "/admin/keys/" + keyTarget : "/account/keys",
      "POST",
      {
        name: f.elements.name.value,
        days: Number(f.elements.days.value),
        services: selected(f),
      },
    );
    $("key-value").textContent = data.key;
    $("key-secret").hidden = false;
    await loadKeys();
    message(data.message);
  }),
);
$("copy-key").addEventListener(
  "click",
  run(async () => {
    await navigator.clipboard.writeText($("key-value").textContent);
    message("密钥已复制");
  }),
);
$("dismiss-key").onclick = () => {
  $("key-value").textContent = "";
  $("key-secret").hidden = true;
};
$("dismiss-password").onclick = () => {
  $("user-password").textContent = "";
  $("user-secret").hidden = true;
};
$("user-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    const data = await api("/admin/users", "POST", {
      display_name: f.elements.display_name.value,
      email: f.elements.email.value,
      services: selected(f),
      rpm: Number(f.elements.rpm.value),
      daily_requests: Number(f.elements.daily_requests.value),
      concurrency: Number(f.elements.concurrency.value),
      ...lunaFields(f),
    });
    $("user-password").textContent =
      data.user.display_name +
      " (#" +
      data.user.id +
      ") · " +
      (data.user.email || "未设置邮箱") +
      "\n临时密码：" +
      data.temporary_password;
    $("user-secret").hidden = false;
    await loadUsers();
    message(data.message);
  }),
);
$("edit-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    await api("/admin/users/" + Number(f.elements.id.value), "PATCH", {
      services: selected(f),
      rpm: Number(f.elements.rpm.value),
      daily_requests: Number(f.elements.daily_requests.value),
      concurrency: Number(f.elements.concurrency.value),
      ...lunaFields(f),
    });
    f.hidden = true;
    $("edit-container").hidden = true;
    await loadUsers();
    message("账号权限和限额已更新");
  }),
);
