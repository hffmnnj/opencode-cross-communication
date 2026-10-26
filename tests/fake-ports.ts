import { ChatError, type ChatLog, type ChatPorts, type SessionRecord } from "../src/contract.ts";

/** Deferred promise for deterministic concurrency/race control without sleeps. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface PromptCall {
  readonly sessionID: string;
  readonly id: string;
  readonly text: string;
  readonly metadata: Record<string, string>;
  readonly delivery: "steer";
  readonly resume: false;
}

/**
 * In-memory faithful fake at the ChatPorts boundary.
 *
 * Oracle: the ChatPorts interface in src/contract.ts. session.active() is the
 * sole activity authority, session.get/list encode native ancestry, and
 * session.prompt admits to the durable inbox. Storage is a plain key/value map.
 */
export class FakePorts implements ChatPorts {
  readonly sessions = new Map<string, SessionRecord>();
  readonly activeSet = new Set<string>();
  /** Per-call active() overrides, consumed in order; falls back to activeSet. */
  readonly activeQueue: Array<Set<string>> = [];
  readonly promptCalls: PromptCall[] = [];
  promptHandler: (input: PromptCall) => Promise<{ readonly id: string; readonly sessionID: string }> =
    async (input) => ({ id: input.id, sessionID: input.sessionID });
  readonly store = new Map<string, ChatLog>();
  readonly storageSets: Array<{ readonly key: string; readonly value: ChatLog }> = [];
  storageGets = 0;
  activeCalls = 0;
  nowValue = 1_000_000;
  readonly now = (): number => this.nowValue;

  advance(ms: number): void {
    this.nowValue += ms;
  }

  addSession(id: string, parentID?: string, opts: { agent?: string; archived?: boolean } = {}): SessionRecord {
    const record: SessionRecord = {
      id,
      parentID,
      agent: opts.agent ?? `${id}-agent`,
      time: {
        created: this.nowValue,
        updated: this.nowValue,
        ...(opts.archived ? { archived: this.nowValue } : {}),
      },
    };
    this.sessions.set(id, record);
    return record;
  }

  readonly session: ChatPorts["session"] = {
    active: async () => {
      this.activeCalls += 1;
      const set = this.activeQueue.length > 0 ? this.activeQueue.shift()! : this.activeSet;
      return Object.fromEntries([...set].map((id) => [id, { type: "running" as const }]));
    },
    get: async ({ sessionID }) => {
      const record = this.sessions.get(sessionID);
      if (!record) throw new ChatError("not_found", `unknown session ${sessionID}`);
      return record;
    },
    list: async ({ parentID, limit, cursor }) => {
      const all = [...this.sessions.values()]
        .filter((record) => record.parentID === parentID)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const start = cursor ? Number(cursor) : 0;
      const page = limit ?? 100;
      const data = all.slice(start, start + page);
      const next = start + page < all.length ? String(start + page) : null;
      return { data, cursor: { next } };
    },
    prompt: async (input) => {
      const call: PromptCall = {
        sessionID: input.sessionID,
        id: input.id,
        text: input.text,
        metadata: { ...input.metadata },
        delivery: input.delivery,
        resume: input.resume,
      };
      this.promptCalls.push(call);
      return this.promptHandler(call);
    },
  };

  readonly storage: ChatPorts["storage"] = {
    get: async (key) => {
      this.storageGets += 1;
      return this.store.get(key);
    },
    set: async (key, value) => {
      this.storageSets.push({ key, value });
      this.store.set(key, value);
    },
  };
}
