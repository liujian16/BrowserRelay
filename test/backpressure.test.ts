import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import http from 'node:http';
import { SessionManager } from '../src/session/SessionManager.js';
import { wsHandler } from '../src/ws/ws-handler.js';
import { proxyHandler } from '../src/proxy/proxy-handler.js';
import {
  decodeFrame,
  MessageType,
  encodeResponseStart,
  encodeResponseChunk,
  encodeResponseEnd,
  encodeAck,
  encodeAbort,
} from '../src/ws/protocol.js';

/**
 * Helper: create a relay server for backpressure tests.
 * Uses real HTTP connections (not inject) for streaming body support.
 */
async function createTestRelay() {
  const fastify = Fastify({ logger: false });
  const sm = new SessionManager();
  await fastify.register(websocket);
  await fastify.register(cookie);
  fastify.get('/ws', { websocket: true }, wsHandler(sm));
  fastify.register(proxyHandler(sm));
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const addr = fastify.addresses()[0];
  const port = typeof addr === 'string' ? 3000 : addr.port;
  return { fastify, sm, port };
}

describe('Backpressure', () => {
  let ctx: Awaited<ReturnType<typeof createTestRelay>>;

  beforeEach(async () => {
    ctx = await createTestRelay();
  });

  afterEach(async () => {
    await ctx.fastify.close();
  });

  it('tracks bytesInFlight and pauses when window is exceeded', async () => {
    const session = ctx.sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Create a real HTTP request with streaming body
    const req = http.request({
      hostname: '127.0.0.1',
      port: ctx.port,
      path: '/proxy',
      method: 'POST',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'POST',
        'X-Proxy-URL': 'https://example.com/upload',
        'X-Proxy-Headers': '{}',
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      },
    });

    // Collect frames on WS side
    const frames: ReturnType<typeof decodeFrame>[] = [];
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      frames.push(frame);
    });

    // Write data larger than window (256KB)
    const chunkSize = 64 * 1024; // 64KB
    const largeData = Buffer.alloc(chunkSize, 0x42);

    // Write several chunks
    req.write(largeData); // 64KB -> bytesInFlight: 64KB
    req.write(largeData); // 128KB
    req.write(largeData); // 192KB
    req.write(largeData); // 256KB -> should pause

    // Wait a bit for frames to arrive
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that REQUEST_CHUNK frames were received
    const chunkFrames = frames.filter(f => f.type === MessageType.REQUEST_CHUNK);
    expect(chunkFrames.length).toBeGreaterThan(0);

    // Check that the pending request has bytesInFlight set
    const s = ctx.sm.getSession(session.sessionId);
    const pendingRequests = Array.from(s!.pendingRequests.values());
    expect(pendingRequests.length).toBe(1);

    const pending = pendingRequests[0];
    expect(pending.bytesInFlight).toBeGreaterThan(0);

    // Now send ACK to release backpressure
    const requestId = pending.requestIdBytes;
    ws.send(encodeAck(requestId, 256 * 1024)); // ACK 256KB

    // Write more data
    req.write(largeData); // Should work after ACK
    req.end();

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should have received more chunk frames
    const chunkFramesAfter = frames.filter(f => f.type === MessageType.REQUEST_CHUNK);
    expect(chunkFramesAfter.length).toBeGreaterThan(chunkFrames.length);

    // Should have REQUEST_END
    const endFrames = frames.filter(f => f.type === MessageType.REQUEST_END);
    expect(endFrames.length).toBe(1);

    ws.close();

    // Gracefully end the request instead of destroying it
    await new Promise(resolve => {
      req.on('close', resolve);
      req.end();
    }).catch(() => {});
  });
});

describe('Error handling', () => {
  let ctx: Awaited<ReturnType<typeof createTestRelay>>;

  beforeEach(async () => {
    ctx = await createTestRelay();
  });

  afterEach(async () => {
    await ctx.fastify.close();
  });

  it('ABORT frame causes 502 response', async () => {
    const session = ctx.sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // When we get REQUEST_START, immediately abort
    const abortPromise = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(data);
        if (frame.type === MessageType.REQUEST_START) {
          ws.send(encodeAbort(frame.requestId, 'Target server error'));
          resolve();
        }
      });
    });

    const responsePromise = fetch(`http://127.0.0.1:${ctx.port}/proxy`, {
      method: 'POST',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': 'https://example.com/api',
        'X-Proxy-Headers': '{}',
      },
    });

    await abortPromise;
    const response = await responsePromise;
    expect(response.status).toBe(502);

    const body = await response.text();
    expect(body).toContain('Target server error');

    ws.close();
  });

  it('timeout returns 504 when browser does not respond', async () => {
    const session = ctx.sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Set a very short timeout for this test
    // We'll use the pending request's timeout directly
    const frames: ReturnType<typeof decodeFrame>[] = [];
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      frames.push(frame);
    });

    // Start proxy request but don't respond
    const responsePromise = fetch(`http://127.0.0.1:${ctx.port}/proxy`, {
      method: 'POST',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': 'https://example.com/api',
        'X-Proxy-Headers': '{}',
      },
    });

    // Manually trigger timeout by expiring the pending request
    await new Promise(resolve => setTimeout(resolve, 100));

    const s = ctx.sm.getSession(session.sessionId);
    const pending = Array.from(s!.pendingRequests.values())[0];
    expect(pending).toBeDefined();

    // Simulate timeout
    pending.reject(new Error('Proxy request timeout'));

    const response = await responsePromise;
    expect(response.status).toBe(504);

    ws.close();
  });

  it('WS disconnect during proxy returns 502', async () => {
    const session = ctx.sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Start proxy request
    const responsePromise = fetch(`http://127.0.0.1:${ctx.port}/proxy`, {
      method: 'POST',
      headers: {
        'X-Proxy-Session': session.sessionId,
        'X-Proxy-Method': 'GET',
        'X-Proxy-URL': 'https://example.com/api',
        'X-Proxy-Headers': '{}',
      },
    });

    // Wait for REQUEST_START to be sent
    await new Promise(resolve => setTimeout(resolve, 100));

    // Disconnect browser
    ws.close();

    const response = await responsePromise;
    expect([502, 504]).toContain(response.status);

    ws.close();
  });
});
