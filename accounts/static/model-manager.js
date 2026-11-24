"use strict";
(() => {
  const list = $("model-list");
  const read = adminListReader("model-load-status", "model-list", () => load());
  const labels = { asr: "语音识别", tts: "语音合成" };
  function capability(model) {
    return model.endpoints.includes("/v1/embeddings")
      ? "文本嵌入"
      : (labels[model.service] ?? "对话");
  }

  async function load() {
    const result = await read("/admin/models");
    if (!result) return;
    list.replaceChildren();
    for (const model of result.models) {
      const enabled = model.enabled;
      const switchButton = action(enabled ? "停用" : "开启", async () => {
        switchButton.disabled = true;
        const next = !model.enabled;
        try {
          const updated = await api("/admin/models", "PATCH", {
            id: model.id,
            enabled: next,
          });
          model.enabled = updated.enabled;
          status.textContent = model.enabled
            ? model.cloud_paused
              ? "全站云模型已暂停"
              : "已开放"
            : "已关闭";
          status.classList.toggle("status-ok", model.enabled);
          status.classList.toggle("status-disabled", !model.enabled);
          switchButton.textContent = model.enabled ? "停用" : "开启";
          switchButton.setAttribute(
            "aria-label",
            switchButton.textContent + " " + model.name,
          );
          panelStatus(
            "model-write-status",
            model.name + (model.enabled ? " 已开放" : " 已停用"),
          );
        } catch (error) {
          panelStatus("model-write-status", error.message, () => load());
        } finally {
          switchButton.disabled = false;
        }
      });
      switchButton.setAttribute(
        "aria-label",
        switchButton.textContent + " " + model.name,
      );
      row(
        "model-list",
        [
          model.name,
          model.id,
          capability(model),
          model.provider === "local" ? "自建" : "OpenAI",
          "",
        ],
        [switchButton],
      );
      const cells = list.lastElementChild.cells;
      const status = document.createElement("span");
      status.className =
        "status-badge " + (enabled ? "status-ok" : "status-disabled");
      status.textContent = enabled
        ? model.cloud_paused
          ? "全站云模型已暂停"
          : "已开放"
        : "已关闭";
      cells[4].append(status);
    }
  }

  $("refresh-models").addEventListener("click", run(load));
  window.modelManager = { load };
})();
