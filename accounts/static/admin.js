"use strict";
(() => {
  const quotaFields = [
    "rpm",
    "daily_requests",
    "concurrency",
    "luna_monthly_tokens",
    "openai_asr_daily_seconds",
    "openai_tts_daily_characters",
  ];
  const state = {
    page: 1,
    total: 0,
    selected: new Map(),
    defaults: null,
    loaded: false,
    sequence: 0,
  };
  const num = (n) => Number(n ?? 0).toLocaleString("zh-CN");
  const minutes = (n) => (Number(n ?? 0) / 60000).toFixed(2);
  const cell = (tr, text) => {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
    return td;
  };
  function selection() {
    const n = state.selected.size;
    $("selected-count").textContent = n
      ? "已选择 " + n + " 个账号"
      : "未选择账号";
    for (const id of ["bulk-defaults", "bulk-enable", "bulk-disable"])
      $(id).disabled = !n;
    const boxes = [...$("users-list").querySelectorAll("input[type=checkbox]")];
    $("select-page").checked =
      boxes.length > 0 && boxes.every((b) => b.checked);
    $("select-page").indeterminate =
      boxes.some((b) => b.checked) && !$("select-page").checked;
  }
  function filter() {
    const f = $("admin-filter-form");
    return new URLSearchParams({
      q: f.elements.q.value.trim(),
      status: f.elements.status.value,
      day: f.elements.day.value,
      page: String(state.page),
      page_size: "50",
    });
  }
  function appendMeter(td, used, limit, suffix = "") {
    const main = document.createElement("strong");
    main.textContent = num(used) + " / " + num(limit) + suffix;
    td.append(main);
    const bar = document.createElement("progress");
    bar.max = 100;
    bar.value = limit ? Math.min(100, (used / limit) * 100) : 0;
    bar.setAttribute("aria-label", main.textContent);
    td.append(bar);
    if (!limit) {
      const small = document.createElement("small");
      small.textContent = "已停用";
      td.append(small);
    }
  }
  async function load() {
    if (user?.role !== "admin") return;
    const sequence = ++state.sequence;
    if (!state.loaded) {
      const info = await api("/auth/registration-info");
      $("admin-filter-form").elements.day.value = info.today;
      state.loaded = true;
    }
    state.defaults = await api("/admin/quota-defaults");
    for (const k of quotaFields) {
      $("quota-defaults-form").elements[k].value = state.defaults[k];
      $("user-form").elements[k].value = state.defaults[k];
    }
    const data = await api("/admin/overview?" + filter());
    if (sequence !== state.sequence) return;
    state.total = data.matching;
    $("admin-summary").replaceChildren();
    for (const [label, value] of [
      ["账号总数", num(data.summary.users.total)],
      ["已启用", num(data.summary.enabled_users)],
      ["当日请求", num(data.summary.total)],
      [
        "失败 / 进行中",
        num(data.summary.failed) + " / " + num(data.summary.inflight),
      ],
      ["识别分钟", minutes(data.summary.asr_ms)],
      ["合成字符", num(data.summary.tts_characters)],
    ]) {
      const card = document.createElement("div");
      const small = document.createElement("span");
      small.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      card.append(small, strong);
      $("admin-summary").append(card);
    }
    $("users-list").replaceChildren();
    for (const u of data.users) {
      const tr = document.createElement("tr");
      if (!u.enabled) tr.classList.add("disabled-user");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", "选择 " + u.username);
      check.checked = state.selected.has(u.id);
      check.onchange = () => {
        if (check.checked) state.selected.set(u.id, u.username);
        else state.selected.delete(u.id);
        selection();
      };
      const selectTd = document.createElement("td");
      selectTd.append(check);
      tr.append(selectTd);
      const name = cell(tr, u.username);
      const badge = document.createElement("small");
      badge.className =
        "status-badge " + (u.enabled ? "status-ok" : "status-disabled");
      badge.textContent =
        (u.role === "admin" ? "管理员 · " : "") +
        (u.enabled ? "启用" : "封禁") +
        (u.must_change ? " · 待改密码" : "");
      name.append(badge);
      cell(
        tr,
        num(u.day_requests) +
          (u.daily_requests ? " / " + num(u.daily_requests) : " / 不限"),
      );
      const luna = document.createElement("td");
      appendMeter(luna, u.luna_used_tokens, u.luna_monthly_tokens);
      tr.append(luna);
      const asr = cell(
        tr,
        minutes(u.asr_used_ms) +
          " / " +
          (u.openai_asr_daily_seconds / 60).toFixed(2) +
          " 分钟",
      );
      if (!u.openai_asr_daily_seconds)
        asr.append(document.createTextNode("（停用）"));
      cell(
        tr,
        num(u.tts_used_characters) + " / " + num(u.openai_tts_daily_characters),
      );
      const ip = cell(tr, u.last_request_ip ?? u.last_login_ip ?? "未知");
      const last = document.createElement("small");
      last.textContent = u.last_request_at
        ? date(u.last_request_at)
        : u.last_login_at
          ? date(u.last_login_at)
          : "无活动记录";
      ip.append(last);
      const controls = document.createElement("td");
      controls.className = "row-actions";
      controls.append(
        action("详情", () => details(u)),
        action("设置", () => edit(u)),
        action(
          u.enabled ? "封禁" : "解封",
          async () => {
            if (
              !confirm(
                (u.enabled ? "封禁" : "解封") +
                  "账号 " +
                  u.username +
                  "？" +
                  (u.enabled ? "封禁会撤销现有登录，会保留历史用量。" : ""),
              )
            )
              return;
            await api("/admin/users/" + u.id, "PATCH", { enabled: !u.enabled });
            await load();
          },
          !!u.enabled,
        ),
        action("密钥", () => keys(u)),
      );
      if (u.id !== user.id)
        controls.append(
          action(
            "重置密码",
            async () => {
              if (
                !confirm(
                  "重置 " + u.username + " 的密码，并撤销全部会话和 API Key？",
                )
              )
                return;
              const r = await api(
                "/admin/users/" + u.id + "/reset-password",
                "POST",
              );
              $("user-password").textContent =
                u.username + "\n临时密码：" + r.temporary_password;
              $("user-secret").hidden = false;
              message(r.message);
            },
            true,
          ),
        );
      tr.append(controls);
      $("users-list").append(tr);
    }
    if (!data.users.length) {
      const tr = document.createElement("tr");
      const td = cell(tr, "没有匹配的账号");
      td.colSpan = 8;
      $("users-list").append(tr);
    }
    $("admin-page-info").textContent =
      "第 " + state.page + " 页 · 共 " + num(data.matching) + " 个匹配账号";
    $("admin-prev").disabled = state.page <= 1;
    $("admin-next").disabled = state.page * 50 >= data.matching;
    selection();
  }
  function edit(u) {
    const f = $("edit-form");
    f.hidden = false;
    $("edit-container").hidden = false;
    f.elements.id.value = u.id;
    $("editing-name").textContent = "设置账号：" + u.username;
    for (const k of quotaFields) f.elements[k].value = u[k];
    for (const box of f.querySelectorAll("[name=services]"))
      box.checked = u.services.includes(box.value);
    f.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function keys(u) {
    keyTarget = u.id;
    $("key-owner").textContent = "API Key：" + u.username;
    for (const box of $("key-services").querySelectorAll("input")) {
      box.disabled = !u.services.includes(box.value);
      box.checked = !box.disabled;
    }
    await tab("keys");
  }
  async function details(u) {
    const data = await api(
      "/admin/users/" +
        u.id +
        "/details?day=" +
        encodeURIComponent($("admin-filter-form").elements.day.value),
    );
    $("user-details").hidden = false;
    $("details-title").textContent = u.username + " · 账号详情";
    $("details-quotas").textContent =
      "RPM " +
      (u.rpm || "不限") +
      " · 并发 " +
      u.concurrency +
      " · 今日识别剩余 " +
      minutes(data.audio.asr.remaining) +
      " 分钟 · 合成剩余 " +
      num(data.audio.tts.remaining) +
      " 字符";
    $("details-ips").replaceChildren();
    const login = document.createElement("p");
    login.textContent =
      "最近登录：" +
      (data.user.last_login_ip ?? "未知") +
      (data.user.last_login_at ? " · " + date(data.user.last_login_at) : "");
    $("details-ips").append(login);
    for (const r of data.ips) {
      const line = document.createElement("p");
      line.textContent =
        r.client_ip +
        " · " +
        num(r.requests) +
        " 次 · 最近 " +
        date(r.last_seen);
      $("details-ips").append(line);
    }
    $("details-requests").replaceChildren();
    for (const r of data.requests) {
      const tr = document.createElement("tr");
      cell(tr, date(r.started));
      cell(tr, r.service + " · " + r.path);
      cell(tr, r.status ?? "进行中");
      cell(
        tr,
        r.luna_tokens !== null
          ? num(r.luna_tokens) + " tokens"
          : r.audio_kind === "asr"
            ? minutes(r.audio_units) + " 分钟"
            : r.audio_kind === "tts"
              ? num(r.audio_units) + " 字符"
              : num(r.prompt_tokens + r.completion_tokens) + " tokens",
      );
      cell(tr, r.client_ip ?? "未知");
      const client = cell(tr, r.client_version || "版本未知");
      const metadata = document.createElement("small");
      metadata.textContent =
        (r.device_id ? "设备 " + r.device_id + " · " : "") +
        (r.user_agent || "User-Agent 未知");
      client.append(metadata);
      cell(tr, r.request_id || r.id);
      $("details-requests").append(tr);
    }
    $("user-details").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function bulk(patch, label) {
    if (!state.selected.size) return;
    if (
      !confirm(
        label +
          "\n" +
          [...state.selected.values()].join("\n") +
          "\n共 " +
          state.selected.size +
          " 个账号",
      )
    )
      return;
    await api("/admin/users/bulk", "POST", {
      ids: [...state.selected.keys()],
      patch,
    });
    state.selected.clear();
    await load();
    message("批量设置已完成。");
  }
  $("admin-filter-form").addEventListener(
    "submit",
    run(async () => {
      state.page = 1;
      state.selected.clear();
      await load();
    }),
  );
  $("admin-refresh").addEventListener("click", run(load));
  $("select-clear").onclick = () => {
    state.selected.clear();
    for (const box of $("users-list").querySelectorAll("input[type=checkbox]"))
      box.checked = false;
    selection();
  };
  $("select-page").onchange = (e) => {
    const checked = e.target.checked;
    for (const box of $("users-list").querySelectorAll(
      "input[type=checkbox]",
    )) {
      box.checked = checked;
      box.onchange();
    }
  };
  $("admin-prev").addEventListener(
    "click",
    run(async () => {
      state.page--;
      await load();
    }),
  );
  $("admin-next").addEventListener(
    "click",
    run(async () => {
      state.page++;
      await load();
    }),
  );
  $("bulk-defaults").addEventListener(
    "click",
    run(() =>
      bulk(
        state.defaults,
        "将已保存的默认额度应用到以下账号：\n" +
          JSON.stringify(state.defaults, null, 2),
      ),
    ),
  );
  $("bulk-enable").addEventListener(
    "click",
    run(() => bulk({ enabled: true }, "解封以下账号？")),
  );
  $("bulk-disable").addEventListener(
    "click",
    run(() => bulk({ enabled: false }, "封禁以下账号并撤销现有登录？")),
  );
  $("quota-defaults-form").addEventListener(
    "submit",
    run(async (e) => {
      const b = Object.fromEntries(
        quotaFields.map((k) => [k, Number(e.target.elements[k].value)]),
      );
      await api("/admin/quota-defaults", "PATCH", b);
      state.defaults = b;
      message("默认额度已保存，仅对后续新账号生效。");
    }),
  );
  $("edit-cancel").onclick = () => {
    $("edit-form").hidden = true;
    $("edit-container").hidden = true;
  };
  $("load-audit").addEventListener(
    "click",
    run(async () => {
      $("admin-audit").textContent = JSON.stringify(
        await api("/admin/audit"),
        null,
        2,
      );
    }),
  );
  $("request-search-form").addEventListener(
    "submit",
    run(async (e) => {
      const rows = await api(
        "/admin/requests?request_id=" +
          encodeURIComponent(e.target.elements.request_id.value.trim()),
      );
      $("request-search-result").textContent = rows.length
        ? JSON.stringify(rows, null, 2)
        : "没有匹配记录（未通过认证的请求只记录于安全日志）";
    }),
  );
  async function review() {
    const f = $("quota-review-filter");
    const params = new URLSearchParams({ state: f.elements.state.value });
    if (f.elements.user_id.value)
      params.set("user_id", f.elements.user_id.value);
    const rows = await api("/admin/quota-review?" + params);
    $("quota-review-list").replaceChildren();
    for (const r of rows) {
      const tr = document.createElement("tr");
      cell(
        tr,
        r.username +
          " / " +
          (r.unit === "milliseconds"
            ? "识别毫秒"
            : r.unit === "characters"
              ? "合成字符"
              : "tokens"),
      );
      cell(tr, r.period);
      cell(tr, r.settled ? "已结算" : "预留 / 待核对");
      cell(tr, num(r.reserved_units) + " / " + num(r.charged_units));
      cell(
        tr,
        (r.request_id || r.lease) + " / " + (r.response_id || "提供方 ID 未知"),
      );
      const td = document.createElement("td");
      const button = action("核对实际用量", async () => {
        const raw = prompt(
          "填写实际扣量（Luna: tokens；识别: 毫秒；合成: Unicode 字符）",
          String(r.charged_units),
        );
        if (raw === null) return;
        const units = Number(raw);
        if (!Number.isSafeInteger(units) || units < 0)
          throw new Error("用量必须为非负整数");
        const reason = prompt(
          "填写核对依据及原因（至少五字符），不要包含密钥或原始音频文本",
        );
        if (reason === null) return;
        if (
          !confirm(
            "将本条用量从 " +
              r.charged_units +
              " 改为 " +
              units +
              "？\n" +
              reason,
          )
        )
          return;
        await api("/admin/quota-adjustments", "POST", {
          id: crypto.randomUUID(),
          kind: r.kind,
          lease: r.lease,
          expected_units: r.charged_units,
          units,
          reason,
        });
        await review();
        message("用量核对已记录审计");
      });
      button.disabled = !r.ended || r.adjustable_after > Date.now() / 1000;
      td.append(button);
      tr.append(td);
      $("quota-review-list").append(tr);
    }
    if (!rows.length) {
      const tr = document.createElement("tr");
      cell(tr, "暂无匹配账本").colSpan = 6;
      $("quota-review-list").append(tr);
    }
  }
  $("quota-review-filter").addEventListener("submit", run(review));
  window.adminUI = { load };
})();
