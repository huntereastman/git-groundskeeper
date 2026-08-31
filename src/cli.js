import process from 'node:process';
import { defaultRoots, scanRoots } from './scanner.js';
import { detectOwners } from './owners.js';
import { formatScanText } from './format.js';
import { createProgressReporter } from './progress.js';
import { formatReclaimText, scanReclaimRoots } from './reclaim.js';
import { formatDiskPressureText, scanDiskPressure } from './disk-pressure.js';
import {
  attachToolProvenance,
  formatToolProvenance,
  getToolProvenance,
} from './provenance.js';
import { formatRetireText, retireWorktree } from './retire.js';

const DEFAULT_INTERVAL_SECONDS = 15;

export async function runCli(argv) {
  const { command, roots, options } = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.version) {
    console.log(formatToolProvenance(getToolProvenance()));
    return;
  }

  if (command === 'retire') {
    const report = attachToolProvenance(await retireWorktree(roots[0], options));
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(withToolProvenance(formatRetireText(report), report));
    process.exitCode = ['blocked', 'partial'].includes(report.status) ? 1 : 0;
    return;
  }

  if (command === 'reclaim' || command === 'session-complete') {
    const report = attachToolProvenance(await scanReclaimRoots(roots, options));
    printReclaimReport(report, options);
    const applyFailed = report.apply
      && (report.summary.blockedCount > 0 || report.summary.partialCount > 0);
    process.exitCode = report.summary.errorCount > 0 || applyFailed ? 1 : 0;
    return;
  }

  if (command === 'disk-pressure') {
    const report = attachToolProvenance(await scanDiskPressure(roots, options));
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(withToolProvenance(formatDiskPressureText(report), report));
    const applyFailed = report.apply
      && report.pressureDetected
      && (report.reclaim.summary.blockedCount > 0 || report.reclaim.summary.partialCount > 0);
    process.exitCode = report.errors.length > 0 || applyFailed ? 1 : 0;
    return;
  }

  const progress = createProgressReporter(options);
  if (progress) options.onProgress = progress.update;

  try {
    if (options.owners.length === 0 && options.detectOwners) {
      options.onProgress?.({
        phase: 'owners',
        label: 'Detecting GitHub owners',
        completed: null,
        total: null,
      });
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
      const report = attachToolProvenance(await scanRoots(roots, options));
      printReport(report, options);
      process.exitCode = options.failOnAttention && report.summary.attentionCount > 0 ? 1 : 0;
      return;
    }

    if (command === 'watch') {
      const intervalMs = options.intervalSeconds * 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const report = attachToolProvenance(await scanRoots(roots, options));
        console.clear();
        printReport(report, options);
        await delay(intervalMs);
      }
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    progress?.dispose();
  }
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
    progress: 'auto',
    progress3d: false,
    progressPulse: false,
    progressSignal: false,
    progressWave: false,
    failOnAttention: false,
    help: false,
    version: false,
    maxDepth: 8,
    largeFileBytes: 10 * 1024 * 1024,
    untrackedFiles: 'normal',
    buckets: false,
    keepsDetails: false,
    commands: false,
    sizes: false,
    scopeStrict: false,
    squashDetect: true,
    liveRemoteCheck: true,
    owners: [],
    onlyMine: false,
    detectOwners: true,
    refreshOwners: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    tool: 'flutter',
    apply: false,
    yes: false,
    fullClean: false,
    excludePrimary: false,
    worktreesOnly: false,
    minAgeMinutes: 10,
    minAgeOptionUsed: false,
    explicitRoots: false,
    reclaimOptionUsed: false,
    diskPressureOptionUsed: false,
    toolOptionUsed: false,
    workflowRoots: [],
    workflowRefs: [],
    minFreeGb: null,
    retainBranch: false,
    retireOptionUsed: false,
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
    } else if (arg === '--progress') {
      options.progress = 'always';
    } else if (arg === '--3d-progress') {
      options.progress = 'always';
      options.progress3d = true;
      options.progressPulse = false;
      options.progressSignal = false;
      options.progressWave = false;
    } else if (arg === '--signal-progress') {
      options.progress = 'always';
      options.progress3d = false;
      options.progressPulse = false;
      options.progressSignal = true;
      options.progressWave = false;
    } else if (arg === '--pulse-progress') {
      options.progress = 'always';
      options.progress3d = false;
      options.progressPulse = true;
      options.progressSignal = false;
      options.progressWave = false;
    } else if (arg === '--wave-progress') {
      options.progress = 'always';
      options.progress3d = false;
      options.progressPulse = false;
      options.progressSignal = false;
      options.progressWave = true;
    } else if (arg === '--no-progress') {
      options.progress = 'never';
    } else if (arg === '--untracked-all') {
      options.untrackedFiles = 'all';
    } else if (arg === '--buckets') {
      options.buckets = true;
    } else if (arg === '--keeps-details') {
      options.keepsDetails = true;
    } else if (arg === '--commands') {
      options.buckets = true;
      options.commands = true;
    } else if (arg.startsWith('--commands=')) {
      options.buckets = true;
      options.commands = true;
      options.commandsTier = parseCommandsTier(arg.split('=')[1]);
    } else if (arg === '--sizes') {
      options.sizes = true;
    } else if (arg === '--scope-strict') {
      options.scopeStrict = true;
    } else if (arg === '--no-squash-detect') {
      options.squashDetect = false;
    } else if (arg === '--no-pr-check') {
      options.prCheck = false;
    } else if (arg === '--no-live-remote-check') {
      options.liveRemoteCheck = false;
    } else if (arg === '--fail-on-attention') {
      options.failOnAttention = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-V') {
      options.version = true;
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
    } else if (arg === '--tool') {
      options.tool = parseValue(args.shift(), '--tool');
      options.toolOptionUsed = true;
      options.reclaimOptionUsed = true;
    } else if (arg.startsWith('--tool=')) {
      options.tool = parseValue(arg.slice('--tool='.length), '--tool');
      options.toolOptionUsed = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--apply') {
      options.apply = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--yes') {
      options.yes = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--retain-branch') {
      options.retainBranch = true;
      options.retireOptionUsed = true;
    } else if (arg === '--full-clean') {
      options.fullClean = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--exclude-primary') {
      options.excludePrimary = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--worktrees-only') {
      options.worktreesOnly = true;
      options.excludePrimary = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--min-age-minutes') {
      options.minAgeMinutes = parseNonNegativeInteger(args.shift(), '--min-age-minutes');
      options.minAgeOptionUsed = true;
      options.reclaimOptionUsed = true;
    } else if (arg === '--workflow-root') {
      options.workflowRoots.push(parseValue(args.shift(), '--workflow-root'));
      options.reclaimOptionUsed = true;
    } else if (arg.startsWith('--workflow-root=')) {
      options.workflowRoots.push(parseValue(arg.slice('--workflow-root='.length), '--workflow-root'));
      options.reclaimOptionUsed = true;
    } else if (arg === '--workflow-ref') {
      options.workflowRefs.push(parseValue(args.shift(), '--workflow-ref'));
      options.reclaimOptionUsed = true;
    } else if (arg.startsWith('--workflow-ref=')) {
      options.workflowRefs.push(parseValue(arg.slice('--workflow-ref='.length), '--workflow-ref'));
      options.reclaimOptionUsed = true;
    } else if (arg === '--min-free-gb') {
      options.minFreeGb = parsePositiveNumber(args.shift(), '--min-free-gb');
      options.diskPressureOptionUsed = true;
    } else if (arg.startsWith('--min-free-gb=')) {
      options.minFreeGb = parsePositiveNumber(arg.slice('--min-free-gb='.length), '--min-free-gb');
      options.diskPressureOptionUsed = true;
    } else if (arg.startsWith('--min-age-minutes=')) {
      options.minAgeMinutes = parseNonNegativeInteger(arg.split('=')[1], '--min-age-minutes');
      options.minAgeOptionUsed = true;
      options.reclaimOptionUsed = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      roots.push(arg);
    }
  }

  options.explicitRoots = roots.length > 0;

  if (command === 'session-complete') {
    if (roots.length !== 1) throw new Error('session-complete requires exactly one explicit worktree root.');
    options.tool = 'auto';
  }

  if (command === 'retire' && roots.length !== 1) {
    throw new Error('retire requires exactly one explicit worktree path.');
  }

  if (!['reclaim', 'session-complete', 'disk-pressure', 'retire'].includes(command) && (options.reclaimOptionUsed || options.diskPressureOptionUsed)) {
    throw new Error('--tool, --apply, --yes, --full-clean, --exclude-primary, --worktrees-only, --min-age-minutes, --workflow-root, --workflow-ref, and --min-free-gb are only valid with reclaim, retire, or disk-pressure.');
  }
  if (command !== 'retire' && options.retireOptionUsed) {
    throw new Error('--retain-branch is only valid with retire.');
  }
  if (command === 'retire') {
    if (options.toolOptionUsed || options.fullClean || options.excludePrimary || options.worktreesOnly || options.minAgeOptionUsed || options.workflowRoots.length > 0 || options.workflowRefs.length > 0 || options.diskPressureOptionUsed) {
      throw new Error('retire accepts scan evidence options plus --retain-branch --apply --yes; reclaim and disk-pressure options are not valid.');
    }
    if (options.apply && !options.retainBranch) {
      throw new Error('Worktree retirement requires the explicit --retain-branch policy.');
    }
  }
  if (command === 'disk-pressure' && (options.fullClean || options.workflowRoots.length > 0 || options.workflowRefs.length > 0)) {
    throw new Error('disk-pressure manages linked-worktree caches only; --full-clean, --workflow-root, and --workflow-ref are not valid.');
  }
  if (command === 'disk-pressure' && options.toolOptionUsed) {
    throw new Error('disk-pressure selects its worktree-cache providers automatically; --tool is not valid.');
  }
  if (command !== 'disk-pressure' && options.diskPressureOptionUsed) {
    throw new Error('--min-free-gb is only valid with disk-pressure.');
  }
  if (command === 'reclaim' || command === 'session-complete' || command === 'disk-pressure' || command === 'retire') {
    if (options.apply && !options.yes) {
      throw new Error(command === 'retire'
        ? 'Worktree retirement requires --apply --yes.'
        : 'Permanent reclaim requires --apply --yes.');
    }
    if (options.yes && !options.apply) throw new Error('--yes is only valid with --apply.');
    if (options.apply && !options.explicitRoots) {
      throw new Error('Permanent action requires at least one explicit root.');
    }
  }

  if (!options.explicitRoots) {
    roots.push(...defaultRoots());
  }

  return { command, roots, options };
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== String(value)) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function parseValue(value, flag) {
  const parsed = (value ?? '').trim();
  if (!parsed || parsed.startsWith('-')) throw new Error(`${flag} requires a value`);
  return parsed;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive number`);
  return parsed;
}

function parseCommandsTier(value) {
  const tiers = ['worktree-and-branch', 'worktree-only', 'branch'];
  if (!tiers.includes(value)) {
    throw new Error(`--commands= requires one of: ${tiers.join(', ')}`);
  }
  return value;
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

  console.log(withToolProvenance(formatScanText(report, options), report));
}

function printReclaimReport(report, options) {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(withToolProvenance(formatReclaimText(report), report));
}

function withToolProvenance(text, report) {
  return `${text}\n\nTool: ${formatToolProvenance(report.provenance)}`;
}

function printHelp() {
  console.log(`git-groundskeeper

Usage:
  git-groundskeeper scan [roots...] [options]
  git-groundskeeper status [roots...] [options]
  git-groundskeeper watch [roots...] [options]
  git-groundskeeper reclaim [roots...] [options]
  git-groundskeeper session-complete <worktree> [options]
  git-groundskeeper disk-pressure [roots...] [options]
  git-groundskeeper retire <worktree> [options]
  git-groundskeeper --version

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
  --progress             Force progress on stderr. Interactive terminals get
                         the animated Deep Forest Telemetry dashboard; pipes
                         get a restrained, escape-free phase log.
  --3d-progress          Add a full-terminal framed ASCII environment to Deep
                         Forest Telemetry, using the available TTY width and
                         height. Implies --progress; pipes keep the phase log.
  --signal-progress      Add the full-terminal Signal Garden: a responsive
                         matrix of cell scans, waves, registers, and vector
                         fields driven by phase-local progress. Implies
                         --progress; pipes keep the restrained phase log.
  --pulse-progress       Add the full-terminal Pulse Observatory: a live ECG
                         trace with a truthful phase-progress gate, illuminated
                         history, and indeterminate acquisition mode. Implies
                         --progress; pipes keep the restrained phase log.
  --wave-progress        Add the full-terminal Centre Wave: phase-offset ASCII
                         bands with black channels, ambient crests, and a
                         truthful progress gate. Implies --progress; pipes keep
                         the restrained phase log.
  --no-progress          Disable progress. Auto mode uses the dashboard only
                         in interactive terminals and never alters stdout.
  --fail-on-attention    Exit 1 when outstanding Git state is found.
  --max-depth <n>        Recursive discovery depth. Default: 8.
  --large-file-mb <n>    Flag dirty files at or above this size. Default: 10.
  --untracked-all        List every file inside untracked directories. Slow on
                         wide scans; the default collapses them per directory.
  --buckets              List worktrees grouped by what removing them costs:
                         worktree + branch, worktree only, blocked, primary.
  --keeps-details        Append exact ignored-content path samples and
                         conservative, repository-scoped rule advice to the
                         selected report layout; never suppresses content.
  --commands[=tier]      Print removal commands for reclaimable buckets, so
                         git re-checks each one. Implies --buckets. Commands
                         recheck branch base/tip or detached retention; never
                         emit --force or -D. Select one shape:
                         worktree-and-branch, worktree-only, or branch.
  --sizes                Measure every discovered worktree, including primary,
                         dirty, and blocked rows. Adds a du walk per worktree.
  --scope-strict         With --sizes, measure only worktrees inside the exact
                         requested roots. Repository-wide Git safety metadata
                         is still inspected so outside checkouts stay visible.
  --no-squash-detect     Skip squash-merge content comparison. Scans are
                         read-only either way; this faster mode can miss
                         squash-merged branches.
  --no-pr-check          Skip live GitHub merged-PR and open-draft WIP
                         evidence. Integrated live branches stay in the
                         retain-branch bucket; gone upstreams fall back to
                         local inference, and drafts are not marked as WIP.
  --no-live-remote-check Skip targeted, read-only remote branch checks. Stale
                         tracking refs can then hide a branch deleted remotely
                         until you explicitly fetch with --prune.
  --owner <name>         Account or org you own. Repeatable. Tags each repo as
                         mine, external, or no-remote by its remote URL. When
                         omitted, owners are detected via gh and cached a day.
  --mine                 Report only repos matching an owner. Cuts vendored
                         dependencies and agent scratch out of the summary.
  --no-detect-owners     Skip gh detection; rely only on --owner.
  --refresh-owners       Re-query gh instead of using the cached owners.
  --concurrency <n>      Git calls in flight. Default: available parallelism.
  --interval <seconds>   Watch interval. Default: 15.
  -V, --version          Print version, commit, dirty state, and source mode.
  -h, --help             Show help.

Reclaim options:
  --tool <provider>      Reclaim provider: auto, flutter, node, swiftpm, or
                         xcode, or runner.
  --workflow-root <dir>  Git checkout whose remote workflow refs protect
                         runner Flutter cache versions. Repeatable; required
                         before any runner-cache deletion is eligible.
  --workflow-ref <ref>   Workflow ref to inspect instead of origin/main,
                         origin/master, origin/dev, and origin/develop.
  --full-clean           Plan Flutter's broader clean set instead of only the
                         configured build output. Flutter only; dry-run unless
                         --apply.
  --min-age-minutes <n>  Block targets changed recently. Default: 10; use 0 to
                         disable the freshness hold.
  --exclude-primary      Omit every repository's primary worktree.
  --worktrees-only       Reclaim only linked worktrees; implies
                         --exclude-primary.
  --apply --yes          Permanently execute an approved plan. Both flags and
                         at least one explicit root are required. The command
                         revalidates evidence immediately before each action.
  --min-free-gb <n>      disk-pressure threshold in GiB. Default: 20.

Session completion:
  session-complete runs the auto provider against exactly one worktree. It is
  read-only by default and never removes the worktree or branches. Add
  --apply --yes to reclaim only proven generated output after revalidation.

Worktree retirement:
  retire plans one exact linked-worktree removal and is read-only by default.
  It rechecks cleanliness, ignored content, branch and full HEAD, locks, Git
  operations, submodules, detached retention, and active processes. Apply
  requires --retain-branch --apply --yes; branch deletion is never performed.

Retire options:
  --retain-branch        Explicitly preserve the attached branch. Required
                         with --apply; detached HEADs receive a safety branch.

Examples:
  git-groundskeeper scan
  git-groundskeeper scan --details
  git-groundskeeper scan .
  git-groundskeeper scan ~/Development
  git-groundskeeper scan ~/Development --json
  git-groundskeeper scan ~/Development --color=always
  git-groundskeeper scan ~/Development --3d-progress
  git-groundskeeper scan ~/Development --signal-progress
  git-groundskeeper scan ~/Development --pulse-progress
  git-groundskeeper scan ~/Development --wave-progress
  git-groundskeeper scan ~/Development --fail-on-attention
  git-groundskeeper watch ~/Development --interval 30
  git-groundskeeper reclaim ~/Development --tool flutter
  git-groundskeeper reclaim ~/Development/MyApp --tool flutter --apply --yes
  git-groundskeeper reclaim ~/Development --tool xcode
  git-groundskeeper reclaim ~/Development --tool auto --worktrees-only
  git-groundskeeper reclaim ~/.github-runners/numbus-flutter --tool runner --workflow-root ~/Development/numbus/B2C/numbus
  git-groundskeeper disk-pressure ~/Development --min-free-gb 20
  git-groundskeeper disk-pressure ~/Development --min-free-gb 20 --apply --yes
  git-groundskeeper session-complete ~/Development/MyApp-worktrees/feature
  git-groundskeeper session-complete ~/Development/MyApp-worktrees/feature --apply --yes
  git-groundskeeper retire ~/Development/MyApp-worktrees/feature --retain-branch
  git-groundskeeper retire ~/Development/MyApp-worktrees/feature --retain-branch --apply --yes
  git-groundskeeper reclaim ~/Development/codex-island --tool xcode --apply --yes
`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
