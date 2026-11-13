# Deploying opencode-cross-communication

Target: the existing main OpenCode server (V2 2.1.4). No new host, no
alternate port or profile, no service lifecycle changes.

## 1. Build

In your local checkout of `opencode-cross-communication`:

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

The plugin discovers the existing managed service on each activity read with
`Service.discover()`; it never starts or stops a service. The discovered
loopback HTTP origin and Basic credentials come from the local service
registration, including on Windows with a dynamic port. Discovery's health
probe runs in an isolated worker that rejects non-loopback targets and
redirects without changing the host's global `fetch`. The plugin then checks
`/api/info` against its own process ID before reading `/api/session/active`.
Missing or unready registration, missing credentials, a different process,
redirects, and invalid activity responses fail closed (`unavailable`).

For a non-managed server, set plugin option `apiBaseURL` to its explicit
loopback HTTP origin. This legacy mode uses the server process's
`OPENCODE_SERVER_USERNAME` (default `opencode`) and
`OPENCODE_SERVER_PASSWORD`. It performs the same PID and activity checks;
it does not fall back to discovery if the explicit endpoint fails. Neither
mode logs or persists credentials. Only `127.0.0.1` and `::1` loopback
addresses are accepted, not DNS names or remote addresses.

## 4. Rollback

Reversible and narrow: remove this plugin entry from the config and
leave everything else alone — user data, other plugins, and other
settings stay untouched. No data migration or cleanup step is needed;
the retained per-family chat log simply stops being written.
