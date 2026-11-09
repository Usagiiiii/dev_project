# 实验6：工具调用、Agent与Harness实现

## 学习通提交说明

- **提交平台：** 只向学习通对应的作业上传一份PDF文件。
- **文件命名：** 班级-学号-姓名-实验6-工具调用、Agent与Harness实现.pdf。
- **PDF内容：** 任务说明、工具接口、Agent、Harness、执行日志和实验小结，附仓库链接与Commit。
- **截止时间：** 以学习通作业设置为准。
- **本文件为结果填写版**：工具、Agent、Harness、测试均已实现并完成真实模型（qwen-plus）运行验证，详见下文。

## 1. 实验目的

- 掌握工具接口定义、参数验证、权限边界和结果反馈。
- 实现一个由模型根据任务和工具结果决定下一步操作、运行状态可查看且能够终止的单Agent。
- 编写运行时Harness，完成上下文组织、工具执行、结果检查、停止控制和日志记录。

## 2. 实验内容

### 2.1 任务选择与边界

**任务目标（结合个人软件 fridge-matcher 选定）**：用户以自然语言提出目标（如"用冰箱里的临期食材做今晚的菜，并记录消耗"），Agent 自主决定调用哪些工具获取信息，最终输出可执行的料理方案，并（经用户确认后）记录方案对库存的消耗。

| 项目 | 内容 |
| --- | --- |
| 任务目标 | 依据冰箱库存与知识库菜谱，生成符合用户偏好（口味/人数/时间/过敏）的料理方案；优先使用临期食材；记录方案消耗的库存（需用户确认） |
| 可用数据 | `ingredients` 表（库存：名称/数量/单位/保质期→剩余天数与寿命等级）、`preferences` 表（口味/人数/时长/过敏）、`knowledge_base.json`（12 条自建菜谱与食材常识） |
| 可用工具 | `query_inventory`（查库存，只读）、`search_recipe`（检索菜谱，只读）、`mark_consumed`（记录消耗并扣减库存，有副作用） |
| 停止条件 | ① 模型输出 final 且程序复核通过；② 达到最大步数（8 步）；③ 超过总运行时限（300s）；④ 模型连续输出无法解析超过重试上限（2 次） |
| 成功标准（程序复核） | S1 final 结构完整（title/steps/used_items）；S2 食材全部真实存在于库存且数量不超；S3 无过敏食材；S4 不使用 expired/needs_confirm 食材；S5 引用编号真实存在；S6 用户同意记录时，实际消耗与方案 used_items 一致 |

**一组输入与预期结果**：

| 输入 | 预期结果 |
| --- | --- |
| "用冰箱里的临期食材做今晚的菜，并记录消耗" | 模型依次调用 query_inventory（看库存与寿命等级）→ search_recipe（检索临期食材能做的菜）→ mark_consumed（提示用户确认后扣减库存）→ 输出 final（如"青菜蛋花汤"，used_items 与消耗记录一致）。实测输出见 2.6 |

**程序预设 vs 模型决定**：

| 环节 | 由谁决定 |
| --- | --- |
| 工具注册表、参数 Schema、权限分级（读自动/写确认/禁止） | 程序预设（Harness/工具层） |
| 最大步数、模型调用超时、总时限、解析重试上限、成功标准 | 程序预设（Harness 强制执行） |
| 是否调用某个工具、工具参数（查什么库存、检索什么食材、消耗哪些） | 模型决定 |
| 何时停止并输出最终方案、方案内容 | 模型决定（但需通过程序复核） |

**操作权限分级**：

| 操作 | 权限 |
| --- | --- |
| query_inventory / search_recipe（只读） | 自动执行，无需确认 |
| mark_consumed（修改库存数据） | 执行前展示操作内容与影响，须用户明确同意；拒绝或等待超时不执行 |
| 执行 shell 命令、删除数据、访问外部网络 | 明确禁止：工具表中根本不注册，模型无法调用（UNKNOWN_TOOL 拦截） |

