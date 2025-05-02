'use strict';
import fetch from 'node-fetch'; // Added for Heroku Eventing
import { URL } from 'node:url'; // Added to parse credentials from Eventing URL
import config from '../config/index.js'; // Import config

async function calculateAndCreateQuotes(jobData, sfContext, logger) {
  logger.info(
    {
      jobId: jobData.jobId,
      transactionKey: jobData.transactionKey,
      recordIds: jobData.recordIds,
      orgId: sfContext.org?.id, // Example of accessing context
    },
    '[pricingService.calculateAndCreateQuotes] Called successfully.'
  );

  // --- Implement SOQL queries for Opportunity and OpportunityLineItems ---
  if (!jobData.recordIds || jobData.recordIds.length === 0) {
    logger.warn(
      { jobId: jobData.jobId },
      '[pricingService.calculateAndCreateQuotes] No record IDs provided in job data. Skipping query.'
    );
    return { status: 'NO_RECORDS', message: 'No record IDs to process.' };
  }

  // Construct the IN clause for the SOQL query
  const formattedRecordIds = jobData.recordIds.map((id) => `'${id}'`).join(',');
  const soqlQuery =
    `SELECT Id, Name, AccountId, StageName, Pricebook2Id, ` + // Added Pricebook2Id for Quote
    `(SELECT Id, Product2Id, Quantity, UnitPrice, PricebookEntryId FROM OpportunityLineItems) ` +
    `FROM Opportunity WHERE Id IN (${formattedRecordIds})`;
  logger.info(
    { jobId: jobData.jobId, query: soqlQuery },
    '[pricingService.calculateAndCreateQuotes] Executing SOQL query'
  );

  let opportunities;
  try {
    const queryResult = await sfContext.org.dataApi.query(soqlQuery);
    opportunities = queryResult?.records || []; // records is an array of Opportunity SObjects
    logger.info(
      { jobId: jobData.jobId, count: opportunities.length },
      '[pricingService.calculateAndCreateQuotes] Successfully queried Opportunity records.'
    );
  } catch (error) {
    logger.error(
      { jobId: jobData.jobId, err: error },
      '[pricingService.calculateAndCreateQuotes] Error during SOQL query'
    );
    // Rethrow or handle as a job failure
    throw error; // Or return a status indicating failure
  }

  // --- Implement pricing calculations ---
  const DISCOUNT_RATE = 0.1; // 10% discount

  if (opportunities && opportunities.length > 0) {
    logger.info(
      { jobId: jobData.jobId },
      '[pricingService.calculateAndCreateQuotes] Applying pricing calculations...'
    );
    opportunities.forEach((oppSObject) => {
      // Access fields via .fields property
      const oppFields = oppSObject.fields;
      // Access subquery results correctly
      const lineItemsResult = oppSObject.subQueryResults?.OpportunityLineItems;
      // Check if OpportunityLineItems relationship exists and has records
      if (lineItemsResult?.records && lineItemsResult.records.length > 0) {
        lineItemsResult.records.forEach((oliSObject) => {
          // Access line item fields via .fields
          const lineItemFields = oliSObject.fields;
          const originalPrice = lineItemFields.UnitPrice;
          // Ensure UnitPrice is a number before calculating
          if (typeof originalPrice === 'number') {
            // Calculate discounted price
            // Store calculated price directly on the fields object for later use by UoW
            lineItemFields.calculatedPrice =
              originalPrice * (1 - DISCOUNT_RATE);
          } else {
            logger.warn(
              {
                jobId: jobData.jobId,
                oppId: oppFields.Id,
                lineItemId: lineItemFields.Id,
                unitPrice: originalPrice,
              },
              'Skipping discount for line item with non-numeric UnitPrice'
            );
            // Set calculatedPrice to original if not numeric, or handle as error?
            lineItemFields.calculatedPrice = originalPrice;
          }
        });
      } else {
        logger.info(
          { jobId: jobData.jobId, oppId: oppFields.Id },
          'Opportunity has no line items, skipping calculation for this Opp.'
        );
      }
    });
  } else {
    logger.info(
      { jobId: jobData.jobId },
      '[pricingService.calculateAndCreateQuotes] No opportunities returned from query, skipping calculations.'
    );
  }

  // --- Implement Unit of Work to prepare Quote and QuoteLineItems ---
  const uow = sfContext.org.dataApi.newUnitOfWork();
  const quoteRefs = new Map(); // To store references for linking
  let quoteLineItemCount = 0;
  logger.info(
    { jobId: jobData.jobId },
    '[pricingService.calculateAndCreateQuotes] Initializing Unit of Work...'
  );
  if (opportunities && opportunities.length > 0) {
    opportunities.forEach((oppSObject) => {
      const oppFields = oppSObject.fields;
      const oppId = oppFields.Id; // Use the correct ID from fields
      const lineItemsResult = oppSObject.subQueryResults?.OpportunityLineItems;

      // Check for Pricebook2Id, essential for creating Quotes
      if (!oppFields.Pricebook2Id) {
        logger.warn(
          { jobId: jobData.jobId, oppId },
          `Opportunity ${oppId} is missing Pricebook2Id. Skipping Quote creation.`
        );
        return; // Skip this Opportunity
      }
      // Check if line items exist for this Opportunity
      if (!lineItemsResult?.records || lineItemsResult.records.length === 0) {
        logger.warn(
          { jobId: jobData.jobId, oppId },
          `Opportunity ${oppId} has no line items to process for Quote. Skipping Quote creation.`
        );
        return; // Skip this Opportunity
      }
      try {
        // 1. Register Quote Create
        const quoteName =
          `Quote for ${oppFields.Name || 'Opportunity'}`.substring(0, 80);
        // Simple ExpirationDate: Today + 30 days
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + 30);
        const quoteRef = uow.registerCreate({
          type: 'Quote',
          fields: {
            Name: quoteName,
            OpportunityId: oppId,
            Pricebook2Id: oppFields.Pricebook2Id,
            ExpirationDate: expirationDate.toISOString().split('T')[0],
            Status: 'Draft',
          },
        });
        quoteRefs.set(oppId, quoteRef); // Store ref keyed by Opp ID

        // 2. Register QuoteLineItem Create for each OpportunityLineItem
        lineItemsResult.records.forEach((oliSObject) => {
          const lineItemFields = oliSObject.fields;
          // Ensure calculatedPrice exists from previous step
          if (typeof lineItemFields.calculatedPrice !== 'number') {
            logger.warn(
              {
                jobId: jobData.jobId,
                oppId,
                lineItemId: lineItemFields.Id,
              },
              'Missing calculatedPrice for QuoteLineItem. Skipping registration.'
            );
            return; // Skip this line item
          }
          // Ensure PricebookEntryId exists
          if (!lineItemFields.PricebookEntryId) {
            logger.warn(
              {
                jobId: jobData.jobId,
                oppId,
                lineItemId: lineItemFields.Id,
              },
              'Missing PricebookEntryId for QuoteLineItem. Skipping registration.'
            );
            return; // Skip this line item
          }
          uow.registerCreate({
            type: 'QuoteLineItem',
            fields: {
              QuoteId: quoteRef.toApiString(), // Link to the registered Quote
              PricebookEntryId: lineItemFields.PricebookEntryId,
              Quantity: lineItemFields.Quantity,
              UnitPrice: lineItemFields.calculatedPrice, // Use the price calculated earlier
              // Product2Id: lineItemFields.Product2Id, // Optional, often not needed if PBE is set
            },
          });
          quoteLineItemCount++;
        });
      } catch (err) {
        logger.error(
          { jobId: jobData.jobId, oppId, err },
          `Error registering UoW operations for Opportunity ${oppId}`
        );
        // Potentially remove the quoteRef for this opp if registration failed partially?
        quoteRefs.delete(oppId);
      }
    });
  } // End of opportunities loop
  logger.info(
    {
      jobId: jobData.jobId,
      quoteCount: quoteRefs.size,
      lineItemCount: quoteLineItemCount,
    },
    '[pricingService.calculateAndCreateQuotes] Finished registering Unit of Work operations.'
  );

  // Commit Unit of Work
  if (quoteRefs.size > 0 || quoteLineItemCount > 0) {
    logger.info(
      { jobId: jobData.jobId },
      '[pricingService.calculateAndCreateQuotes] Committing Unit of Work...'
    );
    try {
      const commitResult = await sfContext.org.dataApi.commitUnitOfWork(uow);
      logger.info(
        { jobId: jobData.jobId, commitResult },
        '[pricingService.calculateAndCreateQuotes] Unit of Work committed successfully.'
      );
      // Platform Event publishing upon successful commit
      await publishQuoteCompletionEvent(
        jobData,
        sfContext,
        commitResult,
        logger
      );
      logger.info(
        `[pricingService.calculateAndCreateQuotes] Processing complete for job ID: ${jobData.jobId}`
      );
      return {
        status: 'SUCCESS',
        message: 'Unit of Work committed successfully.',
        commitResult,
      };
    } catch (err) {
      logger.error(
        { jobId: jobData.jobId, err },
        '[pricingService.calculateAndCreateQuotes] Error committing Unit of Work'
      );
      // Propagate the error so the worker can handle it (e.g., retry, DLQ)
      throw err;
    }
  } else {
    logger.info(
      { jobId: jobData.jobId },
      '[pricingService.calculateAndCreateQuotes] No operations to commit in Unit of Work. Skipping commit.'
    );
    return {
      status: 'NO_OPERATIONS',
      message: 'No operations to commit.',
    };
  }
}

