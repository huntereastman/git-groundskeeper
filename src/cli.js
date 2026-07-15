import process from 'node:process';
import { defaultRoots, scanRoots } from './scanner.js';
import { detectOwners } from './owners.js';
import { formatScanText } from './format.js';

const DEFAULT_INTERVAL_SECONDS = 15;

export async function runCli(argv) {
  const { command, roots, options } = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.owners.length === 0 && options.detectOwners) {
    options.owners = await detectOwners({ refresh: options.refreshOwners });
  }

  // Filtering to owners we never resolved would report an empty machine and
  // look like good news. Fail loudly instead.
  if (options.onlyMine && options.owners.length === 0) {
    throw new Error(
      '--mine needs at least one owner. Pass --owner <name>, or authenticate gh so owners can be detected.',
    );
  }

  if (command === 'scan' || command === 'status') {
    const report = await scanRoots(roots, options);
    printReport(report, options);
    process.exitCode = options.failOnAttention && report.summary.attentionCount > 0 ? 1 : 0;
    return;
  }

  if (command === 'watch') {
    const intervalMs = options.intervalSeconds * 1000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const report = await scanRoots(roots, options);
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
    untrackedFiles: 'normal',
    owners: [],
    onlyMine: false,
    detectOwners: true,
    refreshOwners: false,
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
    } else if (arg === '--untracked-all') {
      options.untrackedFiles = 'all';
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
    } else if (arg === '--owner') {
      options.owners.push(parseOwner(args.shift()));
    } else if (arg.startsWith('--owner=')) {
      options.owners.push(parseOwner(arg.slice('--owner='.length)));
    } else if (arg === '--mine') {
      options.onlyMine = true;
    } else if (arg === '--no-detect-owners') {
      options.detectOwners = false;
    } else if (arg === '--refresh-owners') {
      options.refreshOwners = true;
    } else if (arg === '--concurrency') {
      options.concurrency = parsePositiveInteger(args.shift(), '--concurrency');
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = parsePositiveInteger(arg.split('=')[1], '--concurrency');
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
    roots.push(...defaultRoots());
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

function parseOwner(value) {
  const owner = (value ?? '').trim();
  if (!owner || owner.startsWith('-')) {
    throw new Error('--owner requires an account or organization name');
  }
  return owner;
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

Roots default to your home directory, so a bare scan discovers every
repository on the machine with no prior knowledge of its layout. Pass roots
explicitly to narrow the search, or "." for the current directory.

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
  --untracked-all        List every file inside untracked directories. Slow on
                         wide scans; the default collapses them per directory.
  --owner <name>         Account or org you own. Repeatable. Tags each repo as
                         mine, external, or no-remote by its remote URL. When
                         omitted, owners are detected via gh and cached a day.
  --mine                 Report only repos matching an owner. Cuts vendored
                         dependencies and agent scratch out of the summary.
  --no-detect-owners     Skip gh detection; rely only on --owner.
  --refresh-owners       Re-query gh instead of using the cached owners.
  --concurrency <n>      Git calls in flight. Default: available parallelism.
  --interval <seconds>   Watch interval. Default: 15.
  -h, --help             Show help.

Examples:
  git-groundskeeper scan
  git-groundskeeper scan --details
  git-groundskeeper scan .
  git-groundskeeper scan ~/Development
  git-groundskeeper scan ~/Development --json
  git-groundskeeper scan ~/Development --color=always
  git-groundskeeper scan ~/Development --fail-on-attention
  git-groundskeeper watch ~/Development --interval 30
`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
