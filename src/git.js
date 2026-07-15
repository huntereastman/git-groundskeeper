import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Git is invoked thousands of times during a wide scan and the cost is almost
// entirely process spawn latency, not compute. These are async so callers can
// overlap them; see mapWithConcurrency in scanner.js for the pooling.
export async function git(cwd, args, options = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      // Never let a repository with a misconfigured remote block the scan on
      // a credential prompt. Everything this tool runs is local and read-only.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? (options.encoding === 'buffer' ? Buffer.alloc(0) : ''),
      stderr: error.stderr?.toString() ?? error.message,
      status: error.code,
    };
  }
}

export async function mustGit(cwd, args, options = {}) {
  const result = await git(cwd, args, options);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
