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

function panelStatus(id, text, retry) {
  const status = $(id);
  status.textContent = text;
  status.classList.toggle("error", Boolean(retry));
  if (retry) status.append(" ", action("重试", retry));
}

function adminListReader(statusId, listId, retry) {
  let pending;
  return async (path) => {
    pending?.abort();
    const request = new AbortController();
    pending = request;
    const list = $(listId);
    list.inert = true;
    list.setAttribute("aria-busy", "true");
    panelStatus(statusId, "正在加载…");
    try {
      const data = await api(path, "GET", undefined, request.signal);
      if (request.signal.aborted) return null;
      panelStatus(statusId, "");
      list.inert = false;
      return data;
    } catch (error) {
      if (!request.signal.aborted) panelStatus(statusId, error.message, retry);
      return null;
    } finally {
      if (!request.signal.aborted) list.removeAttribute("aria-busy");
    }
  };
}

const adminSections = ["admin", "models", "keys", "costs", "alerts", "notices"];
function adminLocation() {
  const account = location.pathname.match(/^\/admin\/users\/([1-9]\d*)$/);
  if (account) return "user/" + account[1];
  const section = location.hash.slice(1);
  return adminSections.includes(section) ? section : "admin";
}
let activeAdminRoute;
async function syncAdminRoute() {
  if ($("workspace").hidden) return;
  const route = adminLocation();
  if (route === activeAdminRoute) return;
  activeAdminRoute = route;
  const [, userId] = route.split("/");
  const name = userId ? "user" : route;
  if (!userId) window.adminUI.closeDetails();
  for (const item of [...adminSections, "user"])
    $(item + "-panel").hidden = item !== name;
  if (name !== "keys") {
    $("key-value").textContent = "";
    $("key-secret").hidden = true;
  }
  if (name !== "admin") {
    $("user-password").textContent = "";
    $("user-secret").hidden = true;
  }
  for (const button of document.querySelectorAll("[data-tab]")) {
    if (button.dataset.tab === (userId ? "admin" : name))
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (userId) {
    $("user-settings").open = false;
    $("details-title").focus();
    await window.adminUI.details(Number(userId));
  } else if (name === "admin") await window.adminUI.load({ reuse: true });
  else if (name === "models") await window.modelManager.load();
  else if (name === "keys") await loadKeys();
  else if (name === "costs") void window.adminCosts.load();
  else if (name === "alerts") await window.adminUI.loadInbox();
  else if (name === "notices") await window.noticeManager.load();
}
async function navigateAdmin(route) {
  if (adminLocation() !== route) {
    const path = route.startsWith("user/")
      ? "/admin/users/" + route.slice(5)
      : route === "admin"
        ? "/admin"
        : "/admin#" + route;
    history.pushState(null, "", path);
  }
  await syncAdminRoute();
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
  await syncAdminRoute();
}
document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener(
    "click",
    run(() => navigateAdmin(button.dataset.tab)),
  ),
);
$("user-back").addEventListener("click", (event) => {
  if (
    event.button ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  void navigateAdmin("admin");
});
$("logout").addEventListener(
  "click",
  run(async () => {
    await api("/auth/logout", "POST");
    location.replace("/");
  }),
);
window.addEventListener("hashchange", run(syncAdminRoute));
window.addEventListener("popstate", run(syncAdminRoute));
document.addEventListener(
  "DOMContentLoaded",
  () =>
    refresh().catch((error) => {
      if (!user) location.replace("/?next=admin");
      else message(error.message, true);
    }),
  { once: true },
);
const readKeys = adminListReader("keys-load-status", "keys-list", () =>
  loadKeys(),
);
let renderedKeyTarget;
async function loadKeys() {
  if (renderedKeyTarget !== keyTarget) {
    $("keys-list").replaceChildren();
    $("key-value").textContent = "";
    $("key-secret").hidden = true;
  }
  const target = keyTarget;
  const keys = await readKeys(
    target ? "/admin/keys/" + target : "/account/keys",
  );
  if (!keys || target !== keyTarget) return;
  renderedKeyTarget = target;
  $("keys-list").replaceChildren();
  if (!keys.length) {
    const cell = $("keys-list").insertRow().insertCell();
    cell.colSpan = 5;
    cell.textContent = "暂无 API Key";
  }
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
    const target = keyTarget;
    const data = await api(
      target ? "/admin/keys/" + target : "/account/keys",
      "POST",
      {
        name: f.elements.name.value,
        days: Number(f.elements.days.value),
        services: selected(f),
      },
    );
    if (target !== keyTarget) return;
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
    const id = Number(f.elements.id.value);
    if (
      f.elements.model_policy.value === "allowlist" &&
      f.dataset.modelsReady !== "true"
    )
      return;
    const selectedModels = [
      ...f.querySelectorAll("[name=allowed_models]:checked"),
    ].map((box) => box.value);
    await api("/admin/users/" + id, "PATCH", {
      services: selected(f),
      rpm: Number(f.elements.rpm.value),
      daily_requests: Number(f.elements.daily_requests.value),
      concurrency: Number(f.elements.concurrency.value),
      allowed_model_ids:
        f.elements.model_policy.value === "inherit" ? null : selectedModels,
      ...lunaFields(f),
    });
    await window.adminUI.reloadUser(id);
    message("账号权限、额度和模型范围已保存");
  }),
);
