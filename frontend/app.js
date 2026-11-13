"use strict";

const crops = {
  hero: [839, 483, "茶叶商品、活动海报和项目汇报作品"],
  homePhoto: [348, 418, "山野乌龙商品摄影"],
  homePoster: [282, 231, "春日茶会活动海报"],
  homePpt: [278, 155, "项目工作汇报封面"],
  activity: [352, 119, "户外茶会宣传场景"],
  product: [332, 122, "山野乌龙商品图"],
  cover: [330, 121, "茶与书的内容封面"],
  studioCover: [283, 121, "茶与书的内容封面"],
  studioActivity: [307, 119, "户外茶会宣传场景"],
  presentation: [333, 122, "商务汇报封面"],
  text: [476, 226, "山林间的商品图"],
  image: [464, 226, "由草图到商品照"],
  reference: [471, 226, "同一商品的两张参考结果"],
  mask: [476, 220, "圈选茶杯后局部修改"],
  background: [464, 220, "换背景前后对照"],
  cutout: [471, 220, "商品抠图示例"],
  original: [476, 226, "山野乌龙商品原图"],
  result: [229, 219, "浅色背景的商品候选"],
  result2: [228, 219, "深色木台上的商品候选"],
  posterPhoto: [421, 382, "茶叶与茶盏的宣传主视觉"]
};

const tools = [
  { id: "text", name: "AI 生图", category: "生成", art: "text", hint: "用文字描述画面，也可以添加参考图" },
  { id: "mask", name: "圈选修改", category: "编辑", art: "mask", hint: "标出要改的区域" },
  { id: "edit", name: "整图修改", category: "编辑", art: "image", hint: "根据描述修改已上传的整张图" },
  { id: "background", name: "换背景", category: "编辑", art: "background", hint: "保留主体，换一个场景" },
  { id: "cutout", name: "抠图", category: "处理", art: "cutout", hint: "提取前景主体" },
  { id: "expand", name: "扩图", category: "编辑", art: "reference", hint: "扩展原来的画面边界" },
  { id: "upscale", name: "超分", category: "处理", art: "product", hint: "查看放大和清晰度处理流程" },
  { id: "extract", name: "图片文字提取", category: "处理", art: "posterPhoto", hint: "识别并校对图上的文字" },
  { id: "crop", name: "裁剪缩放", category: "处理", art: "cover", hint: "调整输出比例" }
];

const scenarios = [
  { title: "活动宣传", note: "主海报、方图和横幅", route: "poster", art: "activity" },
  { title: "商品主图", note: "保留商品，替换背景", tool: "background", art: "product" },
  { title: "内容封面", note: "从标题与参考图开始", tool: "text", art: "cover" },
  { title: "汇报 PPT", note: "先确认分镜，再逐页出稿", route: "ppt", art: "presentation" }
];

const imageExamples = [
  ["商品摄影", "homePhoto", "山野乌龙茶罐，暖色自然侧光，放在苔藓石面上，背景是虚化的茶山，保留包装上的中文品名。"],
  ["内容封面", "studioCover", "窗边木桌上的茶杯和翻开的书，午后柔光，暖调纪实摄影，右侧留白用于标题。"],
  ["活动主视觉", "studioActivity", "春日户外茶会，浅紫色花束、木桌和米白桌布，柔和日光，画面中央留白，无文字。"]
];