### 2.2 工具接口与参数约束

实现 3 个可实际运行的工具（位于 `src/services/tools.js`），每个工具声明名称、用途、输入字段（类型/必填）、返回结果与错误信息，即 Schema：

| 工具 | 用途 | 输入 Schema（字段: 类型, 必填, 约束） | 返回 | 错误码示例 |
| --- | --- | --- | --- | --- |
| `query_inventory` | 查询冰箱全部库存（含寿命等级） | 无参数（{}） | `{ok, data:{count, items:[{name,quantity,unit,days_left,life_level,status}]}}` | — |
| `search_recipe` | 按食材检索知识库菜谱（复用实验5 2-gram+BM25） | `ingredients`: array\<string\>, 必填, 1~5 个；`top_k`: number, 可选, 1~5（默认3） | `{ok, data:{results:[{id,title,score,content}]}}` | `INVALID_ARGS` |
| `mark_consumed` | 记录方案消耗食材并扣减库存（复用实验5 `consumeIngredients` 事务） | `items`: array\<object\>, 必填, 1~10 个；每项 `{name: string 必填, quantity: number>0 必填, unit: string 必填}` | `{ok, data:{consumed:[...], remaining:[...]}}` | `INVALID_ARGS` / `ITEM_NOT_FOUND` / `INSUFFICIENT_STOCK` / `USER_REJECTED` / `CONFIRM_REQUIRED` |

**白名单与参数校验**：Harness 维护工具注册表 `TOOL_REGISTRY`，执行前由程序检查：
- **工具名称**：模型输出的 `tool` 字段必须是注册表中存在的名称，否则返回 `UNKNOWN_TOOL`（"不能直接执行模型生成的任意函数名或命令"，模型输出 `delete_food` 等一律被拦截，不可能 eval）；
- **参数 Schema**：手写轻量校验器检查类型、必填、数值范围（如 `top_k ≤ 5`、`quantity > 0`）、数组元素结构与必填子字段；
- **访问范围**：`mark_consumed` 只允许消耗库存中存在的食材（名称+单位解析到库存 id），模型无法绕过校验直接改库；`search_recipe` 只读知识库文件。

**最长等待 / 是否改数据 / 重复调用**：

| 工具 | 最长等待 | 是否修改数据 | 重复调用影响 |
| --- | --- | --- | --- |
| query_inventory | 立即返回 | 否 | 无副作用，可重复 |
| search_recipe | 立即返回 | 否 | 无副作用，可重复 |
| mark_consumed | 确认等待 30s（超时拒绝） | **是**（扣减库存、写 consumption_records） | 重复调用会产生重复扣减；因此①执行前必须人工确认；②工具返回后状态不明时不得盲目重试（见 2.5） |

**接入 Agent 前的工具直测（正确参数与错误参数）**：

| 工具 | 正确参数 | 结果 | 错误参数 | 结果 |
| --- | --- | --- | --- | --- |
| query_inventory | `{}` | 返回 7 项库存（含 life_level） | —（无参契约） | — |
| search_recipe | `{ingredients:["番茄","鸡蛋"],top_k:3}` | 命中 KB-07 番茄炒蛋 | `{ingredients:"番茄"}`（字符串非数组） | `INVALID_ARGS` 拦截 |
| mark_consumed | `{items:[{name:"番茄",quantity:1,unit:"个"}]}` + 确认 | 扣减库存并写消耗记录 | 无确认回调 | `CONFIRM_REQUIRED` 拒绝执行 |

（以上均有自动化测试用例 TOOL-01~06 覆盖，见 2.6。）

### 2.3 Agent循环与状态

**循环图**（接收目标 → 模型提出调用请求 → 程序检查并执行工具 → 回传工具结果 → 模型继续或给出最终回答，标出参数校验、人工确认与停止检查的位置）：

