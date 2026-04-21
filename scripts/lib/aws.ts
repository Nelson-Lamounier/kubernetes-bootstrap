/**
 * AWS Helpers
 *
 * Shared AWS SDK utilities used across all deployment and migration scripts.
 * Vendored from @repo/script-utils — standalone copy for kubernetes-bootstrap.
 */

import { execSync } from 'child_process'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-providers'
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types'
import logger from './logger.js'

// ========================================
// Types
// ========================================

export interface AwsConfig {
  region: string
  profile?: string
  environment: string
  credentials?: AwsCredentialIdentityProvider
}

export interface CliArgSpec {
  name: string
  description: string
  hasValue: boolean
  default?: string | boolean
}

export interface ParsedArgs {
  [key: string]: string | boolean
}

// ========================================
// Auth & Credentials
// ========================================

export function resolveAuth(profile?: string): {
  mode: string
  credentials?: AwsCredentialIdentityProvider
} {
  if (profile) {
    return {
      mode: `profile (${profile})`,
      credentials: fromIni({ profile }),
    }
  }

  if (process.env.AWS_ACCESS_KEY_ID) {
    return { mode: 'OIDC (env credentials)' }
  }

  const defaultProfile = 'dev-account'
  return {
    mode: `profile (${defaultProfile}, default)`,
    credentials: fromIni({ profile: defaultProfile }),
  }
}

export async function getAccountId(config: AwsConfig): Promise<string> {
  const sts = new STSClient({
    region: config.region,
    credentials: config.credentials,
  })

  const result = await sts.send(new GetCallerIdentityCommand({}))
  if (!result.Account) {
    return logger.fatal('Failed to get AWS Account ID. Check your AWS credentials.')
  }
  return result.Account
}

// ========================================
// SSM Parameter Store
// ========================================

export async function getSSMParameter(
  name: string,
  config: AwsConfig,
): Promise<string | undefined> {
  const ssm = new SSMClient({
    region: config.region,
    credentials: config.credentials,
  })

  try {
    const result = await ssm.send(
      new GetParameterCommand({ Name: name }),
    )
    const value = result.Parameter?.Value
    if (value && value !== 'None') {
      return value
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function getSSMParameterWithFallbacks(
  paths: string[],
  config: AwsConfig,
): Promise<{ value: string; path: string } | undefined> {
  for (const path of paths) {
    console.log(`   Trying: ${path}`)
    const value = await getSSMParameter(path, config)
    if (value) {
      logger.success(`Found via: ${path}`)
      return { value, path }
    }
  }
  return undefined
}

// ========================================
// Shell Execution (sync subprocess — used for `aws s3 sync` and similar CLI calls)
// ========================================

export function execShell(
  command: string,
  options?: { cwd?: string; silent?: boolean },
): string {
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      cwd: options?.cwd,
      stdio: options?.silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
    })
    return result.trim()
  } catch (error: unknown) {
    if (error instanceof Error && 'stderr' in error && error.stderr) {
      throw new Error(`Command failed: ${command}\n${error.stderr}`)
    }
    throw error
  }
}

export function execShellStream(command: string, options?: { cwd?: string }): void {
  execSync(command, {
    cwd: options?.cwd,
    stdio: 'inherit',
  })
}

// ========================================
// CLI Argument Parsing
// ========================================

export function parseArgs(
  specs: CliArgSpec[],
  scriptDescription: string,
): ParsedArgs {
  const args = process.argv.slice(2)
  const result: ParsedArgs = {}

  for (const spec of specs) {
    if (spec.default !== undefined) {
      result[spec.name] = spec.default
    }
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]

    if (arg === '--help') {
      console.log(`Usage: tsx ${process.argv[1]} [OPTIONS]`)
      console.log('')
      console.log(scriptDescription)
      console.log('')
      console.log('Options:')
      for (const spec of specs) {
        const flag = spec.hasValue ? `--${spec.name} <value>` : `--${spec.name}`
        const def = spec.default !== undefined ? ` (default: ${spec.default})` : ''
        console.log(`  ${flag.padEnd(25)} ${spec.description}${def}`)
      }
      console.log(`  ${'--help'.padEnd(25)} Show this help message`)
      process.exit(0)
    }

    const spec = specs.find((s) => `--${s.name}` === arg)
    if (!spec) {
      return logger.fatal(`Unknown option: ${arg}\nRun with --help for usage.`)
    }

    if (spec.hasValue) {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        logger.fatal(`Option --${spec.name} requires a value`)
      }
      result[spec.name] = value
      i += 2
    } else {
      result[spec.name] = true
      i += 1
    }
  }

  return result
}

export function buildAwsConfig(args: ParsedArgs): AwsConfig {
  const region = (args.region as string) || process.env.AWS_REGION || 'eu-west-1'
  const profile = args.profile as string | undefined
  const environment = (args.env as string) || process.env.ENVIRONMENT || 'dev'
  const auth = resolveAuth(profile)

  return { region, profile, environment, credentials: auth.credentials }
}
