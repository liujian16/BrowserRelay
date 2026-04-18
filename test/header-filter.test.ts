import { describe, it, expect } from 'vitest';
import { filterForbiddenHeaders } from '../src/util/header-filter.js';

describe('filterForbiddenHeaders', () => {
  it('strips Host header', () => {
    const result = filterForbiddenHeaders({ Host: 'example.com', Accept: '*/*' });
    expect(result).toEqual({ Accept: '*/*' });
  });

  it('strips Content-Length header', () => {
    const result = filterForbiddenHeaders({ 'Content-Length': '1234', 'Content-Type': 'text/html' });
    expect(result).toEqual({ 'Content-Type': 'text/html' });
  });

  it('strips Connection header', () => {
    const result = filterForbiddenHeaders({ Connection: 'keep-alive', Accept: 'application/json' });
    expect(result).toEqual({ Accept: 'application/json' });
  });

  it('strips hop-by-hop headers', () => {
    const result = filterForbiddenHeaders({
      'Proxy-Authorization': 'Bearer xyz',
      'Keep-Alive': 'timeout=5',
      'Transfer-Encoding': 'chunked',
      'TE': 'trailers',
      'Trailer': 'X-Foo',
      'Upgrade': 'websocket',
    });
    expect(result).toEqual({});
  });

  it('strips headers case-insensitively', () => {
    const result = filterForbiddenHeaders({
      'host': 'example.com',
      'content-length': '999',
      'CONTENT-LENGTH': '888',
    });
    expect(result).toEqual({});
  });

  it('preserves allowed headers', () => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Authorization': 'Bearer token',
      'X-Custom-Header': 'value',
      'Cookie': 'session=abc',
    };
    const result = filterForbiddenHeaders(headers);
    expect(result).toEqual(headers);
  });

  it('handles empty headers', () => {
    const result = filterForbiddenHeaders({});
    expect(result).toEqual({});
  });

  it('strips sec-websocket headers', () => {
    const result = filterForbiddenHeaders({
      'Sec-WebSocket-Key': 'abc',
      'Sec-WebSocket-Version': '13',
      'Accept': 'text/html',
    });
    expect(result).toEqual({ Accept: 'text/html' });
  });
});
