import process from 'node:process';
import { scanRoots } from './scanner.js';
import { formatScanText } from './format.js';

const DEFAULT_INTERVAL_SECONDS = 15;

export async function runCli(argv) {
  const { command, roots, options } = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (command === 'scan' || command === 'status') {
    const report = scanRoots(roots, options);
    printReport(report, options);
    process.exitCode = options.failOnAttention && report.summary.attentionCount > 0 ? 1 : 0;
    return;
  }

  if (command === 'watch') {
    const intervalMs = options.intervalSeconds * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const report = scanRoots(roots, options);
      console.clear();
      printReport(report, options);
      await delay(intervalMs);
    }
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const args = [...argv];
  let command = 'scan';

  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift();
  }

  const roots = [];
  const options = {
    json: false,
    compact: true,
    details: false,
    all: false,
    color: 'auto',
    failOnAttention: false,
    help: false,
    maxDepth: 8,
    largeFileBytes: 10 * 1024 * 1024,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  };

  while (args.length > 0) {
    const arg = args.shift();

    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--compact') {
      options.compact = true;
      options.details = false;
    } else if (arg === '--details' || arg === '--verbose') {
      options.details = true;
      options.compact = false;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--color') {
      options.color = 'always';
    } else if (arg.startsWith('--color=')) {
      options.color = parseColorMode(arg.split('=')[1]);
    } else if (arg === '--no-color') {
      options.color = 'never';
    } else if (arg === '--fail-on-attention') {
      options.failOnAttention = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--max-depth') {
      options.maxDepth = parsePositiveInteger(args.shift(), '--max-depth');
    } else if (arg.startsWith('--max-depth=')) {
      options.maxDepth = parsePositiveInteger(arg.split('=')[1], '--max-depth');
    } else if (arg === '--large-file-mb') {
      options.largeFileBytes = parsePositiveInteger(args.shift(), '--large-file-mb') * 1024 * 1024;
    } else if (arg.startsWith('--large-file-mb=')) {
      options.largeFileBytes = parsePositiveInteger(arg.split('=')[1], '--large-file-mb') * 1024 * 1024;
    } else if (arg === '--interval') {
      options.intervalSeconds = parsePositiveInteger(args.shift(), '--interval');
    } else if (arg.startsWith('--interval=')) {
      options.intervalSeconds = parsePositiveInteger(arg.split('=')[1], '--interval');
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      roots.push(arg);
    }
  }

  if (roots.length === 0) {
    roots.push(process.cwd());
  }

  return { command, roots, options };
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseColorMode(value) {
  if (value === 'auto' || value === 'always' || value === 'never') {
    return value;
  }
  throw new Error('--color requires auto, always, or never');
}

function printReport(report, options) {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatScanText(report, options));
}

function printHelp() {
  console.log(`git-groundskeeper

Usage:
  git-groundskeeper scan [roots...] [options]
  git-groundskeeper status [roots...] [options]
  git-groundskeeper watch [roots...] [options]

Options:
  --json                 Print machine-readable JSON.
  --compact              Print the default actionable checklist.
  --details, --verbose   Print full repo, worktree, branch, and stash details.
  --all                  Include clean repos and worktrees in text output.
  --color[=mode]         Color output: auto, always, or never. Default: auto.
  --no-color             Disable color output.
  --fail-on-attention    Exit 1 when outstanding Git state is found.
  --max-depth <n>        Recursive discovery depth. Default: 8.
  --large-file-mb <n>    Flag dirty files at or above this size. Default: 10.
  --interval <seconds>   Watch interval. Default: 15.
  -h, --help             Show help.

Examples:
  git-groundskeeper scan ~/Development
  git-groundskeeper scan ~/Development --details
  git-groundskeeper scan ~/Development --json
  git-groundskeeper scan ~/Development --color=always
  git-groundskeeper scan ~/Development --fail-on-attention
  git-groundskeeper watch ~/Development --interval 30
`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
