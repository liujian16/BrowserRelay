# BrowserRelay

Streaming HTTP relay over WebSocket — use your browser as an HTTP proxy with its full cookie/session context.

## Why

Local CLI tools often need to access SSO-protected internal services. BrowserRelay lets you route HTTP requests through your browser, so the target server sees your real browser session (cookies, auth headers, etc.).

```
┌──────────────┐    HTTP     ┌──────────────┐   Binary WS   ┌──────────────┐   fetch()   ┌──────────────┐
│  Local       │ ──────────> │  Relay       │ ─────────────> │  Browser     │ ──────────> │  Target      │
│  Process     │  POST /proxy│  Server      │  Frames       │  (index.html)│             │  Server      │
│  (curl etc)  │ <────────── │  (Fastify)   │ <──────────── │              │ <────────── │              │
└──────────────┘   stream    └──────────────┘   stream      └──────────────┘   stream   └──────────────┘
```

**Key features:**

- **Binary WebSocket protocol** — no base64 overhead, raw UUID requestIds
- **Streaming upload & download** — PassThrough stream for responses, backpressure control (256KB sliding window) for uploads
- **Zero build step** — browser client is vanilla HTML/JS

## Quick Start

```bash
npm install
npm run dev
```

1. Open `http://localhost:3000` in your browser, click **Connect**
2. Copy the `curl` command shown on the page (includes your session ID)
3. Run it in your terminal:

```bash
curl -X POST http://localhost:3000/proxy \
  -H "X-Proxy-Session: <session-id>" \
  -H "X-Proxy-URL: https://httpbin.org/get" \
  -H "X-Proxy-Method: GET"
```

## API

### `POST /login`

Create a session. Returns `{ sessionId, wsToken }`.

### `GET /ws?token=xxx`

Connect the browser via WebSocket. `token` is a one-time use `wsToken` from `/login`.

### `POST /proxy`

Send a proxied HTTP request. Custom headers:

| Header | Description |
|--------|-------------|
| `X-Proxy-Session` | Session ID from `/login` |
| `X-Proxy-Method` | Target HTTP method |
| `X-Proxy-URL` | Target URL |
| `X-Proxy-Headers` | JSON-encoded target request headers |

Request body is streamed directly. Response is streamed back via chunked transfer encoding.

Error responses:

| Status | Condition |
|--------|-----------|
| 400 | Missing required headers |
| 404 | Session not found |
| 502 | Browser/target error or WebSocket disconnect |
| 503 | Browser not connected |
| 504 | Proxy request timeout (30s) |

## Binary Protocol

All WebSocket frames use binary opcode. Frame layout:

```
[type: 1 byte][requestId: 16 bytes (raw UUID)][type-specific payload]
```

| Type | Hex | Direction | Payload |
|------|-----|-----------|---------|
| REQUEST_START | 0x01 | Server→Browser | method + url + headers JSON |
| REQUEST_CHUNK | 0x02 | Server→Browser | raw body data |
| REQUEST_END | 0x03 | Server→Browser | — |
| RESPONSE_START | 0x11 | Browser→Server | status (uint16 BE) + headers JSON |
| RESPONSE_CHUNK | 0x12 | Browser→Server | raw body data |
| RESPONSE_END | 0x13 | Browser→Server | — |
| ABORT | 0x21 | Both | UTF-8 error message |
| ACK | 0x30 | Browser→Server | windowBytes (uint32 BE) |
| PING/PONG | 0x40/0x41 | Server→Browser | — |

## Development

```bash
npm test                # Run all 72 tests
npm run test:watch      # Watch mode
npx vitest run test/proxy.test.ts   # Single file
npm run dev             # Dev server with hot reload
```

## Tech Stack

- **Server:** Node.js + TypeScript + Fastify 5 + @fastify/websocket
- **Browser:** Vanilla HTML/JS (no build tools)
- **Protocol:** Binary WebSocket frames
- **Testing:** Vitest (72 tests)

## Configuration

| Constant | Default | Description |
|----------|---------|-------------|
| `PORT` env | 3000 | Server port |
| `PROXY_TIMEOUT_MS` | 30s | Proxy request timeout |
| `HEARTBEAT_INTERVAL_MS` | 30s | WebSocket ping interval |
| `DEFAULT_WINDOW_SIZE` | 256KB | Upload backpressure window |
| `MAX_SESSION_AGE_MS` | 24h | Session auto-cleanup threshold |

## License

MIT