const routeLabels = { home: "工作台首页", tools: "全部工具", scenes: "模板与案例", image: "AI 生图", "image-edit": "图片编辑", poster: "海报工作台", ppt: "PPT 工作台", chat: "AI 对话", jobs: "生成任务", projects: "PPT 项目", assets: "我的素材", credits: "积分与明细", admin: "后台设置" };
const workspaceFields = ["image", "poster", "ppt", "assets", "projects", "uploads", "activeProjectId", "standaloneDrafts"];
const imageRatios = ["1:1", "4:3", "3:2", "16:9", "5:4", "7:5", "2:1", "21:9", "3:4", "2:3", "9:16", "4:5", "5:7", "1:2", "9:21"];
const resolutions = { "512 px": 512, "1K": 1024, "1080 px": 1080, "2K": 2048, "3K": 3072, "3840 px": 3840, "4K": 4096 };
const referenceSlots = Array.from({length: 16}, (_, index) => index ? "reference" + (index + 1) : "reference");
const generationReferenceSlots = Array.from({length: 16}, (_, index) => index ? "generation-reference" + (index + 1) : "generation-reference");
const studioAssetDragType = "application/x-fengsha-image-asset";
const pptSlots = Array.from({length: 24}, (_, index) => index ? "ppt" + (index + 1) : "ppt");
const documentExtensions = ["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "tsv", "json", "xml", "html", "log", "rst"];
const imageExtensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const mediaItems = new Map();
const rasterCache = new Map();
const pending = new Map();
const content = document.querySelector("#content");
const balance = document.querySelector("#balance");
const modal = document.querySelector("#modal");
const toast = document.querySelector("#toast");
const fileInput = document.querySelector("#file-input");

function initialState() {
  return {
    points: 0,
    spent: 0,
    ledger: [],
    assets: [],
    projects: [],
    uploads: {},
    activeProjectId: "",
    standaloneDrafts: {},
    image: { tool: "mask", prompt: "", ratio: "1:1", resolution: "source", width: 1024, height: 1024, candidates: [], outputs: {}, adopted: "", selection: null, text: "" },
    poster: { title: "", subtitle: "", date: "", variant: 0, selected: "main", exports: ["main", "square", "wide"] },
    ppt: { brief: "", level: "简报", style: "商务深蓝", stage: 0, maxStage: 0, active: 0, outline: [], boards: [], pages: [], history: {}, textboxes: {},
      discussion: [], discussionDraft: "", sourceWarnings: [], boardHistory: {}, pageEdits: {}, resolution: "1920x1080" }
  };
}

let state = initialState();
let account = null;
let revision = 0;
let identity = 0;
let needsAdmin = false;
let localMail = false;
let writes = Promise.resolve();
let latestWorkspaceSave = writes;
let saveTimer;
let saveDirty = false;
const ui = { route: "home", category: "全部", search: "", imageView: "原图", picked: "", selecting: false, homeMode: "image", homePrompt: "", file: {}, fileTarget: "", authMode: "login", assetType: "全部", assetSearch: "", files: [], users: [], localUrls: new Set(), uploading: false };
let modalAction = null;
let toastTimer;
const publicRoutes = new Set(["home", "tools", "scenes", "image", "image-edit", "poster", "ppt", "chat"]);
const authPaths = {"/login": "login", "/register": "register", "/reset": "reset"};
let authNext = "";
let authContinuation = null;
let authBusy = false;

function isGenerationTool(tool) {
  return ["text", "image", "reference", "batch"].includes(tool);
}

function initializeImageGeneration(image, uploads, files = {}) {
  if (!image.generation) {
    const legacy = isGenerationTool(image.tool);
    image.generation = {tool: legacy ? image.tool : "text", prompt: legacy ? image.prompt : "", ratio: legacy ? image.ratio : "1:1",
      resolution: legacy && image.resolution !== "source" ? image.resolution : "1K", width: legacy ? image.width : 1024, height: legacy ? image.height : 1024,
      model: legacy ? image.model : "", count: image.tool === "batch" ? 3 : 1};
    if (legacy) {
      const previous = ["image", "reference"].includes(image.tool) ? ["image", ...referenceSlots] : referenceSlots;
      const filled = previous.filter(slot => uploads[slot] || files[slot]);
      filled.slice(0, generationReferenceSlots.length).forEach((source, index) => {
        const target = generationReferenceSlots[index];
        if (uploads[source]) uploads[target] = uploads[source];
        if (files[source]) files[target] = files[source];
      });
      Object.assign(image, {tool: "mask", prompt: "", ratio: "1:1", resolution: "source", width: 1024, height: 1024, model: ""});
    }
  }
  const draft = image.generation;
  if (!draft.modeVersion) {
    const hasReferences = generationReferenceSlots.some(slot => uploads[slot] || files[slot]);
    draft.tool = draft.tool === "image" || draft.tool === "reference" || hasReferences ? "image" : "text";
    draft.modeVersion = 1;
  }
  return draft;
}

function imageGeneration() {
  const draft = initializeImageGeneration(state.image, state.uploads, ui.file);
  draft.tool = generationReferenceSlots.some(slot => ui.file[slot]) ? "image" : "text";
  return draft;
}

const studioFormats = {still: "静态图", gif: "GIF 动图", svg: "SVG 矢量图"};
const studioGifSizes = {"512x512": "1:1", "384x576": "2:3", "576x384": "3:2", "640x480": "4:3",
  "480x640": "3:4", "768x432": "16:9", "432x768": "9:16", "512x640": "4:5", "640x512": "5:4", "756x324": "21:9"};
const studioSvgSizes = {"1024x1024": "1:1", "1024x1536": "2:3", "1536x1024": "3:2", "1600x1200": "4:3",
  "1200x1600": "3:4", "1920x1080": "16:9", "1080x1920": "9:16", "1080x1350": "4:5", "1350x1080": "5:4", "2520x1080": "21:9"};
const studioSheetFrames = [4, 6, 8, 9, 12, 16];
const studioGifTiming = {minFrames: 2, maxFrames: 16, minDelay: 20, maxDelay: 2000, step: 10};
const studioFormatExamples = {
  gif: ["一只橙色皮球在米色地面原地弹跳一次，镜头固定。球落回起点，首尾自然衔接。", "白瓷杯静置在深绿桌面上，热气缓慢升起后消散，固定镜头，循环播放。"],
  svg: ["一个几何狐狸头像图标，橙色与米白双色，清晰的封闭轮廓，图形居中，不加文字。", "山野茶品牌标志，用墨绿色与米白呈现两片茶叶和山形，扁平色块，无阴影。"]
};

function studioFormat() {
  return Object.hasOwn(studioFormats, ui.studioFormat) ? ui.studioFormat : "still";
}

function nativeStudioDraft(format = studioFormat()) {
  const generation = imageGeneration();
  generation.formats ??= {};
  const draft = generation.formats[format] ??= {prompt: "", model: "", frames: 9, duration: 200};
  if (!draft.method) draft.method = format === "gif" ? "sheet" : "trace";
  draft.size ??= format === "gif" ? "512x512" : "1024x1024";
  if (draft.method === "native") draft.nativeSize ??= draft.size;
  if (format === "gif" && draft.method === "sheet" && !studioSheetFrames.includes(draft.frames)) draft.frames = 9;
  return draft;
}

function studioSizeChoices(format, draft, model) {
  const presets = format === "gif" ? studioGifSizes : studioSvgSizes;
  const local = draft.method !== "native";
  const choices = Object.keys(presets);
  const sizes = local ? choices : model?.sizes?.length ? model.sizes : choices.slice(0, 3);
  const preferred = local ? draft.size : draft.nativeSize;
  const selected = (local && preferred === "custom") || sizes.includes(preferred) ? preferred : sizes[0];
  return {sizes, presets, selected, local, maxEdge: format === "gif" ? 768 : 4096};
}

function studioSizeText(size) {
  return size.replace("x", " × ");
}

function studioOutputSize(format, draft, model) {
  const {selected, maxEdge} = studioSizeChoices(format, draft, model);
  if (selected !== "custom") return selected;
  const dimensions = [Number(draft.width), Number(draft.height)];
  return dimensions.every(edge => Number.isInteger(edge) && edge >= 64 && edge <= maxEdge)
    ? dimensions.join("x") : "";
}

function nativeStudioCapability(format, count, draft = nativeStudioDraft(format)) {
  const capability = imageCapability(count ? "image" : "text", count);
  return draft.method === "native" ? [format, capability] : capability;
}

function imageDraft() {
  return ui.route === "image-edit" ? state.image : imageGeneration();
}

async function api(path, method = "GET", body) {
  const request = { method };
  if (body instanceof Blob) request.body = body;
  else if (body !== undefined) {
    request.headers = { "Content-Type": "application/json" };
    request.body = JSON.stringify(body);
  }
  const response = await fetch("/api/" + path, request);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "操作暂时无法完成。"), {status: response.status});
  return result;
}
function serializeWorkspace() {
  return Object.fromEntries(workspaceFields.map(key => [key, state[key]]));
}
function queueWrite(operation) {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}
function flushSave(strict = false) {
  clearTimeout(saveTimer);
  if (!saveDirty || !account) return strict ? latestWorkspaceSave : writes;
  saveDirty = false;
  const owner = identity;
  const result = queueWrite(async () => {
    if (owner !== identity) return;
    const result = await api("workspace", "PUT", { revision, workspace: serializeWorkspace() });
    if (owner !== identity) return;
    revision = result.revision;
    await workspaceProjects.sync();
  });
  latestWorkspaceSave = result;
  return strict ? result : result.catch(error => { if (identity === owner) notify(error.message); });
}
function save() {
  if (!account) return;
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 320);
}
function updateWallet(result) {
  state.points = result.points;
  state.ledger = result.ledger;
  if (result.spent !== undefined) state.spent = result.spent;
  updateAccountUsage();
}
async function refreshFiles() {
  const owner = identity;
  if (!account) return;
  const result = await api("assets");
  if (owner !== identity) return;
  ui.files = result.items;
  for (const [target, id] of Object.entries(state.uploads)) {
    const item = ui.files.find(file => file.id === id);
    if (item) ui.file[target] = uploadDescriptor(item);
    else delete ui.file[target];
  }
}
async function applySession(result) {
  identity++;
  latestWorkspaceSave = writes;
  clearTimeout(saveTimer);
  saveDirty = false;
  pending.clear();
  for (const url of ui.localUrls) URL.revokeObjectURL(url);
  ui.localUrls.clear();
  clearRasterCache();
  account = result.user;
  revision = account?.revision || 0;
  needsAdmin = result.needsAdmin;
  localMail = result.localMail;
  live.jobs = [];
  live.allJobs = [];
  live.trash = null;
  live.operations = null;
  stopJobUpdates();
  const defaults = initialState();
  state = { ...defaults, ...(result.workspace || {}), image: { ...defaults.image, ...result.workspace?.image },
    poster: {...defaults.poster, ...result.workspace?.poster}, ppt: {...defaults.ppt, ...result.workspace?.ppt} };
  if (account) updateWallet({points: account.points, ledger: result.ledger, spent: result.spent});
  Object.assign(ui, { file: {}, files: [], users: [], assetType: "全部", assetSearch: "", homePrompt: "", homeMode: "image", guestChatPrompt: "", guestChatTextOnly: false, picked: "", selecting: false, imageView: "原图", uploading: false });
  ui.imageParameters = {};
  ui.imageRecordsLoaded = false;
  ui.editAssetSearch = "";
  ui.editTab = "annotations";
  ui.pptExport = "";
  ui.guestImport = null;
  ui.importingGuest = false;
  ui.workbenchReturns = {};
  try {
    ui.workbenchReturns = JSON.parse(sessionStorage.getItem(workbenchStorageKey()) || "{}");
  } catch {}
  if (workspaceProjects.restoreIndependentDrafts()) save();
  if (account && state.image.homeComposer) {
    ui.homePrompt = state.image.homeComposer.prompt || "";
    ui.homeMode = ["image", "poster", "ppt", "chat"].includes(state.image.homeComposer.mode) ? state.image.homeComposer.mode : "image";
  }
  await Promise.all([refreshFiles(), live.catalog()]);
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
const POINT_SCALE = 1_000_000;
const POINT_STEP = "0.000001";

function points(units) {
  const amount = Math.abs(Number(units || 0));
  const fraction = String(amount % POINT_SCALE).padStart(6, "0").replace(/(\d{2})0+$/, "$1");
  return (units < 0 ? "-" : "") + Math.floor(amount / POINT_SCALE) + "." + fraction;
}

function parsePoints(value) {
  const match = /^(-?)(\d*)(?:\.(\d{1,6}))?$/.exec(String(value).trim());
  if (!match || !(match[2] || match[3])) throw new Error("请输入最多六位小数的积分金额。");
  const units = Number(match[2]) * POINT_SCALE + Number((match[3] || "").padEnd(6, "0"));
  if (!Number.isSafeInteger(units)) throw new Error("积分金额超出范围。");
  return match[1] ? -units : units;
}
function active(value) { return value ? "true" : "false"; }
function go(route) {
  if (route === "account") return openAccount();
  if (route === "admin") {
    if (!account) return openAuth("login", "admin");
    if (account?.role === "admin" && location.pathname !== "/admin") location.assign("/admin");
    return;
  }
  if (!account && !publicRoutes.has(route)) return openAuth("login", route);
  if (location.pathname !== "/") {
    location.assign("/#" + route);
    return;
  }
  if (location.hash === "#" + route) render();
  else location.hash = route;
}
function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}
function available() {
  return state.points;
}
function sampleDescriptor(key, fitRatio, output) {
  const sample = Object.hasOwn(crops, key.split(":")[0]) ? key.split(":")[0] : "text";
  const [width, height, name] = crops[sample];
  const w = fitRatio ? Math.min(width, height * fitRatio) : width;
  const h = fitRatio ? Math.min(height, width / fitRatio) : height;
  return { url: "/frontend/samples/" + sample + ".webp", name, sampleKey: key, filename: name + ".png",
    sourceWidth: width, sourceHeight: height,
    crop: { x: (width - w) * .65, y: (height - h) * .5, width: w, height: h,
      outputWidth: output?.width, outputHeight: output?.height } };
}
function mediaAttrs(key, descriptor, focusable = false) {
  mediaItems.set(key, descriptor);
  return `data-media="${esc(key)}"${focusable ? ' tabindex="0" role="button"' : ""}`;
}
function art(key, fitRatio, media = true, output) {
  const descriptor = sampleDescriptor(key, fitRatio, output);
  const { x, y, width: w, height: h } = descriptor.crop;
  const size = `${descriptor.sourceWidth / w * 100}% ${descriptor.sourceHeight / h * 100}%`;
  const position = `${x ? x / (descriptor.sourceWidth - w) * 100 : 0}% ${y ? y / (descriptor.sourceHeight - h) * 100 : 0}%`;
  return `<div class="art" ${media ? mediaAttrs("sample:" + key, descriptor) : 'role="img"'} aria-label="${descriptor.name}" style="--art-ratio:${w / h};aspect-ratio:${w}/${h};background-image:url('${descriptor.url}');background-size:${size};background-position:${position}"></div>`;
}
function uploadDescriptor(item) {
  return { ...item, url: item.mime.startsWith("image/") ? "/api/assets/" + item.id : "" };
}
function uploadArtwork(file, key, focusable = false, className = "", lazy = false) {
  return `<div class="art uploaded-art ${className}" ${mediaAttrs(key, { url: file.url, name: file.name, file }, focusable)} aria-label="查看 ${esc(file.name)}"><img src="${esc(file.url)}" alt="${esc(file.name)}" draggable="false"${lazy ? ' loading="lazy" decoding="async"' : ""}></div>`;
}
function clearRasterCache() {
  for (const entry of rasterCache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  rasterCache.clear();
}
function rasterImage(id, signature, name, renderer, focusable = false) {
  let entry = rasterCache.get(id);
  if (!entry || entry.signature !== signature) {
    if (entry?.url) URL.revokeObjectURL(entry.url);
    entry = { signature, url: "", blob: renderer() };
    rasterCache.set(id, entry);
    const current = entry;
    entry.blob.then(blob => {
      if (rasterCache.get(id) !== current) return;
      current.url = URL.createObjectURL(blob);
      for (const img of content.querySelectorAll("[data-raster]")) {
        if (img.dataset.raster === id) img.src = current.url;
      }
    }).catch(error => {
      if (rasterCache.get(id) === current && content.querySelector('[data-raster="' + id + '"]')) notify(error.message);
    });
  }
  const attrs = mediaAttrs(id, { name, filename: name + ".png", render: () => entry.blob }, focusable);
  return `<div class="raster-art" ${attrs} aria-label="查看 ${esc(name)}"><img class="raster-image" data-raster="${id}" ${entry.url ? `src="${entry.url}"` : ""} alt="${esc(name)}" draggable="false"></div>`;
}
function button(label, action, value = "", kind = "secondary", extra = "") {
  return `<button type="button" class="btn btn-${kind}" data-action="${action}" data-value="${esc(value)}" ${extra}>${esc(label)}</button>`;
}
function page(title, body, id, sub = "") {
  const links = workbenchLinks();
  return `<section class="section" data-od-id="${id}"><header class="section-head"><h1 tabindex="-1">${title}</h1>${sub || links ? `<div class="row workbench-crumb">${sub ? `<span class="meta">${sub}</span>` : ""}${links}</div>` : ""}</header>${body}</section>`;
}
function workbenchLinks() {
  const from = ui.workbenchReturns?.[ui.route];
  const back = Object.hasOwn(routeLabels, from) ? button("返回" + routeLabels[from], "route", from, "ghost") : "";
  return back + (ui.guestImport ? button("带入登录前的草稿", "import-guest-draft", "", "secondary") : "");
}

function saveHomeComposer() {
  if (!account) return;
  state.image.homeComposer = {prompt: ui.homePrompt, mode: ui.homeMode};
  save();
}
function openModal(title, text, note, label, action) {
  document.querySelector("#modal-title").textContent = title;
  document.querySelector("#modal-text").textContent = text;
  document.querySelector("#modal-note").textContent = note;
  document.querySelector("#modal-confirm").textContent = label;
  modalAction = action;
  modal.showModal();
}
function scenarioCards() {
  return scenarios.map(item => {
    const target = item.tool ? `data-action="open-tool" data-value="${item.tool}"` : `data-action="route" data-value="${item.route}"`;
    return `<button class="card scene" ${target}>${art(item.art, undefined, false)}<span class="scene-label"><b>${item.title} ↗</b><span class="meta">${item.note}</span></span></button>`;
  }).join("");
}
function homeView() {
  const shortcuts = [["AI 生图", "text"], ["圈选修改", "mask"], ["换背景", "background"], ["裁剪缩放", "crop"]];
  const modes = [["AI 生图", "image"], ["海报", "poster"], ["PPT", "ppt"], ["AI 对话", "chat"]];
  const placeholders = {
    image: "描述你想创作的画面，或添加参考图",
    poster: "输入海报主题，例如春日茶集新品试饮",
    ppt: "描述你的汇报主题、受众和目标",
    chat: "问一个问题，或告诉图片 Agent 你想怎么创作"
  };
  const actionLabels = {image: "打开生图工作台", poster: "开始设计海报", ppt: "准备汇报", chat: "进入 AI 对话"};
  const examples = {image: ["商品摄影", imageExamples[0][2]], poster: ["活动海报", "春日茶会新品试饮"], ppt: ["项目进展汇报", "给部门负责人汇报项目阶段进展、当前风险和下月计划。"], chat: ["创意起步", "帮我梳理一个新品宣传图的构图思路。"]};
  const [exampleName, examplePrompt] = examples[ui.homeMode];
  return `<section class="section" data-od-id="home-hero" aria-labelledby="creation-title">
    <div class="creation-content">
      <h1 id="creation-title" tabindex="-1">风沙生图工作台</h1>
      <div class="creation-modes" role="group" aria-label="创作类型">${modes.map(([label, mode]) => button(label, "home-mode", mode, "ghost", `aria-pressed="${active(ui.homeMode === mode)}"`)).join("")}</div>
      <div class="creation-composer" ${ui.homeMode === "image" ? 'data-drop-target="home"' : ""}>
        <textarea class="textarea" aria-label="创作需求" data-field="home" maxlength="12000" placeholder="${placeholders[ui.homeMode]}">${esc(ui.homePrompt)}</textarea>
        ${ui.homeMode === "image" && ui.file.home?.url ? `<div class="home-reference">${uploadArtwork(ui.file.home, "upload:home", true, "upload-thumb")}<span>${esc(ui.file.home.name)}</span>${button("移除参考图", "detach-file", "home", "ghost")}</div>` : ""}
        <div class="row-between creation-actions"><div class="row">${ui.homeMode === "image" ? button("＋ 参考图", "file", "home", "ghost", 'aria-label="添加参考图"') : ""}
          ${button(`试试${exampleName}`, "home-example", examplePrompt, "ghost")}</div>${button(actionLabels[ui.homeMode], "home-create", "", "primary")}</div>
      </div>
    </div>
    ${ui.guestImport ? `<div class="row workbench-crumb">${workbenchLinks()}</div>` : ""}
  </section>
  <section class="section" data-od-id="home-tools">
    <div class="row-between section-head"><h2>常用工具</h2><a class="btn btn-ghost" href="#tools">查看全部工具 →</a></div>
    <div class="row quickbar">${shortcuts.map(([label, id]) => button(label, "open-tool", id)).join("")}</div>
  </section>
  <section class="section" data-od-id="home-scenes">
    <div class="row-between section-head"><h2>按用途创作</h2><a class="btn btn-ghost" href="#scenes">模板与案例 →</a></div>
    <div class="grid-4">${scenarioCards()}</div>
  </section>`;
}
function toolView() {
  const groups = ["全部", "生成", "编辑", "处理"];
  return page("全部工具", `<div class="row-between filters">
    <div class="row" aria-label="工具分类">${groups.map(group => button(group, "category", group, "secondary", `aria-pressed="${active(group === ui.category)}"`)).join("")}</div>
    <input class="input search" type="search" aria-label="搜索工具" placeholder="搜索工具，例如换背景" value="${esc(ui.search)}" data-field="search">
    </div><div class="grid-3" id="tool-grid">${tools.map(tool => `<button class="card tool-card" data-action="open-tool" data-value="${tool.id}" data-category="${tool.category}" data-search="${tool.name} ${tool.hint}">${art(tool.art, undefined, false)}<span class="tool-info"><b>${tool.name}</b><span class="meta">${tool.hint}</span></span></button>`).join("")}</div>
    <p class="empty" id="no-tools" hidden>没有找到匹配的工具。试试其他关键词或分类。</p>`, "tools", "选择一个操作，从示例素材或自己的图片开始。");
}
function filterTools() {
  let count = 0;
  for (const card of content.querySelectorAll("[data-category]")) {
    card.hidden = (ui.category !== "全部" && card.dataset.category !== ui.category) || !card.dataset.search.includes(ui.search.trim());
    if (!card.hidden) count++;
  }
  const empty = content.querySelector("#no-tools");
  if (empty) empty.hidden = count > 0;
}

function imageArtwork(key) {
  const file = imageCandidateFile(key);
  if (file?.url) return uploadArtwork(file, "upload:" + key);
  const output = state.image.outputs[key];
  if (key.startsWith("local:")) return '<div class="art art-placeholder">本地版本已移除</div>';
  return art(key, output && output.width / output.height, true, output);
}
function imageCandidateFile(key) {
  if (ui.file[key]) return ui.file[key];
  const id = key.startsWith("local:") && key.slice(6);
  const asset = id && ui.files.find(item => item.id === id);
  return asset ? uploadDescriptor(asset) : null;
}
function followsEditSource(image) {
  return image === state.image && (image.resolution === "source" ||
    (!image.editSizeChosen && image.resolution === "1K" && image.ratio === "1:1"));
}

function editSourceDimensions() {
  const file = ui.file.image;
  return file?.naturalSize || null;
}

function outputSize(image) {
  if (image === state.image && image.resolution === "suggested") return suggestedEditSize(image);
  if (followsEditSource(image)) {
    const {width, height} = editSourceDimensions() || {};
    if (!width || !height) return null;
    const scale = Math.min(1, 4096 / Math.max(width, height));
    const fitted = {width: Math.round(width * scale), height: Math.round(height * scale)};
    return Math.min(fitted.width, fitted.height) >= 64 ? fitted : null;
  }
  if (image.resolution === "custom") {
    const width = Number(image.width);
    const height = Number(image.height);
    return [width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 4096) ? { width, height } : null;
  }
  const [x, y] = (imageRatios.includes(image.ratio) ? image.ratio : "1:1").split(":").map(Number);
  const limit = resolutions[image.resolution] || resolutions["1K"];
  const scale = limit / Math.max(x, y);
  return { width: Math.round(x * scale), height: Math.round(y * scale) };
}
function outputSummary(image) {
  const size = outputSize(image);
  if (size) return `输出 ${size.width} × ${size.height} px`;
  if (image === state.image && !editSourceDimensions() && (followsEditSource(image) || image.resolution === "suggested")) return "载入原图后读取尺寸";
  return "宽高各需为 64–4096 的整数，可手动设置";
}
function outputControls(image, modelSizes = []) {
  const ratios = imageRatios.map(ratio => {
    const [x, y] = ratio.split(":").map(Number);
    const scale = 16 / Math.max(x, y);
    return `<button class="ratio-choice" type="button" data-action="image-ratio" data-value="${ratio}" aria-pressed="${active(!followsEditSource(image) && Object.hasOwn(resolutions, image.resolution) && image.ratio === ratio)}"><span class="ratio-glyph" aria-hidden="true" style="width:${Math.round(x * scale)}px;height:${Math.round(y * scale)}px"></span>${ratio}</button>`;
  }).join("");
  return `<div class="field output-field"><div class="field-label" id="ratios-label">画面比例</div><div class="ratio-options" role="group" aria-labelledby="ratios-label">${ratios}</div>
    <label for="image-resolution">输出尺寸</label><select class="input" id="image-resolution" data-field="image-resolution">${image === state.image ? `<option value="source" ${followsEditSource(image) ? "selected" : ""}>跟随原图</option>${editToolHelp[image.tool]?.size ? `<option value="suggested" ${image.resolution === "suggested" ? "selected" : ""}>${editToolHelp[image.tool].size}</option>` : ""}` : ""}${Object.keys(resolutions).map(value => `<option ${!followsEditSource(image) && image.resolution === value ? "selected" : ""}>${value}</option>`).join("")}<option value="custom" ${image.resolution === "custom" ? "selected" : ""}>自定义像素</option></select>
    ${image.resolution === "custom" ? `<div class="dimension-grid">${["width", "height"].map((field, index) => `<label class="field">${index ? "高（px）" : "宽（px）"}<input class="input" type="number" inputmode="numeric" min="64" max="4096" step="1" data-field="image-${field}" value="${esc(image[field])}"></label>`).join("")}</div>` : ""}
    ${modelSizes.length ? `<label for="image-known-size">模型的兼容尺寸</label><select class="input" id="image-known-size" data-field="image-known-size"><option value="">保持当前尺寸</option>${modelSizes.map(size => `<option value="${esc(size)}">${esc(size.replace("x", " × "))}</option>`).join("")}</select>` : ""}
    <p class="meta output-summary" id="output-summary" aria-live="polite">${outputSummary(image)}</p></div>`;
}

function imageParameterPanel(draft, operation, modelSizes, count) {
  const open = ui.imageParameters?.[operation];
  let description = `${draft.resolution} · ${draft.ratio}`;
  if (followsEditSource(draft)) description = "跟随原图";
  if (draft.resolution === "custom") description = "自定义尺寸";
  if (draft === state.image && draft.resolution === "suggested") description = editToolHelp[draft.tool]?.size || "建议尺寸";
  const quantity = count ? ` · ${count} 张` : "";
  return `<details class="studio-parameters" data-image-parameters="${operation}"${open ? " open" : ""}>
    <summary><span><strong>输出参数</strong><small><span data-size-summary>${esc(outputSummary(draft))}</span>${quantity}</small></span><span class="studio-parameter-value">${esc(description)}</span></summary>
    <div class="studio-parameter-fields">${outputControls(draft, modelSizes)}
      ${count ? `<div class="field"><span id="image-count-label">生成数量</span><div class="studio-quantity" role="group" aria-labelledby="image-count-label">${[1, 2, 3, 4].map(quantity => button(String(quantity), "image-quantity", quantity, "secondary", `aria-label="${quantity} 张" aria-pressed="${active(quantity === count)}"`)).join("")}</div></div>` : ""}
    </div>
  </details>`;
}

function imagePromptFields(draft, label, placeholder, field = "image-prompt") {
  return `<div class="field studio-prompt">
    <div class="row-between studio-prompt-top"><label for="image-prompt">${label}</label><div class="row">${button("优化规则", "prompt-rules", "", "ghost")}${button("放大编辑", "expand-prompt", "", "ghost")}</div></div>
    <textarea id="image-prompt" class="textarea" maxlength="${field === "poster-prompt" ? 2000 : 3000}" data-field="${field}" placeholder="${placeholder}">${esc(draft.prompt || "")}</textarea>
    <div class="row studio-prompt-actions">${button("一键优化", "optimize-prompt", "quick")}${button("带要求优化", "optimize-prompt", "directed", "ghost")}</div>
  </div>`;
}

function uploadZone(target, title, slots, helper, limit = slots.length) {
  const files = slots.filter(slot => ui.file[slot]?.url);
  const multiple = ["reference", "generation-reference"].includes(target) || slots.length > 1;
  const label = multiple ? "添加参考图" : files.length ? "更换原图" : "上传原图";
  return `<div class="upload-zone" tabindex="0" data-drop-target="${target}" aria-label="${title}，支持粘贴或拖入">
    <div class="upload-head"><strong>${title}${multiple ? ` <small class="meta">${files.length}/${limit}</small>` : ""}</strong>${button(label, "file", target, "secondary", ui.uploading || (multiple && files.length >= limit) ? "disabled" : "")}</div>
    ${files.length ? `<div class="upload-list">${files.map(slot => `<div class="upload-item">${uploadArtwork(ui.file[slot], "upload:" + slot, true, "upload-thumb")}<span title="${esc(ui.file[slot].name)}">${esc(ui.file[slot].name)}</span>${button(target === "generation-reference" ? "×" : "移除", "detach-file", slot, "ghost", `aria-label="移除 ${esc(ui.file[slot].name)}"`)}</div>`).join("")}</div>` : ""}
    <p class="meta">${helper}</p></div>`;
}

function imageJobOperation(job) {
  return job.context?.operation || (["文生图", "图生图", "参考图同款", "批量出图", "图片生成"].includes(job.label) ? "generate" : "edit");
}

function generationGallery() {
  const format = studioFormat();
  const jobs = live.jobs.filter(job => job.scope === "image" && imageJobOperation(job) === "generate" &&
    (job.context?.outputFormat || "still") === format);
  if (account && !ui.imageRecordsLoaded && !jobs.length) return '<div class="studio-empty"><p class="meta" role="status">正在读取生成记录…</p></div>';
  if (!jobs.length && format !== "still") return `<div class="studio-empty studio-native-empty"><strong>还没有${studioFormats[format]}作品</strong><p class="meta">可以从上方示例开始，成品会在这里显示。</p></div>`;
  if (!jobs.length) return `<div class="studio-inspiration">
    <div class="row-between"><h3>从示例开始</h3><a class="btn btn-ghost" href="#tools">全部图片工具</a></div>
    <div class="studio-example-grid">${imageExamples.map(([name, artwork], index) =>
      `<button class="studio-example" type="button" data-action="studio-example" data-value="${index}">
        ${art(artwork, undefined, false)}<span><b>${esc(name)}</b><small>使用示例提示词</small></span></button>`).join("")}</div>
  </div>`;
  const files = new Map(ui.files.map(file => [file.id, file]));
  return `<div class="studio-results">${jobs.map(job => {
    const asset = files.get(job.assetId);
    const stamp = job.created ? new Date(job.created * 1000).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }) : "";
    const dimensions = job.width && job.height ? `${job.width} × ${job.height} px` : "";
    const method = {sheet: "分镜合成", trace: "矢量描摹", native: "模型原生"}[job.context?.outputMethod];
    const details = [method, job.modelName, format === "gif" && dimensions ? `成品 ${dimensions}` : dimensions, stamp].filter(Boolean).join(" · ");
    return `<article class="studio-result">
      <div class="row-between studio-result-head"><h3>${esc(job.label)}</h3><span class="meta">${esc(details)} ${asset ? jobElapsed(job) : ""}</span></div>
      ${asset ? `<div class="studio-result-image">${uploadArtwork(uploadDescriptor(asset), "generation:" + asset.id, true, asset.mime === "image/svg+xml" ? "studio-vector-preview" : "", true)}</div>
        <div class="row studio-result-actions">${format === "gif" ? button("加入拼接", "add-animation-asset", asset.id) : ""}${asset.mime === "image/svg+xml" ? "" : button("圈选修改", "use-upload", asset.id) + button("用作海报产品图", "use-poster-product", asset.id, "ghost") + button("设为参考图", "reference-file", asset.id, "ghost")}<a class="btn btn-ghost" href="/api/assets/${esc(asset.id)}/download">下载${format === "still" ? "" : " " + format.toUpperCase()}</a>${asset.jobId ? button("提示词", "asset-detail", asset.id, "ghost") : ""}</div>`
        : `<div class="studio-result-status">${jobProgress(job)}${jobPreview(job)}${job.error ? `<p class="meta">${esc(job.error)}</p>` : job.status === "succeeded" ? '<p class="meta">图片已移入回收站或暂不可用。</p>' : ""}${job.status === "queued" ? button("取消任务", "cancel-live-job", job.id, "ghost") : ""}</div>`}
      <div class="row studio-result-actions">${jobErrorLink(job) || (format === "gif" ? button("任务详情", "job-detail", job.id, "ghost") : "")}${button("删除记录", "delete-live-job", job.id, "ghost")}</div>
    </article>`;
  }).join("")}</div>`;
}

function updateGenerationGallery() {
  const gallery = content.querySelector("[data-generation-gallery]");
  if (gallery) {
    gallery.innerHTML = generationGallery();
    updateStudioAssets();
  }
}

function studioAssetList() {
  return ui.files.filter(file => file.mime.startsWith("image/") && file.mime !== "image/svg+xml");
}

function studioAssets(files = studioAssetList()) {
  return `<section class="studio-asset-shelf" aria-label="图片素材库">
    <div class="studio-asset-heading row-between">
      <div><h2>素材库</h2><p class="meta">点击预览，拖到左侧作为参考图</p></div>
      <div class="row"><span class="meta">${files.length} 张</span>
        ${button("‹", "scroll-studio-assets", "-1", "secondary", 'aria-label="查看前面的素材" disabled')}
        ${button("›", "scroll-studio-assets", "1", "secondary", 'aria-label="查看更多素材" disabled')}
      </div>
    </div>
    ${files.length ? `<div class="studio-asset-rail" data-studio-asset-rail tabindex="0" aria-label="左右滚动浏览图片素材">
      ${files.map(file => `<article class="studio-asset" data-studio-asset="${esc(file.id)}" draggable="true">
        ${uploadArtwork(uploadDescriptor(file), "studio-asset:" + file.id, true, "", true)}
        <div class="studio-asset-caption"><span title="${esc(file.name)}">${esc(file.name)}</span>
          ${button("+", "reference-file", file.id, "ghost", `aria-label="添加 ${esc(file.name)} 为参考图"`)}</div>
      </article>`).join("")}</div>`
      : `<p class="studio-asset-empty meta">${account ? '上传或生成的图片会显示在这里。<a href="#assets">管理素材</a>' : "登录后查看个人图片素材。"}</p>`}
    </section>`;
}

function syncStudioAssetArrows() {
  const rail = content.querySelector("[data-studio-asset-rail]");
  if (!rail) return;
  const shelf = rail.closest(".studio-asset-shelf");
  shelf.querySelector('[data-value="-1"]').disabled = rail.scrollLeft < 2;
  shelf.querySelector('[data-value="1"]').disabled = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 2;
}

function updateStudioAssets() {
  window.AnimationComposer?.refreshAssets(content);
  const panel = content.querySelector("[data-studio-assets]");
  if (!panel) return;
  const files = studioAssetList();
  const signature = files.map(file => file.id).join(",");
  if (panel.dataset.studioAssets === signature) return;
  const scroll = panel.querySelector("[data-studio-asset-rail]")?.scrollLeft || 0;
  panel.innerHTML = studioAssets(files);
  panel.dataset.studioAssets = signature;
  workspaceMedia.setItems(mediaItems);
  const rail = panel.querySelector("[data-studio-asset-rail]");
  if (rail) rail.scrollLeft = scroll;
  syncStudioAssetArrows();
}

function generationView() {
  const format = studioFormat();
  const draft = imageGeneration();
  const count = [1, 2, 3, 4].includes(draft.count) ? draft.count : 1;
  const refs = imageInputs(draft.tool);
  const capability = imageCapability(draft.tool, refs.length);
  const model = modelFor("image", capability, draft.model).selected;
  const referenceHint = refs.length ? "生成时会使用这些参考图。可拖入、上传或粘贴。"
    : "可拖入、上传或粘贴参考图，也可以直接用文字生成。";
  const files = studioAssetList();
  const links = workbenchLinks();
  return `<section class="section studio-workbench" data-od-id="image-generation" data-studio-format="${format}"><div class="studio-grid">
    <section class="studio-controls card" aria-label="生成设置">
      <div class="studio-controls-heading"><h1 tabindex="-1">图片生成</h1>${links ? `<div class="row workbench-crumb">${links}</div>` : ""}</div>
      <div class="studio-control-fields stack">
      <div class="studio-modes studio-format-tabs" role="group" aria-label="作品格式">${Object.entries(studioFormats).map(([id, label]) =>
        button(label, "studio-format", id, "secondary", `aria-pressed="${active(format === id)}"`)).join("")}</div>
      ${format !== "still" ? nativeStudioFields(format, refs.length) : `
      ${modelSelect("image-model", "image", capability, draft.model)}
      ${uploadZone("generation-reference", "参考图", generationReferenceSlots, referenceHint, imageReferenceLimit("image"))}
      ${imagePromptFields(draft, "画面描述", "描述主体、场景、构图或风格")}
      ${imageParameterPanel(draft, "generate", model?.sizes || [], count)}`}
      </div>
      <div class="studio-control-footer">${button(pending.has("image") ? "正在提交…" : format === "still" ? "查看费用并生成" : "查看费用并生成 " + format.toUpperCase(), format === "still" ? "generate-image" : "generate-native-image", "", "primary", pending.has("image") ? "disabled" : "")}</div>
    </section>
    <section class="studio-gallery" aria-labelledby="generation-gallery-title">
      ${format !== "still" ? nativeStudioIntro(format) : ""}
      ${format === "gif" ? `<details class="studio-composer-disclosure"><summary>拼接已有图片或动图</summary>${window.AnimationComposer?.render() || ""}</details>` : ""}
      ${format === "svg" ? "" : `<div data-studio-assets="${files.map(file => file.id).join(",")}">${studioAssets(files)}</div>`}
      <div class="studio-gallery-heading row-between"><h2 id="generation-gallery-title">生成记录</h2>${button("生成任务", "open-jobs", "", "ghost")}</div>
      <div data-generation-gallery>${generationGallery()}</div>
    </section>
  </div></section>`;
}

function nativeStudioIntro(format) {
  const gif = format === "gif";
  return `<section class="studio-native-intro">
    <div><h2>${gif ? "做一个会动的循环" : "绘制可缩放的矢量图"}</h2>
      <p>${gif ? "从一段简单动作开始。镜头固定、动作单一，循环更容易自然衔接。" : "适合图标、标志和扁平插画。少量纯色与清晰轮廓，描出来的路径更容易编辑。"}</p>
      <div class="row">${(gif ? ["试试弹跳皮球", "试试茶杯热气"] : ["试试狐狸图标", "试试茶叶标志"]).map((name, index) =>
        button(name, "native-prompt-example", index, "secondary")).join("")}</div></div>
    <span class="studio-native-glyph" aria-hidden="true">${gif ? "↻" : "◇"}</span>
  </section>`;
}

function nativeStudioFields(format, referenceCount) {
  const isGif = format === "gif";
  const draft = nativeStudioDraft(format);
  const capability = nativeStudioCapability(format, isGif ? referenceCount : 0);
  const enabled = modelFor("image", capability, draft.model).selected;
  const {sizes, presets, selected, local, maxEdge} = studioSizeChoices(format, draft, enabled);
  const {minFrames, maxFrames, minDelay, maxDelay, step} = studioGifTiming;
  return `<label class="field">制作方式<select class="input" data-field="native-image-method">
    <option value="${isGif ? "sheet" : "trace"}" ${draft.method !== "native" ? "selected" : ""}>${isGif ? "分镜合成（推荐）" : "矢量描摹（推荐）"}</option>
    <option value="native" ${draft.method === "native" ? "selected" : ""}>模型原生（需线路支持）</option></select>
    <span class="meta">${local ? isGif ? "按画幅和时长生成连续分镜，切帧后适配成品尺寸。分镜越多，单帧细节越少。" : "先生成图形，再描成可缩放的 SVG 路径。" : "向线路请求指定格式和参数，实际结果取决于模型。"}</span></label>
    ${modelSelect("native-image-model", "image", capability, draft.model)}
    ${enabled ? "" : `<p class="meta">当前没有符合条件的模型。${!local ? "可切换到推荐的制作方式。" : isGif && referenceCount ? "可移除参考图，查看支持文字生成的模型。" : ""}</p>`}
    ${isGif ? uploadZone("generation-reference", "动作参考图（可选）", generationReferenceSlots, "可沿用静态图参考素材。上传静态图，用下方描述决定怎么动。", imageReferenceLimit("image")) : ""}
    ${imagePromptFields(draft, isGif ? "主体与动作" : "图形、用途与配色", isGif ? "描述起始姿势、动作和如何回到起点。" : "描述图形的用途、轮廓、配色和希望保留的文字。", "native-image-prompt")}
    <label class="field">${isGif ? "每帧尺寸" : "画布尺寸"}<select class="input" data-field="native-image-size">
      ${sizes.map(size => `<option value="${esc(size)}" ${selected === size ? "selected" : ""}>${presets[size] ? `${presets[size]} · ` : ""}${esc(studioSizeText(size))}</option>`).join("")}
      ${local ? `<option value="custom" ${selected === "custom" ? "selected" : ""}>自定义尺寸</option>` : ""}</select></label>
    ${selected === "custom" ? `<div class="dimension-grid"><label class="field">宽（像素）<input class="input" type="number" min="64" max="${maxEdge}" step="1" data-field="native-image-width" value="${esc(draft.width ?? "")}"></label>
      <label class="field">高（像素）<input class="input" type="number" min="64" max="${maxEdge}" step="1" data-field="native-image-height" value="${esc(draft.height ?? "")}"></label></div>
      <p class="meta">宽、高各可设为 64–${maxEdge} 像素。${isGif ? "分镜比例不符时延展边缘背景，保留完整主体。" : ""}</p>` : ""}
    ${isGif ? `<div class="dimension-grid"><label class="field">帧数${local ? `<select class="input" data-field="native-image-frames">${studioSheetFrames.map(value => `<option value="${value}" ${value === draft.frames ? "selected" : ""}>${value}</option>`).join("")}</select>` : `<input class="input" type="number" min="${minFrames}" max="${maxFrames}" data-field="native-image-frames" value="${esc(draft.frames)}">`}</label>
      <label class="field">每帧（毫秒）<input class="input" type="number" min="${minDelay}" max="${maxDelay}" step="${step}" data-field="native-image-duration" value="${esc(draft.duration)}"></label></div>
      <p class="meta">设定循环时长 <output data-native-duration>${gifDuration(draft)}</output>。每帧 ${minDelay}–${maxDelay} 毫秒，步长 ${step} 毫秒。${local ? "相邻相同画面可能合并。单段最长 32 秒，更长可拼接已有动图。" : `可请求 ${minFrames}–${maxFrames} 帧。`}</p>` : ""}`;
}

function validGifTiming(draft) {
  const {minFrames, maxFrames, minDelay, maxDelay, step} = studioGifTiming;
  return Number.isInteger(draft.frames) && draft.frames >= minFrames && draft.frames <= maxFrames &&
    (draft.method !== "sheet" || studioSheetFrames.includes(draft.frames)) && Number.isInteger(draft.duration) &&
    draft.duration >= minDelay && draft.duration <= maxDelay && draft.duration % step === 0;
}

function gifDuration(draft) {
  return validGifTiming(draft) ? `${Number((draft.frames * draft.duration / 1000).toFixed(2))} 秒` : "—";
}

function requestNativeImage() {
  if (!requireAccount()) return;
  const format = studioFormat();
  if (format === "still") return;
  const draft = nativeStudioDraft(format);
  const prompt = draft.prompt.trim();
  if (!prompt) return notify(format === "gif" ? "请描述画面和动作。" : "请描述想生成的矢量图形。");
  const imageIds = format === "gif" ? imageInputs(imageGeneration().tool) : [];
  const model = modelFor("image", nativeStudioCapability(format, imageIds.length), draft.model).selected;
  if (!model) return notify("当前没有符合条件的已启用模型。");
  const size = studioOutputSize(format, draft, model);
  if (!size) return notify(`请填写 64–${studioSizeChoices(format, draft, model).maxEdge} 像素之间的整数宽、高。`);
  const output = {format, method: draft.method};
  if (format === "gif") {
    if (!validGifTiming(draft)) {
      return notify(draft.method === "sheet" ? "请选择分镜帧数，并填写每帧 20–2000 毫秒（按 10 毫秒递增）。"
        : "请填写 2–16 帧，每帧 20–2000 毫秒（按 10 毫秒递增）。");
    }
    Object.assign(output, {frames: draft.frames, frameDurationMs: draft.duration});
  }
  if (imageIds.length > model.maxReferences) return notify(`当前模型最多接收 ${model.maxReferences} 张参考图。`);
  return confirmImages("image", model, [{label: studioFormats[format], prompt, imageIds, size, output,
    context: {operation: "generate"}}], null, null, [
      format === "gif" ? `GIF · ${gifDuration(draft)}` : "SVG 矢量图", studioSizeText(size),
      {sheet: "分镜合成", trace: "矢量描摹", native: "模型原生"}[draft.method]
    ].join(" · "));
}

function imageEditCandidates() {
  const sourceId = ui.file.image?.id;
  if (!sourceId) return [];
  const generated = new Map(live.jobs.filter(job => job.assetId).map(job => [job.assetId, job]));
  const result = state.image.candidates.filter(key => {
    const file = imageCandidateFile(key);
    return file?.parentId === sourceId && (!generated.has(file.id) || imageJobOperation(generated.get(file.id)) === "edit");
  });
  const known = new Set(result.map(key => imageCandidateFile(key)?.id));
  for (const file of ui.files) {
    const job = generated.get(file.id);
    if (file.kind === "image" && file.parentId === sourceId && job && imageJobOperation(job) === "edit" && !known.has(file.id)) {
      result.push("local:" + file.id);
    }
  }
  return result;
}

function editAssetLibrary() {
  const files = studioAssetList();
  const query = (ui.editAssetSearch || "").trim().toLowerCase();
  return `<section class="card edit-library" aria-label="图片素材">
    <div class="row-between"><h2>图片素材</h2><span class="meta" data-edit-asset-count>${files.filter(file => file.name.toLowerCase().includes(query)).length} 张</span></div>
    <p class="meta">拖到画布作底图，拖进标注作参考。</p>
    <input class="input" type="search" data-field="edit-asset-search" aria-label="搜索图片素材" placeholder="搜索图片素材" value="${esc(ui.editAssetSearch || "")}">
    <div class="edit-asset-list" data-edit-scroll>
      ${files.map(file => `<button type="button" class="edit-asset" draggable="true" data-studio-asset="${esc(file.id)}"
        data-action="edit-pick-asset" data-value="${esc(file.id)}" data-edit-asset-name="${esc(file.name.toLowerCase())}"
        aria-pressed="${ui.file.image?.id === file.id}" title="${esc(file.name)}"${file.name.toLowerCase().includes(query) ? "" : " hidden"}>
        <img src="/api/assets/${esc(file.id)}" alt="" loading="lazy" decoding="async" draggable="false">
        <span><strong>${esc(file.name)}</strong><small>${file.jobId ? "生成" : "素材"} · ${localDate(file.created)}</small></span>
      </button>`).join("")}
      <p class="meta edit-asset-empty" data-edit-asset-empty${files.some(file => file.name.toLowerCase().includes(query)) ? " hidden" : ""}>
        ${account ? "没有符合条件的图片" : '<a href="#account">登录后查看历史素材</a>'}</p>
    </div>
    ${button("上传图片", "file", "image", "secondary")}
  </section>`;
}

function editResultList(candidates, selected) {
  if (!candidates.length) return '<div class="edit-empty-panel"><strong>当前底图暂无结果</strong><p class="meta">提交一次编辑后，成品会出现在这里。</p></div>';
  const selectedFile = imageCandidateFile(selected);
  return `<section class="edit-result-panel" aria-label="当前底图的编辑结果">
  <div class="row-between"><h3>编辑结果</h3><span class="meta">${candidates.length} 张</span></div>
  <div class="edit-result-list">${candidates.map((key, index) => {
    const file = imageCandidateFile(key);
    const job = assetGenerationJob(file.id);
    return `<button class="edit-result-card" type="button" data-action="choose-image" data-value="${esc(key)}" aria-pressed="${key === selected}" title="${esc(file.name)}">
      <img src="${esc(file.url)}" alt="" loading="lazy" draggable="false"><strong>${esc(file.name)}</strong><small>${key === selected ? "正在查看" : `结果 ${index + 1}`}</small>
      ${job ? jobElapsed(job) : ""}</button>`;
  }).join("")}</div>
  ${selectedFile ? `<div class="row edit-result-actions">${button("作为新底图", "edit-pick-asset", selectedFile.id)}
    ${button("下载图片", "export-image", selected, "ghost")}${selectedFile.jobId ? button("提示词", "asset-detail", selectedFile.id, "ghost") : ""}</div>` : ""}</section>`;
}

const backgroundEditStarter = "保持原图主体的外观、比例和文字不变。背景换成：";
const editToolHelp = {
  mask: {description: "只改圈出的部分。每个标注可分别填写要求或添加参考图。", submit: "生成标注"},
  edit: {description: "指定整张图要怎么改。适合统一调色、改变风格或调整多个元素。", label: "整图修改要求", example: "例如把整体调成暖色胶片风，保留构图和文字", submit: "生成修改结果"},
  background: {description: "保留原图主体，描述要换上的新场景。", label: "背景替换要求", example: "例如在浅灰影棚中拍摄，地面有柔和的自然阴影。也可写明要保留的主体。", submit: "生成新背景"},
  cutout: {description: "自动识别主体，要求模型移除背景并输出透明图。适合提取商品或人物。", submit: "开始抠图"},
  expand: {description: "向指定方向扩大画布并补出新内容，适合为标题留白或把竖图扩成横图。", label: "补画要求（可选）", example: "例如延续展厅灯光，在新增区域留出干净的标题空间", size: "自动扩展画布", submit: "生成扩图"},
  upscale: {description: "按原图比例放大并增强细节。", submit: "放大并增强"},
  extract: {description: "识别原图中的文字，识别后可以直接校对和复制。", submit: "提取图片文字"},
  crop: {description: "按下方尺寸居中裁剪并缩放，适合统一素材的比例和像素尺寸。", submit: "应用裁剪缩放"}
};
const expansionDirections = {right: "向右", left: "向左", up: "向上", down: "向下", all: "向四周"};

function suggestedEditSize(image) {
  const source = editSourceDimensions();
  if (!source) return null;
  const direction = image.expandDirection || "right";
  const widthFactor = image.tool === "upscale" ? 2 : ["up", "down"].includes(direction) ? 1 : 1.5;
  const heightFactor = image.tool === "upscale" ? 2 : ["left", "right"].includes(direction) ? 1 : 1.5;
  const width = source.width * widthFactor;
  const height = source.height * heightFactor;
  const scale = Math.min(1, 4096 / Math.max(width, height));
  return {width: Math.max(64, Math.round(width * scale)), height: Math.max(64, Math.round(height * scale))};
}

function editorRequestPrompt(image) {
  if (["mask", "cutout", "upscale"].includes(image.tool)) return "";
  const prompt = image.prompt.trim();
  if (image.tool === "background" && prompt === backgroundEditStarter) return "";
  if (image.tool !== "expand") return prompt;
  const direction = expansionDirections[image.expandDirection] || expansionDirections.right;
  return [`${direction}延伸画布，仅在新增区域补画，与原图边缘自然衔接。`, prompt].filter(Boolean).join("\n");
}

function switchEditTool(image, next) {
  if (image.tool === next) return;
  const fields = ["prompt", "resolution", "ratio", "width", "height", "editSizeChosen"];
  const drafts = image.editToolDrafts ||= {};
  if (Object.hasOwn(editToolHelp, image.tool)) {
    drafts[image.tool] = Object.fromEntries(fields.map(field => [field, image[field]]));
  }
  Object.assign(image, {tool: next, prompt: next === "background" ? backgroundEditStarter : "", resolution: editToolHelp[next]?.size ? "suggested" : "source",
    ratio: "1:1", width: 1024, height: 1024, editSizeChosen: false}, drafts[next]);
}

function editToolFields(image, tool) {
  if (tool.id === "mask") return workspaceRegions.panel();
  const guide = editToolHelp[tool.id];
  const direction = tool.id === "expand" ? `<fieldset class="edit-directions">
    <legend>扩展方向</legend>
    <div class="edit-direction-grid">${Object.entries({left: "←", right: "→", up: "↑", down: "↓", all: "↔"}).map(([id, arrow]) => `
      <label><input type="radio" name="edit-expand-direction" data-field="edit-expand-direction" value="${id}"${(image.expandDirection || "right") === id ? " checked" : ""}>
        <span><span aria-hidden="true">${arrow}</span>${expansionDirections[id]}</span></label>`).join("")}</div>
  </fieldset>` : "";
  if (!guide.label) return tool.id === "extract" && image.text ? `<label class="field">识别结果<textarea class="textarea" data-field="image-text">${esc(image.text)}</textarea></label>` : "";
  const draft = tool.id === "background" && !image.prompt ? {...image, prompt: backgroundEditStarter} : image;
  return `${direction}${imagePromptFields(draft, guide.label, guide.example)}${tool.id === "background" ? `<p class="meta edit-help-example">${guide.example}</p>` : ""}`;
}

function imageView() {
  const image = state.image;
  const editTools = tools.filter(item => !isGenerationTool(item.id));
  const tool = editTools.find(item => item.id === image.tool) || editTools[0];
  const isMask = tool.id === "mask";
  const candidates = imageEditCandidates();
  const selected = [ui.picked, image.adopted, candidates.at(-1)].find(key => candidates.includes(key)) || "";
  const showCandidate = ui.imageView === "结果" && Boolean(selected);
  const file = ui.file.image;
  const original = file?.url ? uploadArtwork(file, "upload:image") : image.source ? imageArtwork(image.source) : "";
  const displayed = showCandidate ? imageArtwork(selected) : original;
  const mediaId = showCandidate ? "upload:" + selected : file?.url ? "upload:image" : "sample:" + image.source;
  const shownCrop = mediaItems.get(mediaId)?.crop;
  const stageRatio = shownCrop ? shownCrop.width / shownCrop.height : 1.78;
  const drawing = isMask && original && !showCandidate && ui.selecting;
  const selection = isMask && original && !showCandidate ? workspaceRegions.overlay() : "";
  const isLocal = ["extract", "crop"].includes(tool.id);
  const usesReference = !["extract", "crop", "cutout", "upscale", "expand"].includes(tool.id);
  const capability = imageCapability(tool.id, imageInputs().length);
  const imageModel = modelFor("image", capability, image.model).selected;
  const referenceLimit = imageReferenceLimit();
  const tabs = [["annotations", isMask ? "标注" : "设置"], ...(usesReference ? [["references", "参考图"]] : []), ["results", "结果"]];
  const tab = showCandidate ? "results" : (tabs.some(([id]) => id === ui.editTab) ? ui.editTab : "annotations");
  const pendingImage = pending.has("image");
  const ready = isMask ? workspaceRegions.readyCount() : 0;
  const disabled = !original || (isMask && !ready) || pendingImage;
  const status = showCandidate ? "生成结果" : "当前底图";
  const name = showCandidate ? imageCandidateFile(selected)?.name : file?.name || mediaItems.get(mediaId)?.name;
  const guide = editToolHelp[tool.id];
  const toolPanel = tab === "annotations" ? editToolFields(image, tool) : tab === "references"
    ? uploadZone("reference", "全图参考", referenceSlots, isMask ? "支持上传、粘贴或拖入。拖到画布标注框可指定给单个区域。" : "支持上传、粘贴或拖入。参考图用于提供场景、构图或风格。", referenceLimit)
    : editResultList(candidates, selected);
  const modelControl = isLocal || tool.id === "upscale" ? "" : modelSelect("image-model", "image", capability, image.model);
  const outputControl = tool.id === "upscale" ? upscaleControls(image) :
    ["extract", "cutout"].includes(tool.id) ? "" : imageParameterPanel(image, "edit", isLocal ? [] : imageModel?.sizes || []);
  return page("图片编辑", `<div class="edit-workspace">
    ${editAssetLibrary()}
    <section class="card edit-center" aria-label="图片编辑画布">
      <header class="edit-canvas-header row-between"><div><p class="meta">${status} <span data-edit-source-size>${showCandidate ? "" : editSourceLabel()}</span></p><h2>${esc(name || "添加要编辑的图片")}</h2></div>
        <div class="row">${showCandidate ? button("返回底图", "choose-image", "") : isMask && original ? button(drawing ? "结束圈选" : "继续圈选", "region-draw", "", "secondary", `aria-pressed="${Boolean(drawing)}"`) : ""}
        ${showCandidate ? button("用于海报", "use-poster-product", imageCandidateFile(selected).id, "primary") : ""}
        ${original ? `<button type="button" class="btn btn-ghost" data-open-media="${esc(mediaId)}">查看大图</button>` : ""}</div></header>
      <div class="image-stage edit-stage" data-drop-target="image">${original
        ? `<div id="photo-canvas" class="photo-canvas${drawing ? " selecting" : ""}" ${showCandidate ? "" : "data-edit-original"} style="--stage-ratio:${stageRatio}" aria-label="图片画布">${displayed}${selection}</div>`
        : `<div class="studio-empty"><h3>把图片拖到这里</h3><p class="meta">也可点击左侧素材，或粘贴图片。</p>${button("上传原图", "file", "image")}</div>`}</div>
      <p class="meta edit-canvas-caption">${showCandidate ? "在右侧切换结果，或设为底图继续编辑。" : original && isMask ? "拖动圈选，拖四角调整范围。选中标注后按 Delete 删除。" : ""}</p>
    </section>
    <aside class="card edit-controls" aria-label="编辑参数">
      <header class="edit-inspector-header">
        <div class="edit-tool-heading">
          <div class="field"><label for="image-tool">编辑工具</label><select class="input" id="image-tool" data-field="image-tool" aria-describedby="edit-tool-description">${editTools.map(item => `<option value="${item.id}" ${tool.id === item.id ? "selected" : ""}>${item.name}</option>`).join("")}</select></div>
          <p class="meta" id="edit-tool-description">${guide.description}</p>
        </div>
        <div class="row edit-tabs" role="group" aria-label="编辑面板">${tabs.map(([id, label]) => button(label, "edit-panel", id, "ghost", `aria-pressed="${tab === id}"`)).join("")}</div>
      </header>
      <div class="edit-controls-scroll" data-edit-scroll>
        ${toolPanel ? `<div class="edit-tool-options">${toolPanel}</div>` : ""}
        ${modelControl || outputControl ? `<div class="edit-settings stack">${modelControl}${outputControl}</div>` : ""}
      </div>
      <footer class="edit-inspector-footer stack">
        ${scopeStatus("image", "edit")}
        ${button(pendingImage ? "正在处理…" : isMask ? `生成已填写标注（${ready}）` : guide.submit, "generate-image", "", "primary",
          `${disabled ? "disabled" : ""} ${isMask ? "data-region-submit" : ""}`)}
      </footer>
    </aside>
  </div>`, "image-editor");
}

function editSourceLabel() {
  const size = editSourceDimensions();
  return size ? `· ${size.width} × ${size.height} px` : "";
}

function upscaleSizeLabel() {
  const size = editSourceDimensions();
  if (!size) return "";
  const target = state.image.upscaleTarget || "2";
  const scale = target === "4k" ? 4096 / Math.max(size.width, size.height) : Number(target);
  if (scale <= 1) return "原图长边已达到 4096 像素。";
  if (scale > 4) return "原图长边小于 1024 像素，可选 4 倍放大。";
  return `预计 ${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} px`;
}

function upscaleControls(image) {
  const method = image.upscaleMethod || "local";
  const target = image.upscaleTarget || "2";
  return `<label class="field">超分方式<select class="input" data-field="upscale-method">
      <option value="local" ${method === "local" ? "selected" : ""}>本地 Real-ESRGAN</option>
      <option value="aliyun" ${method === "aliyun" ? "selected" : ""}>阿里云万相超分</option>
    </select></label>
    <label class="field">输出尺寸<select class="input" data-field="upscale-target">
      ${[["2", "放大 2 倍"], ["4", "放大 4 倍"], ["4k", "长边 4096 像素（4K）"]]
        .map(([id, label]) => `<option value="${id}" ${target === id ? "selected" : ""}>${label}</option>`).join("")}
    </select></label>
    <p class="meta" data-upscale-size>${esc(upscaleSizeLabel())}</p>
    <div class="row"><span class="meta" data-upscale-mode-note>${method === "aliyun" ? "由百炼计费" : "使用本机显卡"}</span>
      ${button("超分设置", "open-upscale-settings", "", "ghost")}</div>`;
}

function updateEditDimensions(element) {
  if (ui.route !== "image-edit" || !element?.naturalWidth || !element.matches("[data-edit-original] > .uploaded-art > img") || !ui.file.image) return;
  ui.file.image.naturalSize = {width: element.naturalWidth, height: element.naturalHeight};
  const label = content.querySelector("[data-edit-source-size]");
  if (label) label.textContent = editSourceLabel();
  const upscaleLabel = content.querySelector("[data-upscale-size]");
  if (upscaleLabel) upscaleLabel.textContent = upscaleSizeLabel();
  if (followsEditSource(state.image) || state.image.resolution === "suggested") {
    for (const summary of content.querySelectorAll("[data-size-summary], #output-summary")) summary.textContent = outputSummary(state.image);
  }
}

function visualExists(identifier) { return ui.files.some(file => file.id === identifier); }
const slide = actualSlide;
function stepPptSlide(direction, focusArrow = true) {
  const ppt = state.ppt;
  const index = ppt.active + direction;
  if (ppt.stage < 2 || index < 0 || index >= ppt.outline.length) return;
  ppt.active = index;
  save();
  render();
  if (focusArrow) {
    const arrow = content.querySelector(`[data-action="ppt-slide-step"][data-value="${direction}"]`);
    const focus = arrow?.disabled ? content.querySelector(".ppt-preview") : arrow;
    focus?.focus({preventScroll: true});
  }
}
function pptResolutionControl(ppt) {
  return `<label class="field">出图分辨率<select class="input" data-field="ppt-resolution">${Object.entries(pptResolutions).map(([value, label]) =>
    `<option value="${value}" ${(ppt.resolution || "1920x1080") === value ? "selected" : ""}>${label} px · 16:9</option>`).join("")}</select></label>
    <p class="meta">先按所选尺寸提交。模型明确拒绝时，自动选最接近的支持尺寸。</p>`;
}
function pptReplyText(value) {
  const emphasis = text => esc(text).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  const blocks = String(value ?? "").replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  return `<div class="ppt-reply-text">${blocks.map(block => {
    const heading = /^#{1,6}[ \t]+([^\n]+)(?:\n|$)/.exec(block);
    const body = heading ? block.slice(heading[0].length) : block;
    return `${heading ? `<h3>${emphasis(heading[1])}</h3>` : ""}${body ? `<p>${emphasis(body)}</p>` : ""}`;
  }).join("")}</div>`;
}

const aiSendShortcut = 'aria-keyshortcuts="Control+Enter" title="Ctrl+Enter 发送"';

function researchModeField(field, mode, locked) {
  const options = {auto: "自动识别联网请求", always: "每次主动搜索", off: "关闭自动联网"};
  return `<label class="field">联网搜索<select class="input" data-field="${field}" ${locked}>${Object.entries(options).map(([value, label]) =>
    `<option value="${value}" ${(mode || "auto") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
}

function pptView() {
  const ppt = state.ppt;
  normalizePptDraft(ppt);
  const busy = pending.has("ppt") || scopeInProgress("ppt");
  const locked = busy ? "disabled" : "";
  const submitLocked = pending.has("ppt") ? "disabled" : "";
  const sessionLocked = pending.has("ppt") || ui.uploading ? "disabled" : "";
  const steps = ["需求沟通", "确认大纲", "分镜总览", "成稿与导出"].map((label, index) => index !== ppt.stage && index <= ppt.maxStage
    ? button(label, "ppt-step", index, "ghost")
    : `<span ${index === ppt.stage ? 'aria-current="step"' : ""}>${label}</span>`).join("");
  let body;
  if (ppt.stage === 0) {
    const files = pptSlots.filter(key => ui.file[key]);
    body = `<div class="work-grid ppt-intake-grid"><div class="card stack ppt-intake"><h2>和 AI 沟通汇报需求</h2>
      <label class="field">汇报内容<textarea class="textarea" data-field="ppt-brief" ${ppt.discussion.length ? "" : 'data-ai-send="ppt-discuss"'} maxlength="6000" ${locked} placeholder="描述主题、听众和汇报目标。也可以只上传资料。">${esc(ppt.brief)}</textarea></label>
      <div class="stack upload-zone" data-drop-target="ppt"><div class="row">${button("添加资料", "file", "ppt", "secondary", files.length === pptSlots.length ? "disabled" : locked)}<span class="meta">${files.length} / ${pptSlots.length} 份</span>${button("使用项目汇报示例", "ppt-sample", "", "ghost", locked)}</div>
      <p class="meta">支持拖入或多选 PDF、Word、Excel、PPTX、图片和文本。单份最多 12 MB。</p>
      ${files.length ? `<div class="ppt-source-list" aria-label="已添加资料">${files.map(key => `<div class="row">${ui.file[key].url ? uploadArtwork(ui.file[key], "upload:" + key, true, "upload-thumb") : ""}<span>${esc(ui.file[key].name)}</span>${button("移除附件", "detach-file", key, "ghost", locked)}</div>`).join("")}</div>` : ""}</div>
      ${ppt.sourceWarnings.length ? `<details><summary>资料读取提示（${ppt.sourceWarnings.length}）</summary><ul>${ppt.sourceWarnings.map(warning => `<li>${esc(warning)}</li>`).join("")}</ul></details>` : ""}
      ${ppt.discussion.length ? `<div class="ppt-discussion" aria-label="需求沟通记录">${ppt.discussion.map((turn, index) =>
        `<p class="ppt-turn"><b>你</b>${esc(turn?.question)}</p><article class="ppt-turn"><b>AI</b>${pptReplyText(turn?.reply)}${turn?.webSearch ? workspaceCommercial.searchSources(turn.webSearch, "ppt-turn-" + index, index === ppt.discussion.length - 1) : ""}</article>`).join("")}</div>
        <label class="field">继续补充<textarea class="textarea" data-field="ppt-discussion" data-ai-send="ppt-discuss" maxlength="3000" ${locked} placeholder="回答 AI 的问题，或补充新的要求">${esc(ppt.discussionDraft)}</textarea></label>` : ""}
      ${pptStreamPreview()}
      <div class="row ppt-intake-actions">${button(pending.get("ppt") === "discuss" ? "正在沟通…" : ppt.discussion.length ? "发送补充" : "开始需求沟通", "ppt-discuss", "", ppt.discussion.length ? "secondary" : "primary", locked + " " + aiSendShortcut)}
      ${button("联网搜索并发送", "ppt-search-send", "", "secondary", locked)}
      ${button(pending.get("ppt") === "outline" ? "正在生成大纲…" : "需求已确认，生成大纲", "ppt-outline", "", "primary", ppt.discussion.length ? locked : "disabled")}</div>
      <p class="meta">需求沟通和大纲按语言模型实际 Token 结算。</p></div>
      <aside class="card stack ppt-intake-options">
      <label class="field">详细程度<select class="input" data-field="ppt-level">${["简报","标准","详细"].map(value => `<option ${ppt.level === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      ${workspacePptTemplates.summary(ppt.style, locked)}
      ${modelSelect("ppt-language-model", "chat", "text", ppt.languageModel, "语言模型")}
      ${researchModeField("ppt-search-mode", ppt.searchMode, locked)}
      <p class="meta">「联网搜索并发送」会为本轮重新查找公开资料。回复可展开查看来源。</p></aside></div>`;
  } else if (ppt.stage === 1) {
    body = `<div class="work-grid"><div class="card stack"><h2>逐页确认大纲</h2>
      ${ppt.outline.map(([title, detail], index) => `<div class="stack"><label class="outline-line"><span class="num">${index + 1}</span><input class="input" aria-label="第 ${index + 1} 页标题" data-field="ppt-title" data-index="${index}" maxlength="120" value="${esc(title)}" ${locked}></label><textarea class="textarea" aria-label="第 ${index + 1} 页内容" data-field="ppt-detail" data-index="${index}" maxlength="2000" ${locked}>${esc(detail)}</textarea></div>`).join("")}</div>
      <aside class="card stack"><h3>${esc(ppt.level)} · 分镜设置</h3>
      ${workspacePptTemplates.summary(ppt.style, locked, "更换模板")}
      <p class="meta">模板用于生成分镜。大纲中的标题和内容会保留。</p>${scopeStatus("ppt")}
      ${ppt.outlineWebSearch ? workspaceCommercial.searchSources(ppt.outlineWebSearch, "ppt-outline", true) : ""}
      ${modelSelect("ppt-model", "image", "generate", ppt.model)}
      ${pptResolutionControl(ppt)}
      <p class="meta">分镜就是完整页面图，满意可直接用来导出。</p>
      ${button(pending.has("ppt") ? "正在提交…" : "确认大纲，生成分镜", "ppt-board", "", "primary", submitLocked)}</aside></div>`;
  } else {
    const ready = ppt.stage === 3;
    const asset = ui.files.find(file => file.id === (ready ? ppt.pages : ppt.boards)[ppt.active]);
    const edit = ppt.pageEdits?.[ppt.active] || {};
    const versions = (ready ? ppt.history : ppt.boardHistory)?.[ppt.active] || [];
    const pageVersions = [...new Set([asset?.id, ...(Array.isArray(versions) ? [...versions].reverse() : []),
      ready ? ppt.boards[ppt.active] : null])].filter(visualExists);
    const pageJobMessage = pptPageJobMessage(ppt.active, asset?.id);
    const complete = ppt.outline.every((_, index) => visualExists(ppt.boards[index]));
    const thumbnails = ppt.outline.map(([title], index) => `<button class="slide-tile" data-media-select data-action="ppt-slide" data-value="${index}" aria-pressed="${active(ppt.active === index)}">${slide(index)}<span class="meta">第 ${index + 1} 页 · ${esc(title)}</span></button>`).join("");
    body = `<div class="work-grid ppt-review-grid"><div class="card stack ppt-review"><h2>${ready ? "成稿预览" : "分镜总览"}</h2>
      <div class="ppt-preview" tabindex="-1" aria-label="幻灯片预览">
        <div class="slide-large">${slide(ppt.active, true)}</div>
        ${button("‹", "ppt-slide-step", "-1", "secondary", 'aria-label="上一页" ' + (ppt.active === 0 ? "disabled" : ""))}
        ${button("›", "ppt-slide-step", "1", "secondary", 'aria-label="下一页" ' + (ppt.active >= ppt.outline.length - 1 ? "disabled" : ""))}
      </div>
      <div class="row-between ppt-preview-caption"><span class="meta">第 ${ppt.active + 1} / ${ppt.outline.length} 页</span>
        <span class="meta">点击图面放大，左右方向键翻页</span></div>
      <div class="ppt-page-job-notice" data-ppt-page-status="${ppt.active}" data-asset="${esc(asset?.id || "")}" role="status"${pageJobMessage ? "" : " hidden"}>${pageJobMessage}</div>
      <div class="ppt-page-image-controls">
        <label class="field">本页使用的图片
          <select class="input" data-field="ppt-page-image" ${pageVersions.length ? submitLocked : "disabled"}>
            ${asset ? "" : '<option value="" selected disabled>暂无页图</option>'}
            ${pageVersions.map(id => {
              const file = ui.files.find(item => item.id === id);
              const label = id === asset?.id ? "当前图片" : ready && id === ppt.boards[ppt.active] ? "本页分镜" : "历史版本";
              const time = file.created ? new Date(file.created * 1000).toLocaleString("zh-CN", {month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit"}) : "";
              return `<option value="${esc(id)}" ${id === asset?.id ? "selected" : ""}>${esc([label, file.name, time].filter(Boolean).join(" · "))}</option>`;
            }).join("")}
          </select>
        </label>
        <div class="row">${button("从素材库选择", "ppt-use-asset", "", "secondary", submitLocked)}
          ${button("上传替换图片", "ppt-upload-page", "", "secondary", submitLocked)}</div>
      </div>
      <div class="slide-grid">${thumbnails}</div></div>
      <aside class="card stack ppt-page-options"><h3>第 ${ppt.active + 1} 页 · ${esc(ppt.outline[ppt.active][0])}</h3>
        ${asset?.width ? `<p class="meta">当前图片 ${asset.width} × ${asset.height} px</p>` : ""}
        ${busy ? scopeStatus("ppt") : ""}
        <button type="button" class="btn btn-secondary" data-open-media="slide:${ppt.active}" ${asset ? "" : "disabled"}>放大查看本页</button>
        ${!ready ? button("采用分镜，进入导出", "ppt-use-boards", "", "primary", complete ? locked : "disabled") : ""}
        ${!ready && !complete ? button("补齐缺失分镜", "ppt-board", "", "secondary", submitLocked) : ""}
        <label class="field">用一句话描述本页修改<textarea class="textarea" data-field="ppt-change" data-ai-send="ppt-ai-revise" maxlength="1000" ${submitLocked} placeholder="例如联网核实本页数据，或只调整配色并保留节点">${esc(edit.change ?? "")}</textarea></label>
        ${button(pending.get("ppt") === "revise-slide" ? "AI 正在修改…" : "请 AI 优化本页提示词", "ppt-ai-revise", "", "secondary", submitLocked + " " + aiSendShortcut)}
        ${pptStreamPreview()}
        <p class="meta">AI 只整理本页提示词，按实际 Token 结算。确认重出后才生成图片。</p>
        ${edit.suggestion ? `<label class="field">AI 建议（可编辑）<textarea class="textarea" data-field="ppt-suggestion" maxlength="4500">${esc(edit.suggestion)}</textarea></label>
        ${button("采用建议", "ppt-apply-prompt", "", "secondary", submitLocked)}` : ""}
        ${edit.webSearch ? workspaceCommercial.searchSources(edit.webSearch, "ppt-slide-" + ppt.active) : ""}
        <details><summary>查看或编辑本页生图提示词</summary><textarea class="textarea" aria-label="本页生图提示词" data-field="ppt-prompt" maxlength="4500" ${submitLocked}>${esc(edit.prompt ?? pptPrompt(ppt, ppt.active))}</textarea></details>
        ${modelSelect("ppt-model", "image", "generate", ppt.model)}
        ${pptResolutionControl(ppt)}
        ${button("按所选分辨率重出本页", ready ? "ppt-redo" : "ppt-board-redo", "", "primary", submitLocked)}
        ${ready ? `${modelFor("chat", "vision").selected ? `<label><input type="checkbox" data-field="ppt-auto-review" ${ppt.autoReview !== false ? "checked" : ""}> 成稿重出后自动校对和修复</label>` : ""}
          ${ppt.outline.some((_, index) => !visualExists(ppt.pages[index])) ? button("补齐缺失成稿", "ppt-final", "", "secondary", submitLocked) : ""}
          <div class="ppt-export-options stack">
            <label><input type="checkbox" data-field="ppt-preserve-image" ${edit.preserveImage === true ? "checked" : ""} ${ui.pptExport ? "disabled" : locked}> 本页只保留原图</label>
            ${button(`补充或校对本页文字${ppt.textboxes[ppt.active]?.length ? "（" + ppt.textboxes[ppt.active].length + "）" : ""}`, "ppt-mark-text", "", "secondary", asset && !ui.pptExport ? locked : "disabled")}
            ${button(ui.pptExport?.editable ? "正在导出可编辑 PPTX…" : "导出可编辑 PPTX", "ppt-export", "editable", "primary", ui.pptExport ? "disabled" : locked)}
            ${pptExportStatus(ppt)}
            <p class="meta">在 WPS 或 PowerPoint 中直接点击文字修改。图形和难以安全转换的文字保留在底图中。</p>
            ${button("导出原图 PPTX", "ppt-export", "image", "secondary", ui.pptExport ? "disabled" : locked)}
          </div>`
          : ""}
      </aside></div>`;
  }
  const project = workspaceProjects.label();
  const sessions = pptSessionList();
  const toolbar = `<div class="row-between ppt-session-toolbar">
    <div class="row steps" aria-label="PPT 进度">${steps}</div>
    <div class="row">
      ${sessions.length ? `<select class="input" aria-label="切换 PPT 历史对话" data-field="ppt-chat-history" ${sessionLocked}>
        <option value="">历史对话</option>${sessions.map(({id, title}) => `<option value="${esc(id)}">${esc(title.slice(0, 36))}</option>`).join("")}</select>` : ""}
      ${button("＋ 新对话", "ppt-new-chat", "", "secondary", sessionLocked)}
    </div></div>`;
  return page("PPT 工作台", toolbar + body, "ppt-editor",
    `<a href="#projects">PPT 项目</a>${project ? " / " + esc(project) : ""}${
      state.activeProjectId ? " " + button("退出项目", "p-exit", "", "ghost") : ""}`);
}

function normalizePptDraft(ppt) {
  for (const key of ["outline", "boards", "pages", "discussion", "sourceWarnings", "tracked"]) {
    if (!Array.isArray(ppt[key])) ppt[key] = [];
  }
  for (const key of ["history", "boardHistory", "pageEdits", "textboxes"]) {
    if (!ppt[key] || typeof ppt[key] !== "object" || Array.isArray(ppt[key])) ppt[key] = {};
  }
  if (!ppt.outline.length || !ppt.outline.every(item => Array.isArray(item) && typeof item[0] === "string")) {
    ppt.stage = ppt.maxStage = ppt.active = 0;
    return;
  }
  if (![0, 1, 2, 3].includes(ppt.stage)) ppt.stage = 0;
  if (![0, 1, 2, 3].includes(ppt.maxStage)) ppt.maxStage = ppt.stage;
  if (!Number.isInteger(ppt.active) || ppt.active < 0 || ppt.active >= ppt.outline.length) ppt.active = 0;
}

function localDate(value) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "本次体验";
}
function fileCard(file) {
  const path = "/api/assets/" + file.id;
  const isImage = file.mime.startsWith("image/");
  const preview = isImage && ui.assetType !== "回收站" ? uploadArtwork(uploadDescriptor(file), "asset:" + file.id, true) : '<div class="art art-placeholder">素材文件</div>';
  const kind = {image:"图片成品", poster:"海报主视觉", ppt:"PPT 页面"}[file.kind] || "上传素材";
  return `<article class="card asset-card" data-asset-type="${ui.assetType === "回收站" ? "回收站" : kind}" data-asset-name="${esc(file.name + " " + (file.tags || ""))}">
    ${preview}<h3>${esc(file.name)}</h3><p class="meta">${kind} · ${Math.max(1, Math.round(file.size / 1024))} KB · ${localDate(file.created)}</p>
    ${file.modelName ? `<p class="meta">${esc(file.modelName)} · ${file.width} × ${file.height} px</p>` : ""}
    ${!isImage && file.tags ? `<p class="meta">${esc(file.tags)}</p>` : ""}
    <div class="row">${ui.assetType === "回收站" ? button("恢复", "restore-file", file.id) : `${isImage && file.mime !== "image/svg+xml" ? button("用作原图", "use-upload", file.id) + button("用作参考", "reference-file", file.id, "ghost") : ""}<a class="btn btn-secondary" href="${path}/download">下载</a>${!isImage || file.jobId ? button(isImage ? "提示词" : "详情", "asset-detail", file.id) : ""}${button("移入回收站", "remove-file", file.id, "ghost")}`}</div>
  </article>`;
}
function assetsView() {
  const filters = ["全部", "上传素材", "图片成品", "海报主视觉", "PPT 页面", "回收站"];
  const files = ui.assetType === "回收站" ? live.trash || [] : ui.files;
  return page("我的素材", `<div class="row-between filters">
    <div class="row" aria-label="素材类别">${filters.map(filter => button(filter === "上传素材" ? "我上传的" : filter, "asset-filter", filter, "secondary", `aria-pressed="${active(filter === ui.assetType)}"`)).join("")}</div>
    <div class="row" ${account ? 'data-drop-target="library"' : ""}><input class="input search" type="search" placeholder="搜索素材名称" aria-label="搜索素材" data-field="asset-search" value="${esc(ui.assetSearch)}">${account ? button("上传素材", "file", "library", "primary") : '<a class="btn btn-primary" href="#account">登录后上传</a>'}</div>
  </div><div class="grid-3">
    ${files.map(fileCard).join("")}
  </div><p id="no-assets" class="empty" hidden>这里暂时没有匹配的素材。</p>`, "assets", account ? "上传文件和生成记录归当前账号。" : "登录后查看个人素材。");
}
function filterAssets() {
  const cards = [...content.querySelectorAll("[data-asset-type]")];
  const term = ui.assetSearch.trim().toLowerCase();
  for (const card of cards) {
    card.hidden = (ui.assetType !== "全部" && card.dataset.assetType !== ui.assetType) ||
      !card.dataset.assetName.toLowerCase().includes(term);
  }
  const empty = content.querySelector("#no-assets");
  if (empty) empty.hidden = cards.some(card => !card.hidden);
}
function walletRows(rows = state.ledger) {
  return rows.map(row => `<tr><td>${localDate(row.created)}</td><td>${esc(row.label)}</td><td class="num">${row.amount > 0 ? "+" : ""}${points(row.amount)}</td></tr>`).join("");
}
function creditsView() {
  return page("我的积分", `<div class="grid-2">
    <div class="card stack"><span class="meta">可用积分</span><h2 class="num" id="wallet-balance">${points(available())}</h2><p class="meta">累计已结算消耗 <span id="wallet-usage">${points(state.spent)}</span> 积分。</p></div>
    <form class="card stack" id="redeem-form"><h3>兑换积分</h3><label class="field">兑换码<input name="code" class="input" placeholder="输入管理员发放的兑换码" required></label><button class="btn btn-primary">兑换积分</button></form>
  </div><div class="card table-wrap" style="margin-top:12px"><h2>积分与消耗明细</h2><table class="ds-table"><thead><tr><th>时间</th><th>事项</th><th>积分</th></tr></thead><tbody id="wallet-ledger">
  ${walletRows()}</tbody></table></div>`, "credits", account ? esc(account.name) + " · 账号积分" : "请登录后查看账号积分。");
}
const authDialog = document.querySelector("#auth-dialog");
const accountDialog = document.querySelector("#account-dialog");

function openAuth(mode = "login", next = "", continuation = null) {
  if (authBusy) return;
  authNext = next;
  authContinuation = continuation;
  ui.authMode = mode;
  renderAuth();
  if (!authDialog.open) authDialog.showModal();
}

function renderAuth() {
  const mode = ui.authMode;
  const labels = {
    login: ["登录风沙生图工作台", "登录"],
    register: ["创建你的账号", "注册账号"],
    reset: ["重设登录密码", "重设密码"],
    bootstrap: ["初始化本地管理员", "创建管理员"]
  };
  const [heading, submit] = labels[mode];
  const verify = mode === "register" || mode === "reset";
  authDialog.innerHTML = `<div class="auth-layout-grid">
    <div class="auth-art" aria-hidden="true">
      <img class="auth-art-image" src="/frontend/auth-aurora.webp" width="1672" height="941" alt="">
      <div class="auth-art-light" aria-hidden="true"></div>
      <div class="auth-art-dust" aria-hidden="true"></div>
    </div>
    <div class="auth-surface">
      ${button("×", "close-auth", "", "ghost", 'data-auth-dismiss aria-label="关闭登录弹窗"')}
      <nav class="auth-tabs" aria-label="登录与注册">
        ${button("登录", "auth-mode", "login", "ghost", `aria-current="${mode === "login" ? "page" : "false"}"`)}
        ${button("注册", "auth-mode", "register", "ghost", `aria-current="${mode === "register" ? "page" : "false"}"`)}
      </nav>
      <h2 id="auth-title">${heading}</h2>
      ${mode === "bootstrap" ? '<p class="meta">用你填写的邮箱作为管理员账号，设置至少 8 位的密码。</p>' : ""}
      ${authContinuation && ["image", "image-edit", "poster"].includes(ui.route) ? '<p class="meta">登录后可带入当前草稿，继续核对生成费用。</p>' : ""}
      <form class="stack" id="auth-form" data-mode="${mode}">
        ${["register","bootstrap"].includes(mode) ? '<label class="field">用户名<input class="input" name="name" autocomplete="nickname" minlength="2" maxlength="28" required></label>' : ""}
        ${mode === "login" ? '<label class="field">账号<input class="input" name="account" autocomplete="username" placeholder="邮箱或管理员账号" maxlength="120" required></label>' : '<label class="field">邮箱账号<input type="email" class="input" name="email" autocomplete="username" maxlength="120" required></label>'}
        ${mode === "register" ? '<label class="field">邀请码<input class="input" name="invite" maxlength="80" required></label>' : ""}
        ${verify ? `<div class="auth-code"><label class="field">邮箱验证码<input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label>${button("发送验证码", "send-auth-code")}</div>` : ""}
        <div class="field"><label for="auth-password">${mode === "reset" ? "新密码" : "密码"}</label><div class="password-wrap"><input id="auth-password" type="password" class="input" name="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="${mode === "login" ? 1 : 8}" maxlength="128" required>${button("显示", "toggle-password", "", "ghost", 'aria-label="显示密码" aria-pressed="false"')}</div></div>
        <p class="status-line" role="status" aria-live="polite"></p><button class="btn btn-primary auth-submit">${submit}</button>
      </form>
      <div class="auth-links">${mode === "login" ? button("找回密码", "auth-mode", "reset", "ghost") : button("返回登录", "auth-mode", "login", "ghost")}</div>
      ${needsAdmin && mode === "login" ? button("初始化本地管理员", "auth-mode", "bootstrap", "ghost") : ""}
      ${localMail && verify ? '<p class="meta">本地验证码保存在 mail-outbox 文件夹。</p>' : ""}
    </div>
  </div>`;
}

function closeAuth() {
  if (authBusy) return;
  authNext = "";
  authContinuation = null;
  authDialog.close();
}

authDialog.addEventListener("cancel", event => {
  event.preventDefault();
  closeAuth();
});

function captureGuestDraft() {
  const defaults = initialState();
  initializeImageGeneration(defaults.image, {});
  const changes = (draft, base, keys) => Object.fromEntries(keys
    .filter(key => JSON.stringify(draft[key]) !== JSON.stringify(base[key]))
    .map(key => [key, draft[key]]));
  const imageFields = ["tool", "prompt", "ratio", "resolution", "width", "height", "model"];
  return {
    homePrompt: ui.homePrompt, homeMode: ui.homeMode, chatPrompt: ui.guestChatPrompt, chatTextOnly: ui.guestChatTextOnly,
    generation: changes(imageGeneration(), defaults.image.generation, [...imageFields, "count", "formats"]),
    edit: changes(state.image, defaults.image, [...imageFields, "expandDirection", "editSizeChosen", "editToolDrafts"]),
    poster: changes(state.poster, defaults.poster, ["title", "subtitle", "date", "prompt", "promptOnly", "preset", "model", "selected", "exports", "mode", "message", "languageModel"]),
    ppt: changes(state.ppt, defaults.ppt, ["brief", "level", "style", "model", "languageModel", "discussionDraft", "resolution", "searchMode"]),
    files: Object.entries(ui.file).filter(([, item]) => item?.localFile),
    regions: state.image.regions,
  };
}

function hasGuestDraft(draft) {
  return Boolean(draft.homePrompt || draft.chatPrompt || draft.files.length ||
    [draft.generation, draft.edit, draft.poster, draft.ppt].some(value => Object.keys(value).length));
}

function guestDraftConflicts(draft) {
  const current = captureGuestDraft();
  const conflicts = key => Object.entries(draft[key]).some(([field, value]) =>
    Object.hasOwn(current[key], field) && JSON.stringify(current[key][field]) !== JSON.stringify(value));
  return [
    (draft.homePrompt && current.homePrompt && draft.homePrompt !== current.homePrompt || draft.files.some(([slot]) => slot === "home" && ui.file.home)) && "首页",
    (conflicts("generation") || draft.files.some(([slot]) => slot.startsWith("generation-reference") && ui.file[slot])) && "生图",
    (conflicts("edit") || draft.files.some(([slot]) => (slot === "image" || slot.startsWith("reference")) && ui.file[slot])) && "图片编辑",
    (conflicts("poster") || draft.files.some(([slot]) => (slot.startsWith("poster-") || ["logo", "qr"].includes(slot)) && ui.file[slot])) && "海报",
    (conflicts("ppt") || draft.files.some(([slot]) => /^ppt\d*$/.test(slot) && ui.file[slot])) && "PPT"
  ].filter(Boolean);
}

async function restoreGuestDraft(draft) {
  const owner = identity;
  const imported = draft.imported ||= new Map();
  try {
    for (const [, item] of draft.files) {
      if (!imported.has(item.localFile)) imported.set(item.localFile, await storeFile(item.localFile, owner));
      if (owner !== identity) return false;
    }
  } catch (error) {
    if (owner === identity) notify(`草稿素材未带入。${error.message} 可再点「带入登录前的草稿」。`);
    return false;
  }
  if (draft.homePrompt || draft.files.some(([slot]) => slot === "home")) {
    ui.homePrompt = draft.homePrompt;
    ui.homeMode = draft.homeMode;
    saveHomeComposer();
  }
  if (draft.chatPrompt) workspaceCommercial.seedChatDraft(draft.chatPrompt, {textOnly: draft.chatTextOnly});
  Object.assign(imageGeneration(), draft.generation);
  Object.assign(state.image, draft.edit);
  Object.assign(state.poster, draft.poster);
  Object.assign(state.ppt, draft.ppt);
  if (draft.ppt.brief !== undefined || draft.files.some(([slot]) => /^ppt\d*$/.test(slot))) {
    state.ppt.stage = 0;
    state.ppt.maxStage = 0;
  }
  for (const [slot, item] of draft.files) {
    assignFile(slot, imported.get(item.localFile));
  }
  if (draft.files.some(([slot]) => slot === "image") && ui.file.image?.id) {
    delete state.image.source;
    state.image.selection = null;
    state.image.text = "";
    state.image.regions = (draft.regions || []).map(region => {
      const original = draft.files.find(([, item]) => item.url === region.referenceId)?.[1];
      return {...region, referenceId: imported.get(original?.localFile)?.id || ""};
    });
    ui.selecting = state.image.tool === "mask";
  }
  await saveNow();
  if (owner === identity) ui.guestImport = null;
  return owner === identity;
}

function importGuestDraft() {
  const draft = ui.guestImport;
  if (!draft || ui.importingGuest) return;
  const apply = async () => {
    ui.importingGuest = true;
    try {
      await restoreGuestDraft(draft);
    } finally {
      ui.importingGuest = false;
      render();
    }
  };
  const conflicts = guestDraftConflicts(draft);
  if (!conflicts.length) return apply();
  openModal("带入登录前的草稿", `${conflicts.join("、")}有已保存的内容。`,
    "确认后使用登录前改过的字段和素材。取消可继续账号草稿，稍后仍能带入。", "带入草稿", apply);
}
function renderAccountIdentity() {
  document.querySelector("#guest-login").hidden = Boolean(account);
  document.querySelector("#sidebar-name").textContent = account?.name || "访客体验";
  document.querySelector("#sidebar-role").textContent = account?.role === "admin" ? "管理员" : account ? "个人工作区" : "登录后保存作品";
  document.querySelector("#admin-nav").hidden = account?.role !== "admin";
  document.querySelector(".sidebar-account").setAttribute("aria-controls", account ? "account-dialog" : "auth-dialog");
  const initial = Array.from(account?.name || "访")[0];
  for (const avatar of document.querySelectorAll("#sidebar-avatar, [data-account-avatar]")) {
    if (!account?.avatarUrl) avatar.textContent = initial;
    else if (avatar.firstElementChild?.getAttribute("src") !== account.avatarUrl) {
      const photo = document.createElement("img");
      photo.alt = "";
      photo.src = account.avatarUrl;
      avatar.replaceChildren(photo);
    }
  }
  const heading = accountDialog.querySelector("#account-title");
  if (heading && account) heading.textContent = account.name;
  const remove = accountDialog.querySelector('[data-action="account-avatar-remove"]');
  if (remove) remove.hidden = !account?.avatarUrl;
}

function openAccount() {
  if (!account) return openAuth();
  if (accountDialog.open) return;
  accountDialog.innerHTML = `<header class="account-header">
    <span class="avatar" data-account-avatar aria-hidden="true"></span><h2 id="account-title"></h2>
    ${button("×", "close-account", "", "ghost", 'aria-label="关闭账号弹窗" autofocus')}
  </header>
  <div class="account-tabs" role="group" aria-label="账号选项">
    ${[["profile", "个人资料"], ["password", "修改密码"], ["usage", "积分消耗"], ["upscale", "超分设置"]].map(([key, label]) => button(label, "account-section", key, "ghost", `aria-controls="account-${key}" aria-pressed="${key === "profile"}"`)).join("")}
  </div>
  <section class="account-section stack" id="account-profile" data-account-section="profile" aria-label="个人资料">
    <div class="account-avatar-row"><span class="avatar" data-account-avatar aria-hidden="true"></span>
      <div><div class="account-avatar-actions">
        ${button("上传头像", "account-avatar-pick")}
        ${button("移除头像", "account-avatar-remove", "", "ghost")}
        <input type="file" id="account-avatar-input" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden>
      </div><p class="meta">PNG、JPG 或 WebP，最大 5 MB。</p></div>
    </div>
    <p id="account-avatar-status" class="status-line" role="status"></p>
    <form class="stack" id="profile-form">
      <label class="field">显示名称<input class="input" name="name" autocomplete="nickname" minlength="2" maxlength="28" value="${esc(account.name)}" required></label>
      <label class="field">登录账号<input class="input" value="${esc(account.login || account.email)}" readonly></label>
      <p class="status-line" role="status"></p><button class="btn btn-primary">保存名称</button>
    </form>
  </section>
  <section class="account-section" id="account-password" data-account-section="password" aria-label="修改密码" hidden>
    <form class="stack" id="password-form">
      <label class="field">当前密码<input class="input" name="current" type="password" autocomplete="current-password" maxlength="128" required></label>
      <label class="field">新密码<input class="input" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
      <label class="field">确认新密码<input class="input" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
      <p class="status-line" role="status"></p><button class="btn btn-primary">更新密码</button>
    </form>
  </section>
  <section class="account-section stack" id="account-usage" data-account-section="usage" aria-label="积分消耗" hidden>
    <div class="account-usage-summary">
      <div><span class="meta">可用积分</span><strong class="num" id="account-balance"></strong></div>
      <div><span class="meta">累计已结算消耗</span><strong class="num" id="account-spent"></strong></div>
    </div>
    <p id="account-usage-status" class="status-line" role="status"></p>
    <table class="ds-table account-ledger" aria-label="最近积分明细"><thead><tr><th>时间</th><th>事项</th><th>积分</th></tr></thead><tbody id="account-ledger"></tbody></table>
    <p class="meta" id="account-ledger-empty" hidden>暂无积分明细。</p>
    ${button("查看积分明细", "account-credit-details")}
  </section>
  <section class="account-section stack" id="account-upscale" data-account-section="upscale" aria-label="超分设置" hidden>
    <p class="meta" data-upscale-local-status></p>
    <p class="meta" data-upscale-local-install hidden>在项目文件夹双击「安装可选本地超分.cmd」，确认后下载并检查 Vulkan 显卡。跳过安装仍可使用其他工作台功能。</p>
    <a data-upscale-engine-link class="btn btn-ghost" target="_blank" rel="noopener noreferrer" hidden>下载本地引擎</a>
    <form class="stack" id="upscale-settings-form">
      <p class="meta" data-upscale-cloud-status></p>
      <a data-upscale-key-link class="btn btn-ghost" target="_blank" rel="noopener noreferrer" hidden>前往百炼获取 API Key</a>
      <label class="field">北京地域 API Key<input class="input" name="key" type="password" autocomplete="off" maxlength="4096" required></label>
      <div class="row"><button class="btn btn-primary">保存 API Key</button>
        ${button("移除 API Key", "clear-upscale-key", "", "ghost", 'data-upscale-key-remove hidden')}</div>
      <p class="status-line" role="status"></p>
    </form>
  </section>
  <footer class="account-footer">${button("退出登录", "logout", "", "ghost")}</footer>`;
  accountDialog.querySelector("#account-avatar-input").addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) saveAccountAvatar(file);
  });
  renderAccountIdentity();
  updateAccountUsage();
  accountDialog.showModal();
}

function updateAccountUsage() {
  const current = accountDialog.querySelector("#account-balance");
  if (!current) return;
  current.textContent = points(available());
  accountDialog.querySelector("#account-spent").textContent = points(state.spent);
  accountDialog.querySelector("#account-ledger").innerHTML = walletRows(state.ledger.slice(0, 5));
  accountDialog.querySelector(".account-ledger").hidden = !state.ledger.length;
  accountDialog.querySelector("#account-ledger-empty").hidden = Boolean(state.ledger.length);
}

async function showAccountSection(section) {
  for (const control of accountDialog.querySelectorAll('[data-action="account-section"]')) {
    control.setAttribute("aria-pressed", active(control.dataset.value === section));
  }
  for (const panel of accountDialog.querySelectorAll("[data-account-section]")) panel.hidden = panel.dataset.accountSection !== section;
  if (section === "upscale") return refreshUpscaleSettings();
  if (section !== "usage") return;
  const owner = identity;
  const status = accountDialog.querySelector("#account-usage-status");
  status.textContent = "正在刷新积分…";
  try {
    await queueWrite(async () => {
      if (owner !== identity || !status.isConnected) return;
      const result = await api("profile/usage");
      if (owner !== identity) return;
      updateWallet(result);
      balance.textContent = points(available());
    });
    status.textContent = "";
  } catch (error) { status.textContent = error.message; }
}

async function saveAccountAvatar(file) {
  const owner = identity;
  const status = accountDialog.querySelector("#account-avatar-status");
  const controls = [...accountDialog.querySelectorAll('[data-action="account-avatar-pick"], [data-action="account-avatar-remove"]')];
  for (const control of controls) control.disabled = true;
  status.textContent = file ? "正在上传头像…" : "正在移除头像…";
  try {
    if (file && (!file.size || file.size > 5 * 1024 * 1024)) throw new Error("请选择不超过 5 MB 的有效图片。");
    const result = await api("profile/avatar", file ? "PUT" : "DELETE", file);
    if (owner !== identity) return;
    account.avatarUrl = result.avatarUrl;
    renderAccountIdentity();
    status.textContent = file ? "头像已保存。" : "头像已移除。";
  } catch (error) {
    const message = error.status === 404 ? "当前后台版本还不支持头像设置。请停止旧工作台，重新启动后再试。" : error.message;
    if (status.isConnected) status.textContent = message;
    else if (owner === identity) notify(message);
  }
  finally { for (const control of controls) control.disabled = false; }
}

function isAccountBackdrop(event) {
  if (event.target !== accountDialog) return false;
  const {left, right, top, bottom} = accountDialog.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

let accountBackdropPressed = false;
accountDialog.addEventListener("pointerdown", event => { accountBackdropPressed = isAccountBackdrop(event); });
accountDialog.addEventListener("click", event => {
  if (accountBackdropPressed && isAccountBackdrop(event)) accountDialog.close();
  accountBackdropPressed = false;
});
accountDialog.addEventListener("close", () => { if (!accountDialog.open) accountDialog.replaceChildren(); });
const adminSections = [
  ["models", "模型中心"],
  ["users", "用户管理"],
  ["templates", "模板管理"],
  ["access", "邀请码与积分"],
  ["policy", "生图规则"],
  ["queue", "任务设置"],
  ["storage", "聊天记录与存储"],
  ["tasks", "任务记录"],
  ["audit", "操作记录"]
];

function activeAdminSection() {
  const section = location.hash.slice(1);
  return adminSections.some(([id]) => id === section) ? section : "models";
}

function adminUsersView() {
  const rows = ui.users.map(user => `<tr data-user-search="${esc((user.name + " " + user.email).toLowerCase())}">
    <td><b>${esc(user.name)}</b><br><span class="meta">${esc(user.email)}</span></td><td>${user.role === "admin" ? "管理员" : user.active ? "正常" : "已停用"}</td>
    <td class="num">${points(user.points)}</td><td>${user.assets}</td><td><div class="row admin-user-actions">
      ${user.role !== "admin" ? button("编辑", "manage-user", `edit:${user.id}`) + button("重置密码", "manage-user", `password:${user.id}`, "ghost") : ""}
      ${button("调整积分", "manage-user", `credits:${user.id}`, "ghost")}
      ${user.role !== "admin" ? button(user.active ? "停用" : "启用", "user-status", user.id, "ghost") +
        button("删除", "user-delete", user.id, "ghost") : ""}
    </div></td></tr>`).join("");
  return `<section class="commercial-admin admin-users" aria-labelledby="admin-users-title">
    <div class="row-between"><div><h2 id="admin-users-title">用户管理</h2><p class="meta">${ui.users.length} 个账号</p></div>
      <div class="row">${button("刷新", "refresh-users", "", "ghost")}${button("添加用户", "manage-user", "create", "primary")}</div></div>
    <label class="field admin-user-filter">查找用户<input class="input" type="search" data-field="user-filter" placeholder="按用户名或邮箱查找"></label>
    <div class="table-wrap admin-users-table" tabindex="0" aria-label="用户列表">
      <table class="ds-table admin-table"><thead><tr><th>用户</th><th>状态</th><th>积分</th><th>素材</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="meta admin-users-empty" data-user-empty ${rows ? "hidden" : ""}>${rows ? "没有匹配的用户。" : "暂无账号。"}</p>
    </div></section>`;
}

const adminUserDialog = document.querySelector("#admin-user-dialog");
adminUserDialog.addEventListener("close", () => { if (!adminUserDialog.open) adminUserDialog.replaceChildren(); });
adminUserDialog.addEventListener("cancel", event => {
  if (adminUserDialog.querySelector('[aria-busy="true"]')) event.preventDefault();
});

function openAdminUserForm(value) {
  const [mode, id] = value.split(":");
  const titles = {create: "添加用户", edit: "编辑用户", password: "重置密码", credits: "调整积分"};
  const user = ui.users.find(item => item.id === Number(id));
  if (!Object.hasOwn(titles, mode) || (mode !== "create" && !user)) return;
  const fields = mode === "create" || mode === "edit" ? `
    <label class="field">用户名<input class="input" name="name" minlength="2" maxlength="28" required value="${esc(user?.name || "")}"></label>
    <label class="field">邮箱账号<input class="input" name="email" type="email" autocomplete="username" maxlength="120" required value="${esc(user?.email || "")}"></label>` : "";
  const password = mode === "create" || mode === "password" ? `
    <label class="field">${mode === "create" ? "初始密码" : "新密码"}<input class="input" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>` : "";
  const credits = mode === "credits" ? `
    <label class="field">调整数额<input class="input" type="number" step="${POINT_STEP}" min="-10000" max="10000" name="amount" placeholder="正数增加，负数扣减" required></label>
    <label class="field">调整原因<input class="input" name="reason" minlength="2" maxlength="80" required></label>` : "";
  const hint = {edit: "邮箱变更后，该用户需用新邮箱重新登录。", password: "重置后，该用户的已登录会话会退出。", credits: "调整会写入用户的积分明细。"}[mode];
  adminUserDialog.innerHTML = `<div class="stack"><div><h2 id="admin-user-title">${titles[mode]}</h2>
    ${user ? `<p class="meta">${esc(user.name)} · ${esc(user.email)}</p>` : ""}</div>
    <form class="stack" id="admin-user-form" method="post" data-mode="${mode}" data-user-id="${user?.id || ""}">
      ${fields}${password}${credits}${hint ? `<p class="meta">${hint}</p>` : ""}
      <p class="status-line" role="status"></p>
      <div class="row">${button("取消", "close-admin-user", "", "secondary")}<button class="btn btn-primary">${mode === "edit" ? "保存修改" : titles[mode]}</button></div>
    </form></div>`;
  adminUserDialog.showModal();
  adminUserDialog.querySelector("input")?.focus();
}

function adminView() {
  if (account?.role !== "admin") {
    return page("后台设置", '<p class="empty">此页面供管理员登录后使用。</p>', "admin");
  }
  const section = activeAdminSection();
  const views = {
    models: () => workspaceCommercial.adminPanel(),
    users: adminUsersView,
    templates: () => workspaceProjects.adminPanel(),
    access: () => opsView("access"),
    policy: adminPolicyView,
    queue: () => opsView("queue"),
    storage: adminStorageView,
    tasks: () => opsView("tasks"),
    audit: () => opsView("audit")
  };
  return `<section class="ops-shell" aria-labelledby="ops-title">
    <header class="row-between ops-heading"><h1 id="ops-title" tabindex="-1">后台设置</h1>
      <a class="btn btn-secondary ops-back" href="/#home"><span aria-hidden="true">←</span> 返回工作台首页</a></header>
    <aside class="ops-sidebar">
      <nav class="ops-nav" aria-label="后台设置菜单">
        ${adminSections.map(([id, label]) => `<div class="ops-nav-group">
          <a class="ops-nav-link" href="#${id}"${section === id ? ' aria-current="page"' : ""}>${label}</a>
          ${id === "models" && section === id ? workspaceCommercial.adminNavigation() : ""}
        </div>`).join("")}
      </nav>
    </aside>
    <div class="ops-content" id="ops-content">${views[section]()}</div>
  </section>`;
}

function adminStorageView() {
  const storage = ui.storage;
  return `<section class="card commercial-admin stack" aria-label="聊天记录与存储">
    <div><h2>聊天记录与存储</h2><p class="meta">AI 对话、PPT 和海报的聊天记录与摘要会自动保存到本地，关闭后仍可继续使用。</p></div>
    ${storage ? `<label class="field">当前保存文件夹<input class="input" readonly value="${esc(storage.directory)}"></label>
      <label class="field">聊天记录与摘要数据库<input class="input" readonly value="${esc(storage.database)}"></label>
      <p class="meta">这里显示正在使用的保存位置，无需另外创建聊天记录文件。压缩只整理发送给模型的内容，不会删除原始记录。</p>
      <p class="meta">备份时，请先正常关闭本地工作台服务，再复制整个保存文件夹；其中也包含项目、素材和服务连接配置，请妥善保管。</p>`
      : '<p class="meta" role="status">正在读取保存位置…</p>'}
  </section>`;
}

function adminPolicyView() {
  const policy = ui.imagePolicy;
  return `<section class="card commercial-admin stack" aria-label="生图规则">
    <div><h2>生图规则</h2><p class="meta">统一应用于图片生成、改图、海报主视觉和 PPT 页面。</p></div>
    ${policy ? `<form class="stack" id="image-policy-form">
      <label class="commercial-check"><input type="checkbox" name="enabled" role="switch"${policy.enabled ? " checked" : ""}>启用生图规则</label>
      <label class="field">内置系统提示词<textarea class="textarea" readonly rows="7">${esc(policy.systemPrompt)}</textarea></label>
      <p class="meta">启用后，服务端先检查用户描述，再把规则随生成请求发送。关闭后将停用本站的这层规则。</p>
      <div class="row"><button class="btn btn-primary">保存生图规则</button><span class="meta" role="status"></span></div>
    </form>` : '<p class="meta" role="status">正在加载规则…</p>'}
  </section>`;
}

const views = {
  home: homeView, tools: toolView, image: generationView, "image-edit": imageView, poster: posterView, ppt: pptView,
  projects: workspaceProjects.view, assets: assetsView, credits: creditsView, admin: adminView,
  chat: workspaceCommercial.chatView, jobs: jobsView,
  scenes: workspaceProjects.templatesView
};
function render() {
  document.body.classList.remove("booting");
  document.body.dataset.route = ui.route;
  const railScroll = content.querySelector("[data-studio-asset-rail]")?.scrollLeft || 0;
  const fieldScroll = content.querySelector(".studio-control-fields")?.scrollTop || 0;
  const galleryScroll = content.querySelector(".studio-gallery")?.scrollTop || 0;
  const editScroll = Array.from(content.querySelectorAll("[data-edit-scroll]"), node => node.scrollTop);
  const posterScroll = new Map(Array.from(content.querySelectorAll("[data-poster-scroll]"), node =>
    [node.dataset.posterScroll, [node.scrollLeft, node.scrollTop]]));
  mediaItems.clear();
  content.innerHTML = views[ui.route]();
  if (ui.route === "image") {
    window.AnimationComposer?.bind(content);
    const rail = content.querySelector("[data-studio-asset-rail]");
    if (rail) rail.scrollLeft = railScroll;
    content.querySelector(".studio-control-fields").scrollTop = fieldScroll;
    content.querySelector(".studio-gallery").scrollTop = galleryScroll;
    syncStudioAssetArrows();
  }
  if (ui.route === "image-edit") {
    content.querySelectorAll("[data-edit-scroll]").forEach((node, index) => { node.scrollTop = editScroll[index] || 0; });
    updateEditDimensions(content.querySelector("[data-edit-original] > .uploaded-art > img"));
  }
  if (ui.route === "poster") content.querySelectorAll("[data-poster-scroll]").forEach(node =>
    node.scrollTo(...(posterScroll.get(node.dataset.posterScroll) || [0, 0])));
  workspaceMedia.setItems(mediaItems);
  content.removeAttribute("aria-busy");
  balance.textContent = points(available());
  balance.closest("a").hidden = !account;
  document.querySelector("#page-label").textContent = routeLabels[ui.route];
  renderAccountIdentity();
  document.querySelectorAll("[data-nav]").forEach(link => {
    if (link.dataset.nav === ui.route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (ui.route === "tools") filterTools();
  if (ui.route === "assets") filterAssets();
}
function closeMenu() {
  document.body.classList.remove("menu-open");
  document.querySelector(".menu-button").setAttribute("aria-expanded", "false");
}
async function refreshRoute() {
  const owner = identity;
  try {
    if (["image","image-edit","poster","ppt"].includes(ui.route)) {
      const route = ui.route;
      const old = JSON.stringify(live.models);
      await live.catalog();
      if (owner === identity && route === ui.route && old !== JSON.stringify(live.models)) render();
      if (owner === identity && ["ppt", "poster"].includes(route) && ui.route === route) await workspaceProjects.refresh(route);
    }
    if (ui.route === "admin" && account?.role === "admin") {
      const section = activeAdminSection();
      if (section === "models") await workspaceCommercial.refresh("admin");
      if (section === "templates") await workspaceProjects.refresh("admin");
      if (section === "policy") {
        const policy = await api("admin/image-policy");
        if (owner === identity && ui.route === "admin" && activeAdminSection() === section) {
          ui.imagePolicy = policy;
          const detail = document.querySelector("#ops-content");
          if (detail) detail.innerHTML = adminPolicyView();
        }
      }
      const endpoint = {users: "users", tasks: "jobs", audit: "audit", queue: "generation-settings", storage: "storage"}[section];
      if (endpoint) {
        const result = await api(`admin/${endpoint}`);
        if (owner !== identity || ui.route !== "admin" || section !== activeAdminSection()) return;
        if (section === "users") ui.users = result.items || [];
        else if (section === "queue") ui.generationSettings = result;
        else if (section === "storage") ui.storage = result;
        else (live.operations ||= {jobs: [], audit: []})[endpoint] = result.items || [];
        const detail = document.querySelector("#ops-content");
        if (detail) {
          const filter = detail.querySelector('[data-field="user-filter"]')?.value;
          const scroll = detail.querySelector(".admin-users-table");
          const top = scroll?.scrollTop || 0;
          const left = scroll?.scrollLeft || 0;
          detail.innerHTML = section === "users" ? adminUsersView() : section === "storage" ? adminStorageView() : opsView(section);
          if (filter) {
            const input = detail.querySelector('[data-field="user-filter"]');
            input.value = filter;
            input.dispatchEvent(new Event("input", {bubbles: true}));
          }
          detail.querySelector(".admin-users-table")?.scrollTo(left, top);
        }
      }
    } else if (["projects", "scenes"].includes(ui.route)) {
      await workspaceProjects.refresh(ui.route);
    } else if (ui.route === "chat") {
      await workspaceCommercial.refresh("chat");
    } else if (["jobs", "ppt", "poster"].includes(ui.route) && account) {
      await refreshJobs();
    } else if (ui.route === "assets" && account) {
      const previous = JSON.stringify(ui.files);
      await refreshFiles();
      if (owner === identity && ui.route === "assets" && previous !== JSON.stringify(ui.files)) render();
    } else if (ui.route === "credits" && account) {
      await queueWrite(async () => {
        const result = await api("profile/usage");
        if (owner === identity) {
          updateWallet(result);
          balance.textContent = points(available());
          if (ui.route === "credits") {
            document.querySelector("#wallet-balance").textContent = points(available());
            document.querySelector("#wallet-usage").textContent = points(state.spent);
            document.querySelector("#wallet-ledger").innerHTML = walletRows();
          }
        }
      });
    }
  } catch (error) { notify(error.message); }
}
function syncRoute() {
  const legacyAccount = location.pathname === "/" && location.hash === "#account";
  if (legacyAccount) {
    history.replaceState(null, "", "/#" + ui.route);
    if (!document.body.classList.contains("booting")) return openAccount();
  }
  const authEntry = !account && authPaths[location.pathname];
  const wantsAdmin = authEntry && new URLSearchParams(location.search).get("next") === "admin";
  if (authEntry) history.replaceState(null, "", "/" + location.hash);
  let lockedRoute = "";
  if (location.pathname === "/admin" && account?.role === "admin") {
    ui.route = "admin";
  } else {
    const name = location.hash.slice(1);
    if (name === "admin" && account?.role === "admin") {
      location.replace("/admin");
      return;
    }
    if (!account && Object.hasOwn(routeLabels, name) && !publicRoutes.has(name)) {
      lockedRoute = name;
      const background = publicRoutes.has(ui.route) ? ui.route : "home";
      history.replaceState(null, "", "/#" + background);
      ui.route = background;
    } else {
      if (name === "admin") history.replaceState(null, "", "/#home");
      ui.route = name !== "admin" && Object.hasOwn(routeLabels, name) ? name : "home";
    }
  }
  if (ui.route === "image-edit" && isGenerationTool(state.image.tool)) {
    imageGeneration();
    state.image.tool = "mask";
  }
  closeMenu();
  if (saveDirty) flushSave();
  render();
  window.scrollTo(0, 0);
  refreshRoute();
  if (account && ui.route !== "jobs") scheduleJobs(0);
  if (authEntry || lockedRoute) openAuth(authEntry || "login", wantsAdmin ? "admin" : lockedRoute);
  else if (legacyAccount) openAccount();
}
function openTool(id) {
  if (isGenerationTool(id)) id = "text";
  if (!tools.some(tool => tool.id === id)) return;
  const generation = isGenerationTool(id);
  if (generation) {
    ui.studioFormat = "still";
  } else {
    imageGeneration();
    switchEditTool(state.image, id);
    ui.editTab = "annotations";
    ui.selecting = id === "mask" && Boolean(ui.file.image?.url || state.image.source);
    ui.imageView = "原图";
    const panel = content.querySelector(".edit-controls-scroll");
    if (panel) panel.scrollTop = 0;
  }
  state.image.lastWorkspace = generation ? "generate" : "edit";
  save();
  go(generation ? "image" : "image-edit");
}
function imageDescriptor(key) {
  const file = imageCandidateFile(key);
  if (file?.url) return { url: file.url, name: file.name, file };
  if (key.startsWith("local:")) return null;
  const size = state.image.outputs[key];
  return sampleDescriptor(key, size && size.width / size.height, size);
}
async function cropImage(size) {
  if (ui.uploading) return notify("正在处理图片，请稍等。");
  const owner = identity;
  const draft = state.image;
  const uploaded = ui.file.image;
  const originalKey = draft.source;
  const source = uploaded || (originalKey && imageDescriptor(originalKey));
  if (!source) return notify("请重新选择原图。");
  const sourceIsCurrent = () => owner === identity && draft === state.image &&
    uploaded?.id === ui.file.image?.id && originalKey === draft.source;
  ui.uploading = true;
  try {
    let sourceAsset = uploaded;
    if (!sourceAsset?.id) {
      const blob = await workspaceMedia.getBlob(source);
      if (!sourceIsCurrent()) return;
      const name = (source.name || "示例原图").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
      sourceAsset = await storeFile(new File([blob], name + (imageExtensions[blob.type] || ".png"), {type: blob.type}), owner, true);
      if (!sourceAsset?.id || !sourceIsCurrent()) return;
    }
    const {asset} = await executeLocalImageTool("resize_image", {sourceId: sourceAsset.id, size: `${size.width}x${size.height}`});
    if (owner !== identity) return;
    const stored = {...asset, kind: "image", parentId: sourceAsset.id};
    ui.files = [stored, ...ui.files.filter(file => file.id !== stored.id)];
    if (!sourceIsCurrent()) return;
    if (!uploaded?.id) {
      assignFile("image", sourceAsset);
      delete draft.source;
    }
    const item = uploadDescriptor(stored);
    const key = "local:" + item.id;
    assignFile(key, item);
    state.image.candidates.push(key);
    state.image.outputs[key] = size;
    if (!state.projects.includes("image")) state.projects.push("image");
    ui.picked = key;
    ui.imageView = "结果";
    save();
    ui.uploading = false;
    render();
    notify(`${size.width} × ${size.height} 已裁剪 · 0.00 积分`);
  } catch (error) { notify(error.message); }
  finally { if (owner === identity) ui.uploading = false; }
}

const promptDialog = document.createElement("dialog");
promptDialog.className = "prompt-review";
promptDialog.setAttribute("aria-labelledby", "prompt-review-title");
document.body.append(promptDialog);
const defaultPromptRules = {
  quick: "先保留主体、用途、指定文案和硬性约束，再补足主体位置、景别、空间层次、光线和材质。商品图优先还原包装与轮廓，海报优先处理标题、信息层级和留白。只添加能改善画面的具体描述，避免堆砌画质词。",
  directed: "把本次要求转化为可执行的画面变化，说明修改对象、位置和范围。保留未要求变化的主体、文案、色彩与构图。图生图时写清参考图中要保留的部分以及要替换的部分。"
};
const previousPromptRules = {
  quick: "保留用户指定的主体、产品特征、文案、版式和约束。只补充有助于出图的构图、光线和表现细节。",
  directed: "根据补充要求修改原提示词。保留没有被要求修改的内容，避免加入无关的视觉元素。"
};
let promptReview = null;

function promptRules() {
  try {
    const stored = JSON.parse(localStorage.getItem(`fengsha-prompt-rules:${account.id}`) || "{}");
    return Object.fromEntries(Object.entries(defaultPromptRules).map(([key, value]) =>
      [key, typeof stored?.[key] === "string" && stored[key] !== previousPromptRules[key] ? stored[key].slice(0, 2000) : value]));
  } catch { return {...defaultPromptRules}; }
}

function promptTarget() {
  if (ui.route === "poster") return {draft: state.poster, task: "poster", limit: 2000,
    referenceCount: posterReferences().length, size: "", posterContext: posterOptimizationContext()};
  const format = ui.route === "image" ? studioFormat() : "still";
  if (format !== "still") {
    const draft = nativeStudioDraft(format);
    const referenceCount = format === "gif" ? imageInputs(imageGeneration().tool).length : 0;
    const model = modelFor("image", nativeStudioCapability(format, referenceCount, draft), draft.model).selected;
    return {draft, task: format, limit: 3000, size: studioOutputSize(format, draft, model), referenceCount,
      animation: format === "gif" && validGifTiming(draft)
        ? {method: draft.method, frames: draft.frames, frameDurationMs: draft.duration} : undefined};
  }
  const draft = imageDraft();
  const size = outputSize(draft);
  return {draft, task: draft.tool, limit: 3000, size: size ? `${size.width}x${size.height}` : "",
    referenceCount: imageInputs(draft.tool).length};
}

function openPromptEditor(mode) {
  if (!requireAccount() || promptDialog.open) return;
  const target = promptTarget();
  const {draft, task, limit} = target;
  const prompt = (draft.prompt || "").trim();
  if (["quick", "directed"].includes(mode) && !prompt) return notify("先写一句画面描述，再优化提示词。");
  if (["quick", "directed"].includes(mode) && task === "gif" && (!target.size || !target.animation)) {
    return notify("请先确认每帧尺寸、帧数和每帧时长。");
  }
  const visual = task === "poster" && target.posterContext.assetIds.length > 0;
  const model = ["quick", "directed"].includes(mode) ? (
    (visual && modelFor("chat", ["text", "vision"], draft.languageModel).selected) ||
    modelFor("chat", "text", task === "poster" ? draft.languageModel : undefined).selected
  ) : null;
  if (["quick", "directed"].includes(mode) && !model) return notify("请先上架可用的语言模型。");
  promptReview = {mode, ...target, prompt, model, owner: identity, working: false};
  let fields, heading, footer;
  if (mode === "rules") {
    heading = "优化规则";
    const rules = promptRules();
    fields = `<div class="prompt-columns">${[["quick", "一键优化规则"], ["directed", "带要求的优化规则"]].map(([key, title]) =>
      `<label class="field">${title}<textarea class="textarea" name="${key}" maxlength="2000">${esc(rules[key])}</textarea></label>`).join("")}</div>`;
    footer = `<button type="button" class="btn btn-ghost" data-reset-prompt-rules>恢复默认</button><button class="btn btn-primary" value="save">保存规则</button>`;
  } else if (mode === "expand") {
    heading = "编辑画面描述";
    fields = `<label class="field">提示词<textarea class="textarea" name="suggestion" rows="12" maxlength="${limit}" autofocus>${esc(prompt)}</textarea></label>`;
    footer = `<button class="btn btn-primary" value="apply">保存提示词</button>`;
  } else {
    heading = mode === "directed" ? "带要求的优化" : "一键优化";
    fields = `<p class="meta">${esc(model.name)} · ${tokenRateText(model)}${task === "gif" ? " · 动作与循环" : task === "svg" ? " · 轮廓与配色" : task === "poster" ? " · 海报构图与留白" : ""}</p>
      ${visual ? `<p class="meta">${model.capabilities.includes("vision") ? "结合参考图外观优化" : "按素材名称和用途优化"}</p>` : ""}
      ${target.animation ? `<p class="meta">${esc(studioSizeText(target.size))} px · ${target.animation.frames} 帧 · 每帧 ${target.animation.frameDurationMs} 毫秒 · 共 ${gifDuration(draft)}</p>` : ""}
      ${mode === "directed" ? '<label class="field">你希望怎么改<textarea class="textarea" name="requirements" rows="2" maxlength="1000" placeholder="例如保留商品外观，只调整背景和光线" autofocus></textarea></label>' : ""}
      <div class="prompt-columns"><label class="field">原始提示词<textarea class="textarea" readonly>${esc(prompt)}</textarea></label>
      <label class="field">优化结果<textarea class="textarea" name="suggestion" maxlength="${limit}" placeholder="生成后可在这里继续编辑" disabled></textarea></label></div>`;
    footer = `<button class="btn btn-secondary" value="run">${mode === "directed" ? "开始优化" : "重新优化"}</button><button class="btn btn-primary" value="apply" disabled>应用优化结果</button>`;
  }
  promptDialog.innerHTML = `<form class="stack" method="dialog"><h2 id="prompt-review-title">${heading}</h2>${fields}
    <p class="meta" role="status"></p><div class="row"><button class="btn btn-ghost" value="cancel">关闭</button>${footer}</div></form>`;
  promptDialog.showModal();
  if (mode === "quick") return runPromptReview();
}

promptDialog.addEventListener("click", event => {
  if (!event.target.closest("[data-reset-prompt-rules]")) return;
  const form = promptDialog.querySelector("form");
  for (const [key, value] of Object.entries(defaultPromptRules)) form.elements[key].value = value;
});

promptDialog.addEventListener("submit", event => {
  event.preventDefault();
  const action = event.submitter?.value;
  const form = event.target;
  if (action === "cancel") return promptDialog.close();
  if (action === "run") return runPromptReview();
  if (!promptReview || promptReview.owner !== identity) return promptDialog.close();
  if (action === "save") {
    const rules = Object.fromEntries(Object.keys(defaultPromptRules).map(key => [key, form.elements[key].value.trim()]));
    try { localStorage.setItem(`fengsha-prompt-rules:${account.id}`, JSON.stringify(rules)); }
    catch { return notify("当前浏览器无法保存优化规则。"); }
    promptDialog.close();
    return notify("优化规则已保存。");
  }
  if (action !== "apply" || promptReview.draft !== promptTarget().draft) return promptDialog.close();
  const suggestion = form.elements.suggestion.value.trim().slice(0, promptReview.limit);
  if (promptReview.mode !== "expand" && !suggestion) {
    form.querySelector('[role="status"]').textContent = "请填写优化后的提示词。";
    return;
  }
  promptReview.draft.prompt = suggestion;
  save();
  promptDialog.close();
  render();
  content.querySelector("#image-prompt")?.focus({preventScroll: true});
});

async function runPromptReview() {
  const current = promptReview;
  if (!current || current.working) return;
  const {model, task, size, referenceCount, animation, posterContext, limit, owner, mode, prompt} = current;
  const form = promptDialog.querySelector("form");
  const output = form.elements.suggestion;
  const status = form.querySelector('[role="status"]');
  const run = form.querySelector('[value="run"]');
  const apply = form.querySelector('[value="apply"]');
  const requirements = form.elements.requirements?.value.trim() || "";
  if (mode === "directed" && !requirements) {
    status.textContent = "请先填写这次想调整的内容。";
    form.elements.requirements.focus();
    return;
  }
  current.working = true;
  run.disabled = apply.disabled = output.readOnly = true;
  output.disabled = false;
  const previous = output.value;
  output.value = "";
  status.textContent = "正在优化提示词…";
  try {
    const result = await streamLanguage("prompts/suggest", {
      prompt, mode: task, rules: promptRules()[mode], requirements,
      referenceCount, size, animation, ...posterContext, modelId: model.id,
      tokenRates: model.tokenRates, requestId: crypto.randomUUID()
    }, chunk => {
      if (!promptDialog.open || current !== promptReview) return;
      output.value = (output.value + chunk).slice(0, limit);
      output.scrollTop = output.scrollHeight;
    });
    if (identity !== owner) return;
    if (!promptDialog.open || current !== promptReview) return;
    output.value = result.prompt.slice(0, limit);
    status.textContent = tokenBillingText(result.billing);
    output.readOnly = apply.disabled = false;
    output.focus();
  } catch (error) {
    if (promptDialog.open && current === promptReview) {
      status.textContent = error.message;
      output.value = previous;
      if (previous.trim()) output.readOnly = apply.disabled = false;
    }
  } finally {
    current.working = false;
    run.disabled = false;
  }
}

const actions = {
  route: go,
  "open-tool": openTool,
  "studio-format": value => {
    if (ui.route !== "image" || !Object.hasOwn(studioFormats, value)) return;
    ui.studioFormat = value;
    content.querySelector(".studio-control-fields").scrollTop = 0;
    content.querySelector(".studio-gallery").scrollTop = 0;
    render();
    content.querySelector('[data-action="studio-format"][aria-pressed="true"]')?.focus({preventScroll: true});
  },
  "generate-native-image": requestNativeImage,
  "native-prompt-example": value => {
    const format = studioFormat();
    const example = studioFormatExamples[format]?.[Number(value)];
    if (!example) return;
    const apply = () => {
      nativeStudioDraft(format).prompt = example;
      save();
      render();
      content.querySelector("#image-prompt")?.focus({preventScroll: true});
    };
    if (nativeStudioDraft(format).prompt.trim()) return openModal("使用示例提示词", "", "将替换当前格式的提示词。", "使用示例", apply);
    apply();
  },
  "add-animation-asset": value => {
    const disclosure = content.querySelector(".studio-composer-disclosure");
    if (disclosure) disclosure.open = true;
    return window.AnimationComposer?.addAsset(value);
  },
  "scroll-studio-assets": value => {
    const rail = content.querySelector("[data-studio-asset-rail]");
    if (!rail) return;
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
    rail.scrollBy({left: Math.sign(Number(value)) * Math.max(96, rail.clientWidth * .8), behavior});
  },
  "toggle-sidebar": () => {
    const open = document.body.classList.toggle("menu-open");
    document.querySelector(".menu-button").setAttribute("aria-expanded", active(open));
  },
  "open-auth": () => openAuth(),
  "open-account": openAccount,
  "open-upscale-settings": () => {
    if (!requireAccount(actions["open-upscale-settings"])) return;
    openAccount();
    return showAccountSection("upscale");
  },
  "clear-upscale-key": clearUpscaleKey,
  "job-detail": openJobDetail,
  "close-job-detail": () => document.querySelector("#job-detail-dialog").close(),
  "check-upscale-result": checkUpscaleResult,
  "close-account": () => accountDialog.close(),
  "account-section": showAccountSection,
  "account-avatar-pick": () => accountDialog.querySelector("#account-avatar-input").click(),
  "account-avatar-remove": () => saveAccountAvatar(),
  "account-credit-details": () => { accountDialog.close(); go("credits"); },
  "close-auth": closeAuth,
  "auth-mode": mode => {
    if (authBusy) return;
    ui.authMode = mode;
    renderAuth();
    authDialog.querySelector("form input")?.focus();
  },
  "send-auth-code": async () => {
    const form = authDialog.querySelector("#auth-form");
    if (!form.elements.email.reportValidity()) return;
    const invite = form.elements.invite;
    if (invite && !invite.reportValidity()) return;
    const control = form.querySelector('[data-action="send-auth-code"]');
    control.disabled = true;
    try {
      await api("auth/code", "POST", {email: form.elements.email.value, purpose: form.dataset.mode, invite: invite?.value});
      form.querySelector('[role="status"]').textContent = localMail ? "已发送至本地 mail-outbox。" : "请查收验证码。";
    } finally { control.disabled = false; }
  },
  "toggle-password": () => {
    const input = authDialog.querySelector("#auth-password");
    const control = authDialog.querySelector('[data-action="toggle-password"]');
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    control.textContent = visible ? "隐藏" : "显示";
    control.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    control.setAttribute("aria-pressed", active(visible));
  },
  logout: async () => {
    try {
      await flushSave();
      await api("auth/logout", "POST", {});
      location.replace("/");
    } catch (error) { notify(error.message); }
  },
  "refresh-users": refreshRoute,
  "manage-user": openAdminUserForm,
  "close-admin-user": () => {
    if (!adminUserDialog.querySelector('[aria-busy="true"]')) adminUserDialog.close();
  },
  "user-delete": value => {
    const user = ui.users.find(item => item.id === Number(value));
    if (!user || user.role === "admin") return;
    openModal("删除用户？", `删除「${user.name}」（${user.email}）。`,
      "用户将退出且无法再登录。素材、任务、积分记录及邮箱占用会保留。", "删除用户", async () => {
        await api(`admin/users/${user.id}`, "DELETE");
        await refreshRoute();
        notify("用户已删除");
      });
  },
  "user-status": value => {
    const user = ui.users.find(item => item.id === Number(value));
    if (!user) return;
    const action = user.active ? "停用" : "启用";
    openModal(`${action}账号`, `${action} ${user.name} 的登录权限。`, user.active ? "该用户的已登录会话也会退出。" : "启用后，用户可以用原账号登录。", action, async () => {
      try {
        await api(`admin/users/${user.id}/status`, "POST", { active: !user.active });
        await refreshRoute();
        notify(`账号已${action}`);
      } catch (error) { notify(error.message); }
    });
  },
  "home-mode": value => {
    ui.homeMode = value;
    saveHomeComposer();
    render();
    content.querySelector(`[data-action="home-mode"][data-value="${value}"]`)?.focus({preventScroll: true});
  },
  "home-example": value => {
    const field = content.querySelector('[data-field="home"]');
    if (!field) return;
    const fill = () => { ui.homePrompt = field.value = value; saveHomeComposer(); field.focus(); };
    if (field.value.trim() && field.value !== value) return openModal("替换当前描述", "", "使用示例会替换输入框中的内容。", "使用示例", fill);
    fill();
  },
  "home-create": () => {
    if (ui.uploading) return notify("正在添加参考图，请稍等。");
    const brief = ui.homePrompt.trim();
    if (!account && ["chat", "ppt"].includes(ui.homeMode)) return openAuth("login", "", actions["home-create"]);
    if (ui.homeMode === "chat") {
      if (brief) workspaceCommercial.seedChatDraft(brief);
      return go("chat");
    }
    if (ui.homeMode === "poster") {
      const apply = () => {
        if (brief) state.poster.prompt = brief;
        rememberWorkbench("poster");
        save();
        go("poster");
      };
      if (brief && state.poster.prompt?.trim() && state.poster.prompt.trim() !== brief) {
        return openModal("替换海报的画面描述？", "将带入首页填写的完整描述。", "活动标题、参考素材和已生成的海报会保留。", "替换描述", apply);
      }
      return apply();
    }
    if (ui.homeMode === "ppt") {
      if (brief && brief !== state.ppt.brief) {
        state.ppt.brief = brief;
        state.ppt.stage = 0;
        state.ppt.maxStage = 0;
        save();
      }
      return go("ppt");
    }
    const draft = imageGeneration();
    const reference = ui.file.home;
    const addReference = reference && !generationReferenceSlots.some(slot => ui.file[slot]?.url === reference.url);
    const apply = () => {
      if (addReference) {
        const slot = availableReferenceSlots("image")[0];
        if (!slot) return notify("参考图位置已满。请从侧栏打开 AI 生图，移除旧图后再带入首页参考图。");
        assignFile(slot, reference);
      }
      if (brief) draft.prompt = brief;
      rememberWorkbench("image");
      openTool("text");
    };
    if (brief && draft.prompt?.trim() && draft.prompt.trim() !== brief) {
      return openModal("替换生图的画面描述？", "将带入首页填写的描述。", "原有参考图、生成设置和任务记录会保留。", "替换描述", apply);
    }
    return apply();
  },
  "import-guest-draft": importGuestDraft,
  "open-jobs": () => { rememberWorkbench("jobs"); go("jobs"); },
  category: value => { ui.category = value; render(); },
  "asset-filter": async value => {
    ui.assetType = value;
    if (value === "回收站" && account) live.trash = (await api("assets?trash=1")).items;
    render();
  },
  "asset-detail": value => { const file = ui.files.find(item => item.id === value); if (file) assetDetails(file); },
  "restore-file": async value => {
    await api(`assets/${value}/metadata`, "PUT", {trashed: false});
    await refreshFiles();
    live.trash = (await api("assets?trash=1")).items;
    render();
  },
  "reference-file": value => {
    const file = studioAssetList().find(item => item.id === value);
    if (!file) return;
    if (generationReferenceSlots.some(key => ui.file[key]?.id === file.id)) {
      if (ui.route !== "image") openTool("image");
      return notify("这张图已在参考图中。");
    }
    const slot = availableReferenceSlots("image")[0];
    if (!slot) return notify("没有空余的参考图位置。");
    assignFile(slot, uploadDescriptor(file));
    rememberWorkbench("image");
    if (ui.route === "image") {
      save();
      render();
    } else openTool("image");
    notify("已添加参考图。");
  },
  file: (value, single = false) => {
    if (ui.uploading) return notify("正在处理图片，请稍等。");
    if (["reference", "generation-reference"].includes(value) && !availableReferenceSlots(value === "reference" ? state.image.tool : "image").length) return notify("参考图位置不足，请移除旧图或切换模型。");
    ui.fileTarget = value;
    fileInput.value = "";
    fileInput.multiple = !single && ["reference", "generation-reference", "poster-reference", "library", "ppt"].includes(value);
    fileInput.accept = ["ppt", "library"].includes(value) ? documentExtensions.map(extension => "." + extension).concat(".png", ".jpg", ".jpeg", ".webp", ".gif").join(",") : "image/png,image/jpeg,image/webp,image/gif";
    fileInput.click();
  },
  "detach-file": value => {
    delete ui.file[value];
    delete state.uploads[value];
    if (value === "image") {
      delete state.image.source;
      state.image.text = "";
      workspaceRegions.reset();
      Object.assign(ui, {imageView: "原图", picked: "", selecting: false});
    }
    if (pptSlots.includes(value)) state.ppt.maxStage = 0;
    save();
    render();
  },
  "image-ratio": value => {
    const draft = imageDraft();
    const followSource = followsEditSource(draft);
    draft.ratio = value;
    if (["custom", "suggested"].includes(draft.resolution) || followSource) draft.resolution = "1K";
    if (ui.route === "image-edit") draft.editSizeChosen = true;
    save();
    render();
    content.querySelector(`[data-action="image-ratio"][data-value="${value}"]`)?.focus();
  },
  "image-quantity": value => {
    if (ui.route !== "image" || !["1", "2", "3", "4"].includes(value)) return;
    imageGeneration().count = Number(value);
    save();
    render();
    content.querySelector(`[data-action="image-quantity"][data-value="${value}"]`)?.focus({preventScroll: true});
  },
  "optimize-prompt": mode => openPromptEditor(mode === "directed" ? "directed" : "quick"),
  "prompt-rules": () => openPromptEditor("rules"),
  "expand-prompt": () => openPromptEditor("expand"),
  "edit-panel": value => {
    ui.editTab = value;
    ui.imageView = value === "results" && imageEditCandidates().length ? "结果" : "原图";
    render();
    const panel = content.querySelector(".edit-controls-scroll");
    if (panel) panel.scrollTop = 0;
    content.querySelector(`[data-action="edit-panel"][data-value="${value}"]`)?.focus({preventScroll: true});
  },
  "choose-image": value => {
    ui.picked = value;
    ui.imageView = value ? "结果" : "原图";
    ui.editTab = value ? "results" : "annotations";
    ui.selecting = !value && state.image.tool === "mask";
    render();
  },
  "edit-pick-asset": value => {
    const file = ui.files.find(item => item.id === value && item.mime.startsWith("image/"));
    if (file && ui.file.image?.id !== file.id) setEditSource(uploadDescriptor(file), true);
  },
  "generate-image": requestImage,
  "cancel-live-job": async id => {
    const owner = identity;
    const result = await api("jobs/" + id + "/cancel", "POST");
    if (owner !== identity) return;
    updateWallet(result);
    await refreshJobs();
    render();
  },
  "delete-live-job": id => {
    const job = live.jobs.find(item => item.id === id);
    if (!job) return;
    const owner = identity;
    openModal("删除生成记录", job.label,
      "排队任务会取消并释放预留积分。已开始的任务继续执行和结算。已生成的素材和积分明细仍可查看。",
      "删除记录", async () => {
        const result = await api("jobs/" + id, "DELETE");
        if (owner !== identity) return;
        updateWallet(result);
        live.hiddenJobs.add(id);
        await queueJobUpdate({jobs: live.allJobs.map(job => job.id === id ? result.job : job)}, owner);
        await refreshJobs();
        if (owner !== identity) return;
        notify("生成记录已删除。");
        render();
      });
  },
  "reconcile-job": id => openModal("确认上游任务失败", "确认 CPA 未交付结果后释放预留积分。", "确认前请按任务号核对 CPA。", "确认失败并释放", async () => {
    await api(`admin/jobs/${id}/failed`, "POST", {reason: "管理员已核实上游失败"});
    await refreshRoute();
  }),
  "recover-job": id => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const response = await fetch(`/api/admin/jobs/${id}/recover`, {method: "POST", body: file});
        if (!response.ok) throw new Error((await response.json()).error);
        notify("已补录原任务图片。");
        await refreshRoute();
      } catch (error) { notify(error.message); }
    };
    input.click();
  },
  "use-upload": value => {
    const item = ui.files.find(file => file.id === value && file.mime.startsWith("image/"));
    if (!item) return;
    return sendToEditor({file: uploadDescriptor(item)});
  },
  "remove-file": value => {
    const item = ui.files.find(file => file.id === value);
    if (!item) return;
    openModal("移入回收站", `从素材库隐藏「${item.name}」。`, "项目中的引用可能暂时不可用，可在回收站恢复。", "移入回收站", async () => {
      try {
        await api("assets/" + item.id, "DELETE");
        await refreshFiles();
        render();
        notify("素材已移入回收站。");
      } catch (error) { notify(error.message); }
    });
  },
  "export-image": value => {
    const key = value || ui.picked || state.image.adopted || imageEditCandidates()[0];
    const descriptor = key && imageDescriptor(key);
    if (descriptor) return workspaceMedia.download(descriptor);
  },
  "poster-preview": selectPosterFormat,
  "poster-tab": value => {
    state.poster.previewTab = value;
    save();
    render();
    content.querySelector(`[data-action="poster-tab"][data-value="${CSS.escape(value)}"]`)?.focus({preventScroll: true});
  },
  "poster-select-all": value => {
    state.poster.exports = value ? posterFormats.map(format => format.id) : [];
    save();
    render();
  },
  "poster-mode": value => { state.poster.mode = value; save(); render(); },
  "new-poster-project": () => workspaceProjects.switchPoster(),
  "poster-discuss": () => posterAdvisor(),
  "poster-new-chat": () => switchPosterChat(),
  "poster-plan": () => posterAdvisor(true),
  "poster-generate": createPosterVisual,
  "save-poster": () => outputPosters(true),
  "export-poster": () => outputPosters(false),
  "poster-download": value => {
    const result = posterResult(value);
    const descriptor = result?.asset && posterOutput(result.format, result.asset);
    if (descriptor) return workspaceMedia.download(descriptor);
  },
  "poster-edit": value => {
    const result = posterResult(value);
    const descriptor = result?.asset && posterOutput(result.format, result.asset);
    if (descriptor) return sendToEditor(descriptor);
  },
  "use-poster-product": value => {
    const item = ui.files.find(file => file.id === value && file.mime.startsWith("image/"));
    if (item) return sendToPoster({file: uploadDescriptor(item)});
  },
  "ppt-sample": () => {
    state.ppt.brief = "做一套 6 页的仓配协同项目简报。给管理层看，包含系统架构和下一步计划。";
    state.ppt.maxStage = 0;
    save();
    render();
  },
  "ppt-outline": makeOutline,
  "ppt-discuss": () => discussPpt(),
  "ppt-search-send": () => discussPpt(true),
  "ppt-new-chat": () => switchPptChat(),
  "ppt-open-templates": () => {
    if (!scopeInProgress("ppt")) workspacePptTemplates.open(state.ppt.style, actions["ppt-style"]);
  },
  "ppt-style": value => {
    const ppt = state.ppt;
    if (value === ppt.style || scopeInProgress("ppt")) return;
    const apply = () => {
      if (state.ppt !== ppt || scopeInProgress("ppt")) return;
      if (ppt.stage === 1) resetDeck();
      ppt.style = value;
      ppt.maxStage = ppt.stage;
      save();
      render();
      content.querySelector('[data-action="ppt-open-templates"]')?.focus({preventScroll: true});
    };
    if (ppt.stage === 1 && (ppt.boards.some(Boolean) || ppt.pages.some(Boolean) ||
        Object.keys(ppt.pageEdits).length || Object.keys(ppt.textboxes).length)) {
      return openModal("更换 PPT 模板？", `将改用「${value}」。`,
        "大纲保留。已有分镜和成稿仍可在素材中查看，本项目的逐页修改和文字框设置会清空。", "更换模板", apply);
    }
    apply();
  },
  "ppt-step": value => {
    if (scopeInProgress("ppt")) return notify("正在生成，请等待任务结算后再修改。");
    if (Number(value) > state.ppt.maxStage) return notify("请先完成当前步骤。");
    state.ppt.stage = Number(value);
    save();
    render();
  },
  "ppt-board": () => buildPptPages("board"),
  "ppt-slide": value => { state.ppt.active = Number(value); save(); render(); },
  "ppt-slide-step": value => stepPptSlide(Number(value)),
  "ppt-final": () => buildPptPages("final"),
  "ppt-redo": () => buildPptPages("redo"),
  "ppt-board-redo": () => buildPptPages("board-redo"),
  "ppt-ai-revise": revisePptPrompt,
  "ppt-apply-prompt": () => {
    const edit = pptPageEdit();
    if (!edit.suggestion?.trim()) return;
    edit.prompt = edit.suggestion.trim();
    edit.change = "";
    delete edit.suggestion;
    save();
    render();
  },
  "ppt-use-boards": adoptPptBoards,
  "ppt-use-asset": choosePptAsset,
  "ppt-upload-page": uploadPptPageImage,
  "ppt-export": value => savePpt(value === "editable"),
  "ppt-mark-text": markPptText,
  "studio-example": value => {
    const example = imageExamples[Number(value)];
    if (!example) return;
    imageGeneration().prompt = example[2];
    save();
    render();
    content.querySelector('[data-field="image-prompt"]')?.focus();
  },
  "close-modal": () => modal.close(),
  "confirm-modal": () => {
    const run = modalAction;
    modal.close();
    return run?.();
  }
};

document.addEventListener("click", event => {
  const target = event.target.closest("[data-action]");
  if (target && !target.disabled) {
    const action = target.dataset.action;
    let result;
    if (action.startsWith("c-")) result = workspaceCommercial.handle(action, target.dataset.value, event);
    else if (action.startsWith("p-")) result = workspaceProjects.handle(action, target.dataset.value, event);
    else if (action.startsWith("region-")) result = workspaceRegions.handle(action, target.dataset.value);
    else result = actions[action]?.(target.dataset.value);
    if (result instanceof Promise) result.catch(error => notify(error.message));
  }
});
content.addEventListener("input", event => {
  const field = event.target.dataset.field;
  const value = event.target.value;
  if (field?.startsWith("native-image-") && ui.route === "image" && studioFormat() !== "still") {
    const key = field.slice("native-image-".length);
    const draft = nativeStudioDraft();
    if (key === "size" && draft.method === "native") {
      draft.nativeSize = value;
    } else {
      if (key === "size" && value === "custom") {
        const [width, height] = studioSizeChoices(studioFormat(), draft).selected.split("x");
        draft.width ??= width;
        draft.height ??= height;
      }
      draft[key] = key === "frames" || key === "duration" ? Number(value) : value;
    }
    if (key === "frames" || key === "duration") {
      content.querySelector("[data-native-duration]").textContent = gifDuration(draft);
    }
    save();
    if (key === "method" || key === "model" || key === "size") {
      render();
      content.querySelector(`[data-field="${field}"]`)?.focus({preventScroll: true});
    }
    return;
  }
  if (field?.startsWith("image-") && (ui.route === "image" || ui.route === "image-edit")) {
    state.image.lastWorkspace = ui.route === "image" ? "generate" : "edit";
  }
  if (field === "home") { ui.homePrompt = value; saveHomeComposer(); }
  if (field === "search") { ui.search = value; filterTools(); }
  if (field === "asset-search") { ui.assetSearch = value; filterAssets(); }
  if (field === "edit-asset-search") {
    ui.editAssetSearch = value;
    const query = value.trim().toLowerCase();
    let count = 0;
    for (const item of content.querySelectorAll("[data-edit-asset-name]")) {
      item.hidden = !item.dataset.editAssetName.includes(query);
      if (!item.hidden) count++;
    }
    content.querySelector("[data-edit-asset-count]").textContent = `${count} 张`;
    content.querySelector("[data-edit-asset-empty]").hidden = count > 0;
    return;
  }
  if (field === "user-filter") {
    const query = value.trim().toLowerCase();
    let matches = 0;
    for (const row of content.querySelectorAll("[data-user-search]")) {
      row.hidden = !row.dataset.userSearch.includes(query);
      if (!row.hidden) matches++;
    }
    content.querySelector("[data-user-empty]").hidden = matches > 0;
    return;
  }
  const modelFields = {"image-model": ["image", "model"], "poster-model": ["poster", "model"], "poster-language-model": ["poster", "languageModel"], "ppt-model": ["ppt", "model"], "ppt-language-model": ["ppt", "languageModel"]};
  if (Object.hasOwn(modelFields, field)) {
    const [scope, key] = modelFields[field];
    (scope === "image" ? imageDraft() : state[scope])[key] = value;
    if (field === "image-model") {
      save();
      render();
      content.querySelector('[data-field="image-model"]')?.focus({preventScroll: true});
      return;
    }
  }
  if (field === "poster-prompt") state.poster.prompt = value;
  if (field === "poster-plan-prompt" && state.poster.proposal?.promptVersion === 2) state.poster.proposal.prompt = value;
  if (field === "poster-prompt-only") {
    state.poster.promptOnly = event.target.checked;
    save();
    render();
    content.querySelector('[data-field="poster-prompt-only"]')?.focus({preventScroll: true});
    return;
  }
  if (field === "poster-preset" && Object.hasOwn(posterPresets, value)) {
    state.poster.preset = value;
    const note = content.querySelector("[data-poster-preset-note]");
    if (note) note.textContent = posterPresets[value].note;
    updatePosterPreview();
  }
  if (field === "poster-message") state.poster.message = value;
  if (field === "poster-history" && value) return workspaceProjects.switchPoster(value).catch(error => notify(error.message));
  if (field === "poster-chat-history" && /^\d+$/.test(value)) return switchPosterChat(Number(value));
  if (field === "ppt-change") pptPageEdit().change = value;
  if (field === "ppt-prompt") pptPageEdit().prompt = value;
  if (field === "ppt-suggestion") pptPageEdit().suggestion = value;
  if (field === "ppt-discussion") state.ppt.discussionDraft = value;
  if (field === "ppt-chat-history" && value) {
    switchPptChat(value).catch(error => notify(error.message));
    return;
  }
  if (["ppt-search-mode", "poster-search-mode"].includes(field) && ["auto", "always", "off"].includes(value)) {
    state[field === "ppt-search-mode" ? "ppt" : "poster"].searchMode = value;
  }
  if (field === "ppt-resolution" && Object.hasOwn(pptResolutions, value)) state.ppt.resolution = value;
  if (field === "ppt-auto-review") state.ppt.autoReview = event.target.checked;
  if (field === "ppt-preserve-image") pptPageEdit().preserveImage = event.target.checked;
  if (field === "image-prompt") imageDraft().prompt = value;
  if (field === "image-text") state.image.text = value;
  if (field === "image-resolution") {
    const draft = imageDraft();
    const size = outputSize(draft);
    draft.resolution = value;
    if (ui.route === "image-edit") draft.editSizeChosen = true;
    if (value === "custom" && size) Object.assign(draft, size);
    save();
    render();
    content.querySelector("#image-resolution")?.focus();
  }
  if (field === "image-known-size" && value) {
    const [width, height] = value.split("x").map(Number);
    Object.assign(imageDraft(), {resolution: "custom", width, height});
    save();
    render();
    content.querySelector("#image-known-size")?.focus({preventScroll: true});
  }
  if (["image-width", "image-height"].includes(field)) {
    const draft = imageDraft();
    draft[field.slice(6)] = value;
    const summary = outputSummary(draft);
    content.querySelector("#output-summary").textContent = summary;
    content.querySelector("[data-size-summary]").textContent = summary;
  }
  if (field === "image-tool") {
    openTool(value);
    content.querySelector("#image-tool")?.focus({preventScroll: true});
  }
  if (field === "upscale-method") {
    state.image.upscaleMethod = value;
    content.querySelector("[data-upscale-mode-note]").textContent = value === "aliyun" ? "由百炼计费" : "使用本机显卡";
  }
  if (field === "upscale-target") {
    state.image.upscaleTarget = value;
    content.querySelector("[data-upscale-size]").textContent = upscaleSizeLabel();
  }
  if (field === "edit-expand-direction" && Object.hasOwn(expansionDirections, value)) {
    state.image.expandDirection = value;
    save();
    render();
    content.querySelector('[data-field="edit-expand-direction"]:checked')?.focus({preventScroll: true});
  }
  if (["ppt-brief", "ppt-level", "ppt-style"].includes(field)) {
    state.ppt[field.slice(4)] = value;
    state.ppt.maxStage = 0;
  }
  if (["ppt-title","ppt-detail"].includes(field)) {
    const ppt = state.ppt;
    const index = Number(event.target.dataset.index);
    ppt.outline[index][field === "ppt-title" ? 0 : 1] = value;
    if (ppt.boards[index]) ppt.boards[index] = null;
    if (ppt.pages[index]) ppt.pages[index] = null;
    delete ppt.pageEdits[index];
    delete ppt.textboxes[index];
    ppt.maxStage = 1;
  }
  if (field === "ppt-page-image") {
    const ppt = state.ppt;
    selectPptPageImage(ppt, ppt.active, ppt.stage === 3, value).catch(error => notify(error.message));
    return;
  }
  if (["poster-title", "poster-subtitle", "poster-date"].includes(field)) {
    const key = field.slice(7);
    state.poster[key] = value;
    updatePosterPreview();
  }
  if (field === "poster-format") {
    state.poster.exports = [...content.querySelectorAll('[data-field="poster-format"]:checked')].map(item => item.value);
    if (state.poster.exports.length && !state.poster.exports.includes(state.poster.selected)) {
      state.poster.selected = state.poster.exports[0];
    }
    const active = document.activeElement?.value;
    render();
    if (active) content.querySelector(`[data-field="poster-format"][value="${CSS.escape(active)}"]`)?.focus({preventScroll: true});
  }
  if (field === "guest-chat") ui.guestChatPrompt = value;
  if (field && !["home", "guest-chat", "search", "asset-search"].includes(field)) save();
});
content.addEventListener("toggle", event => {
  const key = event.target.dataset?.imageParameters;
  if (key && event.target.isConnected) (ui.imageParameters ||= {})[key] = event.target.open;
}, true);
document.addEventListener("submit", async event => {
  const form = event.target;
  if (!content.contains(form) && !authDialog.contains(form) && !accountDialog.contains(form) && !adminUserDialog.contains(form)) return;
  event.preventDefault();
  if ((form.id === "auth-form" && authBusy) || (form.id === "admin-user-form" && form.getAttribute("aria-busy") === "true")) return;
  if (form.hasAttribute("data-project")) return workspaceProjects.submit(form);
  if (form.hasAttribute("data-commercial")) return workspaceCommercial.submit(form);
  const data = Object.fromEntries(new FormData(form));
  const status = form.querySelector('[role="status"]');
  const submit = form.querySelector('button:not([type="button"])');
  if (submit) submit.disabled = true;
  if (status) status.textContent = "";
  try {
    if (form.id === "auth-form") {
      authBusy = true;
      const mode = form.dataset.mode;
      const result = await api("auth/" + mode, "POST", data);
      if (mode === "reset") {
        ui.authMode = "login";
        renderAuth();
        authDialog.querySelector('[role="status"]').textContent = "密码已重设，请登录。";
        return;
      }
      const next = authNext || (mode === "bootstrap" ? "admin" : "");
      const continuation = authContinuation;
      const origin = ui.route;
      const returns = ui.workbenchReturns;
      const draft = captureGuestDraft();
      await applySession(result).catch(error => notify(error.message));
      if (returns?.[origin]) rememberWorkbench(origin, returns[origin]);
      let restored = true;
      if (hasGuestDraft(draft)) {
        ui.guestImport = draft;
        restored = !guestDraftConflicts(draft).length && await restoreGuestDraft(draft).catch(error => {
          notify(error.message);
          return false;
        });
      }
      authBusy = false;
      closeAuth();
      render();
      if (next === "admin" && account.role !== "admin") return notify("此账号没有后台设置权限。");
      if (next) go(next);
      else if (!restored && ui.guestImport && guestDraftConflicts(draft).length) importGuestDraft();
      else if (restored && continuation && origin === ui.route) await Promise.resolve().then(continuation).catch(error => notify(error.message));
      refreshRoute();
      scheduleJobs(0);
    } else if (form.id === "upscale-settings-form") {
      const result = await api("profile/upscale", "PUT", {key: data.key});
      form.reset();
      displayUpscaleSettings(result);
      status.textContent = "已保存。";
    } else if (form.id === "guest-chat-form") {
      ui.guestChatPrompt = data.text.trim();
      if (ui.guestChatPrompt) openAuth();
    } else if (form.id === "profile-form") {
      const owner = identity;
      const result = await api("profile", "PUT", data);
      if (owner !== identity) return;
      account.name = result.name;
      form.elements.name.value = result.name;
      renderAccountIdentity();
      status.textContent = "名称已保存。";
    } else if (form.id === "password-form") {
      if (data.password !== data.confirm) throw new Error("两次输入的新密码不一致。");
      await api("profile/password", "PUT", {current: data.current, password: data.password});
      form.reset();
      status.textContent = "密码已更新";
    } else if (form.id === "redeem-form") {
      if (!requireAccount()) return;
      await queueWrite(async () => updateWallet(await api("credits/redeem", "POST", data)));
      render();
      notify("积分兑换成功。");
    } else if (form.id === "generation-settings-form") {
      ui.generationSettings = await api("admin/generation-settings", "PUT", {concurrency: Number(data.concurrency)});
      status.textContent = "已保存，等待中的任务将按新上限安排。";
    } else if (form.id === "image-policy-form") {
      ui.imagePolicy = await api("admin/image-policy", "PUT", {enabled: form.elements.enabled.checked});
      status.textContent = ui.imagePolicy.enabled ? "生图规则已启用。" : "生图规则已停用。";
    } else if (form.dataset.tokenSettlement) {
      await api(`admin/jobs/${form.dataset.tokenSettlement}/settle`, "POST", {input: Number(data.input), output: Number(data.output)});
      await refreshRoute();
      notify("已按实际 Token 用量结算。");
    } else if (form.dataset.issueCode) {
      const payload = {days: Number(data.days)};
      if (form.dataset.issueCode === "credit-codes") Object.assign(payload, {amount: parsePoints(data.amount), pointScale: POINT_SCALE});
      const result = await api("admin/" + form.dataset.issueCode, "POST", payload);
      status.textContent = result.code;
    } else if (form.id === "admin-user-form") {
      form.setAttribute("aria-busy", "true");
      const {mode, userId} = form.dataset;
      const path = "admin/users" + (userId ? "/" + userId : "");
      if (mode === "create") await api(path, "POST", data);
      if (mode === "edit") await api(path, "PUT", data);
      if (mode === "password") await api(path + "/password", "POST", data);
      if (mode === "credits") {
        await api(path + "/credits", "POST", {amount: parsePoints(data.amount), reason: data.reason, pointScale: POINT_SCALE});
        if (Number(userId) === account.id) updateWallet(await api("profile/usage"));
      }
      adminUserDialog.close();
      await refreshRoute();
      notify({create: "用户已添加", edit: "用户信息已保存", password: "密码已重置", credits: "积分调整已记入明细"}[mode]);
    }
  } catch (error) {
    if (status?.isConnected) status.textContent = error.message;
    else notify(error.message);
  } finally {
    if (form.id === "auth-form") authBusy = false;
    if (form.id === "admin-user-form") form.removeAttribute("aria-busy");
    if (submit?.isConnected) submit.disabled = false;
  }
});
function assignFile(target, item) {
  ui.file[target] = item;
  if (item.id) state.uploads[target] = item.id;
  else delete state.uploads[target];
}
function setEditSource(item, keepTool = false) {
  const current = ui.file.image;
  const same = item.id ? item.id === current?.id : item.url === current?.url;
  const apply = () => {
    rememberWorkbench("image-edit");
    if (!same) {
      imageGeneration();
      assignFile("image", item);
      resetEditSource();
    }
    if (keepTool || same) {
      state.image.lastWorkspace = "edit";
      save();
      go("image-edit");
    } else openTool("mask");
    document.querySelector("#media-viewer").close();
    return true;
  };
  if (!same && editSourceHasChanges()) {
    openModal("更换编辑底图？", `将使用「${item.name}」。`,
      "更换底图会清除当前圈选标注。原图和已生成结果仍可在素材中找到。", "更换底图", apply);
    return false;
  }
  return apply();
}

function editSourceHasChanges() {
  return Boolean((ui.file.image || state.image.source) && state.image.regions?.length);
}
function resetEditSource() {
  delete state.image.source;
  state.image.text = "";
  state.image.resolution = editToolHelp[state.image.tool]?.size ? "suggested" : "source";
  workspaceRegions.reset();
  ui.imageView = "原图";
  ui.editTab = "annotations";
  ui.picked = "";
  ui.selecting = state.image.tool === "mask";
}
async function storeFile(file, owner, rendered = false, kind = "upload", parentId) {
  if (owner !== identity) return null;
  if (!file.size) throw new Error("请选择有内容的文件。");
  if (!rendered && file.size > 12 * 1024 * 1024) throw new Error("单个文件最大 12 MB。");
  if (account) {
    const headers = {"X-File-Name": encodeURIComponent(file.name)};
    if (rendered) headers["X-Asset-Kind"] = kind;
    if (rendered && parentId) headers["X-Parent-Asset"] = parentId;
    const response = await fetch(rendered ? "/api/assets/render" : "/api/assets", { method: "POST", headers, body: file });
    const item = await response.json();
    if (!response.ok) throw new Error(item.error);
    if (owner !== identity) return null;
    ui.files.unshift(item);
    return uploadDescriptor(item);
  }
  const url = Object.hasOwn(imageExtensions, file.type) ? URL.createObjectURL(file) : "";
  if (url) ui.localUrls.add(url);
  return { name: file.name, mime: file.type, url, localFile: file };
}
function normalizeFile(file, target, pasted) {
  const extension = file.name.split(".").at(-1).toLowerCase();
  const imageTypes = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  const mime = imageTypes[extension] || file.type;
  const suffix = imageExtensions[mime];
  if (!suffix) {
    if (["ppt", "library"].includes(target)) {
      if (documentExtensions.includes(extension)) return file;
      throw new Error(`无法读取 ${file.name}。请选择受支持的文档、文本或图片。`);
    }
    throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。");
  }
  const name = pasted ? `粘贴图片-${crypto.randomUUID().slice(0, 8)}${suffix}`
    : imageTypes[extension] ? file.name : `${file.name || "参考图"}${suffix}`;
  return name === file.name && mime === file.type ? file : new File([file], name, { type: mime });
}
async function acceptFiles(files, target, pasted = false, replaceSource = false) {
  if (!files.length || !target) return;
  if (target === "ppt" && scopeInProgress("ppt")) return notify("请先等待当前 PPT 任务结束，再添加资料。");
  if (target === "library" && !account) return notify("请先登录，再上传到个人素材库。");
  if (ui.uploading) return notify("正在处理图片，请稍等。");
  if (target === "image" && !replaceSource && editSourceHasChanges()) {
    return openModal("更换编辑底图？", `将使用「${files[0].name}」。`, "更换底图会清除当前圈选标注。",
      "更换底图", () => acceptFiles(files, target, pasted, true));
  }
  const reference = ["reference", "generation-reference"].includes(target);
  const slots = reference ? availableReferenceSlots(target === "reference" ? state.image.tool : "image")
    : target === "ppt" ? pptSlots.filter(slot => !ui.file[slot])
    : target === "poster-reference" ? posterReferenceSlots.filter(slot => !ui.file[slot]) : [target];
  if (!slots.length) return notify("上传位置已满，请先移除一个文件。");
  const owner = identity;
  const imageDocument = state.image;
  const posterDocument = state.poster;
  const pptDocument = state.ppt;
  const limit = target === "library" ? files.length : slots.length;
  ui.uploading = true;
  ui.uploadTarget = target;
  let count = 0;
  const errors = [];
  try {
    for (const file of files) {
      if (count >= limit || owner !== identity) break;
      try {
        const item = await storeFile(normalizeFile(file, target, pasted), owner);
        if (!item) return;
        if (target === "ppt" && state.ppt !== pptDocument) return;
        if ((reference || target === "image") && state.image !== imageDocument) return;
        if ((posterReferenceTargets.includes(target) || target === "logo" || target === "qr") && state.poster !== posterDocument) return;
        if (target !== "library") assignFile(slots[count], item);
        if (target === "reference") workspaceRegions.attach(slots[count]);
        count++;
      } catch (error) { errors.push(error.message); }
    }
    if (owner !== identity) return;
    if (count) {
      if (target === "library") {
        ui.assetType = "上传素材";
        ui.assetSearch = "";
      }
      if (target === "ppt") state.ppt.maxStage = 0;
      if (target === "image") resetEditSource();
      if (reference || target === "image") state.image.lastWorkspace = target === "generation-reference" ? "generate" : "edit";
      save();
    }
    const skipped = files.length - count - errors.length;
    notify([count ? `已添加 ${count} 个素材` : "", ...new Set(errors),
      skipped > 0 ? (reference || target === "ppt" || target === "poster-reference" ? "素材已达上限，已跳过其余文件" : "此处仅接收 1 个素材") : ""].filter(Boolean).join("。"));
  } finally {
    if (owner === identity) {
      ui.uploading = false;
      ui.uploadTarget = "";
      if (count) render();
    }
  }
}
async function sendToEditor(descriptor) {
  if (descriptor.file?.mime === "image/svg+xml") return false;
  const owner = identity;
  const imageDocument = state.image;
  if (descriptor.file) return setEditSource(descriptor.file);
  if (ui.uploading) throw new Error("正在处理图片，请稍等。");
  ui.uploading = true;
  try {
    const blob = await workspaceMedia.getBlob(descriptor);
    const name = (descriptor.name || "图片").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const item = await storeFile(new File([blob], name + (imageExtensions[blob.type] || ".png"), { type: blob.type }), owner, true);
    if (!item || owner !== identity || state.image !== imageDocument) return false;
    ui.uploading = false;
    return setEditSource(item);
  } finally {
    if (owner === identity) ui.uploading = false;
  }
}
workspaceMedia.onEdit = sendToEditor;

function workbenchStorageKey() {
  return `fengsha-workbench-returns:${account?.id ?? "guest"}`;
}

function rememberWorkbench(to, from = ui.route) {
  if (from === to) return;
  const links = ui.workbenchReturns;
  if (links[from] === to) delete links[from];
  links[to] = from;
  try {
    sessionStorage.setItem(workbenchStorageKey(), JSON.stringify(links));
  } catch {}
}

function setPosterProduct(file) {
  const current = ui.file["poster-product"];
  const apply = () => {
    rememberWorkbench("poster");
    assignFile("poster-product", file);
    state.poster.previewTab = "reference";
    save();
    go("poster");
    document.querySelector("#media-viewer").close();
    notify("已带入产品主图。选择物料尺寸即可继续制作。");
    return true;
  };
  if (current && current.id !== file.id) {
    openModal("替换海报产品主图？", `「${current.name}」将替换为「${file.name}」。`,
      "海报文案、风格参考和已生成的成品会保留。", "替换产品主图", apply);
    return false;
  }
  return apply();
}

async function sendToPoster(descriptor) {
  if (descriptor.file?.mime === "image/svg+xml") return false;
  const poster = state.poster;
  const owner = identity;
  let file = descriptor.file;
  if (!file) {
    if (ui.uploading) throw new Error("正在处理图片，请稍等。");
    ui.uploading = true;
    try {
      const blob = await workspaceMedia.getBlob(descriptor);
      if (identity !== owner || poster !== state.poster) return false;
      const name = (descriptor.name || "产品图").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100);
      file = await storeFile(new File([blob], name + (imageExtensions[blob.type] || ".png"), {type: blob.type}), owner, true);
    } finally {
      if (identity === owner) ui.uploading = false;
    }
  }
  if (!file || identity !== owner || poster !== state.poster) return false;
  return setPosterProduct(file);
}
workspaceMedia.onPoster = sendToPoster;
fileInput.addEventListener("change", () => acceptFiles([...fileInput.files], ui.fileTarget));

document.addEventListener("paste", event => {
  if (document.querySelector("dialog[open]")) return;
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === "file" && Object.hasOwn(imageExtensions, item.type)).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  const defaults = { home: ui.homeMode === "image" ? "home" : "", image: studioFormat() === "svg" ? "" : "generation-reference", "image-edit": "image", poster: "poster-product", ppt: state.ppt.stage === 0 ? "ppt" : "", assets: "library" };
  const focused = event.target instanceof Element ? event.target.closest("[data-drop-target]")?.dataset.dropTarget : "";
  const target = focused || defaults[ui.route];
  if (!target || !defaults[ui.route]) return;
  event.preventDefault();
  acceptFiles(files, target, true);
});
content.addEventListener("load", event => updateEditDimensions(event.target), true);

content.addEventListener("dragover", event => {
  const zone = event.target.closest("[data-drop-target]");
  const studioAsset = ["generation-reference", "image", "reference"].includes(zone?.dataset.dropTarget) &&
    event.dataTransfer.types.includes(studioAssetDragType);
  if (!zone || (!studioAsset && !event.dataTransfer.types.includes("Files"))) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  zone.classList.add("is-drop-target");
});
content.addEventListener("dragleave", event => {
  const zone = event.target.closest("[data-drop-target]");
  if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("is-drop-target");
});
content.addEventListener("drop", event => {
  const zone = event.target.closest("[data-drop-target]");
  if (!zone) return;
  const asset = event.dataTransfer.getData(studioAssetDragType);
  if (!asset && !event.dataTransfer.files.length) return;
  event.preventDefault();
  zone.classList.remove("is-drop-target");
  if (asset) {
    if (zone.dataset.dropTarget === "generation-reference") return actions["reference-file"](asset);
    if (zone.dataset.dropTarget === "image") return actions["edit-pick-asset"](asset);
    if (zone.dataset.dropTarget === "reference") {
      const file = ui.files.find(item => item.id === asset && item.mime.startsWith("image/"));
      if (!file || file.id === ui.file.image?.id) return;
      const existing = referenceSlots.find(slot => ui.file[slot]?.id === file.id);
      const slot = existing || availableReferenceSlots()[0];
      if (!slot) return notify("参考图位置不足，请先移除一张参考图。");
      if (!existing) assignFile(slot, uploadDescriptor(file));
      const regionId = zone.dataset.regionBox || zone.dataset.regionInspector;
      if (regionId) workspaceRegions.attach(slot, regionId);
      save();
      render();
    }
    return;
  }
  acceptFiles([...event.dataTransfer.files], zone.dataset.dropTarget);
});
content.addEventListener("dragstart", event => {
  const card = event.target.closest("[data-studio-asset]");
  if (!card) return;
  event.dataTransfer.setData(studioAssetDragType, card.dataset.studioAsset);
  event.dataTransfer.effectAllowed = "copy";
});
content.addEventListener("dragend", () => {
  content.querySelectorAll(".is-drop-target").forEach(zone => zone.classList.remove("is-drop-target"));
});
content.addEventListener("scroll", event => {
  if (event.target.matches?.("[data-studio-asset-rail]")) syncStudioAssetArrows();
}, true);
window.addEventListener("resize", syncStudioAssetArrows);
window.addEventListener("hashchange", syncRoute);
content.addEventListener("keydown", event => {
  const composer = event.target.closest("textarea[data-ai-send]");
  if (composer && event.key === "Enter" && event.ctrlKey && !event.altKey && !event.metaKey &&
      !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented) {
    event.preventDefault();
    if (event.repeat || composer.disabled) return;
    const action = composer.dataset.aiSend;
    const submit = action ? content.querySelector('[data-action="' + CSS.escape(action) + '"]') :
      composer.form?.querySelector('button[type="submit"]');
    submit?.click();
    return;
  }
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
      !event.target.closest(".ppt-preview, .slide-grid")) return;
  const direction = {ArrowLeft: -1, ArrowRight: 1}[event.key];
  if (!direction) return;
  event.preventDefault();
  stepPptSlide(direction);
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && saveDirty) flushSave(); });
api("session").then(applySession).then(syncRoute).catch(error => {
  window.workspaceLoadFailed?.(error.message);
});
