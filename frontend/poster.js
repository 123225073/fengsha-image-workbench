"use strict";

const posterFormats = [
  {id: "main", name: "活动主海报", width: 960, height: 1600, ratio: "3:5", layout: "bottom", scene: "中近景主体居中偏上，利用前景与背景拉开纵深"},
  {id: "story", name: "手机全屏", width: 1080, height: 1920, ratio: "9:16", layout: "top", scene: "用纵向景深突出主体，将主体放在中下部，四周留出界面安全边距"},
  {id: "feed", name: "竖版社媒", width: 1080, height: 1440, ratio: "3:4", layout: "bottom", scene: "主体在上半部，略带俯角，保留产品轮廓并简化背景"},
  {id: "portrait", name: "商品竖图", width: 1080, height: 1350, ratio: "4:5", layout: "top", scene: "产品中下部居中，做正面或四分之三角度的展示"},
  {id: "square", name: "宣传方图", width: 1600, height: 1600, ratio: "1:1", layout: "bottom", scene: "以主体上方偏右为视觉重心，平衡左上角与周边道具"},
  {id: "product", name: "电商方图", width: 1080, height: 1080, ratio: "1:1", layout: "top", scene: "产品居中偏下，使用整洁的陈列台和可辨认的包装细节"},
  {id: "landscape", name: "横版配图", width: 1200, height: 900, ratio: "4:3", layout: "left", scene: "采用环境中景，主体在右侧，保持环境与主体的层次"},
  {id: "wide", name: "展示横幅", width: 1600, height: 900, ratio: "16:9", layout: "left", scene: "采用横向舞台式构图，主体在右侧中部，背景向左延展"},
  {id: "cover", name: "文章封面", width: 1200, height: 600, ratio: "2:1", layout: "left", scene: "右侧用较近的景别呈现产品，左侧提供连贯简洁的背景"},
  {id: "banner", name: "网页通栏", width: 1680, height: 720, ratio: "21:9", layout: "left", scene: "沿水平方向展开场景，主体位于右三分之一，保持产品完整"},
  {id: "header", name: "窄幅横条", width: 1920, height: 640, ratio: "3:1", layout: "left", scene: "右侧以横向陈列呈现主体或产品组合，避免主体贴边"},
  {id: "print", name: "A4 竖版", width: 2480, height: 3508, ratio: "A4", layout: "bottom", scene: "以完整产品和大面积环境建立印刷海报构图，四边留足裁印安全区"}
];
const posterReferenceSlots = ["poster-reference", "poster-reference2", "poster-reference3"];
const posterReferenceTargets = ["poster-product", ...posterReferenceSlots];
const posterCopyArea = {top: "上方", bottom: "下方", left: "左侧"};
const posterPresets = {
  auto: {name: "智能推荐", note: "根据物料尺寸、产品图和文案安排构图。"},
  campaign: {name: "促销海报", note: "突出商品和活动，按尺寸为标题和价格留位。"},
  studio: {name: "商品主图", note: "保留真实外观，导出干净背景和商品，不叠加活动文案。"},
  lifestyle: {name: "使用场景", note: "用真实环境和道具说明产品如何使用。"},
  detail: {name: "卖点细节", note: "聚焦一个可从产品图确认的细节或卖点。"}
};

function posterPresetFor(poster, format) {
  if (poster.preset !== "auto" && Object.hasOwn(posterPresets, poster.preset)) return poster.preset;
  if (poster.title?.trim() || poster.subtitle?.trim() || poster.date?.trim()) return "campaign";
  if (["product", "portrait"].includes(format?.id)) return "studio";
  return ui.file["poster-product"] ? "lifestyle" : "campaign";
}

function posterReferenceInstructions(imageIds) {
  const productId = ui.file["poster-product"]?.id;
  return imageIds.map((id, index) => id === productId
    ? `参考图 ${index + 1} 是唯一的商品外观依据。保持轮廓、结构、部件位置、比例、材质、颜色、包装与已有标识；不要根据文字猜测看不见的部件。`
    : `参考图 ${index + 1} 只用于配色、灯光、构图或环境，不能替换主商品，也不复制其中的商品、标识或文字。`);
}

