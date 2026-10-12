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

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `public/` | 页面与前端交互 |
| `src/routes/` | HTTP 接口 |
| `src/services/` | 库存、偏好、寿命规则、方案生成 |
| `src/db.js` | SQLite 初始化 |
| `data/sample-seed.json` | 可复现样例 |
| `logs/app.log` | 请求与业务日志 |
