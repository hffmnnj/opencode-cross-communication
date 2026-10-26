# Deploying opencode-cross-communication

Target: the existing main OpenCode server (V2 2.1.4). No new host, no
alternate port or profile, no service lifecycle changes.

## 1. Build

In `/absolute/path/to/opencode-cross-communication`:

```sh
bun install && bun run check
```

This runs typecheck, tests, and the `dist/index.js` build (the package
export). Fix failures here before touching server config.
Keep root `index.ts`: the native directory resolver requires it even
though the package export points to `dist/index.js`.

## 2. Activate through watched config

Add the absolute package path to the plugin list in your existing
OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-cross-communication"]
}
```

The main server watches this config, so activation needs no restart.
Do not stop, restart, or mask the server process, and do not launch a
second server to test this.

## 3. Verify through the existing authenticated API

Confirm the live server still reports itself and the plugin, using the
authenticated API you already use. Do not print tokens or secrets in
output or logs:

- `GET /api/info` — server reachable, version 2.1.4.
- `GET /api/plugin?location[directory]=<project-directory>` —
  `opencode-cross-communication` reports `state.status: "active"`
  alongside the existing cache-protection plugins. Registration and
  early startup inventories alone do not prove activation.

Do not dump `/api/config` to inspect activation: it can contain
credential-bearing integration headers. Print only allowlisted status
fields from the plugin inventory.

Then exercise one real native-tool exchange (members → send → receipt)
inside a test session family and confirm the receipt reflects durable
inbox admission.

Use the `agent_chat` Code Mode tools. There is no slash command: V2's
server command API has no return channel, and private chat must not be
written to server logs as a substitute.

The plugin reads `/api/session/active` from the same server process,
verified by `/api/info` PID. Its default origin is
`http://127.0.0.1:4108`; a different loopback HTTP origin may be supplied
as plugin option `apiBaseURL`. It uses the server process's
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD` environment
variables without logging or persisting them. Missing credentials,
identity mismatch, redirects, and invalid activity responses fail closed.

## 4. Rollback

Reversible and narrow: remove this plugin entry from the config and
leave everything else alone — user data, other plugins, and other
settings stay untouched. No data migration or cleanup step is needed;
the retained per-family chat log simply stops being written.
