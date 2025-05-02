'use strict';

import 'dotenv/config'; // Load .env file for standalone execution
import redisClient from './services/redis.js'; // Use the shared Redis client
import config from './config/index.js';
import { ContextImpl } from '@heroku/salesforce-sdk-nodejs/dist/sdk/context.js'; // Import specific path
import { calculateAndCreateQuotes } from './services/pricingService.js'; // <<< ADD_LINE

// Basic logger (can be enhanced later if needed)
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.log, // Map debug to log for now
};

logger.info('Worker process starting...');

// Subscribe to the configured Redis job channel
const jobChannel = config.redisJobChannel;

redisClient.subscribe(jobChannel, (err, count) => {
  if (err) {
    logger.error(`Failed to subscribe to Redis channel '${jobChannel}':`, err);
    process.exit(1);
  }
  logger.info(
    `Successfully subscribed to Redis channel '${jobChannel}'. Listening for jobs...`
  );
  logger.info(`Subscription count: ${count}`);
});

// Listen for messages on the subscribed channel
redisClient.on('message', async (channel, message) => {
  if (channel === jobChannel) {
    logger.info(`Received message on channel '${channel}'`);
    let jobData;
    try {
      // 1. Parse the message
      jobData = JSON.parse(message);
      // 2. Validate the payload structure (basic)
      if (
        !jobData ||
        !jobData.jobId ||
        !jobData.transactionKey ||
        !Array.isArray(jobData.recordIds) ||
        !jobData.context ||
        !jobData.context.org ||
        !jobData.context.org.accessToken ||
        !jobData.context.org.domainUrl ||
        !jobData.context.org.id ||
        !jobData.context.org.user?.id // Optional user ID check
      ) {
        throw new Error('Invalid or incomplete job payload structure.');
      }
      logger.info(
        `Processing job ID: ${jobData.jobId} for transaction: ${jobData.transactionKey}`
      );
      // 3. Reconstruct SDK Context
      const orgContext = jobData.context.org;
      const sfContext = new ContextImpl(
        orgContext.accessToken,
        orgContext.apiVersion, // Optional: Defaults if not provided?
        jobData.jobId, // Use jobId as requestId
        orgContext.namespace, // Optional: Defaults if not provided?
        orgContext.id, // Org ID
        orgContext.domainUrl, // Instance/Domain URL
        orgContext.user?.id, // User ID (optional)
        orgContext.user?.username // Username (optional)
      );
      logger.info(
        `Successfully reconstructed Salesforce context for Org ID: ${sfContext.org?.id}`
      ); // Use sfContext property
      // 4. Call the pricing service handler
      await calculateAndCreateQuotes(jobData, sfContext, logger);
      logger.info(`Finished processing job ID: ${jobData.jobId}`);
    } catch (error) {
      logger.error('Failed to parse or process job message:', error);
      logger.error(`Problematic message content: ${message}`);
    }
  }
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down worker...');
  try {
    // Unsubscribe before quitting
    await redisClient.unsubscribe(jobChannel);
    logger.info(`Unsubscribed from Redis channel '${jobChannel}'.`);
    await redisClient.quit();
    logger.info('Redis connection closed gracefully.');
    process.exit(0);
  } catch (error) {
    logger.error('Error during Redis shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info('Worker initialized and waiting for jobs.');
