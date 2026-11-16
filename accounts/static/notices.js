"use strict";
(() => {
  let page = 1,
    adminPage = 1,
    editing = null,
    timer;
  const show = (parent, tag, text) => {
    const e = document.createElement(tag);
    e.textContent = text;
    parent.append(e);
    return e;
  };
  function badge(n) {
    $("notice-badge").textContent = n > 999 ? "999+" : n;
    $("notice-badge").hidden = !n;
  }
  const DAY = 86400000,
    memory = new Map();
  let checking = false;
  const cacheKey = (id) => "ai-gateway:notice-summary:v2:" + id;
  function cached(id) {
    try {
      const value = JSON.parse(localStorage.getItem(cacheKey(id)) || "null");
      if (value && typeof value === "object") return value;
    } catch {}
    return memory.get(id) || {};
  }
  function save(id, value) {
    memory.set(id, value);
    try {
      localStorage.setItem(cacheKey(id), JSON.stringify(value));
    } catch {}
  }
  function summary(data) {
    if (!user) return;
    const unread = Number(data.unread) || 0;
    save(user.id, { unread, checkedAt: Date.now(), retryAt: 0 });
    badge(unread);
    schedule();
  }
  function nextCheck(id) {
    const value = cached(id),
      now = Date.now();
    const checked =
      Number.isFinite(value.checkedAt) && value.checkedAt <= now + 60000
        ? value.checkedAt
        : 0;
    const retry =
      Number.isFinite(value.retryAt) && value.retryAt <= now + DAY + 60000
        ? value.retryAt
        : 0;
    return Math.max(checked ? checked + DAY : 0, retry);
  }
  function schedule() {
    clearTimeout(timer);
    if (!user || user.must_change) return;
    const delay = document.hidden
      ? DAY
      : Math.max(60000, nextCheck(user.id) - Date.now());
    timer = setTimeout(() => poll().finally(schedule), Math.min(DAY, delay));
  }
  async function poll() {
    if (
      !user ||
      user.must_change ||
      document.hidden ||
      navigator.onLine === false ||
      checking
    )
      return;
    const id = user.id;
    const check = async () => {
      if (Date.now() < nextCheck(id)) return;
      checking = true;
      // Persist the attempt before sending: errors/reloads must not turn into rapid retries.
      save(id, { ...cached(id), retryAt: Date.now() + DAY });
      try {
        const data = await api("/account/notices/unread-count");
        if (user?.id === id) summary(data);
      } catch {
      } finally {
        checking = false;
      }
    };
    if (navigator.locks?.request) {
      try {
        await navigator.locks.request(
          cacheKey(id),
          { ifAvailable: true },
          (lock) => (lock ? check() : undefined),
        );
      } catch {
        await check();
      }
    } else await check();
  }
  function start() {
    clearTimeout(timer);
    if (!user) return;
    badge(Number(cached(user.id).unread) || 0);
    poll().finally(schedule);
  }
  const timestamp = (value) =>
    value ? new Date(value).getTime() / 1000 : null;
  const local = (value) => {
    if (!value) return "";
    const d = new Date(value * 1000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  async function load() {
    const data = await api(
      "/account/notices?page=" + page + "&state=" + $("notice-filter").value,
    );
    summary(data);
    $("notice-items").replaceChildren();
    $("notice-summary").textContent =
      "共 " +
      data.total +
      " 条有效通告 · 未读 " +
      data.unread +
      " 条 · 第 " +
      data.page +
      " 页";
    for (const n of data.items) {
      const card = document.createElement("article");
      card.className = "notification-card" + (n.read_at ? "" : " unread");
      show(
        card,
        "h3",
        (n.priority === "important" ? "【重要】" : "") + n.title,
      );
      show(
        card,
        "small",
        date(n.published_at) + (n.read_at ? " · 已读" : " · 未读"),
      );
      show(card, "p", n.body).style.whiteSpace = "pre-wrap";
      if (!n.read_at) {
        const button = action("标记已读", async () => {
          button.disabled = true;
          try {
            const result = await api("/account/notices/read", "POST", {
              ids: [n.id],
            });
            summary(result);
            data.unread = result.unread;
            n.read_at = Date.now() / 1000;
            card.querySelector("small").textContent =
              date(n.published_at) + " · 已读";
            card.classList.remove("unread");
            button.remove();
            if ($("notice-filter").value === "unread") card.remove();
            $("notice-summary").textContent =
              "共 " +
              data.total +
              " 条有效通告 · 未读 " +
              data.unread +
              " 条 · 第 " +
              data.page +
              " 页";
            if (!$("notice-items").children.length)
              show($("notice-items"), "p", "暂无通告");
          } catch (error) {
            button.disabled = false;
            throw error;
          }
        });
        card.append(button);
      }
      $("notice-items").append(card);
    }
    if (!data.items.length) show($("notice-items"), "p", "暂无通告");
    $("notice-prev").disabled = page <= 1;
    $("notice-next").disabled =
      page * 30 >=
      ($("notice-filter").value === "unread" ? data.unread : data.total);
    $("notice-management").hidden = user.role !== "admin";
    if (user.role === "admin" && $("notice-management").open) await loadAdmin();
  }
  async function loadAdmin() {
    const data = await api("/admin/notices?page=" + adminPage);
    $("notice-admin-items").replaceChildren();
    $("notice-admin-page").textContent =
      "第 " + adminPage + " 页 · 共 " + data.total + " 条";
    $("notice-admin-prev").disabled = adminPage <= 1;
    $("notice-admin-next").disabled = adminPage * 30 >= data.total;
    for (const n of data.items) {
      const card = document.createElement("article");
      card.className = "notification-card";
      show(card, "h3", n.title);
      show(
        card,
        "small",
        { draft: "草稿", published: "已发布", withdrawn: "已撤回" }[n.state] +
          " · " +
          (n.audience === "all"
            ? "全体账号"
            : "指定账号：" + n.user_ids.join(", ")) +
          " · 生效 " +
          date(n.starts_at) +
          (n.expires_at ? " · 到期 " + date(n.expires_at) : ""),
      );
      show(card, "p", n.body).style.whiteSpace = "pre-wrap";
      if (n.state === "draft") {
        card.append(
          action("编辑草稿", () => {
            editing = n;
            const f = $("notice-form");
            for (const k of ["title", "body", "priority", "audience"])
              f.elements[k].value = n[k];
            f.elements.user_ids.value = n.user_ids.join(",");
            f.elements.starts_at.value = local(n.starts_at);
            f.elements.expires_at.value = local(n.expires_at);
            $("notice-edit-status").textContent = "正在编辑草稿";
            f.scrollIntoView();
          }),
        );
        card.append(
          action("发布", async () => {
            if (
              !confirm(
                "将此通告发布给" +
                  (n.audience === "all" ? "全体账号" : "指定账号") +
                  "？",
              )
            )
              return;
            await api("/admin/notices/" + n.id + "/publish", "POST", {
              version: n.version,
            });
            await load();
            message("通告已发布");
          }),
        );
      }
      if (n.state === "published")
        card.append(
          action(
            "撤回",
            async () => {
              if (
                !confirm(
                  "撤回后客户端下次刷新不再显示此通告，已收到的内容无法收回。继续？",
                )
              )
                return;
              await api("/admin/notices/" + n.id + "/withdraw", "POST", {
                version: n.version,
              });
              await load();
              message("通告已撤回");
            },
            true,
          ),
        );
      $("notice-admin-items").append(card);
    }
  }
  function reset() {
    editing = null;
    $("notice-form").reset();
    $("notice-edit-status").textContent = "新建草稿";
  }
  $("notice-form").addEventListener(
    "submit",
    run(async (e) => {
      const f = e.target,
        ids = f.elements.user_ids.value.trim();
      const b = {
        title: f.elements.title.value,
        body: f.elements.body.value,
        priority: f.elements.priority.value,
        audience: f.elements.audience.value,
        user_ids:
          f.elements.audience.value === "all"
            ? []
            : ids.split(",").map((s) => Number(s.trim())),
        starts_at: timestamp(f.elements.starts_at.value) ?? Date.now() / 1000,
        expires_at: timestamp(f.elements.expires_at.value),
      };
      if (editing) b.version = editing.version;
      await api(
        "/admin/notices" + (editing ? "/" + editing.id : ""),
        editing ? "PATCH" : "POST",
        b,
      );
      reset();
      adminPage = 1;
      await loadAdmin();
      message("草稿已保存；点击发布后客户端才能看到");
    }),
  );
  $("notice-reset").onclick = reset;
  $("notice-refresh").addEventListener("click", run(load));
  $("notice-filter").addEventListener(
    "change",
    run(async () => {
      page = 1;
      await load();
    }),
  );
  $("notice-prev").addEventListener(
    "click",
    run(async () => {
      page = Math.max(1, page - 1);
      await load();
    }),
  );
  $("notice-next").addEventListener(
    "click",
    run(async () => {
      page++;
      await load();
    }),
  );
  $("notice-admin-prev").addEventListener(
    "click",
    run(async () => {
      adminPage = Math.max(1, adminPage - 1);
      await loadAdmin();
    }),
  );
  $("notice-admin-next").addEventListener(
    "click",
    run(async () => {
      adminPage++;
      await loadAdmin();
    }),
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll().finally(schedule);
  });
  window.addEventListener("online", () => poll().finally(schedule));
  window.addEventListener("storage", (event) => {
    if (user && event.key === cacheKey(user.id)) {
      badge(Number(cached(user.id).unread) || 0);
      schedule();
    }
  });
  $("notice-management").addEventListener(
    "toggle",
    run(async () => {
      if ($("notice-management").open && user?.role === "admin")
        await loadAdmin();
    }),
  );
  window.noticeUI = { load, start };
})();
