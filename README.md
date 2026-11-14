# 风沙生图工作台 · Windows 版

在本机浏览器使用的创作工作台，包含 AI 生图、图片编辑、海报、PPT 和图片 Agent。Windows 10/11 x64 可使用以下安装方式。macOS 版待后续适配。

当前版本 **1.3.1**。在「后台设置 → Agent 与 Skills」查看内置规则及工具，并为 Agent 或单个 Skill 保存补充规则。PPT 工作台提供 4 套可预览的基础样式，可从大纲直接导出原生可编辑 PPTX。详见 [全功能验收与优化记录](docs/全功能验收与优化-20261114.md)。

## 下载安装

1. 到 [最新版本](https://github.com/123225073/fengsha-image-workbench/releases/latest)，下载对应版本的 `fengsha-image-workbench-版本号-windows.zip`；历史恢复附件仅供回退。也可在 [GitHub 仓库](https://github.com/123225073/fengsha-image-workbench) 点 **Code → Download ZIP** 获取源码。在 Windows 资源管理器右键下载的 ZIP，若「属性」里有「解除锁定」，勾选后再解压到可写文件夹。
2. 双击 **检查电脑环境.cmd**。它只检查 Windows、Python、磁盘空间、显卡和本地超分状态。
3. 双击 **启动本地工作台.cmd**。支持复用 64 位 Python 3.12 或 3.13。缺少 Python 时，输入 `Y` 同意安装官方 Python 到项目目录。随后输入 `Y` 同意在项目的 `.venv` 中安装依赖。后续启动复用这套环境。
4. 保持启动窗口打开，浏览器会进入 [工作台首页](http://127.0.0.1:8766/)。关闭工作台可回到启动窗口按 **Ctrl+C**。若 8766 已被其他程序占用，关闭占用程序或按下文改用另一个本机端口。

### 第一次登录

| 项目 | 初始值或操作 |
| --- | --- |
| 工作台 | [127.0.0.1:8766](http://127.0.0.1:8766/) |
| 登录页 | [127.0.0.1:8766/login](http://127.0.0.1:8766/login) |
| 管理后台 | [127.0.0.1:8766/admin](http://127.0.0.1:8766/admin)，仅管理员可进入 |
| 初始账号 | 点击「登录 / 注册 → 初始化本地管理员」，以你填写的邮箱作为管理员账号 |
| 初始密码 | 初始化时自行设置，8–128 个字符。每份安装独立创建 |
| 初始积分 | 0。使用按积分计费的功能前，可在「后台设置 → 用户管理」调整余额 |
| 普通账号 | 管理员可直接添加，或发放邀请码。未配置邮件服务时，验证码保存在本机 `.commercial-data/mail-outbox/` |

全新安装的连接和模型目录为空。进入 **后台设置 → 模型中心 → 新增连接**，填写自己服务商提供的 HTTPS Base URL 和 API Key，获取目录并上架图片、语言模型，再分别设默认模型。图片按张设置积分，语言模型按每百万输入和输出 Token 设置积分。模型探测和实际出图可能产生服务商费用。

## 主程序和可选能力

| 功能 | 使用条件 |
| --- | --- |
| 浏览示例、账号、项目、素材库、裁剪、已有动图拼接、原图 PPTX 与原生可编辑 PPTX 导出 | 安装主程序 |
| AI 生图与编辑、GIF 分镜、SVG 描摹、海报、PPT 和 AI 对话 | 在后台接入自己的模型。GIF/SVG 原生输出取决于模型服务商 |
| 图片 OCR、PPTX 自动提取文字 | 使用 Windows OCR 及对应语言识别包。没有对应语言包时，可用原图 PPTX 或手工标记文字。已有 Tesseract 也可使用 |
| **可选本地超分** | 双击 **安装可选本地超分.cmd**，确认后下载官方 Real-ESRGAN。脚本检查 Vulkan，并用小图实测。弱显卡可跳过 |
| **可选云端超分** | 头像 →「超分设置」，输入自己的阿里云百炼北京地域 Key。百炼接收图片并计费 |
| **可选邮件投递** | 配置自己的 SMTP 后可向邮箱发送验证码。默认邮件写入本地文件夹 |

本地 Real-ESRGAN 是按任务启动的独立程序。它需要 Vulkan 显卡和匹配的驱动，实际可处理的图片尺寸受显存影响。也可从官方发行页下载 Windows 包，将可执行文件与 `models` 解压到 `.workspace-data/vendor/realesrgan/`。 [Real-ESRGAN 官方发行页](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0)

## 源码安装与更新

Windows 开发者可用自己的 Python 环境手动运行。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe workspace_server.py --open-browser
```

更新时先用原启动窗口停止服务。Git 安装可拉取新代码，ZIP 安装可解压到新目录，再把旧目录的 **整个** `.commercial-data` 复制进去。可选本地超分可复制已经验证可用的引擎目录，或用安装脚本重装。搬迁后重新运行启动器。旧版本已有管理员继续使用旧账号和密码。

默认只监听本机 `127.0.0.1`。可通过环境变量 `FENGSHA_WORKSPACE_PORT` 改本机端口，`FENGSHA_WORKSPACE_DATA` 可指定独立数据目录。数据库、个人资料、API 地址与密钥、生成内容、日志和模型缓存留在本机，备份时数据库与 `provider-secret.key` 需一起保留。仓库包含内置提示词、模板及专用演示素材。应用使用 Python、SQLite、HTML、CSS 和 JavaScript。

详见 [Windows 配置与功能验收](本地使用与验收.md) · [MIT 许可证](LICENSE)。
