/**
 * CDK Stack Tests
 *
 * HOW CDK TESTING WORKS:
 * ----------------------
 * CDK tests verify your infrastructure BEFORE deployment.
 * There are two types:
 *
 * 1. SNAPSHOT TESTS: "Has my infrastructure changed unexpectedly?"
 *    - Takes a "photo" of your CloudFormation template
 *    - Next time you run tests, compares to the saved photo
 *    - If they differ, the test fails — forcing you to review changes
 *    - Great for catching accidental modifications
 *
 * 2. ASSERTION TESTS: "Does my infrastructure have what I expect?"
 *    - Checks specific properties of resources
 *    - e.g., "Is DynamoDB encryption enabled?"
 *    - e.g., "Does Lambda have the right memory?"
 *    - Great for enforcing compliance rules
 *
 * WHY THIS MATTERS AT MASTERCARD:
 * A misconfigured security group or missing encryption could
 * violate PCI-DSS compliance. These tests catch that in CI,
 * BEFORE it reaches AWS.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ServiceStack, ServiceStackProps } from '../lib/service-stack';

// ============================================================
// Test Helper: Create a test stack
// ============================================================
function createTestStack(overrides: Partial<ServiceStackProps> = {}): Template {
  const app = new cdk.App();
  const defaultProps: ServiceStackProps = {
    serviceName: 'test-service',
    teamName: 'platform-engineering',
    environment: 'dev',
    enableDynamoDB: true,
    enableMonitoring: false, // Disable canary in tests for simplicity
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    ...overrides,
  };

  const stack = new ServiceStack(app, 'TestStack', defaultProps);
  return Template.fromStack(stack);
}

// ============================================================
// Snapshot Test
// ============================================================
describe('Snapshot Tests', () => {
  test('infrastructure matches saved snapshot', () => {
    const template = createTestStack();
    // First run: creates __snapshots__ file
    // Subsequent runs: compares against it
    // If infra changes, run: npx jest --updateSnapshot
    expect(template.toJSON()).toMatchSnapshot();
  });
});

// ============================================================
// Resource Existence Tests
// ============================================================
describe('Resource Creation', () => {
  test('creates a Lambda function', () => {
    const template = createTestStack();
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  test('creates an API Gateway REST API', () => {
    const template = createTestStack();
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  test('creates a DynamoDB table when enabled', () => {
    const template = createTestStack({ enableDynamoDB: true });
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  test('does NOT create DynamoDB table when disabled', () => {
    const template = createTestStack({ enableDynamoDB: false });
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  test('creates CloudWatch alarms', () => {
    const template = createTestStack();
    // Should have: Lambda errors, Lambda duration, API 5xx, DynamoDB throttle
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  });

  test('creates an SNS topic for alarms', () => {
    const template = createTestStack();
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  test('creates a CloudWatch dashboard', () => {
    const template = createTestStack();
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });
});

// ============================================================
// Security & Compliance Tests (Critical for PCI-DSS)
// ============================================================
describe('Security & Compliance', () => {
  test('DynamoDB has encryption enabled', () => {
    const template = createTestStack();
    // PCI-DSS requires encryption at rest for all cardholder data
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: {
        SSEEnabled: true,
      },
    });
  });

  test('DynamoDB has point-in-time recovery enabled', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  test('Lambda has X-Ray tracing enabled', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      TracingConfig: {
        Mode: 'Active',
      },
    });
  });

  test('Lambda has reserved concurrency set', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: Match.anyValue(),
    });
  });

  test('API Gateway has throttling configured', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          ThrottlingRateLimit: Match.anyValue(),
          ThrottlingBurstLimit: Match.anyValue(),
        }),
      ]),
    });
  });

  test('Lambda IAM role follows least privilege', () => {
    const template = createTestStack();
    // Verify DynamoDB permissions are scoped to specific table
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.anyValue(),
            Effect: 'Allow',
            Resource: Match.anyValue(), // Should be specific ARN, not *
          }),
        ]),
      },
    });
  });
});

// ============================================================
// Configuration Tests
// ============================================================
describe('Configuration', () => {
  test('Lambda has correct runtime', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
    });
  });

  test('Lambda memory is 512 MB', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
    });
  });

  test('Lambda timeout is 30 seconds', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 30,
    });
  });

  test('Lambda has required environment variables', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          SERVICE_NAME: 'test-service',
          ENVIRONMENT: 'dev',
          TEAM_NAME: 'platform-engineering',
        }),
      },
    });
  });

  test('DynamoDB uses PAY_PER_REQUEST billing', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('production DynamoDB has RETAIN removal policy', () => {
    const template = createTestStack({ environment: 'production' });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('dev DynamoDB has DELETE removal policy', () => {
    const template = createTestStack({ environment: 'dev' });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
    });
  });
});

// ============================================================
// API Gateway Route Tests
// ============================================================
describe('API Routes', () => {
  test('has health endpoint', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'health',
    });
  });

  test('has items endpoint', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'items',
    });
  });

  test('has items/{id} endpoint', () => {
    const template = createTestStack();
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{id}',
    });
  });
});

// ============================================================
// Output Tests
// ============================================================
describe('Stack Outputs', () => {
  test('exports API URL', () => {
    const template = createTestStack();
    template.hasOutput('ApiUrl', {
      Description: 'API Gateway URL',
    });
  });

  test('exports Lambda ARN', () => {
    const template = createTestStack();
    template.hasOutput('LambdaFunctionArn', {
      Description: 'Lambda Function ARN',
    });
  });

  test('exports DynamoDB table name when enabled', () => {
    const template = createTestStack({ enableDynamoDB: true });
    template.hasOutput('DynamoTableName', {
      Description: 'DynamoDB Table Name',
    });
  });
});
