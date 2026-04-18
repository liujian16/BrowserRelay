/**
 * POST /login — create a new session.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { SessionManager } from '../session/SessionManager.js';

export function loginRoute(sm: SessionManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const session = sm.createSession();

    reply.setCookie('sessionId', session.sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
    });

    return reply.send({
      sessionId: session.sessionId,
      wsToken: session.wsToken,
    });
  };
}
