/**
 * BrowserRelay server setup and plugin registration.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './session/SessionManager.js';
import { wsHandler } from './ws/ws-handler.js';
import { proxyHandler } from './proxy/proxy-handler.js';
import { loginRoute } from './routes/login.js';
import { appRoute } from './routes/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer(): FastifyInstance {
  const fastify = Fastify({ logger: true });
  const sm = new SessionManager();

  fastify.register(websocket);
  fastify.register(cookie);

  // Static file serving for browser UI
  fastify.register(staticPlugin, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
    decorateReply: false,
  });

  // Routes
  fastify.post('/login', loginRoute(sm));
  fastify.post('/app', appRoute(sm));

  // WebSocket route MUST be registered inside a plugin context
  // for @fastify/websocket to properly detect websocket: true
  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, wsHandler(sm));
  });

  fastify.register(proxyHandler(sm));

  return fastify;
}