function posterFullImagePrompt(format, imageIds, prompt) {
  return [
    `直接生成一张完整的${format.name}，画幅 ${format.ratio}，目标 ${format.width}×${format.height} 像素。`,
    ...posterReferenceInstructions(imageIds),
    `按以下提示词完成画面及文字排版：\n${prompt}`,
    `按此尺寸独立构图，保留主体和指定文案的安全边距。未指定构图时可参考：${format.scene}。`,
    "准确呈现明确指定的画面文字。未要求呈现的文字、参数、价格和活动信息留空。"
  ].join("\n");
}

function posterImagePrompt(format, poster, imageIds, description, shot) {
  const hasCopy = [poster.title, poster.subtitle, poster.date].some(value => value?.trim()) || ui.file.logo || ui.file.qr;
  const layout = shot === "studio"
    ? "保持商品完整和安全边距。按画幅调整陈列与构图，优先使用参考图确实提供的商品角度。"
    : `本尺寸独立设计：${format.scene}。${hasCopy ? `在${posterCopyArea[format.layout]}留出干净连贯、对比足够的文案区，商品和高光不要占用该区域。` : "保持安全边距。"}同系列保持主体与配色一致，按尺寸改变构图和景别，不能把一张图简单裁成多个尺寸。`;
  return [
    `制作一张可直接用作${format.name}的商业图，画幅 ${format.ratio}，目标 ${format.width}×${format.height} 像素。`,
    `用户需求（用于确定主体和场景，文案稍后排版）：${description || "突出参考图中的商品"}`,
    ...posterReferenceInstructions(imageIds), layout,
    "产品应有可靠的接触面，光向和投影一致，透视合理，边缘自然。不要新增任何营销文字、Logo、水印或二维码；商品原有标识除外。不得擅自添加价格、性能、规格、认证、销量或活动承诺。"
  ].join("\n");
}

function selectedPosterFormats() {
  const selected = state.poster.exports;
  return posterFormats.filter(format => selected.includes(format.id));
}

function posterVisual(format) {
  const identifier = state.poster.visuals?.[format.id] || (format.id === "main" ? state.poster.visual : "");
  return ui.files.find(file => file.id === identifier);
}

function posterReferences() {
  return [...new Set(posterReferenceTargets.map(target => ui.file[target]?.id).filter(Boolean))];
}

function posterOptimizationContext(poster = state.poster) {
  return {assetIds: posterReferences(), productId: ui.file["poster-product"]?.id || null,
    posterShot: posterPresetFor(poster, selectedPosterFormats()[0])};
}

function posterPreviewSource() {
  return posterReferenceTargets.find(target => ui.file[target]?.url);
}

function posterRenderOptions(format, visual) {
  const poster = state.poster;
  const options = {width: format.width, height: format.height, photo: uploadDescriptor(visual), fitted: true};
  if (visual.posterPromptOnly || assetGenerationJob(visual.id)?.context?.posterPromptOnly) {
    return {...options, promptOnly: true};
  }
  const cleanProduct = posterPresetFor(poster, format) === "studio";
  return {...options, layout: poster.visuals?.[format.id] ? format.layout : "bottom",
    title: cleanProduct ? "" : poster.title, subtitle: cleanProduct ? "" : poster.subtitle,
    date: cleanProduct ? "" : poster.date, logo: cleanProduct ? "" : ui.file.logo?.url,
    qr: cleanProduct ? "" : ui.file.qr?.url};
}

function posterSourceArtwork(source) {
  if (source) return `<div class="poster-source-card">${uploadArtwork(ui.file[source], "poster-source:" + source, true, "poster-source-preview")}
    <p class="meta">${source === "poster-product" ? "产品主图" : "风格参考"} · ${esc(ui.file[source].name)}</p></div>`;
  return `<div class="poster-await"><div class="poster-empty-copy"><strong>从文字或图片开始</strong>
      <p>描述你想做的海报，也可以添加产品图作为参考。</p>
      ${button("添加产品图", "file", "poster-product", "secondary")}</div></div>`;
}