```
                    ┌──────────────────────────────────────────────┐
                    │               运行时 Harness                   │
                    │                                              │
   任务目标 ───────▶ │ ① 构造上下文（system+user+工具结果历史）        │
                    │                                              │
                    │ ② 调用模型（超时 120s）        ◀──────┐        │
                    │      │                                   │    │
                    │      ▼                                   │    │
                    │ ③ 解析输出（tool / final / 非法）          │    │
                    │      │                                   │    │
                    │      ├──非法 JSON ──▶ 回喂错误 ──▶ ②（重试≤2次）│    │
                    │      │                                   │    │
                    │      ▼                                   │    │
                    │ ④ 工具调用分支：                          │    │
                    │    ├─ 白名单检查（UNKNOWN_TOOL 拦截）       │    │
                    │    ├─ 参数 Schema 校验（INVALID_ARGS）      │    │
                    │    ├─ 权限：只读自动 │ 写操作→人工确认闸口 │    │
                    │    │    （拒绝/超时→不执行，USER_REJECTED） │    │
                    │    ├─ 执行工具 → 结果回喂（追加上下文）──────┘    │
                    │    │                                           │
                    │    └──▶ 回到 ②（step+1）                      │
                    │                                               │
                    │ ⑤ final 分支：程序复核成功标准（S1~S6）          │
                    │    └─ 通过→completed │ 不通过→failed           │
                    │                                               │
                    │ 停止检查：step≥maxSteps(8) / 总时限≥300s /      │
                    │          连续解析失败>2 → 强制终止              │
                    └──────────────────────────────────────────────┘
```

**模型接口与调用格式**：接入支持工具调用的千问 qwen-plus（OpenAI 兼容接口，复用实验5 `modelClient.callLLM`），并约定可由程序解析的 **JSON 调用格式**（二选一，禁止前后缀文字）：

- 工具调用请求：`{"tool":"工具名","args":{...}}`
- 最终答案：`{"final":{"title":"...","steps":[...],"used_items":[...],"references":[...]}}`
- 无法完成：`{"final":{"error":"原因","message":"说明"}}`

模型每次只输出一个动作；程序解析后把工具结果作为新消息**追加进上下文**（`【工具结果 工具名】...`，role 用 user 保证兼容），模型在下一轮能看到全部历史（调用请求 + 对应结果），不是只打印出来。

**限制（由程序执行，非仅提示词）**：

| 限制 | 值 | 说明 |
| --- | --- | --- |
| 最大执行步数 maxSteps | 8 | 一步 = 一次模型调用及其引发的工具执行；`step++` 由 Harness 计数，达到即强制停止（`max_steps_reached`） |
| 单次模型调用超时 | 120s | 复用 modelClient 的 AbortSignal.timeout，超时 → LLM_TIMEOUT |
| 总运行时限 | 300s | 含工具执行，超时 → `total_timeout` |
| 连续解析失败重试上限 | 2 次 | 模型输出非合法 JSON 时回喂错误让其修正，连续超过 2 次 → `parse_failed` |

**最终回答的复核**：模型输出 final 后，Harness 调用 `checkSuccess` 按 2.1 的成功标准 S1~S6 独立检查，不凭模型自称完成；模型输出 `final.error` 也视为未完成（`MODEL_DECLINED`）。

### 2.4 运行时Harness设计与实现

将组织模型与工具运行的外围程序作为运行时 Harness（`src/services/harness.js` + 工具层 `tools.js` + 决策核心 `agent.js`，未拆成多个独立服务）。各模块职责：

| 模块 | 职责 | 对应函数 |
| --- | --- | --- |
| `tools.js` | 工具注册表、参数 Schema 校验、权限标记、工具执行 | `TOOL_REGISTRY` / `validateArgs` / `executeTool` |
| `agent.js` | Agent 系统 Prompt、任务消息、模型输出解析（tool/final/invalid）、循环常量 | `buildAgentSystemPrompt` / `parseAgentOutput` / `AGENT_LIMITS` |
| `harness.js` | **运行时主循环**：任务输入 → 模型调用 → 解析 → 工具分发/确认/执行 → 结果回传 → 停止控制 → 成功标准复核 → 日志 | `runAgentTask` / `checkSuccess` |
| 复用（实验5） | 模型调用（`modelClient.callLLM`）、检索（`retrieval.search`）、库存/消耗（`inventoryService`）、知识库（`knowledgeBase`） | — |

