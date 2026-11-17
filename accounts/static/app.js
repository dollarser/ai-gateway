"use strict";
let registrationRequiresCode = false,
  registrationCodeTimer = null;
async function tab(name) {
  if (!["usage", "password", "notices"].includes(name)) name = "usage";
  for (const item of ["usage", "password", "notices"])
    $(item + "-panel").hidden = item !== name;
  history.replaceState(
    null,
    "",
    location.pathname +
      location.search +
      (name === "notices" ? "#notices" : ""),
  );
  if (name === "notices") await window.noticeUI.load();
  if (name === "usage") await loadUsage();
}
async function refresh() {
  const data = await api("/account/me");
  user = data.user;
  csrf = data.csrf;
  for (const id of [
    "login",
    "register",
    "password-reset",
    "credential-password",
  ])
    $(id).hidden = true;
  $("password-form").elements.username.value = user.username;
  $("workspace").hidden = false;
  $("identity").textContent = user.username;
  $("page-title").textContent = "我的账号";
  $("admin-link").hidden = user.role !== "admin" || !!user.must_change;
  refreshEmailBinding();
  if (user.must_change) {
    message("首次登录，请先修改初始密码。");
    await tab("password");
    return;
  }
  if (
    user.role === "admin" &&
    new URLSearchParams(location.search).get("next") === "admin"
  ) {
    location.replace("/admin");
    return;
  }
  window.noticeUI.start();
  await tab(location.hash === "#notices" ? "notices" : "usage");
}
window.addEventListener(
  "hashchange",
  run(async () => {
    if (location.hash === "#notices" && user && !user.must_change)
      await tab("notices");
  }),
);
async function loadUsage() {
  const snapshot = await api("/account/usage-snapshot");
  const data = snapshot.usage;
  const isAdmin = user.role === "admin";
  const used = data.totals.reduce((n, t) => n + t.requests, 0);
  $("usage-totals").replaceChildren();
  const heading = document.createElement("p");
  heading.textContent = isAdmin
    ? data.today +
      " 今日用量 · 每日额度 " +
      (user.daily_requests === 0 ? "不限" : user.daily_requests + " 次") +
      " · 每分钟额度 " +
      (user.rpm === 0 ? "不限" : user.rpm + " 次") +
      " · 并发 " +
      user.concurrency
    : "今日已使用 " +
      used +
      " 次 · " +
      (user.daily_requests === 0
        ? "每日请求不限"
        : "剩余 " +
          Math.max(0, user.daily_requests - used) +
          " 次 · 每日额度 " +
          user.daily_requests +
          " 次");
  $("usage-totals").append(heading);
  if (user.luna_monthly_tokens !== undefined) {
    const luna = snapshot.luna;
    const balance = document.createElement("p");
    const amount = (n) => Number(n).toLocaleString("zh-CN");
    balance.textContent =
      "云文本（Luna / 嵌入） · " +
      luna.month +
      " · 月额度 " +
      amount(luna.monthly_tokens) +
      " tokens · 已计入 " +
      amount(luna.used_tokens) +
      " · 剩余 " +
      amount(luna.remaining_tokens) +
      (luna.reserved_tokens
        ? "（其中预留/待核对 " + amount(luna.reserved_tokens) + "）"
        : "");
    const reset = document.createElement("small");
    reset.textContent =
      " 下次重置：" +
      new Date(luna.resets_at).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      }) +
      "（北京时间）";
    balance.append(reset);
    $("usage-totals").append(balance);
  }
  if (user.openai_asr_daily_seconds !== undefined) {
    const a = snapshot.audio;
    const line = document.createElement("p");
    line.textContent =
      "OpenAI 语音 · " +
      a.day +
      " · 识别剩余 " +
      (a.asr.remaining / 60000).toFixed(2) +
      " / " +
      (a.asr.limit / 60000).toFixed(0) +
      " 分钟 · 合成剩余 " +
      a.tts.remaining.toLocaleString("zh-CN") +
      " / " +
      a.tts.limit.toLocaleString("zh-CN") +
      " 字符" +
      (a.asr.reserved || a.tts.reserved ? "（含预留/待核对用量）" : "");
    line.append(
      document.createTextNode(
        " · 下次重置 " +
          new Date(a.resets_at).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          }) +
          "（北京时间）",
      ),
    );
    $("usage-totals").append(line);
  }
  const cards = document.createElement("div");
  cards.className = "usage-cards";
  const names = { qwen: "智能对话", asr: "语音识别", tts: "语音合成" };
  for (const service of user.services) {
    const card = document.createElement("div");
    const total = data.totals.find((x) => x.service === service);
    card.textContent =
      (isAdmin ? service.toUpperCase() : (names[service] ?? service)) +
      " · " +
      (total?.requests ?? 0) +
      " 次";
    cards.append(card);
  }
  $("usage-totals").append(cards);
  const header = document.createElement("tr");
  for (const title of isAdmin
    ? ["时间", "服务", "状态", "耗时", "响应字节"]
    : ["时间", "功能", "结果"]) {
    const th = document.createElement("th");
    th.textContent = title;
    header.append(th);
  }
  $("usage-head").replaceChildren(header);
  $("usage-list").replaceChildren();
  for (const r of data.requests) {
    const values = isAdmin
      ? [
          date(r.started),
          r.service,
          r.status ?? "进行中",
          r.ended ? (r.ended - r.started).toFixed(2) + " 秒" : "—",
          r.response_bytes,
        ]
      : [
          date(r.started),
          names[r.service] ?? r.service,
          r.status === null
            ? "处理中"
            : (r.status >= 200 && r.status < 400) || r.status === 101
              ? "成功"
              : "未完成",
        ];
    const tr = document.createElement("tr");
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    $("usage-list").append(tr);
  }
  if (!data.requests.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = isAdmin ? 5 : 3;
    td.textContent = "暂无使用记录";
    tr.append(td);
    $("usage-list").append(tr);
  }
}

