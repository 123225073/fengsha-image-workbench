"use strict";

const live = {
  models: [], defaults: {}, jobs: [], allJobs: [], hiddenJobs: new Set(), trash: null, operations: null, poll: null,
  jobStream: null, jobWatchRequested: false, jobUpdates: Promise.resolve(), jobVersion: 0, clock: null, pptReply: null,
  catalog: async () => {
    const result = await api("catalog");
    live.models = result.models;
    live.defaults = result.defaults;
  }
};
const jobLabels = {queued: "等待执行", running: "正在生成", succeeded: "已交付", failed: "失败", unknown: "待核对", cancelled: "已取消"};

function modelFor(kind, capability, value) {
  const required = capability ? [capability].flat() : [];
  const options = live.models.filter(model => model.kind === kind && required.every(item => model.capabilities.includes(item)));
  const selected = options.find(model => model.id === value) || options.find(model => model.id === live.defaults[kind]) || options[0];
  return {options, selected};
}

function tokenRateText(model) {
  const rates = model?.tokenRates;
  return rates ? `输入 ${points(rates.input)} / 输出 ${points(rates.output)} 积分每百万 Token` : "待设置 Token 单价";
}

function contextWindowText(model) {
  const size = Number(model?.contextWindowTokens || 65536).toLocaleString();
  return model?.contextWindowSource === "configured" ? `上下文 ${size} Token` : `上下文容量未确认，暂按 ${size} Token 保守估算`;
}

function tokenBillingText(billing) {
  if (billing?.status === "unknown") return "上游用量待核对，预留积分暂未结算。";
  if (billing?.usage) return `输入 ${billing.usage.input} / 输出 ${billing.usage.output} Token · 实扣 ${points(billing.charged)} 积分`;
  return "";
}

function modelSelect(field, kind, capability, value, name = "生成模型") {
  const {options, selected} = modelFor(kind, capability, value);
  return `<label class="field">${name}<select class="input" data-field="${field}" ${options.length ? "" : "disabled"}>
    ${options.map(model => `<option value="${esc(model.id)}" ${selected?.id === model.id ? "selected" : ""}>${esc(model.name)} · ${kind === "image" ? points(model.price) + " 积分/张" : tokenRateText(model)}</option>`).join("") || "<option>暂无支持此操作的已上架模型</option>"}</select>${kind === "chat" && selected ? `<small>${contextWindowText(selected)}。长对话自动整理摘要，摘要用量计入本轮。</small>` : ""}</label>`;
}

function requireAccount(continuation = null) {
  if (account) return true;
  openAuth("login", "", continuation);
  return false;
}

function scopeInProgress(scope) {
  return pending.has(scope) || (["ppt", "poster"].includes(scope) && Boolean(state[scope].documentId) && live.allJobs.some(job => activeJob(job)
    && job.scope === scope && job.context?.documentId === state[scope].documentId
    && (scope !== "ppt" || job.context.generationId === state.ppt.generationId)));
}

function imageCapability(tool, count) {
  if (tool === "mask") return count > 1 ? ["mask", "multiReference"] : "mask";
  if (count > 1) return "multiReference";
  if (count || !["text", "batch"].includes(tool)) return "reference";
  return "generate";
}

function referenceUsesSource(tool) {
  return !isGenerationTool(tool);
}

function imageReferenceLimit(tool = imageDraft().tool) {
  const draft = isGenerationTool(tool) ? imageGeneration() : state.image;
  const gif = isGenerationTool(tool) && ui.route === "image" && studioFormat() === "gif";
  const count = imageInputs(tool).length;
  const capability = gif ? nativeStudioCapability("gif", Math.max(1, count)) : imageCapability(tool, count);
  const {selected} = modelFor("image", capability, gif ? nativeStudioDraft("gif").model : draft.model);
  if (!selected) return 9 - Number(referenceUsesSource(tool));
  if (!selected.capabilities.includes("reference")) return 0;
  const maximum = selected.capabilities.includes("multiReference") ? selected.maxReferences : 1;
  return maximum - Number(referenceUsesSource(tool));
}

function availableReferenceSlots(tool = imageDraft().tool) {
  const slots = isGenerationTool(tool) ? generationReferenceSlots : referenceSlots;
  const free = slots.filter(slot => !ui.file[slot]);
  return free.slice(0, Math.max(0, imageReferenceLimit(tool) - (slots.length - free.length)));
}

function imageInputs(tool = imageDraft().tool) {
  if (tool === "text") return [];
  const source = referenceUsesSource(tool) ? ui.file.image : null;
  const slots = isGenerationTool(tool) ? generationReferenceSlots : referenceSlots;
  const refs = ["expand", "cutout", "upscale"].includes(tool) ? [] : slots.map(key => ui.file[key]).filter(Boolean);
  return [...new Set([source?.id, ...refs.map(item => item.id)].filter(Boolean))];
}

function requestImage() {
  if (ui.uploading) return notify("正在添加素材，请稍等。");
  if (!requireAccount(requestImage)) return;
  const image = imageDraft();
  const generation = isGenerationTool(image.tool);
  if (image.tool === "extract") return readImageText();
  if (image.tool === "upscale") {
    if (!ui.file.image?.id) return notify("请上传原图，或在素材库选用一张原图。");
    return confirmImageTool("upscale_image", {sourceId: ui.file.image.id, method: image.upscaleMethod || "local",
      target: image.upscaleTarget || "2"}, null, {operation: "edit"});
  }
  const size = outputSize(image);
  if (!size) return notify(outputSummary(image));
  if (image.tool === "crop") return cropImage(size);
  const sourceId = generation ? null : ui.file.image?.id;
  if (!generation && !sourceId) return notify("请上传原图，或在素材库选用一张原图。");
  const regions = image.tool === "mask" ? workspaceRegions.payload().filter(region => region.note || region.referenceId) : null;
  if (regions && !regions.length) {
    ui.selecting = true;
    ui.imageView = "原图";
    render();
    return notify("请在原图上圈选，并填写修改要求或添加参考图。");
  }
  const imageIds = imageInputs(image.tool);
  if (image.tool === "image" && !imageIds.length) return notify("请至少添加一张参考图。");
  const prompt = generation ? image.prompt.trim() : editorRequestPrompt(image);
  if (!prompt && (generation || ["edit", "background"].includes(image.tool))) {
    if (!generation && image.tool === "background") return notify("请填写想换上的背景场景。");
    return notify(generation ? "请先填写画面描述。" : "请先填写整图修改要求。");
  }
  const quantity = generation && [1, 2, 3, 4].includes(image.count) ? image.count : 1;
  const capability = imageCapability(image.tool, imageIds.length);
  const model = modelFor("image", capability, image.model).selected;
  if (model && imageIds.length > model.maxReferences) return notify(`当前模型最多接收 ${model.maxReferences} 张图，请减少参考图或切换模型。`);
  const name = generation ? (imageIds.length ? "generate_from_reference" : "generate_image") :
    {edit: "edit_image", mask: "edit_image_regions", background: "replace_background", expand: "extend_image", cutout: "remove_background"}[image.tool];
  const args = {size: `${size.width}x${size.height}`};
  if (prompt) args.prompt = prompt;
  if (generation) args.quantity = quantity;
  if (sourceId) args.sourceId = sourceId;
  if (regions) args.regions = regions;
  if (imageIds.length > Number(Boolean(sourceId))) args.referenceIds = sourceId ? imageIds.slice(1) : imageIds;
  return confirmImageTool(name, args, model, {operation: generation ? "generate" : "edit"});
}

async function readImageText() {
  const asset = ui.file.image;
  if (!asset?.id) return notify("请先上传要识别的图片。");
  const owner = identity;
  const draft = state.image;
  const result = await executeLocalImageTool("extract_image_text", {sourceId: asset.id});
  if (owner !== identity || draft !== state.image || asset.id !== ui.file.image?.id) return;
  draft.text = result.text || "未识别到文字";
  if (ui.route === "image-edit" && draft.tool === "extract") {
    ui.editTab = "annotations";
    ui.imageView = "原图";
  }
  save();
  render();
}

function confirmImages(scope, model, inputs, onSubmitted = null, submitTool = null, details = "", submitNote = "") {
  if (!requireAccount()) return;
  if (!model) return notify("当前操作需要先在后台设置上架适用的图片模型。");
  if (pending.has(scope)) return notify("正在提交上一批，请稍后再试。");
  const amount = inputs.length * model.price;
  if (amount > available()) return notify("积分余额不足。");
  const owner = identity;
  const documentId = state[scope].documentId || (state[scope].documentId = crypto.randomUUID());
  const generationId = scope === "ppt" ? state.ppt.generationId || (state.ppt.generationId = crypto.randomUUID()) : undefined;
  const requests = inputs.map(input => ({...input, context: {...input.context, documentId, generationId},
    scope, modelId: model.id, unitPrice: model.price, requestId: crypto.randomUUID()}));
  openModal("确认提交", [details, model.name, `${inputs.length} 张`, `预计 ${points(amount)} 积分`].filter(Boolean).join(" · "),
    submitNote || "提交后可以在「生成任务」查看进度，已交付的图片会自动保存。", "确认生成", async () => {
      if (identity !== owner || pending.has(scope)) return;
      pending.set(scope, 0);
      let submitted = false;
      try {
        await saveNow();
        if (identity !== owner || state[scope].documentId !== documentId) return;
        submitted = true;
        const result = submitTool ? await submitTool(documentId) : await api("jobs", "POST", {requests});
        if (identity !== owner) return;
        updateWallet(result);
        for (const job of result.jobs) {
          if (!live.jobs.some(item => item.id === job.id)) live.jobs.unshift(job);
          if (!live.allJobs.some(item => item.id === job.id)) live.allJobs.unshift(job);
        }
        if (state[scope].documentId !== documentId || (scope === "ppt" && state.ppt.generationId !== generationId)) return;
        const tracked = new Map((state[scope].tracked || []).map(job => [job.id, job]));
        for (const job of result.jobs) {
          if (!tracked.has(job.id)) tracked.set(job.id, {id: job.id, ...job.context});
        }
        state[scope].tracked = [...tracked.values()];
        if (!state.projects.includes(scope)) state.projects.push(scope);
        onSubmitted?.();
        save();
      } finally {
        if (identity === owner) {
          pending.delete(scope);
          if (submitted) scheduleJobs();
          if (ui.route === scope || (scope === "image" && ui.route === "image-edit")) render();
        }
      }
    });
}