function posterFilename() {
  return (state.poster.title?.trim() || "海报").replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/, "") || "海报";
}

function posterOutput(format, visual = posterVisual(format)) {
  if (!visual) return null;
  const options = posterRenderOptions(format, visual);
  const title = options.promptOnly ? "海报" : state.poster.title || "海报";
  return {name: `${title} · ${format.name}`,
    filename: `${options.promptOnly ? "海报" : posterFilename()}-${format.name}-${format.width}x${format.height}.png`,
    render: () => workspaceRaster.poster(options)};
}

function posterArtwork(format) {
  const visual = posterVisual(format);
  if (!visual) return "";
  const descriptor = posterOutput(format, visual);
  const options = posterRenderOptions(format, visual);
  const scale = Math.min(1, 600 / Math.max(format.width, format.height));
  options.width = Math.round(format.width * scale);
  options.height = Math.round(format.height * scale);
  const key = "poster:" + format.id;
  const html = rasterImage(key, JSON.stringify(options), descriptor.name, () => workspaceRaster.poster(options), true);
  mediaItems.set(key, descriptor);
  return html;
}

function posterGallery(formats) {
  return formats.map(format => {
    const asset = posterVisual(format);
    const job = posterFormatJob(format.id, asset?.id);
    return `<article class="poster-result" id="poster-result-${format.id}" data-poster-result="${format.id}">
    <div class="poster-result-image output-job-frame">
      ${asset ? `<span class="meta poster-preview-pending" role="status">正在准备预览…</span><div data-poster-art="${format.id}">${posterArtwork(format)}</div>` : ""}
      <div class="output-job-slot${asset ? "" : " is-placeholder"}" data-poster-job="${format.id}" data-asset="${esc(asset?.id || "")}">${outputJobStatus(job, asset?.id)}</div>
    </div>
    <div class="poster-result-info"><strong>${format.name}</strong><span class="meta">${format.width} × ${format.height} px</span></div>
    <div class="row">${asset ? button("下载", "poster-download", format.id, "secondary", `aria-label="下载${format.name}"`) +
      button("编辑", "poster-edit", format.id, "ghost", `aria-label="编辑${format.name}"`) : ""}
      <span data-poster-job-error="${format.id}" data-asset="${esc(asset?.id || "")}">${jobErrorLink(job)}</span></div>
  </article>`;
  }).join("");
}

function posterStageJobStatus(job) {
  return job && job.status !== "succeeded" ? `${jobProgress(job)}${jobErrorLink(job)}${jobPreview(job)}` : "";
}

function selectPosterFormat(id) {
  state.poster.selected = id;
  if (posterVisual(posterFormats.find(format => format.id === id) || posterFormats[0])) state.poster.previewTab = "results";
  save();
  render();
  content.querySelector(`[data-poster-result="${CSS.escape(id)}"]`)?.scrollIntoView({block: "nearest", inline: "nearest"});
}

function posterUpload(target, label, hint = "上传、拖入或粘贴") {
  const files = target === "poster-reference" ? posterReferenceSlots : [target];
  const attached = files.filter(slot => ui.file[slot]);
  const action = attached.length && files.length === 1 ? "更换" : "添加";
  return `<div class="upload-zone" tabindex="0" aria-label="${label}" data-drop-target="${target}"><div class="upload-head"><strong>${label}${files.length > 1 ? ` <small class="meta">${attached.length}/${files.length}</small>` : ""}</strong>
    ${button(action, "file", target, "secondary",
      `aria-label="${action}${label}" ${files.length > 1 && attached.length === files.length ? "disabled" : ""}`)}</div>
    ${attached.length ? `<div class="upload-list">${attached.map(slot => {
      const file = ui.file[slot];
      return `<div class="upload-item">${uploadArtwork(file, "upload:" + slot, true, "upload-thumb")}<span title="${esc(file.name)}">${esc(file.name)}</span>
        ${button("移除", "detach-file", slot, "ghost", `aria-label="移除 ${esc(file.name)}"`)}</div>`;
    }).join("")}</div>` : `<p class="meta">${hint}</p>`}</div>`;
}

