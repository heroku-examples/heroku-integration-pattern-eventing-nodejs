import 'dotenv/config'; // Load .env file into process.env
('use strict');

import Fastify from 'fastify';
import fastifySensible from '@fastify/sensible';
import config from './config/index.js';
import generateQuotes from './routes/api.js';

// Initialize Fastify with logger level from environment (or default)
const fastify = Fastify({
  logger: {
    level: config.logLevel,
  },
});

// Add content type parser for CloudEvents
// Treat application/cloudevents+json as application/json
fastify.addContentTypeParser(
  'application/cloudevents+json',
  { parseAs: 'string' },
  (req, body, done) => {
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  }
);

// Register sensible plugin (adds useful decorators and error handlers)
fastify.register(fastifySensible);

// Simple health check route
fastify.get('/', async function handler(_request, _reply) {
  return { status: 'ok' };
});

// Register API routes with prefix
await fastify.register(generateQuotes, { prefix: '/api' });

// --- Server Start ---

const start = async () => {
  try {
    // Use port from loaded config
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    // Log level will be automatically updated by fastifyEnv if changed in .env
    fastify.log.info(
      `Server listening on port ${fastify.server.address().port}`
    );
    fastify.log.info(`Current NODE_ENV: ${config.nodeEnv}`);
    fastify.log.info(`Current LOG_LEVEL: ${fastify.log.level}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
