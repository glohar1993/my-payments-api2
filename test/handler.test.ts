/**
 * Unit Tests for Lambda Handler
 *
 * HOW UNIT TESTING WORKS HERE:
 * ----------------------------
 * We test the handler function in isolation by:
 * 1. Mocking AWS SDK calls (DynamoDB)
 * 2. Creating fake API Gateway events
 * 3. Asserting the response is correct
 *
 * This runs in CI BEFORE deployment — catching bugs early.
 */

// Mock DynamoDB BEFORE importing handler
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = jest.fn();
  return {
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: mockSend })),
    },
    PutCommand: jest.fn((params) => ({ type: 'PutCommand', ...params })),
    GetCommand: jest.fn((params) => ({ type: 'GetCommand', ...params })),
    ScanCommand: jest.fn((params) => ({ type: 'ScanCommand', ...params })),
    __mockSend: mockSend,
  };
});

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

import { handler } from '../src/handler';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';

// Get the mock so we can control it
const { __mockSend: mockSend } = jest.requireMock('@aws-sdk/lib-dynamodb');

// ============================================================
// Test Helpers
// ============================================================

/** Creates a fake API Gateway event */
function createEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/health',
    pathParameters: null,
    queryStringParameters: null,
    headers: { 'Content-Type': 'application/json' },
    body: null,
    isBase64Encoded: false,
    resource: '',
    stageVariables: null,
    requestContext: {} as any,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    ...overrides,
  };
}

/** Creates a fake Lambda context */
function createContext(): Context {
  return {
    awsRequestId: 'test-request-123',
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789:function:test',
    memoryLimitInMB: '512',
    logGroupName: '/aws/lambda/test',
    logStreamName: 'test-stream',
    callbackWaitsForEmptyEventLoop: true,
    getRemainingTimeInMillis: () => 30000,
    done: jest.fn(),
    fail: jest.fn(),
    succeed: jest.fn(),
  };
}

// ============================================================
// Tests
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});

describe('Health Check Endpoint', () => {
  test('GET /health returns 200 with healthy status', async () => {
    const event = createEvent({ httpMethod: 'GET', path: '/health' });
    const result = await handler(event, createContext());

    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.status).toBe('healthy');
    expect(body.version).toBe('1.0.0');
  });

  test('GET /health includes security headers', async () => {
    const event = createEvent({ httpMethod: 'GET', path: '/health' });
    const result = await handler(event, createContext());

    expect(result.headers).toEqual(
      expect.objectContaining({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Strict-Transport-Security': expect.stringContaining('max-age'),
        'Cache-Control': 'no-store',
      }),
    );
  });
});

describe('Create Item Endpoint', () => {
  test('POST /items creates item and returns 201', async () => {
    mockSend.mockResolvedValueOnce({}); // DynamoDB PutCommand success

    const event = createEvent({
      httpMethod: 'POST',
      path: '/items',
      body: JSON.stringify({
        id: 'item-001',
        data: { name: 'Test Item', value: 42 },
      }),
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(201);

    const body = JSON.parse(result.body);
    expect(body.item.id).toBe('item-001');
    expect(body.item.data.name).toBe('Test Item');
    expect(body.item.createdAt).toBeDefined();
  });

  test('POST /items returns 400 when id is missing', async () => {
    const event = createEvent({
      httpMethod: 'POST',
      path: '/items',
      body: JSON.stringify({ data: { name: 'No ID' } }),
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(400);

    const body = JSON.parse(result.body);
    expect(body.error).toContain('Missing required field: id');
  });

  test('POST /items returns 400 when data is missing', async () => {
    const event = createEvent({
      httpMethod: 'POST',
      path: '/items',
      body: JSON.stringify({ id: 'item-001' }),
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(400);

    const body = JSON.parse(result.body);
    expect(body.error).toContain('Missing required field: data');
  });
});

describe('Get Item Endpoint', () => {
  test('GET /items/{id} returns item when found', async () => {
    const mockItem = {
      id: 'item-001',
      data: { name: 'Found Item' },
      createdAt: '2024-01-01T00:00:00Z',
    };
    mockSend.mockResolvedValueOnce({ Item: mockItem });

    const event = createEvent({
      httpMethod: 'GET',
      path: '/items/item-001',
      pathParameters: { id: 'item-001' },
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.item.id).toBe('item-001');
  });

  test('GET /items/{id} returns 404 when not found', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const event = createEvent({
      httpMethod: 'GET',
      path: '/items/nonexistent',
      pathParameters: { id: 'nonexistent' },
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(404);

    const body = JSON.parse(result.body);
    expect(body.error).toContain('Item not found');
  });
});

describe('List Items Endpoint', () => {
  test('GET /items returns list of items', async () => {
    const mockItems = [
      { id: 'item-001', data: { name: 'Item 1' } },
      { id: 'item-002', data: { name: 'Item 2' } },
    ];
    mockSend.mockResolvedValueOnce({ Items: mockItems, Count: 2 });

    const event = createEvent({ httpMethod: 'GET', path: '/items' });
    const result = await handler(event, createContext());

    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.items).toHaveLength(2);
    expect(body.count).toBe(2);
  });

  test('GET /items returns empty list when no items', async () => {
    mockSend.mockResolvedValueOnce({ Items: [], Count: 0 });

    const event = createEvent({ httpMethod: 'GET', path: '/items' });
    const result = await handler(event, createContext());

    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.items).toHaveLength(0);
  });
});

describe('Error Handling', () => {
  test('returns 404 for unknown routes', async () => {
    const event = createEvent({ httpMethod: 'GET', path: '/unknown' });
    const result = await handler(event, createContext());

    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('Route not found');
  });

  test('returns 500 when DynamoDB throws error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB connection failed'));

    const event = createEvent({
      httpMethod: 'POST',
      path: '/items',
      body: JSON.stringify({ id: 'item-001', data: {} }),
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(500);

    const body = JSON.parse(result.body);
    expect(body.error).toBe('Internal server error');
    // Should NOT expose internal error details (PCI compliance)
    expect(body.error).not.toContain('DynamoDB');
    // Should include request ID for tracing
    expect(body.requestId).toBeDefined();
  });

  test('handles malformed JSON body gracefully', async () => {
    const event = createEvent({
      httpMethod: 'POST',
      path: '/items',
      body: 'not valid json{{{',
    });

    const result = await handler(event, createContext());
    expect(result.statusCode).toBe(500);
  });
});

describe('Response Structure', () => {
  test('all responses include service name and timestamp', async () => {
    const event = createEvent({ httpMethod: 'GET', path: '/health' });
    const result = await handler(event, createContext());

    const body = JSON.parse(result.body);
    expect(body.service).toBeDefined();
    expect(body.timestamp).toBeDefined();
    // Verify timestamp is valid ISO format
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});
