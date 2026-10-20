# 实验5：LLM、Context 与 RAG 实现说明

- 项目：AI冰箱食材寿命匹配器（fridge-matcher）
- 范围：本次实现「原版」——LLM 接口（**已接入真实 API**：mock 占位 + `LLM_MODE=api` 时调用千问兼容接口，实测 qwen-plus）、Prompt 原版 V1、知识库与切分、关键词检索、RAG 最小链路、对比测试框架
- 运行环境：Node.js ≥ 22.5，零第三方依赖（复用实验4 工程骨架；API 调用使用 Node 内置 fetch）

---

## 1. 实验任务与对应用户故事

本实验选择的知识问答任务是：**根据冰箱现有库存与用户偏好，回答"能做什么菜"并生成可执行的料理方案**。

对应个人软件用户故事：

| 用户故事 | 内容 | 本实验落地点 |
| --- | --- | --- |
| US-02 | 输入口味、烹饪时间和用餐人数，获得符合当前条件的料理方案 | RAG 回答中的库存与偏好上下文 |
| US-03 | 说明方案会消耗哪些库存，判断推荐是否有助于清理冰箱 | RAG 回答中的 used_items 与库存白名单校验 |
| US-07 | AI 不可用时仍能获得基础处理建议 | 模型调用失败的降级返回（LLM_TIMEOUT 等） |

---

## 2. LLM 调用与输出格式（2.1）

### 2.1 LLM 接口设计（mock 占位 + 真实 API 接入）

按任务要求，LLM 以「调用 API」方式接入云端模型；开发阶段用 mock 占位跑通链路。实现见 `src/services/modelClient.js`：

- 统一调用契约 `callLLM({ messages, temperature, maxTokens, timeoutMs, mock })`，对外屏蔽模型来源；
- 模式由环境变量 `LLM_MODE` 控制（默认 `mock`）：
  - `mock`：占位实现，返回可配置的模拟结果，用于跑通 RAG 链路、输出校验与失败处理；
  - `api`：**已实现真实 HTTP 请求**——`fetch(apiUrl)` + Bearer Token + messages 数组，超时用 `AbortSignal.timeout`；未配置 `LLM_API_URL / LLM_API_KEY / LLM_MODEL` 时明确报错 `LLM_NOT_CONFIGURED`。
- 配置读取：零依赖加载器按「进程环境变量 > 项目根目录 `.env`」优先级加载（`.env` 已被 `.gitignore` 忽略，模板见 `.env.example`）。
- 实测模型：千问 OpenAI 兼容接口（`https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions`，URL 必须带 `/chat/completions` 路径），模型 `qwen-plus`，单次 RAG 问答约 2~9 秒；期间发现推理模型（qwen3.8-flash）对完整 RAG prompt 推理可达 40s~120s+，故默认超时设为 120s，并建议优先使用非推理模型。

返回统一结构：`{ model, mode, text, usage }`，其中 `usage` 含 Token 估算（按 1 汉字 ≈ 1 token 的简化口径，标注为估算值）。

### 2.2 输出格式

要求模型输出严格 JSON，结构固定（与实验3 设计一致）：

```json
{
  "title": "方案名",
  "reason": "推荐理由",
  "cooking_minutes": 15,
  "used_items": [{"name": "食材名", "quantity": 1, "unit": "个"}],
  "required_purchases": [],
  "optional_purchases": [],
  "steps": ["步骤1", "步骤2"],
  "references": ["KB-07"]
}
```

信息不足时输出 `{"error":"CODE","message":"说明"}`。

### 2.3 失败处理测试（连接失败/超时）

| 场景 | 触发方式 | 返回 |
| --- | --- | --- |
| 服务不可用 | `mock: { mode: 'error' }` | `LLM_SERVICE_UNAVAILABLE` |
| 超时 | `mock: { mode: 'timeout' }` | `LLM_TIMEOUT` |
| API 未配置 | `LLM_MODE=api` 且无密钥 | `LLM_NOT_CONFIGURED` |
| API HTTP 错误 | 接口返回非 2xx | `LLM_HTTP_ERROR` |
| 网络错误 | 连接失败/中断 | `LLM_NETWORK_ERROR` |
| 响应格式错误 | 非 JSON / 缺字段 | `LLM_BAD_RESPONSE` |