function posterAdvisorView(poster) {
  const turns = Array.isArray(poster.discussion) ? poster.discussion : [];
  const brief = poster.proposal;
  const busy = pending.has("poster-advisor");
  const history = poster.advisorHistory || [];
  return `<div class="stack">
    <div class="row-between poster-chat-header"><h2>海报对话</h2>
      ${button("＋ 新对话", "poster-new-chat", "", "secondary", busy ? "disabled" : "")}</div>
    ${history.length ? `<label class="field">切换历史对话<select class="input" data-field="poster-chat-history" ${busy ? "disabled" : ""}>
      <option value="">当前对话</option>${history.map((item, index) => `<option value="${index}">${esc(item.discussion?.[0]?.question.slice(0, 35) || "海报草稿")}</option>`).join("")}</select></label>` : ""}
    ${modelSelect("poster-language-model", "chat", "text", poster.languageModel, "语言模型")}
    ${researchModeField("poster-search-mode", poster.searchMode, busy ? "disabled" : "")}
    <div class="poster-discussion" role="log" aria-label="海报需求沟通">
      ${turns.map((turn, index) => `<p><b>你</b>${esc(turn.question)}</p><article><b>AI</b>${pptReplyText(turn.reply)}
        ${turn.webSearch ? workspaceCommercial.searchSources(turn.webSearch, "poster-turn-" + index) : ""}</article>`).join("")}
      ${!busy && !turns.length ? '<p class="meta">告诉 AI 海报用在哪里、要突出什么。</p>' : ""}
      <p data-poster-stream aria-live="off"${busy ? "" : " hidden"}>${esc(ui.posterReply || "正在整理…")}</p>
    </div>
    <label class="field">想做什么海报<textarea class="textarea" data-field="poster-message" data-ai-send="poster-discuss" maxlength="2000" ${busy ? "disabled" : ""}
      placeholder="例如，联网核实这款产品的型号和参数，再做一组宣传图。">${esc(poster.message)}</textarea></label>
    <div class="row">${button("发送给 AI", "poster-discuss", "", "primary", (busy ? "disabled " : "") + aiSendShortcut)}
      ${button("整理设计方案", "poster-plan", "", "secondary", !turns.length || busy ? "disabled" : "")}</div>
    ${brief ? `<section class="poster-proposal stack" data-poster-proposal><h3>海报设计方案</h3>
      ${brief.promptVersion === 2 ? `<label class="field">完整生图提示词
        <textarea class="textarea poster-plan-prompt" data-field="poster-plan-prompt" maxlength="4500" rows="8" ${busy ? "disabled" : ""}>${esc(brief.prompt)}</textarea>
        <span class="meta">可直接改文案和排版。生成时使用这里的提示词与左侧勾选的尺寸。</span></label>` :
      '<p class="meta">请重新整理这份旧方案，生成可直接出图的完整提示词。</p>'}
      ${brief.webSearch ? workspaceCommercial.searchSources(brief.webSearch, "poster-plan") : ""}
    </section>` : ""}
    <p class="meta">AI 沟通按实际 Token 计费。出图前会显示张数和费用。</p></div>`;
}

function switchPosterChat(index = null) {
  if (pending.has("poster-advisor")) return;
  const poster = state.poster;
  const history = [...(poster.advisorHistory || [])];
  const next = index === null ? null : history.splice(index, 1)[0];
  if (index !== null && !next) return;
  if (poster.discussion?.length || poster.message?.trim() || poster.proposal) {
    history.unshift({discussion: poster.discussion || [], message: poster.message || "",
      sessionId: poster.advisorSessionId ||= crypto.randomUUID(),
      proposal: poster.proposal || null});
  }
  poster.advisorHistory = history.slice(0, 8);
  poster.discussion = next?.discussion || [];
  poster.advisorSessionId = next?.sessionId || crypto.randomUUID();
  poster.message = next?.message || "";
  poster.proposal = next?.proposal || null;
  save();
  render();
  content.querySelector('[data-field="poster-message"]')?.focus({preventScroll: true});
}

