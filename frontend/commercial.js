"use strict";

const workspaceCommercial = (() => {
  // Receive and settle the stream immediately; pace only the visible text.
  function revealText(paint) {
    let visible = "", target = "", queue = [], cursor = 0, timer, finish;
    let deadline = 0;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const immediate = () => document.hidden || reducedMotion.matches;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      queue = [];
      cursor = 0;
      if (visible !== target) paint(visible = target);
      const resolve = finish;
      finish = undefined;
      resolve?.();
    };
    const step = () => {
      timer = undefined;
      if (immediate() || (deadline && performance.now() >= deadline)) return flush();
      const remaining = queue.length - cursor;
      if (remaining <= 0) return flush();
      const budget = deadline ? Math.max(2, Math.floor((deadline - performance.now()) / 24)) : 28;
      const next = Math.min(queue.length, cursor + Math.ceil(remaining / budget));
      visible += queue.slice(cursor, next).join("");
      cursor = next;
      paint(visible);
      if (cursor === queue.length) flush();
      else timer = setTimeout(step, 24);
    };
    const set = text => {
      if (text === target) return;
      const extendsTarget = text.startsWith(target);
      if (extendsTarget) {
        queue = queue.slice(cursor).concat(Array.from(text.slice(target.length)));
        cursor = 0;
      }
      else {
        queue = Array.from(text.startsWith(visible) ? text.slice(visible.length) : text);
        cursor = 0;
        if (!text.startsWith(visible)) paint(visible = "");
      }
      target = text;
      if (immediate()) flush();
      else if (timer === undefined) timer = setTimeout(step, 0);
    };
    return {set, flush, drain() {
      if (visible === target || immediate()) {
        flush();
        return Promise.resolve();
      }
      deadline = performance.now() + 480;
      return new Promise(resolve => { finish = resolve; });
    }};
  }

  const capabilityLabels = {
    generate: "文生图",
    reference: "参考图生图",
    mask: "圈选编辑",
    multiReference: "多参考图",
    imageStream: "流式图片预览",
    gif: "原生 GIF",
    svg: "原生 SVG",
    text: "文本对话",
    vision: "理解图片",
    stream: "流式输出"
  };
  const capabilitiesByKind = {
    image: ["generate", "reference", "mask", "multiReference", "imageStream", "gif", "svg"],
    chat: ["text", "vision", "stream"]
  };
  const kindLabels = { image: "图片", chat: "语言" };
  const defaultMaxReferences = 9;
  const maxReferenceLimit = 16;
  const adminTabs = [
    ["connections", "服务连接"], ["models", "模型上架"], ["defaults", "默认模型"], ["audit", "模型配置记录"]
  ];
  const adminDefaults = () => ({ tab: "connections", connections: [], models: [], defaults: {}, audit: [], discovered: new Map(), probing: new Set(), editor: null, notice: "", modelKind: "image", modelSelection: new Set() });
  const chatDefaults = () => ({
    conversations: [], active: "", messages: [], draft: "", modelId: "",
    catalog: { models: [], defaults: {} }, request: null, loaded: false,
    notice: "", openRevision: 0, draftRevision: 0, interrupted: null, agent: true, imageModelId: "", creativeSkill: "auto", webSearch: false,
    attachmentIds: [], plans: [], jobs: new Map(), assets: new Map(), planBusy: new Set(), assemblyPolls: new Set(), uploading: false
  });
  let activeOwner;
  let admin = adminDefaults();
  let chat = chatDefaults();

  function syncOwner() {
    const owner = account?.id ?? null;
    if (activeOwner !== owner) {
      chat.request?.controller.abort();
      admin = adminDefaults();
      activeOwner = owner;
      chat = chatDefaults();
    }
    return owner;
  }

  function escape(value) {
    return esc(String(value ?? ""));
  }

  function option(value, label, current) {
    return `<option value="${escape(value)}"${String(value) === String(current) ? " selected" : ""}>${escape(label)}</option>`;
  }

  function price(value) {
    return points(value);
  }

  function badge(label, good = false) {
    return `<span class="commercial-badge${good ? " commercial-good" : ""}">${escape(label)}</span>`;
  }

  function adminPanel() {
    syncOwner();
    const title = adminTabs.find(([id]) => id === admin.tab)?.[1];
    return `<section class="commercial-admin card" aria-labelledby="commercial-model-title">
      <header class="row-between"><div>
        <p class="meta">模型中心</p>
        <h2 id="commercial-model-title">${escape(title)}</h2>
      </div>${button("刷新", "c-admin-reload", "", "ghost")}</header>
      <div id="commercial-admin-main">${adminBody()}</div>
    </section>`;
  }

  function adminNavigation() {
    syncOwner();
    return `<div class="ops-subnav" role="group" aria-label="模型中心菜单">
      ${adminTabs.map(([id, label]) => button(label, "c-admin-tab", id, "ghost", `aria-pressed="${admin.tab === id}"`)).join("")}
    </div>`;
  }

  function adminBody() {
    const content = { connections: connectionsView, models: modelsView, defaults: defaultsView, audit: auditView };
    return `<p class="commercial-notice" id="commercial-admin-notice" role="status">${escape(admin.notice)}</p>
      ${content[admin.tab]()}`;
  }

  function drawAdmin() {
    const root = document.querySelector("#commercial-admin-main");
    if (!root) return;
    document.querySelector("#commercial-model-title").textContent = adminTabs.find(([id]) => id === admin.tab)[1];
    root.innerHTML = adminBody();
    document.querySelectorAll('[data-action="c-admin-tab"]').forEach(node => {
      node.setAttribute("aria-pressed", String(node.dataset.value === admin.tab));
    });
  }

  function adminNotice(text) {
    admin.notice = text;
    const status = document.querySelector("#commercial-admin-notice");
    if (status) status.textContent = text;
  }

  function connectionsView() {
    if (admin.editor?.type === "connection") return connectionForm();
    const rows = admin.connections.map(item => `<tr>
      <td><strong>${escape(item.name)}</strong><small>${escape(item.baseUrl)}</small></td>
      <td>${badge(item.enabled ? "已启用" : "已停用", item.enabled)} ${badge(item.hasKey ? "密钥已配置" : "缺少密钥")}</td>
      <td><div class="row">${button("编辑连接", "c-connection", item.id)}${button("从目录添加", "c-connection-models", item.id, "ghost")}</div></td>
    </tr>`).join("");
    return `<div class="row-between commercial-subhead"><p class="meta">填写服务商提供的 Base URL 和 API Key，再从目录添加模型。</p>${button("新增连接", "c-connection", "", "primary")}</div>
      ${rows ? `<div class="table-wrap"><table class="ds-table commercial-table"><thead><tr><th>连接</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty">还没有连接。添加 Base URL 和 API Key 后可读取模型目录。</p>'}`;
  }

  function connectionForm() {
    const item = admin.connections.find(entry => entry.id === admin.editor.id)
      || {};
    return `<form class="commercial-form stack" data-commercial="connection" data-id="${escape(item.id)}">
      <h3>${item.id ? "编辑连接" : "新增 OpenAI 兼容连接"}</h3>
      <div class="commercial-fields">
        <label class="field">显示名称<input name="name" class="input" value="${escape(item.name)}" placeholder="例如我的模型服务" maxlength="80" required></label>
        <label class="field">Base URL<input name="baseUrl" class="input" type="url" value="${escape(item.baseUrl)}" placeholder="https://example.com/v1" maxlength="300" required></label>
        <label class="field">API Key<input name="key" class="input" type="password" autocomplete="new-password" placeholder="${item.hasKey ? "已配置，留空保留" : "输入 CPA API Key"}" ${item.hasKey ? "" : "required"}></label>
        <label class="commercial-check"><input type="checkbox" name="enabled"${item.enabled !== false ? " checked" : ""}>启用连接</label>
      </div>
      <div class="row">
        <button class="btn btn-primary" type="submit">${item.id ? "保存连接" : "保存并添加模型"}</button>
        ${button("查看模型目录", "c-discover", "connection")}
        ${button("取消", "c-editor-close", "", "ghost")}
        ${item.id ? button("删除连接", "c-connection-delete", item.id, "ghost") : ""}
      </div>
      <div data-discovery role="status"></div>
    </form>`;
  }

  function modelsView() {
    if (admin.editor?.type === "model") return modelForm();
    if (admin.editor?.type === "batch") return batchModelForm();
    const models = admin.models.filter(item => item.kind === admin.modelKind);
    const count = models.filter(item => admin.modelSelection.has(item.id)).length;
    const rows = models.map(item => {
      const connection = admin.connections.find(entry => entry.id === item.connectionId);
      const published = Boolean(item.enabled && connection?.enabled);
      return `<tr>
        <td><input type="checkbox" data-model-select value="${escape(item.id)}" aria-label="选择 ${escape(item.name)}"${admin.modelSelection.has(item.id) ? " checked" : ""}></td>
        <td><strong>${escape(item.name)}</strong><small>${escape(item.modelId)}</small></td>
        <td>${escape(connection?.name || "已移除连接")}</td>
        <td><div class="commercial-badges">${(item.capabilities || []).map(key => badge(capabilityLabels[key] || key)).join("")}</div></td>
        <td>${badge(published ? "已上架" : item.enabled ? "连接已停用" : "未上架", published)}</td>
        <td class="num">${item.kind === "image" ? price(item.price) + " 积分/张" : tokenRateText(item)}</td>
        <td><div class="row">${button("编辑", "c-model", item.id)}
          ${button(item.enabled ? "下架" : "上架", "c-model-publish", item.id, "ghost", item.enabled || connection?.enabled ? "" : "disabled")}</div></td>
      </tr>`;
    }).join("");
    const canAdd = admin.connections.length ? "" : "disabled";
    return `<div class="row-between commercial-subhead">
      <div class="row">${Object.entries(kindLabels).map(([kind, label]) => button(`${label}模型`, "c-model-kind", kind, kind === admin.modelKind ? "primary" : "ghost", `aria-pressed="${kind === admin.modelKind}"`)).join("")}</div>
      <div class="row">${button("批量导入", "c-model-batch-import", "", "", canAdd)}${button("添加模型", "c-model", "", "primary", canAdd)}</div></div>
      ${rows ? `<div class="row commercial-subhead"><span class="meta">已选 ${count} 项</span>
        ${button("批量上架", "c-model-batch-state", "publish", "", count ? "" : "disabled")}
        ${button("批量下架", "c-model-batch-state", "unpublish", "ghost", count ? "" : "disabled")}</div>
        <div class="table-wrap"><table class="ds-table commercial-table commercial-model-table"><thead><tr>
          <th><input type="checkbox" data-model-select-all aria-label="选择当前分类全部模型"${count === models.length ? " checked" : ""}></th>
          <th>模型</th><th>连接</th><th>能力</th><th>状态</th><th>单价</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${admin.connections.length ? "此分类还没有模型，可从上游目录批量导入。" : "请先添加服务连接。"}</p>`}`;
  }

  function batchDirectory(editor, query = "") {
    const existing = new Set(admin.models.filter(item => item.connectionId === editor.connectionId).map(item => item.modelId));
    const items = admin.discovered.get(editor.connectionId);
    const term = query.trim().toLowerCase();
    const matches = (items || []).filter(item => [item.id, item.name].some(value => String(value || "").toLowerCase().includes(term)));
    return `<div class="row-between"><span class="meta">已选 <span data-batch-count>${editor.selected.size}</span> / 100</span>
      ${button("选中当前结果", "c-batch-select", "", "ghost", matches.some(item => !existing.has(item.id)) ? "" : "disabled")}
      ${button("清空选择", "c-batch-clear", "", "ghost")}</div>
      <div class="commercial-batch-directory">${matches.map(item => `<label class="commercial-check">
        <input type="checkbox" data-batch-select value="${escape(item.id)}"${editor.selected.has(item.id) ? " checked" : ""}${existing.has(item.id) ? " disabled" : ""}>
        <span>${escape(item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id)}${existing.has(item.id) ? "（已添加）" : ""}</span>
      </label>`).join("") || `<p class="meta">${items ? "没有匹配的模型。" : "先获取上游模型目录。"}</p>`}</div>`;
  }

  function batchModelForm() {
    const editor = admin.editor;
    const {kind, connectionId} = editor;
    const rates = kind === "chat";
    const rate = (name, label) => `<label class="field">${label}<input class="input" type="number" min="0" max="1000000" step="${POINT_STEP}" name="${name}"></label>`;
    return `<form class="commercial-form stack" data-commercial="batch-model">
      <h3>从上游批量导入</h3>
      <div class="commercial-fields">
        <label class="field">服务连接<select class="input" name="connectionId">${admin.connections.map(item => option(item.id, item.name, connectionId)).join("")}</select></label>
        <label class="field">本批模型分类<select class="input" name="kind">${Object.entries(kindLabels).map(([key, label]) => option(key, label, kind)).join("")}</select></label>
      </div>
      <div class="row"><input class="input" type="search" name="batchSearch" aria-label="搜索上游模型" placeholder="搜索模型名称或 ID">${button("获取上游目录", "c-batch-discover")}</div>
      <div class="stack" data-batch-directory>${batchDirectory(editor)}</div>
      <fieldset class="commercial-fieldset commercial-form-section"><legend>本批共用的能力与价格</legend>
        <div class="row">${capabilityFields(kind)}</div>
        <div class="commercial-fields">${rates ? rate("inputRate", "输入积分 / 百万 Token") + rate("outputRate", "输出积分 / 百万 Token") : rate("price", "积分 / 张")}</div>
        <label class="commercial-check"><input type="checkbox" name="enabled">导入后立即上架</label>
        <p class="meta">只勾选符合所选分类的模型。立即上架需要填写单价。已添加的模型保留现有配置。</p>
      </fieldset>
      <div class="row"><button class="btn btn-primary" type="submit">导入所选模型</button>${button("取消", "c-editor-close", "", "ghost")}</div>
    </form>`;
  }

  function drawBatchDirectory(form) {
    form.querySelector("[data-batch-directory]").innerHTML = batchDirectory(admin.editor, form.elements.batchSearch.value);
  }

  function modelOptions(connectionId, search = "", selected = "") {
    const models = admin.discovered.get(connectionId) || [];
    const query = search.trim().toLowerCase();
    const matches = models.filter(item => [item.id, item.name].some(value => String(value || "").toLowerCase().includes(query)));
    const placeholder = matches.length ? "选择一个模型" : admin.discovered.has(connectionId) ? "目录中没有匹配项" : "先获取模型目录";
    return option("", placeholder, selected) +
      matches.map(item => option(item.id, item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id, selected)).join("");
  }

  function capabilityFields(kind, selected = []) {
    return capabilitiesByKind[kind].map((key, index) => index === 0
      ? `<label class="commercial-check"><input type="checkbox" checked disabled>${capabilityLabels[key]}（基础）</label><input type="hidden" name="capabilities" value="${key}">`
      : `<label class="commercial-check"><input type="checkbox" name="capabilities" value="${key}"${selected.includes(key) ? " checked" : ""}>${capabilityLabels[key]}</label>`).join("");
  }

  function modelForm() {
    const item = admin.models.find(entry => entry.id === admin.editor.id) || {};
    const connectionId = item.connectionId || admin.editor.connectionId || admin.connections.find(connection => connection.enabled)?.id || admin.connections[0]?.id;
    const kind = item.kind || admin.modelKind;
    const capabilities = item.capabilities || [capabilitiesByKind[kind][0]];
    const canEnable = admin.connections.some(connection => connection.id === connectionId && connection.enabled);
    return `<form class="commercial-form stack" data-commercial="model" data-id="${escape(item.id)}">
      <h3>${item.id ? "编辑模型" : "添加模型"}</h3>
      <fieldset class="commercial-fieldset commercial-form-section"><legend>选择模型</legend>
        <div class="commercial-fields">
          <label class="field">服务连接<select class="input" name="connectionId" required>${admin.connections.map(connection => option(connection.id, connection.name + (connection.enabled ? "" : "（已停用）"), connectionId)).join("")}</select></label>
          <label class="field">模型类型<select class="input" name="kind">${Object.entries(kindLabels).map(([key, label]) => option(key, label, kind)).join("")}</select></label>
        </div>
        <div class="commercial-directory">
          <label class="field">搜索模型目录<input type="search" class="input" name="modelSearch" placeholder="输入模型名或 ID"></label>
          <label class="field">从目录选择<select class="input" name="directoryModel">${modelOptions(connectionId, "", item.modelId)}</select></label>
          ${button("获取模型目录", "c-discover", "model")}
        </div>
        <div data-discovery role="status" class="meta"></div>
        <label class="field">模型 ID<input class="input" name="modelId" value="${escape(item.modelId)}" maxlength="180" placeholder="从目录选择或手工填写" required></label>
      </fieldset>
      <fieldset class="commercial-fieldset commercial-form-section"><legend>前台显示与计费</legend>
        <div class="commercial-fields">
          <label class="field">用户看到的名称<input class="input" name="name" value="${escape(item.name)}" maxlength="80" placeholder="例如通用绘图" required></label>
          <label class="field" data-image-price${kind === "image" ? "" : " hidden"}>单价（积分/张）<input class="input" type="number" name="price" value="${price(item.price)}" min="0" max="1000000" step="${POINT_STEP}"${kind === "image" ? " required" : " disabled"}></label>
        </div>
        <div class="commercial-fields" data-token-prices${kind === "chat" ? "" : " hidden"}>
          <label class="field">输入单价（积分 / 百万 Token）<input class="input" type="number" name="inputRate" value="${item.tokenRates ? price(item.tokenRates.input) : ""}" min="0" max="1000000" step="${POINT_STEP}" placeholder="例如 2.00"${kind === "chat" ? "" : " disabled"}></label>
          <label class="field">输出单价（积分 / 百万 Token）<input class="input" type="number" name="outputRate" value="${item.tokenRates ? price(item.tokenRates.output) : ""}" min="0" max="1000000" step="${POINT_STEP}" placeholder="例如 8.00"${kind === "chat" ? "" : " disabled"}></label>
          <label class="field" ${kind === "chat" ? "" : "hidden"}>上下文窗口（Token）<input class="input" type="number" name="contextWindowTokens" value="${item.contextWindowSource === "configured" ? item.contextWindowTokens : ""}" min="16384" max="10000000" step="1" placeholder="未配置：保守按 65536 估算"${kind === "chat" ? "" : " disabled"}><small>填写服务商支持的容量。接近容量时自动整理早期对话，摘要用量计入本轮。</small></label>
          <p class="meta">按服务商返回的用量结算。不足 0.000001 积分的部分累计，设为 0 表示该项免费。</p>
          <label class="field">图片 Agent 调用方式<select class="input" name="agentMode"${kind === "chat" ? "" : " disabled"}>
            ${option("native", "原生工具调用", item.agentMode || "native")}${option("json", "JSON 计划（兼容）", item.agentMode || "native")}</select></label>
        </div>
        <div class="row"><label class="commercial-check"><input type="checkbox" name="enabled"${item.enabled && canEnable ? " checked" : ""}${canEnable ? "" : " disabled"}>上架给用户</label>
          <span class="meta" data-publish-note>${canEnable ? "启用后随本次保存立即上架。" : "启用服务连接后可上架。"}</span></div>
      </fieldset>
      <fieldset class="commercial-fieldset commercial-form-section"><legend>模型能力</legend>
        <div class="row" data-capability-fields>${capabilityFields(kind, capabilities)}</div>
        <div class="commercial-fields" data-image-fields${kind === "image" ? "" : " hidden"}>
          <label class="field">兼容尺寸（可选）<input class="input" name="sizes" value="${escape((item.sizes || []).join(", "))}" placeholder="留空自动适配"><small class="meta">始终先尝试用户选择。模型明确拒绝时优先使用它返回的可选尺寸，也可在这里补充已知尺寸，如 1024x1024。</small></label>
          <label class="field">最多输入图片<input class="input" name="maxReferences" type="number" value="${escape(item.maxReferences ?? defaultMaxReferences)}" min="1" max="${maxReferenceLimit}" step="1"${kind === "image" ? " required" : " disabled"}><small class="meta">最多 ${maxReferenceLimit} 张，编辑时原图占 1 张。</small></label>
        </div>
      </fieldset>
      <div class="row">
        <button class="btn btn-primary" type="submit" data-save-model>${item.enabled && canEnable ? "保存并上架" : "保存模型"}</button>
        ${button("关闭", "c-editor-close", "", "ghost")}
        ${item.id ? button("删除模型", "c-model-delete", item.id, "ghost") : ""}
      </div>
      ${item.id ? probeControls(item) : ""}
    </form>`;
  }

  function probeControls(item) {
    return `<details class="commercial-fieldset commercial-probes"${admin.editor.probesOpen ? " open" : ""}><summary>上游能力测试（可选）</summary>
      <p class="meta">测试会调用此连接，可能产生上游费用。</p>
      <div>${(item.capabilities || []).map(key => {
        const verified = item.verified?.includes(key);
        const test = item.tests?.[key];
        const metadata = [test?.actualSize, Number.isFinite(test?.elapsedMs) ? `${test.elapsedMs} ms` : ""].filter(Boolean).join(" · ");
        return `<div class="row-between"><div>${escape(capabilityLabels[key] || key)} ${badge(verified ? "已验证" : test?.uncertain ? "待核对" : test ? "未通过" : "待验证", verified)}
          ${metadata ? `<small class="meta">${escape(metadata)}</small>` : ""}
          ${test && !verified ? `<p class="meta">${escape(test.message)}</p>` : ""}</div>
          ${button(`测试${capabilityLabels[key] || key}`, "c-probe", `${item.id}:${key}`, "secondary", admin.probing.has(item.id) ? "disabled" : "")}</div>`;
      }).join("")}</div></details>`;
  }

  function defaultsView() {
    const defaults = Object.keys(kindLabels).map(kind => {
      const models = admin.models.filter(model => model.kind === kind && model.enabled && admin.connections.some(connection => connection.id === model.connectionId && connection.enabled));
      return `<label class="field">默认${kind === "image" ? "生图" : "语言"}模型<select class="input" name="${kind}">${option("", "未设置默认模型", admin.defaults[kind] || "")}
        ${models.map(model => option(model.id, model.name, admin.defaults[kind])).join("")}</select></label>`;
    }).join("");
    return `<form class="commercial-form stack" data-commercial="defaults"><h3>默认模型</h3>
      <p class="meta">只有已上架且连接启用的模型可设为默认。</p>
      <div class="commercial-fields">${defaults}</div><div><button class="btn btn-primary" type="submit">保存默认模型</button></div></form>`;
  }

  function auditView() {
    const names = {
      "connection.create": "新增连接", "connection.update": "修改连接", "connection.delete": "删除连接",
      "model.create": "新增模型", "model.update": "修改模型", "model.delete": "删除模型",
      "model.probe": "能力验证", "defaults.update": "修改默认模型"
    };
    if (!admin.audit.length) return '<p class="empty">还没有模型验证或配置变更记录。</p>';
    const rows = admin.audit.map(item => {
      const detail = item.detail || {};
      const target = admin.models.find(model => model.id === item.target)?.name || admin.connections.find(connection => connection.id === item.target)?.name || (item.target === "defaults" ? "默认模型" : item.target);
      const time = new Date(Number(item.created) * 1000).toLocaleString("zh-CN");
      const info = item.action === "model.probe" ? [capabilityLabels[detail.capability], detail.message, detail.actualSize, Number.isFinite(detail.elapsedMs) ? `${detail.elapsedMs} ms` : "", detail.requestId].filter(Boolean).join(" · ") : "";
      return `<tr><td>${escape(time)}</td><td>${escape(item.actor)}</td><td>${escape(names[item.action] || item.action)}</td><td>${escape(target)}
        ${info ? `<small>${escape(info)}</small>` : ""}</td></tr>`;
    }).join("");
    return `<div class="table-wrap"><table class="ds-table commercial-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象和结果</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function refreshAudit() {
    const owner = syncOwner();
    const result = await api("admin/model-audit");
    if (owner !== activeOwner || owner !== account?.id || admin.tab !== "audit") return;
    admin.audit = result.items || [];
    drawAdmin();
  }

  async function refreshAdmin(force = false) {
    if (account?.role !== "admin") return;
    const owner = syncOwner();
    const [connections, models, defaults] = await Promise.all([
      api("admin/connections"), api("admin/models"), api("admin/defaults")
    ]);
    if (owner !== activeOwner || owner !== account?.id) return;
    admin.connections = connections.connections || [];
    admin.models = models.models || [];
    admin.defaults = defaults.defaults || {};
    const currentForm = document.querySelector("#commercial-admin-main form[data-commercial]");
    if (force || !currentForm || (currentForm.dataset.commercial === "defaults" && !currentForm.dataset.dirty)) drawAdmin();
    if (admin.tab === "audit") await refreshAudit();
  }

  function chatView() {
    syncOwner();
    if (!account) {
      return page("AI 对话", `<div class="commercial-chat-layout">
        <form class="card commercial-compose commercial-chat-guest" id="guest-chat-form">
          <label class="sr-commercial" for="guest-chat-text">输入消息</label>
          <textarea class="textarea" id="guest-chat-text" name="text" data-field="guest-chat" data-ai-send placeholder="输入你的问题，或告诉我你想生成什么图片" maxlength="12000" required>${escape(ui.guestChatPrompt || "")}</textarea>
          <div class="row"><button class="btn btn-primary" type="submit" aria-keyshortcuts="Control+Enter" title="Ctrl+Enter 发送">发送</button></div>
        </form>
      </div>`, "chat");
    }
    return page("AI 对话", `<div class="commercial-chat-layout">
      <div class="commercial-chat-toolbar">
        <details class="card commercial-chat-side">
          <summary>历史对话</summary>
          <div id="commercial-chat-list">${chatList()}</div>
        </details>
      </div>
      <section class="card commercial-chat-main" aria-label="当前对话">
        <header class="commercial-chat-header">
          <div><h2 id="commercial-chat-title">${escape(chatTitle())}</h2><p class="meta" id="commercial-chat-price">${chatPrice()}</p></div>
          <label class="field"><span class="sr-commercial">语言模型</span><select class="input" id="commercial-chat-model"${chat.request ? " disabled" : ""}>${chatOptions()}</select></label>
        </header>
        <div id="commercial-chat-messages" class="commercial-chat-messages" aria-label="消息记录">${chatMessages()}</div>
        <form class="commercial-compose" data-commercial="chat">
          <label class="sr-commercial" for="commercial-chat-text">输入消息</label>
          <div class="commercial-agent-options">
            <label class="commercial-agent-switch"><input type="checkbox" id="commercial-chat-agent"${chat.agent ? " checked" : ""}${chat.request ? " disabled" : ""}>图片 Agent</label>
            <label class="commercial-agent-switch" title="勾选后主动查找；也可以直接输入「联网搜索……」" data-chat-web-search${chat.catalog.webSearch ? "" : " hidden"}><input type="checkbox" id="commercial-chat-web-search"${chat.webSearch ? " checked" : ""}${chat.request ? " disabled" : ""}>联网搜索</label>
            <div id="commercial-chat-agent-tools"${chat.agent ? "" : " hidden"}>${agentTools()}</div>
          </div>
          <div id="commercial-chat-attachments">${attachmentList()}</div>
          <input type="file" id="commercial-chat-file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
          <textarea class="textarea" id="commercial-chat-text" name="text" data-ai-send placeholder="${chatPlaceholder()}" maxlength="12000" required>${escape(chat.draft)}</textarea>
          <div class="row-between"><p id="commercial-chat-notice" class="commercial-notice" role="status">${escape(chat.notice)}</p>
            <div class="row">${button("停止输出", "c-chat-stop", "", "secondary", chat.request ? "" : "hidden")}
              ${button("＋ 新对话", "c-chat-new", "", "secondary", chat.request ? "disabled" : "")}
              <button class="btn btn-primary" id="commercial-chat-send" type="submit" aria-keyshortcuts="Control+Enter" title="Ctrl+Enter 发送"${canSendChat() ? "" : " disabled"}>发送</button></div></div>
        </form>
      </section>
    </div><dialog class="commercial-asset-dialog" id="commercial-chat-asset-picker" aria-labelledby="commercial-chat-asset-title">
      <div class="row-between"><h3 id="commercial-chat-asset-title">选择我的素材</h3>${button("完成", "c-chat-close-picker")}</div>
      <div id="commercial-chat-asset-list"></div>
    </dialog>`, "chat");
  }

  function chatPlaceholder() {
    if (chat.webSearch) return "输入要核实的资料，例如小米 SU7 Ultra 官方参数，再做一张宣传海报";
    return chat.agent ? "描述要生成的图片或 GIF，也可以附图说明怎么改" : "输入你的问题或写作需求";
  }

  function agentTools() {
    const imageModels = chat.catalog.models.filter(model => model.kind === "image");
    const skills = chat.catalog.creativeSkills || [];
    const disabled = chat.request || chat.uploading ? "disabled" : "";
    return `${skills.length ? `<label class="commercial-agent-model"><span class="sr-commercial">创作 Skill</span>
      <select class="input" id="commercial-chat-skill" ${disabled}>${skills.map(skill =>
        option(skill.id, skill.id === "auto" ? "创作 Skill · 智能推荐" : skill.name, chat.creativeSkill)).join("")}</select></label>` : ""}
    <label class="commercial-agent-model"><span class="sr-commercial">图片模型</span><select class="input" id="commercial-chat-image-model" ${disabled}>
      ${option("", "图片模型自动选择", chat.imageModelId)}${imageModels.map(model => option(model.id, `${model.name} · ${price(model.price)} 积分/张`, chat.imageModelId)).join("")}
    </select></label>${button("上传图片", "c-chat-upload", "", "secondary", disabled)}${button("选择素材", "c-chat-assets", "", "secondary", disabled)}`;
  }

  function attachmentLimit() {
    const selected = chat.catalog.models.find(model => model.id === chat.imageModelId);
    return Math.min(16, Number(selected?.maxReferences) || 16);
  }

  function knownImage(id) {
    const item = ui.files.find(item => item.id === id) || chat.assets.get(id);
    return item?.mime?.startsWith("image/") && item.mime !== "image/svg+xml" ? item : undefined;
  }

  function attachmentList() {
    if (!chat.agent || !chat.attachmentIds.length) return "";
    return `<ul class="commercial-attachments" aria-label="已附加的图片">${chat.attachmentIds.map(id => {
      const name = knownImage(id)?.name || "参考图片";
      return `<li><span>${escape(name)}</span>${button("移除", "c-chat-remove-asset", id, "ghost", `${chat.request ? "disabled " : ""}aria-label="移除 ${escape(name)}"`)}</li>`;
    }).join("")}</ul>`;
  }

  function chatModels() {
    return chat.catalog.models.filter(model => model.kind === "chat" && model.capabilities?.includes("text"));
  }

  function chatOptions() {
    const models = chatModels();
    return models.length ? models.map(model => option(model.id, model.name, chat.modelId)).join("") : option("", "暂无可用语言模型", "");
  }

  function chatPrice() {
    const model = chatModels().find(item => item.id === chat.modelId);
    return model ? `${tokenRateText(model)}；${contextWindowText(model)}。长对话自动整理摘要，摘要用量计入本轮。` : "请在后台设置上架语言模型。";
  }

  function chatTitle() {
    return chat.conversations.find(item => item.id === chat.active)?.title || "新对话";
  }

  function chatList() {
    if (!chat.conversations.length) return '<p class="meta commercial-chat-empty">还没有对话记录。</p>';
    return chat.conversations.map(item => `<div class="commercial-chat-thread">
      ${button(item.title || "新对话", "c-chat-open", item.id, "ghost", `aria-pressed="${chat.active === item.id}" title="${escape(item.title)}"`)}
      ${item.id === chat.active ? button("删除", "c-chat-delete", item.id, "ghost", `aria-label="删除对话 ${escape(item.title)}"`) : ""}
    </div>`).join("");
  }

  function chatMessages() {
    if (!chat.messages.length && !chat.plans.length) return '<div class="commercial-chat-welcome"><h3>开始一段对话</h3><p class="meta">例如，生成一张产品海报，或把附图的背景换成暖灰色。</p></div>';
    const plansByTurn = new Map(chat.plans.map(plan => [plan.turnId, plan]));
    const anchored = new Set();
    const messages = chat.messages.map((item, index) => {
      const plan = item.role === "assistant" && item.turnId != null ? plansByTurn.get(item.turnId) : undefined;
      if (plan) anchored.add(plan.id);
      return `<article class="commercial-message commercial-${item.role === "user" ? "user" : "assistant"}">
      <strong>${escape(item.role === "user" ? "你" : item.modelName || "AI")}</strong>
      <p${item.live ? ' data-stream-output aria-live="off"' : ""}>${escape(item.live ? item.liveText || "正在回复…" : item.text)}</p>
      ${item.webSearch ? searchSources(item.webSearch, index) : ""}
      ${item.role === "user" ? messageAttachments(item.assetIds) : ""}
      ${item.role === "assistant" && item.text && !item.live && !plan ? button("用作 PPT 需求", "c-chat-to-ppt", index, "ghost") : ""}
    </article>${plan ? planCard(plan) : ""}`;
    }).join("");
    return messages + chat.plans.filter(plan => !anchored.has(plan.id)).map(planCard).join("");
  }

  function searchSources(result, index, expanded = false) {
    if (!result.sources?.length) {
      const message = result.status === "unavailable" ? "搜索服务暂时无法连接。" :
        result.status === "needs_subject" ? "请补充要查询的具体名称或型号。" : "没有找到可用的公开资料。";
      return `<p class="meta commercial-search-note">${message}</p>`;
    }
    const links = result.sources.map((item, position) => {
      let url;
      try { url = new URL(item.url); } catch { return ""; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
      return `<li><a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">[${position + 1}] ${escape(item.title)}</a>
        <span class="meta">${escape(url.hostname)} · ${item.pageExcerpt ? "已读取正文" : item.snippet || item.hasSnippet ? "仅搜索摘要" : "链接暂未读到正文"}</span></li>`;
    }).join("");
    return `<details class="commercial-search-sources" data-prompt="sources:${index}" ${expanded ? "open" : ""}><summary>${result.reused ? "沿用的联网来源" : "联网来源"}（${result.sources.length}）</summary>
      <p class="meta">检索主题：${escape(result.query)}</p>
      ${result.queries?.length ? `<p class="meta">检索词：${result.queries.map(escape).join("；")}</p>` : ""}
      ${result.missingTargets?.length ? `<p class="meta">尚缺资料：${result.missingTargets.map(escape).join("、")}</p>` : ""}
      <ol>${links}</ol></details>`;
  }

  function messageAttachments(ids) {
    if (!ids?.length) return "";
    return `<div class="commercial-message-assets" aria-label="随消息发送的图片">${ids.map(id => {
      const item = knownImage(id);
      return item ? uploadArtwork(uploadDescriptor(item), `chat-asset:${id}`, true) : '<span class="meta">图片素材</span>';
    }).join("")}</div>`;
  }

  function gifPlan(plan) {
    return plan.actions?.[0]?.tool === "generate_gif_sequence";
  }

  function gifDuration(ms) {
    return `${(ms / 1000).toLocaleString("zh-CN", {maximumFractionDigits: 2})} 秒`;
  }

  function gifPlanProgress(plan) {
    const final = plan.results?.[0];
    if (final?.asset) return "拼接完成";
    if (final?.error) return "拼接失败";
    const jobs = (plan.jobIds || []).map(id => chat.jobs.get(id));
    const complete = jobs.filter(job => job?.status === "succeeded").length;
    if (jobs.length && complete === jobs.length) return "正在拼接完整 GIF";
    if (jobs.some(job => ["failed", "cancelled", "unknown"].includes(job?.status))) return `已生成 ${complete}/${jobs.length} 段，部分片段未完成`;
    return `已生成 ${complete}/${jobs.length} 段`;
  }

  function planCard(plan) {
    const states = {pending: "待确认", submitted: "已提交", cancelled: "已取消"};
    const isGif = gifPlan(plan);
    const skill = plan.actions?.find(action => action.creativeSkill)?.creativeSkill;
    const heading = isGif ? "GIF 制作方案" : skill ? `${skill}方案` : "图片任务方案";
    const status = isGif && plan.status === "submitted" ? gifPlanProgress(plan) : states[plan.status] || plan.status;
    const busy = chat.planBusy.has(plan.id);
    const outputLimit = isGif && plan.actions[0].maxOutputBytes;
    const actions = (plan.actions || []).map((action, index) => {
      const ids = [action.sourceId, ...(action.referenceIds || [])].filter(Boolean);
      const materials = ids.length ? ids : (action.assetIds || []);
      const unit = isGif ? "段" : "张";
      const meta = [action.modelName, action.size?.replace("x", " × "), Number.isInteger(action.count) && `${action.count} ${unit}`,
        action.modelName && `${price(action.unitPrice)} 积分/${unit}`, isGif && gifDuration(action.durationMs)].filter(Boolean).join(" · ");
      const regions = action.arguments?.regions || [];
      const clips = isGif ? (action.arguments?.clips || []) : [];
      return `<li><b>${escape(action.label || "图片任务")}</b><span class="meta">${escape(meta)}</span>
        ${materials.length ? `<span class="meta">素材 ${materials.map(id => escape(knownImage(id)?.name || "图片")).join("、")}</span>` : ""}
        ${clips.map((clip, clipIndex) => `<details data-prompt="${escape(plan.id)}:clip:${clipIndex}">
          <summary>片段 ${clipIndex + 1} · ${escape(clip.frames)} 帧 · ${gifDuration(clip.frames * clip.frameDurationMs)}</summary><p>${escape(clip.prompt)}</p></details>`).join("")}
        ${action.prompt || regions.length ? `<details data-prompt="${escape(plan.id)}:${index}"><summary>${regions.length ? `查看 ${regions.length} 处选区与说明` : "查看提示词"}</summary>
          ${action.prompt ? `<p>${escape(action.prompt)}</p>` : ""}${regions.map(region => {
            const percent = value => `${Number(value).toFixed(1).replace(/\.0$/, "")}%`;
            const size = `左 ${percent(region.x)} · 上 ${percent(region.y)} · 宽 ${percent(region.w)} · 高 ${percent(region.h)}`;
            const reference = region.referenceId ? knownImage(region.referenceId)?.name || "参考图" : "";
            return `<p>${escape(size)}${region.note ? ` · ${escape(region.note)}` : ""}${reference ? ` · 融入 ${escape(reference)}` : ""}</p>`;
          }).join("")}</details>` : ""}</li>`;
    }).join("");
    const jobs = (plan.results || []).map(planResult).join("") + (plan.jobIds || []).map(id => planJob(id)).join("");
    return `<section class="commercial-agent-plan" aria-label="${escape(heading)}">
      <div class="commercial-plan-heading"><h3>${escape(heading)}</h3><span class="meta" role="status">${escape(status)}</span></div>
      <ol class="commercial-plan-actions">${actions}</ol>
      ${plan.status === "pending" && outputLimit ? `<p class="meta">完整 GIF 最大 ${outputLimit / (1024 * 1024)} MB。超出时可分别下载片段。</p>` : ""}
      ${plan.status === "pending" && skill ? '<p class="meta">可在对话里说明要改哪张图，再确认新版方案。</p>' : ""}
      ${plan.status === "pending" ? `<div class="commercial-plan-footer"><b>预计 ${price(plan.totalPrice)} 积分${isGif ? " · 拼接免费" : ""}</b><div class="row">
        ${button("取消方案", "c-chat-cancel-plan", plan.id, "ghost", busy ? "disabled" : "")}
        ${button(busy ? "处理中…" : isGif ? "确认生成并拼接" : "确认执行", "c-chat-confirm-plan", plan.id, "primary", busy ? "disabled" : "")}</div></div>` : ""}
      ${jobs ? `<ul class="commercial-plan-jobs" aria-label="执行结果">${jobs}</ul>` : ""}
    </section>`;
  }

  function planJob(id) {
    const job = chat.jobs.get(id);
    if (!job) return '<li class="meta">正在读取任务状态…</li>';
    const delivered = job.status === "succeeded" && job.assetId;
    const isGif = job.context?.outputFormat === "gif";
    const asset = knownImage(job.assetId) || (delivered && isGif ? {id: job.assetId, name: `${job.label}.gif`, mime: "image/gif"} : null);
    return `<li class="commercial-plan-job"><div class="commercial-plan-job-status">
      <b>${escape(job.label || "图片任务")}</b><span class="meta" role="status">${jobProgress(job)}</span>
      ${delivered && job.width && job.height ? `<span class="meta">${escape(job.width)} × ${escape(job.height)} px</span>` : ""}
      ${job.error ? `<span class="commercial-job-error">${escape(job.error)}</span>` : ""}${jobErrorLink(job)}</div>
      ${delivered ? resultImage(job.assetId, asset, isGif ? "下载片段 GIF" : "") : jobPreview(job)}
    </li>`;
  }

  function planResult(result) {
    if (result.tool === "generate_gif_sequence") {
      if (result.asset?.id) return `<li class="commercial-plan-job"><b>完整 GIF</b>${resultImage(result.asset.id, result.asset, "下载完整 GIF")}</li>`;
      if (result.error) return `<li class="commercial-plan-job"><details data-prompt="gif-sequence-error"><summary>查看合成错误</summary><p class="commercial-job-error">${escape(result.error)}</p></details></li>`;
    }
    if (result.asset?.id) return `<li class="commercial-plan-job"><b>${escape(result.asset.name || "处理结果")}</b>${resultImage(result.asset.id, result.asset)}</li>`;
    if (typeof result.text === "string") return `<li class="commercial-plan-job"><b>提取结果</b><p class="commercial-job-text">${escape(result.text || "未识别到文字。")}</p></li>`;
    return "";
  }

  function resultImage(id, asset, gifDownload = "") {
    return `<div class="commercial-job-result">${asset ? uploadArtwork(uploadDescriptor(asset), `chat-job:${id}`, true) : ""}
      <div class="row"><a class="btn btn-secondary" href="/api/assets/${escape(id)}/download">${gifDownload || "下载图片"}</a>
      ${gifDownload ? "" : button("送去图片编辑", "c-chat-edit-result", id, "secondary")}</div></div>`;
  }

  function drawChat({ thread = true, scroll = true } = {}) {
    const select = document.querySelector("#commercial-chat-model");
    if (!select) return;
    const list = document.querySelector("#commercial-chat-list");
    const messages = document.querySelector("#commercial-chat-messages");
    const wasAtEnd = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 30;
    if (thread) list.innerHTML = chatList();
    if (thread) {
      const previousScroll = messages.scrollTop;
      const focused = messages.contains(document.activeElement) ? document.activeElement : null;
      const expanded = new Set([...messages.querySelectorAll("details[open]")].map(item => item.dataset.prompt));
      messages.innerHTML = chatMessages();
      for (const detail of messages.querySelectorAll("details")) detail.open = expanded.has(detail.dataset.prompt);
      if (!scroll) messages.scrollTop = previousScroll;
      if (focused?.dataset.action) {
        const replacement = [...messages.querySelectorAll("[data-action]")].find(element => element.dataset.action === focused.dataset.action && element.dataset.value === focused.dataset.value);
        replacement?.focus({preventScroll: true});
      }
    } else {
      const live = messages.querySelector("[data-stream-output]");
      if (live) live.textContent = chat.messages.at(-1)?.liveText || "正在回复…";
    }
    if (scroll || wasAtEnd) messages.scrollTop = messages.scrollHeight;
    document.querySelector("#commercial-chat-title").textContent = chatTitle();
    document.querySelector("#commercial-chat-price").textContent = chatPrice();
    document.querySelector("#commercial-chat-notice").textContent = chat.notice;
    if (thread) {
      select.innerHTML = chatOptions();
      select.disabled = Boolean(chat.request) || !chat.modelId;
      document.querySelector("#commercial-chat-send").disabled = !canSendChat();
      document.querySelector('[data-action="c-chat-stop"]').hidden = !chat.request;
      document.querySelector('[data-action="c-chat-new"]').disabled = Boolean(chat.request);
      const webToggle = document.querySelector("#commercial-chat-web-search");
      if (webToggle) {
        webToggle.closest("[data-chat-web-search]").hidden = !chat.catalog.webSearch;
        webToggle.checked = chat.webSearch;
        webToggle.disabled = Boolean(chat.request);
      }
      document.querySelector("#commercial-chat-text").placeholder = chatPlaceholder();
      drawAgentTools();
    }
  }

  function canSendChat() {
    return Boolean(chat.modelId) && !chat.request && !chat.uploading && (!chat.agent || chat.attachmentIds.length <= attachmentLimit());
  }

  function drawAgentTools() {
    const toggle = document.querySelector("#commercial-chat-agent");
    if (!toggle) return;
    toggle.checked = chat.agent;
    toggle.disabled = Boolean(chat.request) || chat.uploading;
    const tools = document.querySelector("#commercial-chat-agent-tools");
    const next = agentTools();
    tools.hidden = !chat.agent;
    // Do not replace the model selector while it has keyboard focus.
    if (tools.innerHTML !== next && !tools.contains(document.activeElement)) tools.innerHTML = next;
    for (const item of tools.querySelectorAll("select, button")) item.disabled = Boolean(chat.request) || chat.uploading;
    document.querySelector("#commercial-chat-text").placeholder = chatPlaceholder();
    const attachments = document.querySelector("#commercial-chat-attachments");
    attachments.innerHTML = attachmentList();
  }

  function chatIsCurrent(instance, id, revision) {
    return chat === instance && account?.id === activeOwner && ui.route === "chat" && chat.active === id && chat.openRevision === revision;
  }

  function updatePlan(plan) {
    if (!plan?.id) return;
    const index = chat.plans.findIndex(item => item.id === plan.id);
    if (index < 0) chat.plans.push(plan);
    else chat.plans[index] = plan;
  }

  function watchAgentJobs() {
    if (ui.route !== "chat" || !chat.active || !chat.plans.some(plan => plan.jobIds?.length)) return;
    scheduleJobs();
    receiveImageJobs(live.jobs, true).catch(() => {});
  }

  function watchAnimationResults(instance, current) {
    for (const plan of instance.plans) {
      const key = `${instance.openRevision}:${plan.id}`;
      if (!gifPlan(plan) || plan.status !== "submitted" || plan.results?.length || !plan.jobIds?.length || instance.assemblyPolls.has(key)) continue;
      const statuses = () => plan.jobIds.map(id => instance.jobs.get(id)?.status);
      const failed = () => {
        const states = statuses();
        return states.every(status => ["succeeded", "failed", "cancelled"].includes(status)) && states.some(status => status !== "succeeded");
      };
      if (failed()) continue;
      instance.assemblyPolls.add(key);
      (async () => {
        try {
          while (current() && !failed()) {
            const result = await api(`chat/conversations/${encodeURIComponent(instance.active)}/plans/${encodeURIComponent(plan.id)}`).catch(() => null);
            if (!current()) return;
            const completed = result?.plan?.results?.length;
            if (completed) updatePlan(result.plan);
            if (result?.jobs) await receiveImageJobs(result.jobs);
            if (completed) {
              if (current()) drawChat({scroll: false});
              return;
            }
            const states = statuses();
            const waitingForReview = states.includes("unknown") && !states.some(status => status === "running" || status === "queued");
            await new Promise(resolve => setTimeout(resolve, waitingForReview ? 10000 : 1500));
          }
        } finally {
          instance.assemblyPolls.delete(key);
        }
      })().catch(() => {});
    }
  }

  async function receiveImageJobs(jobs, fetchOlder = false) {
    const instance = chat;
    if (ui.route !== "chat" || !instance.active) return;
    const ids = [...new Set(instance.plans.flatMap(plan => plan.jobIds || []))];
    if (!ids.length) return;
    const {active, openRevision} = instance;
    const current = () => chatIsCurrent(instance, active, openRevision);
    const found = new Map(jobs.map(job => [job.id, job]));
    if (fetchOlder) {
      const missing = ids.filter(id => !found.has(id) && !instance.jobs.has(id));
      const results = await Promise.allSettled(missing.map(id => api(`jobs/${encodeURIComponent(id)}`)));
      if (!current()) return;
      const latest = new Map(live.jobs.map(job => [job.id, job]));
      for (const [id, job] of latest) found.set(id, job);
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.job && !instance.jobs.has(result.value.job.id)) {
          found.set(result.value.job.id, result.value.job);
        }
      }
    }
    const changed = ids.map(id => found.get(id)).filter(job => {
      if (!job) return false;
      const existing = instance.jobs.get(job.id);
      if (existing && (existing.updated > job.updated || (!activeJob(existing) && activeJob(job)))) return false;
      return JSON.stringify(job) !== JSON.stringify(existing);
    });
    for (const job of changed) instance.jobs.set(job.id, job);
    watchAnimationResults(instance, current);
    if (!changed.length) return;
    if (changed.some(job => job.assetId && !knownImage(job.assetId))) await loadChatAssets().catch(() => {});
    if (!current()) return;
    if (changed.some(job => !activeJob(job)) && !instance.request) {
      const result = await api("session").catch(() => null);
      if (current() && !instance.request && result?.user) applyChatWallet({points: result.user.points, ledger: result.ledger});
    }
    if (current()) drawChat({scroll: false});
  }

  async function loadChatAssets() {
    const instance = chat;
    const result = await api("assets");
    if (chat !== instance || account?.id !== activeOwner) return [];
    const images = (result.items || []).filter(item => item.mime?.startsWith("image/"));
    instance.assets = new Map(images.map(item => [item.id, item]));
    return images;
  }

  function applyChatWallet(wallet) {
    if (!Number.isFinite(wallet?.points) || !Array.isArray(wallet.ledger)) return;
    updateWallet(wallet);
    document.querySelector("#balance").textContent = price(wallet.points);
  }

  function restoreDraft() {
    const field = document.querySelector("#commercial-chat-text");
    if (field && field.value !== chat.draft) field.value = chat.draft;
  }

  function chooseChatModel(preferred) {
    const models = chatModels();
    const options = [preferred, chat.modelId, chat.catalog.defaults.chat];
    chat.modelId = options.find(id => models.some(model => model.id === id)) || models[0]?.id || "";
  }

  async function refreshChat() {
    const owner = syncOwner();
    if (!owner || chat.request) return;
    const revision = chat.openRevision;
    const [catalog, result] = await Promise.all([api("catalog"), api("chat/conversations")]);
    if (owner !== activeOwner || owner !== account?.id || ui.route !== "chat" || chat.request) return;
    chat.catalog = {models: catalog.models || [], defaults: catalog.defaults || {}, webSearch: catalog.webSearch === true,
      creativeSkills: catalog.creativeSkills || []};
    chat.conversations = result.conversations || [];
    if (!chat.catalog.models.some(model => model.id === chat.imageModelId && model.kind === "image")) chat.imageModelId = "";
    chooseChatModel();
    if (!chat.loaded && chat.conversations.length && chat.openRevision === revision) {
      chat.loaded = true;
      await openChat(chat.conversations[0].id, {preserveDraft: true});
      return;
    }
    chat.loaded = true;
    drawChat();
    watchAgentJobs();
  }

  async function openChat(id, {preserveDraft = false} = {}) {
    if (chat.request) return notify("请先等待当前回复结束，或点击停止输出。");
    const instance = chat;
    const revision = ++instance.openRevision;
    if (!preserveDraft) ++instance.draftRevision;
    const result = await api(`chat/conversations/${encodeURIComponent(id)}`);
    if (chat !== instance || chat.openRevision !== revision || chat.request || account?.id !== activeOwner || ui.route !== "chat") return;
    chat.active = id;
    chat.messages = result.messages || [];
    chat.plans = result.plans || [];
    chat.jobs.clear();
    if (!preserveDraft) {
      chat.attachmentIds = [];
      chat.draft = "";
      chat.notice = "";
    }
    chooseChatModel(result.conversation?.modelId || chat.messages.at(-1)?.modelId);
    restoreDraft();
    drawChat();
    watchAgentJobs();
  }

  function newChat() {
    if (chat.request) return notify("请先等待当前回复结束，或点击停止输出。");
    ++chat.openRevision;
    ++chat.draftRevision;
    chat.active = "";
    chat.messages = [];
    chat.plans = [];
    chat.jobs.clear();
    chat.attachmentIds = [];
    chat.draft = "";
    chat.modelId = "";
    chat.notice = "";
    chooseChatModel();
    restoreDraft();
    drawChat();
    document.querySelector("#commercial-chat-text")?.focus();
  }

  function seedChatDraft(text, {fromTemplate = false, textOnly = fromTemplate} = {}) {
    const owner = syncOwner();
    if (chat.request || chat.uploading) {
      if (fromTemplate) notify("请等待当前对话操作完成后再使用模板。");
      return;
    }
    const prompt = String(text).slice(0, 12000);
    const apply = () => {
      if (syncOwner() !== owner) return;
      if (owner) {
        newChat();
        chat.loaded = true;
        chat.draft = prompt;
        if (textOnly) chat.agent = false;
        restoreDraft();
        drawChat();
      } else if (fromTemplate) {
        ui.guestChatPrompt = prompt;
        ui.guestChatTextOnly = textOnly;
      }
      if (fromTemplate) go("chat");
    };
    const currentDraft = owner ? chat.draft : ui.guestChatPrompt;
    if (fromTemplate && ((currentDraft?.trim() && currentDraft !== prompt) || chat.attachmentIds.length)) {
      return openModal("从模板开始新对话", "", "将替换当前未发送的内容。", "使用模板", apply);
    }
    apply();
  }

  function renderAssetPicker(images = [...chat.assets.values()]) {
    const list = document.querySelector("#commercial-chat-asset-list");
    if (!list) return;
    list.innerHTML = images.length ? `<div class="commercial-asset-grid">${images.map(item => {
      const picked = chat.attachmentIds.includes(item.id);
      return `<button type="button" class="commercial-asset-choice" data-action="c-chat-pick" data-value="${escape(item.id)}" aria-pressed="${picked}">
        <img src="/api/assets/${escape(item.id)}" loading="lazy" alt=""><span>${escape(item.name)}</span></button>`;
    }).join("")}</div>` : '<p class="meta">暂无图片素材。可以在对话中上传图片。</p>';
  }

  async function openAssetPicker() {
    if (!chat.agent || chat.request || chat.uploading) return;
    const dialog = document.querySelector("#commercial-chat-asset-picker");
    if (!dialog || dialog.open) return;
    dialog.querySelector("#commercial-chat-asset-list").textContent = "正在读取素材…";
    dialog.showModal();
    try {
      const images = await loadChatAssets();
      if (dialog.isConnected && dialog.open) renderAssetPicker(images);
    } catch (error) {
      if (dialog.isConnected && dialog.open) dialog.querySelector("#commercial-chat-asset-list").textContent = error.message;
    }
  }

  function attachImage(id) {
    if (chat.request || !chat.agent || !knownImage(id)) return false;
    if (chat.attachmentIds.includes(id)) return true;
    if (chat.attachmentIds.length >= attachmentLimit()) {
      notify(`当前最多可附加 ${attachmentLimit()} 张图片。`);
      return false;
    }
    chat.attachmentIds.push(id);
    return true;
  }

  async function uploadChatFiles(files, pasted = false) {
    if (!chat.agent || chat.request || chat.uploading || !files.length) return;
    if (chat.attachmentIds.length + files.length > attachmentLimit()) {
      return notify(`当前最多可附加 ${attachmentLimit()} 张图片，请减少选择数量。`);
    }
    const instance = chat;
    const {draftRevision} = instance;
    const owner = identity;
    const sameDraft = () => chat === instance && identity === owner && ui.route === "chat" && instance.draftRevision === draftRevision;
    instance.uploading = true;
    instance.notice = "正在上传图片…";
    drawChat({scroll: false});
    const errors = [];
    try {
      for (const file of files) {
        if (!sameDraft()) break;
        try {
          const stored = await storeFile(normalizeFile(file, "chat", pasted), owner);
          if (stored && sameDraft()) attachImage(stored.id);
        } catch (error) {
          errors.push(error.message);
        }
      }
    } finally {
      instance.uploading = false;
      if (sameDraft()) instance.notice = errors.join(" ");
      if (chat === instance && ui.route === "chat") drawChat({scroll: false});
    }
  }

  async function changePlan(id, action) {
    const instance = chat;
    const {active} = instance;
    const current = () => chat === instance && account?.id === activeOwner && ui.route === "chat" && chat.active === active;
    const plan = instance.plans.find(item => item.id === id);
    if (!active || !plan || plan.status !== "pending" || instance.planBusy.has(id)) return;
    instance.planBusy.add(id);
    drawChat({scroll: false});
    try {
      const result = await api(`chat/conversations/${encodeURIComponent(active)}/plans/${encodeURIComponent(id)}/${action}`, "POST", {});
      if (chat === instance && account?.id === activeOwner) {
        applyChatWallet(result);
        if (result.jobs?.length) scheduleJobs();
      }
      if (!current()) return;
      updatePlan(result.plan);
      for (const job of result.jobs || []) instance.jobs.set(job.id, job);
      instance.notice = action === "confirm" ? (gifPlan(plan) ? "GIF 片段已提交，全部生成后自动拼接。" : "图片任务已提交。") : "方案已取消。";
      watchAgentJobs();
      if ((result.jobs || []).some(job => job.assetId && !knownImage(job.assetId))) await loadChatAssets().catch(() => {});
    } catch (error) {
      if (current()) instance.notice = error.message;
    } finally {
      instance.planBusy.delete(id);
      if (current()) drawChat({scroll: false});
    }
  }

  function confirmAction(title, text, note, label, action) {
    openModal(title, text, note, label, () => run(action));
  }

  async function deleteChat(id) {
    if (chat.request) return notify("请先等待当前回复结束，或点击停止输出。");
    await api(`chat/conversations/${encodeURIComponent(id)}`, "DELETE");
    chat.conversations = chat.conversations.filter(item => item.id !== id);
    if (chat.active === id) newChat();
    await refreshChat();
  }

  async function parseStream(response, applyEvent) {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || body.message || "对话请求失败。");
      error.status = response.status;
      throw error;
    }
    if (!response.body) throw new Error("浏览器未收到对话内容。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let done = false;
    const handleLine = async line => {
      const value = line.trim();
      if (!value || value.startsWith(":")) return;
      const data = value.startsWith("data:") ? value.slice(5).trim() : value;
      if (data === "[DONE]") { done = true; return; }
      if (!data.startsWith("{")) return;
      const event = JSON.parse(data);
      if (event.type === "done") done = true;
      await applyEvent(event);
    };
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) await handleLine(line);
      }
      await handleLine(pending + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!done) {
      const error = new Error("回复连接提前关闭，已保留收到的内容。");
      error.uncertain = true;
      throw error;
    }
  }

  async function sendChat(form) {
    if (!canSendChat()) return;
    const text = String(new FormData(form).get("text") || "").trim();
    if (!text) return;
    const model = chatModels().find(item => item.id === chat.modelId);
    if (!model) throw new Error("请选择已上架的语言模型。");
    const owner = syncOwner();
    const instance = chat;
    const agent = instance.agent;
    const webSearch = instance.webSearch;
    const assetIds = agent ? [...instance.attachmentIds] : [];
    const imageModelId = agent ? instance.imageModelId : "";
    const creativeSkill = agent ? instance.creativeSkill : "";
    const options = JSON.stringify([agent, imageModelId, creativeSkill, assetIds, webSearch]);
    const interrupted = instance.interrupted;
    const replay = interrupted && interrupted.id === instance.active && interrupted.modelId === model.id && interrupted.text === text && interrupted.options === options;
    const requestId = replay ? interrupted.requestId : crypto.randomUUID();
    const controller = new AbortController();
    const request = { controller, id: requestId };
    const userMessage = { role: "user", text, assetIds };
    const assistant = { role: "assistant", text: "", live: true, modelName: model.name };
    const reveal = revealText(text => {
      assistant.liveText = text;
      if (chat === instance && owner === account?.id && ui.route === "chat") drawChat({thread: false, scroll: false});
    });
    let remoteIssue = "";
    let fetchStarted = false;
    instance.request = request;
    instance.notice = agent ? "正在分析请求…" : "";
    ++instance.openRevision;
    drawChat();
    try {
      if (!instance.active) {
        const result = await api("chat/conversations", "POST", { title: text.slice(0, 42) });
        if (chat !== instance || owner !== account?.id) return;
        instance.active = result.conversation.id;
        instance.conversations.unshift(result.conversation);
      }
      if (controller.signal.aborted) return;
      instance.draft = "";
      if (agent) instance.attachmentIds = [];
      if (!replay || instance.messages.at(-1)?.role !== "user" || instance.messages.at(-1)?.text !== text) instance.messages.push(userMessage);
      instance.messages.push(assistant);
      restoreDraft();
      drawChat();
      fetchStarted = true;
      const response = await fetch(`/api/chat/conversations/${encodeURIComponent(instance.active)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ modelId: model.id, tokenRates: model.tokenRates, text, requestId,
          ...(webSearch ? {webSearch: true} : {}), ...(agent ? {agent, assetIds, creativeSkill, ...(imageModelId ? {imageModelId} : {})} : {}) }),
        signal: controller.signal
      });
    await parseStream(response, event => {
        if (chat !== instance || owner !== account?.id) return;
        if (event.type === "error") remoteIssue = event.message || "模型回复失败。";
        if (event.type === "memory") {
          instance.notice = event.state === "compacting" ? "正在整理较早对话，保留关键决定和纠正…" : "已载入会话摘要，继续回复…";
          drawChat({thread: false});
        }
        if (event.type === "web-search-start") {
          instance.notice = "正在搜索公开资料…";
          drawChat({thread: false});
        }
        if (event.type === "web-search") {
          assistant.webSearch = event.result;
          instance.notice = "正在整理搜索结果…";
          drawChat();
        }
        if (event.type === "delta" || event.type === "replace") {
          assistant.text = (event.type === "delta" ? assistant.text : "") + String(event.text || "");
          reveal.set(assistant.text);
        }
        if (event.type === "plan" && event.plan) {
          assistant.turnId = event.plan.turnId;
          updatePlan(event.plan);
          drawChat();
        }
        if (event.type === "done" && event.wallet) {
          applyChatWallet(event.wallet);
          remoteIssue = [remoteIssue, tokenBillingText(event.billing)].filter(Boolean).join(" ");
        }
      });
      await reveal.drain();
      if (chat !== instance || owner !== account?.id) return;
      instance.interrupted = null;
      instance.notice = remoteIssue || "回复已保存。";
      if (!assistant.text && !assistant.webSearch) instance.messages = instance.messages.filter(message => message !== assistant);
    } catch (error) {
      if (chat !== instance || owner !== account?.id) return;
      instance.notice = error.name === "AbortError" ? "已停止接收回复。" : error.message;
      if (fetchStarted && (!error.status || error.status >= 500 || (replay && error.status === 409))) {
        instance.interrupted = { id: instance.active, requestId, modelId: model.id, text, options };
      } else if (!replay) {
        instance.interrupted = null;
      }
      if (!assistant.text && !assistant.webSearch) {
        instance.messages = instance.messages.filter(message => message !== assistant && message !== userMessage);
        if (error.name !== "AbortError") {
          instance.draft ||= text;
          if (agent) instance.attachmentIds = assetIds;
        }
      }
    } finally {
      reveal.flush();
      assistant.live = false;
      if (chat === instance && owner === account?.id) {
        instance.request = null;
        restoreDraft();
        drawChat();
        watchAgentJobs();
        if (instance.active && !controller.signal.aborted) {
          const id = instance.active;
          const revision = instance.openRevision;
          api(`chat/conversations/${encodeURIComponent(id)}`).then(result => {
            if (!chatIsCurrent(instance, id, revision) || chat.request || !result.messages?.length) return;
            chat.messages = result.messages;
            for (const plan of result.plans || []) {
              const local = chat.plans.find(item => item.id === plan.id);
              if (!local || local.status === "pending" || plan.status !== "pending") updatePlan(plan);
            }
            drawChat();
            watchAgentJobs();
          }).catch(() => {});
        }
      }
    }
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form));
  }

  function directoryEntries(result) {
    return (result.models || []).map(item => typeof item === "string" ? { id: item, name: item } : item)
      .filter(item => typeof item?.id === "string" && item.id);
  }

  function drawDirectory(form) {
    const connectionId = form.elements.connectionId.value;
    form.elements.directoryModel.innerHTML = modelOptions(connectionId, form.elements.modelSearch.value, form.elements.modelId.value);
  }

  function updatePublishControl(form) {
    const control = form.elements.enabled;
    const available = admin.connections.some(connection => connection.id === form.elements.connectionId.value && connection.enabled);
    control.disabled = !available;
    if (!available) control.checked = false;
    form.querySelector("[data-publish-note]").textContent = available ? "启用后随本次保存立即上架。" : "启用服务连接后可上架。";
    form.querySelector("[data-save-model]").textContent = control.checked ? "保存并上架" : "保存模型";
  }

  function updateModelKind(form, kind) {
    const image = kind === "image";
    form.querySelector("[data-capability-fields]").innerHTML = capabilityFields(kind);
    form.querySelector("[data-image-fields]").hidden = !image;
    form.querySelector("[data-image-price]").hidden = !image;
    form.querySelector("[data-token-prices]").hidden = image;
    for (const key of ["maxReferences", "price", "sizes"]) form.elements[key].disabled = !image;
    for (const key of ["maxReferences", "price"]) form.elements[key].required = image;
    for (const key of ["inputRate", "outputRate", "agentMode", "contextWindowTokens"]) form.elements[key].disabled = image;
    form.elements.contextWindowTokens.closest('label').hidden = image;
  }

  function suggestModelKind(form) {
    if (form.dataset.id || form.dataset.manualKind) return;
    const id = form.elements.modelId.value.trim().toLowerCase().split("/").at(-1);
    const imageModel = /image|dall-e|banana|imagen|flux/.test(id);
    const languageModel = /^(gpt-|claude-|gemini-|qwen|deepseek|o[134](?:-|$))/.test(id);
    const kind = imageModel ? "image" : languageModel ? "chat" : "";
    if (kind && kind !== form.elements.kind.value) {
      form.elements.kind.value = kind;
      updateModelKind(form, kind);
    }
  }

  async function discoverActiveModel() {
    const control = document.querySelector('#commercial-admin-main [data-commercial="model"] [data-action="c-discover"]');
    if (control && !control.disabled) await discover(control, "model");
  }

  async function discover(control, type) {
    const form = control.closest("form");
    const notice = form.querySelector("[data-discovery]");
    const values = formValues(form);
    const connectionId = type === "model" ? values.connectionId : form.dataset.id;
    if (type === "connection" && !form.elements.baseUrl.reportValidity()) return;
    const body = type === "model" ? {} : { baseUrl: values.baseUrl, key: values.key || undefined };
    notice.textContent = "正在获取模型目录…";
    control.disabled = true;
    try {
      const endpoint = connectionId ? `admin/connections/${encodeURIComponent(connectionId)}/discover` : "admin/connections/discover";
      const result = await api(endpoint, "POST", body);
      if (!form.isConnected) return;
      const models = directoryEntries(result);
      if (type === "model") {
        admin.discovered.set(connectionId, models);
        if (form.elements.connectionId.value !== connectionId) return;
        drawDirectory(form);
      } else {
        admin.editor.directory = { baseUrl: values.baseUrl, models };
      }
      notice.textContent = models.length ? `获取到 ${models.length} 个模型。${type === "connection" ? "保存连接后可从目录选择。" : "可搜索后从下拉框选择。"}` : "服务目录为空，可手工录入模型 ID。";
    } catch (error) {
      if (form.isConnected && (type === "connection" || form.elements.connectionId.value === connectionId)) notice.textContent = error.message;
    } finally {
      control.disabled = false;
    }
  }

  async function saveConnection(form) {
    const values = formValues(form);
    const id = form.dataset.id;
    const instance = admin;
    const editor = admin.editor;
    const result = await api(id ? `admin/connections/${encodeURIComponent(id)}` : "admin/connections", id ? "PUT" : "POST", {
      name: values.name, baseUrl: values.baseUrl, key: values.key || undefined, enabled: Boolean(values.enabled)
    });
    if (admin !== instance) return;
    const saved = result.connection;
    const directory = editor?.directory;
    if (directory?.baseUrl === values.baseUrl) admin.discovered.set(saved.id, directory.models);
    if (admin.editor === editor) {
      if (id) {
        admin.editor = null;
      } else {
        admin.tab = "models";
        admin.editor = { type: "model", connectionId: saved.id };
      }
    }
    adminNotice("连接已保存。");
    await refreshAdmin(!admin.editor || admin.editor.connectionId === saved.id);
    if (!id && admin.editor?.connectionId === saved.id && !admin.discovered.has(saved.id)) await discoverActiveModel();
  }

  async function saveModel(form) {
    const values = formValues(form);
    const id = form.dataset.id;
    const instance = admin;
    const editor = admin.editor;
    if (admin.probing.has(id)) throw new Error("请等验证结束后再保存模型。");
    const capabilities = new FormData(form).getAll("capabilities");
    if (!capabilities.length) throw new Error("请选择需要开放的模型能力。");
    const body = {
      name: values.name, connectionId: values.connectionId, modelId: values.modelId,
      kind: values.kind, capabilities, pointScale: POINT_SCALE,
      enabled: Boolean(values.enabled)
    };
    if (values.kind === "image") {
      body.price = parsePoints(values.price);
      body.sizes = values.sizes.split(/[,，;；\s]+/).map(value => value.trim().replace(/[×X]/g, "x")).filter(Boolean);
      body.maxReferences = Number(values.maxReferences);
    } else {
      body.agentMode = values.agentMode;
      body.contextWindowTokens = values.contextWindowTokens ? Number(values.contextWindowTokens) : null;
      if (values.inputRate !== "" || values.outputRate !== "" || body.enabled) {
        if (values.inputRate === "" || values.outputRate === "") throw new Error("请分别填写输入和输出 Token 单价。");
        body.tokenRates = {input: parsePoints(values.inputRate), output: parsePoints(values.outputRate)};
      }
    }
    const result = await api(id ? `admin/models/${encodeURIComponent(id)}` : "admin/models", id ? "PUT" : "POST", body);
    if (admin !== instance) return;
    const refreshEditor = admin.editor === editor;
    if (refreshEditor) admin.editor = null;
    adminNotice(result.model.enabled ? "模型已保存并上架。" : "模型配置已保存。");
    await refreshAdmin(refreshEditor);
  }

  async function importModels(form) {
    const editor = admin.editor;
    const instance = admin;
    const values = formValues(form);
    const enabled = Boolean(values.enabled);
    const entries = (admin.discovered.get(editor.connectionId) || []).filter(item => editor.selected.has(item.id))
      .map(item => ({modelId: item.id, name: (item.name || item.id).slice(0, 80), contextWindowTokens: item.contextWindowTokens}));
    if (!entries.length) throw new Error("请从目录勾选要导入的模型。");
    const body = {action: "import", connectionId: editor.connectionId, kind: editor.kind, enabled, entries, pointScale: POINT_SCALE,
      capabilities: new FormData(form).getAll("capabilities")};
    if (editor.kind === "image") {
      if (enabled && values.price === "") throw new Error("请填写每张图片的积分单价。");
      if (values.price !== "") body.price = parsePoints(values.price);
    } else if (enabled || values.inputRate !== "" || values.outputRate !== "") {
      if (values.inputRate === "" || values.outputRate === "") throw new Error("请分别填写输入和输出 Token 单价。");
      body.tokenRates = {input: parsePoints(values.inputRate), output: parsePoints(values.outputRate)};
    }
    const result = await api("admin/models/batch", "POST", body);
    if (admin !== instance || admin.editor !== editor) return;
    admin.editor = null;
    admin.modelKind = editor.kind;
    admin.modelSelection.clear();
    adminNotice(`已导入 ${result.updated} 项，跳过 ${result.skipped} 项已添加模型。`);
    await refreshAdmin(true);
  }

  async function saveDefaults(form) {
    const values = formValues(form);
    const instance = admin;
    const result = await api("admin/defaults", "PUT", { image: values.image || null, chat: values.chat || null });
    if (admin !== instance) return;
    admin.defaults = result.defaults || {};
    adminNotice("默认模型已保存。");
    drawAdmin();
  }

  async function run(action) {
    try { await action(); }
    catch (error) {
      if (ui.route === "admin") adminNotice(error.message);
      else if (ui.route === "chat") {
        chat.notice = error.message;
        drawChat();
      } else notify(error.message);
    }
  }

  const actions = {
    "c-admin-reload": () => refreshAdmin(true),
    "c-admin-tab": async value => {
      if (!adminTabs.some(([id]) => id === value) || value === admin.tab) return;
      admin.tab = value;
      admin.editor = null;
      admin.notice = "";
      drawAdmin();
      if (value === "audit") await refreshAudit();
    },
    "c-connection": value => {
      admin.editor = { type: "connection", id: value };
      drawAdmin();
    },
    "c-connection-models": async value => {
      admin.tab = "models";
      admin.editor = { type: "model", connectionId: value };
      drawAdmin();
      if (!admin.discovered.has(value)) await discoverActiveModel();
    },
    "c-model": value => {
      admin.editor = { type: "model", id: value };
      drawAdmin();
    },
    "c-model-kind": value => {
      if (!(value in kindLabels) || value === admin.modelKind) return;
      admin.modelKind = value;
      admin.modelSelection.clear();
      drawAdmin();
    },
    "c-model-batch-import": () => {
      const connection = admin.connections.find(item => item.enabled) || admin.connections[0];
      if (!connection) return;
      admin.editor = {type: "batch", connectionId: connection.id, kind: admin.modelKind, selected: new Set()};
      drawAdmin();
    },
    "c-model-batch-state": action => {
      const kind = admin.modelKind;
      const ids = admin.models.filter(item => item.kind === kind && admin.modelSelection.has(item.id)).map(item => item.id);
      if (!ids.length) return;
      if (ids.length > 100) return adminNotice("每次最多操作 100 个模型，请减少所选项目。");
      const label = action === "publish" ? "上架" : "下架";
      confirmAction(`批量${label}`, `对选中的 ${ids.length} 个${kindLabels[kind]}模型执行${label}。`,
        action === "unpublish" ? "已设为默认的所选模型会同时取消默认。" : "上架后用户可在对应工作台选择。",
        `确认${label}`, async () => {
          const result = await api("admin/models/batch", "POST", {action, kind, ids});
          admin.modelSelection.clear();
          adminNotice(`已${label} ${result.updated} 项，${result.skipped} 项状态无需调整。`);
          await refreshAdmin(true);
        });
    },
    "c-batch-discover": async (_, event) => {
      const control = event.target.closest("[data-action=c-batch-discover]");
      const form = control.form;
      const editor = admin.editor;
      const connectionId = editor.connectionId;
      control.disabled = true;
      try {
        const result = await api(`admin/connections/${encodeURIComponent(connectionId)}/discover`, "POST", {});
        if (admin.editor !== editor || editor.connectionId !== connectionId || !form.isConnected) return;
        admin.discovered.set(connectionId, result.models || []);
        const available = new Set((result.models || []).map(item => item.id));
        editor.selected = new Set([...editor.selected].filter(id => available.has(id)));
        drawBatchDirectory(form);
      } finally {
        control.disabled = false;
      }
    },
    "c-batch-select": (_, event) => {
      const form = event.target.closest("form");
      const selected = admin.editor.selected;
      for (const input of form.querySelectorAll("[data-batch-select]:enabled")) {
        if (selected.size >= 100) break;
        selected.add(input.value);
      }
      drawBatchDirectory(form);
    },
    "c-batch-clear": (_, event) => {
      admin.editor.selected.clear();
      drawBatchDirectory(event.target.closest("form"));
    },
    "c-model-publish": async (id, event) => {
      const item = admin.models.find(model => model.id === id);
      if (!item || admin.probing.has(id)) return;
      const instance = admin;
      const control = event.target.closest('[data-action="c-model-publish"]');
      control.disabled = true;
      try {
        const result = await api(`admin/models/${encodeURIComponent(id)}`, "PUT", {enabled: !item.enabled});
        if (admin !== instance) return;
        if (admin.editor?.id === id) admin.editor = null;
        adminNotice(result.model.enabled ? "模型已上架。" : "模型已下架。");
        await refreshAdmin(true);
      } finally {
        if (control.isConnected) control.disabled = false;
      }
    },
    "c-editor-close": () => {
      admin.editor = null;
      drawAdmin();
    },
    "c-discover": (value, event) => discover(event.target.closest('[data-action="c-discover"]'), value),
    "c-probe": value => {
      const [id, capability] = value.split(":");
      if (admin.probing.has(id)) return;
      const form = document.querySelector('[data-commercial="model"]');
      if (form?.dataset.dirty) return adminNotice("请先保存修改，再测试已保存的模型配置。");
      if (admin.editor?.id === id) admin.editor.probesOpen = true;
      confirmAction("验证模型能力", `测试${capabilityLabels[capability] || capability}。`, "本次测试会调用上游，可能产生费用。", "执行测试", async () => {
        if (admin.probing.has(id)) return;
        const instance = admin;
        instance.probing.add(id);
        form?.querySelectorAll("input, select, button").forEach(control => {
          if (!control.disabled) {
            control.dataset.probeDisabled = "true";
            control.disabled = true;
          }
        });
        adminNotice("正在等待上游测试结果…");
        try {
          const response = await api(`admin/models/${encodeURIComponent(id)}/probe`, "POST", { capability });
          const result = response.result;
          if (admin !== instance) return;
          adminNotice(result && !result.ok ? result.message || "能力测试未通过。" : "能力测试已通过。");
        } finally {
          instance.probing.delete(id);
          form?.querySelectorAll("[data-probe-disabled]").forEach(control => {
            delete control.dataset.probeDisabled;
            control.disabled = false;
          });
        }
        await refreshAdmin(admin.editor?.id === id);
      });
    },
    "c-connection-delete": id => confirmAction("删除连接", "确定删除此服务连接？", "仍有模型使用时需要先处理关联模型。", "删除连接", async () => {
      await api(`admin/connections/${encodeURIComponent(id)}`, "DELETE");
      admin.editor = null;
      admin.discovered.delete(id);
      adminNotice("连接已删除。");
      await refreshAdmin(true);
    }),
    "c-model-delete": id => confirmAction("删除模型", "确定删除此模型配置？", "操作仅影响之后选择的模型。", "删除模型", async () => {
      await api(`admin/models/${encodeURIComponent(id)}`, "DELETE");
      admin.editor = null;
      adminNotice("模型已删除。");
      await refreshAdmin(true);
    }),
    "c-chat-new": newChat,
    "c-chat-to-ppt": value => {
      const reply = chat.messages[Number(value)]?.text;
      if (!reply) return;
      if (scopeInProgress("ppt")) throw new Error("PPT 工作台仍有任务在处理。");
      rememberWorkbench("ppt");
      state.ppt.brief = reply.slice(0, 6000);
      state.ppt.stage = state.ppt.maxStage = 0;
      resetDeck();
      save();
      go("ppt");
    },
    "c-chat-open": id => openChat(id),
    "c-chat-assets": openAssetPicker,
    "c-chat-close-picker": () => document.querySelector("#commercial-chat-asset-picker")?.close(),
    "c-chat-pick": (id, event) => {
      const item = event.target.closest("[data-action=c-chat-pick]");
      if (chat.attachmentIds.includes(id)) chat.attachmentIds = chat.attachmentIds.filter(value => value !== id);
      else if (!attachImage(id)) return;
      item.setAttribute("aria-pressed", String(chat.attachmentIds.includes(id)));
      drawChat({scroll: false});
    },
    "c-chat-upload": () => {
      if (!chat.agent || chat.request || chat.uploading) return;
      const input = document.querySelector("#commercial-chat-file");
      if (!input) return;
      input.value = "";
      input.click();
    },
    "c-chat-remove-asset": id => {
      if (chat.request) return;
      chat.attachmentIds = chat.attachmentIds.filter(value => value !== id);
      if (chat.attachmentIds.length <= attachmentLimit()) chat.notice = "";
      drawChat({scroll: false});
      document.querySelector("#commercial-chat-text")?.focus({preventScroll: true});
    },
    "c-chat-confirm-plan": id => changePlan(id, "confirm"),
    "c-chat-cancel-plan": id => changePlan(id, "cancel"),
    "c-chat-edit-result": async id => {
      if (!chat.plans.some(plan => (plan.jobIds || []).some(jobId => chat.jobs.get(jobId)?.assetId === id) || (plan.results || []).some(result => result.asset?.id === id))) return;
      const instance = chat;
      const {active, openRevision} = instance;
      let asset = knownImage(id);
      if (!asset) asset = (await loadChatAssets()).find(item => item.id === id);
      if (!chatIsCurrent(instance, active, openRevision)) return;
      if (!asset) throw new Error("这张图片已移出素材库。");
      setEditSource(uploadDescriptor(asset));
    },
    "c-chat-delete": id => {
      const assembling = chat.active === id && chat.plans.some(plan => gifPlan(plan) && plan.status === "submitted" &&
        !plan.results?.length && !plan.jobIds?.some(jobId => ["failed", "cancelled"].includes(chat.jobs.get(jobId)?.status)));
      const note = assembling ? "已提交的片段任务会继续执行。删除对话会停止自动拼接完整 GIF。" : "对话记录将从列表中移除。";
      return confirmAction("删除对话", "确定删除当前对话？", note, "删除对话", () => deleteChat(id));
    },
    "c-chat-stop": () => {
      if (!chat.request) return;
      chat.notice = "正在停止接收…";
      drawChat();
      chat.request.controller.abort();
    }
  };

  async function submit(form) {
    const submitters = form.querySelectorAll('button[type="submit"]');
    if ([...submitters].some(control => control.disabled)) return;
    submitters.forEach(control => { control.disabled = true; });
    try {
      const handler = { connection: saveConnection, model: saveModel, "batch-model": importModels, defaults: saveDefaults, chat: sendChat }[form.dataset.commercial];
      if (handler) await run(() => handler(form));
    } finally {
      submitters.forEach(control => {
        if (control.isConnected) control.disabled = form.dataset.commercial === "chat" && !canSendChat();
      });
    }
  }

  document.addEventListener("input", event => {
    const element = event.target;
    if (element.id === "commercial-chat-text") chat.draft = element.value;
    if (element.name === "batchSearch" && element.form?.dataset.commercial === "batch-model") drawBatchDirectory(element.form);
    if (element.form?.dataset.commercial !== "model") return;
    if (element.name === "modelSearch") drawDirectory(element.form);
    else if (element.name !== "directoryModel") element.form.dataset.dirty = "true";
  });

  document.addEventListener("change", event => {
    const element = event.target;
    if (element.hasAttribute("data-model-select-all")) {
      admin.modelSelection = new Set(element.checked ? admin.models.filter(item => item.kind === admin.modelKind).map(item => item.id) : []);
      drawAdmin();
      document.querySelector("[data-model-select-all]")?.focus();
      return;
    }
    if (element.hasAttribute("data-model-select")) {
      if (element.checked) admin.modelSelection.add(element.value);
      else admin.modelSelection.delete(element.value);
      drawAdmin();
      document.querySelector(`[data-model-select][value="${CSS.escape(element.value)}"]`)?.focus();
      return;
    }
    if (element.id === "commercial-chat-agent" && !chat.request) {
      chat.agent = element.checked;
      drawChat({scroll: false});
    }
    if (element.id === "commercial-chat-web-search" && !chat.request) {
      chat.webSearch = element.checked;
      drawChat({scroll: false});
    }
    if (element.id === "commercial-chat-image-model" && !chat.request) {
      chat.imageModelId = element.value;
      chat.notice = chat.attachmentIds.length > attachmentLimit() ? `当前模型最多可附加 ${attachmentLimit()} 张图片。` : "";
      drawChat({scroll: false});
    }
    if (element.id === "commercial-chat-skill" && !chat.request) chat.creativeSkill = element.value;
    if (element.id === "commercial-chat-file") run(() => uploadChatFiles([...element.files]));
    if (element.id === "commercial-chat-model") {
      chat.modelId = element.value;
      drawChat();
    }
    const form = element.form;
    if (form?.dataset.commercial === "batch-model") {
      if (element.name === "connectionId") {
        admin.editor.connectionId = element.value;
        admin.editor.selected.clear();
        form.elements.batchSearch.value = "";
        drawBatchDirectory(form);
      }
      if (element.name === "kind") {
        admin.editor.kind = element.value;
        admin.editor.selected.clear();
        drawAdmin();
      }
      if (element.hasAttribute("data-batch-select")) {
        const selected = admin.editor.selected;
        if (!element.checked) selected.delete(element.value);
        else if (selected.size < 100) selected.add(element.value);
        else {
          element.checked = false;
          adminNotice("每批最多导入 100 个模型。");
        }
        form.querySelector("[data-batch-count]").textContent = selected.size;
      }
    }
    if (form?.dataset.commercial === "defaults") form.dataset.dirty = "true";
    if (!["model", "batch-model"].includes(form?.dataset.commercial)) return;
    if (form.dataset.commercial === "batch-model" && element.name !== "capabilities") return;
    if (element.name === "connectionId") {
      form.elements.modelSearch.value = "";
      form.elements.contextWindowTokens.value = "";
      form.querySelector("[data-discovery]").textContent = "";
      drawDirectory(form);
      updatePublishControl(form);
    }
    if (element.name === "directoryModel" && element.value) {
      const previousId = form.elements.modelId.value;
      const entry = (admin.discovered.get(form.elements.connectionId.value) || []).find(item => item.id === element.value);
      form.elements.modelId.value = element.value;
      if (previousId !== element.value || !form.elements.contextWindowTokens.value) {
        form.elements.contextWindowTokens.value = entry?.contextWindowTokens || "";
      }
      suggestModelKind(form);
      if (!form.elements.name.value.trim() || form.elements.name.value === previousId || form.dataset.suggestedName === form.elements.name.value) {
        form.elements.name.value = (entry?.name || element.value).slice(0, 80);
        form.dataset.suggestedName = form.elements.name.value;
      }
      form.dataset.dirty = "true";
    }
    if (element.name === "modelId") {
      form.elements.contextWindowTokens.value = "";
      suggestModelKind(form);
    }
    if (element.name === "kind") {
      form.dataset.manualKind = "true";
      updateModelKind(form, element.value);
    }
    if (element.name === "enabled") updatePublishControl(form);
    if (element.name === "capabilities" && form.elements.kind.value === "image") {
      const reference = form.querySelector('[name="capabilities"][value="reference"]');
      const edit = form.querySelector('[name="capabilities"][value="mask"]');
      const multiple = form.querySelector('[name="capabilities"][value="multiReference"]');
      if (element === reference && !element.checked) edit.checked = multiple.checked = false;
      if ((element === edit || element === multiple) && element.checked) reference.checked = true;
    }
  });

  document.addEventListener("paste", event => {
    if (ui.route !== "chat" || !chat.agent || chat.request || !event.target.closest?.('[data-commercial="chat"]')) return;
    const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    run(() => uploadChatFiles(images, true));
  });

  document.addEventListener("dragover", event => {
    if (ui.route === "chat" && chat.agent && !chat.request && event.target.closest?.('[data-commercial="chat"]') && [...(event.dataTransfer?.types || [])].includes("Files")) event.preventDefault();
  });

  document.addEventListener("drop", event => {
    if (ui.route !== "chat" || !chat.agent || chat.request || !event.target.closest?.('[data-commercial="chat"]')) return;
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    run(() => uploadChatFiles(files));
  });

  return {
    adminPanel,
    adminNavigation,
    chatView,
    searchSources,
    revealText,
    seedChatDraft,
    readStream: parseStream,
    receiveImageJobs,
    refresh(route) {
      syncOwner();
      if (route === "admin") return run(refreshAdmin);
      if (route === "chat") return run(refreshChat);
    },
    handle(action, value, event) {
      if (actions[action]) return run(() => actions[action](value, event));
    },
    submit
  };
})();
