"use strict";

const workspacePptTemplates = (() => {
  const palettes = {
    navy: ["#f1f5fb", "#15324b", "#2463a1"],
    olive: ["#f1f5e9", "#273827", "#527947"],
    dark: ["#172238", "#f1f7ff", "#8cc8ff"],
    plum: ["#f6edf4", "#3a2946", "#8a568a"],
    mint: ["#eaf5f3", "#1c353a", "#1c746f"],
    red: ["#fbefec", "#471f27", "#ad3d45"],
    sun: ["#fff5de", "#473621", "#916126"],
    slate: ["#eef2f2", "#283938", "#456e79"],
    cobalt: ["#eaefff", "#122760", "#4655d0"],
    night: ["#201d2e", "#f9efff", "#bdb2ff"],
    kraft: ["#f7eee0", "#402c24", "#946045"],
  };
  const groups = {
    "商业 PPT": [
      ["商务深蓝", "经营管理汇报", "navy", "columns", ["经营成果", "风险与判断", "下一步决策"], "白底深蓝标题，三栏卡片采用清晰网格。数据表按指标对齐，结论置于图表上方。", "经营概览 → 关键变化 → 风险与机会 → 需要拍板的事项"],
      ["极简", "管理层简报", "olive", "compare", ["核心结论", "关键证据", "待决事项"], "浅底深墨字，结论居左、证据居右，仅用一种强调色。按演示阅读距离放大关键内容。", "一句结论 → 三条证据 → 需决策事项，详细说明进附录"],
      ["经营仪表盘", "季度经营分析", "dark", "metrics", ["营收", "利润", "增长"], "深蓝底搭配高亮数字。关键指标同单位对照，下方保留趋势图、口径和统计期。", "经营指标 → 同比与环比 → 偏差归因 → 改进动作"],
      ["咨询方案书", "业务改善建议", "slate", "matrix", ["现状", "机会", "影响", "成本"], "灰蓝网格、重点结论条和对照矩阵，采用平直线条与紧凑的证据表。", "现状诊断 → 方案假设 → 影响与成本 → 推荐方案与验证"],
    ],
    "年终述职 PPT": [
      ["年度成绩单", "年度成果回顾", "red", "metrics", ["目标完成", "交付成果", "个人贡献"], "暖白底和稳重红色。首屏突出关键成果数，随后用目标、结果和贡献三层信息交叉验证。", "职责范围 → 年度目标 → 关键成果与本人贡献 → 下一年目标"],
      ["成长路线", "我的成长路线", "olive", "timeline", ["起点", "挑战", "成长", "下一年"], "低饱和绿，以季度为横轴组织成长轨迹。重要事件配小标题与证据摘要。", "能力基线 → 挑战 → 行动 → 能力变化 → 新一年的成长目标"],
      ["晋升答辩", "岗位胜任力答辩", "dark", "compare", ["岗位要求", "行动证据", "业务影响"], "深色标题页与浅色内容页配合。能力要求和实证并列，突出可核验的个人角色和结果。", "职责和目标岗位 → 对照能力要求 → 核心案例 → 下一岗位计划"],
      ["团队贡献", "团队协作与贡献", "mint", "diagram", ["团队目标", "跨组协作", "复用成果"], "青绿色关系图区分本人、团队和伙伴。协作角色连线明确，复用成果用对照卡呈现。", "团队目标 → 各方分工 → 本人关键动作 → 协作结果 → 机制沉淀"],
    ],
    "技术分享 PPT": [
      ["科技", "系统架构概览", "dark", "blueprint", ["接入层", "服务层", "数据层"], "深色底与青蓝分层。连接线方向明确，保留接口、术语、依赖和异常分支。", "问题背景 → 架构与分层 → 关键机制 → 权衡与边界 → 可复现演示"],
      ["工程实践复盘", "从故障到恢复", "mint", "timeline", ["发现", "定位", "恢复", "复盘"], "白青配色，横向时间线分开事件、判断和动作，实测对照图标记数据来源。", "故障现象 → 影响 → 定位证据 → 修复和验证 → 长期改进"],
      ["接口设计评审", "接口与异常路径", "slate", "diagram", ["调用方", "服务端", "错误处理"], "浅灰底、泳道与消息箭头。协议字段用等宽字，明确标出同步、异步和失败分支。", "场景 → 参与系统 → 请求与响应 → 异常处理 → 兼容和验证"],
      ["算法与实验", "算法方案对比", "night", "compare", ["基线", "新方法", "实验结果"], "深紫章节页，正文对照基线和新方法。主图展示关键指标，说明样本量与实验限制。", "任务定义 → 方法与假设 → 实验方案 → 结果与局限 → 复现入口"],
    ],
    "学生教案 PPT": [
      ["互动课堂", "今天的课堂任务", "sun", "lesson", ["想一想", "一起做", "讲一讲"], "浅暖黄和清楚的大字。问题卡、互动任务和课堂小结分开，每屏只给一个明确指令。", "导入提问 → 示范 → 分组活动 → 分享 → 课堂小结"],
      ["理科实验课", "观察与实验记录", "mint", "steps", ["准备", "观察", "记录", "结论"], "浅青白底，插图与简短动作提示同列。实验步骤顺序清楚，保留测量单位和安全提示。", "实验问题 → 材料与步骤 → 观察记录 → 数据讨论 → 结论"],
      ["人文阅读课", "文本阅读与讨论", "kraft", "editorial", ["文本摘录", "理解", "讨论"], "纸本暖色、引文与讨论区分栏。只放经过确认的摘录和出处，题目使用较大字号。", "导读 → 文本片段 → 线索分析 → 讨论题 → 延伸阅读"],
      ["课后练习", "巩固与自我检查", "cobalt", "lesson", ["基础题", "进阶题", "自查"], "明亮蓝紫与白底。题干留足空间，按难度拆页，答案与练习题分开。", "知识回顾 → 基础练习 → 进阶应用 → 自查答案 → 易错点"],
    ],
    "项目汇报 PPT": [
      ["实施路线图", "项目实施计划", "navy", "timeline", ["调研", "蓝图", "上线", "验收"], "蓝白路线图分阶段排列，标出里程碑、负责角色、交付物和日期口径。", "项目目标与范围 → 阶段进展 → 里程碑 → 风险和依赖 → 下阶段计划"],
      ["交付状态周报", "本周交付状态", "slate", "table", ["工作项", "状态", "责任人"], "浅灰表格结构，状态与说明分列，使用文字与颜色共同表示状态。", "本周摘要 → 计划对照实际 → 风险阻塞 → 下周重点"],
      ["系统切换方案", "上线切换步骤", "mint", "steps", ["准备", "切换", "校验", "回退"], "深浅青配色，以流程卡、校验点、回退路径和负责人组织技术页。", "切换范围 → 前置条件 → 操作顺序 → 校验与放行 → 回退方案"],
      ["项目验收报告", "交付与验收结论", "olive", "matrix", ["验收项", "标准", "实测", "结论"], "浅灰绿矩阵，按交付物对应验收标准、实际结果和证据。结论与遗留项分开。", "范围与标准 → 验收证据 → 遗留事项 → 交付结论和确认"],
    ],
    "产品发布 PPT": [
      ["发布会主视觉", "新品发布", "night", "hero", ["产品名称", "关键亮点", "发布节点"], "深紫色舞台和大字号。主视觉留大面积空间，以三条最重要的产品信息配合。", "开场价值 → 产品亮相 → 三个亮点 → 应用演示 → 上市信息"],
      ["功能更新发布", "产品能力更新", "cobalt", "columns", ["新功能", "改进项", "体验入口"], "蓝紫白底。每项功能有一致的截图区与结果说明，沿用产品实际界面和术语。", "本次更新概览 → 核心功能 → 使用方式 → 已知限制 → 获取渠道"],
      ["新品场景故事", "从痛点到体验", "kraft", "editorial", ["用户困境", "产品介入", "结果"], "温暖杂志排版，场景照片与说明并列。尊重原有物料、商标和尺寸。", "典型用户 → 场景困境 → 产品介入 → 使用体验 → 购买或试用"],
      ["版本路线展望", "产品阶段规划", "dark", "timeline", ["现阶段", "下版本", "长远方向"], "深蓝路线与阶段信息。明确区分已上线、计划中和待定能力，用实线与虚线表达。", "当前能力 → 近期改进 → 远期方向 → 收集反馈和验证条件"],
    ],
    "销售营销 PPT": [
      ["客户提案", "客户解决方案", "mint", "compare", ["客户现状", "推荐方案", "预期价值"], "青白配色，客户需求与方案映射并列。范围、边界和交付条件分组。", "客户问题 → 需求优先级 → 推荐方案 → 价值证据 → 下一步"],
      ["营销活动规划", "活动执行计划", "red", "timeline", ["预热", "转化", "复盘"], "浅红底强调传播节奏，渠道、预算与指标分成对齐行。活动素材只使用已确认信息。", "目标与受众 → 核心信息 → 渠道计划 → 预算与分工 → 复盘口径"],
      ["客户成功案例", "从需求到成果", "kraft", "editorial", ["业务挑战", "解决过程", "客户成果"], "暖白编辑风，案例照片、客户陈述和结果指标分开。引用注明出处和授权状态。", "客户背景 → 业务挑战 → 解决过程 → 实证结果 → 复用经验"],
      ["销售漏斗分析", "转化表现追踪", "navy", "metrics", ["线索", "商机", "成交"], "深蓝数字主导，转化层级清楚。用漏斗与环节转化率辅助读数，注明单位、时间范围。", "销售目标 → 漏斗表现 → 关键断点 → 跟进动作与责任人"],
    ],
    "融资路演 PPT": [
      ["创业路演", "为什么现在做", "dark", "hero", ["市场机会", "解决方案", "融资目标"], "黑蓝封面聚焦一句价值主张。市场、进展和融资用途分别以简明数据页表达。", "问题 → 方案 → 市场与竞争 → 进展和团队 → 融资请求"],
      ["增长证据", "验证与增长", "cobalt", "metrics", ["留存", "营收", "增速"], "蓝紫白底，指标、时间序列和计量口径成组。关键假设独立标识。", "增长假设 → 产品证据 → 获客和留存 → 单位经济 → 计划"],
      ["商业模式说明", "从获客到盈利", "olive", "diagram", ["客户", "渠道", "收入"], "浅绿关系图，清楚标注价值、资金和服务流向。收入来源与成本项分区。", "客户分层 → 价值与触达 → 收入和成本 → 规模化假设 → 风险"],
      ["投资人更新", "阶段经营更新", "slate", "table", ["进展", "指标", "下一步"], "理性灰蓝表格，实际与预期并列。资金余量与风险使用直观标签。", "核心数据 → 经营进展 → 偏差与风险 → 下一期重点 → 所需支持"],
    ],
    "学术答辩 PPT": [
      ["研究答辩", "研究问题与贡献", "navy", "columns", ["研究问题", "方法", "贡献"], "白底学术蓝，问题、方法和贡献主次分明。术语、图表与参考出处使用统一格式。", "研究背景 → 问题 → 方法 → 结果 → 局限 → 结论"],
      ["数据论文汇报", "结果与稳健性", "slate", "metrics", ["样本", "主要结果", "稳健性"], "低饱和数据图。保持坐标轴单位和样本口径，比较图采用一致刻度与图例。", "样本和口径 → 主要结果 → 稳健性 → 局限与复现"],
      ["杂志叙事", "案例与答辩", "kraft", "editorial", ["研究场景", "证据摘录", "结论"], "暖白底、大标题、图文错落。图表页保留整洁网格，案例引用注明来源。", "案例背景 → 核心问题 → 一手证据 → 解释 → 结论"],
      ["毕业设计展示", "方案与验证", "plum", "compare", ["设计目标", "方案实现", "测试证据"], "浅紫和墨灰。展示图与验证表并排，构件标注使用统一编号与视角。", "任务与需求 → 方案选择 → 实现 → 测试 → 结论与展望"],
    ],
    "企业培训 PPT": [
      ["新人入职培训", "入职行动指南", "olive", "lesson", ["了解规则", "找到联系人", "完成任务"], "浅绿友好版式，行动卡、联系人提示和常见问题分区。行动清单可独立阅读。", "团队与规则 → 常用流程 → 资源与联系人 → 入职任务 → 答疑"],
      ["岗位操作手册", "操作流程演示", "navy", "steps", ["前置检查", "执行", "校验", "例外"], "蓝白操作指引，按顺序排列界面截图、操作及预期结果。失败分支独立标注。", "适用范围 → 前置条件 → 操作 → 校验 → 常见异常"],
      ["合规与安全培训", "场景判断练习", "red", "matrix", ["场景", "规则", "处理", "上报"], "稳重红色强调风险。情景卡逐项对应可做事项、禁止事项和处理渠道。", "适用规则 → 场景演练 → 正确处理 → 上报与复核 → 知识检查"],
      ["讲师工作坊", "从讲解到练习", "sun", "editorial", ["核心概念", "现场练习", "复盘"], "暖黄背景配高对比黑字，讲解与活动提示错落。计时、分组、交付要求便于投屏。", "学习目标 → 知识点 → 演示 → 练习 → 反馈和后续行动"],
    ],
  };
  const templates = Object.entries(groups).flatMap(([category, entries]) => entries.map(entry => {
    const [name, title, palette, layout, labels, visual, outline] = entry;
    return {category, name, title, colors: palettes[palette], layout, labels, visual, outline};
  }));
  const byName = new Map(templates.map(template => [template.name, template]));

  function preview(template) {
    const [background, ink, accent] = template.colors;
    return `<span class="ppt-template-preview" data-layout="${template.layout}" aria-hidden="true"
      style="--sample-bg:${background};--sample-ink:${ink};--sample-accent:${accent}">
      <b>${esc(template.title)}</b><span class="ppt-template-demo">${template.labels.map(label =>
        `<span>${esc(label)}</span>`).join("")}</span>
    </span>`;
  }

  function summary(name, disabled = "", label = "选择模板") {
    const template = byName.get(name) || byName.get("商务深蓝");
    return `<section class="ppt-template-summary" aria-label="PPT 模板">
      <div class="ppt-template-summary-head"><b>视觉模板</b><span class="meta">${esc(template.category)}</span></div>
      ${preview(template)}
      <div class="ppt-template-summary-head"><b>${esc(template.name)}</b>
        <button type="button" class="btn btn-secondary" data-action="ppt-open-templates" ${disabled}>${esc(label)}</button></div>
    </section>`;
  }

  function open(name, select) {
    if (document.getElementById("ppt-template-dialog")) return;
    const selected = byName.get(name);
    let category = selected?.category || "";
    const dialog = document.createElement("dialog");
    dialog.id = "ppt-template-dialog";
    dialog.setAttribute("aria-labelledby", "ppt-template-title");
    const categories = ["", ...Object.keys(groups)];
    dialog.innerHTML = `<header class="ppt-template-header">
      <div><h2 id="ppt-template-title">PPT 模板库</h2><p class="meta">${categories.length - 1} 类 · ${templates.length} 套模板</p></div>
      <button type="button" class="btn btn-ghost ppt-template-close" aria-label="关闭模板库">×</button>
    </header>
    <input type="search" class="input ppt-template-search" aria-label="搜索 PPT 模板" placeholder="搜索模板、用途或关键字">
    <div class="ppt-template-categories" role="group" aria-label="模板分类">${categories.map(value =>
      `<button type="button" class="btn btn-secondary" data-template-category="${esc(value)}" aria-pressed="false">
        ${value ? esc(value) : "全部模板"}</button>`).join("")}</div>
    <div class="ppt-template-results">
      <p class="meta" data-template-count aria-live="polite"></p>
      <div class="ppt-template-grid"></div>
    </div>`;
    const search = dialog.querySelector(".ppt-template-search");
    const categoriesRow = dialog.querySelector(".ppt-template-categories");
    const results = dialog.querySelector(".ppt-template-results");
    const count = dialog.querySelector("[data-template-count]");
    const grid = dialog.querySelector(".ppt-template-grid");

    function showTemplates() {
      const keywords = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = templates.filter(template => {
        if (category && category !== template.category) return false;
        const searchable = [template.name, template.category, template.title, template.outline, ...template.labels].join(" ").toLocaleLowerCase();
        return keywords.every(word => searchable.includes(word));
      });
      for (const control of categoriesRow.querySelectorAll("button")) {
        control.setAttribute("aria-pressed", String(control.dataset.templateCategory === category));
      }
      count.textContent = `${matches.length} 套模板`;
      grid.innerHTML = matches.map(template => `<button type="button" class="ppt-template-card"
        data-template-name="${esc(template.name)}" aria-pressed="${String(template.name === name)}">
        ${preview(template)}
        <span class="ppt-template-caption"><b>${esc(template.name)}</b><span>${esc(template.category)}</span></span>
        <small class="ppt-template-outline">${esc(template.outline)}</small>
      </button>`).join("") || '<p class="empty">没有找到匹配的模板。试试其他关键词或切换分类。</p>';
      results.scrollTop = 0;
    }

    search.addEventListener("input", () => {
      category = "";
      showTemplates();
    });
    dialog.addEventListener("click", event => {
      const control = event.target.closest("button");
      if (!control) return;
      if (control.classList.contains("ppt-template-close")) dialog.close();
      if (control.hasAttribute("data-template-category")) {
        category = control.dataset.templateCategory;
        showTemplates();
      }
      const choice = byName.get(control.dataset.templateName);
      if (choice) {
        dialog.close();
        if (choice.name !== name) select(choice.name);
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), {once: true});
    document.body.append(dialog);
    showTemplates();
    dialog.showModal();
    search.focus();
  }

  function visualGuide(name) {
    const template = byName.get(name);
    if (!template) return name || "";
    const [background, ink, accent] = template.colors;
    return `${template.name}（${template.category}），以 ${background} 为参考底色、${ink} 为参考文字色、${accent} 为参考强调色。${template.visual}`;
  }

  function outlineGuide(name) {
    const template = byName.get(name);
    return template ? `${template.name}（${template.category}）。建议叙事顺序：${template.outline}。按用户提供的事实和页数选用。` : "";
  }

  return {summary, open, visualGuide, outlineGuide};
})();
