# BrowserRelay 设计文档

## 概述

BrowserRelay 是一个基于 WebSocket 的流式 HTTP 中继系统。它允许本地进程通过浏览器的 WebSocket 连接发送 HTTP 请求，将浏览器作为 HTTP 执行引擎。这使得需要浏览器 cookies/session 上下文的请求（如带 SSO 的内网访问）可以通过本地命令行工具完成。

核心能力：通过多帧二进制协议 + 背压控制，流式传输大文件而不 OOM。

## 系统架构

```
┌──────────────┐    HTTP     ┌──────────────┐   Binary WS   ┌──────────────┐   fetch()   ┌──────────────┐
│  Local       │ ──────────> │  Relay       │ ─────────────> │  Browser     │ ──────────> │  Target      │
│  Process     │  /proxy     │  Server      │  Frames       │  (index.html)│             │  Server      │
│  (curl etc)  │ <────────── │  (Fastify)   │ <──────────── │              │ <────────── │              │
└──────────────┘   stream    └──────────────┘   stream      └──────────────┘   stream   └──────────────┘
```

**上传方向**: Local Process → HTTP /proxy (chunked) → Fastify → WS binary frames → Browser (ReadableStream) → fetch(stream body, duplex:"half") → Target Server

**下载方向**: Target Server → fetch response → Browser (ReadableStream reader) → WS binary frames → Fastify frame-router → HTTP response (streaming) → Local Process

## 技术栈

| 组件 | 技术 |
|------|------|
| Server | Node.js + TypeScript + Fastify 5 + @fastify/websocket |
| Browser | 原生 HTML/JS 单页面（无构建工具） |
| 协议 | 二进制 WebSocket 帧（无 base64 开销） |
| 测试 | Vitest + 模拟浏览器 WS 客户端 |

## 项目结构

```
src/
├── index.ts                 # 入口：启动 Fastify，支持 PORT 环境变量
├── server.ts                # Fastify 实例创建 + 插件/路由注册
├── session/
│   ├── types.ts             # Session、PendingRequest 类型定义
│   └── SessionManager.ts    # 内存会话存储
├── ws/
│   ├── protocol.ts          # 二进制协议编解码
│   ├── ws-handler.ts        # /ws 路由处理
│   └── frame-router.ts      # 入站 WS 帧分发
├── proxy/
│   └── proxy-handler.ts     # /proxy 路由：流式 HTTP ↔ WS
├── routes/
│   ├── login.ts             # POST /login
│   └── app.ts               # POST /app
└── util/
    ├── header-filter.ts     # 过滤禁止转发的 HTTP 头
    └── constants.ts         # 超时、窗口大小等常量
```

## 二进制 WebSocket 协议

### 消息类型

| 类型 | Hex | 方向 | 描述 |
|------|-----|------|------|
| REQUEST_START | 0x01 | Server→Browser | method, url, headers |
| REQUEST_CHUNK | 0x02 | Server→Browser | body 数据 |
| REQUEST_END | 0x03 | Server→Browser | 上传完成 |
| RESPONSE_START | 0x11 | Browser→Server | status, headers |
| RESPONSE_CHUNK | 0x12 | Browser→Server | body 数据 |
| RESPONSE_END | 0x13 | Browser→Server | 下载完成 |
| ABORT | 0x21 | 双向 | 错误/取消 |
| ACK | 0x30 | Browser→Server | 背压窗口确认 |
| PING | 0x40 | Server→Browser | 心跳 |
| PONG | 0x41 | Browser→Server | 心跳回复 |

### 帧布局

每帧为二进制数据（WS opcode 0x02）：
- Byte 0: 消息类型
- Bytes 1-16: requestId（原始 UUID 字节，16 字节）
- 剩余字节: 类型特定载荷

**REQUEST_START**: `[type][requestId][4B methodLen][method][4B urlLen][url][4B headersLen][headerJSON]`

**REQUEST_CHUNK**: `[type][requestId][raw data bytes]`

**RESPONSE_START**: `[type][requestId][2B status(uint16BE)][4B headersLen][headerJSON]`

**RESPONSE_CHUNK**: `[type][requestId][raw data bytes]`

**ACK**: `[type][requestId][4B windowBytes(uint32BE)]`

**ABORT**: `[type][requestId][UTF-8 error message]`

## API 端点

### POST /login

创建会话，返回 `sessionId` 和一次性 `wsToken`。

**响应**: `{ sessionId, wsToken }`
**副作用**: 设置 `sessionId` cookie

### GET /ws?token=xxx

验证一次性 wsToken，将 WebSocket 绑定到会话。仅支持二进制帧。心跳间隔 30 秒。

### POST /proxy (流式)

本地进程通过自定义 HTTP 头发送代理请求：

| 头 | 描述 |
|----|------|
| X-Proxy-Session | sessionId |
| X-Proxy-Method | 目标 HTTP 方法 |
| X-Proxy-URL | 目标 URL |
| X-Proxy-Headers | JSON 编码的目标请求头 |

