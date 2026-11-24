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
    filters: null,
    overview: null,
    details: null,
    summary: null,
    shown: false,
    loading: false,
    stale: false,
    defaultsRequest: null,
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
      $(id).disabled = !n || state.loading || state.stale;
    const boxes = [...$("users-list").querySelectorAll("input[type=checkbox]")];
    $("select-page").disabled = !boxes.length || state.loading || state.stale;
    $("select-page").checked =
      boxes.length > 0 && boxes.every((b) => b.checked);
    $("select-page").indeterminate =
      boxes.some((b) => b.checked) && !$("select-page").checked;
  }
  const filterForm = $("admin-filter-form");
  const today = () =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
      new Date(),
    );
  function readFilters() {
    return {
      q: filterForm.elements.q.value.trim(),
      status: filterForm.elements.status.value,
      day: filterForm.elements.day.value,
    };
  }
  function closeDetails() {
    state.details?.abort();
    $("details-content").hidden = true;
    $("user-secret").hidden = true;
    $("user-password").textContent = "";
  }
  function refreshControls() {
    const unavailable = state.loading || state.stale;
    $("admin-results").inert = unavailable;
    $("admin-results").setAttribute("aria-busy", String(state.loading));
    $("admin-prev").disabled = unavailable || state.page <= 1;
    $("admin-next").disabled = unavailable || state.page * 50 >= state.total;
    selection();
  }
  async function getDefaults() {
    if (state.defaults) return state.defaults;
    state.defaultsRequest ??= api("/admin/quota-defaults")
      .then((data) => (state.defaults = data))
      .finally(() => {
        state.defaultsRequest = null;
      });
    return state.defaultsRequest;
  }
  async function loadDefaultsForm(panelId, formId) {
    const statusId = panelId + "-status";
    const form = $(formId);
    if (!form.hidden) return;
    panelStatus(statusId, "正在读取默认额度…");
    try {
      const defaults = await getDefaults();
      for (const k of quotaFields) form.elements[k].value = defaults[k];
      form.hidden = false;
      panelStatus(statusId, "");
    } catch (error) {
      panelStatus(statusId, error.message, () =>
        loadDefaultsForm(panelId, formId),
      );
    }
  }
  const loadCreation = () => loadDefaultsForm("create-user", "user-form");
  $("quota-defaults").addEventListener("toggle", () => {
    if ($("quota-defaults").open)
      void loadDefaultsForm("quota-defaults", "quota-defaults-form");
  });
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
  async function load({ forceSummary = true, reuse = false } = {}) {
    if (user?.role !== "admin") return;
    if (!state.filters) {
      filterForm.elements.day.value = today();
      state.filters = readFilters();
    }
    if (
      reuse &&
      (state.loading ||
        (!state.stale &&
          state.shown &&
          state.summary &&
          Date.now() - state.summary.at < 30000))
    )
      return;
    state.overview?.abort();
    const request = new AbortController();
    state.overview = request;
    const filters = state.filters;
    const query = new URLSearchParams({
      ...filters,
      page: String(state.page),
      page_size: "50",
    });
    if (
      !forceSummary &&
      state.summary?.day === filters.day &&
      Date.now() - state.summary.at < 30000
    )
      query.set("summary", "0");

    state.loading = true;
    refreshControls();
    panelStatus(
      "admin-load-status",
      state.shown ? "正在更新账号列表…" : "正在加载账号与用量…",
    );
    try {
      const data = await api(
        "/admin/overview?" + query,
        "GET",
        undefined,
        request.signal,
      );
      if (request.signal.aborted) return;
      const last = Math.max(1, Math.ceil(data.matching / 50));
      if (state.page > last) {
        state.page = last;
        return await load({ forceSummary });
      }
      if (data.summary) {
        renderSummary(data.summary);
        state.summary = { day: filters.day, at: Date.now() };
      }
      renderUsers(data);
      state.shown = true;
      state.stale = false;
      panelStatus(
        "admin-load-status",
        filters.day +
          " · 北京时间" +
          (filters.q ? " · 搜索：" + filters.q : ""),
      );
    } catch (error) {
      if (request.signal.aborted) return;
      state.stale = true;
      panelStatus(
        "admin-load-status",
        error.message + (state.shown ? "。当前保留上一次结果。" : ""),
        () => load({ forceSummary }),
      );
    } finally {
      if (!request.signal.aborted) {
        state.loading = false;
        refreshControls();
      }
    }
  }
  function renderSummary(summary) {
    $("admin-summary").replaceChildren();
    for (const [label, value] of [
      ["账号总数", num(summary.users.total)],
      ["已启用", num(summary.enabled_users)],
      ["当日请求", num(summary.total)],
      ["失败 / 进行中", num(summary.failed) + " / " + num(summary.inflight)],
      ["识别分钟", minutes(summary.asr_ms)],
      ["合成字符", num(summary.tts_characters)],
    ]) {
      const card = document.createElement("div");
      const small = document.createElement("span");
      small.textContent = label;
      const strong = document.createElement("strong");
      strong.textContent = value;
      card.append(small, strong);
      $("admin-summary").append(card);
    }
  }
  function renderUsers(data) {
    state.total = data.matching;
    $("users-list").replaceChildren();
    for (const u of data.users) {
      const tr = document.createElement("tr");
      if (!u.enabled) tr.classList.add("disabled-user");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.setAttribute(
        "aria-label",
        "选择 " + u.display_name + " (#" + u.id + ")",
      );
      check.checked = state.selected.has(u.id);
      check.onchange = () => {
        if (check.checked)
          state.selected.set(u.id, u.display_name + " (#" + u.id + ")");
        else state.selected.delete(u.id);
        selection();
      };
      const selectTd = document.createElement("td");
      selectTd.append(check);
      tr.append(selectTd);
      const name = cell(tr, "");
      const link = document.createElement("a");
      link.href = "/admin/users/" + u.id;
      link.className = "user-name-link";
      link.textContent = u.display_name;
      link.addEventListener("click", (event) => {
        if (
          event.button ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        void navigateAdmin("user/" + u.id);
      });
      name.append(link);
      const identifier = document.createElement("small");
      identifier.textContent =
        "#" + u.id + " · " + (u.email || "未设置登录邮箱");
      name.append(identifier);
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
      $("users-list").append(tr);
    }
    if (!data.users.length) {
      const tr = document.createElement("tr");
      const td = cell(tr, "没有匹配的账号");
      td.colSpan = 7;
      $("users-list").append(tr);
    }
    $("admin-page-info").textContent =
      "第 " + state.page + " 页 · 共 " + num(data.matching) + " 个匹配账号";
  }
  function userActions(u) {
    const controls = $("user-actions");
    controls.replaceChildren();
    controls.append(
      action(
        u.enabled ? "封禁" : "解封",
        async () => {
          if (
            !confirm(
              (u.enabled ? "封禁" : "解封") +
                "账号 " +
                u.display_name +
                "？" +
                (u.enabled ? "封禁会撤销现有登录，会保留历史用量。" : ""),
            )
          )
            return;
          await api("/admin/users/" + u.id, "PATCH", { enabled: !u.enabled });
          await reloadUser(u.id);
        },
        !!u.enabled,
      ),
      action("核对该账号额度", async () => {
        await navigateAdmin("operations");
        $("quota-review-filter").elements.user_id.value = u.id;
        $("quota-review").open = true;
        $("quota-review").scrollIntoView({ block: "start" });
        await review();
      }),
    );
    if (!u.email)
      controls.append(
        action("设置登录邮箱", async () => {
          const email = prompt(
            "为账号 #" + u.id + " 设置登录邮箱（不会标记已验证）",
          );
          if (!email) return;
          await api("/admin/users/" + u.id + "/login-email", "PUT", {
            email,
          });
          await reloadUser(u.id);
          message("登录邮箱已设置，请账号本人验证邮箱");
        }),
      );
    if (u.id !== user.id)
      controls.append(
        action(
          "重置密码",
          async () => {
            if (
              !confirm(
                "重置 " +
                  u.display_name +
                  " 的密码，并撤销全部会话和 API Key？",
              )
            )
              return;
            const r = await api(
              "/admin/users/" + u.id + "/reset-password",
              "POST",
            );
            $("user-password").textContent =
              u.display_name + "\n临时密码：" + r.temporary_password;
            $("user-secret").hidden = false;
            message(r.message);
          },
          true,
        ),
      );
  }
  function setupSettings(u, request, prefetched) {
    const form = $("edit-form"),
      list = $("user-model-list");
    form.elements.id.value = u.id;
    const allowed = u.allowed_model_ids ?? null;
    list.querySelectorAll("label").forEach((label) => label.remove());
    list.hidden = true;
    for (const k of quotaFields) form.elements[k].value = u[k];
    for (const box of form.querySelectorAll("[name=services]"))
      box.checked = u.services.includes(box.value);
    const save = $("save-user-settings");
    let ready = false;
    form.dataset.modelsReady = "false";
    let loading = false;
    save.disabled = true;
    async function loadModels() {
      if (ready || loading || request.signal.aborted) return;
      loading = true;
      panelStatus("user-model-status", "正在读取模型…");
      try {
        const first = prefetched;
        prefetched = null;
        const result = first
          ? await first.then(({ data, error }) => {
              if (error) throw error;
              return data;
            })
          : await api("/admin/models", "GET", undefined, request.signal);
        if (request.signal.aborted) return;
        for (const model of result.models) {
          const option = document.createElement("label");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.name = "allowed_models";
          box.value = model.id;
          box.checked = allowed?.includes(model.id) ?? model.enabled;
          box.defaultChecked = box.checked;
          option.append(
            box,
            model.name +
              (!model.enabled
                ? " · 全站关闭"
                : model.cloud_paused
                  ? " · 云模型已暂停"
                  : ""),
          );
          list.append(option);
        }
        ready = true;
        form.dataset.modelsReady = "true";
        panelStatus("user-model-status", "");
        list.hidden = false;
        save.disabled = false;
      } catch (error) {
        if (!request.signal.aborted)
          panelStatus("user-model-status", error.message, loadModels);
      } finally {
        loading = false;
      }
    }
    void loadModels();
  }
  function setupKeys(u) {
    keyTarget = u.id;
    const panel = $("user-keys");
    $("keys-list").replaceChildren();
    $("key-value").textContent = "";
    $("key-secret").hidden = true;
    for (const box of $("key-services").querySelectorAll("input")) {
      box.disabled = !u.services.includes(box.value);
      box.checked = !box.disabled;
    }
    panel.ontoggle = run(async () => {
      if (panel.open && !$("user-panel").hidden) await loadKeys();
      else {
        $("key-value").textContent = "";
        $("key-secret").hidden = true;
      }
    });
    if (panel.open) void loadKeys();
  }
  function invalidateList() {
    state.summary = null;
  }
  async function reloadUser(id) {
    invalidateList();
    if (adminLocation() === "user/" + id) await details(id);
  }
  async function details(id) {
    state.details?.abort();
    const request = new AbortController();
    state.details = request;
    $("user-password").textContent = "";
    $("user-secret").hidden = true;
    $("details-content").hidden = true;
    $("details-title").textContent = "账号 #" + id;
    panelStatus("details-status", "正在读取账号详情…");
    const modelList = api(
      "/admin/models",
      "GET",
      undefined,
      request.signal,
    ).then(
      (data) => ({ data }),
      (error) => ({ error }),
    );
    const day = state.filters?.day ?? today();
    const detailsPath = "/admin/users/" + id + "/details?";
    let data;
    try {
      data = await api(
        detailsPath + new URLSearchParams({ day, view: "summary" }),
        "GET",
        undefined,
        request.signal,
      );
    } catch (error) {
      if (!request.signal.aborted)
        panelStatus("details-status", error.message, () => details(id));
      return;
    }
    if (request.signal.aborted) return;
    const u = data.user;
    $("details-requests-title").textContent =
      "最近 100 次请求 · " +
      (data.day ?? state.filters?.day ?? today()) +
      "（北京时间）";
    $("details-title").textContent = u.display_name + " (#" + u.id + ")";
    $("user-account-meta").textContent = [
      u.email || "未设置邮箱",
      u.email_verified_at ? "邮箱已验证" : "邮箱未验证",
      u.role === "admin" ? "管理员" : "普通用户",
      u.enabled ? "已启用" : "已封禁",
      u.must_change ? "待修改初始密码" : "",
      u.created ? "创建于 " + date(u.created) : "",
      u.allowed_model_ids == null
        ? "使用全站默认模型"
        : "模型白名单 " + u.allowed_model_ids.length + " 项",
    ]
      .filter(Boolean)
      .join(" · ");
    panelStatus("details-status", "");
    setupSettings(u, request, modelList);
    setupKeys(u);
    userActions(u);
    $("details-content").hidden = false;
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
    const activity = $("user-activity");
    const activityContent = $("user-activity-content");
    activityContent.hidden = true;
    let pending = false;
    async function loadActivity() {
      if (pending || !activityContent.hidden || request.signal.aborted) return;
      pending = true;
      panelStatus("user-activity-status", "正在读取活动记录…");
      try {
        const records = await api(
          detailsPath + new URLSearchParams({ day, view: "activity" }),
          "GET",
          undefined,
          request.signal,
        );
        if (request.signal.aborted) return;
        renderActivity(u, records);
        activityContent.hidden = false;
        panelStatus("user-activity-status", "");
      } catch (error) {
        if (!request.signal.aborted)
          panelStatus("user-activity-status", error.message, loadActivity);
      } finally {
        pending = false;
      }
    }
    activity.ontoggle = () => {
      if (activity.open) void loadActivity();
    };
    if (activity.open) void loadActivity();
  }
  function renderActivity(u, data) {
    $("details-ips").replaceChildren();
    const login = document.createElement("p");
    login.textContent =
      "最近登录：" +
      (u.last_login_ip ?? "未知") +
      (u.last_login_at ? " · " + date(u.last_login_at) : "");
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
    if (!data.requests.length) {
      const row = document.createElement("tr");
      cell(row, "所选日期暂无请求").colSpan = 7;
      $("details-requests").append(row);
    }
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
      state.filters = readFilters();
      state.selected.clear();
      closeDetails();
      await load({ forceSummary: false });
    }),
  );
  $("admin-refresh").addEventListener(
    "click",
    run(async () => {
      closeDetails();
      await load();
    }),
  );
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
      closeDetails();
      await load({ forceSummary: false });
    }),
  );
  $("admin-next").addEventListener(
    "click",
    run(async () => {
      state.page++;
      closeDetails();
      await load({ forceSummary: false });
    }),
  );
  $("bulk-defaults").addEventListener(
    "click",
    run(async () => {
      const defaults = await getDefaults();
      await bulk(defaults, "将已保存的默认额度应用到以下账号？");
    }),
  );
  $("bulk-enable").addEventListener(
    "click",
    run(() => bulk({ enabled: true }, "解封以下账号？")),
  );
  $("bulk-disable").addEventListener(
    "click",
    run(() => bulk({ enabled: false }, "封禁以下账号并撤销现有登录？")),
  );
  $("user-form").addEventListener("input", (event) => {
    if (quotaFields.includes(event.target.name))
      event.target.dataset.edited = "true";
  });
  $("quota-defaults-form").addEventListener(
    "submit",
    run(async (e) => {
      const b = Object.fromEntries(
        quotaFields.map((k) => [k, Number(e.target.elements[k].value)]),
      );
      await api("/admin/quota-defaults", "PATCH", b);
      state.defaults = b;
      const create = $("user-form");
      for (const k of quotaFields) {
        if (!create.elements[k].dataset.edited) create.elements[k].value = b[k];
      }
      message("默认额度已保存，仅对后续新账号生效。");
    }),
  );
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
  $("download-diagnostic").addEventListener(
    "click",
    run(async () => {
      const id = $("request-search-form").elements.request_id.value.trim();
      if (!id) throw new Error("请填写服务端请求 ID");
      const data = await api(
        "/admin/diagnostic-bundle?request_id=" + encodeURIComponent(id),
      );
      const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json",
          }),
        ),
        link = document.createElement("a");
      link.href = url;
      link.download =
        "provider-diagnostic-" +
        (data.request?.request_id ?? "request") +
        ".json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
  );
  $("network-stats-form").addEventListener(
    "submit",
    run(async (e) => {
      const f = e.target,
        params = new URLSearchParams({ hours: f.elements.hours.value });
      for (const k of ["country", "colo", "model"])
        if (f.elements[k].value.trim())
          params.set(
            k,
            k === "model"
              ? f.elements[k].value.trim()
              : f.elements[k].value.trim().toUpperCase(),
          );
      const data = await api("/admin/network-stats?" + params);
      $("network-summary").textContent =
        "收到 " +
        num(data.summary.requests) +
        " 次，成功 " +
        num(data.summary.successful) +
        " 次，地区拒绝 " +
        num(data.summary.region_restricted) +
        " 次" +
        (data.truncated ? "；仅显示前 200 组" : "");
      $("network-groups").replaceChildren();
      for (const r of data.groups) {
        const tr = document.createElement("tr");
        cell(tr, r.country + " / " + r.colo);
        cell(tr, r.model + " / " + r.protocol);
        cell(tr, r.requests + " / " + r.provider_attempts);
        cell(tr, r.successful + " / " + r.failed + " / " + r.inflight);
        cell(
          tr,
          (r.success_rate * 100).toFixed(1) +
            "% / " +
            (r.region_error_rate * 100).toFixed(1) +
            "%" +
            (r.requests < 20 ? "（样本少于 20）" : ""),
        );
        cell(tr, new Date(r.last_seen * 1000).toLocaleString());
        $("network-groups").append(tr);
      }
      $("network-probe-result").textContent = JSON.stringify(
        data.observations,
        null,
        2,
      );
    }),
  );
  $("run-network-probe").addEventListener(
    "click",
    run(async () => {
      $("network-probe-result").textContent = JSON.stringify(
        await api("/admin/network-probe", "POST", {}),
        null,
        2,
      );
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
        r.display_name +
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
          "填写实际扣量（云文本: tokens；识别: 毫秒；合成: Unicode 字符）",
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
        let costs = {};
        if (r.kind === "luna") {
          const dollars = prompt(
            "填写核对后的美元成本（不是 token 数）",
            String(units === 0 ? 0 : r.charged_cost_nanos / 1e9),
          );
          if (dollars === null) return;
          const value = Number(dollars);
          if (!Number.isFinite(value) || value < 0)
            throw new Error("成本应为非负美元数");
          costs = {
            cost_nanos: Math.round(value * 1e9),
            expected_cost_nanos: r.charged_cost_nanos,
          };
        }
        await api("/admin/quota-adjustments", "POST", {
          ...costs,
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
  async function loadOperations({ alerts = false } = {}) {
    const status = alerts ? "runtime-alerts-status" : "global-config-status";
    panelStatus(status, "正在读取…");
    let data;
    try {
      data = await api(
        "/admin/operations?view=" + (alerts ? "alerts" : "configuration"),
      );
    } catch (error) {
      panelStatus(status, error.message, () => loadOperations({ alerts }));
      return;
    }
    panelStatus(status, "");
    if (!alerts) {
      renderGlobalConfiguration(data);
      return;
    }
    renderRuntimeAlerts(data);
  }
  function renderGlobalConfiguration(data) {
    $("global-config-fields").hidden = false;
    const r = $("registration-policy-form");
    r.elements.enabled.checked = data.registration.enabled;
    for (const k of ["ip_hourly", "global_hourly", "global_minute"])
      r.elements[k].value = data.registration[k];
    renderBudget(data);
    if ($("email-delivery-status"))
      $("email-delivery-status").textContent = data.email_delivery
        ?.transactional
        ? "验证码发信：事务邮件通道已配置（" +
          data.email_delivery.provider +
          "）"
        : "验证码发信：仍为旧通道或未配置，待切换事务邮件服务";
  }
  function renderBudget(data) {
    const f = $("global-limits-form");
    f.elements.cloud_enabled.checked = data.limits.cloud_enabled;
    for (const k of [
      "luna_monthly_usd",
      "asr_daily_minutes",
      "tts_daily_characters",
    ])
      f.elements[k].value = data.limits[k] ?? "";
    $("global-budget-summary").textContent =
      data.month +
      "（北京时间）网关云文本估算用量 $" +
      data.luna.used_usd.toFixed(4) +
      "，其中预留 $" +
      data.luna.reserved_usd.toFixed(4) +
      "，剩余 $" +
      data.luna.remaining_usd.toFixed(4);
  }
  function renderRuntimeAlerts(data) {
    const notifications = data.notifications ?? {
      configured: false,
      deliveries: [],
    };
    $("notification-status").textContent =
      "默认接收位置：站内告警中心 " +
      (notifications.destination_url ??
        "https://accounts.hilex.me/admin#alerts") +
      (notifications.external_configured
        ? "；另已配置外部 HTTPS Webhook（" +
          notifications.destination_host +
          "）"
        : "；未启用外部推送");
    $("test-notification").disabled = !notifications.configured;
    $("notification-deliveries").textContent = JSON.stringify(
      notifications.deliveries,
      null,
      2,
    );
    $("operational-alerts").replaceChildren();
    const names = {
      provider_region_restricted: "上游地区限制",
      slow_first_audio: "首音频响应偏慢",
      provider_error_rate: "模型错误率偏高",
      pending_usage: "存在待核对额度",
      high_latency: "请求延迟偏高",
      luna_budget: "云文本全站预算接近上限",
    };
    for (const alert of data.alerts) {
      const row = document.createElement("p");
      row.textContent =
        (names[alert.kind] ?? alert.kind) +
        " · " +
        alert.state +
        " · " +
        new Date(alert.last_seen * 1000).toLocaleString() +
        " · " +
        alert.details;
      if (alert.state === "open") {
        const button = document.createElement("button");
        button.textContent = "已知悉";
        button.onclick = run(async () => {
          await api("/admin/alerts/acknowledge", "POST", { kind: alert.kind });
          await loadOperations({ alerts: true });
        });
        row.append(button);
      }
      $("operational-alerts").append(row);
    }
    if (!data.alerts.some((a) => a.state === "open")) {
      const p = document.createElement("p");
      p.textContent = "暂无未处理告警；监测每 15 分钟运行一次。";
      $("operational-alerts").append(p);
    }
  }
  $("test-notification").addEventListener(
    "click",
    run(async () => {
      await api("/admin/notifications/test", "POST", {});
      await Promise.all([loadOperations({ alerts: true }), loadInbox()]);
      message("测试通知已处理");
    }),
  );
  $("load-operations").addEventListener(
    "click",
    run(() => loadOperations({ alerts: true })),
  );
  $("cloud-configuration").addEventListener(
    "toggle",
    run(async () => {
      if ($("cloud-configuration").open && $("global-config-fields").hidden)
        await loadOperations();
    }),
  );
  $("runtime-alerts").addEventListener(
    "toggle",
    run(async () => {
      if ($("runtime-alerts").open) await loadOperations({ alerts: true });
    }),
  );
  $("global-limits-form").addEventListener(
    "submit",
    run(async (e) => {
      const f = e.target;
      const budget = await api("/admin/global-limits", "PATCH", {
        cloud_enabled: f.elements.cloud_enabled.checked,
        luna_monthly_usd: Number(f.elements.luna_monthly_usd.value),
        asr_daily_minutes:
          f.elements.asr_daily_minutes.value === ""
            ? null
            : Number(f.elements.asr_daily_minutes.value),
        tts_daily_characters:
          f.elements.tts_daily_characters.value === ""
            ? null
            : Number(f.elements.tts_daily_characters.value),
      });
      renderBudget(budget);
      message("全站预算已保存；不会清零已有用量");
    }),
  );
  $("registration-policy-form").addEventListener(
    "submit",
    run(async (e) => {
      const f = e.target;
      await api("/admin/registration-policy", "PATCH", {
        enabled: f.elements.enabled.checked,
        ...Object.fromEntries(
          ["ip_hourly", "global_hourly", "global_minute"].map((k) => [
            k,
            Number(f.elements[k].value),
          ]),
        ),
      });
      message("注册保护已保存");
    }),
  );
  const inboxState = { page: 1, items: [] };
  const alertNames = {
    provider_region_restricted: "上游地区限制",
    provider_error_rate: "模型错误率偏高",
    pending_usage: "存在待核对额度",
    high_latency: "请求延迟偏高",
    slow_first_audio: "首音频响应偏慢",
    luna_budget: "云文本预算接近上限",
    test: "测试通知",
  };
  function inboxBadge(n) {
    $("alert-badge").textContent = n > 999 ? "999+" : String(n);
    $("alert-badge").hidden = !n;
  }
  async function markInboxRead(ids) {
    if (!ids.length) return;
    await api("/admin/notifications/read", "POST", { ids });
    inboxState.page = 1;
    await loadInbox();
  }
  const readInbox = adminListReader("inbox-load-status", "inbox-list", () =>
    loadInbox(),
  );
  async function loadInbox() {
    if (user?.role !== "admin" || user.must_change) return;
    const state = $("inbox-filter").value;
    for (const id of ["inbox-prev", "inbox-next", "read-inbox-page"])
      $(id).disabled = true;
    const data = await readInbox(
      "/admin/notifications?" +
        new URLSearchParams({ page: String(inboxState.page), state }),
    );
    if (!data) return;
    const count = state === "unread" ? data.unread : data.total;
    const last = Math.max(1, Math.ceil(count / data.page_size));
    if (inboxState.page > last) {
      inboxState.page = last;
      return loadInbox();
    }
    inboxState.items = data.items;
    inboxBadge(data.unread);
    $("inbox-summary").textContent =
      "共 " + num(data.total) + " 条通知，未读 " + num(data.unread) + " 条";
    $("inbox-list").replaceChildren();
    for (const item of data.items) {
      const card = document.createElement("article"),
        title = document.createElement("h3"),
        meta = document.createElement("p"),
        detail = document.createElement("pre");
      card.className = "notification-card" + (item.read_at ? "" : " unread");
      title.textContent =
        (item.read_at ? "" : "未读 · ") +
        (alertNames[item.kind] ?? "运行通知") +
        (item.state === "resolved" ? " · 已恢复" : "");
      meta.textContent = new Date(item.created * 1000).toLocaleString();
      detail.textContent = JSON.stringify(item.payload?.details ?? {}, null, 2);
      card.append(title, meta, detail);
      if (!item.read_at)
        card.append(action("标为已读", () => markInboxRead([item.id])));
      $("inbox-list").append(card);
    }
    if (!data.items.length) {
      const p = document.createElement("p");
      p.textContent = "暂无匹配通知";
      $("inbox-list").append(p);
    }
    $("inbox-page").textContent = "第 " + data.page + " 页";
    $("inbox-prev").disabled = data.page <= 1;
    const total = state === "unread" ? data.unread : data.total;
    $("inbox-next").disabled = data.page * data.page_size >= total;
    $("read-inbox-page").disabled = !data.items.some((n) => !n.read_at);
  }
  $("refresh-inbox").addEventListener("click", run(loadInbox));
  $("inbox-filter").addEventListener(
    "change",
    run(async () => {
      inboxState.page = 1;
      await loadInbox();
    }),
  );
  $("read-inbox-page").addEventListener(
    "click",
    run(() =>
      markInboxRead(
        inboxState.items.filter((n) => !n.read_at).map((n) => n.id),
      ),
    ),
  );
  $("inbox-prev").addEventListener(
    "click",
    run(async () => {
      inboxState.page = Math.max(1, inboxState.page - 1);
      await loadInbox();
    }),
  );
  $("inbox-next").addEventListener(
    "click",
    run(async () => {
      inboxState.page++;
      await loadInbox();
    }),
  );
  $("show-operational-alerts").addEventListener(
    "click",
    run(async () => {
      $("runtime-alerts").open = true;
      $("runtime-alerts").scrollIntoView({ behavior: "smooth" });
    }),
  );
  window.adminUI = {
    load,
    loadInbox,
    details,
    closeDetails,
    reloadUser,
    loadCreation,
    invalidateList,
  };
})();
