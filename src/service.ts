import { createHash } from "node:crypto";
import {
  ChatError, LIMITS,
  type ChatLog, type ChatMessage, type ChatPorts, type ChatService, type ChatTarget,
  type DeliveryReceipt, type Participant, type SessionRecord,
} from "./contract.ts";
import { renderEnvelope } from "./render.ts";

type StoredMessage = ChatMessage & { readonly requestFingerprint?: string };
interface StoredLog extends ChatLog { readonly messages: readonly StoredMessage[] }
const locks = new Map<string, Promise<void>>();
const FAMILY_RECORD_SCAN_LIMIT = 10_000;
const FAMILY_PAGE_SCAN_LIMIT = 10_000;

async function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await run(); }
  finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function fail(code: ConstructorParameters<typeof ChatError>[0], message: string): never {
  throw new ChatError(code, message);
}
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function hash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function participant(value: unknown): value is Participant {
  return object(value) && nonempty(value.sessionID) && optionalString(value.parentID)
    && optionalString(value.agent) && optionalString(value.title) && typeof value.archived === "boolean"
    && typeof value.active === "boolean";
}
function receipt(value: unknown): value is DeliveryReceipt {
  return object(value) && nonempty(value.sessionID) && nonempty(value.inboxID)
    && typeof value.status === "string" && ["pending", "admitted", "failed", "unknown"].includes(value.status)
    && optionalString(value.detail);
}
function storedMessage(value: unknown, root: string): value is StoredMessage {
  if (!object(value) || !nonempty(value.id) || value.rootID !== root || !nonempty(value.threadID)
    || !optionalString(value.replyTo) || !participant(value.from)
    || (value.kind !== "direct" && value.kind !== "group")
    || !nonempty(value.text) || value.text.length > LIMITS.messageChars
    || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
    || !optionalString(value.requestFingerprint) || !Array.isArray(value.receipts)
    || value.receipts.length > LIMITS.recipients || !value.receipts.every(receipt)) return false;
  const recipients = value.receipts.map((item: DeliveryReceipt) => item.sessionID);
  return !recipients.includes(value.from.sessionID) && new Set(recipients).size === recipients.length;
}
function asParticipant(session: SessionRecord, active: boolean): Participant {
  return {
    sessionID: session.id, ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    ...(session.title === undefined ? {} : { title: session.title }),
    archived: session.time.archived !== undefined, active,
  };
}
function visible(message: ChatMessage, caller: string): boolean {
  return message.kind === "group" || message.from.sessionID === caller
    || message.receipts.some((item) => item.sessionID === caller);
}
function publicMessage(message: StoredMessage): ChatMessage {
  const { requestFingerprint: _fingerprint, ...result } = message;
  return structuredClone(result);
}
function validateText(text: unknown): asserts text is string {
  if (!nonempty(text) || text.length > LIMITS.messageChars) fail("invalid_input", "Text must contain 1 to 8000 characters.");
}
function identityKey(root: string): string { return `opencode-cross-communication:chat:v1:${root}`; }

