/**
 * /proxy route handler — streams HTTP request body to browser via WebSocket binary frames,
 * and streams the response back.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionManager } from '../session/SessionManager.js';
import {
  encodeRequestStart,
  encodeRequestChunk,
  encodeRequestEnd,
} from '../ws/protocol.js';
import { filterForbiddenHeaders } from '../util/header-filter.js';
import { PROXY_TIMEOUT_MS } from '../util/constants.js';

export function proxyHandler(sm: SessionManager) {
  return async (fastify: FastifyInstance) => {
    // Accept text-like content types as string
    fastify.addContentTypeParser(['text/plain', 'application/json', 'text/html'], { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
    // For binary/unknown content types, don't parse — use raw stream
    fastify.addContentTypeParser(/^/, (_req, _payload, done) => {
      done(null, null);
    });

    fastify.all('/proxy', async (request: FastifyRequest, reply: FastifyReply) => {
      // Validate headers
      const sessionId = request.headers['x-proxy-session'] as string | undefined;
      const targetMethod = (request.headers['x-proxy-method'] as string) || 'GET';
      const targetUrl = request.headers['x-proxy-url'] as string | undefined;
      const targetHeadersRaw = request.headers['x-proxy-headers'] as string | undefined;

      if (!sessionId) {
        return reply.code(400).send({ error: 'Missing X-Proxy-Session header' });
      }
      if (!targetUrl) {
        return reply.code(400).send({ error: 'Missing X-Proxy-URL header' });
      }

      // Find session
      const session = sm.getSession(sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }

      if (!session.wsConnection || session.wsConnection.readyState !== 1) {
        return reply.code(503).send({ error: 'Browser not connected' });
      }

      // Parse and filter target headers
      let targetHeaders: Record<string, string> = {};
      if (targetHeadersRaw) {
        try {
          targetHeaders = JSON.parse(targetHeadersRaw);
        } catch {
          return reply.code(400).send({ error: 'Invalid X-Proxy-Headers JSON' });
        }
      }
      targetHeaders = filterForbiddenHeaders(targetHeaders);

      // Generate requestId
      const requestId = randomUUID();
      const requestIdBytes = Buffer.from(requestId.replace(/-/g, ''), 'hex');

      const ws = session.wsConnection;

      // Create promises for response lifecycle
      const responseStarted = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          reject(new Error('Proxy request timeout'));
        }, PROXY_TIMEOUT_MS);

        const chunks: Buffer[] = [];
        let responseInfo: { status: number; headers: Record<string, string> } | null = null;

        const pending = {
          requestIdBytes,
          requestId,
          resolve: (_value: unknown) => {
            if (responseInfo) resolve(responseInfo);
          },
          reject: (reason: unknown) => {
            clearTimeout(timeoutHandle);
            reject(reason);
          },
          timeoutHandle,
          bytesInFlight: 0,
          windowSize: 256 * 1024,
          paused: false,
          responseResolve: (_value: unknown) => {
            clearTimeout(timeoutHandle);
          },
          responseHeaders: null as Record<string, string> | null,
          responseStatus: null as number | null,
          abortController: new AbortController(),
          _chunks: chunks,
          _ended: false,
          _endResolve: () => {},
          _responseInfo: responseInfo,
          _setResponseInfo: (info: { status: number; headers: Record<string, string> }) => {
            responseInfo = info;
            resolve(info);
          },
          _resume: () => {},
        };

        sm.addPendingRequest(sessionId, pending);
      });

      // Send REQUEST_START
      ws.send(encodeRequestStart(requestIdBytes, targetMethod, targetUrl, targetHeaders));

      // Stream body as REQUEST_CHUNK frames
      const pendingReq = sm.getPendingRequest(sessionId, requestId);
      const body = request.body as string | undefined;

      if (typeof body === 'string' && body.length > 0) {
        // Buffered body (from inject or small requests)
        ws.send(encodeRequestChunk(requestIdBytes, Buffer.from(body)));
        ws.send(encodeRequestEnd(requestIdBytes));
      } else if (typeof body === 'string') {
        // Empty body
        ws.send(encodeRequestEnd(requestIdBytes));
      } else {
        // No parsed body — stream from raw request (large uploads with backpressure)
        const rawReq = request.raw;

        if (pendingReq) {
          (pendingReq as any)._resume = () => rawReq.resume();
        }

        rawReq.on('data', (chunk: Buffer) => {
          if (!ws || ws.readyState !== 1) return;
          ws.send(encodeRequestChunk(requestIdBytes, chunk));

          if (pendingReq) {
            pendingReq.bytesInFlight += chunk.length;
            if (pendingReq.bytesInFlight >= pendingReq.windowSize && !pendingReq.paused) {
              pendingReq.paused = true;
              rawReq.pause();
            }
          }
        });

        rawReq.on('end', () => {
          if (ws && ws.readyState === 1) {
            ws.send(encodeRequestEnd(requestIdBytes));
          }
        });
      }

      // Wait for response start from browser
      try {
        const { status, headers } = await responseStarted;

        // Wait for all chunks and end
        const pending = sm.getPendingRequest(sessionId, requestId);
        const allChunksReceived = new Promise<void>((resolve) => {
          if (pending && (pending as any)._ended) {
            resolve();
          } else if (pending) {
            (pending as any)._endResolve = resolve;
          }
        });

        await allChunksReceived;

        // Get final chunks
        const finalPending = sm.getPendingRequest(sessionId, requestId);
        const chunks: Buffer[] = (finalPending as any)?._chunks ?? [];

        // Send response
        const filteredHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          if (!['transfer-encoding', 'connection', 'keep-alive'].includes(lower)) {
            filteredHeaders[key] = value;
          }
        }

        return reply.code(status).headers(filteredHeaders).send(Buffer.concat(chunks));
      } catch (err: any) {
        sm.removePendingRequest(sessionId, requestId);
        if (err.message === 'Proxy request timeout') {
          return reply.code(504).send({ error: 'Gateway timeout' });
        }
        return reply.code(502).send({ error: err.message || 'Proxy error' });
      } finally {
        sm.removePendingRequest(sessionId, requestId);
      }
    });
  };
}