async function publishQuoteCompletionEvent(
  jobData,
  sfContext,
  details,
  logger
) {
  logger.info(
    { jobId: jobData.jobId, transactionKey: jobData.transactionKey, details },
    '[pricingService.publishQuoteCompletionEvent] Attempting to publish platform event.'
  );
  const eventPayload = {};
  // 1. Add CreatedById from the Salesforce context
  eventPayload.CreatedById = sfContext.org.user.id;
  // 2. Add CreatedDate as epoch milliseconds
  eventPayload.CreatedDate = Date.now();
  // 3. Construct Status__c object (always represents success now)
  let statusMessage = 'Unknown Status'; // Default, should be overwritten
  let createdCount = 0;
  // Calculate count from commitResult (details)
  if (details && typeof details.get === 'function') {
    // Check if it's a Map
    details.forEach((saveResult) => {
      // If the result has an ID, assume success for this context
      if (saveResult && saveResult.id) {
        createdCount++;
      }
    });
    statusMessage = `Quotes Generated: ${createdCount}`;
  }
  eventPayload.Status__c = { string: statusMessage }; // Nested object format

  try {
    // Use config object for consistency
    const publishUrlString = config.HEROKUEVENTS_PUBLISH_URL;
    if (!publishUrlString) {
      logger.error(
        { jobId: jobData.jobId },
        '[pricingService.publishQuoteCompletionEvent] Missing Heroku Eventing configuration (HEROKUEVENTS_PUBLISH_URL). Cannot publish event.'
      );
      return; // Or throw an error if this is critical
    }
    let username, password, fetchUrl;
    try {
      const parsedUrl = new URL(publishUrlString);
      username = parsedUrl.username;
      password = parsedUrl.password;
      // Create a new URL string without the username/password for the fetch call, to avoid issues if fetch also tries to parse them.
      fetchUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    } catch (urlParseError) {
      logger.error(
        { jobId: jobData.jobId, url: publishUrlString, err: urlParseError },
        '[pricingService.publishQuoteCompletionEvent] Invalid HEROKUEVENTS_PUBLISH_URL. Cannot parse.'
      );
      return;
    }
    // Configure HTTP POST request
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const publishName = 'QuoteGenerationComplete'; // Changed to remove __e suffix per user request
    const finalPublishUrl = `${fetchUrl.replace(/\/$/, '')}/${publishName}`; // Ensure single slash

    const response = await fetch(finalPublishUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(eventPayload),
    });
    if (response.ok) {
      const responseBody = await response.json(); // Or response.text() if not JSON
      logger.info(
        {
          jobId: jobData.jobId,
          statusCode: response.status,
          response: responseBody,
          publishedPayload: eventPayload,
        },
        '[pricingService.publishQuoteCompletionEvent] Event published successfully to Heroku Eventing.'
      );
    } else {
      const errorBody = await response.text();
      logger.error(
        {
          jobId: jobData.jobId,
          statusCode: response.status,
          errorBody,
          publishedPayload: eventPayload,
        },
        '[pricingService.publishQuoteCompletionEvent] Error publishing event to Heroku Eventing.'
      );
    }
  } catch (err) {
    logger.error(
      { jobId: jobData.jobId, err },
      '[pricingService.publishQuoteCompletionEvent] Error publishing Platform Event.'
    );
  }
}

export { calculateAndCreateQuotes };
