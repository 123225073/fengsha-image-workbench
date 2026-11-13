(() => {
  const maxRegions = 12;
  const minSize = 3;
  const handles = ["nw", "ne", "sw", "se"];
  const defaultPlacement = { x: 10, y: 10, w: 80, h: 80 };
  let activeId = "";
  let positioning = false;
  let uploadRegionId = "";
  let draft = null;
  let owner = null;
  const undo = [];

  function clamp(value, min = 0, max = 100) {
    return Math.min(max, Math.max(min, value));
  }

  function geometry(value) {
    if (!value || !["x", "y", "w", "h"].every(key => Number.isFinite(value[key]))) return null;
    const x = clamp(value.x, 0, 100 - minSize);
    const y = clamp(value.y, 0, 100 - minSize);
    return { x, y, w: clamp(value.w, minSize, 100 - x), h: clamp(value.h, minSize, 100 - y) };
  }

  function syncOwner() {
    if (owner === state.image) return;
    owner = state.image;
    activeId = "";
    positioning = false;
    uploadRegionId = "";
    draft = null;
    undo.length = 0;
  }

  function regions() {
    syncOwner();
    const image = state.image;
    const items = Array.isArray(image.regions) ? image.regions : image.selection ? [{ ...image.selection, id: "legacy" }] : [];
    return items.slice(0, maxRegions).flatMap((item, index) => {
      const box = geometry(item);
      if (!box) return [];
      const id = typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ? item.id : "region-" + index;
      return [{
        id, ...box,
        name: typeof item.name === "string" ? item.name.slice(0, 28) : "",
        note: typeof item.note === "string" ? item.note.slice(0, 600) : "",
        referenceId: typeof item.referenceId === "string" ? item.referenceId : "",
        placement: geometry(item.placement) || { ...defaultPlacement }
      }];
    });
  }

  function selected(items = regions()) {
    return items.find(item => item.id === activeId) || items.at(-1);
  }

  function referenceKey(file) {
    return file.id || file.url;
  }

  function references() {
    return referenceSlots.flatMap(slot => {
      const file = ui.file[slot];
      return file?.url && (!file.id || file.id !== ui.file.image?.id) ? [{ ...file, key: referenceKey(file) }] : [];
    });
  }

  function payload() {
    const refs = references();
    return regions().map(({ x, y, w, h, note, referenceId, placement }) => {
      const file = refs.find(reference => reference.key === referenceId);
      const region = { x, y, w, h, note: note.trim() };
      if (!file?.id) return region;
      return {
        ...region, referenceId: file.id,
        referencePlacement: {
          x: x + w * placement.x / 100,
          y: y + h * placement.y / 100,
          w: w * placement.w / 100,
          h: h * placement.h / 100
        }
      };
    });
  }

  function readyCount() {
    return payload().filter(region => region.note || region.referenceId).length;
  }

  function displayName(item, index) {
    return item.name?.trim() || `区域 ${index + 1}`;
  }

  function setRegions(items, remember = true, redraw = true) {
    if (remember) {
      undo.push({ items: regions(), activeId, positioning });
      if (undo.length > 30) undo.shift();
    }
    state.image.regions = items;
    state.image.selection = null;
    save();
    if (redraw) render();
  }

  function reset() {
    syncOwner();
    state.image.regions = [];
    state.image.selection = null;
    activeId = "";
    positioning = false;
    uploadRegionId = "";
    draft = null;
    undo.length = 0;
  }

  function boxStyle(box) {
    return `left:${box.x}%;top:${box.y}%;width:${box.w}%;height:${box.h}%`;
  }

  function corners(attribute) {
    return handles.map(handle => `<span class="region-handle region-handle-${handle}" ${attribute}="${handle}" aria-hidden="true"></span>`).join("");
  }

  function overlay() {
    const items = regions();
    const focused = selected(items)?.id;
    const refs = references();
    const content = items.map((item, index) => {
      const current = item.id === focused;
      const file = refs.find(reference => reference.key === item.referenceId);
      const workingOnPlacement = current && positioning && file;
      return `<div class="workspace-region${current ? " is-active" : ""}${workingOnPlacement ? " is-positioning" : ""}"
        data-region-box="${esc(item.id)}" data-drop-target="reference" tabindex="0" role="button" aria-label="选区 ${index + 1}" aria-pressed="${current}" aria-keyshortcuts="Delete" style="${boxStyle(item)}">
        <span class="region-number">${index + 1}</span>
        <span class="region-caption" data-region-caption>${esc(displayName(item, index))} · ${item.note.trim() || file ? "已填写" : "待填写"}</span>
        ${file ? `<span class="region-placement" data-region-placement style="${boxStyle(item.placement)}"><img src="${esc(file.url)}" alt="" draggable="false">${workingOnPlacement ? corners("data-placement-handle") : ""}</span>` : ""}
        ${current && !workingOnPlacement ? corners("data-region-handle") : ""}
      </div>`;
    }).join("");
    return `<div class="workspace-region-layer" data-region-layer>${content}</div>`;
  }

  function panel() {
    const items = regions();
    const item = selected(items);
    const refs = references();
    const linked = refs.find(file => file.key === item?.referenceId);
    const prepared = new Set(items.filter(region => region.note.trim() || refs.some(ref => ref.key === region.referenceId)).map(region => region.id));
    const choices = items.map((region, index) => `<button type="button" class="edit-queue-item" data-action="region-activate" data-value="${esc(region.id)}"
      aria-label="选区 ${index + 1}" aria-pressed="${item?.id === region.id}">
      <span class="edit-queue-number">${index + 1}</span><span><strong data-queue-name>${esc(displayName(region, index))}</strong>
      <small data-queue-note>${esc(region.note.trim() || (prepared.has(region.id) ? "已添加参考图" : "未填写修改要求"))}</small></span>
      <small data-queue-status>${prepared.has(region.id) ? "待生成" : "待填写"}</small></button>`).join("");
    const options = refs.map(file => `<option value="${esc(file.key)}"${linked?.key === file.key ? " selected" : ""}>${esc(file.name)}</option>`).join("");
    return `<section class="region-panel" aria-label="多选区编辑">
      ${item ? `<div class="region-inspector" data-region-inspector="${esc(item.id)}" data-drop-target="reference">
        <div class="row-between"><strong>当前标注</strong>${button("删除本区", "region-delete", item.id, "ghost", 'title="Delete"')}</div>
        <label class="field">区域名称<input class="input" data-region-name maxlength="28" value="${esc(item.name)}" placeholder="${esc(displayName(item, items.indexOf(item)))}"></label>
        <label class="field">修改要求<textarea class="textarea" data-region-note maxlength="600" rows="4" placeholder="例如：把瓶盖换成哑光黑，保留瓶身和光线">${esc(item.note)}</textarea></label>
        <dl class="region-coordinates">${[["X",item.x],["Y",item.y],["宽",item.w],["高",item.h]].map(([label,value]) =>
          `<div><dt>${label}</dt><dd>${Math.round(value)}%</dd></div>`).join("")}</dl>
        <details${linked || positioning ? " open" : ""}><summary>本区参考图${linked ? " · 已添加" : ""}</summary>
          <label class="field">选用参考图<select class="input" data-region-reference><option value="">无</option>${options}</select></label>
          <div class="row region-actions">${button("上传并融入", "region-upload", item.id, "secondary")}
          ${linked ? button(positioning ? "完成定位" : "调整素材位置", "region-position", item.id, "ghost", `aria-pressed="${positioning}"`) : ""}</div>
          <p class="meta">${positioning ? "拖动参考图，或拉四角缩放。" : "可从左侧把素材拖进标注框。"}</p>
        </details>
      </div>` : `<p class="meta">${ui.file.image ? "在底图上拖出一个区域，然后填写修改要求。" : "先从左侧选择一张图片。"}</p>`}
      <div class="row-between"><strong>标注队列</strong><span class="meta">${items.length}/${maxRegions}</span></div>
      ${items.length ? `<div class="edit-queue">${choices}</div><div class="row region-actions">
        ${button("撤销", "region-undo", "", "ghost", undo.length ? "" : "disabled")}
        ${button("清空标注", "region-clear", "", "ghost")}</div>` : ""}
    </section>`;
  }

  function updateRegion(id, patch, options = {}) {
    const items = regions();
    if (!items.some(item => item.id === id)) return false;
    setRegions(items.map(item => item.id === id ? { ...item, ...patch } : item), options.remember !== false, options.redraw !== false);
    return true;
  }

  function activate(id) {
    const item = regions().find(region => region.id === id);
    if (!item) return false;
    activeId = item.id;
    ui.imageView = "原图";
    ui.editTab = "annotations";
    return true;
  }

  function attach(slot, regionId = uploadRegionId) {
    if (!regionId || !ui.file[slot]?.url) return false;
    uploadRegionId = "";
    if (!activate(regionId)) return false;
    const ok = updateRegion(regionId, { referenceId: referenceKey(ui.file[slot]), placement: { ...defaultPlacement } }, { redraw: false });
    if (ok) positioning = true;
    return ok;
  }

  function handle(action, value) {
    const items = regions();
    if (action === "region-draw") {
      ui.selecting = !ui.selecting;
      ui.imageView = "原图";
      positioning = false;
    } else if (action === "region-activate") {
      activate(value);
      positioning = false;
    } else if (action === "region-position") {
      if (activate(value)) positioning = !positioning;
    } else if (action === "region-upload") {
      if (!activate(value) || ui.uploading) return true;
      uploadRegionId = value;
      actions.file("reference", true);
      return true;
    } else if (action === "region-delete" || action === "region-clear") {
      const remaining = action === "region-clear" ? [] : items.filter(item => item.id !== value);
      setRegions(remaining, true, false);
      if (!remaining.some(item => item.id === activeId)) activeId = remaining.at(-1)?.id || "";
      positioning = false;
    } else if (action === "region-undo") {
      const previous = undo.pop();
      if (previous) {
        activeId = previous.activeId;
        positioning = previous.positioning;
        setRegions(previous.items, false, false);
      }
    } else {
      return false;
    }
    render();
    if (action === "region-activate" || action === "region-delete") focusRegion();
    return true;
  }

  function focusRegion() {
    const box = document.querySelector(`[data-region-box="${CSS.escape(activeId)}"]`);
    const fallback = document.querySelector('[data-action="region-draw"]');
    (box || fallback)?.focus({preventScroll: true});
  }

  function point(event, rect) {
    return {
      x: clamp((event.clientX - rect.left) / rect.width * 100),
      y: clamp((event.clientY - rect.top) / rect.height * 100)
    };
  }

  function draggedBox(start, end) {
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
  }

  function transformedBox(box, dx, dy, handle) {
    if (!handle) return { ...box, x: clamp(box.x + dx, 0, 100 - box.w), y: clamp(box.y + dy, 0, 100 - box.h) };
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    const x = handle.includes("w") ? clamp(box.x + dx, 0, right - minSize) : box.x;
    const y = handle.includes("n") ? clamp(box.y + dy, 0, bottom - minSize) : box.y;
    const endX = handle.includes("e") ? clamp(right + dx, x + minSize, 100) : right;
    const endY = handle.includes("s") ? clamp(bottom + dy, y + minSize, 100) : bottom;
    return { x, y, w: endX - x, h: endY - y };
  }

  function pointerDown(event) {
    if (event.button !== 0 || draft || !(event.target instanceof Element)) return;
    const canvas = event.target.closest("#photo-canvas");
    const layer = canvas?.querySelector("[data-region-layer]");
    if (!layer) return;
    const target = event.target.closest("[data-region-box]");
    const items = regions();
    if (!target && !ui.selecting) return;
    if (!target && items.length >= maxRegions) {
      notify(`最多可以添加 ${maxRegions} 个选区。`);
      return;
    }
    const rect = layer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const item = items.find(region => region.id === target?.dataset.regionBox);
    const movingPlacement = Boolean(item && target.classList.contains("is-positioning") && event.target.closest("[data-region-placement]"));
    const placementHandle = event.target.closest("[data-placement-handle]");
    const regionHandle = event.target.closest("[data-region-handle]");
    const preview = item ? movingPlacement ? target.querySelector("[data-region-placement]") : target : document.createElement("div");
    const handle = movingPlacement ? placementHandle?.dataset.placementHandle : regionHandle?.dataset.regionHandle;
    if (!item) {
      preview.className = "workspace-region is-drawing";
      layer.append(preview);
    }
    const start = point(event, rect);
    draft = { pointerId: event.pointerId, canvas, rect, start, items, item, movingPlacement, handle, preview };
    if (item) {
      const previous = layer.querySelector(".workspace-region.is-active");
      previous?.classList.remove("is-active");
      target.classList.add("is-active");
    } else preview.style.cssText = boxStyle({ x: start.x, y: start.y, w: 0, h: 0 });
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
  }

  function currentBox(event, interaction) {
    const { rect, start, item, movingPlacement, handle } = interaction;
    const end = point(event, rect);
    if (!item) return draggedBox(start, end);
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if (movingPlacement) {
      dx *= 100 / item.w;
      dy *= 100 / item.h;
    }
    return transformedBox(movingPlacement ? item.placement : item, dx, dy, handle);
  }

  function pointerMove(event) {
    if (draft?.pointerId !== event.pointerId) return;
    draft.preview.style.cssText = boxStyle(currentBox(event, draft));
  }

  function release(interaction) {
    draft = null;
    if (interaction.canvas.hasPointerCapture(interaction.pointerId)) interaction.canvas.releasePointerCapture(interaction.pointerId);
  }

  function pointerEnd(event) {
    if (draft?.pointerId !== event.pointerId) return;
    const interaction = draft;
    release(interaction);
    if (event.type !== "pointerup") {
      render();
      return;
    }
    const box = currentBox(event, interaction);
    if (interaction.item) {
      const { item, movingPlacement } = interaction;
      const previous = movingPlacement ? item.placement : item;
      const moved = ["x", "y", "w", "h"].some(key => Math.abs(box[key] - previous[key]) > .001);
      if (moved) updateRegion(item.id, movingPlacement ? { placement: box } : box, { redraw: false });
      activeId = item.id;
      positioning = movingPlacement;
    } else if (box.w >= minSize && box.h >= minSize) {
      const id = crypto.randomUUID();
      setRegions([...interaction.items, { id, ...box }], true, false);
      activeId = id;
      positioning = false;
    } else {
      notify("拖出一个稍大的区域。");
    }
    ui.editTab = "annotations";
    render();
    if (interaction.item || (box.w >= minSize && box.h >= minSize)) focusRegion();
  }

  function keyboard(event) {
    if (ui.route !== "image-edit" || event.defaultPrevented || event.isComposing || document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && (draft || ui.selecting || positioning)) {
      if (draft) release(draft);
      ui.selecting = false;
      positioning = false;
      render();
      return;
    }
    if (!(event.target instanceof Element) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest("input, textarea, select, [role=textbox]") || event.target.isContentEditable) return;
    const target = event.target.closest("[data-region-box]");
    if ((event.key === "Delete" || (target && event.key === "Backspace")) &&
        !draft && document.querySelector("[data-region-layer]") &&
        (event.target.closest(".edit-workspace") || event.target === document.body)) {
      const id = target?.dataset.regionBox || selected()?.id;
      if (!id) return;
      event.preventDefault();
      if (!event.repeat) handle("region-delete", id);
      return;
    }
    if (!target) return;
    const id = target.dataset.regionBox;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      handle("region-activate", id);
      return;
    }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    const item = regions().find(region => region.id === id);
    if (!direction || !item) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    const move = transformedBox(item, direction[0] * step, direction[1] * step);
    updateRegion(id, move, { redraw: false });
    activeId = id;
    render();
    focusRegion();
  }

  document.addEventListener("pointerdown", pointerDown);
  document.addEventListener("pointermove", pointerMove);
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) document.addEventListener(event, pointerEnd);
  document.addEventListener("keydown", keyboard);
  document.addEventListener("input", event => {
    if (!(event.target instanceof Element) || !event.target.matches("[data-region-note], [data-region-name]")) return;
    const id = event.target.closest("[data-region-inspector]")?.dataset.regionInspector;
    const key = event.target.hasAttribute("data-region-name") ? "name" : "note";
    if (!updateRegion(id, {[key]: event.target.value}, {remember: false, redraw: false})) return;
    const items = regions();
    const index = items.findIndex(item => item.id === id);
    const item = items[index];
    const linked = references().some(ref => ref.key === item.referenceId);
    const ready = Boolean(item.note.trim() || linked);
    const queue = document.querySelector(`[data-action="region-activate"][data-value="${CSS.escape(id)}"]`);
    queue.querySelector("[data-queue-name]").textContent = displayName(item, index);
    queue.querySelector("[data-queue-note]").textContent = item.note.trim() || (linked ? "已添加参考图" : "未填写修改要求");
    queue.querySelector("[data-queue-status]").textContent = ready ? "待生成" : "待填写";
    document.querySelector(`[data-region-box="${CSS.escape(id)}"] [data-region-caption]`).textContent = `${displayName(item,index)} · ${ready ? "已填写" : "待填写"}`;
    const submit = document.querySelector("[data-region-submit]");
    const count = readyCount();
    if (submit && !pending.has("image")) {
      submit.disabled = !count;
      submit.textContent = `生成已填写标注（${count}）`;
    }
  });
  document.addEventListener("change", event => {
    if (!(event.target instanceof Element) || !event.target.matches("[data-region-reference]")) return;
    const id = event.target.closest("[data-region-inspector]")?.dataset.regionInspector;
    if (!activate(id)) return;
    const referenceId = event.target.value;
    updateRegion(id, { referenceId, placement: { ...defaultPlacement } }, { redraw: false });
    positioning = Boolean(referenceId);
    render();
  });
  document.addEventListener("click", event => {
    if (!ui.uploading && event.target instanceof Element && event.target.closest('[data-action="file"]')) uploadRegionId = "";
  }, true);
  document.addEventListener("cancel", event => {
    if (event.target?.id === "file-input") uploadRegionId = "";
  }, true);
  document.addEventListener("drop", event => {
    if (!ui.uploading && event.dataTransfer?.files.length) prepareAttachment(event.target);
  }, true);
  document.addEventListener("paste", event => {
    if (!ui.uploading && [...(event.clipboardData?.items || [])].some(item => item.kind === "file")) prepareAttachment(event.target);
  }, true);

  function prepareAttachment(target) {
    if (!(target instanceof Element)) return;
    uploadRegionId = target.closest("[data-region-box]")?.dataset.regionBox
      || target.closest("[data-region-inspector]")?.dataset.regionInspector || "";
  }

  window.workspaceRegions = { regions, payload, readyCount, overlay, panel, handle, reset, attach };
})();