失败时 RAG 服务返回降级结果 `{ ok:false, fallback:'model_unavailable', issues:[...] }`，不崩溃、不返回伪造回答。对应测试：`LLM-02/03/04`、`RAG-03`。真实 API 调用还记录 `usage`（模型返回的 prompt_tokens / completion_tokens）。

---

## 3. Prompt 与上下文组织（2.2）—— 原版 V1

### 3.1 模板结构

实现见 `src/services/promptTemplates.js`，版本标记 `PROMPT_VERSION = 'v1'`。

- **系统消息**：角色定位 + 硬性规则（不虚构库存、过敏硬排除、临期优先）+ 严格 JSON 格式 + 信息不足处理；
- **用户消息（直接组）**：用户问题 + 库存清单 + 用户偏好；
- **用户消息（RAG 组）**：在直接组基础上追加「知识库资料」块，每条带编号 `[KB-xx]`、来源、内容与相关性得分，并要求在 `references` 中引用编号。

### 3.2 实际发送的完整输入（RAG 组示例，已截断）

```
【系统】你是「AI冰箱食材寿命匹配器」的料理助手……
硬性规则：1. 只能使用「库存清单」中列出的食材……禁止虚构……
4. 必须输出严格 JSON……
6. 若提供了「知识库资料」，必须依据资料回答，并在 references 中列出实际用到的资料编号……

【用户问题】番茄和鸡蛋能做什么家常菜？

【库存清单】（只能使用以下食材）
- 青菜：1把，剩余约 1 天（寿命等级：critical）
- 鸡蛋：6枚，剩余约 8 天（寿命等级：ok）
- 番茄：4个，剩余约 5 天（寿命等级：ok）
……

【用户偏好】
口味：清淡；人数：1；最长烹饪时间：20 分钟
过敏/忌口：花生；仅使用现有库存：否；最大补购数：2

【知识库资料】（依据这些资料回答，并在回答中引用编号）
[KB-07] 番茄炒蛋的做法
来源：自建整理：家庭烹饪与食材储存通用常识
内容：番茄炒蛋是常见家常菜……
（相关性得分：8.274，命中特征：番茄、鸡蛋、家常、常菜）
```

### 3.3 上下文工程

- 长度统计：`buildMessages` 返回 `context_chars`（字符数）与 `prompt_tokens_estimate`（Token 估算）。示例 RAG 组上下文约 1414 字符 / 884 Token 估算。
- 无关/重复检查：`auditContext` 检查①问题未直接命中库存食材名时提示可精简库存上下文；②检索片段重复时提示去重。默认发送"问题 + 库存 + 偏好 [+ 检索资料]"，按需精简。

### 3.4 原版与修改版说明

实验5 要求"根据测试结果修改至少一次 Prompt，记录原版本、修改原因、修改内容和结果变化"。**原版 V1 已实现并完成真实对比测试；修改版 V2 已基于对比测试结果实现**（`promptTemplates.js` 中 `buildSystemPromptV1` / `buildSystemPromptV2`，`buildMessages(..., version)` 切换，默认 V2）。

**V1 → V2 修改记录**：

