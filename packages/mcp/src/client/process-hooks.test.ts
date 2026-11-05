import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const hostScript = fileURLToPath(new URL('../__fixtures__/graceful-shutdown-host.ts', import.meta.url));

// Run node directly: the tsx CLI would intercept the signal before the host sees it.
async function signalHost({
  hooks,
  disconnectFirst = false,
  signal = 'SIGTERM',
}: {
  hooks: 'true' | 'false' | 'default';
  disconnectFirst?: boolean;
  signal?: NodeJS.Signals;
}) {
  const host = spawn(process.execPath, ['--import', 'tsx', hostScript, hooks, String(disconnectFirst), signal], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  host.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    host.once('error', reject);
    host.once('close', (code, signal) => resolve({ code, signal }));
  });
  const run = async () => {
    await new Promise<void>((resolve, reject) => {
      host.stdout.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.includes('host: READY')) resolve();
      });
      void exited.then(() => reject(new Error(`Host exited before READY: ${stdout}\n${stderr}`)), reject);
    });
    host.kill(signal);
    return { ...(await exited), stdout, stderr };
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Host timed out: ${stdout}\n${stderr}`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    host.kill('SIGKILL');
    await exited;
  }
}

type ListenerCounts = Record<string, number>;

function listenersFrom(stdout: string): Record<'before' | 'connected' | 'disconnected', ListenerCounts | undefined> {
  const line = stdout.split('\n').find(l => l.startsWith('host: listeners '));
  if (!line) throw new Error(`Host printed no listener counts: ${stdout}`);
  return JSON.parse(line.slice('host: listeners '.length));
}

// Signals must reach a real process: listener mocks can't show whether the host survives (#27478).
describe.skipIf(process.platform === 'win32')('MCPClient process hooks and host shutdown', () => {
  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] satisfies NodeJS.Signals[])(
    'lets the host finish awaited cleanup on %s with hooks disabled',
    async signal => {
      const result = await signalHost({ hooks: 'false', signal });
      expect(result.stdout).toContain('host: starting cleanup');
      expect(result.stdout).toContain('host: cleanup finished');
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    },
    20000,
  );

  it('still lets the host finish when disconnected before SIGTERM', async () => {
    const result = await signalHost({ hooks: 'false', disconnectFirst: true });
    expect(result.stdout).toContain('host: cleanup finished');
    expect(result.code).toBe(0);
    const listeners = listenersFrom(result.stdout);
    expect(listeners.connected).toEqual(listeners.before);
    expect(listeners.disconnected).toEqual(listeners.before);
  }, 20000);

  // A disconnected client must leave no process listener that ends the host on a signal.
  it('lets the host finish cleanup on SIGTERM after it disconnected clients that used default hooks', async () => {
    const result = await signalHost({ hooks: 'default', disconnectFirst: true });
    expect(result.stdout).toContain('host: cleanup finished');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    const listeners = listenersFrom(result.stdout);
    expect(listeners.disconnected).toEqual(listeners.before);
  }, 20000);

  it.each([
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] satisfies [NodeJS.Signals, number][])(
    'ends a host with connected default-hook clients on %s with exit code %i',
    async (signal, code) => {
      const result = await signalHost({ hooks: 'default', signal });
      expect(result.stdout).toContain('host: starting cleanup');
      expect(result.stdout).not.toContain('host: cleanup finished');
      expect(result.code).toBe(code);
      expect(result.signal).toBeNull();
    },
    20000,
  );

  it.each(['default', 'true'] as const)(
    'preserves %s SIGTERM exit behavior',
    async hooks => {
      const result = await signalHost({ hooks });
      expect(result.stdout).toContain('host: starting cleanup');
      expect(result.stdout).not.toContain('host: cleanup finished');
      expect(result.code).toBe(143);
      expect(result.signal).toBeNull();
    },
    20000,
  );
});
