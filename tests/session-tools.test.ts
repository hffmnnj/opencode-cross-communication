import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { registerSessionTools } from "../src/session-tools.ts";
import { createSessionService } from "../src/sessions.ts";
import { FakePorts } from "./fake-ports.ts";

test("cross-session tools use native caller identity and separate namespace", async () => {
  const ports = new FakePorts();
  for (const id of ["ses-a", "ses-b"]) {
    ports.sessions.set(id, { ...ports.addSession(id), projectID: "project", location: { directory: "/work" } });
    ports.activeSet.add(id);
  }
  const tools: Array<{ name: string; options: { namespace: string }; execute: (input: unknown, context: ToolContext) => Promise<{ output: unknown }> }> = [];
  const namespaces: string[] = [];
  const context = { tool: { transform: (fn: (editor: unknown) => void) => fn({
    namespace: (item: { name: string }) => namespaces.push(item.name),
    add: (tool: typeof tools[number]) => tools.push(tool),
  }) } } as unknown as Plugin.Context;
  await registerSessionTools(context, createSessionService(ports));
  expect(namespaces).toEqual(["agent_sessions"]);
  expect(tools.map(t => t.name).sort()).toEqual(["history", "list", "receipt", "reply", "send"]);
  expect(tools.every(t => t.options.namespace === "agent_sessions")).toBe(true);
  const native = { sessionID: "ses-a", messageID: "native-message", id: "native-tool", signal: new AbortController().signal } as ToolContext;
  const sent = await tools.find(t => t.name === "send")!.execute({ to: "ses-b", text: "hello", caller: "ses-b" }, native);
  expect(sent.output).toMatchObject({ from: { sessionID: "ses-a" }, receipts: [{ sessionID: "ses-b", status: "admitted" }] });
});
