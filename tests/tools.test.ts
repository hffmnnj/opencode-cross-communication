import { expect, test } from "bun:test";
import { ChatError, type ChatMessage, type ChatService, type HistoryResult, type MembersResult } from "../src/contract.ts";
import { registerTools } from "../src/tools.ts";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";

interface CapturedTool {
  readonly name: string;
  readonly description: string;
  readonly output?: unknown;
  readonly execute: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

type ServiceMethod = "members" | "send" | "reply" | "history" | "receipt";

interface ServiceCall {
  readonly method: ServiceMethod;
  readonly caller: string;
  readonly input: unknown;
  readonly operationID?: string;
  readonly signal?: AbortSignal;
}

function cannedMessage(from: string, id: string): ChatMessage {
  return {
    id,
    rootID: "ses-root",
    threadID: id,
    from: { sessionID: from, agent: `${from}-agent`, archived: false, active: true },
    kind: "direct",
    text: "canned",
    createdAt: 1,
    receipts: [],
  };
}

class SpyService implements ChatService {
  readonly calls: ServiceCall[] = [];
  sendBehavior: (caller: string) => ChatMessage = (caller) => cannedMessage(caller, "msg-canned");
  replyBehavior: (caller: string) => ChatMessage = (caller) => cannedMessage(caller, "msg-reply-canned");

  async members(caller: string, signal?: AbortSignal): Promise<MembersResult> {
    this.calls.push({ method: "members", caller, input: undefined, signal });
    return { self: caller, rootID: "ses-root", members: [] };
  }

  async send(caller: string, input: { to?: unknown; text?: unknown }, operationID: string, signal?: AbortSignal): Promise<ChatMessage> {
    if (input.to === undefined || typeof input.text !== "string") {
      throw new ChatError("invalid_input", "send needs to and text");
    }
    this.calls.push({ method: "send", caller, input, operationID, signal });
    return this.sendBehavior(caller);
  }

  async reply(
    caller: string,
    input: { messageID?: unknown; text?: unknown },
    operationID: string,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    if (typeof input.messageID !== "string" || typeof input.text !== "string") {
      throw new ChatError("invalid_input", "reply needs messageID and text");
    }
    this.calls.push({ method: "reply", caller, input, operationID, signal });
    return this.replyBehavior(caller);
  }

  async history(caller: string, input?: unknown, signal?: AbortSignal): Promise<HistoryResult> {
    this.calls.push({ method: "history", caller, input, signal });
    return { messages: [] };
  }

