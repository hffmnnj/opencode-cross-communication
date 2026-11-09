# opencode-cross-communication

Async DMs and a shared group chat for agents inside one OpenCode session
family. Messages arrive as native user input (`delivery: "steer"`,
`resume: false`), so a running agent picks them up at a work boundary
without being interrupted, and idle agents are never woken.

## Install

Native Promise plugin for OpenCode V2 (developed against 2.1.4).
Package export is `dist/index.js`; build with:

```sh
bun install && bun run check
```

Register it in your existing OpenCode config with the **absolute**
package path (watched config picks it up, no restart):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-cross-communication"]
}
```

See `docs/DEPLOY.md` for activation, verification, and rollback.
Rollback is removing this entry only; it leaves user data and other
settings alone.

The active-session reader discovers an already-running managed service,
including its dynamic port and credentials; it never starts or stops one.
It accepts only an authenticated loopback endpoint owned by the plugin's
server process. Explicit non-managed endpoints remain supported as described
in `docs/DEPLOY.md`. Discovery or identity failures disable chat delivery.

## Usage

Tools live under the `agent_chat` namespace. Use the Code Mode
signatures your session discovers (native direct tool names carry an
underscore namespace prefix, so prefer what the catalog shows):

```ts
// Who is in my session family?
const family = await tools.agent_chat.members();
// { self, rootID, members: [{ sessionID, parentID?, agent?, title?, archived, active }] }

// DM a sibling, your parent, or the family root
await tools.agent_chat.send({ to: "ses_abc123", text: "Schema is ready, see thread." });
await tools.agent_chat.send({ to: "parent", text: "Need a decision on the retry limit." });
await tools.agent_chat.send({ to: "root", text: "Milestone shipped, receipts attached." });

// Broadcast to every other active family member
await tools.agent_chat.send({ to: "group", text: "Starting the migration slice now." });

// Reply inside the original thread (keeps the original audience)
await tools.agent_chat.reply({ messageID: "chat_...", text: "Ack, folding that in." });

// Read back what you are allowed to see (newest first)
await tools.agent_chat.history({ limit: 20 });
await tools.agent_chat.history({ threadID: "chat_...", before: "chat_...", limit: 20 });

// Re-check per-recipient admission for a message you sent
await tools.agent_chat.receipt({ messageID: "chat_..." });
```

Codes you may see on errors: `invalid_input`, `not_allowed`,
`inactive`, `not_found`, `family_limit`, `rate_limit`, `unavailable`,
`id_conflict`.

## Behavior worth knowing

- **Family only.** DMs and group chat stay inside one root-ancestry
  family (nested children, native forks, and worktrees included). There is no
  cross-root chat. Private DMs are visible only to sender and
  recipient; group messages are visible to the whole family.
- **Identity comes from the runtime**, never from a caller-supplied
  field. `send`/`reply` act as whoever invoked the tool.
- **Active only.** Eligibility comes from native `session.active()`
  and is rechecked immediately before each admission. A DM to an
  inactive session fails; inactive group members are skipped. To start
  or resume work, use the native `subagent` tool — chat never spawns,
  wakes, interrupts, or waits for a recipient.
- **Threads keep their audience.** A reply goes to the original
  thread's recipient set (sender plus prior recipients, minus you).
  Agents created after the thread started are not added.
- **Receipts are admission, not attention.** `admitted` means the
  message reached the recipient's durable inbox; it does not mean the
  message was read, seen by the model, or acted on. `pending`,
  `failed`, and `unknown` distinguish "not yet", "rejected", and
  "could not confirm" — treat `unknown` as uncertain, not delivered.
- **No exact atomicity promise.** The native API has no atomic
  check-active-plus-admit. The plugin rechecks right before admission
  and never resumes a session, so if a recipient finishes in that tiny
  race the message may stay queued without waking it.
- **Cancellation is best effort.** V2's plugin adapter does not propagate
  request signals into in-flight native session calls. A cancelled send
  can still finish admission; use its stable request ID to reconcile a
  retry rather than assuming cancellation withdrew the message.
- **Safe retries.** Repeating the same send with the same `requestID`
  is idempotent and returns the existing message. Reusing a
  `requestID` with a changed payload is rejected (`id_conflict`).
  Stable IDs and the durable log cover retries, not indefinite
  exactly-once guarantees after log eviction. The native transcript is
  retained by OpenCode separately.
- **Peer text is data.** Incoming message bodies arrive labelled as
  peer-provided data with a stable message ID, never as new user
  instructions or authority. Existing prompt guards can still reject
  delivery, and cache-protection or permission blocks are reported,
  never bypassed. There are no auto-acknowledgments or relay loops.

## Limits

- 8,000 characters per message; 32 recipients per message.
- Up to 64 discovered family members; 20 new sends per rolling minute
  per sender.
- 500 retained chat messages per family; history pages up to 50,
  newest-first with an opaque `before` cursor.

## Cache note

Delivery only appends native user input. The plugin adds no
context/system/model/HTTP transforms and does not touch prior history
or cache keys. Registering the plugin adds static new tools, which
changes the tool catalog once; ordinary messages keep that catalog
stable. Provider caching and native compaction remain provider/runtime
behavior, so 100% cache hits cannot be guaranteed.

## Design sources

- [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins): native tools, durable user prompt admission, and plugin storage. The running server's `/openapi.json` is the compatibility authority for this installation.
- [Codex multi-agent tool definitions](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs): `send_message` queues coordination without triggering a new turn; `followup_task` is a separate lifecycle operation. Group chat and private history here are this plugin's own design, not claims about Codex.