async function saveNow() {
  save();
  await flushSave(true);
}

function stopJobUpdates() {
  clearTimeout(live.poll);
  clearTimeout(live.clock);
  live.clock = null;
  live.jobStream?.abort();
  live.jobStream = null;
  live.jobWatchRequested = false;
  live.jobUpdates = Promise.resolve();
  live.hiddenJobs.clear();
  live.pptReply = null;
}

function scheduleJobs(delay = 0) {
  clearTimeout(live.poll);
  if (!account) return;
  if (live.jobStream) live.jobWatchRequested = true;
  else live.poll = setTimeout(watchJobs, delay);
}

function nextJobWatch() {
  if (live.allJobs.some(activeJob)) scheduleJobs();
  else if (live.allJobs.some(job => job.status === "unknown")) scheduleJobs(10000);
}

async function watchJobs() {
  if (!account || live.jobStream) return;
  const owner = identity;
  const controller = new AbortController();
  live.jobStream = controller;
  let retry = false;
  try {
    const response = await fetch("/api/jobs/events?track=1", {signal: controller.signal, headers: {Accept: "application/x-ndjson"}});
    await workspaceCommercial.readStream(response, async event => {
      if (identity !== owner || event.type !== "jobs") return;
      live.jobVersion++;
      await queueJobUpdate({jobs: event.jobs}, owner);
    });
  } catch (error) {
    if (identity !== owner || error.name === "AbortError") return;
    retry = true;
    // Older local services can still report the final state through the JSON endpoint.
    await refreshJobs().catch(problem => notify(problem.message));
  } finally {
    if (live.jobStream === controller) {
      live.jobStream = null;
      const requested = live.jobWatchRequested;
      live.jobWatchRequested = false;
      if (retry && live.allJobs.some(activeJob)) scheduleJobs(1700);
      else if (requested) scheduleJobs();
      else nextJobWatch();
    }
  }
}

async function refreshJobs() {
  const owner = identity;
  if (!account) return;
  const version = live.jobVersion;
  const result = await api("jobs?track=1");
  if (owner === identity && version === live.jobVersion) await queueJobUpdate(result, owner);
  if (owner === identity && !live.jobStream) nextJobWatch();
}

function queueJobUpdate(result, owner) {
  const queued = live.jobUpdates.then(() => owner === identity && applyJobs(result, owner));
  live.jobUpdates = queued.catch(() => {});
  return queued;
}

async function applyJobs(result, owner) {
  const previousJobs = live.allJobs;
  const previous = JSON.stringify(live.jobs);
  const wasPptBusy = scopeInProgress("ppt");
  const wasPosterActive = [...activePosterFormats()].sort().join(",");
  const loaded = ui.imageRecordsLoaded;
  const jobs = result.jobs.map(job => {
    if (job.hidden) live.hiddenJobs.add(job.id);
    return live.hiddenJobs.has(job.id) && !job.hidden ? {...job, hidden: true} : job;
  });
  const records = new Map(jobs.map(job => [job.id, job]));
  const positions = new Map(jobs.map((job, index) => [job.id, index]));
  const ended = ["succeeded", "failed", "cancelled"];
  for (const scope of ["image", "poster", "ppt"]) {
    const doc = state[scope];
    const visible = jobs.filter(job => job.scope === scope && job.context?.documentId === doc.documentId && doc.documentId
      && (scope !== "ppt" || job.context.generationId === doc.generationId)).reverse();
    const existing = new Map((doc.tracked || []).map(item => [item.id, item]));
    doc.tracked = visible.map(job => existing.get(job.id) || {id: job.id, ...job.context});
  }
  const newlyFinished = ["image", "poster", "ppt"].flatMap(scope => (state[scope].tracked || [])
    .filter(item => !item.handled && ended.includes(records.get(item.id)?.status)).map(item => ({scope, item, job: records.get(item.id)})));
  const previouslyDelivered = new Set(previousJobs.filter(job => job.status === "succeeded").map(job => job.id));
  const newImage = jobs.some(job => job.scope === "image" && job.status === "succeeded" && !previouslyDelivered.has(job.id)
    && !ui.files.some(file => file.id === job.assetId));
  if (newlyFinished.length || newImage) {
    const [files, session] = await Promise.all([api("assets"), api("session")]);
    if (identity !== owner) return;
    ui.files = files.items;
    if (session.user) updateWallet({points: session.user.points, ledger: session.ledger, spent: session.spent});
    for (const {scope, item, job} of newlyFinished) {
      if (job.context?.documentId !== state[scope].documentId || (scope === "ppt" && job.context.generationId !== state.ppt.generationId)) continue;
      item.handled = true;
      const asset = ui.files.find(file => file.id === job.assetId);
      if (!asset) continue;
      if (scope !== "image" && jobs.some(newer => newer.id !== job.id && newer.status === "succeeded" &&
          newer.scope === scope && newer.context?.documentId === job.context.documentId &&
          newer.context?.generationId === job.context.generationId &&
          (scope === "poster" ? newer.context?.formatId === job.context.formatId :
            newer.context?.index === job.context.index && (newer.context?.phase === "board") === (job.context.phase === "board")) &&
          positions.get(newer.id) < positions.get(job.id))) continue;
      if (scope === "image" && !job.context?.outputFormat) {
        const key = "local:" + asset.id;
        assignFile(key, uploadDescriptor(asset));
        if (!state.image.candidates.includes(key)) state.image.candidates.push(key);
        state.image.outputs[key] = {width: job.width, height: job.height};
        if (ui.route === "image-edit" && imageJobOperation(job) === "edit" && asset.parentId === ui.file.image?.id) {
          ui.picked = key;
          ui.imageView = "结果";
          ui.selecting = false;
        }
      } else if (scope === "poster") {
        if (item.formatId) (state.poster.visuals ||= {})[item.formatId] = asset.id;
        else state.poster.visual = asset.id;
      } else if (scope === "ppt") {
        const ppt = state.ppt;
        const final = item.phase !== "board";
        if (ppt.manualJobSkips?.includes(job.id)) {
          const history = final ? ppt.history : ppt.boardHistory;
          history[item.index] = [...new Set([...(history[item.index] || []), asset.id])];
        } else {
          ppt.stage = Math.max(final ? 3 : 2, ppt.stage);
          setPptPageImage(ppt, item.index, final, asset.id);
        }
      }
    }
    if (state.ppt.boards.filter(Boolean).length >= state.ppt.outline.length && state.ppt.outline.length) state.ppt.maxStage = Math.max(state.ppt.maxStage, 2);
    if (state.ppt.pages.filter(Boolean).length >= state.ppt.outline.length && state.ppt.outline.length) state.ppt.maxStage = 3;
    save();
    balance.textContent = points(available());
  }
  live.allJobs = jobs;
  live.jobs = jobs.filter(job => !job.hidden);
  const detail = document.querySelector("#job-detail-dialog");
  if (detail.open && detail.dataset.jobId) {
    const fresh = records.get(detail.dataset.jobId);
    if (fresh && detail.dataset.updated !== `${fresh.status}:${fresh.updated}`) {
      openJobDetail(fresh.id).catch(error => notify(error.message));
    }
  }
  ui.imageRecordsLoaded = true;
  const changed = previous !== JSON.stringify(live.jobs);
  if (ui.route === "image" && (changed || !loaded)) updateGenerationGallery();
  if (changed) {
    for (const summary of content.querySelectorAll("[data-job-summary]")) {
      const markup = scopeStatusMarkup(summary.dataset.jobSummary, summary.dataset.jobOperation);
      const wasOpen = summary.querySelector(".poster-task-history")?.open;
      summary.innerHTML = markup;
      if (wasOpen && summary.firstElementChild?.matches(".poster-task-history")) summary.firstElementChild.open = true;
      summary.hidden = !markup;
    }
    for (const slot of content.querySelectorAll("[data-ppt-job], [data-poster-job]")) {
      const job = slot.hasAttribute("data-ppt-job")
        ? pptSlideJob(Number(slot.dataset.pptJob), slot.dataset.asset)
        : records.get(slot.dataset.jobId) || posterFormatJob(slot.dataset.posterJob, slot.dataset.asset);
      slot.innerHTML = slot.hasAttribute("data-ppt-job") ? pptImageJobStatus(job, slot.dataset.asset) : outputJobStatus(job, slot.dataset.asset);
    }
    for (const slot of content.querySelectorAll("[data-poster-job-error], [data-poster-stage-status]")) {
      if (slot.hasAttribute("data-poster-job-error")) {
        slot.innerHTML = jobErrorLink(records.get(slot.dataset.jobId) || posterFormatJob(slot.dataset.posterJobError, slot.dataset.asset));
      } else {
        const markup = posterStageJobStatus(posterFormatJob(slot.dataset.posterStageStatus, slot.dataset.asset));
        slot.innerHTML = markup;
        slot.hidden = !markup;
      }
    }
    for (const note of content.querySelectorAll("[data-ppt-page-status]")) {
      const markup = pptPageJobMessage(Number(note.dataset.pptPageStatus), note.dataset.asset);
      note.innerHTML = markup;
      note.hidden = !markup;
    }
  }
  if ((changed && ui.route === "jobs") || (ui.route === "ppt" && wasPptBusy !== scopeInProgress("ppt")) ||
      (ui.route === "poster" && (!loaded || wasPosterActive !== [...activePosterFormats()].sort().join(","))) ||
      newlyFinished.some(entry => entry.scope === ui.route && ui.route !== "image") ||
      (ui.route === "image-edit" && (newImage || newlyFinished.some(entry => entry.scope === "image" && imageJobOperation(entry.job) === "edit")))) render();
  await workspaceCommercial.receiveImageJobs(live.allJobs);
}