$("login-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    const data = await api("/auth/login", "POST", {
      username: f.elements.username.value,
      password: f.elements.password.value,
    });
    csrf = data.csrf;
    f.reset();
    message("登录成功");
    await refresh();
  }),
);
$("logout").addEventListener(
  "click",
  run(async () => {
    await api("/auth/logout", "POST");
    location.reload();
  }),
);
document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener(
    "click",
    run(() => tab(b.dataset.tab)),
  ),
);
$("refresh-usage").addEventListener("click", run(loadUsage));
$("password-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    await api("/auth/password", "POST", {
      username: f.elements.username.value,
      current_password: f.elements.current_password.value,
      new_password: f.elements.new_password.value,
    });
    location.reload();
  }),
);
document.addEventListener("DOMContentLoaded", () => refresh().catch(() => {}), {
  once: true,
});

$("show-register").addEventListener(
  "click",
  run(async () => {
    const info = await api("/auth/registration-info");
    if (info.registration_enabled === false)
      throw new Error("当前暂停公开注册");
    const q = info.defaults;
    registrationRequiresCode = info.email_verification === true;
    $("registration-code-fields").hidden = !registrationRequiresCode;
    $("register-form").elements.code.required = registrationRequiresCode;
    $("registration-quotas").textContent =
      "注册后每天可使用 " +
      q.daily_requests +
      " 次。" +
      (registrationRequiresCode ? "需要验证邮箱后完成注册。" : "");
    $("login").hidden = true;
    $("register").hidden = false;
    message("");
  }),
);
$("show-login").onclick = () => {
  $("register").hidden = true;
  $("login").hidden = false;
  message("");
};
$("register-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    const email = f.elements.email.value;
    if (f.elements.password.value !== f.elements.confirm_password.value)
      throw new Error("两次输入的密码不一致");
    const data = await api("/auth/register", "POST", {
      email,
      password: f.elements.password.value,
      ...(registrationRequiresCode
        ? { code: f.elements.code.value.trim() }
        : {}),
    });
    f.reset();
    $("register").hidden = true;
    $("login").hidden = false;
    $("login-form").elements.username.value = email;
    $("login-form").elements.password.focus();
    message(data.message);
  }),
);

