"use strict";

(() => {
  const maxClips = 16;
  const mimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const reorderType = "application/x-fengsha-animation-clip";
  const ratios = {auto: "跟随首项素材", "1:1": "1:1 方形", "16:9": "16:9 横屏", "9:16": "9:16 竖屏"};
  let draft;

  function getDraft() {
    if (draft?.owner !== identity) {
      if (draft) clearResult(draft);
      draft = {owner: identity, clips: [], ratio: "auto", loop: true, error: ""};
    }
    return draft;
  }

  function clearResult(current) {
    current.request?.abort();
    current.request = null;
    current.started = null;
    if (current.url) URL.revokeObjectURL(current.url);
    current.url = "";
    current.blob = null;
    current.saved = false;
    current.error = "";
  }

  function update() {
    if (ui.route === "image") render();
  }

  function listAssets() {
    return ui.files.filter(file => mimeTypes.includes(file.mime));
  }

  function assetOptions(assets) {
    return '<option value="">从素材库选择</option>' + assets.map(file =>
      `<option value="${esc(file.id)}">${esc(file.name)}</option>`).join("");
  }

  function refreshAssets(root) {
    const panel = root.querySelector("[data-animation-composer]");
    if (!panel) return;
    const current = getDraft();
    const assets = listAssets();
    const picker = panel.querySelector("[data-animation-source]");
    const selected = picker.value;
    picker.innerHTML = assetOptions(assets);
    picker.value = assets.some(file => file.id === selected) ? selected : "";
    picker.disabled = !assets.length || current.clips.length >= maxClips;
    panel.querySelector('[data-animation-action="add"]').disabled = picker.disabled || !picker.value;
  }

  function addAsset(id) {
    const file = listAssets().find(item => item.id === id);
    if (file) addClips(getDraft(), [uploadDescriptor(file)]);
  }

  function clipRow(clip, index, size) {
    const name = esc(clip.file.name);
    const isGif = clip.file.mime === "image/gif";
    return `<li class="animation-clip" data-animation-clip="${index}">
      <span class="animation-grip" draggable="true" title="拖动排序">⠿</span>
      <img src="${esc(clip.file.url)}" alt="" loading="lazy" draggable="false">
      <div class="animation-clip-info"><strong title="${name}">${name}</strong>
        ${isGif ? '<span class="meta">保留原帧时长</span>' :
    `<label class="animation-duration"><span>静图停留</span><input class="input" aria-label="${name} 停留秒数" data-animation-duration="${index}" type="number" min="0.1" max="10" step="0.1" value="${clip.durationMs / 1000}"><span>秒</span></label>`}
      </div>
      <div class="animation-clip-actions">
        <button class="btn btn-ghost" type="button" data-animation-action="up" aria-label="前移 ${name}" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn-ghost" type="button" data-animation-action="down" aria-label="后移 ${name}" ${index === size - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn-ghost" type="button" data-animation-action="remove" aria-label="移除 ${name}">×</button>
      </div>
    </li>`;
  }

  function view() {
    const current = getDraft();
    const assets = listAssets();
    const ready = current.clips.length >= 2;
    const full = current.clips.length >= maxClips;
    return `<section class="card animation-composer" data-animation-composer aria-labelledby="animation-heading">
      <header class="animation-header"><h2 id="animation-heading">拼接动图</h2><p class="meta">按顺序播放图片和已有动图，拼接免费。</p></header>
      <div class="animation-layout">
        <div class="animation-timeline">
          <div class="animation-add">
            <select class="input" aria-label="从素材库选择图片" data-animation-source ${assets.length && !full ? "" : "disabled"}>
              ${assetOptions(assets)}
            </select>
            <button class="btn btn-secondary" type="button" data-animation-action="add" disabled>添加</button>
            <button class="btn btn-secondary" type="button" data-animation-action="upload" ${full || current.uploading ? "disabled" : ""}>${current.uploading ? "上传中…" : "上传图片"}</button>
            <input type="file" data-animation-upload hidden multiple accept=".png,.jpg,.jpeg,.webp,.gif">
          </div>
          ${current.clips.length ? `<ol class="animation-clips">${current.clips.map((clip, index) => clipRow(clip, index, current.clips.length)).join("")}</ol>` :
    '<p class="animation-drop-hint">拖入素材，或从上方添加。至少需要 2 项。</p>'}
          <div class="animation-options">
            <label class="field">画面比例<select class="input" data-animation-ratio>
              ${Object.entries(ratios).map(([value, label]) => `<option value="${value}" ${current.ratio === value ? "selected" : ""}>${label}</option>`).join("")}
            </select></label>
            <label class="animation-loop"><input type="checkbox" data-animation-loop ${current.loop ? "checked" : ""}> 循环播放</label>
          </div>
          <p class="meta animation-fit-note">画面完整保留，空余区域填充深色。</p>
        </div>
        <div class="animation-output">
          <div class="animation-preview" aria-live="polite">
            ${current.url ? `<img src="${esc(current.url)}" alt="拼接动图预览">` :
    `<p class="meta">${current.request ? activeJobProgress("正在拼接", current.started) : "生成后在此预览"}</p>`}
          </div>
          <p class="animation-error" role="alert" ${current.error ? "" : "hidden"}>${esc(current.error)}</p>
          <div class="row animation-export">
            <button class="btn btn-primary" type="button" data-animation-action="preview" ${ready && !current.request && !current.uploading ? "" : "disabled"}>${current.request ? "正在拼接…" : "生成预览"}</button>
            <button class="btn btn-secondary" type="button" data-animation-action="download" ${current.url ? "" : "disabled"}>下载 GIF</button>
            ${current.url ? `<button class="btn btn-ghost" type="button" data-animation-action="save" ${current.saved || current.saving ? "disabled" : ""}>${current.saved ? "已保存" : current.saving ? "保存中…" : "保存到素材库"}</button>` : ""}
          </div>
        </div>
      </div>
    </section>`;
  }

  function addClips(current, files) {
    const room = maxClips - current.clips.length;
    if (!room) return notify(`最多可添加 ${maxClips} 项素材。`);
    const usable = files.filter(file => file && mimeTypes.includes(file.mime));
    if (!usable.length) return;
    clearResult(current);
    current.clips.push(...usable.slice(0, room).map(file => ({file, durationMs: 1000})));
    if (usable.length > room) notify(`最多可添加 ${maxClips} 项素材。`);
    update();
  }

  async function addUploads(current, files) {
    if (!files.length || current.uploading || !requireAccount()) return;
    const room = maxClips - current.clips.length;
    if (!room) return notify(`最多可添加 ${maxClips} 项素材。`);
    const added = [];
    const errors = [];
    current.uploading = true;
    update();
    try {
      for (const file of files) {
        if (added.length >= room || current !== getDraft()) break;
        try {
          const item = await storeFile(normalizeFile(file, "animation"), current.owner);
          if (item) added.push(item);
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (current !== getDraft()) return;
      if (added.length) addClips(current, added);
      if (errors.length) notify(errors[0]);
      else if (files.length > room) notify(`已添加可放入的素材，最多 ${maxClips} 项。`);
    } finally {
      current.uploading = false;
      if (current === getDraft()) update();
    }
  }

  function moveClip(current, from, to, focusAction = "") {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || !current.clips[from] || !current.clips[to]) return;
    clearResult(current);
    const [clip] = current.clips.splice(from, 1);
    current.clips.splice(to, 0, clip);
    update();
    if (focusAction) {
      document.querySelector(`[data-animation-clip="${to}"] [data-animation-action="${focusAction}"]:not(:disabled)`)?.focus();
    }
  }

  async function preview(current) {
    if (current.request || current.clips.length < 2 || !requireAccount()) return;
    clearResult(current);
    const request = new AbortController();
    current.request = request;
    current.started = Math.floor(Date.now() / 1000);
    update();
    try {
      const response = await fetch("/api/animations/compose", {method: "POST", signal: request.signal,
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({ratio: current.ratio, loop: current.loop,
          clips: current.clips.map(({file, durationMs}) => ({assetId: file.id, durationMs}))})});
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "无法拼接这些素材，请重试。");
      }
      const blob = await response.blob();
      if (blob.type !== "image/gif" || !blob.size) throw new Error("没有收到可预览的 GIF 文件。");
      if (current !== getDraft() || current.request !== request) return;
      current.blob = blob;
      current.url = URL.createObjectURL(blob);
    } catch (error) {
      if (error.name !== "AbortError" && current.request === request) current.error = error.message;
    } finally {
      if (current.request === request) {
        current.request = null;
        current.started = null;
        if (current === getDraft()) update();
      }
    }
  }

  async function saveResult(current) {
    if (!current.blob || current.saving || current.saved || !requireAccount()) return;
    const blob = current.blob;
    current.saving = true;
    update();
    try {
      const item = await storeFile(new File([blob], "拼接动图.gif", {type: "image/gif"}), current.owner);
      if (item && current === getDraft() && current.blob === blob) {
        current.saved = true;
        notify("动图已保存到素材库。");
      }
    } catch (error) {
      if (current === getDraft() && current.blob === blob) current.error = error.message;
    } finally {
      current.saving = false;
      if (current === getDraft()) update();
    }
  }

  function bind(root) {
    const panel = root.querySelector("[data-animation-composer]");
    if (!panel) return;
    const current = getDraft();
    const picker = panel.querySelector("[data-animation-source]");
    const upload = panel.querySelector("[data-animation-upload]");
    panel.addEventListener("click", event => {
      const button = event.target.closest("[data-animation-action]");
      if (!button) return;
      const index = Number(button.closest("[data-animation-clip]")?.dataset.animationClip);
      const action = button.dataset.animationAction;
      if (action === "add") addAsset(picker.value);
      if (action === "upload" && requireAccount()) upload.click();
      if (action === "preview") void preview(current);
      if (action === "save") void saveResult(current);
      if (action === "download" && current.url) {
        const link = document.createElement("a");
        link.href = current.url;
        link.download = "拼接动图.gif";
        link.click();
      }
      if (action === "up") moveClip(current, index, index - 1, action);
      if (action === "down") moveClip(current, index, index + 1, action);
      if (action === "remove" && current.clips[index]) {
        clearResult(current);
        current.clips.splice(index, 1);
        update();
      }
    });
    panel.addEventListener("input", event => {
      const field = event.target;
      const clip = current.clips[Number(field.dataset.animationDuration)];
      if (!clip) return;
      const seconds = field.valueAsNumber;
      clip.durationMs = Number.isFinite(seconds) ? Math.min(10_000, Math.max(100, Math.round(seconds * 1000))) : 1000;
      clearResult(current);
      const message = document.createElement("p");
      message.className = "meta";
      message.textContent = "生成后在此预览";
      panel.querySelector(".animation-preview").replaceChildren(message);
      panel.querySelector('[data-animation-action="download"]').disabled = true;
      panel.querySelector('[data-animation-action="save"]')?.remove();
      panel.querySelector(".animation-error").hidden = true;
      const previewButton = panel.querySelector('[data-animation-action="preview"]');
      previewButton.disabled = current.clips.length < 2 || current.uploading;
      previewButton.textContent = "生成预览";
    });
    panel.addEventListener("change", event => {
      const field = event.target;
      if (field === picker) {
        panel.querySelector('[data-animation-action="add"]').disabled = !picker.value;
        return;
      }
      if (field === upload) {
        void addUploads(current, Array.from(upload.files));
        return;
      }
      const clip = current.clips[Number(field.dataset.animationDuration)];
      if (clip) {
        field.value = clip.durationMs / 1000;
        return;
      }
      else if (field.matches("[data-animation-loop]")) current.loop = field.checked;
      else if (field.matches("[data-animation-ratio]")) current.ratio = field.value;
      else return;
      clearResult(current);
      update();
    });
    panel.addEventListener("dragstart", event => {
      const grip = event.target.closest(".animation-grip");
      if (!grip) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(reorderType, grip.closest("[data-animation-clip]").dataset.animationClip);
    });
    panel.addEventListener("dragover", event => {
      const types = event.dataTransfer.types;
      const reorder = types.includes(reorderType);
      const target = event.target.closest("[data-animation-clip]");
      if (reorder && !target) return;
      if (!reorder && !types.includes("Files") && !types.includes(studioAssetDragType)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = reorder ? "move" : "copy";
      panel.querySelector(".animation-drop-row")?.classList.remove("animation-drop-row");
      if (reorder) target.classList.add("animation-drop-row");
      else panel.classList.add("animation-receiving");
    });
    const resetDrag = () => {
      panel.classList.remove("animation-receiving");
      panel.querySelector(".animation-drop-row")?.classList.remove("animation-drop-row");
    };
    panel.addEventListener("dragend", resetDrag);
    panel.addEventListener("dragleave", event => {
      if (!panel.contains(event.relatedTarget)) resetDrag();
    });
    panel.addEventListener("drop", event => {
      event.preventDefault();
      resetDrag();
      const source = event.dataTransfer.getData(reorderType);
      const target = event.target.closest("[data-animation-clip]")?.dataset.animationClip;
      if (source !== "" && target !== undefined) return moveClip(current, Number(source), Number(target));
      const assetId = event.dataTransfer.getData(studioAssetDragType);
      if (assetId) return addAsset(assetId);
      void addUploads(current, Array.from(event.dataTransfer.files));
    });
  }

  window.AnimationComposer = {render: view, bind, refreshAssets, addAsset};
})();