**Harness 实际控制流程**（`runAgentTask`）：

```
1. 生成 task_id，记录开始时间；构造上下文 [system, user(目标+偏好)]
2. 循环：
   a. 检查总时限 / 步数上限（未超继续）
   b. 调用模型（真实 callLLM 或测试注入 llmOverride）
   c. 解析输出：
      - invalid → 回喂解析错误 → 重试（≤2 次），超过 → parse_failed 终止
      - tool → 白名单 → Schema 校验 → 权限（写操作先走人工确认闸口）
              → 执行工具 → 结果文本化回喂 → step+1 → 回到 b
      - final → 成功标准复核 → completed / failed，终止
3. 写日志（logs/agent-<task_id>.json），返回完整运行结果
```

关键限制全部由程序执行：步数计数、超时、确认闸口、成功标准复核均不依赖提示词。工具失败或结果不符合要求时，把错误信息（code+message）回喂模型进行有限次修正（如参数错误场景模型自行修正后继续），或按停止条件结束任务并说明原因。

### 2.5 失败处理与可观测性

**运行日志**（每次运行生成 `logs/agent-<task_id>.json`）：

| 字段 | 内容 |
| --- | --- |
| task_id / task | 任务编号（`T<时间戳>-<随机>`）与目标 |
| status | running / completed / failed / max_steps_reached / total_timeout / parse_failed / llm_failed / harness_error |
| steps[] | 每步：序号、类型（tool/final/llm_error/parse_error）、工具名、参数摘要、结果摘要、错误码、耗时 |
| final / success / success_issues | 最终方案、复核结论与未通过项 |
| elapsed_ms / total_steps | 总耗时与步数 |

**密钥与隐私脱敏**：日志不记录 API Key（密钥仅存在于 `.env`，已被 .gitignore 忽略）、不记录消息全文，只记录参数与结果摘要（如 `鸡蛋×2枚、青菜×1把`），不包含任何个人信息。

**错误处理与边界**：

| 情况 | 处理 | 返回状态 |
| --- | --- | --- |
| 参数错误（类型/必填/越界） | Schema 校验拦截，错误回喂模型修正 | 修正后继续，或累计无效后终止 |
| 工具异常（食材不存在/库存不足） | 捕获为 ToolError，code+message 回喂 | 模型决定修正或放弃 |
| 模型调用超时/服务不可用 | 捕获 LLMError，记录 error_code | `llm_failed`（不崩溃） |
| 达到步数上限 | 程序强制停止 | `max_steps_reached` |
| 连续输出无法解析 | 回喂错误 ≤2 次 | `parse_failed` |
| 人工确认拒绝/超时 | 不执行工具，`USER_REJECTED` 回喂 | 模型可给出方案并说明未记录消耗 |
| 修改数据的调用状态不明 | **先核对执行结果再决定，不得盲目重试**（本项目 `consumeIngredients` 使用事务，失败即回滚，状态明确） | — |

**超时与取消能力说明**：单次模型调用超时（120s）只是"停止等待"该次调用，后台模型请求若已发出可能仍在服务端运行；本项目工具均为本地同步/短时操作（检索 <10ms、消耗为本地事务），不存在后台长任务，因此"超时 ≠ 后台已停止"的问题仅在模型调用场景存在，已通过 AbortSignal 中止连接并记录 `LLM_TIMEOUT`，不做盲目重试。

**人工确认流程**：`mark_consumed` 执行前，Harness 调用确认回调，展示操作内容与影响（如"将记录以下食材消耗并扣减库存：鸡蛋 × 2枚、青菜 × 1把"）；用户明确同意才执行，拒绝或 30s 超时不执行，并把拒绝结果回喂模型。CLI 演示由终端输入 y/n 完成，测试由注入的模拟回调完成（同意/拒绝各测一条）。

