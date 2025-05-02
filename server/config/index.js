'use strict';

// Note: process.env.NODE_ENV is set by Heroku by default.
// Locally, it will be undefined unless set in the environment or .env file.
const nodeEnv = process.env.NODE_ENV || 'development';
if (nodeEnv === 'development') {
  // In development, load .env file if it exists.
  // In production (Heroku), config vars are set directly.
  // The `dotenv/config` import in index.js and worker.js handles this.
}

const config = {
  nodeEnv,
  port: process.env.PORT || 8080,
  host: process.env.HOST || '0.0.0.0',
  logLevel:
    process.env.LOG_LEVEL || (nodeEnv === 'development' ? 'debug' : 'info'),
  // Redis Config
  redisUrl: process.env.REDIS_URL, // Standard Redis URL (use rediss:// scheme for TLS)
  redisJobChannel: process.env.REDIS_JOB_CHANNEL || 'quoteQueue',
  // Heroku Integration (for fetching run-as-user credentials)
  HEROKU_INTEGRATION_API_URL: process.env.HEROKU_INTEGRATION_API_URL,
  HEROKU_INTEGRATION_TOKEN: process.env.HEROKU_INTEGRATION_TOKEN,
  CONNECTION_NAMES: process.env.CONNECTION_NAMES, // Org Alias/Connection Name
  // Heroku Eventing (for publishing platform events via Event Bus)
  HEROKUEVENTS_PUBLISH_URL: process.env.HEROKUEVENTS_PUBLISH_URL, // Includes basic auth credentials
};

export default config;
