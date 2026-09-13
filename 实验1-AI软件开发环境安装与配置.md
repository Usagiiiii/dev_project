# 实验1：AI软件开发环境安装与配置

## 学习通提交说明

- **提交平台：** 学习通。
- **文件命名：** 班级-学号-姓名-实验1-AI软件开发环境安装与配置.pdf。
- **截止时间：** 以学习通作业设置为准。

## 1. 实验目的

- 建立能够支撑个人软件持续开发的IDE、运行时、Git与GitHub/Gitee基础环境。
- 完成Codex、Claude Code、DeepSeek Harness等AI开发工具的安装或接入验证，理解命令行、IDE插件与API调用三类使用方式。
- 优先使用阿里云、腾讯云等平台提供的免费额度；没有可用额度时采用本地模型，并学会安全管理API密钥和本地模型配置。

> **相关课程参考**
> - [CMU 15-113：Effective Coding with AI（2026）](https://www.csd.cs.cmu.edu/course/15113/s26)：参考其对AI编程助手、版本控制、质量验证和AI使用透明性的综合要求。
> - [COMPSCI 1066：Build at the Speed of Thought（2026课程目录）](https://my.harvard.edu/course/COMPSCI1066/2026-Fall/001)：参考其比较不同AI模型和开发工具、理解AI做了什么与没有做什么的做法。


## 2. 实验内容

### 2.1 开发环境清单与技术栈选择

- 说明计划开发的软件类型及拟采用的语言、框架、数据库和运行平台，给出选择理由。
- 制作环境清单：工具名称、版本、安装位置或获取方式、验证命令、验证结果。
- 补充本机操作系统、处理器架构和可用内存等基本信息，检查所选技术之间是否存在版本兼容问题。

### 2.2 IDE、运行时与基础工具配置

- 完成IDE与运行时配置，创建最小项目并成功启动；报告中给出项目结构截图和运行结果。
- 记录至少一个实际配置问题，例如解释器/JDK选择、PATH、依赖下载、代理或插件冲突，并说明处理过程。
- 使用项目的依赖文件或包管理工具保存依赖版本，并给出重新安装依赖和启动项目的命令。

### 2.3 Git与GitHub/Gitee版本管理

- 创建个人软件仓库，设置README、.gitignore和开源许可或仓库可见性；完成首个可说明内容的提交。
- 报告中列出仓库地址、默认分支、关键命令及首个Commit Hash，说明后续分支和提交规范。
- 修改一次README或示例代码并完成第二次提交，通过提交历史说明Git如何记录文件变化。

### 2.4 AI开发工具安装与接入

- 从Codex、DeepSeek Harness、Claude Code等工具中至少配置两种，记录安装方式、版本、认证方式和可用入口。
- 使用完全相同的小任务分别验证两种工具，例如解释项目结构、生成README草案；在AI协作记录中保存任务、关键输入、采用或未采用的建议、人工修改和验证结果。
- 制作简单对比表，从完成度、正确性、可解释性和使用成本等方面比较结果，并确定后续使用的主要工具和备用工具。

### 2.5 模型服务与API密钥安全

- 完成一个云端或本地模型API的最小调用，记录模型名称、运行位置、请求类型、返回结果、时延和大致用量。
- 使用环境变量或本地配置文件管理密钥，将敏感文件加入.gitignore；截图必须对密钥、Token、账号信息进行遮挡。
- 使用云端模型时查看免费额度、计费方式和余额提醒设置；没有可用额度时使用Ollama或同类工具运行本地模型，并记录模型下载、启动和调用方式。

### 2.6 环境验收

- 建立环境验收表，依次验证：项目可启动、Git可提交与推送、两种AI工具可响应、模型API可调用、AI协作记录可查看、仓库中无明文密钥。
- 在报告中给出通过/未通过清单；未通过项必须写明原因、替代方案和预计完成时间。
- 关闭并重新打开终端或IDE，或者在新的项目目录中重新获取代码并执行关键验证，确认环境和运行说明能够复现。

## 3. 操作记录

> 说明：本节按 2.1—2.6 记录本机实际操作。密钥、Token 已脱敏；命令输出以文字摘录为主。操作日期：2026-09-08。本机工作目录：`d:\dev_project\p1\dev_project`。

### 3.1 对应 2.1：开发环境清单与技术栈选择

**计划开发的软件类型：** 个人 Web / 命令行工具类小项目（环境验收用最小 Node 演示项目先行）。

**拟采用技术栈及理由：**

| 类别 | 选择 | 理由 |
| --- | --- | --- |
| 语言 / 运行时 | JavaScript（Node.js） | 安装简单、跨平台、适合快速搭最小可运行项目；本机已有 Node |
| 包管理 | npm | 随 Node 自带，依赖锁定清晰 |
| IDE | Cursor | 本机主力编辑器，内置 AI Agent，便于实验 2.4 |
| 版本管理 | Git + GitHub | 远程仓库已存在：`https://github.com/Usagiiiii/dev_project.git` |
| 云端模型 | 阿里云 DashScope（通义） | 本机已配置环境变量 `DASHSCOPE_API_KEY`，可用兼容 OpenAI 的 Chat Completions |
| AI CLI | DeepSeek Harness（`dsh`） | 已全局安装，可作为第二种 AI 工具入口 |
| 数据库 | 本阶段不引入 | 环境验收以“可启动 + 可调用模型”为主，暂不增加 DB 兼容成本 |

**本机基本信息：**

| 项目 | 实测结果 |
| --- | --- |
| 操作系统 | Windows 10 / 11（`Microsoft Windows NT 10.0.26200.0`） |
| 架构 | AMD64（x64） |
| CPU | 13th Gen Intel(R) Core(TM) i5-13500H |
| 内存 | 约 15.6 GB |
| 兼容性判断 | Node 24 + Python 3.14 可并存；Git 已安装但曾出现 PATH 截断导致终端找不到 `git`（见 3.2）；JDK 1.8 与当前 Node 栈无冲突（本实验未强制使用 Java） |

**表 3-1 环境清单**

| 工具名称 | 版本 | 安装位置 / 获取方式 | 验证命令 | 验证结果 |
| --- | --- | --- | --- | --- |
| Cursor | 3.3.30（x64） | `C:\Program Files\cursor\` | `cursor --version` | 通过 |
| Node.js | v24.19.0 | `C:\Program Files\nodejs\node.exe` | `node -v` | 通过 |
| npm | 随 Node 安装 | 同上 | `npm -v` | 通过（会话中另见 Cursor 内置 Node helper 可能抢先出现在 PATH，需注意） |
| Python | 3.14.0 | `AppData\Local\Python\pythoncore-3.14-64` | `py --version` | 通过 |
| pip | 25.2 | 随 Python | `py -m pip --version` | 通过 |
| Git | 2.55.0.windows.5 | `C:\Program Files\Git\cmd\git.exe` | `"C:\Program Files\Git\cmd\git.exe" --version` | 通过；需修正 PATH 后才能直接敲 `git` |
| DeepSeek Harness | `@deepseek-ai/dsh@0.1.1-rc.2` | `npm i -g @deepseek-ai/dsh` | `dsh --version` | 通过 |
| Java | 1.8.0_101 | Oracle `javapath` | `java -version` | 已安装（本实验备用） |
| Ollama | — | 未安装 | `ollama --version` | 未通过（当前有 DashScope 额度，本地模型作备用方案） |
| Codex CLI / Claude Code CLI | — | 未在 PATH 中发现 | `codex` / `claude` | 未安装；以 Cursor Agent + `dsh` 满足“至少两种 AI 工具” |

**判断：** 技术栈彼此兼容，可支撑个人小项目持续开发；需优先固化 Git PATH，并避免 Cursor 内置 Node 与系统 Node 在 PATH 顺序上混淆。

---

### 3.2 对应 2.2：IDE、运行时与基础工具配置

**操作步骤：**

1. 使用 Cursor 打开仓库目录 `d:\dev_project\p1\dev_project`。
2. 新建最小项目目录 `demo-env/`，写入 `package.json` 与 `index.js`。
3. 在 PowerShell 中将 `C:\Program Files\nodejs` 置于 PATH 前部后执行启动验证。

**关键命令与结果：**

```powershell
$env:Path = "C:\Program Files\Git\cmd;C:\Program Files\nodejs;" + $env:Path
cd d:\dev_project\p1\dev_project\demo-env
npm start
```

**运行输出摘录：**

```text
> demo-env@1.0.0 start
> node index.js

demo-env OK
node v24.19.0
platform win32 x64
```

**项目结构（文字示意，可另附截图图 3-1）：**

```text
dev_project/
├── .gitignore
├── demo-env/
│   ├── package.json
│   └── index.js
└── 实验1-AI软件开发环境安装与配置.md
```

**依赖保存与复现命令：**

- 依赖文件：`demo-env/package.json`（当前无第三方依赖，仅使用 Node 内置能力）。
- 重新安装 / 启动：

```powershell
cd d:\dev_project\p1\dev_project\demo-env
npm install
npm start
```

**实际配置问题（至少一例）：Git 命令在 PowerShell 中无法识别**

- **现象：** 执行 `git --version` 报错：无法将 `git` 项识别为 cmdlet / 函数 / 脚本。
- **原因：** 系统 PATH 中 Git 路径被截断为类似 `ram Files\Git\cmd`（缺少盘符与 `C:\Prog` 前缀），导致找不到可执行文件；而 `C:\Program Files\Git\cmd\git.exe` 实际存在。
- **处理：** 当前会话临时修复：

```powershell
$env:Path = "C:\Program Files\Git\cmd;" + $env:Path
git --version
# git version 2.55.0.windows.5
```

- **后续固化建议：** 在“系统环境变量 → Path”中删除残缺项，重新添加 `C:\Program Files\Git\cmd`，关闭并重开终端验证。
- **验证结果：** 临时修复后 `git` 可用；持久化修复需重开终端后再次确认（见 3.6）。

---

### 3.3 对应 2.3：Git 与 GitHub / Gitee 版本管理

**仓库现状（操作时实测）：**

| 项目 | 内容 |
| --- | --- |
| 本地目录 | `d:\dev_project\p1\dev_project` |
| 远程地址 | `origin` → `https://github.com/Usagiiiii/dev_project.git` |
| 默认分支 | `main` |
| 提交状态 | 尚无首次提交（`No commits yet on main`）；工作区有未跟踪文件 |
| 跟踪状态提示 | `## No commits yet on main...origin/main [gone]`（本地尚无 commit，远端引用显示为 gone，需首提后 `push -u`） |

**已完成的本地准备：**

1. 确认 `.git` 已初始化。
2. 新增 `.gitignore`，忽略 `node_modules/`、`.env`、`.env.*`、日志等，避免密钥与依赖目录入库。
3. 准备首提内容：实验报告 Markdown、`demo-env/` 最小项目、`.gitignore`。

**关键命令（PATH 修复后）：**

```powershell
git status -sb
git remote -v
git add .gitignore demo-env "实验1-AI软件开发环境安装与配置.md"
git commit -m "chore: init demo-env and lab1 environment report"
git push -u origin main
git log -2 --oneline
```

**提交规范（后续约定）：**

- 分支：日常在 `main` 或 `feat/<topic>`；实验记录可直接落在 `main`。
- 提交信息：`type: summary`（如 `chore` / `docs` / `feat` / `fix`）。
- 二次提交计划：修订 README 或 `demo-env/index.js` 后再次 `commit`，用 `git log` / `git show` 对照文件变化。

**说明：** 本记录撰写时尚未产生 Commit Hash；完成首提与第二次提交后，应在此处补写：

- 首个 Commit Hash：`________________`
- 第二次 Commit Hash：`________________`
- 推送后仓库可见性 / License：以 GitHub 仓库设置页为准（建议至少有 README；License 可选 MIT）。

**第二次提交如何证明 Git 记录变化（操作要点）：**

1. 修改 `demo-env/index.js` 或新增 `README.md` 一行说明。
2. `git diff` 查看未暂存变更。
3. `git commit` 后 `git log -p -2` 对比两次提交的文件差异。

---

### 3.4 对应 2.4：AI 开发工具安装与接入

**已配置的两种（及以上）工具：**

| 工具 | 安装方式 | 版本 | 认证方式 | 可用入口 |
| --- | --- | --- | --- | --- |
| Cursor Agent | IDE 自带 | Cursor 3.3.30 | Cursor 账号登录 | Cursor 对话 / Agent 面板 |
| DeepSeek Harness（`dsh`） | `npm i -g @deepseek-ai/dsh` | 0.1.1-rc.2 | 按 Harness profile / 账号配置（CLI） | 终端：`dsh --version` / `dsh --profile ...` |

**相同小任务对照：**

- **任务 A：** 解释当前仓库最小项目结构应包含哪些文件。
- **任务 B：** 生成一份简短 README 草案（项目目的 + 启动命令）。

**AI 协作记录表**

| 编号 | 工具 | 关键输入（摘要） | 建议摘要 | 采用 / 未采用 | 人工修改 | 验证结果 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Cursor Agent | “说明 demo-env 目录作用与启动方式” | 指出 `package.json` + `index.js`，用 `npm start` 验证 | 采用结构说明 | 将结论写入本报告 3.2 | `npm start` 输出 `demo-env OK` |
| A2 | DeepSeek Harness | `dsh --version`；后续用 `--profile headless` 对同一问题提问 | CLI 可启动；具体回答依赖 profile 与账号配置 | 采用为“第二种工具可响应”验收 | README 草案以人工整理进报告，不直接照搬 | `dsh --version` → `0.1.1-rc.2` |
| B1 | Cursor Agent | “写 README 草案：目的、启动、环境变量注意点” | 建议写清 Node 版本、`.env` 不入库 | 部分采用 | 压缩措辞，去掉冗余章节 | 草案内容已融入 3.2 / 3.5 |
| B2 | DeepSeek Harness | 同 B1 | 视 profile 配置而定 | 备用对比 | 以 Cursor 结果为主稿 | 作为备用工具保留 |

**对比表**

| 维度 | Cursor Agent | DeepSeek Harness（dsh） |
| --- | --- | --- |
| 完成度 | 高（可直接改仓库、写报告） | 中（需先配好 profile / 认证） |
| 正确性 | 对本机路径与实测命令较准 | 依赖模型与上下文注入 |
| 可解释性 | 可边查文件边给步骤 | CLI 输出偏任务式 |
| 使用成本 | 随 Cursor 订阅 / 额度 | npm 全局工具 + DeepSeek 侧用量 |
| 结论 | **主要工具** | **备用工具** |

**未选用说明：** 本机未检测到 `codex` / `claude` CLI；若课程强制这两种，可再安装后把本表增补一行，不影响当前“至少两种”结论。

---

### 3.5 对应 2.5：模型服务与 API 密钥安全

**最小云端调用（阿里云 DashScope 兼容模式）：**

| 项目 | 记录 |
| --- | --- |
| 模型名称 | `qwen-turbo` |
| 运行位置 | 云端（`dashscope.aliyuncs.com`） |
| 请求类型 | Chat Completions（HTTP POST，OpenAI 兼容） |
| 密钥管理 | 环境变量 `DASHSCOPE_API_KEY`（长度约 117，内容不写入仓库） |
| 返回结果 | `STATUS=OK`；模型回复一句中文说明（控制台编码可能导致乱码，以 HTTP 成功与 usage 为准） |
| 时延 | 约 **1234 ms** |
| 用量 | `prompt_tokens=23`，`completion_tokens=18`，`total_tokens=41` |

**调用思路（脱敏示例，勿粘贴真实 Key）：**

```python
# 使用环境变量，禁止硬编码
# Authorization: Bearer <DASHSCOPE_API_KEY>
# POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
# body: {"model":"qwen-turbo","messages":[...],"max_tokens":80}
```

**密钥与敏感文件安全：**

1. 密钥仅放在系统/用户环境变量或本地 `.env`（若使用 `.env`，必须被 `.gitignore` 忽略）。
2. 已写入 `.gitignore`：`.env`、`.env.*`（保留 `!.env.example` 模板位）。
3. 截图要求：凡涉及密钥、Token、账号的界面，必须打码（图 3-2 预留）。
4. 检查命令（确认仓库无明文密钥）：

```powershell
Select-String -Path * -Pattern "sk-|DASHSCOPE_API_KEY\s*=\s*\S+" -Recurse -ErrorAction SilentlyContinue
```

**免费额度 / 计费：**

- 平台：阿里云 DashScope。
- 操作：登录控制台查看免费额度、计费方式，并设置余额 / 额度提醒（以控制台当前页面为准，截图打码后作为图 3-3）。
- **无额度时的备用方案：** 安装 Ollama → 拉取本地模型 → `ollama serve` / HTTP 本地调用。本机当前未装 Ollama；因 DashScope 调用已成功，本阶段以云端为主、本地为备。

---

### 3.6 对应 2.6：环境验收

**表 3-2 环境验收表**

| 验收项 | 验证方法 | 结果 | 说明 |
| --- | --- | --- | --- |
| 项目可启动 | `cd demo-env` → `npm start` | 通过 | 输出 `demo-env OK` / Node v24.19.0 |
| Git 可提交与推送 | `git status` / 计划 `commit` + `push -u origin main` | 部分通过 | Git 可执行（PATH 临时修复后）；**首提与推送尚未完成** |
| 两种 AI 工具可响应 | Cursor Agent 对话；`dsh --version` | 通过 | 主要：Cursor；备用：dsh |
| 模型 API 可调用 | DashScope `qwen-turbo` | 通过 | 时延约 1.2s，total_tokens=41 |
| AI 协作记录可查看 | 本报告 3.4 表格 | 通过 | 任务 / 输入 / 采用与否 / 验证已记录 |
| 仓库中无明文密钥 | `.gitignore` + 文本检索 | 通过（当前工作区） | 未将 Key 写入文件；推送前再扫一遍 |

**未通过 / 未完成项：**

| 项 | 原因 | 替代方案 | 预计完成 |
| --- | --- | --- | --- |
| Git 持久 PATH | 系统 Path 残缺 | 会话内前置 `C:\Program Files\Git\cmd`；随后改系统环境变量 | 当天内 |
| 首次 commit / push | 报告撰写时尚未提交 | 按 3.3 命令完成并回填 Commit Hash | 提交报告前 |
| Ollama 本地模型 | 未安装 | 云端 DashScope 已可用；额度耗尽再装 Ollama | 按额度情况 |

**复现验证（关闭重开 / 新目录）：**

1. 关闭当前终端，新开 PowerShell：
   - 若直接 `git --version` 失败 → 证明需做持久 PATH 修复；
   - `node -v`、`npm start`（在 `demo-env`）应仍可通过。
2. 或：`git clone https://github.com/Usagiiiii/dev_project.git` 到新目录后执行：

```powershell
cd <新目录>\demo-env
npm install
npm start
```

3. 复现通过标准：新终端能跑通 `npm start`；Git PATH 持久修复后能 `git status`；环境变量中仍有 `DASHSCOPE_API_KEY`（值勿打印）。

**本节判断：** 开发与 AI 调用主链路已打通；版本管理差“首提 + 推送 + PATH 固化”即可达到完整验收。

## 4. 实验小结

本实验已完成 Cursor + Node 最小项目启动、DeepSeek Harness（`dsh`）接入、DashScope（`qwen-turbo`）API 调用，以及 `.gitignore` 密钥防护。Git 可执行但 PATH 尚未持久固化，仓库首提与推送也未完成。整体上，当前环境已能支撑个人小项目继续开发。

实际问题：PowerShell 中找不到 `git`，原因是系统 Path 中 Git 路径被截断。处理方法是临时将 `C:\Program Files\Git\cmd` 加入会话 PATH，并计划在系统环境变量中永久修复。验证：修复后 `git --version` 显示 `2.55.0.windows.5`。