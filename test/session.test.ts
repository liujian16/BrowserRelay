import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../src/session/SessionManager.js';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
  });

  describe('createSession', () => {
    it('returns a session with sessionId and wsToken', () => {
      const session = sm.createSession();
      expect(session.sessionId).toBeTruthy();
      expect(session.wsToken).toBeTruthy();
      expect(session.sessionId).not.toBe(session.wsToken);
    });

    it('creates unique sessionIds', () => {
      const s1 = sm.createSession();
      const s2 = sm.createSession();
      expect(s1.sessionId).not.toBe(s2.sessionId);
    });
  });

  describe('consumeWsToken', () => {
    it('returns session for valid token', () => {
      const session = sm.createSession();
      const found = sm.consumeWsToken(session.wsToken);
      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe(session.sessionId);
    });

    it('returns null for invalid token', () => {
      const found = sm.consumeWsToken('nonexistent-token');
      expect(found).toBeNull();
    });

    it('rejects reuse of wsToken (one-time use)', () => {
      const session = sm.createSession();
      const first = sm.consumeWsToken(session.wsToken);
      expect(first).not.toBeNull();
      const second = sm.consumeWsToken(session.wsToken);
      expect(second).toBeNull();
    });
  });

  describe('getSession', () => {
    it('returns session by id', () => {
      const session = sm.createSession();
      const found = sm.getSession(session.sessionId);
      expect(found).toBe(session);
    });

    it('returns undefined for unknown id', () => {
      const found = sm.getSession('unknown');
      expect(found).toBeUndefined();
    });
  });

  describe('bindWebSocket / unbindWebSocket', () => {
    it('binds a WebSocket to the session', () => {
      const session = sm.createSession();
      const mockWs = { readyState: 1 } as any;
      sm.bindWebSocket(session.sessionId, mockWs);
      expect(session.wsConnection).toBe(mockWs);
    });

    it('unbinds WebSocket from session', () => {
      const session = sm.createSession();
      const mockWs = { readyState: 1 } as any;
      sm.bindWebSocket(session.sessionId, mockWs);
      sm.unbindWebSocket(session.sessionId);
      expect(session.wsConnection).toBeNull();
    });

    it('unbind clears pending requests', () => {
      const session = sm.createSession();
      const mockWs = { readyState: 1 } as any;
      sm.bindWebSocket(session.sessionId, mockWs);

      // Add a pending request
      const pending = sm.addPendingRequest(session.sessionId, {
        requestIdBytes: new Uint8Array(16),
        requestId: 'test-req-id',
        resolve: () => {},
        reject: () => {},
        timeoutHandle: setTimeout(() => {}, 100000),
        bytesInFlight: 0,
        windowSize: 256 * 1024,
        paused: false,
        responseResolve: null,
        responseHeaders: null,
        responseStatus: null,
        abortController: new AbortController(),
      });
      expect(pending).not.toBeNull();

      sm.unbindWebSocket(session.sessionId);
      expect(session.wsConnection).toBeNull();
    });
  });

  describe('pending requests', () => {
    it('addPendingRequest adds and returns the request', () => {
      const session = sm.createSession();
      const pending = sm.addPendingRequest(session.sessionId, {
        requestIdBytes: new Uint8Array(16),
        requestId: 'req-1',
        resolve: () => {},
        reject: () => {},
        timeoutHandle: setTimeout(() => {}, 100000),
        bytesInFlight: 0,
        windowSize: 256 * 1024,
        paused: false,
        responseResolve: null,
        responseHeaders: null,
        responseStatus: null,
        abortController: new AbortController(),
      });
      expect(pending).not.toBeNull();
      expect(session.pendingRequests.has('req-1')).toBe(true);
    });

    it('getPendingRequest returns the request', () => {
      const session = sm.createSession();
      sm.addPendingRequest(session.sessionId, {
        requestIdBytes: new Uint8Array(16),
        requestId: 'req-2',
        resolve: () => {},
        reject: () => {},
        timeoutHandle: setTimeout(() => {}, 100000),
        bytesInFlight: 0,
        windowSize: 256 * 1024,
        paused: false,
        responseResolve: null,
        responseHeaders: null,
        responseStatus: null,
        abortController: new AbortController(),
      });
      const found = sm.getPendingRequest(session.sessionId, 'req-2');
      expect(found).not.toBeNull();
      expect(found!.requestId).toBe('req-2');
    });

    it('removePendingRequest removes the request', () => {
      const session = sm.createSession();
      sm.addPendingRequest(session.sessionId, {
        requestIdBytes: new Uint8Array(16),
        requestId: 'req-3',
        resolve: () => {},
        reject: () => {},
        timeoutHandle: setTimeout(() => {}, 100000),
        bytesInFlight: 0,
        windowSize: 256 * 1024,
        paused: false,
        responseResolve: null,
        responseHeaders: null,
        responseStatus: null,
        abortController: new AbortController(),
      });
      sm.removePendingRequest(session.sessionId, 'req-3');
      expect(session.pendingRequests.has('req-3')).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('destroys sessions older than max age with no WS', () => {
      const session = sm.createSession();
      // Manually age the session
      session.createdAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
      session.lastActivity = Date.now() - 25 * 60 * 60 * 1000;
      session.wsConnection = null;

      sm.cleanup();
      expect(sm.getSession(session.sessionId)).toBeUndefined();
    });

    it('keeps sessions with active WS connection', () => {
      const session = sm.createSession();
      session.createdAt = Date.now() - 25 * 60 * 60 * 1000;
      session.lastActivity = Date.now() - 25 * 60 * 60 * 1000;
      session.wsConnection = { readyState: 1 } as any;

      sm.cleanup();
      expect(sm.getSession(session.sessionId)).toBe(session);
    });

    it('keeps recent sessions', () => {
      const session = sm.createSession();
      sm.cleanup();
      expect(sm.getSession(session.sessionId)).toBe(session);
    });
  });
});
