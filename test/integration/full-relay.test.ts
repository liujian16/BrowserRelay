import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import http from 'node:http';
import { SessionManager } from '../../src/session/SessionManager.js';
import { wsHandler } from '../../src/ws/ws-handler.js';
import { proxyHandler } from '../../src/proxy/proxy-handler.js';
import { loginRoute } from '../../src/routes/login.js';
import {
  decodeFrame,
  MessageType,
  encodeResponseStart,
  encodeResponseChunk,
  encodeResponseEnd,
  encodeRequestStart,
  encodeRequestChunk,
  encodeRequestEnd,
} from '../../src/ws/protocol.js';
import { filterForbiddenHeaders } from '../../src/util/header-filter.js';

/**
 * Full relay integration test:
 * LocalProcess -> /proxy -> WS -> BrowserSim -> MockTarget -> response back
 */

describe('Full relay integration', () => {
  let relayServer: Fastify.FastifyInstance;
  let mockTarget: http.Server;
  let mockTargetPort: number;
  let sm: SessionManager;
  let relayPort: number;

  beforeEach(async () => {
    // Set up mock target HTTP server
    mockTarget = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value.join(', ');
        }

        // Echo back request info
        const echo = JSON.stringify({
          method: req.method,
          url: req.url,
          headers,
          bodyLength: body.length,
          body: body.toString('utf-8'),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Mock-Target': 'true',
        });
        res.end(echo);
      });
    });

    await new Promise<void>((resolve) => {
      mockTarget.listen(0, '127.0.0.1', () => {
        const addr = mockTarget.address()!;
        mockTargetPort = typeof addr === 'number' ? addr : addr.port;
        resolve();
      });
    });

    // Set up relay server
    relayServer = Fastify({ logger: false });
    sm = new SessionManager();
    await relayServer.register(websocket);
    await relayServer.register(cookie);
    relayServer.get('/ws', { websocket: true }, wsHandler(sm));
    relayServer.post('/login', loginRoute(sm));
    relayServer.register(proxyHandler(sm));
    await relayServer.listen({ port: 0, host: '127.0.0.1' });
    const addr = relayServer.addresses()[0];
    relayPort = typeof addr === 'string' ? 3000 : addr.port;
  });

  afterEach(async () => {
    await relayServer.close();
    await new Promise<void>((resolve) => mockTarget.close(() => resolve()));
  });

  /**
   * Simulate a browser that:
   * 1. Connects via WS
   * 2. On receiving REQUEST_START, makes a real HTTP request to mock target
   * 3. Streams the target's response back via WS
   */
  async function createBrowserSim(sessionId: string, wsToken: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?token=${wsToken}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);

      if (frame.type === MessageType.REQUEST_START) {
        const requestId = frame.requestId;
        const method = frame.method!;
        const url = frame.url!;
        const headers = frame.headers ?? {};

        // Make the actual HTTP request to the mock target
        const targetUrl = new URL(url);
        const targetHeaders = { ...headers, host: `127.0.0.1:${mockTargetPort}` };

        const options: http.RequestOptions = {
          hostname: '127.0.0.1',
          port: mockTargetPort,
          path: targetUrl.pathname + targetUrl.search,
          method,
          headers: targetHeaders,
        };

        const targetReq = http.request(options, (targetRes) => {
          // Send RESPONSE_START
          const resHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(targetRes.headers)) {
            if (typeof value === 'string') resHeaders[key] = value;
            else if (Array.isArray(value)) resHeaders[key] = value.join(', ');
          }
          ws.send(encodeResponseStart(requestId, targetRes.statusCode ?? 200, resHeaders));

          // Stream response chunks
          targetRes.on('data', (chunk: Buffer) => {
            ws.send(encodeResponseChunk(requestId, chunk));
          });

          targetRes.on('end', () => {
            ws.send(encodeResponseEnd(requestId));
          });
        });

        targetReq.on('error', (err) => {
          ws.send(encodeResponseStart(requestId, 502, { 'X-Error': err.message }));
          ws.send(encodeResponseEnd(requestId));
        });

        // Send body chunks as they arrive
        if (frame.type === MessageType.REQUEST_START) {
          // Collect body from subsequent REQUEST_CHUNK frames
          const bodyChunks: Buffer[] = [];

          const chunkHandler = (data: Buffer) => {
            const f = decodeFrame(data);
            if (f.type === MessageType.REQUEST_CHUNK &&
                Buffer.from(f.requestId).equals(Buffer.from(requestId))) {
              bodyChunks.push(Buffer.from(f.data!));
            } else if (f.type === MessageType.REQUEST_END &&
                Buffer.from(f.requestId).equals(Buffer.from(requestId))) {
              ws.off('message', chunkHandler);
              if (bodyChunks.length > 0) {
                targetReq.write(Buffer.concat(bodyChunks));
              }
              targetReq.end();
            }
          };

          ws.on('message', chunkHandler);
        }
      }
    });

    return ws;
  }

  it('performs full relay: proxy -> WS -> target -> response', async () => {
    // Step 1: Login
    const loginResponse = await relayServer.inject({
      method: 'POST',
      url: '/login',
    });
    const { sessionId, wsToken } = loginResponse.json();

    // Step 2: Connect browser sim
    const browserWs = await createBrowserSim(sessionId, wsToken);

    // Step 3: Send proxy request to mock target
    const targetUrl = `http://127.0.0.1:${mockTargetPort}/test-path?foo=bar`;
    const response = await relayServer.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': targetUrl,
        'X-Proxy-Headers': JSON.stringify({ Accept: 'application/json' }),
      },
      body: '',
    });

    // Step 4: Verify response
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.method).toBe('GET');
    expect(body.url).toBe('/test-path?foo=bar');
    expect(body.headers.accept).toBe('application/json');

    browserWs.close();
  });

  it('relays POST with body data', async () => {
    const loginResponse = await relayServer.inject({
      method: 'POST',
      url: '/login',
    });
    const { sessionId, wsToken } = loginResponse.json();
    const browserWs = await createBrowserSim(sessionId, wsToken);

    const targetUrl = `http://127.0.0.1:${mockTargetPort}/submit`;
    const response = await relayServer.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': sessionId,
        'X-Proxy-Method': 'POST',
        'X-Proxy-URL': targetUrl,
        'X-Proxy-Headers': JSON.stringify({ 'Content-Type': 'text/plain' }),
        'Content-Type': 'text/plain',
      },
      body: 'request body data',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.method).toBe('POST');
    expect(body.body).toBe('request body data');

    browserWs.close();
  });

  it('relays target error responses', async () => {
    // Create a target that returns 500
    const errorTarget = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });
    await new Promise<void>((resolve) => {
      errorTarget.listen(0, '127.0.0.1', () => resolve());
    });
    const errorAddr = errorTarget.address()!;
    const errorPort = typeof errorAddr === 'number' ? errorAddr : errorAddr.port;

    const loginResponse = await relayServer.inject({
      method: 'POST',
      url: '/login',
    });
    const { sessionId, wsToken } = loginResponse.json();

    // Browser sim that routes to error target
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?token=${wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      if (frame.type === MessageType.REQUEST_START) {
        const rid = frame.requestId;

        const targetReq = http.request({
          hostname: '127.0.0.1',
          port: errorPort,
          path: '/',
          method: 'GET',
        }, (targetRes) => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(targetRes.headers)) {
            if (typeof value === 'string') headers[key] = value;
          }
          ws.send(encodeResponseStart(rid, targetRes.statusCode ?? 500, headers));

          targetRes.on('data', (chunk: Buffer) => {
            ws.send(encodeResponseChunk(rid, chunk));
          });
          targetRes.on('end', () => {
            ws.send(encodeResponseEnd(rid));
          });
        });

        targetReq.end();
      }
    });

    const response = await relayServer.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': `http://127.0.0.1:${errorPort}/`,
        'X-Proxy-Headers': '{}',
      },
      body: '',
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('Internal Server Error');

    ws.close();
    await new Promise<void>((resolve) => errorTarget.close(() => resolve()));
  });
});