function activePosterFormats() {
  const documentId = state.poster.documentId;
  return new Set(documentId ? live.allJobs.filter(job => job.scope === "poster" && activeJob(job) &&
    job.context?.documentId === documentId).map(job => job.context.formatId || "main") : []);
}

function posterView() {
  const poster = state.poster;
  const chosen = selectedPosterFormats();
  const format = posterFormats.find(item => item.id === poster.selected) || chosen[0] || posterFormats[0];
  const source = posterPreviewSource();
  const completed = posterFormats.filter(posterVisual);
  const galleryFormats = posterFormats.filter(format => posterVisual(format) || posterFormatJob(format.id));
  const showResults = poster.previewTab === "results" || (poster.previewTab !== "reference" && completed.length > 0);
  const count = new Set(posterReferenceTargets.map(target => ui.file[target]?.id || ui.file[target]?.url).filter(Boolean)).size;
  const advisor = poster.mode === "advisor";
  const canGenerate = !advisor || poster.proposal?.promptVersion === 2;
  const activeFormats = activePosterFormats();
  const submitting = pending.has("poster");
  const job = live.jobs.find(item => item.scope === "poster" && item.context?.documentId === poster.documentId &&
    (item.context?.formatId || "main") === format.id);
  const stageStatus = posterStageJobStatus(job);
  const languageBusy = pending.has("poster-advisor");
  return page("海报工作台", `<div id="poster-project-controls" class="poster-project-controls">${workspaceProjects.posterHistory()}</div>
  <div class="poster-studio"${workspaceProjects.posterSwitching() ? " inert" : ""}>
    <section class="card stack poster-sizes"><div class="row-between"><h2>物料尺寸</h2><span class="meta" data-poster-count>已选 ${chosen.length} 项</span></div>
      <div class="row">${button("全选", "poster-select-all", "yes", "ghost")}${button("清空", "poster-select-all", "", "ghost")}</div>
    <div class="poster-size-list" data-poster-scroll="sizes">${posterFormats.map(item => `<div class="poster-size-row" data-poster-selected="${item.id === format.id}">
        <input type="checkbox" data-field="poster-format" value="${item.id}" aria-label="勾选${item.name}" ${poster.exports.includes(item.id) ? "checked" : ""}>
        <button type="button" data-action="poster-preview" data-value="${item.id}" aria-pressed="${item.id === format.id}">
          <strong>${item.name}</strong><span class="meta">${item.width} × ${item.height} · ${item.ratio}</span>
        </button>${posterVisual(item) ? '<span class="poster-ready" title="已生成" aria-label="已生成"></span>' : ""}
      </div>`).join("")}</div>
    </section>
    <section class="card poster-stage ${showResults ? "is-results" : "is-reference"}">
      <div class="poster-stage-toolbar">
        <div class="row poster-stage-switch" role="group" aria-label="海报预览">
          ${button("参考图", "poster-tab", "reference", showResults ? "ghost" : "secondary", `aria-pressed="${!showResults}"`)}
          ${button(`成品总览 ${completed.length}`, "poster-tab", "results", showResults ? "secondary" : "ghost", `aria-pressed="${showResults}"`)}
        </div>
        ${showResults ? button("打包下载 ZIP", "export-poster", "", "primary", !completed.length || ui.uploading ? "disabled" : "") :
          `<span class="meta">${source === "poster-product" ? "产品主图" : source ? "风格参考" : "可拖入产品图"}</span>`}
      </div>
      ${showResults
        ? (galleryFormats.length ? `<div class="poster-gallery" data-poster-scroll="gallery" tabindex="0" role="region" aria-label="海报生成结果">${posterGallery(galleryFormats)}</div>` :
          '<div class="poster-stage-art poster-results-empty"><div class="poster-empty-copy"><strong>还没有成品</strong><p>勾选尺寸后生成，完成的海报会显示在这里。</p></div></div>')
        : `<div class="poster-stage-art poster-stage-reference" data-drop-target="poster-product">${posterSourceArtwork(source)}</div>`}
      <div class="poster-stage-footer">
        <div><strong>${format.name}</strong><p class="meta">${format.width} × ${format.height} px · ${format.ratio}</p></div>
        <div class="row">${!showResults && source ? button("移除参考图", "detach-file", source, "ghost") : ""}
          ${canGenerate ? button(activeFormats.has(format.id) ? "此尺寸已提交" : posterVisual(format) ? "重新生成此尺寸" : "生成此尺寸", "poster-generate", format.id, "secondary", submitting || activeFormats.has(format.id) || languageBusy ? "disabled" : "") : ""}</div>
        <div class="poster-stage-progress" data-poster-stage-status="${format.id}" data-asset="${esc(posterVisual(format)?.id || "")}"${stageStatus ? "" : " hidden"}>${stageStatus}</div>
      </div>
    </section>
    <aside class="card stack poster-controls">
      <div class="stack poster-control-fields" data-poster-scroll="controls">
      <div class="row poster-modes">${button("按参数制作", "poster-mode", "manual", advisor ? "ghost" : "primary", `aria-pressed="${!advisor}"`)}
        ${button("和 AI 沟通", "poster-mode", "advisor", advisor ? "primary" : "ghost", `aria-pressed="${advisor}"`)}</div>
      <section class="poster-reference-group stack" aria-labelledby="poster-references-title">
        <div class="row-between"><h2 id="poster-references-title">参考素材</h2><span class="meta">${count ? `已添加 ${count} 张` : "选填"}</span></div>
        ${posterUpload("poster-product", "产品主图", "用产品照片保持外观与包装。")}
        ${posterUpload("poster-reference", "风格或场景图", "参考配色、灯光或背景。")}
        <p class="meta">支持上传、拖入或粘贴。${count ? "生成时会用到这些图片。" : "只写文字也能生成。"}</p>
      </section>
      <label class="field">出图方向<select class="input" data-field="poster-preset">
        ${Object.entries(posterPresets).map(([key, preset]) => `<option value="${key}" ${(poster.preset || "auto") === key ? "selected" : ""}>${preset.name}</option>`).join("")}
      </select><span class="meta" data-poster-preset-note>${(posterPresets[poster.preset] || posterPresets.auto).note}</span></label>
      ${advisor ? posterAdvisorView(poster) : `${imagePromptFields(poster, poster.promptOnly ? "完整生图提示词" : "画面描述", poster.promptOnly ? "描述画面、要显示的文字和排版" : "描述主体、场景和风格", "poster-prompt")}
        <label class="commercial-check"><input type="checkbox" data-field="poster-prompt-only" ${poster.promptOnly ? "checked" : ""}>以完整提示词出图</label>
        ${poster.promptOnly ? '<p class="meta">图中文字和排版以提示词为准。</p>' : `<div class="poster-copy-fields">
          <label class="field">活动标题（选填）<input class="input" data-field="poster-title" maxlength="30" value="${esc(poster.title)}"></label>
          <label class="field">活动副标题（选填）<input class="input" data-field="poster-subtitle" maxlength="40" value="${esc(poster.subtitle)}"></label>
          <label class="field">活动时间（选填）<input class="input" data-field="poster-date" maxlength="32" value="${esc(poster.date)}" placeholder="例如 4 月 20 日 14:00"></label>
        </div>
        <div class="poster-marks">${posterUpload("logo", "品牌标志")}${posterUpload("qr", "二维码")}</div>`}`}
      </div>
      <div class="stack poster-output">
        ${canGenerate ? modelSelect("poster-model", "image", count > 1 ? "multiReference" : count ? "reference" : "generate", poster.model) : '<p class="meta">整理设计方案后，可在这里确认费用并生成。</p>'}
        ${scopeStatus("poster")}
        ${canGenerate ? button(advisor ? "确认费用并生成" : "生成所选尺寸", "poster-generate", "", "primary", !chosen.some(format => !activeFormats.has(format.id)) || submitting || languageBusy ? "disabled" : "") : ""}
        <div class="row">${button("保存所选到素材", "save-poster", "", "ghost", chosen.some(posterVisual) && !ui.uploading ? "" : "disabled")}</div>
      </div>
    </aside>
  </div>`, "poster-editor");
}