### 2.6 测试与结果分析

**自动化测试**（`tests/agent.test.js`，`node --test tests/agent.test.js`，**16/16 通过**；实验5回归 `tests/api.test.js tests/rag.test.js` 31/31 通过，未破坏原有功能）。测试使用独立数据库（`data/test-agent-fridge.db`，不影响真实 `fridge.db`），库存为按当前日期动态生成的测试数据（含 ok/warn/critical/needs_confirm/expired 各寿命等级）。其中 AGENT-01 是唯一依赖真实模型网络的用例，已加网络容错：调用失败自动重试一次，仍不可用则 `skip` 并打印错误码与原因（不让网络抖动把整个用例判红），其余 15 个用例完全离线、任何环境可复现。

**五类情况测试记录**（输入 / 预期行为 / 实际结果 / 判断依据）：

| 编号 | 类别 | 输入（触发方式） | 预期行为 | 实际结果 | 判断依据 |
| --- | --- | --- | --- | --- | --- |
| AGENT-01 | **正常完成** | "用冰箱里的临期食材做今晚的菜，并记录消耗"（**真实模型 qwen-plus + 真实工具**，确认=同意） | 模型自主调用工具并给出方案，复核通过 | status=completed, success=true，5 步闭环（详见下方真实运行实例） | 程序复核 S1~S6 全部通过；日志 mode=api |
| AGENT-02 | 参数错误 | 模拟模型输出 `ingredients:"番茄"`（字符串） | Schema 拦截 INVALID_ARGS，回喂后模型修正，最终完成 | 记录 1 次 INVALID_ARGS，修正后 completed | 修正后最终方案通过复核 |
| AGENT-03 | 工具异常 | 模拟模型输出 `top_k:99`（越界） | 工具错误回喂，模型修正，最终完成 | 记录 1 次 INVALID_ARGS（越界），修正后 completed | 同上 |
| AGENT-04 | 工具异常 | 模拟模型消耗不存在食材"深海龙虾" | ITEM_NOT_FOUND 回喂模型 | 记录 ITEM_NOT_FOUND，模型收到错误 | 错误码与回喂上下文正确 |
| AGENT-05 | **达到步数限制** | 模拟模型每步都调 query_inventory（死循环） | 达到 maxSteps(8) 强制停止 | status=max_steps_reached, success=false，恰好 8 步 | 停止检查由程序执行 |
| AGENT-06 | **人工确认-同意** | 模拟模型调 mark_consumed 消耗番茄×2，确认=同意 | 库存扣减、消耗记录写入、复核通过 | 番茄 4→2 个，completed success=true | 库存实查 + S6 消耗一致 |
| AGENT-07 | **人工确认-拒绝** | 同上，确认=拒绝 | 不执行、库存不变、USER_REJECTED 回喂 | 库存不变，note=user_rejected_consumption | 库存实查 + 拒绝结果回喂 |
| AGENT-08 | 输出无法解析 | 模拟模型持续输出非 JSON | 回喂错误 ≤2 次后终止 | status=parse_failed | 重试上限生效 |
| AGENT-09 | 模型调用失败 | 模拟 LLM_TIMEOUT | 捕获并返回明确状态 | status=llm_failed，不崩溃 | LLMError 处理路径 |
| TOOL-01~06 | 工具直测 | 正确/错误参数、白名单、无确认拒执 | Schema 与权限边界生效 | 全部符合预期 | 断言校验错误与返回 |

（说明：作业要求"正常流程必须实际调用模型和工具"——AGENT-01 使用真实 qwen-plus API 与真实工具；异常与边界场景按要求使用模拟触发，保证测试确定性与速度。）

**真实运行实例（AGENT-01，模型 qwen-plus，完整闭环）**：

