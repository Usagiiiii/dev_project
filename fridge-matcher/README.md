# AI冰箱食材寿命匹配器（实验4）

非 AI 业务闭环：录入库存 → 寿命排序 → 规则方案生成 → 补缺清单 → 确认消耗。

## 技术栈

- Node.js（内置 `node:sqlite`、`node:http`，零第三方依赖）
- SQLite 本地文件：`data/fridge.db`
- 静态前端：`public/`

## 启动

```powershell
cd fridge-matcher
npm start
```

浏览器打开 http://localhost:3780

## 样例数据

```powershell
npm run seed
# 或页面点击「加载样例数据」
```

清空/重建：

```powershell
npm run reset-db
npm run seed
```

## 测试

```powershell
npm test
```

## 实验5：LLM、Context 与 RAG（原版）

- LLM 接口占位（mock / API 骨架），预计后续以调用 API 方式接入：`src/services/modelClient.js`
- Prompt 原版 V1 与上下文工程：`src/services/promptTemplates.js`
- 知识库与切分：`data/knowledge_base.json` + `src/services/knowledgeBase.js`
- 关键词检索（2-gram + BM25）：`src/services/retrieval.js`
- RAG 最小链路与输出校验：`src/services/ragService.js` / `ragGuard.js`

```powershell
npm run rag -- "冰箱里有青菜和鸡蛋，能做什么菜？"   # 命令行 RAG 演示
npm run rag-compare                                 # 直接组 vs RAG 组对比测试
npm run test:rag                                    # RAG 单元测试
```

详细说明见《实验5-LLM-Context-RAG-实现说明.md》。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `public/` | 页面与前端交互 |
| `src/routes/` | HTTP 接口 |
| `src/services/` | 库存、偏好、寿命规则、方案生成 |
| `src/db.js` | SQLite 初始化 |
| `data/sample-seed.json` | 可复现样例 |
| `logs/app.log` | 请求与业务日志 |