function updatePosterPreview() {
  for (const preview of content.querySelectorAll("[data-poster-art]")) {
    const format = posterFormats.find(item => item.id === preview.dataset.posterArt);
    if (format) preview.innerHTML = posterArtwork(format);
  }
}

function createPosterVisual(id) {
  if (ui.uploading) return notify("正在添加素材，请稍等。");
  const selected = id ? posterFormats.filter(item => item.id === id) : selectedPosterFormats();
  if (!selected.length) return notify("请先勾选海报尺寸。");
  if (!requireAccount(() => createPosterVisual(id))) return;
  const active = activePosterFormats();
  const formats = selected.filter(format => !active.has(format.id));
  if (!formats.length) return notify("所选尺寸已提交，可在「生成任务」查看进度。");
  const poster = state.poster;
  const advisor = poster.mode === "advisor";
  if (advisor && poster.proposal?.promptVersion !== 2) return notify("请先整理设计方案。");
  const promptOnly = advisor || poster.promptOnly;
  const imageIds = posterReferences();
  const title = poster.title?.trim();
  const description = advisor ? poster.proposal.prompt?.trim() : poster.prompt?.trim() || (promptOnly ? "" : poster.subtitle?.trim() || title);
  if (advisor && !description) return notify("请填写完整生图提示词。");
  if (!description && !imageIds.length) return notify("请填写画面描述或海报文案，也可以添加参考图。");
  const model = modelFor("image", imageIds.length > 1 ? "multiReference" : imageIds.length ? "reference" : "generate", poster.model).selected;
  if (model && imageIds.length > model.maxReferences) return notify(`当前模型最多接收 ${model.maxReferences} 张参考图。`);
  const inputs = formats.map(format => {
    const input = {label: `海报 · ${format.name}`, size: `${format.width}x${format.height}`, imageIds};
    if (promptOnly) return {...input, context: {formatId: format.id, posterPromptOnly: true},
      prompt: posterFullImagePrompt(format, imageIds, description || "突出参考图中的商品")};
    const shot = posterPresetFor(poster, format);
    return {...input,
      context: {formatId: format.id, posterShot: shot},
      prompt: posterImagePrompt(format, poster, imageIds, description, shot)};
  });
  const skipped = selected.length - formats.length;
  return confirmImages("poster", model, inputs, () => { poster.previewTab = "results"; }, null,
    formats.map(format => format.name).join("、"), skipped ? `${skipped} 个尺寸已在排队或生成，本次不会重复提交。` : "");
}

