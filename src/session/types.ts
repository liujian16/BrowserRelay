/**
 * Session and PendingRequest type definitions.
 */

import type { WebSocket } from 'ws';

export interface PendingRequest {
  /** UUID bytes (16 bytes) for binary protocol */
  requestIdBytes: Uint8Array;
  /** String form of the UUID */
  requestId: string;
  /** Resolve the proxy HTTP response */
  resolve: (value: unknown) => void;
  /** Reject the proxy HTTP response */
  reject: (reason: unknown) => void;
  /** Timeout handle for the request */
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Bytes sent to WS but not yet ACKed */
  bytesInFlight: number;
  /** Window size for backpressure */
  windowSize: number;
  /** Whether the HTTP request stream is paused */
  paused: boolean;
  /** Resolve to signal response headers are ready */
  responseResolve: ((value: unknown) => void) | null;
  /** Response headers from browser */
  responseHeaders: Record<string, string> | null;
  /** Response status from browser */
  responseStatus: number | null;
  /** AbortController for cancelling */
  abortController: AbortController;
}

export interface Session {
  sessionId: string;
  wsToken: string;
  wsConnection: WebSocket | null;
  createdAt: number;
  lastActivity: number;
  pendingRequests: Map<string, PendingRequest>;
}
