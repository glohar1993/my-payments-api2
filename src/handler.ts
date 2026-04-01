/**
 * my-payments-api2 - Lambda Handler
 * Team: platform-engineering
 *
 * This is the main entry point for the microservice.
 * It handles API Gateway events and processes requests.
 *
 * HOW THIS WORKS AT MASTERCARD (Real-world context):
 * -------------------------------------------------
 * In a real payment service, this Lambda would:
 * 1. Receive a payment authorization request via API Gateway
 * 2. Validate the request (check merchant, amount, currency)
 * 3. Call internal services (fraud check, balance check)
 * 4. For crypto operations, call the proprietary HSM (not KMS!)
 * 5. Return approved/declined response
 *
 * For this template, we demonstrate a simpler CRUD pattern
 * that you can extend for your specific use case.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

// ============================================================
// Configuration
// ============================================================
const TABLE_NAME = process.env.TABLE_NAME || 'my-payments-api2-table';
const REGION = process.env.AWS_REGION || 'us-east-1';

// DynamoDB client setup
const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// ============================================================
// Types
// ============================================================
interface ServiceItem {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  team: string;
}

interface ApiResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Creates a standardized API response.
 * At Mastercard, responses follow ISO 8583 format for payment APIs.
 * For REST APIs, we use standard JSON responses.
 */
function createResponse(statusCode: number, body: unknown): ApiResponse {
  return {
    statusCode,
    body: JSON.stringify({
      service: 'my-payments-api2',
      timestamp: new Date().toISOString(),
      ...( typeof body === 'object' ? body : { message: body }),
    }),
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Name': 'my-payments-api2',
      'X-Service-Team': 'platform-engineering',
      // Security headers (PCI compliance requires these)
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Cache-Control': 'no-store',
    },
  };
}

/**
 * Validates that required fields exist in the request body.
 */
function validateRequest(body: Record<string, unknown>, requiredFields: string[]): string | null {
  for (const field of requiredFields) {
    if (!(field in body)) {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

// ============================================================
// Route Handlers
// ============================================================

/** Health check endpoint - used by Synthetic Monitoring */
async function handleHealthCheck(): Promise<ApiResponse> {
  return createResponse(200, {
    status: 'healthy',
    version: '1.0.0',
    region: REGION,
    uptime: process.uptime(),
  });
}

/** Create a new item */
async function handleCreate(body: Record<string, unknown>): Promise<ApiResponse> {
  const validationError = validateRequest(body, ['id', 'data']);
  if (validationError) {
    return createResponse(400, { error: validationError });
  }

  const now = new Date().toISOString();
  const item: ServiceItem = {
    id: body.id as string,
    data: body.data as Record<string, unknown>,
    createdAt: now,
    updatedAt: now,
    team: 'platform-engineering',
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(id)', // Prevent overwrites
  }));

  return createResponse(201, { item });
}

/** Get an item by ID */
async function handleGet(id: string): Promise<ApiResponse> {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { id },
  }));

  if (!result.Item) {
    return createResponse(404, { error: `Item not found: ${id}` });
  }

  return createResponse(200, { item: result.Item });
}

/** List all items */
async function handleList(): Promise<ApiResponse> {
  const result = await docClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    Limit: 100,
  }));

  return createResponse(200, {
    items: result.Items || [],
    count: result.Count,
  });
}

// ============================================================
// Main Handler (API Gateway router)
// ============================================================
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const { httpMethod, path, pathParameters, body } = event;
  const requestId = context.awsRequestId;

  console.log(JSON.stringify({
    message: 'Request received',
    requestId,
    method: httpMethod,
    path,
    timestamp: new Date().toISOString(),
  }));

  try {
    // Route: GET /health
    if (path === '/health' && httpMethod === 'GET') {
      return handleHealthCheck();
    }

    // Route: POST /items
    if (path === '/items' && httpMethod === 'POST') {
      const parsedBody = body ? JSON.parse(body) : {};
      return await handleCreate(parsedBody);
    }

    // Route: GET /items
    if (path === '/items' && httpMethod === 'GET') {
      return await handleList();
    }

    // Route: GET /items/{id}
    if (path.startsWith('/items/') && httpMethod === 'GET') {
      const id = pathParameters?.id || path.split('/').pop() || '';
      return await handleGet(id);
    }

    // 404 for unmatched routes
    return createResponse(404, {
      error: 'Route not found',
      method: httpMethod,
      path,
    });

  } catch (error) {
    console.error(JSON.stringify({
      message: 'Request failed',
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }));

    // Don't expose internal errors (PCI compliance)
    return createResponse(500, {
      error: 'Internal server error',
      requestId, // Give them the request ID so they can ask ops to look it up
    });
  }
}
