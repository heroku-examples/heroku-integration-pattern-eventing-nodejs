'use strict';

// import fp from 'fastify-plugin';
import crypto from 'node:crypto';
import redisClient from '../services/redis.js'; // Import Redis client
import config from '../config/index.js'; // Import config for URLs/Tokens/Channel
import fetch from 'node-fetch'; // For Heroku Integration API call

// In-memory buffer and timeout management
const transactionBuffer = new Map(); // Stores { transactionKey: [recordId1, recordId2...] }
const transactionTimeouts = new Map(); // Stores { transactionKey: timeoutId }
const FLUSH_TIMEOUT_MS = 15000;

// --- Fastify Plugin --- //

async function generateQuotes(fastify, _options) {
  fastify.post('/generatequotes', async (request, reply) => {
    fastify.log.info('Received POST request on /api/generatequotes');
    // 1. CloudEvent Parsing
    let recordIds = [];
    let transactionKey = null;
    try {
      if (!request.body || typeof request.body !== 'object') {
        throw new Error('Request body is missing or not an object.');
      }
      const changeEventHeader = request.body?.data?.ChangeEventHeader;
      recordIds = changeEventHeader?.recordIds ?? [];
      transactionKey = changeEventHeader?.transactionKey ?? null;
      if (!transactionKey || recordIds.length === 0) {
        fastify.log.warn(
          { body: request.body },
          'Could not extract transactionKey or recordIds from CloudEvent. Skipping processing.'
        );
        return reply.code(204).send();
      }
      fastify.log.info(
        { transactionKey, recordCount: recordIds.length },
        'Successfully parsed CloudEvent'
      );
    } catch (error) {
      fastify.log.error(
        { err: error, body: request.body },
        'Failed to parse CloudEvent'
      );
      return reply.code(204).send();
    }
    // 2. Event Buffering
    try {
      // Get current buffer or initialize if new key
      const currentBuffer = transactionBuffer.get(transactionKey) || [];
      currentBuffer.push(...recordIds); // Add new record IDs
      transactionBuffer.set(transactionKey, currentBuffer);
      fastify.log.info(
        {
          transactionKey,
          addedCount: recordIds.length,
          totalBuffered: currentBuffer.length,
        },
        'Added records to transaction buffer'
      );
      // Clear existing timeout for this key if it exists
      if (transactionTimeouts.has(transactionKey)) {
        clearTimeout(transactionTimeouts.get(transactionKey));
        fastify.log.debug(
          { transactionKey },
          'Cleared existing flush timeout.'
        );
      }
      // Set a new timeout to flush this transaction buffer
      const timeoutId = setTimeout(() => {
        // Pass fastify.log instance to the flush function
        flushTransaction(transactionKey, fastify.log);
      }, FLUSH_TIMEOUT_MS);
      transactionTimeouts.set(transactionKey, timeoutId);
      fastify.log.info(
        { transactionKey, timeout: FLUSH_TIMEOUT_MS },
        'Set new flush timeout for transaction'
      );
    } catch (error) {
      // Catch errors during buffering (e.g., unexpected issues with Map)
      fastify.log.error(
        { err: error, transactionKey },
        'Error during event buffering logic'
      );
      // Still return 204 as parsing likely succeeded
      return reply.code(204).send();
    }
    // 3. Immediately acknowledge receipt
    return reply.code(204).send();
  });
}

export default generateQuotes;

// --- Helper Functions ---

