import { expect, test } from "bun:test";
import { createSessionService } from "../src/sessions.ts";
import { createChatService } from "../src/service.ts";
import { FakePorts } from "./fake-ports.ts";

function fixture() {
  const ports = new FakePorts();
  for (const [id, projectID, directory, title] of [
    ["ses-a", "project-one", "/work/alpha", "Alpha"],
    ["ses-b", "project-one", "/work/beta", "Beta"],
    ["ses-c", "project-two", "/other/gamma", "Gamma"],
  ]) {
    const session = ports.addSession(id!);
    ports.sessions.set(id!, { ...session, projectID, location: { directory: directory! }, title });
    ports.activeSet.add(id!);
  }
  ports.addSession("ses-child", "ses-b");
  ports.activeSet.add("ses-child");
  return { ports, service: createSessionService(ports) };
}

test("discovery uses active roots and actual projectID and location metadata", async () => {
  const { ports, service } = fixture();
  ports.addSession("ses-idle");
  expect((await service.list("ses-a")).sessions.map(s => s.sessionID)).toEqual(["ses-b"]);
  expect((await service.list("ses-a", { allProjects: true, query: "/other" })).sessions.map(s => s.sessionID)).toEqual(["ses-c"]);
  expect((await service.list("ses-a", { allProjects: true, query: "PROJECT-ONE" })).sessions.map(s => s.sessionID)).toEqual(["ses-b"]);
  expect((await service.list("ses-a", { allProjects: true, query: "gamma" })).sessions.map(s => s.sessionID)).toEqual(["ses-c"]);
  const page = await service.list("ses-a", { allProjects: true, limit: 1 });
  expect(page.sessions.map(s => s.sessionID)).toEqual(["ses-b"]);
  expect(page.next).toBe("ses-b");
  expect((await service.list("ses-a", { allProjects: true, limit: 1, after: page.next })).sessions.map(s => s.sessionID)).toEqual(["ses-c"]);
});

test("foreign children cannot send or receive and cannot read root conversations", async () => {
  const { ports, service } = fixture();
  await expect(service.send("ses-a", { to: "ses-child", text: "no" }, "one")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(service.send("ses-child", { to: "ses-a", text: "no" }, "two")).rejects.toMatchObject({ code: "not_allowed" });
  const message = await service.send("ses-a", { to: "ses-b", text: "private" }, "three");
  await expect(service.history("ses-child")).rejects.toMatchObject({ code: "not_allowed" });
  await expect(service.receipt("ses-child", message.id)).rejects.toMatchObject({ code: "not_allowed" });
  await expect(service.receipt("ses-c", message.id)).rejects.toMatchObject({ code: "not_found" });
  expect((await service.history("ses-c")).messages).toEqual([]);
  expect((await createChatService(ports).history("ses-a")).messages).toEqual([]);
  expect((await service.history("ses-b")).messages.map(m => m.id)).toEqual([message.id]);
  const reply = await service.reply("ses-b", { messageID: message.id, text: "ack" }, "four");
  expect(reply.threadID).toBe(message.id);
  expect(reply.receipts[0]?.sessionID).toBe("ses-a");
  expect(ports.promptCalls.map(p => p.sessionID)).toEqual(["ses-b", "ses-a"]);
  expect(ports.promptCalls[0]).toMatchObject({ delivery: "steer", resume: false });
  expect(ports.promptCalls[0]?.text).toContain("agent_sessions.reply");
});

test("activity and structural role are rechecked at admission and retries preserve identity", async () => {
  const { ports, service } = fixture();
  ports.activeQueue.push(new Set(["ses-a", "ses-b"]), new Set(["ses-a"]));
  const input = { to: "ses-b", text: "hello", requestID: "stable" };
  const first = await service.send("ses-a", input, "op1");
  expect(first.receipts[0]?.status).toBe("failed");
  expect(ports.promptCalls).toHaveLength(0);
  ports.activeSet.delete("ses-b");
  const retry = await service.send("ses-a", input, "op2");
  expect(retry.id).toBe(first.id);
  expect(retry.receipts[0]?.status).toBe("failed");
  expect(ports.promptCalls).toHaveLength(0);
  ports.activeSet.add("ses-b");
  const admitted = await service.send("ses-a", input, "op3");
  expect(admitted.receipts[0]?.status).toBe("admitted");
  expect(admitted.receipts[0]?.inboxID).toBe(first.receipts[0]?.inboxID);
  await service.send("ses-a", input, "op4");
  expect(ports.promptCalls).toHaveLength(1);
  await expect(service.send("ses-a", { ...input, text: "different" }, "op5")).rejects.toMatchObject({ code: "id_conflict" });
  ports.activeSet.delete("ses-a");
  await expect(service.reply("ses-b", { messageID: first.id, text: "reply" }, "reply")).rejects.toMatchObject({ code: "inactive" });
  expect(ports.promptCalls).toHaveLength(1);
});

test("role changes and caller inactivity immediately before admission fail closed", async () => {
  const { ports, service } = fixture();
  // Change between initial eligibility and the admission role check.
  const originalGet = ports.session.get;
  let targetGets = 0;
  ports.session.get = async (input, options) => {
    if (input.sessionID === "ses-b" && ++targetGets === 2) {
      ports.sessions.set("ses-b", { ...ports.sessions.get("ses-b")!, parentID: "ses-c" });
    }
    return originalGet(input, options);
  };
  const result = await service.send("ses-a", { to: "ses-b", text: "hello" }, "op");
  expect(result.receipts[0]?.status).toBe("failed");
  expect(ports.promptCalls).toHaveLength(0);
});

test("reply admission rechecks sender activity and retry rechecks recipient role", async () => {
  const { ports, service } = fixture();
  const first = await service.send("ses-a", { to: "ses-b", text: "hello" }, "first");
  ports.activeQueue.push(new Set(["ses-a", "ses-b"]), new Set(["ses-a"]));
  const reply = await service.reply("ses-b", { messageID: first.id, text: "ack", requestID: "reply-id" }, "reply");
  expect(reply.receipts[0]?.status).toBe("failed");
  expect(ports.promptCalls).toHaveLength(1);
  ports.sessions.set("ses-a", { ...ports.sessions.get("ses-a")!, parentID: "ses-c" });
  const retry = await service.reply("ses-b", { messageID: first.id, text: "ack", requestID: "reply-id" }, "retry");
  expect(retry.id).toBe(reply.id);
  expect(retry.receipts[0]?.status).toBe("failed");
  expect(ports.promptCalls).toHaveLength(1);
});
