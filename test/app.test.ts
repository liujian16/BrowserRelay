import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { appRoute } from '../src/routes/app.js';
import { SessionManager } from '../src/session/SessionManager.js';

describe('POST /app', () => {
  let fastify: Fastify.FastifyInstance;
  let sm: SessionManager;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    sm = new SessionManager();
    await fastify.register(cookie);
    fastify.post('/app', appRoute(sm));
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('returns status for valid session', async () => {
    const session = sm.createSession();
    const response = await fastify.inject({
      method: 'POST',
      url: '/app',
      cookies: { sessionId: session.sessionId },
      body: { command: 'status' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.connected).toBe(false);
  });

  it('returns connected=true when WS is bound', async () => {
    const session = sm.createSession();
    sm.bindWebSocket(session.sessionId, { readyState: 1 } as any);
    const response = await fastify.inject({
      method: 'POST',
      url: '/app',
      cookies: { sessionId: session.sessionId },
      body: { command: 'status' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connected).toBe(true);
  });

  it('returns 401 for missing session cookie', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/app',
      body: { command: 'status' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for invalid session', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/app',
      cookies: { sessionId: 'nonexistent' },
      body: { command: 'status' },
    });

    expect(response.statusCode).toBe(401);
  });
});
