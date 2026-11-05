import { fileURLToPath } from 'node:url';
import { MCPClient } from '../client/configuration.js';

// A real host with two stdio connections and its own asynchronous shutdown (#27478).
const [, , hooks, disconnectFirst, signal = 'SIGTERM'] = process.argv;
const server = {
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./noisy-server.ts', import.meta.url))],
  stderr: 'pipe',
} satisfies import('../client/types.js').MastraMCPServerDefinition;
const mcp = new MCPClient({
  servers: { first: server, second: server },
  ...(hooks === 'default' ? {} : { registerProcessHooks: hooks === 'true' }),
});

const processEvents = ['SIGINT', 'SIGTERM', 'SIGHUP', 'beforeExit', 'exit', 'message'] as const;
const countListeners = () => Object.fromEntries(processEvents.map(event => [event, process.listenerCount(event)]));

process.once(signal, async () => {
  console.log('host: starting cleanup');
  await mcp.disconnect();
  // Models awaited host work (for example, draining requests) after MCP teardown.
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('host: cleanup finished');
  process.exit(0);
});

const listeners: Record<string, Record<string, number>> = { before: countListeners() };
const { errors } = await mcp.listToolsWithErrors();
if (Object.keys(errors).length) throw new Error(JSON.stringify(errors));
listeners.connected = countListeners();
if (disconnectFirst === 'true') {
  await mcp.disconnect();
  listeners.disconnected = countListeners();
}
console.log(`host: listeners ${JSON.stringify(listeners)}`);
console.log('host: READY');
setInterval(() => {}, 1000);
