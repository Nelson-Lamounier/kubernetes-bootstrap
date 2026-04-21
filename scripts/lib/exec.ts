/**
 * Child Process Execution Utilities
 *
 * Shared, CDK-agnostic utilities for spawning child processes and
 * capturing their output.
 * Vendored from @repo/script-utils — standalone copy for kubernetes-bootstrap.
 */

import { spawn, type SpawnOptions } from 'child_process';

// =============================================================================
// Types
// =============================================================================

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecuteOptions {
  captureOutput?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// =============================================================================
// Core Execution Engine
// =============================================================================

export async function executeChildProcess(
  command: string,
  args: string[],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const useShell = process.platform === 'win32';

  const spawnOpts: SpawnOptions = {
    cwd,
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    env: options.env ? { ...process.env, ...options.env } : process.env,
    ...(useShell && { shell: true }),
  };

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, spawnOpts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (options.captureOutput) {
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    }

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      });
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: error.message,
      });
    });
  });
}

// =============================================================================
// Convenience Wrapper
// =============================================================================

export async function runCommand(
  command: string,
  args: string[] = [],
  options: ExecuteOptions = {},
): Promise<CommandResult> {
  return executeChildProcess(command, args, options);
}
