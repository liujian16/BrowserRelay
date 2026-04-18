import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import { SessionManager } from '../src/session/SessionManager.js';
import { wsHandler } from '../src/ws/ws-handler.js';
import { encodePing, encodePong, decodeFrame, MessageType } from '../src/ws/protocol.js';

describe('GET /ws', () => {
  let fastify: Fastify.FastifyInstance;
  let sm: SessionManager;
  let port: number;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    sm = new SessionManager();
    await fastify.register(websocket);
    await fastify.register(cookie);
    fastify.get('/ws', { websocket: true }, wsHandler(sm));
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const addr = fastify.addresses()[0];
    port = typeof addr === 'string' ? 3000 : addr.port;
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('connects with valid token', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });

  it('rejects connection with invalid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=invalid-token`);

    await new Promise<void>((resolve) => {
      ws.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws.on('error', () => {
        // Connection may error before close
      });
    });
  });

  it('rejects reused token', async () => {
    const session = sm.createSession();
    // First connection consumes the token
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve) => {
      ws1.on('open', () => { ws1.close(); resolve(); });
    });

    // Second connection with same token should fail
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);
    await new Promise<void>((resolve) => {
      ws2.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
      ws2.on('error', () => {});
    });
  });

  it('responds to PING with PONG', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);

    const pongPromise = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(data);
        if (frame.type === MessageType.PONG) {
          resolve();
        }
      });
    });

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(encodePing());
        resolve();
      });
    });

    await pongPromise;
    ws.close();
  });

  it('binds WebSocket to session', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);

    await new Promise<void>((resolve) => {
      ws.on('open', () => resolve());
    });

    // Session should now have a ws connection
    const s = sm.getSession(session.sessionId);
    expect(s!.wsConnection).not.toBeNull();

    ws.close();
  });

  it('unbinds WebSocket on disconnect', async () => {
    const session = sm.createSession();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${session.wsToken}`);

    await new Promise<void>((resolve) => {
      ws.on('open', () => resolve());
    });

    ws.close();

    // Wait for close to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    const s = sm.getSession(session.sessionId);
    expect(s!.wsConnection).toBeNull();
  });
});