function activeJob(job) {
  return job.status === "queued" || job.status === "running";
}

function jobSeconds(start, end = Math.floor(Date.now() / 1000)) {
  return Math.max(0, end - start);
}

function tickJobClocks() {
  live.clock = null;
  const clocks = document.querySelectorAll("[data-job-since]");
  for (const clock of clocks) clock.textContent = `已用 ${jobSeconds(Number(clock.dataset.jobSince))} 秒`;
  if (clocks.length) live.clock = setTimeout(tickJobClocks, 1000);
}

function jobElapsed(job) {
  if (!Number.isFinite(job.created)) return "";
  if (activeJob(job)) return runningElapsed(job.created);
  return Number.isFinite(job.updated) ? `<span class="job-elapsed">耗时 ${jobSeconds(job.created, job.updated)} 秒</span>` : "";
}

function runningElapsed(start) {
  if (!live.clock) live.clock = setTimeout(tickJobClocks, 1000);
  return `<span class="job-elapsed" data-job-since="${start}">已用 ${jobSeconds(start)} 秒</span>`;
}

function jobProgress(job) {
  return `<span class="job-progress">${activeJob(job) ? '<span class="job-spinner" aria-hidden="true"></span>' : ""}<strong>${esc(jobLabels[job.status] || job.status)}</strong>${jobElapsed(job)}</span>`;
}

function hasJobError(job) {
  return job?.status === "failed" || job?.status === "unknown";
}

function jobErrorLink(job) {
  return hasJobError(job) ? button("查看错误", "job-detail", job.id, "ghost", 'data-job-error') : "";
}

function assetGenerationJob(id) {
  return id ? live.jobs.find(job => job.assetId === id) : undefined;
}

function pptSlideJob(index, assetId) {
  const ppt = state.ppt;
  const current = ppt.documentId && live.jobs.find(job => job.scope === "ppt" && job.context?.documentId === ppt.documentId &&
    job.context.generationId === ppt.generationId && job.context.index === index &&
    (job.context.phase === "board") === (ppt.stage !== 3));
  return current || assetGenerationJob(assetId);
}

function posterFormatJob(format, assetId) {
  if (assetId) return posterResultJob(assetId);
  const current = state.poster.documentId && live.jobs.find(job => job.scope === "poster" &&
    job.context?.documentId === state.poster.documentId && (job.context?.formatId || "main") === format);
  return current || assetGenerationJob(assetId);
}

function outputJobStatus(job, assetId) {
  if (job) return jobProgress(job);
  return assetId ? "" : '<span class="meta">等待生成</span>';
}

function pptImageJobStatus(job, assetId) {
  return outputJobStatus(assetId && job && !activeJob(job) ? assetGenerationJob(assetId) : job, assetId);
}

function pptPageJobMessage(index, assetId) {
  const job = pptSlideJob(index, assetId);
  if (!job || !["unknown", "failed", "cancelled"].includes(job.status)) return "";
  const current = assetId ? "本页继续使用所选图片。" : "可在下方选择或上传页图。";
  return `<strong>本页生成${esc(jobLabels[job.status])}</strong><span>${esc(job.error || "此任务未交付新图片。")} ${current}</span>
    ${jobErrorLink(job) || button("查看任务详情", "job-detail", job.id, "ghost")}`;
}

function jobPreview(job) {
  if (!job?.previewVersion || job.status !== "running") return "";
  return `<img class="job-preview-image" src="/api/jobs/${encodeURIComponent(job.id)}/preview?v=${encodeURIComponent(job.previewVersion)}" alt="模型中间预览">`;
}

function scopeStatus(scope, operation) {
  const markup = scopeStatusMarkup(scope, operation);
  return `<div data-job-summary="${scope}" data-job-operation="${operation || ""}"${markup ? "" : " hidden"}>${markup}</div>`;
}

function scopeStatusMarkup(scope, operation) {
  const tracked = (state[scope].tracked || []).filter(item => !live.hiddenJobs.has(item.id));
  if (!tracked.length) return "";
  const selectedPptPage = scope === "ppt" && state.ppt.stage >= 2;
  const jobs = tracked.map(item => live.jobs.find(job => job.id === item.id)).filter(job => {
    if (!job || (operation && imageJobOperation(job) !== operation)) return false;
    if (!selectedPptPage) return true;
    return job.context?.index === state.ppt.active && (job.context.phase === "board") === (state.ppt.stage === 2);
  });
  if (selectedPptPage && !jobs.length) return "";
  if (operation && !jobs.length && tracked.every(item => (item.operation && item.operation !== operation) || live.jobs.some(job => job.id === item.id))) return "";
  const activeEdits = operation === "edit" ? jobs.filter(activeJob) : [];
  const latest = activeEdits.length ? activeEdits : jobs.slice(selectedPptPage || operation === "edit" ? -1 : -12);
  const summary = latest.length ? latest.map(job => `<span class="workbench-job-entry">${esc(job.label)} · ${jobProgress(job)}${job.status === "succeeded" && latest.length === 1 ? sizeDetail(job) : ""}${jobErrorLink(job)}</span>`).join("") : "已提交，正在同步进度";
  const recentEditError = operation === "edit" && jobs.findLast(hasJobError);
  const preview = jobs.findLast(job => job.previewVersion && job.status === "running");
  const markup = `<div class="notice workbench-job-note"><div>${summary}${recentEditError && !latest.includes(recentEditError) ? `<span class="workbench-job-entry">上次错误 · ${esc(recentEditError.label)} ${jobErrorLink(recentEditError)}</span>` : ""}</div>${button("查看任务", "open-jobs", "", "ghost")}</div>${jobPreview(preview)}`;
  if (scope === "poster" && jobs.length && jobs.length === tracked.length &&
      jobs.every(job => ["succeeded", "failed", "cancelled"].includes(job.status))) {
    const complete = jobs.filter(job => job.status === "succeeded").length;
    return `<details class="poster-task-history"><summary>任务已结束 · ${complete}/${jobs.length} 张已交付</summary>${markup}</details>`;
  }
  return markup;
}

function sizeDetail(job) {
  if (!job.requestedSize || !job.width || !job.height) return "";
  const delivered = `${job.width}x${job.height}`;
  if (delivered === job.requestedSize && (job.upscaleMethod || job.submittedSize === job.requestedSize)) return "";
  return ` · 请求 ${esc(job.requestedSize.replace("x", " × "))}，成品 ${job.width} × ${job.height} px`;
}

function jobsView() {
  if (!account) return page("生成任务", '<p class="empty"><a href="#account">登录后查看生成记录</a></p>', "jobs");
  const rows = live.jobs.map(job => `<tr><td>${button(job.label, "job-detail", job.id, "ghost", 'data-job-title')}<br><small class="meta">${esc(job.id)}</small></td><td>${esc(job.modelName)}</td><td>${jobProgress(job)}${sizeDetail(job)}<br><small class="meta">${esc(job.error || job.review || "")}</small></td><td>${points(job.price)}</td><td>${jobErrorLink(job) || button("详情", "job-detail", job.id, "ghost")}${job.assetId ? `<a class="btn btn-ghost" href="/api/assets/${esc(job.assetId)}/download">下载</a>` : ""}${job.status === "queued" ? button("取消", "cancel-live-job", job.id) : ""}${button("删除记录", "delete-live-job", job.id, "ghost")}</td></tr>`).join("");
  return page("生成任务", `<div class="card table-wrap"><table class="ds-table"><thead><tr><th>任务</th><th>模型</th><th>状态</th><th>积分</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>${rows ? "" : '<p class="meta">暂无生成记录。</p>'}</div>`, "jobs");
}

function jobImage(id, label, download = false) {
  const path = `/api/assets/${encodeURIComponent(id)}`;
  return `<a href="${path}" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="${path}" alt="${esc(label)}"></a>
    <div class="row"><a class="btn btn-ghost" href="${path}" target="_blank" rel="noopener noreferrer">查看大图</a>
    ${download ? `<a class="btn btn-ghost" href="${path}/download">下载成品</a>` : ""}</div>`;
}

async function openJobDetail(id) {
  const dialog = document.querySelector("#job-detail-dialog");
  const owner = identity;
  const request = crypto.randomUUID();
  dialog.dataset.request = request;
  const {job} = await api(`jobs/${encodeURIComponent(id)}`);
  if (owner !== identity || dialog.dataset.request !== request) return;
  const sameJob = dialog.open && dialog.dataset.jobId === id;
  renderJobDetail(dialog, job);
  if (!dialog.open) dialog.showModal();
  if (!sameJob) dialog.scrollTop = 0;
}

document.querySelector("#job-detail-dialog").addEventListener("close", event => {
  const dialog = event.currentTarget;
  if (!dialog.open) {
    delete dialog.dataset.request;
    delete dialog.dataset.jobId;
  }
});

