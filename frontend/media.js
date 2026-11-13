"use strict";

(() => {
  const viewer = document.querySelector("#media-viewer");
  const stage = document.querySelector("#media-stage");
  const image = document.querySelector("#media-image");
  const title = document.querySelector("#media-title");
  const dimensions = document.querySelector("#media-dimensions");
  const scale = document.querySelector("#media-scale");
  const status = document.querySelector("#media-status");
  const menu = document.querySelector("#media-menu");
  const menuItems = [...menu.querySelectorAll("button")];
  const controls = [...viewer.querySelectorAll("button")];
  const editorButton = viewer.querySelector('[data-media-action="edit"]');
  let items = new Map();
  let viewing = null;
  let context = null;
  let drag = null;
  let editing = false;

  function resolve(item) {
    return typeof item === "string" ? items.get(item) : item;
  }

  async function getBlob(item) {
    const descriptor = resolve(item);
    if (!descriptor) throw new Error("这张图片已找不到。");
    if (descriptor.render) return descriptor.render();
    const response = await fetch(descriptor.url);
    if (!response.ok) throw new Error("无法读取这张图片，请刷新后再试。");
    const source = await response.blob();
    if (!descriptor.crop) return source;

    const { x, y, width, height, outputWidth, outputHeight } = descriptor.crop;
    const bitmap = await createImageBitmap(source);
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth || Math.round(width);
    canvas.height = outputHeight || Math.round(height);
    try {
      const context2d = canvas.getContext("2d");
      context2d.imageSmoothingQuality = "high";
      context2d.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
    return new Promise((resolveBlob, reject) => canvas.toBlob(blob => {
      if (blob) resolveBlob(blob);
      else reject(new Error("无法生成图片文件。"));
    }, "image/png"));
  }

  function basename(descriptor, blob) {
    if (descriptor.filename) return descriptor.filename;
    const ext = { "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[blob.type] || "png";
    const name = (descriptor.name || "图片").replace(/[\\/:*?"<>|]/g, "_");
    const extension = ext === "jpg" ? "jpe?g" : ext;
    return new RegExp(`\\.${extension}$`, "i").test(name) ? name : `${name}.${ext}`;
  }

  async function download(item) {
    const descriptor = resolve(item);
    const blob = await (viewing?.descriptor === descriptor ? viewing.blob : getBlob(descriptor));
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = basename(descriptor, blob);
    link.hidden = true;
    (viewer.open ? viewer : document.body).append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("media-error", isError);
  }

  function setReady(ready) {
    for (const button of controls) {
      if (button.dataset.mediaAction !== "close") button.disabled = !ready;
    }
    if (editing) editorButton.disabled = true;
    editorButton.hidden = typeof api.onEdit !== "function" || viewing?.descriptor.file?.mime === "image/svg+xml";
  }

  function layout() {
    if (!viewing?.width) return;
    const { width, height, fit } = viewing;
    const ratio = viewing.zoom || fit;
    const fittedWidth = width * ratio;
    const fittedHeight = height * ratio;
    const maxX = Math.max(0, (fittedWidth - stage.clientWidth) / 2);
    const maxY = Math.max(0, (fittedHeight - stage.clientHeight) / 2);
    viewing.x = Math.max(-maxX, Math.min(maxX, viewing.x));
    viewing.y = Math.max(-maxY, Math.min(maxY, viewing.y));
    image.style.width = `${fittedWidth}px`;
    image.style.height = `${fittedHeight}px`;
    image.style.transform = `translate(calc(-50% + ${viewing.x}px), calc(-50% + ${viewing.y}px))`;
    stage.classList.toggle("is-zoomed", maxX > .5 || maxY > .5);
    scale.value = `${Math.round(ratio * 100)}%`;
  }

  function fit(reset = false) {
    if (!viewing?.width || !viewer.open || !stage.clientWidth || !stage.clientHeight) return;
    viewing.fit = Math.min(stage.clientWidth / viewing.width, stage.clientHeight / viewing.height);
    if (reset || !viewing.zoom) {
      viewing.zoom = 0;
      viewing.x = viewing.y = 0;
    }
    layout();
  }

  function zoom(factor, clientX, clientY) {
    if (!viewing?.width) return;
    const { left, top, width, height } = stage.getBoundingClientRect();
    const before = viewing.zoom || viewing.fit;
    const after = Math.min(Math.max(viewing.fit * .3, before * factor), Math.max(4, viewing.fit * 8));
    const x = (clientX ?? left + width / 2) - left - width / 2;
    const y = (clientY ?? top + height / 2) - top - height / 2;
    viewing.x = x - (x - viewing.x) * after / before;
    viewing.y = y - (y - viewing.y) * after / before;
    viewing.zoom = after;
    layout();
  }

  function resetImage() {
    if (viewing?.url) URL.revokeObjectURL(viewing.url);
    image.hidden = true;
    image.removeAttribute("src");
    stage.classList.remove("is-zoomed", "is-panning");
    drag = null;
  }

  async function open(item, origin = document.activeElement) {
    const descriptor = resolve(item);
    if (!descriptor) return;
    if (viewer.open && viewing?.descriptor === descriptor) return;
    closeMenu();
    resetImage();
    const current = { descriptor, origin: viewing?.origin || origin, zoom: 0, x: 0, y: 0 };
    viewing = current;
    title.textContent = descriptor.name || "查看图片";
    dimensions.textContent = "";
    scale.value = "—";
    setStatus("正在打开图片…");
    setReady(false);
    if (!viewer.open) viewer.showModal();

    try {
      current.blob = getBlob(descriptor);
      const blob = await current.blob;
      if (viewing !== current || !viewer.open) return;
      current.url = URL.createObjectURL(blob);
      image.alt = descriptor.name || "图片预览";
      image.src = current.url;
      await image.decode();
      if (viewing !== current || !viewer.open) return;
      current.width = image.naturalWidth;
      current.height = image.naturalHeight;
      dimensions.textContent = `${current.width.toLocaleString()} × ${current.height.toLocaleString()} px`;
      image.hidden = false;
      setReady(true);
      setStatus("");
      fit(true);
    } catch (error) {
      if (viewing === current && viewer.open) setStatus(error.message || "无法打开这张图片。", true);
    }
  }

  function closeMenu(restore = false) {
    const origin = context?.origin;
    menu.hidden = true;
    context = null;
    if (restore && origin?.isConnected) origin.focus({ preventScroll: true });
  }

  function showMenu(descriptor, origin, x, y) {
    if (!descriptor) return;
    context = { descriptor, origin };
    (viewer.open ? viewer : document.body).append(menu);
    menuItems[0].hidden = viewer.open;
    const vector = descriptor.file?.mime === "image/svg+xml";
    menu.querySelector('[data-media-menu="edit"]').hidden = vector || typeof api.onEdit !== "function";
    menu.querySelector('[data-media-menu="poster"]').hidden = vector || typeof api.onPoster !== "function";
    menu.hidden = false;
    const fallback = origin.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x || fallback.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y || fallback.bottom, innerHeight - menu.offsetHeight - 8))}px`;
    menuItems.find(button => !button.hidden).focus({ preventScroll: true });
  }

  function originFor(element) {
    return element.closest("button,a,[tabindex]") || element;
  }

  async function edit(descriptor) {
    if (!api.onEdit || editing) return;
    const current = viewing;
    editing = true;
    editorButton.disabled = true;
    try {
      const result = await api.onEdit(descriptor);
      if (result !== false && viewer.open && viewing === current) viewer.close();
    } finally {
      editing = false;
      editorButton.disabled = !viewing?.width;
    }
  }

  function report(error) {
    if (viewer.open) {
      setStatus(error.message || "暂时无法完成图片操作。", true);
    } else {
      const toast = document.querySelector("#toast");
      toast.textContent = error.message || "暂时无法完成图片操作。";
      toast.hidden = false;
      setTimeout(() => { toast.hidden = true; }, 3200);
    }
  }

  const api = {
    setItems(map) {
      items = map;
      closeMenu();
    },
    getBlob, download, open, onEdit: null, onPoster: null
  };
  window.workspaceMedia = api;

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const explicit = event.target.closest("[data-open-media]");
    const artwork = event.target.closest("[data-media]");
    if (!explicit && (!artwork || artwork.closest(".photo-canvas.selecting,[data-media-select]"))) return;
    const control = event.target.closest("button,a,input,select,textarea");
    if (!explicit && control && control !== artwork && artwork.contains(control)) return;
    const item = resolve(explicit?.dataset.openMedia ?? artwork.dataset.media);
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    open(item, originFor(explicit || artwork));
  }, true);

  document.addEventListener("contextmenu", event => {
    if (!(event.target instanceof Element)) return;
    const artwork = event.target.closest("[data-media]") ||
      event.target.closest("[data-region-box]")?.closest("#photo-canvas")?.querySelector("[data-media]");
    const descriptor = viewer.open && stage.contains(event.target) ? viewing?.descriptor : resolve(artwork?.dataset.media);
    if (!descriptor) return;
    event.preventDefault();
    showMenu(descriptor, artwork ? originFor(artwork) : editorButton, event.clientX, event.clientY);
  });

  document.addEventListener("pointerdown", event => {
    if (context && !menu.contains(event.target)) closeMenu();
  }, true);
  window.addEventListener("resize", () => closeMenu());

  menu.addEventListener("click", event => {
    const action = event.target.closest("button")?.dataset.mediaMenu;
    if (!action || !context) return;
    const { descriptor, origin } = context;
    closeMenu(action !== "open");
    if (action === "open") open(descriptor, origin);
    if (action === "edit") edit(descriptor).catch(report);
    if (action === "poster" && api.onPoster) {
      const current = viewing;
      api.onPoster(descriptor).then(result => {
        if (result !== false && viewer.open && viewing === current) viewer.close();
      }).catch(report);
    }
    if (action === "download") download(descriptor).catch(report);
  });
  menu.addEventListener("keydown", event => {
    if (event.key === "Tab") {
      closeMenu(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    const options = menuItems.filter(button => !button.hidden);
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      options[(index + direction + options.length) % options.length].focus();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || viewer.open || context || !(event.target instanceof Element)) return;
    const artwork = event.target.closest("[data-media]") || event.target.querySelector("[data-media]");
    if (!artwork) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      showMenu(resolve(artwork.dataset.media), event.target);
    } else if (event.target === artwork && !artwork.matches("button,a") &&
        !artwork.closest(".photo-canvas.selecting,[data-media-select]") &&
        (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open(artwork.dataset.media, artwork);
    }
  });

  viewer.addEventListener("close", () => {
    if (viewer.open) return;
    const origin = viewing?.origin;
    resetImage();
    viewing = null;
    closeMenu();
    if (origin?.isConnected) origin.focus({ preventScroll: true });
  });
  viewer.addEventListener("cancel", event => {
    if (!context) return;
    event.preventDefault();
    closeMenu(true);
  });
  const blankViewerArea = event => {
    if (event.target === viewer || event.target.matches(".media-header, .media-footer")) return true;
    if (event.target !== stage) return false;
    if (!viewing?.width || image.hidden) return true;
    const bounds = image.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  let dismissPointer = null;
  viewer.addEventListener("pointerdown", event => {
    dismissPointer = event.button === 0 && blankViewerArea(event) ? [event.clientX, event.clientY] : null;
  }, true);
  viewer.addEventListener("pointercancel", () => { dismissPointer = null; });
  viewer.addEventListener("click", event => {
    const dismiss = dismissPointer && blankViewerArea(event) &&
      Math.hypot(event.clientX - dismissPointer[0], event.clientY - dismissPointer[1]) < 6;
    dismissPointer = null;
    if (dismiss) return viewer.close();
    const action = event.target.closest("button")?.dataset.mediaAction;
    if (action === "close") viewer.close();
    if (action === "download") download(viewing.descriptor).catch(report);
    if (action === "edit") edit(viewing.descriptor).catch(report);
    if (action === "fit") fit(true);
    if (action === "out") zoom(1 / 1.25);
    if (action === "in") zoom(1.25);
  });
  viewer.addEventListener("keydown", event => {
    if (context || event.ctrlKey || event.metaKey) return;
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(1 / 1.25);
    else if (event.key === "0") fit(true);
    else return;
    event.preventDefault();
  });
  stage.addEventListener("wheel", event => {
    if (!viewing?.width || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    zoom(Math.exp(-Math.max(-90, Math.min(90, delta)) / 340), event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || blankViewerArea(event) || !stage.classList.contains("is-zoomed")) return;
    stage.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, startX: event.clientX - viewing.x, startY: event.clientY - viewing.y };
    stage.classList.add("is-panning");
  });
  stage.addEventListener("pointermove", event => {
    if (drag?.id !== event.pointerId) return;
    viewing.x = event.clientX - drag.startX;
    viewing.y = event.clientY - drag.startY;
    layout();
  });
  stage.addEventListener("lostpointercapture", event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    stage.classList.remove("is-panning");
  });
  new ResizeObserver(() => fit()).observe(stage);
})();
