export const LIMITS = Object.freeze({
  messageChars: 8_000,
  recipients: 32,
  members: 64,
  ancestry: 64,
  retainedMessages: 500,
  messagesPerMinute: 20,
  historyPage: 50,
});

export interface SessionRecord {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly title?: string;
  readonly time: { readonly created: number; readonly updated: number; readonly idle?: number; readonly archived?: number };
}

export interface ChatPorts {
  readonly session: {
    active(options?: { signal?: AbortSignal }): Promise<Readonly<Record<string, { readonly type: "running" }>>>;
    get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<SessionRecord>;
    list(input: { parentID?: string; limit?: number; cursor?: string }, options?: { signal?: AbortSignal }): Promise<{
      readonly data: readonly SessionRecord[];
      readonly cursor: { readonly next?: string | null };
    }>;
    prompt(input: {
      sessionID: string;
      id: string;
      text: string;
      metadata: Record<string, string>;
      delivery: "steer";
      resume: false;
    }, options?: { signal?: AbortSignal }): Promise<{ readonly id: string; readonly sessionID: string }>;
  };
  readonly storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: ChatLog): Promise<void>;
  };
  readonly now?: () => number;
}

export interface Participant {
  readonly sessionID: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly title?: string;
  readonly archived: boolean;
  readonly active: boolean;
}

export interface MembersResult {
  readonly self: string;
  readonly rootID: string;
  readonly members: readonly Participant[];
}

export type ChatTarget = string | readonly string[];
export interface SendInput {
  readonly to: ChatTarget;
  readonly text: string;
  readonly requestID?: string;
}
export interface ReplyInput {
  readonly messageID: string;
  readonly text: string;
  readonly requestID?: string;
}
export interface HistoryInput {
  readonly threadID?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface DeliveryReceipt {
  readonly sessionID: string;
  readonly inboxID: string;
  readonly status: "pending" | "admitted" | "failed" | "unknown";
  readonly detail?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly rootID: string;
  readonly threadID: string;
  readonly replyTo?: string;
  readonly from: Participant;
  readonly kind: "direct" | "group";
  readonly text: string;
  readonly createdAt: number;
  readonly receipts: readonly DeliveryReceipt[];
}

export interface ChatLog {
  readonly version: 1;
  readonly messages: readonly ChatMessage[];
}

export interface HistoryResult {
  readonly messages: readonly ChatMessage[];
  readonly next?: string;
}

export type ChatErrorCode = "invalid_input" | "not_allowed" | "inactive" | "not_found" | "family_limit" | "rate_limit" | "unavailable" | "id_conflict";
export class ChatError extends Error {
  constructor(readonly code: ChatErrorCode, message: string) {
    super(message);
    this.name = "ChatError";
  }
}

export interface ChatService {
  members(caller: string, signal?: AbortSignal): Promise<MembersResult>;
  send(caller: string, input: SendInput, operationID: string, signal?: AbortSignal): Promise<ChatMessage>;
  reply(caller: string, input: ReplyInput, operationID: string, signal?: AbortSignal): Promise<ChatMessage>;
  history(caller: string, input?: HistoryInput, signal?: AbortSignal): Promise<HistoryResult>;
  receipt(caller: string, messageID: string, signal?: AbortSignal): Promise<ChatMessage>;
}
