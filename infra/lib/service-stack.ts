/**
 * Service Stack - Main AWS Infrastructure
 *
 * This CDK stack creates everything your microservice needs:
 * - API Gateway (the front door)
 * - Lambda Function (the brain)
 * - DynamoDB Table (the database)
 * - CloudWatch Alarms (the watchdog)
 * - Synthetic Monitoring (the health checker)
 * - IAM Roles (the security guard)
 *
 * REAL-WORLD CONTEXT (Mastercard Platform Engineering):
 * ---------------------------------------------------
 * At Mastercard, your platform team would build this as a
 * reusable CDK Construct that application teams consume.
 * They don't write this code — they just use your template
 * from Backstage and get all of this for free.
 *
 * Key security considerations for payment processing:
 * - All data encrypted at rest (AES-256)
 * - All traffic encrypted in transit (TLS 1.2+)
 * - Least-privilege IAM policies
 * - VPC deployment for network isolation (commented out for simplicity)
 * - For real crypto operations, use proprietary HSMs, NOT KMS
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'path';

// ============================================================
// Stack Props Interface
// ============================================================
export interface ServiceStackProps extends cdk.StackProps {
  serviceName: string;
  teamName: string;
  environment: string;
  enableDynamoDB?: boolean;
  enableMonitoring?: boolean;
}

// ============================================================
// Main Stack
// ============================================================
export class ServiceStack extends cdk.Stack {
  /** The API Gateway REST API - exposed for testing */
  public readonly api: apigateway.RestApi;
  /** The Lambda function - exposed for testing */
  public readonly lambdaFunction: lambda.Function;
  /** The DynamoDB table (if enabled) - exposed for testing */
  public readonly table?: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);

    const { serviceName, teamName, environment, enableDynamoDB = true, enableMonitoring = true } = props;

    // ========================================================
    // 1. DynamoDB Table
    // ========================================================
    if (enableDynamoDB) {
      this.table = new dynamodb.Table(this, 'ServiceTable', {
        tableName: `${serviceName}-${environment}-table`,
        partitionKey: {
          name: 'id',
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        // NOTE: For payment data at Mastercard, you'd use:
        // encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        // encryptionKey: importedKmsKey, // Or better: proprietary HSM-managed key
        pointInTimeRecovery: true, // Always enable for production data
        removalPolicy: environment === 'production'
          ? cdk.RemovalPolicy.RETAIN   // Never delete prod data
          : cdk.RemovalPolicy.DESTROY, // OK to delete in dev/staging

        // Time-to-live for auto-cleanup (optional)
        timeToLiveAttribute: 'ttl',
      });

      // Global Secondary Index example (for querying by team)
      this.table.addGlobalSecondaryIndex({
        indexName: 'team-index',
        partitionKey: {
          name: 'team',
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: 'createdAt',
          type: dynamodb.AttributeType.STRING,
        },
      });
    }

    // ========================================================
    // 2. Lambda Function
    // ========================================================
    this.lambdaFunction = new lambda.Function(this, 'ServiceHandler', {
      functionName: `${serviceName}-${environment}-handler`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../dist/src'), {
        exclude: ['*.map', '*.d.ts', '*.d.ts.map'],
      }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),

      environment: {
        TABLE_NAME: this.table?.tableName || '',
        SERVICE_NAME: serviceName,
        ENVIRONMENT: environment,
        TEAM_NAME: teamName,
        NODE_OPTIONS: '--enable-source-maps',
        // IMPORTANT: Never put secrets in env vars!
        // Use AWS Secrets Manager or proprietary HSM for sensitive config.
      },

      // Structured logging
      logRetention: logs.RetentionDays.ONE_MONTH,

      // Tracing for distributed request tracking
      tracing: lambda.Tracing.ACTIVE,

      // Reserved concurrency prevents one service from starving others
      // At Mastercard scale, this prevents a runaway service from
      // consuming all Lambda capacity in the account
      reservedConcurrentExecutions: undefined,

      /**
       * VPC DEPLOYMENT (commented out for simplicity):
       *
       * At Mastercard, Lambdas run inside a VPC for network isolation:
       *
       * vpc: importedVpc,
       * vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
       * securityGroups: [lambdaSecurityGroup],
       *
       * This is where IP constraints become real — each Lambda ENI
       * consumes an IP from your subnet. With 100 concurrent executions,
       * you need 100 IPs just for this one function.
       */
    });

    // Grant Lambda permissions to read/write DynamoDB
    if (this.table) {
      this.table.grantReadWriteData(this.lambdaFunction);
    }

    // ========================================================
    // 3. API Gateway
    // ========================================================
    this.api = new apigateway.RestApi(this, 'ServiceApi', {
      restApiName: `${serviceName}-${environment}-api`,
      description: `API for ${serviceName} (${environment})`,

      deployOptions: {
        stageName: environment,
        // Access logging
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiAccessLogs', {
            logGroupName: `/api/${serviceName}/${environment}/access`,
            retention: logs.RetentionDays.ONE_MONTH,
          }),
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        // Throttling (protects backend from traffic spikes)
        throttlingRateLimit: 1000,
        throttlingBurstLimit: 500,
        // Enable tracing
        tracingEnabled: true,
      },

      // CORS configuration
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // Restrict in production!
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      },
    });

    // Lambda integration
    const lambdaIntegration = new apigateway.LambdaIntegration(this.lambdaFunction, {
      proxy: true, // Pass the entire request to Lambda
    });

    // API Routes
    // GET /health
    const health = this.api.root.addResource('health');
    health.addMethod('GET', lambdaIntegration);

    // GET/POST /items
    const items = this.api.root.addResource('items');
    items.addMethod('GET', lambdaIntegration);
    items.addMethod('POST', lambdaIntegration);

    // GET /items/{id}
    const singleItem = items.addResource('{id}');
    singleItem.addMethod('GET', lambdaIntegration);

    // ========================================================
    // 4. CloudWatch Alarms
    // ========================================================
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${serviceName}-${environment}-alarms`,
      displayName: `${serviceName} Alerts (${environment})`,
    });

    // Alarm: Lambda Errors > 5 in 5 minutes
    const errorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmName: `${serviceName}-${environment}-lambda-errors`,
      metric: this.lambdaFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      alarmDescription: `Lambda errors exceeded threshold for ${serviceName}`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // Alarm: Lambda Duration > 10 seconds (p95)
    const durationAlarm = new cloudwatch.Alarm(this, 'LambdaDurationAlarm', {
      alarmName: `${serviceName}-${environment}-lambda-duration`,
      metric: this.lambdaFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p95',
      }),
      threshold: 10000, // 10 seconds in milliseconds
      evaluationPeriods: 3,
      alarmDescription: `Lambda p95 latency too high for ${serviceName}`,
    });
    durationAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // Alarm: API Gateway 5xx errors
    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: `${serviceName}-${environment}-api-5xx`,
      metric: this.api.metricServerError({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      alarmDescription: `API 5xx errors exceeded threshold for ${serviceName}`,
    });
    api5xxAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));

    // DynamoDB throttle alarm
    if (this.table) {
      const throttleAlarm = new cloudwatch.Alarm(this, 'DynamoThrottleAlarm', {
        alarmName: `${serviceName}-${environment}-dynamo-throttle`,
        metric: this.table.metricThrottledRequestsForOperations({
          operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.GET_ITEM],
          period: cdk.Duration.minutes(5),
        }),
        threshold: 5,
        evaluationPeriods: 2,
      });
      throttleAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alarmTopic));
    }

    // ========================================================
    // 5. Synthetic Monitoring (Canary)
    // ========================================================
    if (enableMonitoring) {
      // This is the "Synthetic Monitoring" your manager mentioned!
      // It creates a Lambda that runs every 5 minutes, hits your API,
      // and alerts if anything is wrong — BEFORE real users notice.

      const canaryBucket = new s3.Bucket(this, 'CanaryArtifacts', {
        bucketName: `${serviceName}-${environment}-canary-artifacts`,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      });

      const canaryRole = new iam.Role(this, 'CanaryRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchSyntheticsFullAccess'),
        ],
      });

      canaryBucket.grantReadWrite(canaryRole);

      new synthetics.CfnCanary(this, 'HealthCanary', {
        name: `${serviceName.substring(0, 15)}-${environment.substring(0, 3)}-canary`,
        executionRoleArn: canaryRole.roleArn,
        artifactS3Location: `s3://${serviceName}-${environment}-canary-artifacts`,
        runtimeVersion: 'syn-nodejs-puppeteer-15.0',
        schedule: {
          expression: 'rate(5 minutes)', // Run every 5 minutes
        },
        startCanaryAfterCreation: true,
        code: {
          handler: 'index.handler',
          script: `
            const https = require('https');
            const synthetics = require('Synthetics');
            const log = require('SyntheticsLogger');

            const apiCanary = async function () {
              const url = '${this.api.url}health';
              log.info('Checking health endpoint: ' + url);

              const response = await synthetics.executeHttpStep(
                'Health Check',
                url,
                {
                  method: 'GET',
                  headers: { 'Content-Type': 'application/json' },
                }
              );

              // Verify response
              if (response.statusCode !== 200) {
                throw new Error('Health check failed with status: ' + response.statusCode);
              }

              const body = JSON.parse(response.body);
              if (body.status !== 'healthy') {
                throw new Error('Service reports unhealthy status');
              }

              log.info('Health check passed!');
            };

            exports.handler = async () => {
              return await apiCanary();
            };
          `,
        },
      });
    }

    // ========================================================
    // 6. CloudWatch Dashboard
    // ========================================================
    const dashboard = new cloudwatch.Dashboard(this, 'ServiceDashboard', {
      dashboardName: `${serviceName}-${environment}`,
    });

    dashboard.addWidgets(
      // Row 1: Request metrics
      new cloudwatch.GraphWidget({
        title: 'API Requests',
        left: [this.api.metricCount({ period: cdk.Duration.minutes(5) })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency (p50, p95, p99)',
        left: [
          this.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50' }),
          this.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p95' }),
          this.api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
        ],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      // Row 2: Errors and Lambda
      new cloudwatch.GraphWidget({
        title: 'API Errors (4xx & 5xx)',
        left: [
          this.api.metricClientError({ period: cdk.Duration.minutes(5) }),
          this.api.metricServerError({ period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations & Errors',
        left: [
          this.lambdaFunction.metricInvocations({ period: cdk.Duration.minutes(5) }),
          this.lambdaFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
    );

    // ========================================================
    // 7. Stack Outputs
    // ========================================================
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway URL',
      exportName: `${serviceName}-${environment}-api-url`,
    });

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: this.lambdaFunction.functionArn,
      description: 'Lambda Function ARN',
    });

    if (this.table) {
      new cdk.CfnOutput(this, 'DynamoTableName', {
        value: this.table.tableName,
        description: 'DynamoDB Table Name',
      });
    }
  }
}
