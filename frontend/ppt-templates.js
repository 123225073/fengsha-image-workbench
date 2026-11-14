"use strict";

const workspacePptTemplates = (() => {
  const palettes = {
    basicBlue: ["#ffffff", "#172b4d", "#2255a4"],
    basicGray: ["#ffffff", "#202124", "#58606b"],
    basicGreen: ["#f8fbf8", "#183e32", "#26775b"],
    basicOrange: ["#fffcf7", "#49362d", "#b35e22"],
    bay: ["#f3f7fa", "#102b45", "#136789"],
    signal: ["#132337", "#f0f6fe", "#70d9c0"],
    paper: ["#f7f2e8", "#362820", "#9a4938"],
    orbit: ["#142731", "#f3f6ef", "#c6e75a"],
    launch: ["#231614", "#fff5ed", "#f46443"],
    classroom: ["#f0f7f5", "#173a37", "#d38a24"],
    pitch: ["#24213e", "#f8f6ff", "#cbc7ff"],
    impact: ["#f7f3e5", "#233d31", "#a97537"],
    market: ["#fceeee", "#431728", "#c33465"],
    prism: ["#11102a", "#f5f2ff", "#64f5e9"],
    pulse: ["#153ad3", "#f8f7f1", "#e9fc49"],
    ember: ["#1f171a", "#f6ead8", "#ef8444"],
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
    "基础模板": [
      ["霓光·未来科技", "下一次跃迁", "prism", "points", ["演讲", "舞台", "科技", "未来", "科技大会"], "暗紫舞台配青色光带，适合科技峰会、趋势分享和创新演讲。", "信号 → 变化 → 路线图 → 行动"],
      ["电蓝·创意演讲", "打破惯性", "pulse", "points", ["演讲", "舞台", "公开课", "设计", "创意"], "电蓝、荧光柠檬黄与黑白摄影，适合公开演讲、创意分享和论坛开场。", "问题 → 视角 → 行动 → 收尾"],
      ["长夜·故事分享", "越过那片山", "ember", "points", ["演讲", "个人故事", "故事", "主题分享"], "炭黑、暖白和余烬橙，适合个人故事、经验分享和叙事演讲。", "出发 → 转折 → 高潮 → 结尾"],
      ["海湾·商务提案", "客户服务升级", "bay", "points", ["提案", "客户", "项目"], "海军蓝与冰白，斜切图文和半透明蓝带贯穿封面、方案对照和实施路线。适合提案和项目评审。", "业务挑战 → 方案与取舍 → 分阶段验证 → 决策与行动"],
      ["信号·技术分享", "知识检索架构", "signal", "process", ["技术", "架构", "复盘"], "墨蓝封面配薄荷色信号线，内页以亮底强调分层和节点。适合架构、流程与技术复盘。", "技术问题 → 关键机制 → 方案比较 → 落地流程 → 验证与边界"],
      ["纸本·研究纪要", "社区阅读观察", "paper", "comparison", ["研究", "答辩", "案例"], "暖白纸面、宋体大标题、朱红细线和低饱和图像。适合调研、案例和答辩。", "研究问题 → 样本与方法 → 观察与证据 → 结论与局限"],
      ["向上·年度经营", "年度经营复盘", "orbit", "points", ["年终", "述职", "经营", "财务", "复盘"], "深墨色与青柠绿，封面用几何环形，内页突出关键指标和年度行动。", "成果 → 变化 → 项目 → 计划"],
      ["赤焰·新品发布", "新品发布", "launch", "points", ["发布会", "产品", "新品", "演示"], "炭黑、暖白和焰橙，聚焦一件产品，用大图和分区放大卖点。", "亮点 → 场景 → 对比 → 上市"],
      ["浅岛·企业培训", "新人上手指南", "classroom", "points", ["培训", "教案", "上手", "课堂"], "浅青底、深青字和金色路径，适合讲解、演练和回顾。", "目标 → 示范 → 练习 → 回顾"],
      ["远山·融资路演", "增长与机会", "pitch", "points", ["路演", "投资人", "融资", "商业模式"], "午夜紫封面配渐进折面，内页以图表和精简的结构展示增长路径。", "市场 → 模式 → 增长 → 资金"],
      ["山野·可持续行动", "可持续行动报告", "impact", "points", ["公益", "ESG", "环保", "可持续"], "森绿、暖米白和赭色，使用纪实摄影和清晰的信息层级。", "范围 → 行动 → 记录 → 承诺"],
      ["莓红·品牌营销", "品牌活动策划", "market", "points", ["营销", "品牌", "投放", "渠道"], "莓红与浅粉搭配编辑式图文构图，适合活动策划、渠道节奏和复盘。", "洞察 → 主线 → 渠道 → 结果"],
      ["基础·商务蓝", "项目进展汇报", "basicBlue", "points", ["本期进展", "当前问题", "下一步安排"], "白底深蓝正文与蓝色强调线。统一标题、正文、页码和安全边距，优先结论与事实。", "汇报目标 → 关键进展 → 问题与对照 → 行动计划 → 待确认事项"],
      ["基础·极简灰", "简洁的管理层简报", "basicGray", "points", ["核心结论", "支撑事实", "决策事项"], "纯白底和高对比灰黑字，装饰克制。适合正式评审、投屏和打印。", "核心结论 → 关键证据 → 选项比较 → 推荐行动 → 决策事项"],
      ["基础·教育绿", "清晰的培训与分享", "basicGreen", "points", ["学习目标", "重点内容", "行动练习"], "浅白绿色底与深绿正文。知识点按阅读顺序分组，步骤页与总结页保持同一节奏。", "学习目标 → 背景与概念 → 示例与对照 → 操作步骤 → 练习与小结"],
      ["基础·暖白橙", "有重点的方案说明", "basicOrange", "points", ["需求背景", "方案价值", "实施安排"], "暖白底、深棕正文与柔和橙色强调。保留充分留白，适合提案、案例和内部分享。", "目标与需求 → 方案要点 → 选项对照 → 实施安排 → 后续行动"],
    ],
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
  // Keep historical preset settings for existing drafts.
  const baseName = "基础·商务蓝";
  const designs = {
    bay: {
      category: "商业 PPT",
      type: "中文封面用有分量的宋体主标题，副标题缩小一级；内页用清晰黑体或宋体标题、黑体正文，图表同一网格对齐。",
      pages: {
        cover: "左侧为契合主题的摄影或图形，右侧冰白留字区用斜切过渡，右列排主标题和副标题，底部用半透明海蓝带收边。",
        agenda: "左列对齐章节号和标题，右侧可配一块斜切图面，细蓝横线强调标题。",
        section: "章节编号与大标题集中在明亮文字区，另一侧用斜切图像保持与封面呼应。",
        points: "冰白底、标题下用横向结论区，其余支撑要点按行分隔，海蓝只用于路径和重点。",
        comparison: "左右等宽并列，标题对齐，用竖线分开两个方案，每栏以简短小标题开头。",
        process: "从左到右的路线，每个节点先显示步骤名，说明放在节点下方。",
        closing: "沿用封面的斜切图文，留白区突出确认事项，副标题列出下一步。",
      },
    },
    signal: {
      category: "技术分享 PPT",
      type: "中文用思源黑体或等效黑体，主标题粗体，代码、接口名和技术标签用 IBM Plex Mono 风格的等宽字。",
      inner: ["#E8F4FC", "#132337", "#179E8B"],
      pages: {
        cover: "整页深墨蓝，粗体主标题和副标题靠左，右半边用半透明玻璃分层和薄荷色节点表现技术结构。",
        agenda: "纵向目录，序号列与标题列分开，用薄荷色小圆点连接各项。",
        section: "大号薄荷色编号与白色章节标题分层，右边延续信号阶梯。",
        points: "浅冰蓝底配深色粗体标题，左侧短薄荷线起笔，重点用有留白的图示或对齐短文说明。",
        comparison: "两组方案左右对齐，用半透明冰蓝模块、细边界和薄荷色标明主要差异。",
        process: "三个技术模块按从左到右连接，步骤名靠上，正文靠下，箭头方向用已确认内容决定。",
        closing: "大标题与一句结论靠左，右边保留终端信号线和足够留白。",
      },
    },
    paper: {
      category: "学术答辩 PPT",
      type: "主标题用思源宋体或宋体，较粗字重；小标题与正文用思源黑体或等效黑体，暖黑字。",
      pages: {
        cover: "暖纸底，大宋体标题和副标题靠左，右侧配合主题放一张低饱和照片，剪裁边界像折页，朱红细线串起两侧。",
        agenda: "纵向目录像书籍目录，每行有编号与标题，两项之间用细线或留白分隔。",
        section: "大号章节编号与宋体标题左对齐，像研究报告分节，保留右上大留白。",
        points: "页标题靠左上，正文采用短行和细规则线，关键证据作为单独一行。",
        comparison: "两栏像刊物并排，只有中间一根细竖线，证据和出处靠对应内容排布。",
        process: "以纵向三步阅读，左列为关键动作，右列为简短说明，行间以浅线区分。",
        closing: "宋体结论靠左、其下留一行研究局限或后续行动，页脚仅保留细线。",
      },
    },
    orbit: {
      category: "经营复盘",
      type: "标题用醒目粗黑体，数字用等宽粗体。深墨配青柠几何线，浅底内页用细线分组。",
      inner: ["#F3F6EF", "#142731", "#527729"],
      pages: {
        cover: "大标题靠左，环形图形占右侧，青柠只用于强调。",
        points: "优先放可核验的关键指标，下方写统计口径、变化原因或行动。",
        comparison: "按相同期间与口径对齐两组指标，重点变化用一处青柠色强调。",
        process: "用按时间对齐的目标与行动轨道，突出节点与责任。",
      },
    },
    launch: {
      category: "产品发布",
      type: "封面用特粗黑体标题和炭黑焰橙，内页留暖白。产品图强调轮廓、材质和真实使用比例。",
      inner: ["#FFF5ED", "#231614", "#B9442D"],
      pages: {
        cover: "用一件和本次内容相关的主视觉占据右侧，左侧留大标题区，暖橙光只凸显轮廓。",
        points: "一页讲一个卖点，尽量用相关产品细节或场景图说明，短文字排在另一侧。",
        comparison: "保留相同视角和标注尺度，两列展示差别。",
        process: "用可扫读的横向发布计划标注节点，末端强调已确认的行动。",
      },
    },
    classroom: {
      category: "企业培训",
      type: "粗黑体标题和深青正文字，金色只标清步骤和重点。图形有纸艺质感，行距宽松。",
      pages: {
        cover: "大标题靠左，右侧用折纸或陶瓷质感图形提示学习路径。",
        points: "一个学习任务或情景一个区域，说明控制在可投屏阅读的长度。",
        comparison: "镜像分栏说明两种做法，用统一对齐和标记形成对照。",
        process: "用清楚的序号串起动作，每个节点旁放一句说明或示范。",
      },
    },
    pitch: {
      category: "融资路演",
      type: "大号无衬线标题，午夜紫和薰衣草色形成对比，亮底内页用纤细图形与短标题。",
      inner: ["#F8F6FF", "#24213E", "#7562D9"],
      pages: {
        cover: "左侧留白装入主张，右侧以折叠立体结构形成抬升感。",
        points: "优先摆放市场、数据或证据，标签齐头，重要事实保留来源。",
        comparison: "用同一尺度展示不同方案或同期数据。",
        process: "用阶梯和顺序强调增长路径，具体数值与阶段按文稿。",
      },
    },
    impact: {
      category: "公益与可持续",
      type: "暖米白纸面和森林绿粗标题，赭色作辅助。纪实照片自然调色，压低装饰。",
      pages: {
        cover: "纪实摄影跨下半页，上半页留白排标题与副标题。",
        points: "组合大幅现场图与少量说明，用细线引导阅读。",
        comparison: "用同尺度照片、原始记录或对照数据，说明采集边界。",
        process: "按行动顺序放清楚的节点，末端列出后续承诺。",
      },
    },
    market: {
      category: "品牌营销",
      type: "浅粉与莓红交替，标题像杂志封面，正文和数据保持高对比。",
      pages: {
        cover: "左边安排大字标题，右边放契合品牌调性的静物或图形组合，保留留白。",
        points: "用编辑式拼接将主洞察置顶，图片和要点相互说明。",
        comparison: "两组内容保留统一的对齐规则，用深浅强调主次。",
        process: "用横向活动排期呈现渠道与节奏，节点标签短而明确。",
      },
    },
    prism: {
      category: "舞台演讲",
      type: "大号无衬线中文标题、高反差细节。深黑紫底，青色光线与紫色反射强调焦点。",
      pages: {
        cover: "标题靠左，右边用虹彩黑曜石与青色光带塑造立体主视觉。边缘保留投屏安全区。",
        section: "用大号数字和一个短标题切换段落，背景只留简洁光痕。",
        points: "一句结论居中放大，其余文字放到安全区的一侧，让观众一眼读完。",
        comparison: "左右两侧以同等视觉重量对照，局部青光强调关键变化。",
        process: "深底上用有方向的青色节点与连接线呈现路径，每站只放短标签。",
        closing: "放大最后一句行动主张，弱化图形，保留足够留白。",
      },
    },
    pulse: {
      category: "舞台演讲",
      type: "超粗黑体和不对称网格，电蓝搭荧光黄与纸白。黑白摄影采用大胆裁切，信息保持清楚。",
      pages: {
        cover: "超大主标题与一块黑白剪影构成对角线，少量荧光黄标出焦点。",
        section: "用一组大字和实色切面翻转节奏。",
        points: "把关键词放大成页面视觉重心，图形或结论靠边对齐，留出大块空面。",
        comparison: "对照左右用反白和纸白做分区，同一高度放短标题，再用同规格例子说明。",
        process: "将行动用短语排列，电蓝和荧光黄交替打点。",
        closing: "一条行动句占主要画幅，留下简洁的电蓝签名式收尾图形。",
      },
    },
    ember: {
      category: "舞台演讲",
      type: "采用暖白宋体大标题，深色上保持对比。纪实电影感照片配少量暖橙，图面留出不被文字覆盖的区域。",
      pages: {
        cover: "一张叙事照片铺满，文案对齐暖白留字区。橙光和地平线帮助引导视线。",
        section: "让转折短句与画面形成对照，让观众注意叙事变化。",
        points: "交替使用全页照片和纯色引文页，一页只突出一句话或一个事实。",
        comparison: "用左右两张同色调照片建立前后对照，避免破坏原情境的文字。",
        process: "用跨画面的细时间线串起关键节点，配简短地名或动作。",
        closing: "用开阔远景与一句短结语收束，照片细节与暖白字保持可读对比。",
      },
    },
  };
  const templates = Object.entries(groups).flatMap(([category, entries]) => entries.map(entry => {
    const [name, title, palette, layout, labels, visual, outline] = entry;
    const family = Object.hasOwn(designs, palette) ? palette : "";
    return {category, name, title, colors: palettes[palette], layout, labels, visual, outline, family, native: category === "基础模板"};
  }));
  const byName = new Map(templates.map(template => [template.name, template]));
  const available = templates.filter(template => template.family);
  for (const entry of globalThis.workspacePptReferenceCatalog || []) {
    if (byName.has(entry.name)) continue;
    const template = {name: entry.name, title: entry.title, family: entry.key, colors: entry.colors,
      labels: entry.keywords, visual: entry.summary, native: true};
    designs[entry.key] = {category: entry.category, type: entry.type, inner: entry.inner, pages: entry.pages};
    byName.set(entry.name, template);
    available.push(template);
  }

  function referenceKey(name) {
    return byName.get(name)?.family || "";
  }

  function availableNames() {
    return available.map(template => template.name);
  }

  function referenceUrl(template) {
    return `/frontend/ppt-style-references/${template.family}.jpg`;
  }

  function preview(template, defer = false) {
    const key = template.family;
    if (key) return `<img class="ppt-reference-image" ${defer ? "data-reference-src" : "src"}="${referenceUrl(template)}"
      alt="${esc(template.name)}视觉参考图" decoding="async">`;
    return `<span class="ppt-legacy-swatches" aria-hidden="true">${template.colors.map(color =>
      `<span style="background:${color}"></span>`).join("")}</span>`;
  }

  function summary(name, disabled = "", label = "选择模板") {
    const template = byName.get(name) || byName.get(baseName);
    return `<section class="ppt-template-summary" aria-label="PPT 模板">
      <div class="ppt-template-summary-head"><b>分镜视觉模板</b><span class="meta">${esc(designs[template.family]?.category || "已停用的旧样式")}</span></div>
      ${preview(template)}
      <div class="ppt-template-summary-head"><b>${esc(template.name)}</b>
        <button type="button" class="btn btn-secondary" data-action="ppt-open-templates" ${disabled}>${esc(label)}</button></div>
      <p class="meta">${esc(template.visual)}</p>
    </section>`;
  }

  function open(name, select) {
    if (document.getElementById("ppt-template-dialog")) return;
    const opener = document.activeElement;
    let chosen = byName.get(name);
    if (!chosen?.family) chosen = available[0];
    const categoryCounts = new Map();
    for (const template of available) {
      const category = designs[template.family].category;
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    }
    const dialog = document.createElement("dialog");
    dialog.id = "ppt-template-dialog";
    dialog.setAttribute("aria-labelledby", "ppt-template-title");
    dialog.innerHTML = `<header class="ppt-template-header">
      <div><h2 id="ppt-template-title">选择分镜视觉模板</h2><p class="meta">每套一张参考图，包含封面和代表性内页。</p></div>
      <button type="button" class="btn btn-ghost ppt-template-close" aria-label="关闭模板库">×</button>
    </header>
    <div class="ppt-template-toolbar"><input type="search" class="input ppt-template-search" aria-label="搜索 PPT 模板" placeholder="搜索模板、用途或关键字">
      <label class="ppt-template-filter">用途<select class="input" aria-label="模板分类"><option value="">全部参考图（${available.length}）</option>${[...categoryCounts].map(([value, count]) => `<option value="${esc(value)}">${esc(value)}（${count}）</option>`).join("")}</select></label>
    </div>
    <div class="ppt-template-body">
      <section class="ppt-template-results" aria-label="模板列表"><p class="meta" data-template-count aria-live="polite"></p><div class="ppt-template-grid"></div></section>
      <section class="ppt-template-detail" aria-label="模板预览"></section>
    </div>
    <footer class="ppt-template-footer"><p class="meta">参考图用于指导分镜的配色与排版。</p><button type="button" class="btn btn-primary" data-template-apply></button></footer>`;
    const search = dialog.querySelector(".ppt-template-search");
    const filter = dialog.querySelector(".ppt-template-filter select");
    const results = dialog.querySelector(".ppt-template-results");
    const count = dialog.querySelector("[data-template-count]");
    const grid = dialog.querySelector(".ppt-template-grid");
    const detail = dialog.querySelector(".ppt-template-detail");
    const apply = dialog.querySelector("[data-template-apply]");
    const thumbnailObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !entry.target.isConnected) continue;
        entry.target.src = entry.target.dataset.referenceSrc;
        thumbnailObserver.unobserve(entry.target);
      }
    }, {root: results, rootMargin: "240px 0px"});

    function showDetail() {
      if (!chosen) {
        detail.innerHTML = '<p class="empty">没有符合条件的参考图。</p>';
        apply.textContent = "使用模板";
        apply.disabled = true;
        return;
      }
      detail.innerHTML = `<div class="ppt-template-detail-heading"><div><h3>${esc(chosen.name)}</h3><p class="meta">${esc(designs[chosen.family].category)}</p></div>
        <div class="ppt-template-detail-actions"><span class="ppt-template-badge">${chosen.name === name ? "当前使用" : "待应用"}</span>
          <a class="ppt-template-original" href="${referenceUrl(chosen)}" target="_blank" rel="noopener">看原图</a></div></div>
        <div class="ppt-template-main-preview">${preview(chosen)}</div>
        <p class="ppt-template-visual">${esc(designs[chosen.family].type)}</p>
        <div class="ppt-template-palette" aria-label="模板配色">${chosen.colors.map(color => `<span><i style="background:${color}" aria-hidden="true"></i>${esc(color.toUpperCase())}</span>`).join("")}</div>`;
      apply.textContent = chosen.name === name ? "保留当前样式" : `使用「${chosen.name}」`;
      apply.disabled = false;
    }

    function showTemplates() {
      const keywords = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const matches = available.filter(template => {
        const purpose = designs[template.family].category;
        if (filter.value && filter.value !== purpose) return false;
        const searchable = [template.name, purpose, template.title, template.visual, template.outline,
          designs[template.family].type, ...template.labels].join(" ").toLocaleLowerCase();
        return keywords.every(word => searchable.includes(word));
      });
      if (!matches.includes(chosen)) chosen = matches[0];
      count.textContent = `${matches.length} 套样式`;
      thumbnailObserver.disconnect();
      grid.innerHTML = matches.map(template => `<button type="button" class="ppt-template-card"
        data-template-name="${esc(template.name)}" aria-pressed="${String(template === chosen)}" aria-label="预览${esc(template.name)}">
        ${preview(template, true)}
        <span class="ppt-template-caption"><b>${esc(template.name)}</b><span>${esc(designs[template.family].category)}</span></span>
        <small class="ppt-template-outline">${esc(template.title)}</small>
      </button>`).join("") || '<p class="empty">没有匹配的样式。换个关键词，或选择其他分类。</p>';
      results.scrollTop = 0;
      grid.querySelectorAll("img[data-reference-src]").forEach(image => thumbnailObserver.observe(image));
      showDetail();
    }

    search.addEventListener("input", showTemplates);
    filter.addEventListener("change", showTemplates);
    dialog.addEventListener("click", event => {
      const control = event.target.closest("button");
      if (!control) return;
      if (control.classList.contains("ppt-template-close")) return dialog.close();
      const choice = byName.get(control.dataset.templateName);
      if (choice?.family) {
        chosen = choice;
        for (const card of grid.querySelectorAll("[data-template-name]")) card.setAttribute("aria-pressed", String(card.dataset.templateName === chosen.name));
        showDetail();
      }
      if (chosen && control.hasAttribute("data-template-apply")) {
        const selectedName = chosen.name;
        dialog.close();
        if (selectedName !== name) select(selectedName);
      }
    });
    dialog.addEventListener("close", () => {
      thumbnailObserver.disconnect();
      dialog.remove();
      if (opener?.isConnected) opener.focus({preventScroll: true});
    }, {once: true});
    document.body.append(dialog);
    showTemplates();
    dialog.showModal();
    search.focus();
  }

  function visualGuide(name, layout) {
    const template = byName.get(name) || byName.get(baseName);
    const design = designs[template.family];
    const [background, ink, accent] = design?.inner && layout && !["cover", "section", "closing"].includes(layout)
      ? design.inner : template.colors;
    return `${template.name}，底色 ${background}，文字色 ${ink}，强调色 ${accent}。${design ?
      design.type + (design.pages[layout] || design.pages.points) : template.visual}`;
  }

  function nativeTemplate(name) {
    const template = byName.get(name) || byName.get(baseName);
    const layouts = {columns: "points", compare: "comparison", timeline: "process", steps: "process", diagram: "process", blueprint: "process"};
    return {name: template.name, colors: [...template.colors], layout: template.native ? "points" : layouts[template.layout] || "points"};
  }

  return {summary, open, visualGuide, nativeTemplate, referenceKey, availableNames};
})();