```
第1步 query_inventory  {"status":"all"}   → INVALID_ARGS（模型误传枚举外值，回喂）
第2步 query_inventory  {"status":"available"} → OK（模型自行修正，库存8项含寿命等级）
第3步 search_recipe    {"ingredients":["豆腐","鸡蛋","番茄"],"top_k":3} → OK（命中3条菜谱）
第4步 mark_consumed    {豆腐×1盒,鸡蛋×2枚,番茄×2个} → OK（确认后扣减库存）
第5步 final            番茄炒蛋，used_items=豆腐1盒/鸡蛋2枚/番茄2个，引用 KB-07
复核：S1~S6 全部通过 → completed，耗时 9.7s
```

该实例同时演示了**参数错误自动修正**的真实发生（模型第一次传 `status:"all"` 被 Schema 拦截后自行改为合法值）。

**真实运行实例（CLI 演示 `node scripts/agent-demo.js`，终端人工确认输入 y）**：

```
[1] query_inventory   → OK：库存 7 项
[2] search_recipe  {鸡蛋,豆腐}      → OK：检索到 3 条
[3] search_recipe  {鸡蛋,青菜}      → OK：检索到 3 条
[4] search_recipe  {鸡蛋,青菜,生姜}  → OK：检索到 3 条
⚠ 需要确认：工具「mark_consumed」→ 将记录以下食材消耗并扣减库存：鸡蛋 × 2枚、青菜 × 1把、生姜 × 0.1块。执行吗？(y/n，30秒无响应视为拒绝)
[5] mark_consumed（用户确认 y）→ OK：已消耗 鸡蛋、青菜、生姜
[6] final：青菜蛋花汤（15分钟），消耗=鸡蛋2枚/青菜1把/生姜0.1块，引用 KB-06
复核通过 → completed，success=true，耗时 12s
```

模型在本次运行中自主进行了 3 次菜谱检索探索（鸡蛋豆腐 / 鸡蛋青菜 / 鸡蛋青菜生姜），最终选择临期食材青菜（warn，5天）+ 鸡蛋，符合"优先消耗临期食材"的任务目标。

**另一个真实边界案例（数据全过期时的正确拒绝）**：在库存全部过期（实验5遗留的 10 月样例数据）时，模型输出 `{"final":{"error":"no_valid_ingredients",...}}` 明确拒绝编造方案（遵守"不使用 expired/needs_confirm 食材"与过敏规则），Harness 按 `MODEL_DECLINED` 判 failed 并记录原因——证明模型与程序的双重安全边界生效。此案例促使我们把样例库存改为**相对日期动态生成**（`sample-seed.json` 用 `expiry_days_from_now` / `purchase_days_ago` 字段，`seed.js` 在 seed 时按当天换算为具体日期），避免写死日期随时间推移再次全部过期。

**问题定位分析**：测试过程中出现过一类非预期失败（AGENT-01/03 及早期 AGENT-02/06 复核失败，错误为 `actual 'failed' expected 'completed'`），定位为**库存数据的日期写死导致随时间推移全部过期**（样例/测试数据保质期固定为 2026-10~11 的某几天，运行到 2026-11-09 时豆腐、鸡蛋、番茄已全部 expired，被 S4"禁用过期食材"规则拦截，最终方案无法通过复核）——是**测试数据设计缺陷**而非控制流程问题；修复方式为**两类库存数据全部改为相对今天动态生成**：`tests/agent.test.js` 的 `testSeed` 用 `daysFromNow(n)` 构造各寿命等级（+26/+3/+7/+1/-10 天），`data/sample-seed.json` 改用 `expiry_days_from_now` / `purchase_days_ago` 并由 `seed.js` 换算；修复后任意日期运行均保持 ok/warn/critical/needs_confirm/expired 的稳定分布，全部 47 个用例通过。另发现并修复三处实现缺陷：① `query_inventory` 声明了未生效的 `status` 过滤参数（改为无参契约，筛选决策交给模型）；② CLI 确认回调在管道输入下 readline 提前关闭（改为每次确认新建实例）；③ **测试库隔离失效**（ESM import 提升导致测试文件里 `process.env.FRIDGE_DB_PATH` 设置晚于 `db.js` 模块加载，测试实际写入默认库 `data/fridge.db`，并行运行多测试文件时互相锁冲突——`database is locked`）；修复方式为 `db.js` 将库路径改为**每次调用时惰性解析**（`resolveDbPath()` 读取当前 `FRIDGE_DB_PATH`），修复后三个测试文件并行运行 **47/47 通过**且互不污染（测试库 `data/test-agent-fridge.db`、`data/test-rag-fridge.db` 用完即清）。

