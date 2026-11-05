import process from 'node:process';

/** A teardown that runs when the process is asked to end, bounded by `wait` milliseconds. */
interface ProcessHook {
  onExit: () => Promise<void>;
  wait: number;
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
type HookedSignal = keyof typeof SIGNAL_NUMBERS;

const hooks = new Set<ProcessHook>();
let listenersInstalled = false;
let exiting = false;

const signalListeners = Object.fromEntries(
  (Object.keys(SIGNAL_NUMBERS) as HookedSignal[]).map(signal => [
    signal,
    () => void runHooksAndExit(128 + SIGNAL_NUMBERS[signal]),
  ]),
) as Record<HookedSignal, () => void>;
const onBeforeExit = () => void runHooksAndExit();
// PM2 cluster mode asks workers to stop with an IPC message instead of a signal.
const onMessage = (message: unknown) => {
  if (message === 'shutdown') void runHooksAndExit();
};

function installListeners() {
  listenersInstalled = true;
  for (const [signal, listener] of Object.entries(signalListeners)) process.on(signal, listener);
  process.on('beforeExit', onBeforeExit);
  process.on('message', onMessage);
}

function removeListeners() {
  listenersInstalled = false;
  for (const [signal, listener] of Object.entries(signalListeners)) process.off(signal, listener);
  process.off('beforeExit', onBeforeExit);
  process.off('message', onMessage);
}

async function runHooksAndExit(signalExitCode?: number) {
  if (exiting) return;
  exiting = true;
  const exitCode = signalExitCode ?? (Number(process.exitCode) || 0);
  const pending = [...hooks];
  const forceAfter = Math.max(0, ...pending.map(hook => hook.wait));
  const timer = setTimeout(() => process.exit(exitCode), forceAfter);
  await Promise.allSettled(pending.map(hook => hook.onExit()));
  clearTimeout(timer);
  await flushStdio();
  process.exit(exitCode);
}

async function flushStdio() {
  const flush = (stream: NodeJS.WriteStream) =>
    new Promise<void>(resolve => {
      if (!stream.writable) {
        resolve();
        return;
      }
      try {
        stream.write('', () => resolve());
      } catch {
        resolve();
      }
    });
  await Promise.race([
    Promise.all([flush(process.stdout), flush(process.stderr)]),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
}

/**
 * Runs `onExit` when the process receives SIGINT, SIGTERM or SIGHUP, empties its event loop, or
 * gets a PM2 `shutdown` message, then exits (128 + signal number for signals). The process
 * listeners exist only while at least one hook does, so releasing the last hook leaves the host's
 * own shutdown alone.
 *
 * @returns A function that releases the hook.
 */
export function addProcessHook(onExit: () => Promise<void>, { wait }: { wait: number }): () => void {
  const hook: ProcessHook = { onExit, wait };
  if (!listenersInstalled) installListeners();
  hooks.add(hook);
  return () => {
    // Exiting keeps its listeners: a hook releasing itself mid-teardown must not hand a
    // second signal to Node's default handler before the others finish.
    if (hooks.delete(hook) && hooks.size === 0 && !exiting) removeListeners();
  };
}
