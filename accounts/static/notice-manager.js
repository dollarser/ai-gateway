"use strict";
(() => {
  let adminPage = 1,
    editing = null;
  const show = (parent, tag, text) => {
    const e = document.createElement(tag);
    e.textContent = text;
    parent.append(e);
    return e;
  };
  const timestamp = (value) =>
    value ? new Date(value).getTime() / 1000 : null;
  const local = (value) => {
    if (!value) return "";
    const d = new Date(value * 1000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  };
  const readNotices = adminListReader(
    "notices-load-status",
    "notice-admin-items",
    () => loadAdmin(),
  );
  async function loadAdmin() {
    $("notice-admin-prev").disabled = true;
    $("notice-admin-next").disabled = true;
    const data = await readNotices("/admin/notices?page=" + adminPage);
    if (!data) return;
    const last = Math.max(1, Math.ceil(data.total / 30));
    if (adminPage > last) {
      adminPage = last;
      return loadAdmin();
    }
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
            await loadAdmin();
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
              await loadAdmin();
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
  window.noticeManager = { load: loadAdmin };
})();
