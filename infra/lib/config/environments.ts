/**
 * @format
 * Environment Configurations
 *
 * Cross-project environment identity: account, region, and shared utilities.
 * Uses enum for type safety as recommended by AWS CDK best practices.
 *
 * IMPORTANT: Environment values use FULL NAMES to match GitHub Environments:
 * - development (not 'dev')
 * - staging
 * - production (not 'prod')
 *
 * This ensures consistency across:
 * - GitHub Environments (secrets/variables)
 * - CDK CLI commands
 * - Stack names
 * - Pipeline workflows
 */

import * as cdk from 'aws-cdk-lib/core';

// =============================================================================
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

/**
 * Read a value from process.env at synth time.
 * Returns undefined if the variable is not set.
 */
function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

// =============================================================================
// ENVIRONMENT ENUM & RESOLUTION
// =============================================================================

/**
 * Environment enum - centralized definition for all environments.
 * Uses full names to match GitHub Environments.
 */
export enum Environment {
    DEVELOPMENT = 'development',
    STAGING = 'staging',
    PRODUCTION = 'production',
    MANAGEMENT = 'management',
}

/**
 * Mapping from short names to full names for backward compatibility
 * Allows: -c environment=dev OR -c environment=development
 */
const SHORT_TO_FULL: Record<string, Environment> = {
    dev: Environment.DEVELOPMENT,
    staging: Environment.STAGING,
    prod: Environment.PRODUCTION,
    mgt: Environment.MANAGEMENT,
};

/**
 * String union type derived from the Environment enum.
 * Prefer using the Environment enum directly for type safety.
 */
export type EnvironmentName = `${Environment}`;

/**
 * Standard deployable environments used by project-level configs.
 * Excludes MANAGEMENT which is org-specific (root account infrastructure).
 */
export type DeployableEnvironment = Exclude<Environment, Environment.MANAGEMENT>;

// =============================================================================
// CROSS-PROJECT IDENTITY
// =============================================================================

/**
 * Cross-project environment identity.
 * Only contains values that are truly shared across ALL projects.
 */
export interface EnvironmentConfig {
    /** AWS account ID for this environment */
    readonly account: string;
    /** Primary AWS region (default: eu-west-1) */
    readonly region: string;
    /** Edge region for CloudFront/ACM/WAF resources (always us-east-1) */
    readonly edgeRegion: string;
}

/**
 * Environment configurations — cross-project identity.
 * Each environment targets a dedicated AWS account.
 *
 * IMPORTANT: The primary region is hardcoded, NOT derived from
 * CDK_DEFAULT_REGION. When the Edge deploy job configures AWS credentials
 * for us-east-1, CDK_DEFAULT_REGION also becomes us-east-1, which would
 * cause SSM cross-region readers in the Edge stack to look in the wrong
 * region for ALB DNS and assets bucket parameters.
 */
const environments: Record<Environment, EnvironmentConfig> = {
    [Environment.DEVELOPMENT]: {
        account: '771826808455',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.STAGING]: {
        account: '692738841103',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.PRODUCTION]: {
        account: '607700977986',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
    [Environment.MANAGEMENT]: {
        account: fromEnv('ROOT_ACCOUNT') ?? '711387127421',
        region: 'eu-west-1',
        edgeRegion: 'us-east-1',
    },
};

/**
 * Get environment configuration (cross-project identity)
 */
export function getEnvironmentConfig(env: Environment): EnvironmentConfig {
    return environments[env];
}

/**
 * Get CDK environment (account + region) for stack props.
 */
export function cdkEnvironment(env: Environment): cdk.Environment {
    const config = environments[env];
    return {
        account: config.account,
        region: config.region,
    };
}

/**
 * Get CDK environment for edge stacks (CloudFront, ACM, WAF).
 */
export function cdkEdgeEnvironment(env: Environment): cdk.Environment {
    const config = environments[env];
    return {
        account: config.account,
        region: config.edgeRegion,
    };
}

// =============================================================================
// ENVIRONMENT ABBREVIATIONS (for flat resource naming)
// =============================================================================

const ENV_ABBREVIATIONS: Record<Environment, string> = {
    [Environment.DEVELOPMENT]: 'dev',
    [Environment.STAGING]: 'stg',
    [Environment.PRODUCTION]: 'prd',
    [Environment.MANAGEMENT]: 'mgt',
};

export function shortEnv(env: EnvironmentName): string {
    return ENV_ABBREVIATIONS[env as Environment];
}

// =============================================================================
// ENVIRONMENT UTILITY FUNCTIONS
// =============================================================================

export function isProductionEnvironment(env: Environment): boolean {
    return env === Environment.PRODUCTION;
}

export function environmentRemovalPolicy(env: Environment): cdk.RemovalPolicy {
    return env === Environment.PRODUCTION
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;
}

export function resolveEnvironment(contextValue?: string): Environment {
    const envValue = contextValue ?? fromEnv('ENVIRONMENT') ?? Environment.DEVELOPMENT;

    if (Object.values(Environment).includes(envValue as Environment)) {
        return envValue as Environment;
    }

    if (envValue in SHORT_TO_FULL) {
        const fullName = SHORT_TO_FULL[envValue];
        // eslint-disable-next-line no-console
        console.log(`Mapping short environment name '${envValue}' to '${fullName}'`);
        return fullName;
    }

    // eslint-disable-next-line no-console
    console.warn(`Unknown environment '${envValue}', defaulting to '${Environment.DEVELOPMENT}'`);
    return Environment.DEVELOPMENT;
}

export function isValidEnvironment(value: string): value is Environment {
    if (Object.values(Environment).includes(value as Environment)) {
        return true;
    }
    return value in SHORT_TO_FULL;
}
