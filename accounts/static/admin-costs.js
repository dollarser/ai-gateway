"use strict";
(() => {
  const cache = new Map();
  const pending = new Map();
  let sequence = 0;
  const money = (value, currency) =>
    new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "code",
      maximumFractionDigits: 6,
    }).format(value);
  const isoDay = (seconds) =>
    new Date(seconds * 1000).toISOString().slice(0, 10);

  function render(data) {
    const totals = new Map();
    const peaks = new Map();
    for (const day of data.days) {
      for (const [currency, amount] of Object.entries(day.amounts)) {
        totals.set(currency, (totals.get(currency) ?? 0) + amount);
        peaks.set(
          currency,
          Math.max(peaks.get(currency) ?? 0, Math.abs(amount)),
        );
      }
    }
    $("costs-totals").replaceChildren();
    $("costs-days").replaceChildren();
    for (const [currency, total] of totals) {
      const card = document.createElement("div");
      const label = document.createElement("span");
      const value = document.createElement("strong");
      label.textContent = "区间合计";
      value.textContent = money(total, currency);
      card.append(label, value);
      $("costs-totals").append(card);
    }
    for (const day of [...data.days].reverse()) {
      const row = document.createElement("tr");
      const date = document.createElement("th");
      date.scope = "row";
      date.textContent = day.date;
      const cell = document.createElement("td");
      for (const [currency, amount] of Object.entries(day.amounts)) {
        const line = document.createElement("div");
        line.className = "costs-amount";
        const value = document.createElement("span");
        value.textContent = money(amount, currency);
        const bar = document.createElement("progress");
        bar.max = peaks.get(currency) || 1;
        bar.value = Math.abs(amount);
        bar.classList.toggle("negative", amount < 0);
        bar.setAttribute("aria-hidden", "true");
        line.append(value, bar);
        cell.append(line);
      }
      if (!cell.hasChildNodes()) cell.textContent = "无费用记录";
      row.append(date, cell);
      $("costs-days").append(row);
    }
    $("costs-data").hidden = !totals.size;
    const range =
      isoDay(data.start_time) + " 至 " + isoDay(data.end_time) + "（UTC）";
    const fetched = new Date(data.fetched_at * 1000).toLocaleString("zh-CN");
    $("costs-status").textContent = totals.size
      ? range + " · 获取于 " + fetched + "（本地时间）"
      : range + " · OpenAI 暂无费用记录";
  }

  async function load(force = false) {
    const current = ++sequence;
    const period = $("costs-period").value;
    const stored = cache.get(period);
    const status = $("costs-status");
    status.classList.remove("error");
    $("costs-refresh").disabled = false;
    $("costs-data").removeAttribute("aria-busy");
    if (!force && stored && Date.now() - stored.received < 300000) {
      render(stored.data);
      return;
    }
    $("costs-refresh").disabled = true;
    $("costs-data").setAttribute("aria-busy", "true");
    if (stored) render(stored.data);
    else $("costs-data").hidden = true;
    status.textContent = "正在读取 OpenAI 费用…";
    if (!pending.has(period)) {
      pending.set(
        period,
        api("/admin/openai-costs?period=" + period)
          .then((data) => {
            cache.set(period, { data, received: Date.now() });
            return data;
          })
          .finally(() => pending.delete(period)),
      );
    }
    try {
      const data = await pending.get(period);
      if (current === sequence) render(data);
    } catch (error) {
      if (current !== sequence) return;
      status.classList.add("error");
      status.textContent = stored
        ? error.message +
          "。当前显示上次成功获取的数据（" +
          new Date(stored.data.fetched_at * 1000).toLocaleString("zh-CN") +
          "）。"
        : error.message;
    } finally {
      if (current === sequence) {
        $("costs-refresh").disabled = false;
        $("costs-data").removeAttribute("aria-busy");
      }
    }
  }
  $("costs-period").addEventListener("change", () => void load());
  $("costs-refresh").addEventListener("click", () => void load(true));
  window.adminCosts = { load };
})();
