"use strict";

const workspaceProjects = (() => {
  const templateScopes = {image: "AI 生图", "image-edit": "图片编辑", poster: "海报", ppt: "PPT", chat: "AI 对话"};
  const stateForAccount = () => ({
    owner: null, session: null, projects: [], posterProjects: [], templates: [], managed: [],
    draft: null, templateEditor: null, filter: "active", switching: false, current: null, related: null,
    templateFilter: "all", templateFocus: "", recoveryNotices: new Set()
  });
  let data = stateForAccount();

  function syncOwner() {
    const owner = account?.id ?? null;
    if (owner !== data.owner || identity !== data.session) {
      data = stateForAccount();
      Object.assign(data, {owner, session: identity});
    }
    return data;
  }

  function options(values, selected) {
    return values.map(([key, label]) => `<option value="${esc(key)}"${key === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
  }

  function day(timestamp) {
    return new Date(timestamp * 1000).toLocaleString("zh-CN", {dateStyle: "medium", timeStyle: "short"});
  }

  function workspaceDraft(scope) {
    const document = state[scope];
    const {tracked, ...rest} = document;
    return {
      document: Array.isArray(tracked) && !tracked.length ? rest : document,
      uploads: Object.fromEntries(Object.entries(state.uploads).filter(([key]) => uploadBelongsTo(scope, key)))
    };
  }

  function uploadBelongsTo(scope, key) {
    if (scope === "ppt") return pptSlots.includes(key);
    if (scope === "poster") return ["logo", "qr", ...posterReferenceTargets].includes(key);
    return key === "image" || referenceSlots.includes(key) || generationReferenceSlots.includes(key) || key.startsWith("local:");
  }

  function installDraft(scope, draft, id = "") {
    for (const key of new Set([...Object.keys(state.uploads), ...Object.keys(ui.file)])) {
      if (!uploadBelongsTo(scope, key)) continue;
      delete state.uploads[key];
      delete ui.file[key];
    }
    state[scope] = {...initialState()[scope], ...draft?.document, ...(id ? {documentId: id} : {})};
    for (const [key, assetId] of Object.entries(draft?.uploads || {})) {
      if (!uploadBelongsTo(scope, key)) continue;
      state.uploads[key] = assetId;
      const file = ui.files.find(item => item.id === assetId);
      if (file) ui.file[key] = uploadDescriptor(file);
    }
    if (scope === "ppt") {
      normalizePptDraft(state.ppt);
      ui.pptExport = "";
    }
  }

  function restoreIndependentDrafts() {
    let restored = false;
    for (const scope of ["image", "poster"]) {
      const draft = state.standaloneDrafts[scope];
      if (!draft) continue;
      installDraft(scope, draft);
      delete state.standaloneDrafts[scope];
      restored = true;
    }
    return restored;
  }

  function projectPpt(project) {
    return project.workspaces?.ppt || (project.scope === "ppt" ? project.workspace : {});
  }

  function bindProject(project, current, draft = workspaceDraft("ppt")) {
    current.current = {project, snapshot: snapshot(draft)};
  }

  function comparable(workspace) {
    const {tracked, ...document} = workspace.document;
    return snapshot({document, uploads: workspace.uploads});
  }

  function recoverProject(current) {
    const id = state.activeProjectId;
    if (!id || current.current || !current.owner) return;
    if (current.recovering) return current.recovering;
    normalizePptDraft(state.ppt);
    const local = structuredClone(workspaceDraft("ppt"));
    current.recovering = api(`projects/${encodeURIComponent(id)}`).then(({project}) => {
      if (data !== current || identity !== current.session || state.activeProjectId !== id || current.current) return;
      const saved = projectPpt(project);
      const document = {...initialState().ppt, ...saved.document, documentId: id};
      normalizePptDraft(document);
      const conflicted = comparable({document, uploads: saved.uploads || {}}) !== comparable(local);
      bindProject(project, current, local);
      if (conflicted) {
        current.current.conflicted = true;
        notify("当前 PPT 草稿和项目版本不同。可新建 PPT 项目并带入当前草稿。");
      }
      current.current.blocked = conflicted || project.archived || project.deleted;
      if (!current.current.blocked && snapshot(local) !== snapshot(workspaceDraft("ppt"))) save();
      if (ui.route === "ppt") render();
    }).finally(() => { current.recovering = null; });
    return current.recovering;
  }

  function snapshot(value) {
    const order = item => {
      if (Array.isArray(item)) return item.map(order);
      if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])]));
      return item;
    };
    return JSON.stringify(order(value));
  }

  async function sync() {
    const current = syncOwner();
    const binding = current.current;
    if (!binding || binding.blocked || binding.project.id !== state.activeProjectId) return;
    const draft = workspaceDraft("ppt");
    const serialized = snapshot(draft);
    if (serialized === binding.snapshot) return;
    try {
      const {project} = await api(`projects/${encodeURIComponent(binding.project.id)}`, "PUT",
        {revision: binding.project.revision, workspaces: {ppt: draft}});
      if (data === current && current.current === binding) Object.assign(binding, {project, snapshot: serialized});
    } catch (error) {
      if (error.message.includes("其他页面更新") || error.message.includes("归档")) {
        binding.blocked = binding.conflicted = true;
        error.projectConflict = true;
      }
      throw error;
    }
  }

  function view() {
    syncOwner();
    if (!account) return page("PPT 项目", '<div class="card stack"><h2>登录后保存 PPT 项目</h2><a href="#account" class="btn btn-primary">登录 / 注册</a></div>', "projects");
    return page("PPT 项目", `<div id="named-projects">${projectList()}</div>`, "projects");
  }

  function projectList() {
    const projects = data.projects.filter(project => (project.scope === "ppt" || project.scopes?.includes("ppt")) &&
      (data.filter === "trash" ? project.deleted : !project.deleted && project.archived === (data.filter === "archived")));
    return `<div class="row-between filters"><div class="row" aria-label="项目状态">
      ${[["active","进行中"],["archived","已归档"],["trash","回收站"]].map(([key,label]) =>
        button(label, "p-filter", key, "secondary", `aria-pressed="${data.filter === key}"`)).join("")}
      </div>${button("新建 PPT 项目", "p-create", "", "primary")}</div>
      ${state.activeProjectId ? `<div class="notice row-between"><span>当前 PPT 项目 ${esc(data.current?.project.name || data.projects.find(item => item.id === state.activeProjectId)?.name || "")}</span>${button("退出项目", "p-exit", "", "ghost")}</div>` : ""}
      ${data.draft?.mode === "project" ? projectForm(data.draft) : ""}
      ${projects.length ? `<div class="grid-3">${projects.map(projectCard).join("")}</div>` : '<p class="empty">暂无项目。</p>'}
      ${data.related ? relatedView(data.related) : ""}
      <p class="row" style="margin-top:16px"><a class="btn btn-ghost" href="#scenes">浏览模板</a>
        <a class="btn btn-ghost" href="#ppt">打开 PPT 工作台</a></p>`;
  }

  function projectCard(project) {
    return `<article class="card stack">
      <h3>${esc(project.name)}</h3><p class="meta">更新于 ${day(project.updated)}</p>
      ${project.description ? `<p>${esc(project.description)}</p>` : ""}
      ${project.deleted ? `<div class="row">${button("恢复项目", "p-restore", project.id)}</div>` :
        `
          <div class="row">${project.archived ? button("恢复", "p-archive", project.id) :
            button("打开 PPT", "p-open", project.id, "primary") + button("编辑项目", "p-rename", project.id, "ghost") +
            button("项目素材", "p-assets", project.id, "ghost") + button("归档", "p-archive", project.id, "ghost")}
            ${button("删除", "p-delete", project.id, "ghost")}</div>`}
    </article>`;
  }

  function relatedView(related) {
    const files = ui.files.filter(file => related.ids.includes(file.id));
    const available = ui.files.filter(file => !related.ids.includes(file.id));
    return `<section class="section stack"><div class="row-between"><h2>${esc(related.name)} · 项目素材</h2>
      <div class="row">${button("添加已有素材", "p-pick-assets", "", "secondary", available.length ? "" : "disabled")}${button("收起", "p-close-assets", "", "ghost")}</div></div>
      ${related.picking ? `<form data-project="assets" class="commercial-form stack">
        <div class="commercial-batch-directory">${available.map(file => `<label class="commercial-check"><input type="checkbox" name="assetId" value="${esc(file.id)}"><span>${esc(file.name)}</span></label>`).join("")}</div>
        <div class="row"><button type="submit" class="btn btn-primary">添加所选素材</button>${button("取消", "p-pick-assets", "", "ghost")}</div>
      </form>` : ""}
      ${files.length ? `<div class="grid-3">${files.map(file => `<article class="card asset-card">
        ${file.mime.startsWith("image/") ? uploadArtwork(uploadDescriptor(file), "project-asset:" + file.id, true) : ""}
        <h3>${esc(file.name)}</h3>
        <div class="row"><a class="btn btn-secondary" href="/api/assets/${esc(file.id)}/download">下载</a>
        ${related.linked.includes(file.id) ? button("解除关联", "p-unlink-asset", file.id, "ghost") : ""}</div>
      </article>`).join("")}</div>` : '<p class="empty">项目使用的素材和生成结果会显示在这里。</p>'}</section>`;
  }

  async function updateRelated(method, assetIds) {
    const related = data.related;
    if (!related) return;
    if (!assetIds.length || assetIds.length > 100) throw new Error("请选择 1 至 100 个素材。");
    const result = await api(`projects/${encodeURIComponent(related.id)}/assets`, method, {assetIds});
    if (data.related !== related || ui.route !== "projects") return;
    Object.assign(related, {ids: result.assetIds, linked: result.linkedIds, picking: false});
    draw();
    notify(method === "POST" ? "素材已加入项目。" : "已解除素材关联。");
  }

  function projectForm(draft) {
    const project = draft.project;
    return `<form class="commercial-form stack" data-project="project">
      <h3>${project ? "编辑项目" : "新建 PPT 项目"}</h3>
      <div class="commercial-fields">
        <label class="field">项目名称<input class="input" name="name" value="${esc(project?.name || "")}" maxlength="80" placeholder="输入项目名称" required></label>
        <label class="field">项目说明<textarea class="textarea" name="description" maxlength="500">${esc(project?.description || "")}</textarea></label>
        ${project ? "" : '<label class="commercial-check"><input type="checkbox" name="copy">带入当前 PPT 草稿和资料</label>'}
      </div>
      <div class="row"><button class="btn btn-primary" type="submit">${project ? "保存项目" : "创建并打开"}</button>${button("取消", "p-close", "", "ghost")}</div>
    </form>`;
  }

  function templatesView() {
    syncOwner();
    return page("模板与案例", `<div id="published-templates">${templateGallery()}</div>`, "scenes");
  }

  const templatePresentation = {
    image: {art: "homePhoto", note: "可调整描述、输出尺寸和参考图。", fields: {prompt: "画面描述", ratio: "画面比例", resolution: "分辨率"}},
    "image-edit": {art: "background", note: "可用示例图练习，也可继续使用自己的原图。", fields: {tool: "编辑工具", prompt: "修改要求"}},
    poster: {art: "homePoster", note: "替换活动信息，按需添加产品图，再勾选发布尺寸。", fields: {title: "活动标题", subtitle: "副标题", date: "活动时间", preset: "出图方向", prompt: "主视觉描述"}},
    ppt: {art: "homePpt", note: "使用模板会打开一个新 PPT 项目。你可以补充实际资料，再和 AI 确认需求。", fields: {brief: "汇报需求", level: "详细程度", style: "视觉风格"}},
    chat: {note: "提示词会放到一段新对话中，编辑后可自行发送。", fields: {prompt: "首条消息"}}
  };

  function templateScope(template) {
    return template.scope === "image" && Object.hasOwn(editToolHelp, template.settings?.tool) ? "image-edit" : template.scope;
  }

  function templateFormat(template) {
    return templateScope(template) === "image" ? template.settings?.format || "still" : "";
  }

  function templateExamples() {
    const examples = [
      {id: "case-image", scope: "image", name: "商品摄影", description: "用自然侧光突出茶罐、包装和材质。", settings: {prompt: imageExamples[0][2], ratio: "1:1", resolution: "1K"}},
      {id: "case-edit", scope: "image-edit", name: "商品换背景", description: "保留商品与包装，把背景换成浅灰影棚。", settings: {tool: "background", prompt: "保留茶罐的外观、比例、位置和包装文字。把背景换成浅灰色影棚，加入柔和自然的接触阴影。"}},
      {id: "case-poster", scope: "poster", name: "春日茶会海报", description: "预填活动标题、副标题和主视觉描述。", settings: {title: "春日茶会", subtitle: "品茶、交流与手作", preset: "campaign", prompt: imageExamples[2][2]}},
      {id: "case-ppt", scope: "ppt", name: "部门周会汇报", description: "用成果、风险和下一步计划组织周会汇报。", settings: {brief: "面向部门负责人做项目阶段汇报。按目标、已交付成果、关键里程碑、当前风险和下月计划组织内容。待补数字用占位提示，不编造数据。", level: "标准", style: "商务深蓝"}},
      {id: "case-chat", scope: "chat", name: "新品创意讨论", description: "从受众、卖点和渠道出发，梳理创意方向。", settings: {prompt: "帮我策划一张新品宣传图。先问我产品、目标受众和发布渠道，再给出三个构图方案及各自适合的场景。"}},
      {id: "case-gif", scope: "image", name: "弹跳动图", description: "用固定镜头做一段首尾衔接的循环。", settings: {format: "gif", prompt: studioFormatExamples.gif[0]}},
      {id: "case-svg", scope: "image", name: "几何狐狸图标", description: "用简洁的闭合轮廓做一张矢量图标。", settings: {format: "svg", prompt: studioFormatExamples.svg[0]}}
    ];
    return [...data.templates, ...examples.filter(example => !data.templates.some(template =>
      templateScope(template) === example.scope && templateFormat(template) === templateFormat(example)))];
  }

  function templateArt(template, focusable = false) {
    const scope = templateScope(template);
    const format = templateFormat(template);
    const preview = scope === "image-edit" ? (tools.find(tool => tool.id === template.settings?.tool)?.art || "background") : templatePresentation[scope].art;
    if (preview && (!format || format === "still")) return art(preview, undefined, focusable);
    if (focusable) return "";
    return `<div class="template-text-preview"><p>${esc(template.settings?.prompt || template.description || template.name)}</p></div>`;
  }

  function templateFieldValue(key, value) {
    if (key === "tool") return tools.find(tool => tool.id === value)?.name || value;
    if (key === "preset") return posterPresets[value]?.name || value;
    return value;
  }

  function templateDetails(template) {
    const scope = templateScope(template);
    const info = templatePresentation[scope];
    const format = templateFormat(template);
    const fields = Object.entries(info.fields).filter(([key]) => template.settings?.[key] &&
      (!format || format === "still" || key === "prompt"));
    const preview = templateArt(template, true);
    return `<section class="template-detail${preview ? "" : " template-detail-text"}" id="template-detail" tabindex="-1" aria-label="模板详情">
      ${preview ? `<div class="template-detail-preview">${preview}<p class="meta">效果示意</p></div>` : ""}
      <div class="template-detail-body"><div class="row-between"><h2>${esc(template.name)}</h2>${button("关闭详情", "p-template-preview", "", "ghost")}</div>
        ${template.description ? `<p>${esc(template.description)}</p>` : ""}
        <h3>带入工作台的内容</h3>
        ${fields.length ? `<dl>${fields.map(([key, label]) => `<div><dt>${label}</dt><dd>${esc(templateFieldValue(key, template.settings[key]))}</dd></div>`).join("")}</dl>` : '<p class="meta">打开工作台后可填写内容。</p>'}
        <p class="meta">${info.note}</p>
        ${button("使用模板", "p-template-use", template.id, "primary")}
      </div></section>`;
  }

  function templateGallery() {
    const filters = [["all", "全部模板"], ...Object.entries(templateScopes)];
    const listed = templateExamples().filter(template => templatePresentation[templateScope(template)] &&
      (data.templateFilter === "all" || templateScope(template) === data.templateFilter));
    const focused = listed.find(template => template.id === data.templateFocus);
    return `<p class="template-lead">选一个模板，把示例内容带入对应工作台，改好后再开始创作。</p>
      <div class="template-filter row-between"><div class="row" role="group" aria-label="模板类型">${filters.map(([key, name]) =>
        button(name, "p-template-filter", key, key === data.templateFilter ? "secondary" : "ghost", `aria-pressed="${key === data.templateFilter}"`)).join("")}</div>
        <span class="meta">${listed.length} 个模板</span></div>
      <div class="template-grid">${listed.map(template => {
        const format = templateFormat(template);
        const label = format && format !== "still" ? studioFormats[format] : templateScopes[templateScope(template)];
        return `<article class="template-tile"><div class="template-cover">${templateArt(template)}<span>${label}</span></div>
          <div class="template-tile-body"><h2>${esc(template.name)}</h2>${template.description ? `<p class="meta">${esc(template.description)}</p>` : ""}
          <div class="row template-tile-actions">${button("使用模板", "p-template-use", template.id, "primary", `aria-label="使用模板：${esc(template.name)}"`)}
          ${button("查看详情", "p-template-preview", template.id, "ghost", `aria-label="查看模板：${esc(template.name)}"`)}</div></div></article>`;
      }).join("")}</div>
      ${focused ? templateDetails(focused) : ""}`;
  }

  function adminPanel() {
    syncOwner();
    return `<section class="card commercial-admin" aria-labelledby="project-template-title">
      <header class="row-between"><div><h2 id="project-template-title">模板管理</h2><p class="meta">发布后，用户可从「模板与案例」将内容带入对应工作台。</p></div>
      ${button("新增模板", "p-template-edit", "", "primary")}</header>
      <div id="admin-project-templates">${templateAdminBody()}</div>
    </section>`;
  }

  function templateAdminBody() {
    return `${data.templateEditor ? templateForm(data.templateEditor) : ""}
      ${data.managed.length ? `<div class="table-wrap"><table class="ds-table commercial-table">
        <thead><tr><th>模板</th><th>版本</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${data.managed.map(template => `<tr>
          <td><b>${esc(template.name)}</b><small>${templateScopes[templateScope(template)]}</small></td>
          <td>v${template.revision}${template.publishedRevision && template.revision !== template.publishedRevision ? ` · 已发布 v${template.publishedRevision}` : ""}</td>
          <td>${template.archived ? "已下架" : template.publishedRevision === template.revision ? "已发布" : "草稿"}</td>
          <td>${button("编辑模板", "p-template-edit", template.id)}</td>
        </tr>`).join("")}</tbody></table></div>` : '<p class="empty">暂无模板。创建后可先保存草稿。</p>'}`;
  }

  function templateFields(scope, settings = {}) {
    const input = (name, label, limit) => `<label class="field">${label}<input class="input" name="${name}" maxlength="${limit}" value="${esc(settings[name] || "")}"></label>`;
    const text = (name, label, limit) => `<label class="field">${label}<textarea class="textarea" name="${name}" maxlength="${limit}">${esc(settings[name] || "")}</textarea></label>`;
    const select = (name, label, values, fallback) => `<label class="field">${label}<select class="input" name="${name}">${options(values, settings[name] || fallback)}</select></label>`;
    const labels = values => values.map(value => [value, value]);
    if (scope === "image-edit") {
      const editor = tools.filter(tool => Object.hasOwn(editToolHelp, tool.id)).map(tool => [tool.id, tool.name]);
      return select("tool", "编辑工具", editor, "background") +
        `<div data-template-editor-prompt${editToolHelp[settings.tool || "background"]?.label ? "" : " hidden"}>${text("prompt", "修改要求", 3000)}</div>`;
    }
    if (scope === "poster") return input("title", "海报标题", 30) + input("subtitle", "海报副标题", 40) + input("date", "活动时间", 32) +
      select("preset", "出图方向", Object.entries(posterPresets).map(([key, value]) => [key, value.name]), "auto") + text("prompt", "主视觉描述", 2000);
    if (scope === "ppt") return text("brief", "汇报需求", 6000) + select("level", "详细程度", labels(["简报", "标准", "详细"]), "简报") +
      select("style", "视觉风格", labels(["商务深蓝", "科技", "极简"]), "商务深蓝");
    if (scope === "chat") return text("prompt", "首条消息", 12000);
    return select("format", "生成格式", Object.entries(studioFormats), "still") + text("prompt", "生成提示词", 3000) +
      `<div class="row" data-template-still${settings.format && settings.format !== "still" ? " hidden" : ""}>${select("ratio", "画面比例", labels(imageRatios), "1:1")}${select("resolution", "分辨率", labels(Object.keys(resolutions)), "1K")}</div>`;
  }

  function templateForm(template) {
    const scope = templateScope(template) || "image";
    return `<form class="commercial-form stack" data-project="template">
      <h3>${template.id ? "编辑模板 · v" + template.revision : "新建模板"}</h3>
      <div class="commercial-fields">
        <label class="field">模板名称<input class="input" name="name" value="${esc(template.name || "")}" maxlength="80" required></label>
        <label class="field">模板类型<select class="input" name="scope"${template.id ? " disabled" : ""}>${options(Object.entries(templateScopes), scope)}</select></label>
      </div>
      <label class="field">模板说明<textarea class="textarea" name="description" maxlength="320">${esc(template.description || "")}</textarea></label>
      <div class="commercial-fields" data-template-fields>${templateFields(scope, template.settings)}</div>
      <label class="field">保存方式<select class="input" name="status">
        <option value="draft">保存草稿</option><option value="publish">发布版本</option>${template.id ? '<option value="archive">下架模板</option>' : ""}
      </select></label>
      <div class="row"><button class="btn btn-primary" type="submit">保存模板</button>${button("关闭编辑", "p-template-close", "", "ghost")}</div>
    </form>`;
  }

  function paint(id, makeContent) {
    const node = document.querySelector(id);
    if (node) node.innerHTML = makeContent();
  }

  function draw() {
    if (ui.route === "projects") paint("#named-projects", projectList);
    if (ui.route === "poster") {
      paint("#poster-project-controls", posterHistory);
      const chats = content.querySelector(".poster-conversation-controls");
      if (chats) chats.inert = syncOwner().posterSwitching;
    }
    if (ui.route === "scenes") {
      mediaItems.clear();
      paint("#published-templates", templateGallery);
      workspaceMedia.setItems(mediaItems);
    }
    if (ui.route === "admin") paint("#admin-project-templates", templateAdminBody);
  }

  async function refresh(route, redraw = false) {
    const current = syncOwner();
    if (route === "ppt") return recoverProject(current);
    if (route === "projects" && state.activeProjectId) await recoverProject(current);
    const endpoints = { projects: "projects", poster: "poster/projects", scenes: "templates", admin: "admin/templates" };
    if (!endpoints[route] || (["projects", "poster"].includes(route) && !current.owner) || (route === "admin" && account?.role !== "admin")) return;
    const posterDraft = state.poster;
    const result = await api(endpoints[route]);
    if (data !== current || (route === "poster" && (current.posterSwitching || state.poster !== posterDraft))) return;
    if (route === "projects") current.projects = result.projects || [];
    if (route === "poster") current.posterProjects = result.projects || [];
    if (route === "scenes") current.templates = result.templates || [];
    if (route === "admin") current.managed = result.templates || [];
    const form = document.querySelector("form[data-project]");
    if (ui.route === route && (redraw || !form)) draw();
  }

  function posterHistory() {
    const current = syncOwner();
    const id = state.poster.projectId || "";
    const name = current.posterProjects.find(project => project.id === id)?.name || "当前创作";
    const older = current.posterProjects.filter(project => project.id !== id);
    return `<strong>${esc(name)}</strong>
      ${older.length ? `<select class="input" aria-label="历史海报项目" data-field="poster-history" ${current.posterSwitching ? "disabled" : ""}>
        <option value="">历史项目（${older.length}）</option>${options(older.map(project => [project.id, project.name]), "")}</select>` : ""}
      ${button("新建项目", "new-poster-project", "", "secondary", current.posterSwitching ? "disabled" : "")}`;
  }

  async function switchPoster(target = "") {
    const current = syncOwner();
    if (current.posterSwitching || (target && target === state.poster.projectId)) return;
    if (pending.has("poster") || pending.has("poster-advisor") || ui.uploading || modal.open) {
      notify("当前操作尚未完成，请稍后切换创作。");
      return;
    }
    current.posterSwitching = true;
    draw();
    const studio = content.querySelector(".poster-studio");
    if (studio) studio.inert = true;
    try {
      if (!current.owner) {
        installDraft("poster");
      } else {
        await flushSave(true);
        await queueWrite(async () => {
          if (data !== current || identity !== current.session) return;
          const result = await api("poster/projects", "POST", {revision, open: target});
          if (data !== current || identity !== current.session) return;
          revision = result.revision;
          current.posterProjects = result.projects || [];
          installDraft("poster", result.draft);
        });
      }
      if (data !== current || identity !== current.session) return;
      if (ui.route === "poster") {
        content.querySelectorAll("[data-poster-scroll]").forEach(node => node.scrollTo(0, 0));
        render();
      }
      if (target) await refreshJobs();
      if (ui.route === "poster" && data === current) notify(target ? "已打开历史项目。" : "已开始新的海报创作。");
    } finally {
      current.posterSwitching = false;
      if (ui.route === "poster" && data === current) {
        const visibleStudio = content.querySelector(".poster-studio");
        if (visibleStudio) visibleStudio.inert = false;
        draw();
      }
    }
  }

  function canSwitchPpt() {
    if (pending.has("ppt") || (ui.uploading && ui.uploadTarget === "ppt")) {
      notify("请等待当前 PPT 操作完成后再切换项目。");
      return false;
    }
    return true;
  }

  async function preparePptSwitch(current, carryDraft = false) {
    if (!canSwitchPpt()) return false;
    if (state.activeProjectId && !current.current) await recoverProject(current);
    try {
      await flushSave(true);
    } catch (error) {
      if (!(carryDraft && error.projectConflict)) throw error;
    }
    if (data !== current || identity !== current.session || !canSwitchPpt()) return false;
    if (current.current?.conflicted && !carryDraft) {
      throw new Error("当前 PPT 草稿有尚未合并的修改，请先新建 PPT 项目并勾选带入当前草稿。");
    }
    return true;
  }

  async function applyProject(project, current, route = "ppt") {
    if (data !== current || identity !== current.session || account?.id !== current.owner) return;
    if (project.archived || project.deleted) throw new Error("请先恢复项目。");
    if (!state.activeProjectId) {
      state.standaloneDrafts.ppt ??= workspaceDraft("ppt");
    }
    state.activeProjectId = project.id;
    installDraft("ppt", projectPpt(project), project.id);
    bindProject(project, current);
    current.related = null;
    save();
    go(route);
    const document = state.ppt;
    if (pptSlots.some(slot => state.uploads[slot] && !ui.file[slot])) {
      await refreshFiles();
      if (data === current && state.ppt === document && ui.route === "ppt") render();
    }
  }

  function leaveProject(current) {
    if (!state.activeProjectId) return;
    installDraft("ppt", state.standaloneDrafts.ppt);
    state.activeProjectId = "";
    delete state.standaloneDrafts.ppt;
    current.current = null;
    current.related = null;
    save();
  }

  async function openProject(id) {
    const current = syncOwner();
    if (current.switching || !canSwitchPpt()) return;
    if (current.current?.project.id === id && !current.current.blocked) return go("ppt");
    current.switching = true;
    try {
      if (!await preparePptSwitch(current)) return;
      const {project} = await api(`projects/${encodeURIComponent(id)}`);
      if (canSwitchPpt()) await applyProject(project, current);
    } finally {
      current.switching = false;
    }
  }

  async function alterProject(project, fields) {
    const current = syncOwner();
    await flushSave(true);
    if (data !== current || account?.id !== current.owner) return;
    const changingActive = (fields.archived || fields.deleted) && state.activeProjectId === project.id;
    if (changingActive && !await preparePptSwitch(current)) throw new Error("当前 PPT 操作尚未完成。");
    const binding = current.current?.project.id === project.id ? current.current : null;
    const revision = binding?.project.revision ?? project.revision;
    const {project: updated} = await api(`projects/${encodeURIComponent(project.id)}`, "PUT", {revision, ...fields});
    if (data !== current) return;
    if ((updated.archived || updated.deleted) && state.activeProjectId === project.id) leaveProject(current);
    else if (binding) binding.project = updated;
    if (current.related?.id === project.id) current.related = null;
    data.draft = null;
    await refresh("projects", true);
  }

  async function saveProject(form) {
    const current = syncOwner();
    const values = Object.fromEntries(new FormData(form));
    const draft = current.draft;
    if (!draft) return;
    if (draft.project) {
      await alterProject(draft.project, {name: values.name, description: values.description});
      notify("项目已保存。");
      return;
    }
    if (current.switching || !canSwitchPpt()) return;
    current.switching = true;
    try {
      if (!await preparePptSwitch(current, Boolean(values.copy))) return;
      const body = {name: values.name, description: values.description, workspace: values.copy ? workspaceDraft("ppt") : {}};
      const {project} = await api("projects", "POST", body);
      if (data !== current || account?.id !== current.owner) return;
      current.projects.unshift(project);
      current.filter = "active";
      current.draft = null;
      if (canSwitchPpt()) await applyProject(project, current);
      notify("PPT 项目已创建。");
    } finally {
      current.switching = false;
    }
  }

  async function saveTemplate(form) {
    const current = syncOwner();
    const template = current.templateEditor;
    const values = Object.fromEntries(new FormData(form));
    const scope = template.scope || values.scope;
    const type = templateScope(template) || scope;
    const fields = {
      image: values.format === "still" ? ["prompt", "format", "ratio", "resolution"] : ["prompt", "format"],
      "image-edit": editToolHelp[values.tool]?.label ? ["tool", "prompt"] : ["tool"],
      poster: ["title", "subtitle", "date", "preset", "prompt"],
      ppt: ["brief", "level", "style"], chat: ["prompt"]
    }[type];
    const settings = Object.fromEntries(fields.map(field => [field, values[field] || ""]));
    const body = {scope, name: values.name, description: values.description, status: values.status, settings, revision: template.revision};
    const path = template.id ? `admin/templates/${encodeURIComponent(template.id)}` : "admin/templates";
    await api(path, template.id ? "PUT" : "POST", body);
    if (data !== current) return;
    current.templateEditor = null;
    await refresh("admin", true);
    notify(values.status === "publish" ? "模板已发布。" : values.status === "archive" ? "模板已下架。" : "模板草稿已保存。");
  }

  function templateFieldsToApply(settings, keys) {
    return Object.fromEntries(keys.filter(key => typeof settings[key] === "string").map(key => [key, settings[key]]));
  }

  function confirmTemplateChanges(template, fields, draft, defaults, apply) {
    const owner = identity;
    const run = () => {
      if (identity === owner && ui.route === "scenes") return apply();
    };
    const changed = Object.entries(fields).some(([key, value]) => draft[key] && draft[key] !== defaults[key] && draft[key] !== value);
    if (changed) return openModal("应用模板内容", template.name, "将替换此工作台中对应的草稿内容。", "使用模板", run);
    return run();
  }

  async function usePptTemplate(template) {
    if (!account) return openAuth("login", "", () => usePptTemplate(template).catch(error => notify(error.message)));
    const current = syncOwner();
    if (current.switching || !canSwitchPpt() || ui.route !== "scenes") return;
    current.switching = true;
    try {
      if (!await preparePptSwitch(current) || ui.route !== "scenes") return;
      const body = {name: template.name, description: template.description || ""};
      if (template.id === "case-ppt") body.workspace = {document: template.settings};
      else Object.assign(body, {templateId: template.id, templateRevision: template.revision});
      const {project} = await api("projects", "POST", body);
      if (data !== current || account?.id !== current.owner) return;
      current.projects.unshift(project);
      current.filter = "active";
      if (ui.route === "scenes" && canSwitchPpt()) await applyProject(project, current);
      notify("已从模板创建 PPT 项目。");
    } finally {
      current.switching = false;
    }
  }

  function useImageEditTemplate(template, settings) {
    const tool = settings.tool || "background";
    const image = state.image;
    const starter = tool === "background" ? backgroundEditStarter : "";
    const fields = editToolHelp[tool]?.label ? templateFieldsToApply(settings, ["prompt"]) : {};
    const previous = image.tool === tool ? image : image.editToolDrafts?.[tool] || {};
    return confirmTemplateChanges(template, fields, previous, {prompt: starter}, async () => {
      if (ui.uploading || pending.has("image")) return notify("请等待当前图片操作完成后再使用模板。");
      const owner = identity;
      let sample;
      const original = !ui.file.image && image.source && imageDescriptor(image.source);
      if (!ui.file.image) {
        const descriptor = original || sampleDescriptor("homePhoto");
        ui.uploading = true;
        try {
          sample = descriptor.file;
          if (!sample) {
            const blob = await workspaceMedia.getBlob(descriptor);
            if (owner !== identity || ui.route !== "scenes" || image !== state.image) return;
            sample = await storeFile(new File([blob], descriptor.filename, {type: blob.type}), owner, true);
          }
          if (!sample || owner !== identity || ui.route !== "scenes" || image !== state.image) return;
        } finally {
          if (owner === identity) ui.uploading = false;
        }
      }
      imageGeneration();
      switchEditTool(image, tool);
      if (sample && !ui.file.image) {
        assignFile("image", sample);
        if (original) delete image.source;
        else resetEditSource();
      }
      Object.assign(image, fields);
      openTool(tool);
    });
  }

  function useTemplate(id) {
    const template = templateExamples().find(item => item.id === id);
    if (!template || ui.route !== "scenes") return;
    const settings = template.settings || {};
    const scope = templateScope(template);
    if (scope === "ppt") return usePptTemplate(template);
    if (scope === "chat") return workspaceCommercial.seedChatDraft(settings.prompt || "", {fromTemplate: true});
    if (scope === "image-edit") return useImageEditTemplate(template, settings);
    if (scope === "poster") {
      const fields = templateFieldsToApply(settings, ["title", "subtitle", "date", "prompt", "preset"]);
      return confirmTemplateChanges(template, fields, state.poster, {...initialState().poster, preset: "auto"}, () => {
        if (scopeInProgress("poster") || pending.has("poster-advisor")) return notify("请等待当前海报操作完成后再使用模板。");
        Object.assign(state.poster, fields, {mode: "manual", promptOnly: false, previewTab: "reference"});
        save();
        go("poster");
      });
    }
    const format = templateFormat(template);
    const draft = format === "still" ? imageGeneration() : nativeStudioDraft(format);
    const fields = templateFieldsToApply(settings, format === "still" ? ["prompt", "ratio", "resolution"] : ["prompt"]);
    return confirmTemplateChanges(template, fields, draft, {ratio: "1:1", resolution: "1K"}, () => {
      Object.assign(draft, fields);
      ui.studioFormat = format;
      state.image.lastWorkspace = "generate";
      save();
      go("image");
    });
  }

  const actions = {
    "p-filter": value => { data.filter = value; data.draft = null; data.related = null; draw(); },
    "p-create": () => { data.draft = {mode: "project"}; draw(); },
    "p-close": () => { data.draft = null; draw(); },
    "p-open": id => openProject(id),
    "p-exit": async () => {
      const current = syncOwner();
      if (current.switching || !canSwitchPpt()) return;
      current.switching = true;
      try {
        if (!await preparePptSwitch(current)) return;
        leaveProject(current);
        if (ui.route === "ppt") render();
        else draw();
      } finally {
        current.switching = false;
      }
    },
    "p-assets": async id => {
      const current = syncOwner();
      const project = current.projects.find(item => item.id === id);
      if (!project) return;
      await flushSave(true);
      const [{assetIds, linkedIds}] = await Promise.all([api(`projects/${encodeURIComponent(id)}/assets`), refreshFiles()]);
      if (data !== current || ui.route !== "projects") return;
      current.related = {id, name: project.name, ids: assetIds, linked: linkedIds};
      draw();
    },
    "p-close-assets": () => { data.related = null; draw(); },
    "p-pick-assets": () => {
      if (!data.related) return;
      data.related.picking = !data.related.picking;
      draw();
    },
    "p-unlink-asset": id => updateRelated("DELETE", [id]),
    "p-rename": id => { data.draft = {mode: "project", project: data.projects.find(project => project.id === id)}; draw(); },
    "p-archive": async id => {
      const project = data.projects.find(item => item.id === id);
      if (!project) return;
      await alterProject(project, {archived: !project.archived});
      notify(project.archived ? "项目已恢复。" : "项目已归档。");
    },
    "p-delete": id => {
      const project = data.projects.find(item => item.id === id);
      if (!project) return;
      openModal("删除项目", project.name, "项目将移入回收站，可随时恢复。", "移入回收站", async () => {
        await alterProject(project, {deleted: true});
        notify("项目已移入回收站。");
      });
    },
    "p-restore": async id => {
      const project = data.projects.find(item => item.id === id);
      if (!project) return;
      await alterProject(project, {deleted: false});
      notify("项目已恢复。");
    },
    "p-template-filter": value => {
      if (value !== "all" && !Object.hasOwn(templateScopes, value)) return;
      Object.assign(data, {templateFilter: value, templateFocus: ""});
      draw();
      document.querySelector('[data-action="p-template-filter"][aria-pressed="true"]')?.focus({preventScroll: true});
    },
    "p-template-preview": id => {
      const previous = data.templateFocus;
      data.templateFocus = id;
      draw();
      if (id) document.querySelector("#template-detail")?.focus();
      else if (previous) document.querySelector(`[data-action="p-template-preview"][data-value="${CSS.escape(previous)}"]`)?.focus();
    },
    "p-template-use": useTemplate,
    "p-template-edit": id => { data.templateEditor = data.managed.find(template => template.id === id) || {}; draw(); },
    "p-template-close": () => { data.templateEditor = null; draw(); }
  };

  document.addEventListener("change", event => {
    const field = event.target;
    const form = field.form;
    if (form?.dataset.project !== "template") return;
    if (field.name === "scope") form.querySelector("[data-template-fields]").innerHTML = templateFields(field.value);
    if (field.name === "tool") form.querySelector("[data-template-editor-prompt]").hidden = !editToolHelp[field.value]?.label;
    if (field.name === "format") form.querySelector("[data-template-still]").hidden = field.value !== "still";
  });

  return {
    view, templatesView, adminPanel, refresh, sync, restoreIndependentDrafts, posterHistory, switchPoster,
    posterSwitching: () => syncOwner().posterSwitching,
    label() {
      const current = syncOwner();
      return current.current?.project.id === state.activeProjectId ? current.current.project.name :
        current.projects.find(project => project.id === state.activeProjectId)?.name || "";
    },
    async handle(action, value) {
      syncOwner();
      try { await actions[action]?.(value); }
      catch (error) { notify(error.message); }
    },
    async submit(form) {
      const control = form.querySelector('button[type="submit"]');
      if (!control || control.disabled) return;
      control.disabled = true;
      try {
        if (form.dataset.project === "template") await saveTemplate(form);
        else if (form.dataset.project === "assets") await updateRelated("POST", new FormData(form).getAll("assetId"));
        else await saveProject(form);
      } catch (error) {
        notify(error.message);
      } finally {
        control.disabled = false;
      }
    }
  };
})();
