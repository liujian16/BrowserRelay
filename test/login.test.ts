import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { loginRoute } from '../src/routes/login.js';
import { SessionManager } from '../src/session/SessionManager.js';

describe('POST /login', () => {
  let fastify: Fastify.FastifyInstance;
  let sm: SessionManager;

  beforeEach(async () => {
    fastify = Fastify({ logger: false });
    sm = new SessionManager();
    await fastify.register(cookie);
    fastify.post('/login', loginRoute(sm));
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('returns sessionId and wsToken', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/login',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.wsToken).toBeTruthy();
    expect(typeof body.sessionId).toBe('string');
    expect(typeof body.wsToken).toBe('string');
  });

  it('creates a valid session in SessionManager', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/login',
    });

    const { sessionId } = response.json();
    const session = sm.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe(sessionId);
    expect(session!.wsConnection).toBeNull();
  });

  it('sets sessionId cookie', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/login',
    });

    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('sessionId=');
  });

  it('returns different sessionId on each call', async () => {
    const r1 = await fastify.inject({ method: 'POST', url: '/login' });
    const r2 = await fastify.inject({ method: 'POST', url: '/login' });
    const id1 = r1.json().sessionId;
    const id2 = r2.json().sessionId;
    expect(id1).not.toBe(id2);
  });
});