| 修改点 | 修改原因（V1 实测问题） | 修改内容 | 结果变化（真实模型 qwen-plus 对比） |
| --- | --- | --- | --- |
| 错误码枚举化 | V1 的 `"error":"CODE"` 占位符被模型照抄为字面值（Q4/Q5/Q6 输出 "CODE:"） | V2 规则 6 定义三种枚举错误码 `NO_INVENTORY` / `INSUFFICIENT_STOCK` / `OUT_OF_SCOPE` 并说明适用场景 | V2 全部错误场景使用枚举码，不再出现 "CODE" |
| 禁止无资料编造引用 | V1 直接组无资料时模型照抄 system 示例编号（Q1/Q2 幻觉引用 KB-01/KB-06） | V2 规则 8：未提供资料时不得在 references 编造 KB 编号，可省略该字段 | V2 直接组 Q1/Q2 正确输出无引用（[—]），幻觉引用消除 |
| 开放式问题处理 | V1 下开放式问题（Q5"怎样减少浪费"）模型过于严格拒绝 | V2 规则 9：开放式问题可基于资料输出 JSON 形式的原则性建议（title/steps/references） | V2 RAG 组 Q5 给出"临期食材优先消耗法 [KB-10]"，由拒绝变为可答 |
| 过期食材禁用 | V1 仅"临期优先"；过期样例下模型自行推断拒绝（不一致） | V2 规则 3 显式：寿命等级 expired（已过期）的食材不得用于方案 | 过期库存下模型一致、明确地拒绝（实测"按规则3禁止使用expired食材"） |
| 步骤条数与用量 | V1 未约束步骤数量与用量 | V2 规则 5：steps 3~5 条可执行；用量参考人数（人数越多用量越大） | 输出步骤数稳定在 3~5 条，用量与 1 人份匹配 |
| JSON 边界 | V1 "只输出 JSON"遵守不稳（模型输出前后缀文字） | V2 规则 4：首行必须 `{`、末行必须 `}`，禁止任何前后缀/代码块 | 配合 guard 的 `{}` 提取容错，真实输出均成功解析 |

**V1 vs V2 对比测试摘要（同库存、同模型 qwen-plus）**：见第 6.3 节；V2 完整结果见 `data/rag-compare-result-v2.json`。

**已知的 V2 局限**：Q5 直接组（无资料）模型尝试给建议但 `used_items` 为空被校验拦截；Q4 安全判断类问题模型使用 `OUT_OF_SCOPE` 错误码但实际给出了判断，错误码语义与内容不完全一致（判断类问题与开放式问题边界还需细化）。

---

## 4. 知识库与切分策略（2.3）

### 4.1 资料选择与来源

知识库 `data/knowledge_base.json` 共 **12 条**，主题覆盖本项目核心领域：食材储存与保鲜（KB-01~05）、家常料理做法（KB-06~08）、食品安全（KB-09）、库存管理原则（KB-10~12）。

- **来源**：全部为项目自建整理（"家庭烹饪与食材储存通用常识"），标注于每条 `source` 字段；不含第三方版权内容；
- **使用权限/隐私**：知识库不含任何用户个人数据；向模型发送前仅选取与本问题相关的 Top-k 片段（最小化发送原则），隐私处理方式见文件 `_meta.privacy_note`。

### 4.2 切分策略

- **按条目切分**：每个 chunk 本身就是一条独立资料，不做跨条目切分，相邻片段之间**无重叠**；
- 片段元数据：`id / title / source / tags / content / content_len（字符数）/ doc_text（检索用）`；
- 资料更新方法：直接编辑 `knowledge_base.json` 增删条目即可，服务启动时重新加载。

### 4.3 抽查片段（3 个）

| 编号 | 标题 | 来源 | 字符数 | 关键语句完整性 |
| --- | --- | --- | --- | --- |
| KB-01 | 青菜等绿叶菜的保鲜 | 自建整理 | 96 | 完整：储存方式、期限、建议优先食用 |
| KB-06 | 青菜蛋花汤的做法 | 自建整理 | 86 | 完整：主料、步骤、适用场景 |
| KB-09 | 变质食材的判断与安全 | 自建整理 | 84 | 完整：变质特征、处理方式、安全原则 |

抽查结论：关键语句完整、来源对应原条目、无乱码与重复（对应测试 `KB-02`）。

---

## 5. 检索与 RAG 最小链路（2.4）

### 5.1 检索方法选择

实现见 `src/services/retrieval.js`：**中文 2-gram 特征 + 简化 BM25 关键词检索**。

选择理由：
1. 项目坚持零第三方依赖，纯 JS 确定性实现便于解释与测试；
2. 知识库仅 12 条，BM25 线性打分即可满足性能；
3. 向量检索依赖 embedding 模型，与"LLM 接口先空出来"的策略一致，后续接入 API 后可扩展（预留说明）。

检索流程：
1. 查询与文档统一做 2-gram 特征化，去除停用词（功能词如"做法/适合/怎么/什么"）；
2. **领域过滤**：查询特征必须命中知识库领域词表（tags 并集 + 标题有效 2-gram），否则视为"无相关资料"，直接返回空——避免"佛跳墙的做法""明天天气"等无关查询误命中；
3. BM25 打分（tf、idf、长度归一化，k1=1.5, b=0.75），按得分降序取 Top-k；
4. 返回片段附命中特征与得分，作为**排序依据（可解释）**。