function renderJobDetail(dialog, job) {
  dialog.dataset.jobId = job.id;
  dialog.dataset.updated = `${job.status}:${job.updated}`;
  const statuses = {queued: "等待执行。", running: "正在处理，完成后会保存成品。",
    succeeded: "已收到并保存成品。", failed: "任务失败，未交付成品。",
    unknown: "当前未保存成品，上游结果仍需核对。", cancelled: "任务已取消。"};
  const billing = job.upscaleMethod === "aliyun" ? "费用由阿里云百炼按您的账号结算。" :
    job.price ? (job.status === "unknown" ? `${points(job.price)} 积分仍在预留，尚未结算。` :
      ["failed", "cancelled"].includes(job.status) ? "预留积分已释放。" :
      `${points(job.price)} 积分${job.status === "succeeded" ? "已结算" : "已预留"}。`) : "";
  const inputs = (job.inputs || []).map((item, index) => `<div class="job-detail-image stack">
    <strong>${esc(item.name)}</strong>
    ${item.available ? jobImage(item.id, index === 0 ? "输入原图" : "参考图") :
      `<p class="meta">${item.trashed ? "素材在回收站，可在「我的素材」恢复。" : "素材文件已不可用。"}</p>`}
    ${item.jobId ? button("查看来源任务", "job-detail", item.jobId, "ghost") : ""}</div>`).join("");
  const error = hasJobError(job);
  const errorMessage = job.error || (job.status === "unknown" ? "暂时无法确认上游结果。" : "没有返回具体错误信息。");
  const nativeFormat = job.context?.outputMethod === "native" && job.context.outputFormat;
  const alternative = {gif: "分镜合成", svg: "矢量描摹"}[nativeFormat];
  const images = `<div class="job-detail-images">
      <section class="stack"><h3>原图与参考图</h3>${inputs || '<p class="meta">此任务没有输入图片。</p>'}</section>
      <section class="stack"><h3>成品</h3>${job.requestedSize ? `<p class="meta">目标 ${esc(studioSizeText(job.requestedSize))} px${job.width && job.height ? ` · 实际 ${job.width} × ${job.height} px` : ""}</p>` : ""}
      ${job.context?.outputMethod === "sheet" && job.submittedSize ? `<p class="meta">上游分镜请求 ${esc(studioSizeText(job.submittedSize))} px${job.storyboardSize ? ` · 实际返回 ${esc(studioSizeText(job.storyboardSize))} px` : ""}</p>` : ""}
      ${(job.assetAvailable ?? Boolean(job.assetId)) ? `<div class="job-detail-image">${jobImage(job.assetId, "任务成品", true)}</div>` :
        `<p class="meta">${job.assetId ? "成品文件已不可用。" : "暂无成品。"}</p>`}</section></div>`;
  dialog.innerHTML = `<header class="row-between"><h2 id="job-detail-title">${esc(job.label)}</h2>
    ${button("关闭", "close-job-detail", "", "ghost")}</header>
    <div class="stack job-detail-body"><div><p>${jobProgress(job)} · ${esc(job.modelName)}</p>
    <p class="meta">${esc(statuses[job.status] || "")} ${esc(billing)}</p>
    ${error ? `<section class="job-error-detail"><h3>错误原因</h3><p>${esc(errorMessage)}</p>
      ${alternative ? `<p class="meta">当前线路的原生格式未交付。可以在 AI 生图里选择「${alternative}」单独提交新任务。</p>` : ""}
      ${job.status === "unknown" ? '<p class="meta">可提供下方编号给管理员核对。平台会保留原任务记录，避免自动重复出图。</p>' : ""}</section>` : job.error ? `<p>${esc(job.error)}</p>` : ""}
    ${job.review ? `<p class="meta">${esc(job.review)}</p>` : ""}
    <p class="meta">任务编号 ${esc(job.id)}${job.upstreamId ? ` · 上游编号 ${esc(job.upstreamId)}` : ""}</p></div>
    ${job.canCheckResult ? `<div>${button("继续核对百炼结果", "check-upscale-result", job.id)}<p class="meta">查询原任务，百炼结果保留 24 小时。</p></div>` : ""}
    ${error ? `<details><summary>查看输入图片与成品</summary>${images}</details>` : images}
    ${job.prompt ? `<details><summary>查看提示词</summary><p class="job-detail-prompt">${esc(job.prompt)}</p></details>` : ""}</div>`;
}

async function checkUpscaleResult(id) {
  const dialog = document.querySelector("#job-detail-dialog");
  const control = dialog.querySelector('[data-action="check-upscale-result"]');
  if (control) control.disabled = true;
  const owner = identity;
  try {
    const {job} = await api(`jobs/${encodeURIComponent(id)}/check-upscale`, "POST", {});
    if (owner !== identity) return;
    if (dialog.open && dialog.dataset.jobId === id) renderJobDetail(dialog, job);
    scheduleJobs(0);
  } finally {
    if (control?.isConnected) control.disabled = false;
  }
}

function displayUpscaleSettings(result) {
  const panel = accountDialog.querySelector("#account-upscale");
  if (!panel) return;
  panel.querySelector("[data-upscale-local-status]").textContent = result.localReady ? "本地 Real-ESRGAN 已就绪。" : "需要安装本地 Real-ESRGAN。";
  panel.querySelector("[data-upscale-cloud-status]").textContent =
    `阿里云万相超分 · ${result.model} · ${result.configured ? "已保存 API Key" : "待填写 API Key"}`;
  panel.querySelector("[data-upscale-key-remove]").hidden = !result.configured;
  panel.querySelector("[data-upscale-local-install]").hidden = result.localReady;
  const key = panel.querySelector("[data-upscale-key-link]");
  key.href = result.keyUrl;
  key.hidden = false;
  const engine = panel.querySelector("[data-upscale-engine-link]");
  engine.href = result.engineUrl;
  engine.hidden = result.localReady;
}

async function refreshUpscaleSettings() {
  const owner = identity;
  const result = await api("profile/upscale");
  if (owner === identity) displayUpscaleSettings(result);
}

async function clearUpscaleKey() {
  const form = accountDialog.querySelector("#upscale-settings-form");
  const owner = identity;
  const result = await api("profile/upscale", "PUT", {clear: true});
  if (owner !== identity || !form.isConnected) return;
  form.reset();
  displayUpscaleSettings(result);
  form.querySelector('[role="status"]').textContent = "已移除。";
}

function resetDeck() {
  const ppt = state.ppt;
  ppt.boards = [];
  ppt.pages = [];
  ppt.history = {};
  ppt.boardHistory = {};
  ppt.pageEdits = {};
  delete ppt.change;
  ppt.textboxes = {};
  ppt.tracked = [];
  delete ppt.manualJobSkips;
  ppt.active = 0;
  ppt.generationId = crypto.randomUUID();
}

const pptResolutions = {"1024x576": "1024 × 576", "1280x720": "1280 × 720",
  "1920x1080": "1920 × 1080", "2560x1440": "2560 × 1440", "3840x2160": "3840 × 2160"};
function pptPageEdit(index = state.ppt.active) {
  return ((state.ppt.pageEdits ||= {})[index] ||= {});
}

function pptPrompt(ppt, index) {
  const [title, detail] = ppt.outline[index];
  const style = workspacePptTemplates.visualGuide(ppt.style);
  return `制作 16:9 中文演示文稿第 ${index + 1} 页。全套视觉风格：${style}。页标题：${title}。本页内容和布局：${detail}。如大纲提及其他模板、配色或字体，视觉风格以当前所选模板为准，保留本页结构和业务内容。以一个核心结论组织画面，标题、数据与标签清晰。技术页完整保留已确认的节点、分层、箭头方向和业务关系。保持画面留白与安全边距，不添加无来源的文字和数字。`;
}

function compactSearchResult(result) {
  if (!result) return undefined;
  return {...result, sources: (result.sources || []).map(({title, url, pageExcerpt, readStatus, provided, snippet}) =>
    ({title, url, pageExcerpt: Boolean(pageExcerpt), readStatus, provided, hasSnippet: Boolean(snippet)}))};
}

function scrollPptConversation() {
  const log = content.querySelector(".ppt-discussion");
  if (log) log.scrollTop = log.scrollHeight;
}

function pptSessionScope() {
  return state.activeProjectId || "standalone";
}

function pptSessionList() {
  if (!account) return [];
  const scope = pptSessionScope();
  const owner = identity;
  if (ui.pptSessions?.scope !== scope || ui.pptSessions.owner !== owner) {
    const catalog = {scope, owner, sessions: []};
    ui.pptSessions = catalog;
    api("ppt/sessions/" + scope).then(result => {
      if (ui.pptSessions !== catalog || owner !== identity || scope !== pptSessionScope()) return;
      catalog.sessions = result.sessions;
      if (ui.route === "ppt") render();
    }).catch(error => {
      if (ui.pptSessions === catalog && owner === identity && scope === pptSessionScope()) notify(error.message);
    });
  }
  return ui.pptSessions.sessions.filter(item => item.id !== state.ppt.draftId);
}

async function switchPptChat(target = "") {
  if (!requireAccount()) return;
  if (pending.has("ppt") || ui.uploading) return notify("请等待当前操作提交或资料上传结束。");
  const ppt = state.ppt;
  const owner = identity;
  const scope = pptSessionScope();
  const uploads = Object.fromEntries(pptSlots.filter(slot => state.uploads[slot]).map(slot => [slot, state.uploads[slot]]));
  const {documentId, ...draft} = ppt;
  const title = (ppt.brief.trim() || ppt.discussion[0]?.question || ppt.discussionDraft.trim() || "PPT 草稿").slice(0, 60);
  const hasDraft = ppt.brief.trim() || ppt.discussionDraft.trim() || ppt.discussion.length || ppt.outline.length || Object.keys(uploads).length;
  const archive = hasDraft ? {id: ppt.draftId || ppt.sessionId || crypto.randomUUID(), title, document: draft, uploads} : null;
  pending.set("ppt", "switch-chat");
  render();
  try {
    await flushSave(true);
    if (owner !== identity || scope !== pptSessionScope() || state.ppt !== ppt) return;
    const {opened, sessions} = await api("ppt/sessions/" + scope, "POST", {open: target, archive, revision});
    if (owner !== identity || scope !== pptSessionScope() || state.ppt !== ppt) return;
    for (const slot of pptSlots) {
      delete state.uploads[slot];
      delete ui.file[slot];
      const assetId = opened?.uploads?.[slot];
      if (!assetId) continue;
      state.uploads[slot] = assetId;
      const item = ui.files.find(file => file.id === assetId);
      if (item) ui.file[slot] = uploadDescriptor(item);
    }
    const id = opened ? target : crypto.randomUUID();
    state.ppt = {
      ...initialState().ppt,
      ...(opened?.document ?? {sessionId: id, model: ppt.model, languageModel: ppt.languageModel, searchMode: ppt.searchMode}),
      documentId, draftId: id
    };
    ui.pptSessions = {scope, owner, sessions};
    save();
    await flushSave(true);
    await refreshJobs();
  } finally {
    if (owner === identity) {
      pending.delete("ppt");
      if (ui.route === "ppt") {
        render();
        scrollPptConversation();
        content.querySelector('[data-field="ppt-discussion"], [data-field="ppt-brief"]')?.focus({preventScroll: true});
      }
    }
  }
}

