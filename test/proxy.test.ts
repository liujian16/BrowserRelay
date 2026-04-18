import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import { SessionManager } from '../src/session/SessionManager.js';
import { wsHandler } from '../src/ws/ws-handler.js';
import { proxyHandler } from '../src/proxy/proxy-handler.js';
import {
  decodeFrame,
  MessageType,
  encodeResponseStart,
  encodeResponseChunk,
  encodeResponseEnd,
} from '../src/ws/protocol.js';

describe('/proxy upload direction', () => {
  let fastify: Fastify.FastifyInstance;
  let sm: SessionManager;
  let port: number;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    sm = new SessionManager();
    await fastify.register(websocket);
    await fastify.register(cookie);
    fastify.get('/ws', { websocket: true }, wsHandler(sm));
    fastify.register(proxyHandler(sm));
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const addr = fastify.addresses()[0];
    port = typeof addr === 'string' ? 3000 : addr.port;
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('sends REQUEST_START frame with correct method and URL', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const startFrame = new Promise<ReturnType<typeof decodeFrame>>((resolve) => {
      ws.once('message', (data: Buffer) => {
        resolve(decodeFrame(data));
      });
    });

    // Don't await inject — handler blocks on responsePromise
    fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': 'https://example.com/api/test',
        'X-Proxy-Headers': JSON.stringify({ Accept: 'application/json' }),
      },
      body: '',
    });

    const frame = await startFrame;
    expect(frame.type).toBe(MessageType.REQUEST_START);
    expect(frame.method).toBe('GET');
    expect(frame.url).toBe('https://example.com/api/test');
    expect(frame.headers).toEqual({ Accept: 'application/json' });
    ws.close();
  });

  it('sends REQUEST_CHUNK frames for body data', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const frames: ReturnType<typeof decodeFrame>[] = [];
    const allReceived = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(data);
        frames.push(frame);
        if (frame.type === MessageType.REQUEST_END) {
          resolve();
        }
      });
    });

    fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'POST',
        'X-Proxy-URL': 'https://example.com/api',
        'X-Proxy-Headers': '{}',
        'Content-Type': 'text/plain',
      },
      body: 'hello world body',
    });

    await allReceived;

    const types = frames.map(f => f.type);
    expect(types).toContain(MessageType.REQUEST_START);
    expect(types).toContain(MessageType.REQUEST_CHUNK);
    expect(types).toContain(MessageType.REQUEST_END);

    const chunks = frames
      .filter(f => f.type === MessageType.REQUEST_CHUNK)
      .map(f => Buffer.from(f.data!));
    const combined = Buffer.concat(chunks).toString('utf-8');
    expect(combined).toBe('hello world body');
    ws.close();
  });

  it('sends REQUEST_END after body is complete', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    const endFrame = new Promise<ReturnType<typeof decodeFrame>>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(data);
        if (frame.type === MessageType.REQUEST_END) {
          resolve(frame);
        }
      });
    });

    fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': 'https://example.com/api',
        'X-Proxy-Headers': '{}',
      },
      body: '',
    });

    const frame = await endFrame;
    expect(frame.type).toBe(MessageType.REQUEST_END);
    ws.close();
  });

  it('returns 400 when X-Proxy-Session is missing', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-URL': 'https://example.com',
        'X-Proxy-Method': 'GET',
      },
      body: '',
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 when session not found', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': 'nonexistent-session',
        'X-Proxy-URL': 'https://example.com',
        'X-Proxy-Method': 'GET',
      },
      body: '',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 503 when session has no WS connection', async () => {
    const session = sm.createSession();
    const response = await fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-URL': 'https://example.com',
        'X-Proxy-Method': 'GET',
      },
      body: '',
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('/proxy response streaming', () => {
  let fastify: Fastify.FastifyInstance;
  let sm: SessionManager;
  let port: number;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    sm = new SessionManager();
    await fastify.register(websocket);
    await fastify.register(cookie);
    fastify.get('/ws', { websocket: true }, wsHandler(sm));
    fastify.register(proxyHandler(sm));
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const addr = fastify.addresses()[0];
    port = typeof addr === 'string' ? 3000 : addr.port;
  });

  afterEach(async () => {
    await fastify.close();
  });

  /**
   * Helper: simulate browser that responds to proxy requests.
   * Listens for REQUEST_START on WS, extracts requestId,
   * then sends RESPONSE_START + chunks + RESPONSE_END back.
   */
  async function createBrowserSimAndProxy(opts: {
    responseBody: string;
    responseStatus?: number;
    responseHeaders?: Record<string, string>;
  }) {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // When we get REQUEST_START, respond with mock data
    const requestReceived = new Promise<Uint8Array>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(data);
        if (frame.type === MessageType.REQUEST_START) {
          const requestId = frame.requestId;

          // Send response
          const status = opts.responseStatus ?? 200;
          const headers = opts.responseHeaders ?? { 'Content-Type': 'text/plain' };
          ws.send(encodeResponseStart(requestId, status, headers));

          // Send body chunks
          const body = opts.responseBody;
          if (body.length > 0) {
            ws.send(encodeResponseChunk(requestId, Buffer.from(body)));
          }
          ws.send(encodeResponseEnd(requestId));
          resolve(requestId);
        }
      });
    });

    // Fire the proxy request
    const injectPromise = fastify.inject({
      method: 'POST',
      url: '/proxy',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': 'https://example.com/api',
        'X-Proxy-Headers': '{}',
      },
      body: '',
    });

    const response = await injectPromise;
    return { response, ws, session, requestReceived };
  }

  it('returns response status from browser', async () => {
    const { response, ws } = await createBrowserSimAndProxy({
      responseBody: 'OK',
      responseStatus: 200,
    });
    expect(response.statusCode).toBe(200);
    ws.close();
  });

  it('returns response body from browser', async () => {
    const { response, ws } = await createBrowserSimAndProxy({
      responseBody: 'Hello from target!',
    });
    expect(response.body).toBe('Hello from target!');
    ws.close();
  });

  it('returns response headers from browser', async () => {
    const { response, ws } = await createBrowserSimAndProxy({
      responseBody: 'test',
      responseHeaders: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
    });
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-custom']).toBe('value');
    ws.close();
  });

  it('handles 404 response from browser', async () => {
    const { response, ws } = await createBrowserSimAndProxy({
      responseBody: 'Not Found',
      responseStatus: 404,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('Not Found');
    ws.close();
  });

  it('handles empty response body', async () => {
    const { response, ws } = await createBrowserSimAndProxy({
      responseBody: '',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    ws.close();
  });
});