### 5.2 一次查询的完整记录

问题："番茄和鸡蛋能做什么家常菜？"（k=3）

| 排名 | 片段 | 得分 | 命中特征 |
| --- | --- | --- | --- |
| 1 | KB-07 番茄炒蛋的做法 | 8.274 | 番茄、鸡蛋、家常、常菜 |
| 2 | KB-11 家常食材搭配原则 | 4.763 | 番茄、鸡蛋、家常 |
| 3 | KB-06 青菜蛋花汤的做法 | 2.996 | 鸡蛋、家常 |

无相关资料时（如"教我做佛跳墙的做法"）检索返回空，RAG 层明确返回 `INSUFFICIENT_DOCS`，不编造（对应测试 `RET-04`、`RAG-05`）。

### 5.3 最小链路

```
问题输入 → 检索（BM25 Top-k）→ 上下文组织（库存+偏好+检索片段）
        → 模型调用（LLM_MODE=api 时真实调用千问 qwen-plus）→ 输出校验（白名单/过敏/引用/格式）→ 回答返回
```

实现见 `src/services/ragService.js` 的 `ask()`。输出校验见 `src/services/ragGuard.js`：
- **库存白名单**：`used_items` 食材名必须真实存在于库存（拦截虚构库存，`FABRICATED_INVENTORY`）；
- **过敏硬拦截**：涉及过敏食材直接拦截（`ALLERGEN_CONFLICT`）；
- **引用校验**：`references` 必须是知识库真实编号（`INVALID_REFERENCE`）；
- **格式校验**：必须为可解析 JSON 且含 `title/steps/used_items`（`INVALID_JSON / INVALID_FORMAT`）。

链路一次运行实测（CLI，真实 API / qwen-plus）：检索 7ms 内完成，模型调用约 2~9 秒，回答带 `references: ["KB-07"]`，全部通过校验（见 6.2 真实结果）。

---

## 6. 对比测试与质量分析（2.5）

固定问题集共 **7 个**（定义于 `scripts/rag-compare.js`），覆盖：单片段可答（Q1-Q3）、安全类（Q4）、多片段综合（Q5）、资料无答案（Q6）、超出范围（Q7）。

两组使用相同问题、相同模型（`LLM_MODE=api` 时为真实模型 qwen-plus，否则 mock）、相同主要参数（temperature=0.3, maxTokens=800）与相同输出格式；差异仅在于 **RAG 组注入检索资料并要求引用来源，直接组不提供资料**。每次测试独立上下文。

### 6.1 测试结果（真实 API：千问 qwen-plus，14 次调用全部成功）

| 编号 | 类型 | 直接组回答 | 直接组引用 | RAG组回答 | RAG组引用 | 检索片段 |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | 单片段可答 | 青菜豆腐蛋花汤 | KB-06（无资料支撑） | 青菜蛋花汤 | KB-06 | KB-06,KB-01,KB-11 |
| Q2 | 单片段可答 | 番茄炒蛋 | KB-01（幻觉引用） | 番茄炒蛋 | KB-07 | KB-07,KB-11,KB-06 |
| Q3 | 单片段可答 | 番茄豆腐蒸蛋 | — | 姜香煎豆腐配青菜 | KB-08,KB-04,KB-11 | KB-08,KB-04,KB-11 |
| Q4 | 安全类 | 拒绝（CODE：超出任务范围） | — | 异味/发黏属变质，不应食用 | —（内容引 KB-09） | KB-09,KB-10,KB-04 |
| Q5 | 多片段综合 | 拒绝（CODE：开放式问题） | — | 拒绝（引用 KB-10/09/12 说明无菜谱） | — | KB-10,KB-09,KB-12 |
| Q6 | 资料无答案 | 拒绝（CODE：天气未提供） | — | 拒绝（天气未提供） | — | 空 |
| Q7 | 超出范围 | 拒绝（INSUFFICIENT_STOCK） | — | 拒绝（INSUFFICIENT_STOCK） | — | 空 |