function pptReplacementTopic(message) {
  const change = /^(?:请|麻烦|我想|我们)?\s*(?:(?:换个|换一个|更换|切换)(?:主题|话题)|(?:主题|话题)(?:换成|改成|改为)|改做|改讲|改为|改成|换成)[\s，,：:]*/.exec(message);
  if (!change) return "";
  const topic = message.slice(change[0].length).trim();
  return /^(?:听众|受众|对象|用途|风格|配色|页数|详细程度|汇报对象|用于|面向|给(?:新员工|管理层|老板)|(?:做|要)?\s*[\d一二三四五六七八九十两]{1,3}\s*[页张]|(?:蓝色|深蓝|浅蓝|红色|绿色|白色|黑色|暖色|冷色|商务风|简约风|横版|竖版)$)/.test(topic) ? "" : topic;
}

function pptLanguageRequest(ppt, model, message = "") {
  const originalBrief = ppt.brief.trim();
  const replacement = pptReplacementTopic(message);
  const brief = replacement || originalBrief;
  const lastBrief = ppt.searchBrief ?? String(ppt.discussion[0]?.question ?? originalBrief).trim();
  const sameTopic = lastBrief === originalBrief && !replacement;
  const research = pptResearchRequest(ppt);
  if (!sameTopic) research.researchId = crypto.randomUUID();
  const previous = sameTopic ? ppt.discussion.slice(ppt.searchStart || 0) : [];
  const history = previous.map(({question, reply}) => ({question: String(question || ""), reply: String(reply || "")}));
  const evidenceTurnIds = previous.filter(turn => turn.webSearch?.status === "ok" && Number.isSafeInteger(turn.evidenceTurnId))
    .slice(-4).reverse().map(turn => turn.evidenceTurnId);
  return {modelId: model.id, tokenRates: model.tokenRates, requestId: crypto.randomUUID(),
    sessionId: ppt.sessionId, projectId: state.activeProjectId || "",
    brief, style: ppt.style, level: ppt.level, requirements: ppt.requirements || {}, templateGuide: workspacePptTemplates.outlineGuide(ppt.style),
    assetIds: pptSlots.map(key => ui.file[key]?.id).filter(Boolean), history,
    evidenceTurnIds, ...research};
}

function pptResearchRequest(ppt) {
  const mode = ppt.searchMode || "auto";
  return {researchId: ppt.researchId ||= crypto.randomUUID(),
    webSearch: mode === "auto" ? undefined : mode === "always"};
}

async function streamLanguage(path, request, onDelta, onStatus) {
  const owner = identity;
  const response = await fetch("/api/" + path, {
    method: "POST",
    headers: {"Content-Type": "application/json", Accept: "application/x-ndjson"},
    body: JSON.stringify(request)
  });
  let result;
  let issue;
  await workspaceCommercial.readStream(response, event => {
    if (identity !== owner) return;
    if (event.type === "delta") onDelta(String(event.text || ""));
    if (["started", "web-search", "memory"].includes(event.type)) onStatus?.(event);
    if (event.type === "error") issue = new Error(event.message || "模型回复失败。");
    if (event.type === "done") result = event.result;
  });
  if (identity !== owner) return null;
  if (result && Number.isFinite(result.points)) {
    updateWallet(result);
    balance.textContent = points(available());
  }
  if (issue) {
    const billing = tokenBillingText(result?.billing);
    if (billing) issue.message += " " + billing;
    throw issue;
  }
  if (!result) throw new Error("模型未交付完整结果。");
  return result;
}

function pptOutlineProgress(raw) {
  const pages = [];
  const objects = raw.matchAll(/\{(?:"(?:[^"\\]|\\.)*"|[^"{}])*\}/g);
  for (const [object] of objects) {
    try {
      const page = JSON.parse(object);
      if (typeof page.title === "string" && typeof page.detail === "string") pages.push(page);
    } catch { /* A later delta may complete the current page. */ }
  }
  return pages.map(({title, detail}, index) => `${index + 1}. ${title}\n${detail}`).join("\n\n");
}

function pptStreamText(reply) {
  return reply.path === "outline" ? pptOutlineProgress(reply.text) : reply.text;
}

function pptStreamPreview() {
  const reply = live.pptReply;
  if (!reply || reply.ppt !== state.ppt || (reply.index !== null && reply.index !== state.ppt.active)) return "";
  const title = {discuss: "AI 正在回复", outline: "正在编写大纲", "revise-slide": "正在优化本页提示词"}[reply.path];
  return `<div class="ppt-stream-preview" aria-busy="true"><p class="meta job-progress" role="status"><span class="job-spinner" aria-hidden="true"></span><span data-ppt-stream-status>${esc(reply.status || title)}</span></p>
    <div data-ppt-stream-output>${esc(pptStreamText(reply) || "等待模型回复…")}</div></div>`;
}

async function pptLanguageTask(ppt, path, request, apply, index = null) {
  const owner = identity;
  const reply = {path, ppt, index, text: ""};
  live.pptReply = reply;
  pending.set("ppt", path);
  render();
  const paint = text => {
    if (owner !== identity || live.pptReply !== reply || state.ppt !== ppt) return;
    reply.text = text;
    const target = ui.route === "ppt" && (index === null || ppt.active === index) && content.querySelector("[data-ppt-stream-output]");
    if (!target) return;
    const follow = target.scrollHeight - target.clientHeight - target.scrollTop < 40;
    target.textContent = pptStreamText(reply) || "正在整理首个页面…";
    if (follow) target.scrollTop = target.scrollHeight;
  };
  const reveal = path === "outline" ? null : workspaceCommercial.revealText(paint);
  let raw = "";
  try {
    const result = await streamLanguage("ppt/" + path, request, chunk => {
      const limit = {discuss: 32000, outline: 32000, "revise-slide": 4500}[path];
      if (raw.length >= limit) return;
      raw = (raw + chunk).slice(0, limit);
      if (reveal) reveal.set(raw);
      else paint(raw);
    }, event => {
      reply.status = event.type === "memory" ? (event.state === "compacting" ? "正在整理较早对话，保留关键决定和纠正…" : "已载入会话摘要，继续回复…") :
        event.type === "started" ? (event.research ? "正在查找公开资料…" : "") :
        event.result.sources.length ? `${event.result.reused ? "已沿用" : "已获取"} ${event.result.sources.length} 条联网来源，正在整理…` :
        "未取得可用联网资料，正在整理已有信息…";
      const target = ui.route === "ppt" && state.ppt === ppt && content.querySelector("[data-ppt-stream-status]");
      if (target && reply.status) target.textContent = reply.status;
    });
    if (reveal) await reveal.drain();
    if (owner !== identity) return;
    if (state.ppt !== ppt) return;
    apply(result);
    if (result.warnings) ppt.sourceWarnings = result.warnings;
    save();
    const billing = tokenBillingText(result.billing);
    if (billing) notify(billing);
  } finally {
    reveal?.flush();
    if (owner === identity) {
      if (live.pptReply === reply) live.pptReply = null;
      pending.delete("ppt");
      if (ui.route === "ppt") {
        render();
        if (path === "discuss" && state.ppt === ppt) scrollPptConversation();
      }
    }
  }
}

async function discussPpt(searchNow = false) {
  if (!requireAccount()) return;
  if (scopeInProgress("ppt")) return notify("请先等待当前 PPT 任务结束。");
  const ppt = state.ppt;
  const model = modelFor("chat", "text", ppt.languageModel).selected;
  if (!model) return notify("请先上架可用的语言模型。");
  const message = ppt.discussionDraft.trim() || (searchNow && ppt.discussion.length ? "重新搜索资料" : "");
  const request = pptLanguageRequest(ppt, model, message);
  if (!message && (ppt.discussion.length || !(ppt.brief.trim() || request.assetIds.length))) {
    return notify("请填写汇报需求或本次补充。");
  }
  if (searchNow) Object.assign(request, {webSearch: true, refreshWebSearch: true});
  await pptLanguageTask(ppt, "discuss", {...request, message}, result => {
    if (ppt.researchId !== request.researchId) {
      ppt.researchId = request.researchId;
      ppt.searchStart = ppt.discussion.length;
    }
    if (request.brief !== ppt.brief.trim()) ppt.brief = request.brief;
    ppt.searchBrief = request.brief;
    ppt.discussion.push({question: message || ppt.brief.trim() || "请先帮我梳理所选资料。", reply: result.reply,
      webSearch: compactSearchResult(result.webSearch), evidenceTurnId: result.evidenceTurnId});
    ppt.discussionDraft = "";
    ppt.maxStage = 0;
  });
}

async function revisePptPrompt() {
  if (!requireAccount()) return;
  if (pending.has("ppt")) return notify("请先等待当前操作提交或 AI 回复结束。");
  const ppt = state.ppt;
  const model = modelFor("chat", "text", ppt.languageModel).selected;
  if (!model) return notify("请先上架可用的语言模型。");
  const index = ppt.active;
  const edit = pptPageEdit(index);
  const change = (edit.change || "").trim();
  if (!change) return notify("先写下这一页想怎么改。");
  const [title, detail] = ppt.outline[index];
  const request = pptLanguageRequest(ppt, model);
  const {modelId, tokenRates, requestId, brief, style, history, webSearch, researchId, evidenceTurnIds, sessionId, projectId} = request;
  await pptLanguageTask(ppt, "revise-slide", {modelId, tokenRates, requestId, brief, history, webSearch,
    researchId, evidenceTurnIds, sessionId, projectId,
    title, detail, change, style: workspacePptTemplates.visualGuide(style), prompt: edit.prompt || pptPrompt(ppt, index)},
  result => { edit.suggestion = result.prompt; edit.webSearch = compactSearchResult(result.webSearch); }, index);
}

