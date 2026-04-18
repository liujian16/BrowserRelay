import { describe, it, expect } from 'vitest';
import {
  encodeRequestStart,
  encodeRequestChunk,
  encodeRequestEnd,
  encodeResponseStart,
  encodeResponseChunk,
  encodeResponseEnd,
  encodeAbort,
  encodeAck,
  encodePing,
  encodePong,
  decodeFrame,
  MessageType,
} from '../src/ws/protocol.js';

// Helper: generate a deterministic 16-byte requestId
function makeRequestId(seed: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(seed, 0);
  return buf;
}

const requestId = makeRequestId(0x01020304);

describe('protocol', () => {
  describe('REQUEST_START', () => {
    it('encodes and decodes round-trip', () => {
      const headers = { 'Content-Type': 'application/json', Accept: '*/*' };
      const frame = encodeRequestStart(requestId, 'POST', 'https://example.com/api', headers);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.REQUEST_START);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
      expect(decoded.method).toBe('POST');
      expect(decoded.url).toBe('https://example.com/api');
      expect(decoded.headers).toEqual(headers);
    });

    it('handles empty headers', () => {
      const frame = encodeRequestStart(requestId, 'GET', 'http://test.com', {});
      const decoded = decodeFrame(frame);
      expect(decoded.headers).toEqual({});
    });
  });

  describe('REQUEST_CHUNK', () => {
    it('encodes and decodes round-trip', () => {
      const data = Buffer.from('hello world');
      const frame = encodeRequestChunk(requestId, data);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.REQUEST_CHUNK);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
      expect(Buffer.from(decoded.data)).toEqual(data);
    });

    it('handles empty chunk', () => {
      const data = Buffer.alloc(0);
      const frame = encodeRequestChunk(requestId, data);
      const decoded = decodeFrame(frame);
      expect(decoded.data).toHaveLength(0);
    });
  });

  describe('REQUEST_END', () => {
    it('encodes and decodes round-trip', () => {
      const frame = encodeRequestEnd(requestId);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.REQUEST_END);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
    });
  });

  describe('RESPONSE_START', () => {
    it('encodes and decodes round-trip', () => {
      const headers = { 'Content-Type': 'text/html', 'X-Custom': 'value' };
      const frame = encodeResponseStart(requestId, 200, headers);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.RESPONSE_START);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
      expect(decoded.status).toBe(200);
      expect(decoded.headers).toEqual(headers);
    });

    it('handles various status codes', () => {
      for (const status of [200, 404, 500, 301, 204]) {
        const frame = encodeResponseStart(requestId, status, {});
        const decoded = decodeFrame(frame);
        expect(decoded.status).toBe(status);
      }
    });
  });

  describe('RESPONSE_CHUNK', () => {
    it('encodes and decodes round-trip', () => {
      const data = Buffer.from('response body chunk');
      const frame = encodeResponseChunk(requestId, data);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.RESPONSE_CHUNK);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
      expect(Buffer.from(decoded.data)).toEqual(data);
    });
  });

  describe('RESPONSE_END', () => {
    it('encodes and decodes round-trip', () => {
      const frame = encodeResponseEnd(requestId);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.RESPONSE_END);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
    });
  });

  describe('ABORT', () => {
    it('encodes and decodes round-trip', () => {
      const frame = encodeAbort(requestId, 'connection timeout');
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.ABORT);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
      expect(decoded.errorMessage).toBe('connection timeout');
    });
  });

  describe('ACK', () => {
    it('encodes and decodes round-trip', () => {
      const frame = encodeAck(requestId, 65536);
      const decoded = decodeFrame(frame);

      expect(decoded.type).toBe(MessageType.ACK);
      expect(Buffer.from(decoded.requestId)).toEqual(requestId);
      expect(decoded.windowBytes).toBe(65536);
    });
  });

  describe('PING/PONG', () => {
    it('PING encodes and decodes', () => {
      const frame = encodePing();
      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe(MessageType.PING);
    });

    it('PONG encodes and decodes', () => {
      const frame = encodePong();
      const decoded = decodeFrame(frame);
      expect(decoded.type).toBe(MessageType.PONG);
    });
  });

  describe('edge cases', () => {
    it('REQUEST_START handles large headers', () => {
      const headers: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        headers[`X-Header-${i}`] = `value-${i}`;
      }
      const frame = encodeRequestStart(requestId, 'GET', 'http://test.com', headers);
      const decoded = decodeFrame(frame);
      expect(decoded.headers).toEqual(headers);
    });

    it('REQUEST_CHUNK handles binary data', () => {
      const data = Buffer.alloc(1024);
      for (let i = 0; i < 1024; i++) data[i] = i & 0xff;
      const frame = encodeRequestChunk(requestId, data);
      const decoded = decodeFrame(frame);
      expect(Buffer.from(decoded.data)).toEqual(data);
    });

    it('decodeFrame handles unknown message type', () => {
      const frame = Buffer.alloc(17);
      frame[0] = 0xff; // unknown type
      frame.set(requestId, 1);
      expect(() => decodeFrame(frame)).toThrow(/unknown message type/i);
    });
  });
});