**Agent 与 Harness 是否用于个人软件及局限改进**：

| 项目 | 说明 |
| --- | --- |
| 是否用于个人软件 | 是：作为 fridge-matcher 的 Agent 能力（CLI 演示），复用实验5的模型调用、检索、库存服务；暂未接入 Web 界面（本实验以 CLI + 测试呈现，符合作业"可独立完成练习"的要求） |
| 当前局限 | ① 工具仅 3 个，未覆盖"补购清单"等更多动作；② 检索为关键词 BM25（沿用实验5），无语义能力；③ 模型多步探索可能重复检索（如 demo 中连续 3 次 search_recipe），增加耗时；④ 单 Agent 无并行/记忆持久化 |
| 下一步改进 | 接入向量检索提升工具信息质量；为重复调用加"结果缓存/去重"；将 Agent 封装为 Web 面板交互（人工确认改为页面按钮）；支持多 Agent 分工（如规划/执行分离） |

## 3. 操作记录

> 以下为操作步骤与文字说明，截图请按编号插入（截图插入位置：▲图N）。

- **图1**（全量测试通过）：在 `fridge-matcher` 目录执行 `node --test tests/agent.test.js`，结果 16/16 通过（含工具 Schema、白名单、五类场景、输出解析用例）；再执行 `node --test tests/api.test.js tests/rag.test.js` 31/31 通过（实验5回归）。▲图1
- **图2**（工具直测）：在 `fridge-matcher` 目录执行 `node scripts/tool-demo.js`，依次展示 TOOL-01~06：Schema 校验（类型错误/缺失必填/越界被拦截）、白名单拦截 UNKNOWN_TOOL、query_inventory 返回 7 项库存及寿命等级、search_recipe 命中 KB-07、错误参数返回 INVALID_ARGS、写工具无确认回调被 CONFIRM_REQUIRED 拦截且库存未变化。▲图2
- **图3**（真实模型闭环运行）：执行 `node --test tests/agent.test.js` 中 AGENT-01（真实 qwen-plus），或查看 `logs/agent-*.json`，展示 5 步闭环轨迹（查库存→检索→确认消耗→方案）与复核通过结果。▲图3
- **图4**（CLI 演示 + 人工确认）：执行 `node scripts/agent-demo.js "用冰箱里的临期食材做今晚的菜，并记录消耗"`，终端展示每步工具调用、确认提示（y/n）与最终方案；回答 y 演示同意路径。▲图4
- **图5**（拒绝路径演示）：回答 n 或等待 30s 超时，展示 mark_consumed 不执行、库存不变、模型给出方案并说明未记录消耗。▲图5
- **图6**（运行日志）：打开 `logs/agent-<task_id>.json`，展示 task_id、每步记录（工具/参数摘要/结果/耗时）、最终状态与成功标准复核结果。▲图6
- **图7**（步数限制演示）：执行 `node --test tests/agent.test.js` 中 AGENT-05，展示模型死循环时程序在 maxSteps=8 强制停止并返回 `max_steps_reached`。▲图7

## 4. 实验小结

本次实验在 fridge-matcher 上实现了"工具调用 + 单 Agent + 运行时 Harness"的完整闭环：

1. **工具接口与参数约束**：实现 3 个可实际运行的工具（查库存 / 检索菜谱 / 记录消耗），每个工具带 Schema（字段类型/必填/范围）；建立工具注册表白名单，执行前程序校验工具名称、参数与访问范围（模型生成的任意函数名一律 UNKNOWN_TOOL 拦截，不可能 eval）；权限分级明确：只读自动、写操作人工确认、禁止操作不注册。接入 Agent 前完成正确/错误参数直测。