async function makeOutline() {
  if (!requireAccount()) return;
  if (scopeInProgress("ppt")) return notify("请先等待当前 PPT 任务结束。");
  const ppt = state.ppt;
  const model = modelFor("chat", "text", ppt.languageModel).selected;
  if (!model) return notify("请先上架可用的语言模型。");
  const request = pptLanguageRequest(ppt, model);
  if (!ppt.discussion.length) return notify("请先和 AI 沟通一轮，再确认生成大纲。");
  const owner = identity;
  openModal("生成 PPT 大纲", `${model.name} · ${tokenRateText(model)}`,
    "将需求、资料和适用的联网来源交给模型整理。按实际 Token 用量结算。", "生成大纲", async () => {
      if (owner !== identity || state.ppt !== ppt || scopeInProgress("ppt")) return;
      await pptLanguageTask(ppt, "outline", request, result => {
        resetDeck();
        ppt.outline = result.outline;
        ppt.outlineWebSearch = compactSearchResult(result.webSearch);
        ppt.stage = ppt.maxStage = 1;
      });
    });
}

function adoptPptBoards() {
  const ppt = state.ppt;
  if (scopeInProgress("ppt")) return notify("请先等待当前 PPT 任务结束。");
  if (!ppt.outline.every((_, index) => visualExists(ppt.boards[index]))) return notify("请先补齐分镜。");
  const fill = ppt.outline.map((_, index) => visualExists(ppt.pages[index]) ? ppt.pages[index] : ppt.boards[index]);
  ppt.pages = fill;
  ppt.stage = ppt.maxStage = 3;
  save();
  render();
}

function buildPptPages(phase) {
  const ppt = state.ppt;
  if (ppt.outline.some(([title]) => !title.trim())) return notify("请填写每一页的标题。");
  const board = phase === "board" || phase === "board-redo";
  const single = phase === "redo" || phase === "board-redo";
  const batch = board ? ppt.boards : ppt.pages;
  const wanted = single ? [ppt.active] : ppt.outline.map((_, index) => index).filter(index => !visualExists(batch[index]));
  const running = new Set(live.allJobs.filter(job => activeJob(job) && job.scope === "ppt" &&
    job.context?.documentId === ppt.documentId && job.context.generationId === ppt.generationId &&
    (job.context.phase === "board") === board).map(job => job.context.index));
  const indexes = wanted.filter(index => !running.has(index));
  if (wanted.length && !indexes.length) return notify("所选页面已提交，可在「生成任务」查看。");
  const size = Object.hasOwn(pptResolutions, ppt.resolution) ? ppt.resolution : "1920x1080";
  if (!indexes.length) {
    ppt.stage = board ? 2 : 3;
    save();
    render();
    return;
  }
  const model = modelFor("image", "generate", ppt.model).selected;
  const keepLayout = modelFor("image", "reference", model?.id).options.some(item => item.id === model?.id);
  const requests = indexes.map(index => {
    const edit = pptPageEdit(index);
    const existing = [batch[index], !board ? ppt.boards[index] : null].find(visualExists);
    const prompt = (edit.prompt?.trim() || pptPrompt(ppt, index)) +
      (edit.change?.trim() ? "\n本次修改要求：" + edit.change.trim() : "") +
      (existing && keepLayout ? "\n沿用参考页未要求修改的布局和内容。" : "");
    return {label: `PPT ${board ? "分镜" : "成稿"} · 第 ${index + 1} 页`, prompt,
      size, imageIds: existing && keepLayout ? [existing] : [],
      context: {index, phase: board ? "board" : phase, regenerate: single}};
  });
  return confirmImages("ppt", model, requests, () => {
    ppt.stage = board ? 2 : 3;
    ppt.maxStage = Math.max(ppt.maxStage, ppt.stage);
  }, null, `目标 ${pptResolutions[size]} px${requests.some(item => item.imageIds.length) ? " · 参考已有页" : single ? " · 按提示词重出" : ""}`);
}

async function confirmImageTool(name, args, model, options = {}) {
  if (!requireAccount()) return;
  if (!model && name !== "upscale_image") return notify("当前操作需要先在后台设置上架适用的图片模型。");
  const owner = identity;
  const document = state.image;
  const parameters = model ? {...args, modelId: model.id} : args;
  const quote = await api(`image-tools/${name}/quote`, "POST", {arguments: parameters});
  if (owner !== identity || document !== state.image) return;
  const requestId = crypto.randomUUID();
  const pricedModel = {...model, name: quote.modelName, price: quote.unitPrice};
  return confirmImages("image", pricedModel, Array.from({length: quote.quantity}, () => ({})), null,
    documentId => api(`image-tools/${name}/execute`, "POST", {
      arguments: quote.arguments, expectedPrice: quote.total, requestId,
      context: {documentId, ...(options.operation ? {operation: options.operation} : {})}
    }), `${quote.title} ${(quote.size || quote.arguments.size).replace("x", " × ")} px`,
    args.method === "aliyun" ? "原图将发送到阿里云百炼，费用由你填写的百炼账号结算。" : "");
}

function executeLocalImageTool(name, args) {
  return api(`image-tools/${name}/execute`, "POST", {arguments: args, expectedPrice: 0, requestId: crypto.randomUUID()});
}

function actualSlide(index, focusable) {
  const ppt = state.ppt;
  const identifier = (ppt.stage === 3 ? ppt.pages : ppt.boards)[index];
  const asset = ui.files.find(file => file.id === identifier);
  const job = pptSlideJob(index, asset?.id);
  return `<div class="slide-raster output-job-frame">
    ${asset ? uploadArtwork(uploadDescriptor(asset), "slide:" + index, focusable) : ""}
    <div class="output-job-slot${asset ? "" : " is-placeholder"}" data-ppt-job="${index}" data-asset="${esc(asset?.id || "")}">${pptImageJobStatus(job, asset?.id)}</div>
  </div>`;
}

function setPptPageImage(ppt, index, final, id) {
  const slides = final ? ppt.pages : ppt.boards;
  const history = final ? ppt.history : ppt.boardHistory;
  const previous = slides[index];
  if (previous === id) return;
  history[index] = [...new Set([...(history[index] || []).filter(value => value !== id), previous].filter(Boolean))];
  slides[index] = id;
  if (final) delete ppt.textboxes[index];
  else if (previous && ppt.pages[index] === previous) setPptPageImage(ppt, index, true, id);
}

async function selectPptPageImage(ppt, index, final, id) {
  const generationId = ppt.generationId;
  if (!ui.imageRecordsLoaded && ppt.documentId) await refreshJobs();
  if (state.ppt !== ppt || ppt.generationId !== generationId || !visualExists(id)) return;
  const followsBoard = !final && ppt.boards[index] && ppt.pages[index] === ppt.boards[index];
  const pendingJobs = live.allJobs.filter(job => job.scope === "ppt" && job.context?.documentId === ppt.documentId &&
    job.context.generationId === ppt.generationId && job.context.index === index &&
    ((job.context.phase !== "board") === final || followsBoard) && (activeJob(job) || job.status === "unknown"));
  if (pendingJobs.length) ppt.manualJobSkips = [...new Set([...(ppt.manualJobSkips || []), ...pendingJobs.map(job => job.id)])];
  setPptPageImage(ppt, index, final, id);
  await saveNow();
  if (ui.route === "ppt" && state.ppt === ppt) render();
}

