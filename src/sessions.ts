import { createHash } from "node:crypto";
import { ChatError, LIMITS, type ChatLog, type ChatMessage, type ChatPorts, type HistoryInput, type HistoryResult, type ReplyInput, type SessionRecord } from "./contract.ts";
import { renderEnvelope } from "./render.ts";

const KEY = "opencode-cross-communication:cross-session:v1";
let tail: Promise<void> = Promise.resolve();
async function locked<T>(run: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await run(); } finally { release(); }
}
const hash = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const valid = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(s);
const error = (code: ConstructorParameters<typeof ChatError>[0], message: string): never => { throw new ChatError(code, message); };
type Stored = ChatMessage & { readonly requestFingerprint: string };
export interface DiscoveryInput { readonly query?: string; readonly allProjects?: boolean; readonly limit?: number; readonly after?: string }
export interface DiscoveryResult {
  readonly sessions: readonly { readonly sessionID: string; readonly title?: string; readonly agent?: string; readonly projectID: string; readonly directory: string; readonly active: true }[];
  readonly next?: string;
}

export function createSessionService(ports: ChatPorts) {
  const now = ports.now ?? Date.now;
  async function get(id: string, signal?: AbortSignal): Promise<SessionRecord> {
    if (!valid(id)) return error("invalid_input", "Invalid session ID.");
    signal?.throwIfAborted();
    let record: SessionRecord;
    try { record = await ports.session.get({ sessionID: id }, { signal }); }
    catch { signal?.throwIfAborted(); return error("unavailable", "Session could not be verified."); }
    if (!record || record.id !== id || !record.time || typeof record.time !== "object") return error("unavailable", "Session could not be verified.");
    return record;
  }
  async function root(id: string, signal?: AbortSignal): Promise<SessionRecord> {
    const record = await get(id, signal);
    if (record.parentID !== undefined || record.time.archived !== undefined) return error("not_allowed", "Only unarchived root sessions may use cross-session chat.");
    return record;
  }
  async function active(signal?: AbortSignal): Promise<Readonly<Record<string, { readonly type: "running" }>>> {
    signal?.throwIfAborted();
    try {
      const result = await ports.session.active({ signal });
      if (!result || typeof result !== "object" || Array.isArray(result) || Object.values(result).some(v => !v || v.type !== "running")) throw new Error();
      signal?.throwIfAborted();
      return result;
    } catch { signal?.throwIfAborted(); return error("unavailable", "Session activity could not be verified."); }
  }
  const running = (registry: Readonly<Record<string, unknown>>, id: string) => Object.hasOwn(registry, id);
  async function load(): Promise<Stored[]> {
    let value: unknown;
    try { value = await ports.storage.get(KEY); } catch { return error("unavailable", "Chat storage is unavailable."); }
    if (value === undefined) return [];
    const log = value as ChatLog;
    if (!log || log.version !== 1 || !Array.isArray(log.messages) || log.messages.length > LIMITS.retainedMessages ||
      log.messages.some(m => !m || !valid(m.id) || !valid(m.threadID) || !m.from || !valid(m.from.sessionID) ||
        m.kind !== "direct" || !Array.isArray(m.receipts) || m.receipts.length !== 1 ||
        !valid(m.receipts[0]?.sessionID) || !valid(m.receipts[0]?.inboxID) ||
        !["pending", "admitted", "failed", "unknown"].includes(m.receipts[0]!.status) ||
        m.receipts[0]!.sessionID === m.from.sessionID || typeof m.text !== "string" ||
        typeof (m as Stored).requestFingerprint !== "string" || typeof m.createdAt !== "number")) {
      return error("unavailable", "Stored cross-session log is invalid.");
    }
    return structuredClone(log.messages) as Stored[];
  }
  async function save(messages: readonly Stored[]) {
    try { await ports.storage.set(KEY, { version: 1, messages }); } catch { error("unavailable", "Chat storage is unavailable."); }
  }
  function publicMessage(message: Stored): ChatMessage {
    const { requestFingerprint: _, ...result } = message;
    return structuredClone(result);
  }
  function visible(message: Stored, caller: string) {
    return message.from.sessionID === caller || message.receipts[0]!.sessionID === caller;
  }
  function find(messages: Stored[], caller: string, id: string): Stored {
    if (!valid(id)) return error("invalid_input", "Invalid message ID.");
    return messages.find(m => m.id === id && visible(m, caller)) ?? error("not_found", "Message not found.");
  }
  async function write(caller: string, input: { text: string; requestID?: string }, operationID: string, target?: string, replyTo?: string, signal?: AbortSignal): Promise<ChatMessage> {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > LIMITS.messageChars || !valid(operationID) ||
      (input.requestID !== undefined && !valid(input.requestID))) return error("invalid_input", "Invalid message or request ID.");
    if (target !== undefined && !valid(target)) return error("invalid_input", "Invalid target.");
    if (replyTo !== undefined && !valid(replyTo)) return error("invalid_input", "Invalid message ID.");
    return locked(async () => {
      const self = await root(caller, signal);
      const id = `cross_${hash(caller, input.requestID ?? operationID)}`;
      const fingerprint = hash(input.text, target ?? "", replyTo ?? "");
      let messages = await load();
      let message = messages.find(m => m.id === id);
      if (message && (message.from.sessionID !== caller || message.requestFingerprint !== fingerprint)) return error("id_conflict", "Message ID was used for a different request.");
      if (!message) {
        const original = replyTo === undefined ? undefined : find(messages, caller, replyTo);
        const recipient = original ? (original.from.sessionID === caller ? original.receipts[0]!.sessionID : original.from.sessionID) : target;
        if (!recipient || recipient === caller) return error("invalid_input", "Choose another root session.");
        await root(recipient, signal);
        const registry = await active(signal);
        if (!running(registry, caller) || !running(registry, recipient)) return error("inactive", "Both root sessions must be running.");
        if (messages.filter(m => m.from.sessionID === caller && m.createdAt > now() - 60_000).length >= LIMITS.messagesPerMinute) return error("rate_limit", "Message rate limit exceeded.");
        if (messages.length >= LIMITS.retainedMessages) {
          const index = messages.findIndex(m => ["admitted", "failed"].includes(m.receipts[0]!.status));
          if (index < 0) return error("unavailable", "Chat log has too many unresolved messages.");
          messages.splice(index, 1);
        }
        message = { id, rootID: caller, threadID: original?.threadID ?? id, ...(replyTo ? { replyTo } : {}),
          from: { sessionID: caller, ...(self.agent === undefined ? {} : { agent: self.agent }), ...(self.title === undefined ? {} : { title: self.title }), archived: false, active: true },
          kind: "direct", text: input.text, createdAt: now(), requestFingerprint: fingerprint,
          receipts: [{ sessionID: recipient, inboxID: `msg_${hash(id, recipient)}`, status: "pending" }] };
        messages.push(message);
        await save(messages);
      }
      const receipt = message.receipts[0]!;
      if (receipt.status !== "admitted") {
        let updated: typeof receipt;
        try {
          await root(caller, signal);
          await root(receipt.sessionID, signal);
          const registry = await active(signal);
          signal?.throwIfAborted();
          if (!running(registry, caller) || !running(registry, receipt.sessionID)) {
            updated = { ...receipt, status: "failed", detail: "Both root sessions must be running." };
          } else {
            const admission = await ports.session.prompt({ sessionID: receipt.sessionID, id: receipt.inboxID,
              text: renderEnvelope(message, "agent_sessions.reply"), metadata: { source: "opencode-cross-communication", messageID: message.id, threadID: message.threadID, fromSessionID: caller, rootID: caller },
              delivery: "steer", resume: false }, { signal });
            updated = admission?.id === receipt.inboxID && admission.sessionID === receipt.sessionID
              ? { ...receipt, status: "admitted" } : { ...receipt, status: "unknown", detail: "Inbox admission could not be confirmed." };
          }
        } catch (cause) {
          updated = cause instanceof ChatError && cause.code === "not_allowed"
            ? { ...receipt, status: "failed", detail: "A session is no longer an eligible root." }
            : { ...receipt, status: "unknown", detail: "Inbox admission could not be confirmed." };
        }
        message = { ...message, receipts: [updated] };
        messages = messages.map(m => m.id === id ? message! : m);
        await save(messages);
      }
      signal?.throwIfAborted();
      return publicMessage(message);
    });
  }
  return {
    async list(caller: string, input: DiscoveryInput = {}, signal?: AbortSignal): Promise<DiscoveryResult> {
      const self = await root(caller, signal);
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (input.after !== undefined && !valid(input.after)) ||
        (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 256)) ||
        (input.allProjects !== undefined && typeof input.allProjects !== "boolean")) return error("invalid_input", "Invalid discovery options.");
      if (!valid(self.projectID)) return error("unavailable", "Current project could not be verified.");
      const registry = await active(signal);
      if (Object.keys(registry).length > 10_000) return error("unavailable", "Active session discovery exceeds 10,000 records.");
      const ids = Object.keys(registry).filter(id => id !== caller && (input.after === undefined || id > input.after)).sort();
      const result: DiscoveryResult["sessions"][number][] = [];
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      for (const id of ids) {
        let session: SessionRecord;
        try { session = await get(id, signal); } catch { signal?.throwIfAborted(); continue; }
        if (session.parentID !== undefined || session.time.archived !== undefined || !valid(session.projectID) ||
          !session.location || typeof session.location.directory !== "string" || !session.location.directory) continue;
        if (!input.allProjects && session.projectID !== self.projectID) continue;
        if (query && ![session.id, session.title, session.agent, session.projectID, session.location.directory].some(s => s?.toLocaleLowerCase().includes(query))) continue;
        result.push({ sessionID: id, ...(session.title === undefined ? {} : { title: session.title }), ...(session.agent === undefined ? {} : { agent: session.agent }), projectID: session.projectID, directory: session.location.directory, active: true });
        if (result.length > limit) break;
      }
      const next = result.length > limit ? result[limit - 1]?.sessionID : undefined;
      return { sessions: result.slice(0, limit), ...(next ? { next } : {}) };
    },
    send(caller: string, input: { to: string; text: string; requestID?: string }, operationID: string, signal?: AbortSignal) {
      return write(caller, input, operationID, input.to, undefined, signal);
    },
    reply(caller: string, input: ReplyInput, operationID: string, signal?: AbortSignal) {
      return write(caller, input, operationID, undefined, input.messageID, signal);
    },
    async history(caller: string, input: HistoryInput = {}, signal?: AbortSignal): Promise<HistoryResult> {
      await root(caller, signal);
      const limit = input.limit ?? LIMITS.historyPage;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.historyPage || (input.before !== undefined && !valid(input.before)) || (input.threadID !== undefined && !valid(input.threadID))) return error("invalid_input", "Invalid history options.");
      const messages = (await load()).reverse().filter(m => visible(m, caller) && (input.threadID === undefined || input.threadID === m.threadID));
      const index = input.before === undefined ? -1 : messages.findIndex(m => m.id === input.before);
      if (input.before !== undefined && index === -1) return error("not_found", "Message not found.");
      const page = messages.slice(index + 1, index + 1 + limit);
      return { messages: page.map(publicMessage), ...(messages.length > index + 1 + limit ? { next: page.at(-1)!.id } : {}) };
    },
    async receipt(caller: string, id: string, signal?: AbortSignal): Promise<ChatMessage> {
      await root(caller, signal);
      return publicMessage(find(await load(), caller, id));
    },
  };
}
