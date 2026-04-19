# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test              # Run all tests once (vitest run)
npm run test:watch    # Run tests in watch mode
npm run dev           # Dev server with hot reload (tsx watch)
npm start             # Start server (tsx)
npx vitest run test/proxy.test.ts          # Run single test file
npx vitest run test/proxy.test.ts -t "returns response body"  # Run single test
```

## Architecture

BrowserRelay is a streaming HTTP relay over WebSocket. A local process sends HTTP requests through a browser's WebSocket connection, leveraging the browser's cookie/session context (e.g., SSO-protected intranets).

```
Local Process (curl) ──HTTP POST /proxy──> Relay Server ──Binary WS──> Browser ──fetch()──> Target
                                         <──PassThrough── <──frame-router── <────────────── <────
```

### Key Files

- **`src/index.ts`** — Entry point, reads `PORT` env (default 3000)
- **`src/server.ts`** — Fastify setup, registers routes + websocket + static files
- **`src/ws/protocol.ts`** — Binary frame codec. Frame layout: `[type:1B][requestId:16B][payload...]`. Types: REQUEST_START/CHUNK/END (0x01-03), RESPONSE_START/CHUNK/END (0x11-13), ABORT (0x21), ACK (0x30), PING/PONG (0x40-41)
- **`src/ws/ws-handler.ts`** — WS connection handler: validates one-time wsToken, enforces binary frames, 30s heartbeat
- **`src/ws/frame-router.ts`** — Dispatches incoming WS frames to the correct pending request by requestId
- **`src/proxy/proxy-handler.ts`** — POST /proxy endpoint. Streams request body as REQUEST_CHUNK frames with backpressure (256KB window). Streams response back via PassThrough. Custom headers: X-Proxy-Session, X-Proxy-Method, X-Proxy-URL, X-Proxy-Headers
- **`src/session/SessionManager.ts`** — In-memory sessions with pending request tracking. Auto-cleanup after 24h inactivity
- **`src/routes/login.ts`** — POST /login creates session, returns sessionId + one-time wsToken
- **`public/index.html`** — Browser-side UI, vanilla JS, implements full binary protocol client with backpressure ACK

### Data Flow

1. Local process POSTs to `/proxy` with target URL/method/headers
2. Server creates a `PendingRequest` and sends `REQUEST_START` + `REQUEST_CHUNK`s + `REQUEST_END` to browser via WS
3. Browser receives frames, makes real `fetch()` to target, sends back `RESPONSE_START` + `RESPONSE_CHUNK`s + `RESPONSE_END`
4. `frame-router` dispatches chunks to the pending request's `_writeChunk` which writes to a `PassThrough` stream
5. `reply.send(stream)` pipes the response back to the local process with chunked transfer encoding

### Backpressure (upload direction only)

Upload uses a sliding window: `bytesInFlight += chunk.length` on each send, pauses HTTP stream when `bytesInFlight >= windowSize (256KB)`, resumes on ACK frame from browser. Download direction has no backpressure yet.

## Testing

72 tests across 9 files using Vitest. Tests simulate browser clients via raw WebSocket connections sending/receiving binary protocol frames.

- **Unit tests** (`test/*.test.ts`) use `fastify.inject()` for HTTP + simulated WS clients
- **Backpressure tests** (`test/backpressure.test.ts`) use real HTTP connections (`http.request` / `fetch`)
- **Integration tests** (`test/integration/full-relay.test.ts`) spin up a mock HTTP target + full relay chain

## Constants

- `PROXY_TIMEOUT_MS`: 30s — proxy request timeout
- `HEARTBEAT_INTERVAL_MS`: 30s — WS ping/pong interval
- `DEFAULT_WINDOW_SIZE`: 256KB — backpressure window
