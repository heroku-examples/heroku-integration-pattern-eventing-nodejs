'use strict';

import Redis from 'ioredis';
import config from '../config/index.js'; // Adjust path to our config

// Create a new Redis client instance
// It will automatically use the REDIS_URL from the environment if available,
// otherwise, it falls back to the default provided in the config.
const redisClient = new Redis(config.redisUrl, {
  // Use our config.redisUrl
  // Add TLS options for Heroku Redis connections
  // Required for hobby/premium tier Redis on Heroku
  // Set rejectUnauthorized to false for self-signed certs (often needed for local testing against Heroku Redis)
  // Consider making this conditional based on NODE_ENV or REDIS_URL contents in production
  tls: {
    rejectUnauthorized: false,
  },
  // Keep alive settings
  keepAlive: 1000 * 30, // Send keepalive probe every 30 seconds.
  // Retry strategy (optional but recommended)
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000); // Exponential backoff up to 2 seconds
    console.warn(
      `Redis connection attempt ${times} failed, retrying in ${delay}ms`
    );
    return delay;
  },
  maxRetriesPerRequest: 3, // Optional: Limit retries for individual commands
});

redisClient.on('connect', () => {
  // Use Fastify logger if available, otherwise console
  const log = global.fastify?.log || console;
  log.info('🔌 Connected to Redis successfully.');
});

redisClient.on('error', (error) => {
  // Use Fastify logger if available, otherwise console
  const log = global.fastify?.log || console;
  log.error({ err: error }, '❌ Redis connection error:');
});

// Export the client instance for use in other parts of the application
export default redisClient;
