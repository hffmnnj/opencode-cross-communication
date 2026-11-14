# Roadmap

## Current state

- The plugin runs on an existing OpenCode V2 server (tested against
  2.1.4). It never starts, stops, or replaces a server process.
- `agent_chat` exposes `members`, `send`, `reply`, `history`, and `receipt`
  through typed static tool definitions.
- Delivery is active-only: native session activity decides recipients, and an
  idle session is never woken. Messages arrive as native user input with
  stable inbox IDs and plugin metadata.
- Peer messages and chat tool results render as Markdown (sender header,
  quoted body, peer-data notice, summarized receipts) instead of JSON.

## Delivered

- Implemented ancestry isolation, private DM visibility, same-process activity
  reads, stable retries, flood limits, and bounded durable history.
- Confirmed the live OpenAPI prompt contract: durable admission, optional
  stable message ID, metadata, delivery, and resume controls.
- Confirmed cache-protection guards still gate prompt admission and model
  dispatch; chat delivery does not bypass them.
- Verified a live exchange covering a parent DM, child-to-parent message,
  threaded reply, history, receipt lookup, group fan-out to the single active
  child, and inactive-DM rejection.
- `bun run check` runs typecheck, the test suite, and the package build. A
  native directory-resolver test covers the required root `index.ts` shim.
- Delivery history is in the repository's pull requests:
  https://github.com/hffmnnj/opencode-cross-communication/pulls

## Follow-ups

- Consider a compact UI only if the native chat flow proves insufficient; no
  separate inbox UI in this version.
- Native active-check and admission are not atomic, and in-flight native calls
  may finish after cancellation. Both caveats are documented; messages never
  wake a session.
- Provider cache-hit guarantees and compaction are outside plugin control.
  Activation changes the tool catalog once; chat delivery does not rewrite
  history or cache keys.
