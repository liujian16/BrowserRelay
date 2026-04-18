/**
 * Frame router — dispatch incoming WebSocket frames to the correct pending request.
 */

import type { SessionManager } from '../session/SessionManager.js';
import type { DecodedFrame } from './protocol.js';
import { MessageType } from './protocol.js';

/**
 * Handle a decoded frame from the browser.
 * Routes RESPONSE_START/CHUNK/END/ABORT/ACK frames to the correct pending request.
 */
export function routeFrame(
  sm: SessionManager,
  sessionId: string,
  frame: DecodedFrame,
): void {
  const session = sm.getSession(sessionId);
  if (!session) return;

  switch (frame.type) {
    case MessageType.RESPONSE_START: {
      const requestIdStr = bufferToUUID(frame.requestId);
      const pending = sm.getPendingRequest(sessionId, requestIdStr);
      if (!pending) return;

      const status = frame.status ?? 200;
      const headers = frame.headers ?? {};

      pending.responseStatus = status;
      pending.responseHeaders = headers;

      if (pending.responseResolve) {
        pending.responseResolve(null);
      }

      // Use _setResponseInfo if available (proxy-handler sets this)
      if ((pending as any)._setResponseInfo) {
        (pending as any)._setResponseInfo({ status, headers });
      } else {
        pending.resolve({ status, headers });
      }
      break;
    }

    case MessageType.RESPONSE_CHUNK: {
      const requestIdStr = bufferToUUID(frame.requestId);
      const pending = sm.getPendingRequest(sessionId, requestIdStr);
      if (!pending) return;

      if ((pending as any)._chunks) {
        (pending as any)._chunks.push(Buffer.from(frame.data!));
      }
      break;
    }

    case MessageType.RESPONSE_END: {
      const requestIdStr = bufferToUUID(frame.requestId);
      const pending = sm.getPendingRequest(sessionId, requestIdStr);
      if (!pending) return;

      (pending as any)._ended = true;

      if ((pending as any)._endResolve) {
        (pending as any)._endResolve();
      }
      break;
    }

    case MessageType.ABORT: {
      const requestIdStr = bufferToUUID(frame.requestId);
      const pending = sm.getPendingRequest(sessionId, requestIdStr);
      if (!pending) return;

      pending.reject(new Error(frame.errorMessage || 'Request aborted'));
      sm.removePendingRequest(sessionId, requestIdStr);
      break;
    }

    case MessageType.ACK: {
      const requestIdStr = bufferToUUID(frame.requestId);
      const pending = sm.getPendingRequest(sessionId, requestIdStr);
      if (!pending) break;

      // Decrease bytes in flight by the acknowledged window size
      pending.bytesInFlight -= frame.windowBytes ?? 0;
      if (pending.bytesInFlight < 0) pending.bytesInFlight = 0;

      // Resume if paused and below window
      if (pending.paused && pending.bytesInFlight < pending.windowSize) {
        pending.paused = false;
        // Resume the HTTP request stream
        const session = sm.getSession(sessionId);
        // We need access to the raw request to resume it
        // This is handled by the pending request's stored reference
        if ((pending as any)._resume) {
          (pending as any)._resume();
        }
      }
      break;
    }
  }
}

/** Convert 16-byte requestId to UUID string format */
export function bufferToUUID(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