$("send-registration-code").addEventListener(
  "click",
  run(async () => {
    const f = $("register-form"),
      button = $("send-registration-code");
    if (!f.elements.email.reportValidity()) return;
    button.disabled = true;
    try {
      const data = await api("/auth/registration-code", "POST", {
        email: f.elements.email.value,
        captcha_token: await window.helixCaptcha.getToken("registration_code"),
      });
      message(data.message);
      let remaining = 60;
      button.textContent = remaining + " 秒后重发";
      clearInterval(registrationCodeTimer);
      registrationCodeTimer = setInterval(() => {
        remaining--;
        button.textContent =
          remaining > 0 ? remaining + " 秒后重发" : "发送验证码";
        if (remaining <= 0) {
          clearInterval(registrationCodeTimer);
          button.disabled = false;
        }
      }, 1000);
      f.elements.code.focus();
    } catch (e) {
      button.disabled = false;
      throw e;
    }
  }),
);

let bindingOwner = null,
  bindingCodeTimer = null;
function refreshEmailBinding() {
  const required = user.email_binding_required === true;
  $("email-binding-reminder").hidden = !required;
  $("open-email-binding").disabled = !!user.must_change;
  $("email-binding-hint").textContent = user.must_change
    ? "请先修改初始密码，再验证并绑定邮箱。"
    : "您的账号尚未验证邮箱，请完成绑定以接收账号通知。绑定不会改变登录名，也不影响当前服务使用。";
  if (!required) {
    $("email-binding-form").reset();
    $("email-binding-form").hidden = true;
    clearInterval(bindingCodeTimer);
    $("send-binding-code").disabled = false;
    $("send-binding-code").textContent = "发送验证码";
  }
  if (bindingOwner !== user.id) {
    bindingOwner = user.id;
    $("email-binding-form").elements.email.value =
      user.email ||
      (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.username) ? user.username : "");
  }
}
$("open-email-binding").addEventListener("click", () => {
  $("email-binding-form").hidden = false;
  $("email-binding-form").elements.email.focus();
});
$("defer-email-binding").addEventListener("click", () => {
  $("email-binding-form").hidden = true;
  $("email-binding-form").elements.code.value = "";
});
$("send-binding-code").addEventListener(
  "click",
  run(async () => {
    const f = $("email-binding-form"),
      button = $("send-binding-code");
    if (!f.elements.email.reportValidity()) return;
    button.disabled = true;
    try {
      const data = await api("/account/email/code", "POST", {
        email: f.elements.email.value,
        captcha_token: await window.helixCaptcha.getToken("email_binding_code"),
      });
      message(data.message);
      let remaining = 60;
      button.textContent = remaining + " 秒后重发";
      clearInterval(bindingCodeTimer);
      bindingCodeTimer = setInterval(() => {
        remaining--;
        button.textContent =
          remaining > 0 ? remaining + " 秒后重发" : "发送验证码";
        if (remaining <= 0) {
          clearInterval(bindingCodeTimer);
          button.disabled = false;
        }
      }, 1000);
      f.elements.code.focus();
    } catch (e) {
      button.disabled = false;
      throw e;
    }
  }),
);
$("email-binding-form").addEventListener(
  "submit",
  run(async (e) => {
    const f = e.target;
    const result = await api("/account/email/bind", "POST", {
      email: f.elements.email.value,
      code: f.elements.code.value.trim(),
    });
    await refresh();
    message(result.message);
  }),
);
