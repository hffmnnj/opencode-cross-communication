# Cross-communication engineering

- OpenCode V2's plugin `SessionDomain` omits `active` even though the client and HTTP API expose it. Keep the same-process, authenticated read-only adapter in `src/activity.ts`; do not cast the missing method into existence.
- Keep the root `index.ts` compatibility shim: native local-directory loading resolves an index entry, not the package export map. `tests/entrypoint.test.ts` exercises the actual resolver.
- Only native active-registry membership permits delivery. Preserve `resume: false` and the immediate pre-admission activity recheck. Keep `agent_chat` ancestry checks same-family; `agent_sessions` permits only private, explicitly addressed structural roots, never descendant callers or recipients. Keep their storage and visibility separate. Native `subagent` owns task launch/resume.
- Keep tool schemas and descriptions static. Deliver through native user inbox admission; do not add context/system/provider transforms for chat.
- Render delivered peer messages as Markdown in `src/render.ts`: `Agent Message - ses_id (@agent) - title` header (single-line sanitized, agent tag and title omitted when absent), quoted peer-data notice, quoted body, and a reply handle with the stable message ID. Chat tool results keep sender header, quoted body, and summarized receipts. Do not put the peer JSON envelope back into the native inbox.
- `bun run check` from this repository runs the offline suite, typecheck, and build. Never start an OpenCode host or write its database for integration tests; use native tools on the existing main server.