async function outputPosters(store) {
  if (store && !requireAccount()) return;
  if (ui.uploading) return notify("正在处理素材，请稍等。");
  const formats = (store ? selectedPosterFormats() : posterFormats).filter(posterVisual);
  if (!formats.length) return notify(store ? "请选择已生成的海报尺寸。" : "还没有可下载的成品。");
  const poster = state.poster;
  const owner = identity;
  const title = posterFilename();
  const outputs = formats.map(format => {
    const visual = posterVisual(format);
    return {parent: visual.id, descriptor: posterOutput(format, visual)};
  });
  ui.uploading = true;
  let done = 0;
  try {
    if (!store) {
      const entries = [];
      for (const {descriptor} of outputs) {
        const blob = await workspaceMedia.getBlob(descriptor);
        if (owner !== identity || poster !== state.poster) return;
        entries.push({name: descriptor.filename, blob});
      }
      const zip = await workspaceRaster.zip(entries);
      if (owner !== identity || poster !== state.poster) return;
      await workspaceMedia.download({filename: `${title}-全部尺寸.zip`, render: () => zip});
      if (owner === identity) notify(`已打包 ${entries.length} 张海报。`);
      return;
    }
    for (const {parent, descriptor} of outputs) {
      if (owner !== identity || poster !== state.poster) return;
      const blob = await workspaceMedia.getBlob(descriptor);
      if (owner !== identity || poster !== state.poster) return;
      const item = await storeFile(new File([blob], descriptor.filename, {type: "image/png"}), owner, true, "poster", parent);
      if (!item || owner !== identity || poster !== state.poster) return;
      poster.savedAssets = [...new Set([...(poster.savedAssets || []), item.id])];
      save();
      done++;
    }
  } finally {
    if (owner === identity) ui.uploading = false;
  }
  notify(`已保存 ${done} 张海报。`);
}

