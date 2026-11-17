"use strict";
(() => {
  let page = 1,
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
  }
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
  window.noticeUI = { load, start };
})();
