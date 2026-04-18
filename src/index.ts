import { createServer } from './server.js';

async function start() {
  const fastify = createServer();

  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    console.log('BrowserRelay server listening on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