2. **Agent 循环**：接入 qwen-plus 真实模型，约定可解析的 JSON 调用格式（tool 请求 / final 答案二选一）；模型每轮只输出一个动作，工具结果作为新消息追加进上下文回喂（不是只打印）；设置了最大步数（8）、单次调用超时（120s）、总时限（300s）与解析重试上限（2 次），一步如何计数由程序执行。

3. **运行时 Harness**：由 `tools.js / agent.js / harness.js` 组织任务输入、上下文、工具分发、参数与权限检查、结果回传、停止控制与成功标准复核；工具失败将错误回喂模型有限修正；模型给出 final 后由程序按 S1~S6 独立复核，不凭模型自称完成。

4. **失败处理与可观测性**：每次运行生成 task_id 与完整日志（步数、工具与参数摘要、结果、错误码、耗时、状态），密钥脱敏；对参数错误、工具异常、超时、步数上限、连续解析失败、人工确认拒绝/超时均有明确状态返回；修改数据调用依托事务保证状态明确，不盲目重试。

5. **测试（核心收获）**：16 个自动化用例覆盖五类场景（正常完成、参数错误、工具异常、达到步数限制、人工确认同意/拒绝）与工具直测、输出解析，正常流程真实调用模型与工具；实验5 回归 31/31 通过。真实运行（qwen-plus）完整闭环 5 步 9.7s 成功；还实测到两个有价值案例：① 模型传非法参数被 Schema 拦截后**自行修正**继续；② 库存全过期时模型与程序双重安全边界生效、正确拒绝编造方案。过程中定位并修复了**库存日期写死导致随时间全部过期**、测试库隔离失效、无效过滤参数、CLI 确认 readline 提前关闭四处问题，其中库存数据已改为按当天相对日期动态生成，保证测试与演示在任何日期运行都稳定。

6. **局限**：工具数量少、检索无语义能力、模型多步探索可能重复检索耗时、无并行与记忆。下一步计划向量检索、工具结果去重缓存、Web 面板人工确认交互、多 Agent 分工。

总体：实验6 的 Agent + Harness 闭环在真实模型上验证了"模型决定下一步、程序兜底安全与停止、结果可观测可复核"的设计，且完整复用实验5 的模型调用、检索与库存服务，两实验形成从 RAG 单轮问答到 Agent 多步决策的递进。

## 仓库与 Commit

- **仓库路径**：`D:\dev_project\p1\dev_project`（fridge-matcher 子目录）。
- **本实验新增/修改文件**：
  - 新增 `src/services/tools.js`（工具注册表与 Schema 校验）、`src/services/agent.js`（Agent 决策核心）、`src/services/harness.js`（运行时 Harness）、`tests/agent.test.js`（16 用例）、`scripts/agent-demo.js`（CLI 演示）、`scripts/tool-demo.js`（工具层演示，对应图2）；
  - 修改 `data/sample-seed.json`（样例库存改为相对日期动态生成：`expiry_days_from_now` / `purchase_days_ago`）、`scripts/seed.js`（支持相对日期换算）、`tests/agent.test.js`（测试库存改为 `daysFromNow(n)` 动态生成）、`src/db.js`（测试库路径惰性解析）、`package.json`（新增 `test:agent` / `agent` 脚本）、`实验6-工具调用、Agent与Harness实现.md`（本报告）。
- **提交方式**：在项目根目录执行以下命令（`.env` 与 `data/*.db` 已被 `.gitignore` 忽略，`logs/agent-*.json` 作为图6 的运行证据一并提交）：

  ```
  cd D:\dev_project\p1\dev_project
  git add -A
  git commit -m "实验6：工具调用、Agent与Harness实现（含测试与报告）"
  git push origin main
  ```

- **Commit**：`ddc4e09`（分支 main，2026-11-09）
