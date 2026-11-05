---
'@mastra/mcp': patch
---

Fixed `MCPClient` ending the host process on `SIGINT` or `SIGTERM` after `disconnect()`. A client with the default process hooks used to leave process-wide signal listeners behind, so the next signal exited the process before the application's own shutdown could finish, even with every client disconnected. The hooks now go away when the last client disconnects. While a client is connected, a signal still disconnects it and ends the process as before. Follow-up to [#27478](https://github.com/mastra-ai/mastra/issues/27478).

`SIGHUP` now ends the process with exit code 129 instead of 0, so a supervisor no longer reads it as a clean exit.