请求体直接流式传输（无包装）。

**示例**:
```bash
curl -X POST http://localhost:3000/proxy \
  -H "X-Proxy-Session: sess-123" \
  -H "X-Proxy-URL: https://target/api" \
  -H "X-Proxy-Method: GET"
```

### POST /app

通过 cookie 验证会话，执行命令分发（当前仅 `status`）。

## 会话模型

```
Session {
  sessionId,          // UUID
  wsToken,            // 一次性令牌
  wsConnection,       // WebSocket 实例或 null
  createdAt,          // 创建时间
  lastActivity,       // 最后活跃时间
  pendingRequests     // Map<requestId, PendingRequest>
}

PendingRequest {
  requestIdBytes,     // 16字节 UUID
  requestId,          // UUID 字符串
  resolve/reject,     // Proxy response promise
  timeoutHandle,      // 超时定时器
  bytesInFlight,      // 已发送未确认字节数
  windowSize,         // 背压窗口大小（256KB）
  paused,             // 是否暂停
  responseStatus/Headers,
  abortController
}
```

- wsToken 一次性使用，验证后即失效
- 定期清理：60 秒间隔，销毁超过 24 小时无 WS 连接的会话

## 背压控制

防止大文件上传时服务器 OOM：

1. 浏览器每消费 64KB 数据，发送 ACK 帧
2. 服务器跟踪每个 pending request 的 `bytesInFlight`
3. 当 `bytesInFlight >= windowSize`（256KB），暂停 HTTP 读取 (`req.pause()`)
4. 收到 ACK 后，递减 `bytesInFlight`，低于窗口时 `req.resume()`

```
Server                          Browser
  │  REQUEST_CHUNK (64KB)  ───>  │
  │  REQUEST_CHUNK (64KB)  ───>  │
  │  REQUEST_CHUNK (64KB)  ───>  │
  │  REQUEST_CHUNK (64KB)  ───>  │
  │  (paused, bytesInFlight      │  <──  ACK (64KB consumed)
  │   = 256KB >= windowSize)     │
  │  (resumed, bytesInFlight     │
  │   -= 64KB)                   │
  │  REQUEST_CHUNK ...     ───>  │
```

## 错误处理

| 场景 | HTTP 状态码 | 说明 |
|------|------------|------|
| 缺少 X-Proxy-Session | 400 | 缺少必要头 |
| Session 不存在 | 404 | 无效的 sessionId |
| 浏览器未连接 | 503 | Session 无 WS 连接 |
| ABORT 帧 | 502 | 浏览器/目标返回错误 |
| 超时（30s） | 504 | 浏览器未响应 |
| WS 断开 | 502 | 代理过程中浏览器断开 |

## 配置常量

| 常量 | 值 | 说明 |
|------|-----|------|
| PROXY_TIMEOUT_MS | 30,000 | 代理请求超时 |
| HEARTBEAT_INTERVAL_MS | 30,000 | 心跳间隔 |
| DEFAULT_WINDOW_SIZE | 256KB | 背压窗口 |
| ACK_THRESHOLD | 64KB | ACK 触发阈值 |
| STREAM_CHUNK_SIZE | 64KB | 流式传输块大小 |
| MAX_SESSION_AGE_MS | 24h | 最大会话存活时间 |

## 使用方法

### 启动

```bash
PORT=8080 npm run dev
```

### 测试

```bash
npm test          # 运行全部 72 个测试
npm run test:watch # 监听模式
```

### 手动验证

1. 浏览器打开 `http://localhost:8080`，点击 Connect
2. 页面显示 sessionId，复制 curl 命令
3. 在终端执行 curl 请求，验证响应

```bash
curl -X POST http://localhost:8080/proxy \
  -H "X-Proxy-Session: <sessionId>" \
  -H "X-Proxy-URL: https://httpbin.org/get" \
  -H "X-Proxy-Method: GET"
```

## 测试架构

| 测试文件 | 覆盖范围 | 数量 |
|----------|---------|------|
| protocol.test.ts | 二进制协议编解码、往返验证 | 16 |
| session.test.ts | SessionManager CRUD、token 验证、清理 | 16 |
| header-filter.test.ts | 禁止头过滤、大小写不敏感 | 8 |
| login.test.ts | /login 端点、cookie 设置 | 4 |
| ws.test.ts | WS 连接、token 验证、PING/PONG | 6 |
| proxy.test.ts | 上传帧、响应流式传输、错误状态码 | 11 |
| app.test.ts | /app 端点、会话验证 | 4 |
| backpressure.test.ts | 背压暂停/恢复、ABORT/超时/断开 | 4 |
| integration/full-relay.test.ts | 完整中继循环（含真实 HTTP 目标） | 3 |
| **总计** | | **72** |

集成测试通过模拟浏览器 WS 客户端和真实 HTTP 目标服务器，验证完整的 `LocalProcess → /proxy → WS → BrowserSim → MockTarget → response` 循环。
