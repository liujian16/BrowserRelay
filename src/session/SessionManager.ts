/**
 * In-memory session store for BrowserRelay.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Session, PendingRequest } from './types.js';
import { MAX_SESSION_AGE_MS } from '../util/constants.js';

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Map wsToken -> sessionId for one-time token lookup */
  private tokenToSession = new Map<string, string>();

  /**
   * Create a new session with a unique sessionId and one-time wsToken.
   */
  createSession(): Session {
    const sessionId = randomUUID();
    const wsToken = randomUUID();

    const session: Session = {
      sessionId,
      wsToken,
      wsConnection: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      pendingRequests: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.tokenToSession.set(wsToken, sessionId);
    return session;
  }

  /**
   * Consume a one-time wsToken. Returns the session if valid, null otherwise.
   * The token is invalidated after use.
   */
  consumeWsToken(token: string): Session | null {
    const sessionId = this.tokenToSession.get(token);
    if (!sessionId) return null;

    // One-time use: remove the token
    this.tokenToSession.delete(token);

    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastActivity = Date.now();
    return session;
  }

  /**
   * Get a session by its sessionId.
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Bind a WebSocket connection to a session.
   */
  bindWebSocket(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.wsConnection = ws;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Unbind the WebSocket from a session and reject all pending requests.
   */
  unbindWebSocket(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.wsConnection = null;

    // Reject all pending requests
    for (const [requestId, pending] of session.pendingRequests) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(new Error('WebSocket disconnected'));
      session.pendingRequests.delete(requestId);
    }
  }

  /**
   * Add a pending request to a session.
   */
  addPendingRequest(sessionId: string, pending: PendingRequest): PendingRequest | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.pendingRequests.set(pending.requestId, pending);
    return pending;
  }

  /**
   * Get a pending request from a session.
   */
  getPendingRequest(sessionId: string, requestId: string): PendingRequest | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.pendingRequests.get(requestId) ?? null;
  }

  /**
   * Remove a pending request from a session.
   */
  removePendingRequest(sessionId: string, requestId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const pending = session.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutHandle);
      session.pendingRequests.delete(requestId);
    }
  }

  /**
   * Destroy sessions older than MAX_SESSION_AGE_MS that have no active WS.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (
        session.wsConnection === null &&
        now - session.lastActivity > MAX_SESSION_AGE_MS
      ) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
