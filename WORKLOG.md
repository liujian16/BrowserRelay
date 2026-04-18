# BrowserRelay 开发记录

## 项目目标

构建一个基于 WebSocket 的流式 HTTP 中继系统，允许本地进程通过浏览器的 WebSocket 连接发送 HTTP 请求，利用浏览器的 cookies/session 上下文访问目标服务（如带 SSO 的内网）。

## 实施过程

采用 TDD（测试驱动开发）模式，按计划分 13 个步骤逐步实现，每步遵循 Red-Green-Refactor 循环。

### Step 0: 项目脚手架

- 创建 package.json、tsconfig.json、vitest.config.ts
- 初始化 Fastify 服务器骨架（src/index.ts）
- 创建测试基础设施（test/helpers/relay-fixture.ts）
- 创建 public/index.html 占位页

### Step 1: 二进制协议模块

- **测试**: 16 个 — 编码后解码验证往返正确性，覆盖所有帧类型、空载荷、二进制数据、未知类型报错
- **实现**: src/ws/protocol.ts — 10 种消息类型的 encode/decode 函数
- **关键决策**: 使用原始 UUID 字节（16 字节）而非字符串，减少传输开销

### Step 2: HTTP 头过滤

- **测试**: 8 个 — 验证 Host/Content-Length/Connection 等 hop-by-hop 头被过滤，自定义头保留，大小写不敏感
- **实现**: src/util/header-filter.ts + src/util/constants.ts

### Step 3: 会话管理

- **测试**: 16 个 — 创建会话、消费令牌（有效/无效/重用）、绑定/解绑 WS、pending request CRUD、过期清理
- **实现**: src/session/types.ts + SessionManager.ts
- **关键决策**: wsToken 一次性使用，tokenToSession Map 做快速查找

### Step 4: /login 路由

- **测试**: 4 个 — 返回 sessionId+wsToken、创建有效会话、设置 cookie、每次返回不同 ID
- **实现**: src/routes/login.ts
- **踩坑**: 需要注册 @fastify/cookie 插件才能使用 reply.setCookie

### Step 5: /ws WebSocket 路由

- **测试**: 6 个 — 有效令牌连接成功、无效令牌拒绝、令牌重用拒绝、PING/PONG、绑定/解绑 WS
- **实现**: src/ws/ws-handler.ts

### Step 6: /proxy 上传方向

- **测试**: 6 个 — REQUEST_START/CHUNK/END 帧验证、缺少 session 返回 400、无效 session 返回 404、无 WS 返回 503
- **实现**: src/proxy/proxy-handler.ts
- **踩坑**: Fastify inject 对 `application/octet-stream` 返回 415，需要用 `text/plain`。inject 返回的 Promise 在 handler await responsePromise 时永远 pending，测试不能 await inject

### Step 7: 响应流式 + 帧路由

- **测试**: 5 个 — 响应状态码、body、headers、404 错误、空 body
- **实现**: src/ws/frame-router.ts — 分发 RESPONSE_START/CHUNK/END/ABORT/ACK 到对应 pending request
- **关键设计**: pending request 上挂载 `_chunks`、`_ended`、`_endResolve`、`_setResponseInfo` 等扩展字段实现响应收集

### Step 8: 完整中继集成

- **测试**: 3 个 — GET 中继、POST 带 body、目标服务器错误响应
- **实现**: 连接所有组件到 src/server.ts
- **测试方法**: 创建 BrowserSim 模拟浏览器行为，连接真实 HTTP 目标服务器

### Step 9: 背压控制

- **测试**: 1 个 — 大于窗口大小的数据上传，验证 bytesInFlight 跟踪、暂停、ACK 恢复
- **实现**: proxy-handler 中 req.pause/resume，frame-router 中 ACK 处理
- **踩坑**: 需要使用 request.raw 而非 request.body 实现真正的流式读取。content-type parser 对 `application/octet-stream` 不解析，保留 raw stream

### Step 10: 错误处理

- **测试**: 3 个 — ABORT 返回 502、超时返回 504、WS 断开返回 502
- **实现**: ABORT 帧处理、timeout 清理、disconnect 清理

### Step 11: /app 路由