  async receipt(caller: string, messageID: string, signal?: AbortSignal): Promise<ChatMessage> {
    this.calls.push({ method: "receipt", caller, input: { messageID }, signal });
    return cannedMessage(caller, messageID);
  }
}

/** Plugin context exposing only the tool registry; any other access throws. */
function strictPluginContext(captured: CapturedTool[], editorOverrides: Record<string, unknown> = {}): Plugin.Context {
  const editor = {
    add: (candidate: unknown) => {
      captured.push(candidate as CapturedTool);
    },
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
    ...editorOverrides,
  };
  const tool = {
    transform: (fn: (editor: unknown) => void) => {
      fn(editor);
    },
    list: () => [],
    reload: async () => {},
    hook: {},
  };
  return new Proxy({} as Plugin.Context, {
    get(_target, prop) {
      if (prop === "tool") return tool;
      if (typeof prop === "symbol") return undefined;
      throw new Error(`cross-chat test context does not provide ${String(prop)}`);
    },
  });
}

/** Native-shaped tool execution context: identity lives here, not in input. */
function nativeContext(sessionID = "ses-alice", id = "op-tool-1", signal?: AbortSignal): ToolContext {
  return {
    sessionID,
    agent: "alice-agent",
    messageID: "msg-tool-1",
    id,
    signal: signal ?? new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolContext;
}

async function registered() {
  const captured: CapturedTool[] = [];
  const spy = new SpyService();
  await registerTools(strictPluginContext(captured), spy);
  return { captured, spy };
}

function registeredTool(tools: CapturedTool[], method: ServiceMethod): CapturedTool {
  const tool = tools.find(candidate => candidate.name === method);
  if (!tool) throw new Error(`Missing registered tool: ${method}`);
  return tool;
}

test("registers_discoverable_tools_with_names_and_descriptions", async () => {
  const { captured } = await registered();
  expect(captured.map(tool => tool.name).sort()).toEqual(["history", "members", "receipt", "reply", "send"]);
  const names = captured.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);
  for (const tool of captured) {
    expect(tool.name.length).toBeGreaterThan(0);
    expect(tool.description.length).toBeGreaterThan(0);
    expect(typeof tool.execute).toBe("function");
    expect(tool.output).toMatchObject({ type: "object" });
  }
});

test("registration_needs_only_tool_transform", async () => {
  const added: unknown[] = [];
  const ctx = strictPluginContext(added as CapturedTool[], {
    list: () => {
      throw new Error("must not need editor.list");
    },
  });
  await registerTools(ctx, new SpyService());
  expect(added.length).toBeGreaterThanOrEqual(2);
});

test("send_tool_uses_tool_context_identity_and_forwards_operation_id", async () => {
  const { captured, spy } = await registered();
  const ctx = nativeContext("ses-alice", "op-tool-7");
   const sendTool = registeredTool(captured, "send");
  expect(sendTool).not.toBeUndefined();

  spy.calls.length = 0;
  const result = await sendTool!.execute({ to: "ses-bob", text: "hello from tool" }, ctx) as { content?: string };
  expect(result.content).toContain("**Sent** · DM from `ses-alice-agent`");
  expect(result.content).not.toContain('"receipts"');
  const call = spy.calls.find((entry) => entry.method === "send");
  expect(call).not.toBeUndefined();
  expect(call?.caller).toBe("ses-alice");
  // The operation id is derived from the tool-call context, never the input.
  expect(call?.operationID).toBe("msg-tool-1:op-tool-7");
});

test("send_tool_never_trusts_caller_supplied_identity", async () => {
  const { captured, spy } = await registered();
  const ctx = nativeContext("ses-alice", "op-tool-spoof");
  const sendTool = registeredTool(captured, "send");
  expect(sendTool).not.toBeUndefined();

  const spoofed = {
    to: "ses-bob",
    text: "spoof attempt",
    from: "ses-victim",
    sender: "ses-victim",
    sessionID: "ses-victim",
    caller: "ses-victim",
    operationID: "op-evil",
  };
  spy.calls.length = 0;
  await sendTool!.execute(spoofed, ctx);
  const sendCalls = spy.calls.filter((entry) => entry.method === "send");
  expect(sendCalls).toHaveLength(1);
  expect(sendCalls[0]?.caller).toBe("ses-alice");
  expect(sendCalls[0]?.operationID).toBe("msg-tool-1:op-tool-spoof");
});

test("reply_tool_uses_tool_context_identity_and_forwards_operation_id", async () => {
  const { captured, spy } = await registered();
  const ctx = nativeContext("ses-bob", "op-tool-reply");
  const replyTool = registeredTool(captured, "reply");
  expect(replyTool).not.toBeUndefined();

  spy.calls.length = 0;
  await replyTool!.execute({ messageID: "msg-1", text: "ack" }, ctx);
  const call = spy.calls.find((entry) => entry.method === "reply");
  expect(call).not.toBeUndefined();
  expect(call?.caller).toBe("ses-bob");
  expect(call?.operationID).toBe("msg-tool-1:op-tool-reply");
});

test("history_tool_delegates_with_tool_context_caller_and_signal", async () => {
  const { captured, spy } = await registered();
  const historyTool = registeredTool(captured, "history");
  expect(historyTool).not.toBeUndefined();

  const aborter = new AbortController();
  const ctx = nativeContext("ses-carol", "op-tool-history", aborter.signal);
  spy.calls.length = 0;
  const result = await historyTool!.execute({ limit: 5 }, ctx) as { content?: string };
  expect(result.content).toContain("**History** · 0 messages · newest first");
  const call = spy.calls.find((entry) => entry.method === "history");
  expect(call).not.toBeUndefined();
  expect(call?.caller).toBe("ses-carol");
  expect(call?.signal).toBe(aborter.signal);
});

test("members_tool_delegates_with_tool_context_caller", async () => {
  const { captured, spy } = await registered();
  const membersTool = registeredTool(captured, "members");
  expect(membersTool).not.toBeUndefined();

  spy.calls.length = 0;
  const result = await membersTool!.execute({}, nativeContext("ses-dave", "op-tool-members")) as { content?: string };
  expect(result.content).toContain("**Family** · self `ses-dave` · root `ses-root`");
  const call = spy.calls.find((entry) => entry.method === "members");
  expect(call).not.toBeUndefined();
  expect(call?.caller).toBe("ses-dave");
});

test("receipt_tool_passes_message_id_through_with_tool_context_caller", async () => {
  const { captured, spy } = await registered();
  const receiptTool = registeredTool(captured, "receipt");
  expect(receiptTool).not.toBeUndefined();

  spy.calls.length = 0;
  await receiptTool!.execute({ messageID: "msg-1" }, nativeContext("ses-bob", "op-tool-receipt"));
  const call = spy.calls.find((entry) => entry.method === "receipt");
  expect(call).not.toBeUndefined();
  expect(call?.caller).toBe("ses-bob");
  expect((call?.input as { messageID?: string })?.messageID).toBe("msg-1");
});

test("tool_errors_from_service_surface_as_rejections", async () => {
  const { captured, spy } = await registered();
  const sendTool = registeredTool(captured, "send");
  expect(sendTool).not.toBeUndefined();
  spy.sendBehavior = () => {
    throw new ChatError("inactive", "peer is not running");
  };

  let rejected: unknown;
  try {
    await sendTool!.execute({ to: "ses-bob", text: "hello" }, nativeContext("ses-alice", "op-tool-err"));
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(Error);
});
