#!/usr/bin/env node
/**
 * CDK App Entry Point
 *
 * HOW THIS WORKS:
 * ---------------
 * This file is the "main()" of your CDK application.
 * When you run `cdk deploy`, CDK executes this file, which:
 * 1. Creates a CDK App (a container for all stacks)
 * 2. Instantiates your stack(s) with configuration
 * 3. CDK then "synthesizes" this into CloudFormation templates
 * 4. CloudFormation deploys the actual AWS resources
 *
 * MULTI-REGION DEPLOYMENT (Mastercard context):
 * At Mastercard, the same stack might be deployed to multiple regions
 * for high availability. Smart DNS then routes traffic to the nearest
 * healthy region.
 */

import * as cdk from 'aws-cdk-lib';
import { ServiceStack } from '../lib/service-stack';

// ============================================================
// Configuration
// ============================================================
const app = new cdk.App();

// Read from cdk.json context or environment variables
const serviceName = app.node.tryGetContext('serviceName') || 'my-payments-api2';
const teamName = app.node.tryGetContext('teamName') || 'platform-engineering';
const environment = process.env.ENV || app.node.tryGetContext('environment') || 'dev';
const primaryRegion = app.node.tryGetContext('awsRegion') || 'us-east-1';

// ============================================================
// Stack Deployment
// ============================================================

// Primary region stack
new ServiceStack(app, `${serviceName}-${environment}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: primaryRegion,
  },
  serviceName,
  teamName,
  environment,
  enableDynamoDB: true,
  enableMonitoring: environment !== 'dev', // Monitoring in staging + prod only

  // Standard tags (mandatory at Mastercard for cost tracking & compliance)
  tags: {
    Service: serviceName,
    Team: teamName,
    Environment: environment,
    ManagedBy: 'cdk',
    CostCenter: `cc-${teamName}`,
    DataClassification: 'internal', // PCI: tag data sensitivity
  },
});

/**
 * MULTI-REGION EXAMPLE (uncomment for production):
 *
 * In production at Mastercard, you'd deploy to multiple regions:
 *
 * const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1'];
 *
 * regions.forEach(region => {
 *   new ServiceStack(app, `${serviceName}-${environment}-${region}`, {
 *     env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
 *     serviceName,
 *     teamName,
 *     environment,
 *     enableDynamoDB: true,
 *     enableMonitoring: true,
 *   });
 * });
 *
 * Then you'd use Cloud WAN or Transit Gateway to connect them,
 * and Smart DNS (Route 53) for intelligent traffic routing.
 */

app.synth();
