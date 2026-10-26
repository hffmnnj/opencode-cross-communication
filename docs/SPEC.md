# Cross-communication

## Goal

Give agents in one OpenCode session family asynchronous DMs and a shared group chat, delivered as native user messages without interrupting work or rewriting the cached prompt prefix.

## Not doing

- No new OpenCode host, service, database edits, session creation, or lifecycle bypass.
- No cross-project/global chat, external messaging service, separate web UI, or automatic reply bots.
- No changing provider cache keys, model settings, existing history, system instructions, or cache-protection policy.
- No claim that a provider guarantees cache hits, or that admission proves an agent read a message.

## Scope

1. Discover participants through verified native session ancestry.
2. Send a DM to a session, parent, or root; broadcast to the current family.
3. Reply in a thread and inspect a bounded persistent conversation log.
4. Return per-recipient admission receipts, with explicit failures and safe retries.
5. Register discoverable native tools with typed results; do not log private chat for command output.
6. Load in the existing main OpenCode server through watched configuration.

## Acceptance checks

- Sender identity comes from tool execution context, never caller-supplied identity. Unrelated families cannot read or receive messages. Only recipients present in native `session.active()` may be messaged; inactive DMs are rejected, inactive group members are skipped, and active membership is rechecked immediately before each admission.
- Sending returns after durable inbox admission, without waiting for recipient inference, interrupting it, or spawning a session.
- The native prompt contains a stable message ID, peer-data attribution, and no authority escalation; existing prompt guards can reject delivery.
- Direct, parent, root, group, reply, history, and per-recipient receipt behavior have deterministic tests, including partial failure and duplicate retry.
- Native delivery only appends user input. The plugin registers no context/system/model/HTTP transforms and does not alter cache keys.
- Typecheck, tests, build, native main-server activation, and a real native-tool messaging exchange are verified without restarting the server.
- Usage, delivery limits, cache caveats, and reversible installation are documented; the private repository has a topic-branch PR.

## Delivery decisions

- OpenCode V2 only. The existing main server reports version 2.1.4.
- Use the native durable session inbox, not synthetic context injection or prompt hooks.
- Session-family membership is a server-verified root ancestry relationship, including nested children and worktrees; it is not an agent-name match.
- Group fan-out is explicit and excludes the sender. No automatic acknowledgments or polling wakeups.
- Messaging always sets `resume: false`: running recipients consume native steer input at a boundary. Inactive recipients are not messaged. Launching or resuming a task is exclusively the native `subagent` tool's job.
- The native API does not expose atomic conditional admission against its active registry. Recheck immediately before admission and never wake a session; a recipient that finishes during that native race may retain a queued message without being resumed. Do not claim stronger atomic guarantees.
- Keep the latest 500 chat messages per family in plugin storage; history is newest-first with an opaque message cursor. Native inbox history remains managed by OpenCode.
- Limit one message to 8,000 characters and 32 recipients, family discovery to 64 members, and each sender to 20 new messages per rolling minute. These are flood limits, not liveness clocks.
- Existing cache-protection admission and dispatch guards remain authoritative; blocked or uncertain delivery is reported, never routed around.