- **测试**: 4 个 — 有效会话返回状态、WS 绑定时 connected=true、缺少 cookie 返回 401、无效会话返回 401
- **实现**: src/routes/app.ts — 通过 cookie 验证会话，支持 status 命令

### Step 12: 浏览器 UI

- **实现**: public/index.html — 完整的单页面应用
  - 自动登录获取 sessionId + wsToken
  - WebSocket 连接管理（Connect/Disconnect）
  - 二进制协议编解码（浏览器端 JS 实现）
  - fetch() 流式请求处理
  - 背压 ACK（每 64KB 发送确认）
  - 请求计数和日志面板

### Step 13: 清理 + 提交

- 删除 scaffold 占位测试
- 最终验证：72 个测试全部通过

## 合并后发现的问题及修复

### 问题 1: WebSocket 连接失败（浏览器端）

**现象**: 浏览器点击 Connect 后，登录成功但 WebSocket 报错 `close code: 1006`

**根因**:
1. `request.query` 在 WS upgrade 上下文中为 undefined，导致 token 始终为 undefined
2. WS 路由在根级别注册时，`@fastify/websocket` 的 `onRoute` hook 未正确触发，导致 handler 收到的第一个参数是 FastifyRequest 而非 WebSocket

**修复**:
- token 解析改为从 `request.url` 用 URL 构造器提取
- WS 路由注册包裹在 `fastify.register(async function(f) { ... })` 插件上下文中

### 问题 2: 端口占用

**现象**: 默认 3000 端口被占用

**修复**: 支持 `PORT` 环境变量，`PORT=8080 npm run dev`

## 当前状态

### 测试: 72 个全部通过

| 测试文件 | 数量 |
|----------|------|
| protocol.test.ts | 16 |
| session.test.ts | 16 |
| header-filter.test.ts | 8 |
| login.test.ts | 4 |
| ws.test.ts | 6 |
| proxy.test.ts | 11 |
| app.test.ts | 4 |
| backpressure.test.ts | 4 |
| integration/full-relay.test.ts | 3 |

### 已知限制

1. **下载方向非流式**: 目标服务器返回的响应在服务器端全量缓冲（`_chunks` 数组 + `Buffer.concat`），大文件下载可能 OOM。需要改为收到 RESPONSE_START 后立即写入 `reply.raw`，RESPONSE_CHUNK 逐块写入
2. **无并发请求限制**: 未限制单个会话的并发代理请求数量
3. **无认证机制**: /login 端点无认证，任何人可创建会话
4. **无 HTTPS 支持**: 服务器仅支持 HTTP
5. **单实例**: SessionManager 为纯内存存储，不支持多进程/多机器部署

### Git 提交记录

```
d70d830 Add design document
b3d6e3b Fix WebSocket connection and add configurable port
b609595 Implement BrowserRelay: streaming HTTP relay over WebSocket
0f63303 Initial: add requirement document
```

分支 `feat/browserrelay` 已 fast-forward 合并到 `main`。

### Step 14: 流式下载（PassThrough Stream）

**问题**: 下载方向（Target -> Browser -> Server -> Local Process）将所有响应块缓冲在 `_chunks[]` 数组中，然后通过 `Buffer.concat()` 一次性发送，大文件下载会导致 OOM。

**方案**: 用 Node.js `PassThrough` 流替换缓冲逻辑，实现真正的流式下载。

**变更文件**:
- `src/proxy/proxy-handler.ts` — 引入 `PassThrough` 流，替换 `_chunks`/`_ended`/`_endResolve` 为 `_writeChunk`/`_finishResponse`，用 `reply.send(stream)` 替代 `Buffer.concat` + `reply.send(buffer)`，过滤 `content-length` 头（流式用 chunked encoding），移除 `finally` 块（清理由 `_finishResponse` 处理）
- `src/ws/frame-router.ts` — `RESPONSE_CHUNK` 处理器改为调用 `_writeChunk`，`RESPONSE_END` 处理器改为调用 `_finishResponse`

**测试**: 全部 72 个测试通过，无需修改测试文件。`inject()` 自动收集流响应，与 `PassThrough` 完全兼容。
