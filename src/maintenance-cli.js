import process from 'node:process';
import { defaultRoots } from './scanner.js';
import { formatDiskPressureText, scanDiskPressure } from './disk-pressure.js';
import { formatReclaimText, scanReclaimRoots } from './reclaim.js';

export function isMaintenanceCommand(argv) {
  return ['reclaim', 'session-complete', 'disk-pressure'].includes(argv[0]);
}

export async function runMaintenanceCli(argv) {
  const { command, roots, options } = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (command === 'reclaim' || command === 'session-complete') {
    const report = await scanReclaimRoots(roots, options);
    printReport(report, options, formatReclaimText);
    const applyFailed = report.apply
      && (report.summary.blockedCount > 0 || report.summary.partialCount > 0);
    process.exitCode = report.summary.errorCount > 0 || applyFailed ? 1 : 0;
    return;
  }
  const report = await scanDiskPressure(roots, options);
  printReport(report, options, formatDiskPressureText);
  const applyFailed = report.apply
    && report.pressureDetected
    && (report.reclaim.summary.blockedCount > 0 || report.reclaim.summary.partialCount > 0);
  process.exitCode = report.errors.length > 0 || applyFailed ? 1 : 0;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const roots = [];
  const options = {
    json: false,
    help: false,
    tool: 'flutter',
    apply: false,
    yes: false,
    fullClean: false,
    excludePrimary: false,
    worktreesOnly: false,
    minAgeMinutes: 10,
    workflowRoots: [],
    workflowRefs: [],
    minFreeGb: null,
    explicitRoots: false,
    toolOptionUsed: false,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--json') options.json = true;
    else if (arg === '--no-progress') {
      // Maintenance commands never render the scanner progress UI.
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--tool') {
      options.tool = parseValue(args.shift(), '--tool');
      options.toolOptionUsed = true;
    } else if (arg.startsWith('--tool=')) {
      options.tool = parseValue(arg.slice('--tool='.length), '--tool');
      options.toolOptionUsed = true;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--full-clean') options.fullClean = true;
    else if (arg === '--exclude-primary') options.excludePrimary = true;
    else if (arg === '--worktrees-only') {
      options.worktreesOnly = true;
      options.excludePrimary = true;
    } else if (arg === '--min-age-minutes') {
      options.minAgeMinutes = parseNonNegativeInteger(args.shift(), '--min-age-minutes');
    } else if (arg.startsWith('--min-age-minutes=')) {
      options.minAgeMinutes = parseNonNegativeInteger(arg.slice('--min-age-minutes='.length), '--min-age-minutes');
    } else if (arg === '--workflow-root') options.workflowRoots.push(parseValue(args.shift(), '--workflow-root'));
    else if (arg.startsWith('--workflow-root=')) options.workflowRoots.push(parseValue(arg.slice('--workflow-root='.length), '--workflow-root'));
    else if (arg === '--workflow-ref') options.workflowRefs.push(parseValue(args.shift(), '--workflow-ref'));
    else if (arg.startsWith('--workflow-ref=')) options.workflowRefs.push(parseValue(arg.slice('--workflow-ref='.length), '--workflow-ref'));
    else if (arg === '--min-free-gb') options.minFreeGb = parsePositiveNumber(args.shift(), '--min-free-gb');
    else if (arg.startsWith('--min-free-gb=')) options.minFreeGb = parsePositiveNumber(arg.slice('--min-free-gb='.length), '--min-free-gb');
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else roots.push(arg);
  }
  options.explicitRoots = roots.length > 0;
  if (command === 'session-complete') {
    if (roots.length !== 1) throw new Error('session-complete requires exactly one explicit worktree root.');
    options.tool = 'auto';
  }
  if (command === 'disk-pressure') {
    if (options.fullClean || options.workflowRoots.length > 0 || options.workflowRefs.length > 0) {
      throw new Error('disk-pressure manages linked-worktree caches only; --full-clean, --workflow-root, and --workflow-ref are not valid.');
    }
    if (options.toolOptionUsed) {
      throw new Error('disk-pressure selects its worktree-cache providers automatically; --tool is not valid.');
    }
  } else if (options.minFreeGb !== null) {
    throw new Error('--min-free-gb is only valid with disk-pressure.');
  }
  if (options.apply && !options.yes) throw new Error('Permanent reclaim requires --apply --yes.');
  if (options.yes && !options.apply) throw new Error('--yes is only valid with --apply.');
  if (options.apply && !options.explicitRoots) {
    throw new Error('Permanent reclaim requires at least one explicit root.');
  }
  if (!options.explicitRoots) roots.push(...defaultRoots());
  return { command, roots, options };
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== String(value)) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive number`);
  return parsed;
}

function parseValue(value, flag) {
  const parsed = (value ?? '').trim();
  if (!parsed || parsed.startsWith('-')) throw new Error(`${flag} requires a value`);
  return parsed;
}

function printReport(report, options, formatter) {
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatter(report));
}

function printHelp() {
  console.log(`git-groundskeeper maintenance

Usage:
  git-groundskeeper reclaim [roots...] [options]
  git-groundskeeper session-complete <worktree> [options]
  git-groundskeeper disk-pressure [roots...] [options]

Reclaim options:
  --tool <provider>      auto, flutter, node, swiftpm, xcode, or runner.
  --workflow-root <dir>  Git checkout whose remote workflow refs protect
                         runner Flutter cache versions. Repeatable.
  --workflow-ref <ref>   Workflow ref to inspect instead of the default
                         origin/main, origin/master, origin/dev, and develop.
  --full-clean           Flutter's broader clean set. Flutter only.
  --min-age-minutes <n>  Block targets changed recently. Default: 10.
  --exclude-primary      Omit primary worktrees.
  --worktrees-only       Reclaim linked worktrees only.
  --apply --yes          Permanently execute a revalidated plan. Explicit
                         roots are always required.
  --min-free-gb <n>      disk-pressure threshold in GiB. Default: 20.

Examples:
  git-groundskeeper reclaim ~/Development --tool auto --worktrees-only
  git-groundskeeper reclaim ~/.github-runners/numbus-flutter --tool runner --workflow-root ~/Development/numbus/B2C/numbus
  git-groundskeeper disk-pressure ~/Development --min-free-gb 20
`);
}