（结构化结果保存于 `data/rag-compare-result.json`，含每问耗时与已填写的人工判断列。）

### 6.2 真实模型对比分析（V1 原版）

- **RAG 组引用可靠**：Q1/Q2/Q3 均引用真实检索片段（KB-06/07/08），与期望一致；Q4 安全类能依据 KB-09 给出"异味发黏不可食用"的正确判断——**没有资料时（直接组）模型直接拒绝，有了资料才能回答**，正是 RAG 注入的价值；
- **直接组出现幻觉引用**：Q1 引 KB-06、Q2 引 KB-01——直接组 Prompt 不含任何知识库资料，模型输出的编号全部来自 system 示例的照抄，属于**无资料支撑的编造引用**；RAG 组的真实资料注入有效抑制了该现象；
- **拒绝类问题（Q5/Q6/Q7）两组均不编造**，正确返回资料不足/库存不足提示；Q5 模型对开放式问题过于严格（拒绝给出原则性建议），是 V1 的已知局限；
- **性能**：14 次调用全部成功，单问 0.8~8s，无超时无崩溃；失败处理与 JSON 容错（自然语言包裹中提取 JSON）在真实模型下验证有效；
- 暴露的 Prompt V1 问题（已由 V2 解决）：① 错误模板占位符 `"error":"CODE"` 被模型照抄为字面值；② 开放式问题应允许输出基于资料的原则性建议；③ 直接组无资料时模型仍会编造引用编号。
- mock 模式的确定性结果仍记录于提交历史（commit 043113d），真实结果已覆盖 `data/rag-compare-result.json`（`mode: "api:qwen-plus"`，V1）。

### 6.3 V2 修改版对比结果（同库存、同模型 qwen-plus，14 次调用全部成功）

| 编号 | 类型 | 直接组回答（V2） | 直接组引用 | RAG组回答（V2） | RAG组引用 | 相对 V1 的变化 |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | 单片段可答 | 青菜豆腐蛋花汤 | — | 青菜蛋花汤 | KB-06 | 直接组幻觉引用消除 |
| Q2 | 单片段可答 | 番茄炒蛋 | — | 番茄炒蛋 | KB-07,KB-11 | 直接组幻觉引用消除 |
| Q3 | 单片段可答 | 番茄豆腐蒸蛋 | — | 姜香煎豆腐配青菜 | KB-08,KB-11 | 引用更精简（少 KB-04） |
| Q4 | 安全类 | OUT_OF_SCOPE + "不可食用"建议 | — | OUT_OF_SCOPE + 依据 KB-09 判变质 | —（内容引 KB-09） | 错误码枚举化；结论正确 |
| Q5 | 多片段综合 | 有建议但 used_items 空被拦截 | — | 临期食材优先消耗法 | KB-10 | **RAG 组由拒绝变为可答**（规则9） |
| Q6 | 资料无答案 | OUT_OF_SCOPE（不编造） | — | OUT_OF_SCOPE | — | 错误码枚举化 |
| Q7 | 超出范围 | OUT_OF_SCOPE | — | OUT_OF_SCOPE | — | 分类更准确（V1 为 INSUFFICIENT_STOCK） |

**V1 → V2 改进验证（真实模型）**：
1. 错误码枚举化生效：所有错误场景输出 `NO_INVENTORY / INSUFFICIENT_STOCK / OUT_OF_SCOPE`，V1 的 "CODE" 字面值问题消失；
2. 直接组幻觉引用消除：Q1/Q2 V1 编造 KB-01/KB-06，V2 正确输出无引用（规则 8）；
3. 开放式问题可答：Q5 RAG 组 V1 拒绝 → V2 给出"临期食材优先消耗法 [KB-10]"（规则 9）；
4. 过期食材规则显式化：过期库存变体测试中模型一致明确拒绝（"按规则 3 禁止使用 expired 食材"）；
5. 已知局限：Q5 直接组有建议但格式未达标（used_items 空被 guard 拦截）；Q4 判断类问题错误码用 `OUT_OF_SCOPE` 但实际给出了判断，语义边界待细化。

（V2 完整结果见 `data/rag-compare-result-v2.json`，含人工判断列。）

---

## 7. 模块调用与后续使用（2.6）