async function fetchHerokuIntegrationCredentials(logger) {
  logger.info('Attempting to fetch Heroku Integration credentials...');
  const apiUrl = config.HEROKU_INTEGRATION_API_URL;
  const apiToken = config.HEROKU_INTEGRATION_TOKEN;
  const connectionNamesValue = config.CONNECTION_NAMES; // Use CONNECTION_NAMES
  if (!apiUrl || !apiToken || !connectionNamesValue) {
    // Check connectionNamesValue
    logger.error(
      'Missing Heroku Integration API URL, Token, or Connection Name (CONNECTION_NAMES) in config.' // Updated message
    );
    throw new Error('Heroku Integration configuration is incomplete.');
  }

  // Ensure URL ends with /invocations/authorization
  const endpoint = apiUrl.endsWith('/invocations/authorization')
    ? apiUrl
    : `${apiUrl}/invocations/authorization`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ org_name: connectionNamesValue }), // Use connectionNamesValue for org_name
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
        },
        'Failed to fetch Heroku Integration credentials'
      );
      throw new Error(
        `Heroku Integration API request failed: ${response.status} ${response.statusText}`
      );
    }

    const credentials = await response.json();
    logger.info('Successfully fetched Heroku Integration credentials.');
    return credentials;
  } catch (error) {
    logger.error({ err: error }, 'Error calling Heroku Integration API');
    // Rethrow to prevent job enqueueing without credentials
    throw error;
  }
}

async function enqueueJob(
  transactionKey,
  aggregatedRecordIds,
  credentials,
  logger
) {
  const jobId = crypto.randomUUID();
  const jobPayload = {
    jobId: jobId,
    transactionKey: transactionKey,
    recordIds: aggregatedRecordIds,
    // Embed necessary auth details directly (matching org-job-nodejs pattern)
    // Reconstruct the nested structure expected by the worker's ContextImpl
    context: {
      // requestId: jobId, // Optional: Could use jobId as requestId if needed by ContextImpl
      org: {
        accessToken: credentials.access_token,
        instanceUrl: credentials.org_domain_url,
        domainUrl: credentials.org_domain_url,
        ...(credentials.api_version && { apiVersion: credentials.api_version }),
        id: credentials.org_id,
        namespace: '', // Assuming no namespace for now
        user: {
          id: credentials.user_id, // User ID - Adjust key based on actual API response
          username: credentials.user_context?.username, // Username (Optional chaining if user_context might be absent)
        },
      },
    },
  };

  logger.info(
    { jobPayloadBeingSent: jobPayload },
    'Job payload structure before stringify:'
  );
  try {
    const payloadString = JSON.stringify(jobPayload);
    await redisClient.publish(config.redisJobChannel, payloadString);
    logger.info(
      { jobId, transactionKey, recordCount: aggregatedRecordIds.length },
      `Successfully published job to Redis channel '${config.redisJobChannel}'`
    );
  } catch (error) {
    logger.error(
      { err: error, jobId, transactionKey },
      'Failed to publish job to Redis'
    );
    // Decide if this should be retried or logged as a critical failure
  }
}

// Function to process and enqueue buffered events for a transaction key
async function flushTransaction(transactionKey, logger) {
  logger.info({ transactionKey }, 'Flushing transaction buffer...');

  // Clear the timeout associated with this key first
  if (transactionTimeouts.has(transactionKey)) {
    clearTimeout(transactionTimeouts.get(transactionKey));
    transactionTimeouts.delete(transactionKey);
  }

  // Get the buffered record IDs
  const aggregatedRecordIds = transactionBuffer.get(transactionKey);

  if (!aggregatedRecordIds || aggregatedRecordIds.length === 0) {
    logger.warn(
      { transactionKey },
      'Flush called but no records found in buffer. Cleaning up.'
    );
    transactionBuffer.delete(transactionKey); // Clean up buffer entry
    return;
  }

  try {
    // 1. Fetch Credentials
    const credentials = await fetchHerokuIntegrationCredentials(logger);

    // 2. Enqueue Job
    await enqueueJob(transactionKey, aggregatedRecordIds, credentials, logger);
  } catch (error) {
    // Errors during credential fetch or enqueueing are logged within those functions
    logger.error(
      { err: error, transactionKey },
      'Failed to process transaction flush due to credential or Redis error.'
    );
    // Depending on requirements, might implement retry or move to dead-letter queue
  } finally {
    // 3. Clean up buffer for this transaction key regardless of success/failure
    transactionBuffer.delete(transactionKey);
    logger.info({ transactionKey }, 'Cleaned up transaction buffer entry.');
  }
}
