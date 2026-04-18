/**
 * Filter out forbidden/unsafe HTTP headers before proxying.
 *
 * Strips hop-by-hop headers, WebSocket headers, and other headers
 * that browsers will reject or that should not be forwarded.
 */

/** Headers to strip, all lowercase for case-insensitive matching */
const FORBIDDEN_HEADERS = new Set([
  // Hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Content-Length is managed by the transport
  'content-length',
  // Host should not be forwarded
  'host',
  // WebSocket headers
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'sec-websocket-accept',
]);

/**
 * Filter forbidden headers from a headers object.
 * Returns a new object with only allowed headers.
 */
export function filterForbiddenHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