export function createChatService(ports: ChatPorts): ChatService {
  const now = ports.now ?? Date.now;
  const inactiveDetail = "Recipient is inactive. Use native subagent to launch or resume a task.";

  async function activeSessions(signal?: AbortSignal): Promise<Readonly<Record<string, { readonly type: "running" }>>> {
    aborted(signal);
    let value: unknown;
    try { value = await ports.session.active({ signal }); }
    catch { aborted(signal); return fail("unavailable", "Session activity could not be verified."); }
    aborted(signal);
    if (!object(value) || Object.values(value).some((entry) => !object(entry) || entry.type !== "running")) {
      fail("unavailable", "Session activity could not be verified.");
    }
    return value as Readonly<Record<string, { readonly type: "running" }>>;
  }
  function isActive(active: Readonly<Record<string, { readonly type: "running" }>>, id: string): boolean {
    return Object.hasOwn(active, id) && active[id]?.type === "running";
  }

  async function get(id: string, signal?: AbortSignal): Promise<SessionRecord> {
    aborted(signal);
    if (!nonempty(id)) fail("invalid_input", "A session ID is required.");
    let session: SessionRecord;
    try { session = await ports.session.get({ sessionID: id }, { signal }); }
    catch { aborted(signal); return fail("unavailable", "Session verification failed."); }
    aborted(signal);
    if (!session || session.id !== id || !object(session.time)
      || (session.parentID !== undefined && !nonempty(session.parentID))) {
      fail("not_allowed", "Session ancestry could not be verified.");
    }
    return session;
  }

  async function ancestry(id: string, signal?: AbortSignal): Promise<{ self: SessionRecord; root: SessionRecord }> {
    const seen = new Set<string>();
    let current = id;
    let self: SessionRecord | undefined;
    for (let depth = 0; depth < LIMITS.ancestry; depth++) {
      if (seen.has(current)) fail("not_allowed", "Session ancestry could not be verified.");
      seen.add(current);
      const record = await get(current, signal);
      self ??= record;
      if (record.parentID === undefined) return { self, root: record };
      current = record.parentID;
    }
    return fail("not_allowed", "Session ancestry exceeds the supported depth.");
  }

  async function family(root: SessionRecord, signal?: AbortSignal): Promise<SessionRecord[]> {
    const result = [root];
    const seen = new Set([root.id]);
    let pagesScanned = 0;
    for (let index = 0; index < result.length; index++) {
      const parent = result[index]!;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        aborted(signal);
        if (pagesScanned >= FAMILY_PAGE_SCAN_LIMIT) fail("family_limit", "Family discovery exceeds 10,000 pages.");
        pagesScanned += 1;
        let page: Awaited<ReturnType<ChatPorts["session"]["list"]>>;
        try {
          page = await ports.session.list({ parentID: parent.id, limit: LIMITS.members, ...(cursor ? { cursor } : {}) }, { signal });
        } catch { aborted(signal); return fail("unavailable", "Family discovery failed."); }
        aborted(signal);
        if (!page || !Array.isArray(page.data) || !object(page.cursor)) fail("unavailable", "Invalid family discovery response.");
        for (const child of page.data) {
          if (!child || !nonempty(child.id) || child.parentID !== parent.id || !object(child.time) || seen.has(child.id)) {
            fail("not_allowed", "Family discovery could not be verified.");
          }
          if (result.length >= FAMILY_RECORD_SCAN_LIMIT) fail("family_limit", "Family discovery exceeds 10,000 records.");
          seen.add(child.id);
          result.push(child);
        }
        const next = page.cursor.next;
        if (next !== undefined && next !== null && (!nonempty(next) || cursors.has(next))) {
          fail("unavailable", "Invalid family discovery cursor.");
        }
        cursor = next ?? undefined;
        if (cursor) cursors.add(cursor);
      } while (cursor !== undefined);
    }
    return result;
  }

  function currentFamily(discovered: readonly SessionRecord[], active: Readonly<Record<string, { readonly type: "running" }>>): SessionRecord[] {
    const cutoff = now() - 300_000;
    const result = discovered.filter((member) => {
      if (isActive(active, member.id)) return true;
      const lastIdle = member.time.idle === undefined ? member.time.updated : member.time.idle;
      if (typeof lastIdle !== "number" || !Number.isFinite(lastIdle)) fail("unavailable", "Session inactivity could not be verified.");
      return lastIdle >= cutoff;
    });
    if (result.length > LIMITS.members) fail("family_limit", "Family exceeds 64 members.");
    return result;
  }

  async function load(root: string): Promise<StoredLog> {
    let value: unknown;
    try { value = await ports.storage.get(identityKey(root)); }
    catch { return fail("unavailable", "Chat storage is unavailable."); }
    if (value === undefined) return { version: 1, messages: [] };
    if (!object(value) || value.version !== 1 || !Array.isArray(value.messages)) {
      fail("unavailable", "Stored chat log is invalid.");
    }
    const messages: unknown[] = value.messages;
    if (messages.length > LIMITS.retainedMessages || !messages.every((item) => storedMessage(item, root))) {
      fail("unavailable", "Stored chat log is invalid.");
    }
    if (new Set(messages.map((item) => item.id)).size !== messages.length) fail("unavailable", "Stored chat log is invalid.");
    return { version: 1, messages: structuredClone(messages) };
  }
  async function save(root: string, messages: readonly StoredMessage[]): Promise<void> {
    try { await ports.storage.set(identityKey(root), { version: 1, messages }); }
    catch { fail("unavailable", "Chat storage is unavailable."); }
  }
  async function readMessage(root: string, caller: string, id: string): Promise<StoredMessage> {
    if (!nonempty(id)) fail("invalid_input", "A message ID is required.");
    const log = await load(root);
    const message = log.messages.find((item) => item.id === id && visible(item, caller));
    if (!message) fail("not_found", "Message not found.");
    return message;
  }
  async function directTargets(target: ChatTarget, self: SessionRecord, root: SessionRecord, signal?: AbortSignal): Promise<SessionRecord[]> {
    const raw = typeof target === "string" ? [target] : target;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => !nonempty(id))) fail("invalid_input", "A valid target is required.");
    const ids = raw.map((id) => id === "parent" ? self.parentID ?? fail("invalid_input", "This session has no parent.") : id === "root" ? root.id : id);
    const unique = [...new Set(ids)].filter((id) => id !== self.id).sort();
    if (unique.length === 0) fail("invalid_input", "Choose a recipient other than yourself.");
    if (unique.length > LIMITS.recipients) fail("invalid_input", "Too many recipients.");
    const result: SessionRecord[] = [];
    for (const id of unique) {
      const verified = await ancestry(id, signal);
      if (verified.root.id !== root.id) fail("not_allowed", "Target is outside this session family.");
      if (verified.self.time.archived !== undefined) fail("not_allowed", "Target is archived.");
      result.push(verified.self);
    }
    return result;
  }
  async function deliver(root: string, message: StoredMessage, signal?: AbortSignal): Promise<ChatMessage> {
    aborted(signal);
    const outcomes = await Promise.allSettled(message.receipts.filter((item) => item.status !== "admitted").map(async (item) => {
      aborted(signal);
      let updated: DeliveryReceipt;
      try {
        const target = await ancestry(item.sessionID, signal);
        if (target.root.id !== root || target.self.time.archived !== undefined) {
          updated = { ...item, status: "failed", detail: "Recipient is not available in this family." };
        } else {
          aborted(signal);
          const active = await activeSessions(signal);
          aborted(signal);
          if (!isActive(active, item.sessionID)) {
            updated = { ...item, status: "failed", detail: inactiveDetail };
          } else {
            const admission = await ports.session.prompt({ sessionID: item.sessionID, id: item.inboxID,
              text: renderEnvelope(message), metadata: { source: "opencode-cross-communication", messageID: message.id,
                threadID: message.threadID, fromSessionID: message.from.sessionID, rootID: root },
              delivery: "steer", resume: false }, { signal });
            updated = admission?.id === item.inboxID && admission.sessionID === item.sessionID
              ? { ...item, status: "admitted" }
              : { ...item, status: "unknown", detail: "Inbox admission could not be confirmed." };
          }
        }
      } catch {
        updated = { ...item, status: "unknown", detail: "Inbox admission could not be confirmed." };
      }
      // Persist even after cancellation: admission may already have happened.
      await locked(identityKey(root), async () => {
        const log = await load(root);
        const retained = log.messages.find((entry) => entry.id === message.id);
        if (!retained) return;
        const receipts = retained.receipts.map((entry) => entry.sessionID === item.sessionID && entry.status !== "admitted" ? updated : entry);
        await save(root, log.messages.map((entry) => entry.id === message.id ? { ...retained, receipts } : entry));
      });
    }));
    // Do not release the message mutex while other admissions are still settling.
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    aborted(signal);
    return publicMessage(await readMessage(root, message.from.sessionID, message.id));
  }

  async function write(caller: string, input: { text: string; requestID?: string }, operationID: string,
    target: ChatTarget | undefined, replyTo: string | undefined, signal?: AbortSignal): Promise<ChatMessage> {
    aborted(signal);
    validateText(input.text);
    if (!nonempty(operationID)) fail("invalid_input", "An operation ID is required.");
    if (input.requestID !== undefined && (!nonempty(input.requestID) || input.requestID.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.requestID))) {
      fail("invalid_input", "Invalid request ID.");
    }
    if (target !== undefined && typeof target !== "string" && !Array.isArray(target)) fail("invalid_input", "Invalid target.");
    if (Array.isArray(target) && (target.length === 0 || target.some((id) => !nonempty(id)))) fail("invalid_input", "Invalid target.");
    if (typeof target === "string" && !nonempty(target)) fail("invalid_input", "Invalid target.");
    const { self, root } = await ancestry(caller, signal);
    const id = `chat_${hash([root.id, caller, input.requestID ?? operationID])}`;
    const normalizedTarget = Array.isArray(target) ? [...new Set(target)].sort() : target;
    const fingerprint = hash([input.text, JSON.stringify(normalizedTarget) ?? "", replyTo ?? ""]);
    return locked(`delivery:${root.id}:${id}`, async () => {
      aborted(signal);
      const existing = (await load(root.id)).messages.find((entry) => entry.id === id);
      if (existing) {
        if (existing.from.sessionID !== caller || existing.requestFingerprint !== fingerprint) fail("id_conflict", "Message ID was used for a different request.");
        return deliver(root.id, existing, signal);
      }
      let recipients: string[];
      let kind: ChatMessage["kind"];
      let threadID = id;
      let active = await activeSessions(signal);
      if (replyTo !== undefined) {
        const original = await readMessage(root.id, caller, replyTo);
        kind = original.kind;
        threadID = original.threadID;
        recipients = [...new Set([original.from.sessionID, ...original.receipts.map((item) => item.sessionID)])].filter((member) => member !== caller);
        // Do not rediscover the group: a thread retains its original audience.
        for (const recipient of recipients) {
          const verified = await ancestry(recipient, signal);
          if (verified.root.id !== root.id) fail("not_allowed", "Reply audience is no longer in this family.");
          if (kind === "direct" && verified.self.time.archived !== undefined) fail("not_allowed", "Target is archived.");
        }
        active = await activeSessions(signal);
        recipients = recipients.filter((recipient) => isActive(active, recipient));
        if (recipients.length === 0) fail("inactive", inactiveDetail);
      } else if (target === "group") {
        kind = "group";
        const discovered = await family(root, signal);
        active = await activeSessions(signal);
        recipients = currentFamily(discovered, active).filter((member) => member.id !== caller && member.time.archived === undefined && isActive(active, member.id)).map((member) => member.id);
        if (recipients.length === 0) fail("inactive", inactiveDetail);
      } else {
        kind = "direct";
        recipients = (await directTargets(target!, self, root, signal)).map((member) => member.id);
        active = await activeSessions(signal);
        if (recipients.some((recipient) => !isActive(active, recipient))) fail("inactive", inactiveDetail);
      }
      recipients.sort();
      if (recipients.length > LIMITS.recipients) fail("invalid_input", "Too many recipients.");
      const message: StoredMessage = { id, rootID: root.id, threadID, ...(replyTo === undefined ? {} : { replyTo }),
        from: asParticipant(self, isActive(active, caller)), kind, text: input.text, createdAt: now(), requestFingerprint: fingerprint,
        receipts: recipients.map((sessionID) => ({ sessionID, inboxID: `msg_${hash([id, sessionID])}`, status: "pending" })) };
      await locked(identityKey(root.id), async () => {
        aborted(signal);
        const log = await load(root.id);
        const timestamp = now();
        if (log.messages.filter((entry) => entry.from.sessionID === caller && entry.createdAt > timestamp - 60_000).length >= LIMITS.messagesPerMinute) {
          fail("rate_limit", "Message rate limit exceeded.");
        }
        const retained = [...log.messages];
        if (retained.length >= LIMITS.retainedMessages) {
          const removable = retained.findIndex((entry) => entry.receipts.every((item) => item.status === "admitted" || item.status === "failed")
            && !locks.has(`delivery:${root.id}:${entry.id}`));
          if (removable === -1) fail("unavailable", "Chat log has too many unresolved messages.");
          retained.splice(removable, 1);
        }
        await save(root.id, [...retained, message]);
      });
      return deliver(root.id, message, signal);
    });
  }

  return {
    async members(caller, signal) {
      const { root } = await ancestry(caller, signal);
      const discovered = await family(root, signal);
      const active = await activeSessions(signal);
      return { self: caller, rootID: root.id, members: currentFamily(discovered, active).map((member) => asParticipant(member, isActive(active, member.id))) };
    },
    send(caller, input, operationID, signal) { return write(caller, input, operationID, input.to, undefined, signal); },
    reply(caller, input, operationID, signal) {
      if (!nonempty(input.messageID)) return Promise.reject(new ChatError("invalid_input", "A message ID is required."));
      return write(caller, input, operationID, undefined, input.messageID, signal);
    },
    async receipt(caller, messageID, signal) {
      const { root } = await ancestry(caller, signal);
      const result = await readMessage(root.id, caller, messageID);
      aborted(signal);
      return publicMessage(result);
    },
    async history(caller, input = {}, signal) {
      const limit = input.limit ?? LIMITS.historyPage;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.historyPage
        || (input.before !== undefined && !nonempty(input.before))
        || (input.threadID !== undefined && !nonempty(input.threadID))) fail("invalid_input", "Invalid history options.");
      const { root } = await ancestry(caller, signal);
      const log = await load(root.id);
      aborted(signal);
      const messages = [...log.messages].reverse().filter((entry) => visible(entry, caller)
        && (input.threadID === undefined || entry.threadID === input.threadID));
      const beforeIndex = input.before === undefined ? -1 : messages.findIndex((entry) => entry.id === input.before);
      if (input.before !== undefined && beforeIndex === -1) fail("not_found", "Message not found.");
      const page = messages.slice(beforeIndex + 1, beforeIndex + 1 + limit);
      const next = messages.length > beforeIndex + 1 + limit ? page.at(-1)?.id : undefined;
      return { messages: page.map(publicMessage), ...(next === undefined ? {} : { next }) };
    },
  };
}
