/**
 * WebSocket route handler for /ws endpoint.
 */

import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { SessionManager } from '../session/SessionManager.js';
import { decodeFrame, MessageType, encodePong } from './protocol.js';
import { routeFrame } from './frame-router.js';
import { HEARTBEAT_INTERVAL_MS } from '../util/constants.js';

export function wsHandler(sm: SessionManager) {
  return (socket: WebSocket, request: FastifyRequest) => {
    const token = (request.query as Record<string, string>).token;

    // Validate token
    const session = sm.consumeWsToken(token);
    if (!session) {
      socket.close(4001, 'Invalid or expired token');
      return;
    }

    // Bind WebSocket to session
    sm.bindWebSocket(session.sessionId, socket);

    // Binary-only enforcement
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        socket.close(4002, 'Only binary frames are allowed');
        return;
      }

      const frame = decodeFrame(data);

      if (frame.type === MessageType.PONG) {
        // Pong reply to our heartbeat — ignore
        return;
      }

      if (frame.type === MessageType.PING) {
        // Browser sends protocol PING — reply with PONG
        socket.send(encodePong());
        return;
      }

      // Route all other frames (RESPONSE_*, ABORT, ACK) to pending requests
      routeFrame(sm, session.sessionId, frame);
    });

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (socket.readyState === 1) {
        // PING is sent by the server; browser should reply PONG
        // We rely on the ws library's built-in ping/pong for keepalive
        socket.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Cleanup on close
    socket.on('close', () => {
      clearInterval(heartbeat);
      sm.unbindWebSocket(session.sessionId);
    });

    socket.on('error', () => {
      clearInterval(heartbeat);
      sm.unbindWebSocket(session.sessionId);
    });
  };
}
