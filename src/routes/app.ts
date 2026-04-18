/**
 * POST /app — session-validated command dispatch.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { SessionManager } from '../session/SessionManager.js';

export function appRoute(sm: SessionManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies.sessionId;

    if (!sessionId) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }

    const session = sm.getSession(sessionId);
    if (!session) {
      return reply.code(401).send({ error: 'Invalid session' });
    }

    const body = request.body as { command?: string } | undefined;
    const command = body?.command ?? 'status';

    switch (command) {
      case 'status':
        return reply.send({
          status: 'ok',
          connected: session.wsConnection !== null && session.wsConnection.readyState === 1,
          pendingRequests: session.pendingRequests.size,
        });

      default:
        return reply.code(400).send({ error: `Unknown command: ${command}` });
    }
  };
}
