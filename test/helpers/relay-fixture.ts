/**
 * Test fixture for BrowserRelay integration tests.
 * Provides helpers to create a relay server, mock HTTP target, and simulated browser WS client.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import http from 'node:http';

export interface RelayServerResult {
  fastify: FastifyInstance;
  port: number;
  close: () => Promise<void>;
}

/**
 * Create a Fastify relay server on a random port.
 * Registers websocket plugin. Caller registers routes before calling listen.
 */
export function createRelayServer(): RelayServerResult {
  const fastify = Fastify({ logger: false });
  fastify.register(websocket);

  const result: RelayServerResult = {
    fastify,
    port: 0,
    close: async () => {
      await fastify.close();
    },
  };

  // Patch: listen on random port after routes are registered
  const originalListen = fastify.listen.bind(fastify);
  (fastify as any).listenAndWait = async () => {
    await originalListen({ port: 0, host: '127.0.0.1' });
    const address = fastify.addresses()[0];
    result.port = typeof address === 'string' ? 3000 : address.port;
  };

  return result;
}

export interface MockTargetResult {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Buffer;
  }>;
}

/**
 * Create a mock HTTP target server that echoes requests back.
 */
export function createMockTarget(): Promise<MockTargetResult> {
  return new Promise((resolve, reject) => {
    const requests: MockTargetResult['requests'] = [];

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value.join(', ');
        }
        requests.push({ method: req.method!, url: req.url!, headers, body });

        // Echo back the request info as JSON response
        const echo = JSON.stringify({
          method: req.method,
          url: req.url,
          headers,
          bodyLength: body.length,
          body: body.toString('utf-8'),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Mock-Target': 'true',
        });
        res.end(echo);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()!;
      const port = typeof addr === 'string' ? 3001 : addr.port;
      resolve({
        server,
        port,
        close: () => new Promise((res) => server.close(() => res(undefined))),
        requests,
      });
    });

    server.on('error', reject);
  });
}

/**
 * Simulated browser client that connects via WS and handles proxy_request frames
 * by forwarding to a mock target, then streams responses back.
 *
 * This is a placeholder — will be implemented in integration test steps.
 */
export { WebSocket as BrowserSim } from 'ws';