async function posterAdvisor(plan = false) {
  if (!requireAccount() || pending.has("poster-advisor")) return;
  const poster = state.poster;
  const model = modelFor("chat", "text", poster.languageModel).selected;
  const message = (poster.message || "").trim();
  if (!model) return notify("请先在后台设置上架语言模型。");
  if (!plan && !message) return notify("请先输入要沟通的需求。");
  const discussion = poster.discussion || [];
  const searchMode = poster.searchMode || "auto";
  const owner = identity;
  const request = {modelId: model.id, tokenRates: model.tokenRates, requestId: crypto.randomUUID(),
    sessionId: poster.advisorSessionId ||= crypto.randomUUID(),
    webSearch: searchMode === "auto" ? undefined : searchMode === "always",
    history: discussion.map(({question, reply}) => ({question, reply})),
    mode: plan ? "plan" : "discuss", message,
    prompt: [
      `出图方向：${(posterPresets[poster.preset] || posterPresets.auto).name}。`,
      "产品主图用于还原外观；场景图只用于风格。构图随尺寸变化。卖点、参数、价格无来源时先询问，不补写。"
    ].filter(Boolean).join("\n"),
    ...posterOptimizationContext({preset: poster.preset}), formats: selectedPosterFormats().map(format => format.id),
    catalog: posterFormats.map(format => ({id: format.id, label: format.name, size: `${format.width}×${format.height}`}))};
  save(); // Persist the session ID before a request can fail or the page can reload.
  pending.set("poster-advisor", true);
  ui.posterReply = "";
  if (ui.route === "poster") render();
  const showProgress = text => {
    const target = ui.route === "poster" && content.querySelector("[data-poster-stream]");
    if (target) {
      const log = target.parentElement;
      const follow = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
      target.textContent = text;
      if (follow) log.scrollTop = log.scrollHeight;
    }
  };
  const reveal = plan ? null : workspaceCommercial.revealText(text => {
    if (owner !== identity || poster !== state.poster) return;
    ui.posterReply = text;
    showProgress(text);
  });
  let raw = "";
  let planReady = false;
  try {
    const result = await streamLanguage("poster/advisor", request, delta => {
      if (owner !== identity || poster !== state.poster || plan) return;
      raw = (raw + delta).slice(0, 32000);
      reveal.set(raw);
    }, event => {
      if (owner !== identity || poster !== state.poster || ui.route !== "poster") return;
      if (event.type === "started" && event.research) showProgress("正在查找公开资料…");
      if (event.type === "memory") showProgress(event.state === "compacting" ? "正在整理较早对话，保留关键决定和纠正…" : "已载入会话摘要，继续回复…");
      if (event.type === "web-search") showProgress(event.result.sources.length ?
        "已获取联网来源，正在整理…" : "未取得可用联网资料，正在整理已有信息…");
    });
    if (reveal) await reveal.drain();
    if (owner !== identity || poster !== state.poster || !result) return;
    const sources = compactSearchResult(result.webSearch);
    if (plan) {
      poster.proposal = {...result.advice, webSearch: sources};
      const suggested = poster.proposal.formats || [];
      if (!poster.exports.length && suggested.length) {
        poster.exports = suggested;
        poster.selected = suggested[0];
      }
      planReady = poster.proposal.promptVersion === 2;
    }
    else {
      poster.discussion = [...discussion, {question: message, reply: result.advice, webSearch: sources}];
      poster.message = "";
      delete poster.proposal;
    }
    save();
  } finally {
    reveal?.flush();
    if (owner === identity) {
      pending.delete("poster-advisor");
      ui.posterReply = "";
      if (ui.route === "poster") {
        render();
        const log = content.querySelector(".poster-discussion");
        if (log) log.scrollTop = log.scrollHeight;
        if (planReady && poster === state.poster && poster.mode === "advisor") {
          content.querySelector("[data-poster-proposal]")?.scrollIntoView({block: "nearest"});
        }
      }
    }
  }
}
