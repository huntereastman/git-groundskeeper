import { execFileSync } from 'node:child_process';

export function git(cwd, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', args, {
        cwd,
        encoding: options.encoding ?? 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message,
      status: error.status,
    };
  }
}

export function mustGit(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