function choosePptAsset() {
  const choices = studioAssetList();
  if (!choices.length) return notify("素材库中暂无可用图片。");
  const ppt = state.ppt;
  const index = ppt.active;
  const final = ppt.stage === 3;
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form class="stack"><h2>用素材替换第 ${index + 1} 页</h2>
    <label class="field">选择图片<select class="input" name="assetId">${choices.map(file => `<option value="${esc(file.id)}">${esc(file.name)}</option>`).join("")}</select></label>
    <div class="row"><button class="btn btn-secondary" type="button">取消</button><button class="btn btn-primary">采用这张图</button></div></form>`;
  const form = dialog.querySelector("form");
  form.querySelector('[type="button"]').onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = form.querySelector(".btn-primary");
    submit.disabled = true;
    try {
      await selectPptPageImage(ppt, index, final, form.elements.assetId.value);
      dialog.close();
    } catch (error) {
      notify(error.message);
    } finally {
      submit.disabled = false;
    }
  };
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
}

function uploadPptPageImage() {
  if (!requireAccount()) return;
  if (ui.uploading) return notify("正在上传图片，请稍等。");
  const ppt = state.ppt;
  const {active: index, generationId} = ppt;
  const final = ppt.stage === 3;
  const owner = identity;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file || owner !== identity || ui.uploading) return;
    ui.uploading = true;
    try {
      const asset = await storeFile(normalizeFile(file, "ppt-page", false), owner);
      if (!asset || state.ppt !== ppt || ppt.generationId !== generationId) return;
      await selectPptPageImage(ppt, index, final, asset.id);
      notify(`已替换第 ${index + 1} 页`);
    } catch (error) {
      notify(error.message);
    } finally {
      if (owner === identity) ui.uploading = false;
    }
  }, {once: true});
  input.click();
}

function markPptText() {
  const ppt = state.ppt;
  const index = ppt.active;
  const assetId = ppt.pages[index];
  if (!visualExists(assetId)) return;
  const boxes = [...(ppt.textboxes[index] || [])];
  const visualModel = modelFor("chat", "vision").selected;
  const owner = identity;
  const dialog = document.createElement("dialog");
  dialog.className = "ppt-text-mark";
  dialog.innerHTML = `<form class="stack"><h2>第 ${index + 1} 页 · 补充可编辑文字</h2>
    <p class="meta">在原图上紧贴文字拖出选区，避开图标和线条。可输入正确内容，也可先识别再校对。</p>
    <label class="field">已有选区<select class="input" name="saved"></select></label>
    <div class="ppt-text-mark-image"><img src="/api/assets/${esc(assetId)}" alt="本页原图，拖动圈选文字" draggable="false"><span hidden></span></div>
    <label class="field">文字内容<textarea class="textarea" rows="2" name="text" maxlength="1000"></textarea></label>
    <div class="row"><button class="btn btn-secondary" type="button" data-recognize>识别选区文字</button>
      ${visualModel ? '<button class="btn btn-secondary" type="button" data-verify>OCR 与视觉复核</button>' : ""}
      <button class="btn btn-ghost" type="button" data-remove>移除此文字层</button></div>
    ${visualModel ? `<p class="meta">视觉复核仅发送选区给 ${esc(visualModel.name)}。${esc(tokenRateText(visualModel))}。</p>` : ""}
    <div data-verify-results hidden></div>
    <p class="meta" role="status"></p>
    <div class="row"><button class="btn btn-secondary" type="button" data-close>取消</button><button class="btn btn-primary">保存并关闭</button></div></form>`;
  const form = dialog.querySelector("form");
  const image = dialog.querySelector("img");
  const marker = image.nextElementSibling;
  const select = form.elements.saved;
  const input = form.elements.text;
  const status = dialog.querySelector("[role=status]");
  const recognize = dialog.querySelector("[data-recognize]");
  const verify = dialog.querySelector("[data-verify]");
  const comparison = dialog.querySelector("[data-verify-results]");
  const remove = dialog.querySelector("[data-remove]");
  let region = null, start = null, selected = -1;
  const show = box => {
    marker.hidden = !box;
    if (box) Object.assign(marker.style, {left: box.x * 100 + "%", top: box.y * 100 + "%",
      width: box.w * 100 + "%", height: box.h * 100 + "%"});
  };
  const choose = next => {
    selected = next;
    select.innerHTML = `<option value="-1">新增选区</option>${boxes.map((box, i) =>
      `<option value="${i}">${esc(box.text.slice(0, 36))}</option>`).join("")}`;
    select.value = String(next);
    region = boxes[next] || null;
    comparison.hidden = true;
    input.value = region?.text || "";
    remove.disabled = next < 0;
    show(region);
  };
  choose(-1);
  select.onchange = () => choose(Number(select.value));
  remove.onclick = () => { boxes.splice(selected, 1); choose(-1); status.textContent = "保存后移除此文字层。"; };
  const point = event => {
    const rect = image.getBoundingClientRect();
    return ["clientX", "clientY"].map((key, i) =>
      Math.min(1, Math.max(0, (event[key] - [rect.left, rect.top][i]) / [rect.width, rect.height][i])));
  };
  const selection = ([x, y]) => ({x: Math.min(x, start[0]), y: Math.min(y, start[1]),
    w: Math.abs(x - start[0]), h: Math.abs(y - start[1])});
  image.onpointerdown = event => {
    if (event.button !== 0 || !image.naturalWidth) return;
    start = point(event);
    image.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  image.onpointermove = event => { if (start) show(selection(point(event))); };
  image.onpointercancel = () => { start = null; show(region); };
  image.onpointerup = event => {
    if (!start) return;
    const box = selection(point(event));
    start = null;
    if (box.w * image.naturalWidth >= 3 && box.h * image.naturalHeight >= 3) {
      region = box;
      comparison.hidden = true;
    }
    show(region);
  };
  recognize.onclick = async () => {
    if (!region) { status.textContent = "请先拖动圈选文字。"; return; }
    const requested = region;
    recognize.disabled = true;
    status.textContent = "正在识别选区…";
    try {
      const result = await api(`assets/${assetId}/ocr`, "POST", {region: requested});
      if (region !== requested) return;
      if (result.text) input.value = result.text.slice(0, 1000);
      status.textContent = result.text ? "请核对识别结果后保存。" : "未识别到文字，可以手动输入。";
    } catch (error) { status.textContent = error.message; }
    finally { recognize.disabled = false; }
  };
  if (verify) verify.onclick = async () => {
    if (!region) { status.textContent = "请先拖动圈选文字。"; return; }
    const requested = region;
    comparison.hidden = true;
    verify.disabled = true;
    status.textContent = "本机 OCR 与视觉模型正在分别读取选区…";
    try {
      const result = await api("ppt/verify-text", "POST", {assetId, region: requested,
        modelId: visualModel.id, tokenRates: visualModel.tokenRates, requestId: crypto.randomUUID()});
      if (owner !== identity) return;
      if (Number.isFinite(result.points)) {
        updateWallet(result);
        balance.textContent = points(available());
      }
      if (region !== requested || !dialog.open) return;
      comparison.replaceChildren();
      for (const [label, value] of [["本机 OCR", result.ocr], ["视觉模型", result.candidate]]) {
        const item = document.createElement("div");
        item.className = "field";
        const text = document.createElement("p");
        text.className = "meta";
        text.style.whiteSpace = "pre-wrap";
        text.textContent = label + " · " + (value || "未识别到明确文字");
        item.append(text);
        if (value) {
          const use = document.createElement("button");
          use.type = "button";
          use.className = "btn btn-secondary";
          use.textContent = "采用" + label;
          use.onclick = () => { input.value = value; };
          item.append(use);
        }
        comparison.append(item);
      }
      comparison.hidden = false;
      status.textContent = result.ocr && result.ocr === result.candidate
        ? "两份结果一致，请对照原图后采用。" : "两份结果不一致，请对照原图后选择或手动填写。";
    } catch (error) { status.textContent = error.message; }
    finally { verify.disabled = false; }
  };
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    if (state.ppt !== ppt || ppt.pages[index] !== assetId) return dialog.close();
    const value = input.value.trim();
    if (region || value) {
      if (!region || !value) { status.textContent = "请圈选区域并填写文字。"; return; }
      if (selected < 0 && boxes.length >= 30) { status.textContent = "单页最多保存 30 个文字选区。"; return; }
      const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      if (boxes.some((box, i) => i !== selected && overlaps(box, region))) {
        status.textContent = "文字选区不能重叠，请缩小或移动选区。"; return;
      }
      boxes[selected < 0 ? boxes.length : selected] = {...region, text: value};
    }
    if (boxes.length) ppt.textboxes[index] = boxes;
    else delete ppt.textboxes[index];
    dialog.close();
    save();
    render();
  };
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
}

function pptExportStatus(ppt) {
  const task = ui.pptExport;
  if (task?.ppt === ppt) {
    const message = task.native ? "正在按大纲排版，制作原生可编辑 PPTX" : task.editable ? "正在识别文字并制作可编辑 PPTX" : "正在打包原图 PPTX";
    return `<div class="ppt-export-status" data-ppt-export-active>
      <div class="ppt-export-status-line"><span class="job-spinner" aria-hidden="true"></span>
        <strong role="status">${message}</strong>${runningElapsed(task.started)}</div>
      <div class="ppt-export-track" aria-hidden="true"></div>
    </div>`;
  }
  const result = ui.pptExportResult;
  if (result?.ppt !== ppt) return "";
  if (result.error) return `<p class="ppt-export-status" role="status">${esc(result.error)}</p>`;
  return `<div class="ppt-export-status" role="status"><strong>下载已开始 · 耗时 ${result.seconds} 秒</strong>
    ${result.slides ? `<p class="meta">共 ${result.slides} 页${result.continued ? `，长内容自动增加 ${result.continued} 页，正文已完整保留` : ""}。</p>` : ""}
    ${result.imagePages ? `<p class="meta">第 ${esc(result.imagePages)} 页按原图导出。</p>` : ""}
    ${result.reviewPages ? `<p class="meta">第 ${esc(result.reviewPages)} 页有文字保留在底图，可圈选补充。</p>` : ""}</div>`;
}

const pptLayouts = {cover: "封面", section: "章节", points: "要点", comparison: "对照", process: "流程", closing: "结尾"};

function parsePptOutline(value) {
  const pages = [];
  for (const line of value.replaceAll("\r", "").split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (!heading[1].trim()) throw new Error("页标题不能为空，请在 # 后填写标题。");
      pages.push([heading[1].trim(), ""]);
    }
    else if (pages.length) pages[pages.length - 1][1] += line + "\n";
    else if (line.trim()) throw new Error("请用 # 页标题 开始每一页，再填写正文。");
  }
  if (!pages.length || pages.length > 24) throw new Error("请提供 1 至 24 页大纲，用 # 页标题 分隔。");
  pages.forEach(([title, detail], index) => {
    if (title.length > 120 || detail.trim().length > 2000) throw new Error(`第 ${index + 1} 页过长：标题最多 120 字，正文最多 2000 字，请拆页。`);
    if (!detail.trim()) throw new Error(`请补充第 ${index + 1} 页正文。`);
    pages[index][1] = detail.trim();
  });
  return pages;
}

function openManualPptOutline() {
  if (!requireAccount(openManualPptOutline)) return;
  if (pending.has("ppt") || scopeInProgress("ppt") || ui.pptExport) return notify("请等待当前 PPT 任务结束。");
  const ppt = state.ppt, owner = identity;
  const dialog = document.createElement("dialog");
  dialog.className = "ppt-manual-outline";
  dialog.setAttribute("aria-labelledby", "ppt-manual-title");
  dialog.innerHTML = `<form class="stack"><h2 id="ppt-manual-title">整理已有大纲</h2>
    <p class="meta">每页以「# 页标题」开始，下一行填写正文。支持 1 至 24 页，内容只在本地整理。</p>
    <label class="field">逐页内容<textarea class="textarea" name="outline" rows="15" maxlength="52000" placeholder="# 项目阶段汇报&#10;面向部门负责人，确认本阶段结果与下一步安排。&#10;&#10;# 当前进展&#10;填写已确认的结果和依据。" required>${esc(ppt.outline.map(([title, detail]) => `# ${title}\n${detail}`).join("\n\n"))}</textarea></label>
    ${ppt.outline.length ? '<p class="meta">应用后替换当前大纲和页面安排；已生成图片仍保留在素材库。</p>' : ""}
    <p class="status-line" role="status"></p><div class="row"><button type="button" class="btn btn-secondary" data-close>取消</button><button class="btn btn-primary">应用大纲</button></div></form>`;
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.querySelector("form").onsubmit = event => {
    event.preventDefault();
    if (owner !== identity || state.ppt !== ppt) return dialog.close();
    try {
      const outline = parsePptOutline(dialog.querySelector("textarea").value);
      resetDeck();
      ppt.outline = outline;
      ppt.stage = ppt.maxStage = 1;
      save();
      dialog.close();
      render();
    } catch (error) { dialog.querySelector('[role="status"]').textContent = error.message; }
  };
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
}

async function savePpt(editable, native = false) {
  if (!requireAccount()) return;
  const ppt = state.ppt;
  if (ui.pptExport) return;
  const slides = native ? ppt.outline.map(([title, detail, layout], index) => ({title, detail, layout: layout || (index === 0 ? "cover" : "points")})) : ppt.outline.map(([title], index) => ({
    title, assetId: ppt.pages[index], textboxes: editable ? ppt.textboxes[index] || [] : [],
    preserveImage: editable && ppt.pageEdits?.[index]?.preserveImage === true
  }));
  if (!slides.length) return notify("请先确认大纲。");
  if (native && slides.some(slide => !slide.title?.trim() || !slide.detail?.trim())) return notify("请填写每一页的标题和正文后导出。");
  if (!native && slides.some(slide => !visualExists(slide.assetId))) return notify("请先补齐全部成稿。");
  if (editable && slides.every(slide => slide.preserveImage)) return notify("所有页面均设为保留原图。取消至少一页的设置，或直接导出原图。");
  const owner = identity;
  const title = slides[0].title || "演示文稿";
  const task = {ppt, editable, native, started: Math.floor(Date.now() / 1000)};
  ui.pptExport = task;
  ui.pptExportResult = null;
  render();
  try {
    const result = await fetch("/api/ppt/export", {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(native ? {format: "native", slides, template: workspacePptTemplates.nativeTemplate(ppt.style)} : {slides, editable, auto: editable})});
    if (!result.ok) {
      const failure = await result.json().catch(() => ({}));
      throw new Error(failure.error || "导出失败，请重试。");
    }
    const blob = await result.blob();
    if (owner !== identity || ui.pptExport !== task) return;
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = title.replace(/[\\/:*?"<>|]/g, "_") + (native ? "-原生可编辑" : editable ? "-图片文字可编辑" : "-原图") + ".pptx";
    link.click();
    ui.pptExportResult = {ppt, seconds: jobSeconds(task.started),
      slides: Number(result.headers.get("X-PPT-Slide-Count")) || slides.length,
      continued: Number(result.headers.get("X-PPT-Continued-Slides")) || 0,
      imagePages: result.headers.get("X-PPT-Image-Only-Pages")?.replaceAll(",", "、"),
      reviewPages: result.headers.get("X-PPT-Review-Pages")?.replaceAll(",", "、")};
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  } catch (error) {
    if (owner === identity && ui.pptExport === task) ui.pptExportResult = {ppt, error: error.message};
  } finally {
    if (owner === identity && ui.pptExport === task) {
      ui.pptExport = "";
      if (ui.route === "ppt") render();
    }
  }
}

function assetDetails(file) {
  if (file.mime.startsWith("image/")) return showAssetPrompt(file);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `<form class="stack"><h2>素材详情</h2>
    <label class="field">名称<input class="input" name="name" maxlength="120" value="${esc(file.name)}" required></label>
    <label class="field">标签<input class="input" name="tags" maxlength="200" value="${esc(file.tags)}"></label>
    <label class="field">备注<textarea class="textarea" name="notes" maxlength="2000">${esc(file.notes)}</textarea></label>
    <p class="meta" role="status"></p><div class="row"><button class="btn btn-secondary" type="button" data-close>取消</button><button class="btn btn-primary">保存详情</button></div></form>`;
  const form = dialog.querySelector("form");
  const status = form.querySelector('[role="status"]');
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`assets/${file.id}/metadata`, "PUT", Object.fromEntries(new FormData(form)));
      await refreshFiles();
      dialog.close();
      render();
    } catch (error) { status.textContent = error.message; }
  };
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
}

async function showAssetPrompt(file) {
  const owner = identity;
  const dialog = document.createElement("dialog");
  dialog.className = "prompt-review asset-prompt-dialog";
  dialog.setAttribute("aria-labelledby", "asset-prompt-title");
  dialog.innerHTML = `<div class="stack">
    <h2 id="asset-prompt-title">生成提示词</h2>
    <pre data-prompt tabindex="0">${file.jobId ? "正在读取…" : "这张图片没有生成提示词。"}</pre>
    <p class="meta" role="status"></p>
    <div class="row"><button type="button" class="btn btn-ghost" data-close>关闭</button>
      <button type="button" class="btn btn-secondary" data-copy disabled>复制</button>
      <button type="button" class="btn btn-primary" data-reuse disabled>带到 AI 生图</button></div></div>`;
  const status = dialog.querySelector('[role="status"]');
  const output = dialog.querySelector("[data-prompt]");
  const copy = dialog.querySelector("[data-copy]");
  const reuse = dialog.querySelector("[data-reuse]");
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove(), {once: true});
  document.body.append(dialog);
  dialog.showModal();
  if (!file.jobId) return;
  try {
    const record = await api(`assets/${file.id}/prompt`);
    if (!dialog.open || owner !== identity) return;
    const prompt = record.prompt;
    output.textContent = prompt || "这张图片没有生成提示词。";
    if (!prompt) return;
    copy.disabled = reuse.disabled = false;
    copy.onclick = () => navigator.clipboard.writeText(prompt).then(() => {
      status.textContent = "已复制。";
    }).catch(() => {
      status.textContent = "无法自动复制，请选择文本后手动复制。";
    });
    reuse.onclick = () => {
      if (owner !== identity) return;
      imageGeneration().prompt = prompt.slice(0, 3000);
      dialog.close();
      openTool("text");
    };
  } catch (error) {
    if (dialog.open) output.textContent = error.message;
  }
}

function opsView(section) {
  const current = live.operations || {jobs: [], audit: []};
  if (section === "queue") {
    const settings = ui.generationSettings;
    return `<section class="card commercial-admin" aria-label="任务设置"><h2>任务设置</h2>
      ${settings ? `<form class="commercial-form stack" id="generation-settings-form">
        <label class="field">全站同时生成上限（张）<input class="input" name="concurrency" type="number" min="1" max="${settings.maximum}" step="1" required value="${settings.concurrency}"></label>
        <p class="meta">默认 10 张。超过上限的任务按提交顺序等待。降低上限后，正在处理的任务继续完成。</p>
        <p class="status-line" role="status"></p><button class="btn btn-primary">保存任务设置</button></form>` : '<p class="meta">正在读取任务设置…</p>'}</section>`;
  }
  if (section === "access") {
    return `<section class="card commercial-admin" aria-label="邀请码与积分"><h2>邀请码与积分</h2><div class="grid-2">
      <form class="commercial-form stack" data-issue-code="invites"><h3>生成邀请码</h3><label class="field">有效天数<input class="input" type="number" min="1" max="90" value="7" name="days" required></label><button class="btn btn-primary">生成邀请码</button><output role="status"></output></form>
      <form class="commercial-form stack" data-issue-code="credit-codes"><h3>生成兑换码</h3><label class="field">积分<input class="input" name="amount" type="number" min="${POINT_STEP}" max="10000" step="${POINT_STEP}" required></label><label class="field">有效天数<input class="input" type="number" min="1" max="90" value="7" name="days" required></label><button class="btn btn-primary">生成兑换码</button><output role="status"></output></form>
    </div></section>`;
  }
  if (section === "tasks") {
    const jobs = current.jobs.map(job => `<tr><td>${esc(job.label)}<br><small class="meta">${esc(job.id)}${job.upstreamId ? " / " + esc(job.upstreamId) : ""}</small></td><td>${esc(job.owner)}</td><td>${jobLabels[job.status]}</td><td>${points(job.price)}</td><td>${esc(job.error)}
      ${job.status === "unknown" ? button(job.scope === "chat" ? "释放预留积分" : "核对失败", "reconcile-job", job.id) + (job.scope !== "chat" ? button("补录结果图片", "recover-job", job.id) : "") : ""}
      ${job.tokenBilling ? `<form class="token-settlement row" data-token-settlement="${esc(job.id)}">
        <input class="input" type="number" name="input" min="0" step="1" max="100000000" aria-label="实际输入 Token" placeholder="输入 Token" value="${job.tokenUsage?.input ?? ""}" required>
        <input class="input" type="number" name="output" min="0" step="1" max="100000000" aria-label="实际输出 Token" placeholder="输出 Token" value="${job.tokenUsage?.output ?? ""}" required>
        <button class="btn btn-secondary">按用量结算</button><span class="meta" role="status"></span></form>` : ""}</td></tr>`).join("");
    return `<section class="card commercial-admin" aria-label="任务记录"><header><h2>任务记录</h2><p class="meta">查看生成任务、积分消耗和待核对结果。</p></header>
      ${jobs ? `<div class="table-wrap"><table class="ds-table commercial-table"><thead><tr><th>任务</th><th>用户</th><th>状态</th><th>积分</th><th>详情</th></tr></thead><tbody>${jobs}</tbody></table></div>` : '<p class="empty">暂无生成任务。</p>'}</section>`;
  }
  const audit = current.audit.map(entry => `<tr><td>${localDate(entry.created)}</td><td>${esc(entry.actor)}</td><td>${esc(entry.action)}</td><td>${esc(entry.target)}</td></tr>`).join("");
  return `<section class="card commercial-admin" aria-label="操作记录"><header><h2>操作记录</h2><p class="meta">查看管理员的运营变更。</p></header>
    ${audit ? `<div class="table-wrap"><table class="ds-table commercial-table"><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>对象</th></tr></thead><tbody>${audit}</tbody></table></div>` : '<p class="empty">暂无操作记录。</p>'}</section>`;
}