### 7.1 模块与入口

| 路径 | 职责 | 依赖 |
| --- | --- | --- |
| `data/knowledge_base.json` | 知识库（12 条） | 无 |
| `src/services/knowledgeBase.js` | 加载、切分、抽查、统计 | 无 |
| `src/services/retrieval.js` | 2-gram + BM25 关键词检索 | knowledgeBase |
| `src/services/modelClient.js` | LLM 接口（mock 占位 + 真实 API fetch 调用） | 无 |
| `src/services/promptTemplates.js` | Prompt V1 原版 / V2 修改版、上下文组装 | modelClient |
| `src/services/ragGuard.js` | 输出校验（白名单/过敏/引用/格式） | knowledgeBase |
| `src/services/ragService.js` | RAG 最小链路 `ask()` | 上述全部 + inventory/preference |
| `src/routes/rag.js` | HTTP 入口 | ragService |
| `scripts/rag-demo.js` | 命令行入口 | ragService |
| `scripts/rag-compare.js` | 对比测试脚本 | ragService |

### 7.2 调用方式

```bash
npm run rag -- "冰箱里有青菜和鸡蛋，能做什么菜？"      # 命令行 RAG 演示
npm run rag -- "番茄和鸡蛋能做什么？" --no-rag        # 直接模型组
npm run rag-compare                                  # 7 问两组对比，输出表格 + JSON
npm test                                             # 全量测试（原 8 + RAG 20）
```

HTTP 接口：
- `POST /api/rag/ask`，请求体 `{ "question": "...", "use_rag": true, "top_k": 3 }`
- `GET /api/rag/kb`（知识库概览，供抽查）

### 7.3 输入/输出与失败返回

- 输入：问题文本（必填，非空），可选 `use_rag / top_k / mock`；
- 输出：`{ question, source:'rag'|'direct', model, answer, chunks, prompt, usage, audit, elapsed_ms }`；
- 失败返回：模型超时/不可用 → `{ ok:false, fallback:'model_unavailable', error:{code,message} }`；输出未通过校验 → `answer:null` + `guard_issues`。

### 7.4 知识库准备方法

编辑 `data/knowledge_base.json`，在 `chunks` 数组中按现有结构新增条目（id 连续编号、提供 title/source/tags/content），重启服务即生效；条目数量与字符数可通过 `GET /api/rag/kb` 或 CLI 查看。

---

## 8. 结论：个人软件是否继续使用 RAG

**继续使用，理由**：
1. RAG 的"依据资料回答 + 来源引用"与本项目"可解释结果"的设计目标一致（实验2 差异化第 5 条）；
2. 输出校验层（库存白名单、过敏拦截）已就绪，可有效约束模型幻觉，正是 RAG 落地所需的安全底座；
3. 知识库可随菜品/食材资料扩充，回答质量随资料增长而提升。

拟接入的功能：将 RAG 回答接入现有"生成今天方案"接口，作为 `source:'ai'` 的方案来源，与现有 `rule_fallback` 形成"AI 主生成 + 规则兜底"双通道。

---

## 9. 当前局限与下一步改进

| 局限 | 说明 | 下一步计划 |
| --- | --- | --- |
| ~~LLM 未接入~~ | **已完成**：真实 API（千问 qwen-plus）实测通过 | 可在 .env 切换模型 / 增加流式输出 |
| 推理模型过慢 | 曾用 qwen3.8-flash（推理模型）完整 RAG prompt 达 40s~120s+ | 优先使用非推理模型（qwen-plus 实测 2~9s） |
| 检索仅关键词 | 2-gram + BM25 无法处理同义/语义相似 | 接入 embedding 向量检索，关键词 + 向量混合排序 |
| Prompt 仅原版 | ~~V1 未包含"资料不足"等场景的显式指令~~ | **已完成 V2**：错误码枚举化/禁止无资料编造引用/开放式问题处理/过期食材禁用/steps 约束（见 3.4、6.3） |
| 知识库规模小 | 12 条仅覆盖核心食材 | 扩充至 30-50 条并加入更新机制 |
| ~~对比测试为 mock~~ | **已完成**：qwen-plus 真实重跑 7 问×2 组，人工判断列已填 | 换模型后可按需重跑 |
