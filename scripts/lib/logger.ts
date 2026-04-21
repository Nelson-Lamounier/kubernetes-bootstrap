/**
 * Logger Utility
 *
 * Styled console logging for deployment and operational scripts.
 * Vendored from @repo/script-utils — standalone copy for kubernetes-bootstrap.
 */

import chalk from 'chalk';

// =============================================================================
// Log Levels
// =============================================================================

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  VERBOSE = 3,
  DEBUG = 4,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  verbose: LogLevel.VERBOSE,
  debug: LogLevel.DEBUG,
};

function resolveLogLevel(): LogLevel {
  const explicit = process.env.LOG_LEVEL?.toLowerCase();
  if (explicit && explicit in LOG_LEVEL_MAP) {
    return LOG_LEVEL_MAP[explicit];
  }

  const env = process.env.DEPLOY_ENVIRONMENT?.toLowerCase();
  if (env === 'production' || env === 'staging') {
    return LogLevel.INFO;
  }

  return LogLevel.DEBUG;
}

let currentLevel = resolveLogLevel();

// =============================================================================
// Logger
// =============================================================================

const logger = {
  setLevel: (level: LogLevel): void => {
    currentLevel = level;
  },

  getLevel: (): LogLevel => currentLevel,

  setEnvironment: (environment: string): void => {
    if (process.env.LOG_LEVEL) return;

    const env = environment.toLowerCase();
    if (env === 'production' || env === 'staging') {
      currentLevel = LogLevel.INFO;
    } else {
      currentLevel = LogLevel.DEBUG;
    }
  },

  isEnabled: (level: LogLevel): boolean => level <= currentLevel,

  header: (message: string): void => {
    console.log();
    console.log(chalk.bold.cyan(`━━━ ${message} ━━━`));
    console.log();
  },

  success: (message: string): void => {
    console.log(chalk.green('✓'), message);
  },

  warn: (message: string): void => {
    console.log(chalk.yellow('⚠'), message);
  },

  error: (message: string): void => {
    console.log(chalk.red('✗'), message);
  },

  info: (message: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(chalk.blue('ℹ'), message);
    }
  },

  task: (message: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(chalk.cyan('→'), message);
    }
  },

  keyValue: (key: string, value: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(`  ${chalk.dim(key + ':')} ${value}`);
    }
  },

  listItem: (message: string): void => {
    if (currentLevel >= LogLevel.INFO) {
      console.log(`  ${chalk.dim('•')} ${message}`);
    }
  },

  verbose: (message: string): void => {
    if (currentLevel >= LogLevel.VERBOSE) {
      console.log(chalk.gray('⋯'), message);
    }
  },

  verboseKeyValue: (key: string, value: string): void => {
    if (currentLevel >= LogLevel.VERBOSE) {
      console.log(`  ${chalk.gray(key + ':')} ${value}`);
    }
  },

  debug: (message: string): void => {
    if (currentLevel >= LogLevel.DEBUG) {
      console.log(chalk.gray('⊡'), chalk.dim(message));
    }
  },

  green: (message: string): void => {
    console.log(chalk.green(message));
  },

  yellow: (message: string): void => {
    console.log(chalk.yellow(message));
  },

  red: (message: string): void => {
    console.log(chalk.red(message));
  },

  dim: (message: string): void => {
    console.log(chalk.dim(message));
  },

  blank: (): void => {
    console.log();
  },

  box: (title: string, content: string[]): void => {
    console.log();
    console.log(chalk.cyan('┌─' + '─'.repeat(title.length + 2) + '─┐'));
    console.log(chalk.cyan('│ ') + chalk.bold(title) + chalk.cyan(' │'));
    console.log(chalk.cyan('├─' + '─'.repeat(title.length + 2) + '─┤'));
    content.forEach((line) => {
      const padding = ' '.repeat(Math.max(0, title.length - line.length + 2));
      console.log(chalk.cyan('│ ') + line + padding + chalk.cyan(' │'));
    });
    console.log(chalk.cyan('└─' + '─'.repeat(title.length + 2) + '─┘'));
    console.log();
  },

  table: (headers: string[], rows: string[][]): void => {
    const colWidths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] || '').length))
    );

    const separator = colWidths.map((w) => '─'.repeat(w + 2)).join('┼');
    const headerRow = headers
      .map((h, i) => h.padEnd(colWidths[i]))
      .join(' │ ');

    console.log();
    console.log(chalk.dim('┌─' + separator + '─┐'));
    console.log(chalk.dim('│ ') + chalk.bold(headerRow) + chalk.dim(' │'));
    console.log(chalk.dim('├─' + separator + '─┤'));

    rows.forEach((row) => {
      const rowStr = row
        .map((cell, i) => (cell || '').padEnd(colWidths[i]))
        .join(' │ ');
      console.log(chalk.dim('│ ') + rowStr + chalk.dim(' │'));
    });

    console.log(chalk.dim('└─' + separator + '─┘'));
    console.log();
  },

  step: (current: number, total: number, message: string): void => {
    console.log(chalk.yellow(`[${current}/${total}] ${message}`));
  },

  fail: (message: string): void => {
    console.log(chalk.red('✗'), message);
  },

  config: (label: string, entries: Record<string, string>): void => {
    console.log(chalk.yellow(`📋 ${label}:`));
    for (const [key, value] of Object.entries(entries)) {
      console.log(`   ${key}: ${value}`);
    }
    console.log();
  },

  divider: (): void => {
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  },

  summary: (title: string, entries: Record<string, string>): void => {
    console.log();
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.green(`✅ ${title}`));
    console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log();
    console.log(chalk.cyan('Summary:'));
    for (const [key, value] of Object.entries(entries)) {
      console.log(`  ${key}: ${value}`);
    }
    console.log();
  },

  nextSteps: (steps: string[]): void => {
    console.log(chalk.yellow('Next steps:'));
    steps.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s}`);
    });
    console.log();
  },

  fatal: (message: string): never => {
    console.error(chalk.red(`✗ Fatal: ${message}`));
    process.exit(1);
  },
};

export default logger;
