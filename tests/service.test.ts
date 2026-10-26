import { describe, expect, test } from "bun:test";
import { ChatError, LIMITS } from "../src/contract.ts";
import { createChatService } from "../src/service.ts";
import { FakePorts } from "./fake-ports.ts";

/**
 * Deterministic contract tests for createChatService(ports).
 *
 * Oracle: docs/SPEC.md plus src/contract.ts. Expectations below encode the
 * brief's named behaviors; where the contract leaves a code unspecified
 * (cycle/missing ancestry, cross-family send) the tests pin only fail-closed
 * ChatError behavior and say so. Every admission is expected to use
 * delivery:'steer' with resume:false, a stable id, and a peer-data envelope
 * whose values carry the sender session and the message id.
 */

let seq = 0;
function ids(tag: string) {
  seq += 1;
  return { requestID: `req-${tag}-${seq}`, operationID: `op-${tag}-${seq}` };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection, but the call resolved");
}

function expectFailClosed(error: unknown, codes: readonly string[]) {
  expect(error).toBeInstanceOf(ChatError);
  expect(codes).toContain((error as ChatError).code);
}

function rig() {
  const ports = new FakePorts();
  ports.addSession("ses-root", undefined, { agent: "root-agent" });
  ports.addSession("ses-alice", "ses-root", { agent: "alice-agent" });
  ports.addSession("ses-bob", "ses-root", { agent: "bob-agent" });
  ports.addSession("ses-carol", "ses-root", { agent: "carol-agent" });
  for (const id of ["ses-root", "ses-alice", "ses-bob", "ses-carol"]) ports.activeSet.add(id);
  const svc = createChatService(ports);
  return { ports, svc, root: "ses-root", alice: "ses-alice", bob: "ses-bob", carol: "ses-carol" };
}

function promptTargets(ports: FakePorts): string[] {
  return ports.promptCalls.map((call) => call.sessionID);
}

describe("members", () => {
  test("members_resolves_family_by_ancestry_not_agent_name", async () => {
    const { ports, svc, root, alice } = rig();
    // An unrelated family reuses alice's agent name: it must never merge.
    ports.addSession("ses-other-root", undefined, { agent: "alice-agent" });
    ports.addSession("ses-lookalike", "ses-other-root", { agent: "alice-agent" });
    ports.activeSet.add("ses-other-root");
    ports.activeSet.add("ses-lookalike");
    // A nested child joins through parent ancestry, not name matching.
    ports.addSession("ses-nested", alice, { agent: "nested-agent" });
    ports.activeSet.add("ses-nested");

    const result = await svc.members(alice);
    expect(result.self).toBe(alice);
    expect(result.rootID).toBe(root);
    expect(result.members.map((m) => m.sessionID).sort()).toEqual(
      ["ses-root", "ses-alice", "ses-bob", "ses-carol", "ses-nested"].sort(),
    );
    for (const member of result.members) {
      expect(member.active).toBe(true);
      expect(member.archived).toBe(false);
    }
  });

  test("members_marks_archived_and_inactive_participants", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    ports.activeSet.delete(bob);
    ports.addSession(carol, "ses-root", { agent: "carol-agent", archived: true });

    const result = await svc.members(alice);
    const byId = new Map(result.members.map((m) => [m.sessionID, m]));
    expect(byId.get(bob)?.active).toBe(false);
    expect(byId.get(carol)?.archived).toBe(true);
    expect(byId.get(alice)?.active).toBe(true);
  });

  test("members_cyclic_ancestry_fails_closed", async () => {
    const { ports, svc } = rig();
    ports.addSession("ses-x", "ses-y", { agent: "x-agent" });
    ports.addSession("ses-y", "ses-x", { agent: "y-agent" });
    ports.activeSet.add("ses-x");
    ports.activeSet.add("ses-y");

    // Any ChatError code is fail-closed here; the contract pins no code.
    expect(await captureError(svc.members("ses-x"))).toBeInstanceOf(ChatError);
  });

  test("members_missing_parent_fails_closed", async () => {
    const { ports, svc } = rig();
    ports.addSession("ses-orphan", "ses-gone", { agent: "orphan-agent" });
    ports.activeSet.add("ses-orphan");

    expect(await captureError(svc.members("ses-orphan"))).toBeInstanceOf(ChatError);
  });

  test("members_family_over_64_fails_family_limit", async () => {
    const { ports, svc, alice } = rig();
    // Rig holds 4 members; 60 extras reach exactly 64, one more exceeds it.
    for (let i = 0; i < 60; i += 1) {
      const id = `ses-extra-${i}`;
      ports.addSession(id, "ses-root", { agent: `extra-${i}-agent` });
      ports.activeSet.add(id);
    }
    expect((await svc.members(alice)).members).toHaveLength(64);
    ports.addSession("ses-one-too-many", "ses-root", { agent: "extra-agent" });
    ports.activeSet.add("ses-one-too-many");

    const error = await captureError(svc.members(alice));
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).code).toBe("family_limit");
  });

  test("members_unknown_caller_fails_closed", async () => {
    const { svc } = rig();
    expect(await captureError(svc.members("ses-nope"))).toBeInstanceOf(ChatError);
  });
});

describe("send", () => {
  test("send_direct_dm_is_admitted_with_steer_envelope", async () => {
    const { ports, svc, alice, bob } = rig();
    const activeBefore = ports.activeCalls;
    const { requestID, operationID } = ids("dm");

    const msg = await svc.send(alice, { to: bob, text: "hello bob", requestID }, operationID);

    expect(msg.kind).toBe("direct");
    expect(msg.text).toBe("hello bob");
    expect(msg.from.sessionID).toBe(alice);
    expect(msg.threadID).toBe(msg.id);
    expect(msg.receipts).toHaveLength(1);
    expect(msg.receipts[0]?.sessionID).toBe(bob);
    expect(msg.receipts[0]?.status).toBe("admitted");
    expect(ports.promptCalls).toHaveLength(1);
    const call = ports.promptCalls[0]!;
    expect(call.sessionID).toBe(bob);
    expect(call.delivery).toBe("steer");
    expect(call.resume).toBe(false);
    expect(call.text).toContain(msg.id);
    expect(call.text).toContain(alice);
    for (const value of Object.values(call.metadata)) expect(typeof value).toBe("string");
    expect(Object.values(call.metadata)).toContain(alice);
    expect(Object.values(call.metadata)).toContain(msg.id);
    expect(msg.receipts[0]?.inboxID).toBe(call.id);
    // Discovery plus the pre-admission recheck, without polling loops.
    expect(ports.activeCalls - activeBefore).toBeLessThanOrEqual(3);
    const forAlice = await svc.history(alice, { limit: 10 });
    const forBob = await svc.history(bob, { limit: 10 });
    expect(forAlice.messages.map((m) => m.id)).toContain(msg.id);
    expect(forBob.messages.map((m) => m.id)).toContain(msg.id);
  });

  test("send_direct_to_parent_and_root_is_admitted", async () => {
    const { ports, svc } = rig();
    ports.addSession("ses-nested", "ses-alice", { agent: "nested-agent" });
    ports.activeSet.add("ses-nested");
    const toParent = ids("parent");
    const toRoot = ids("root");

    const viaParent = await svc.send("ses-nested", { to: "parent", text: "up", requestID: toParent.requestID }, toParent.operationID);
    const viaRoot = await svc.send("ses-nested", { to: "root", text: "top", requestID: toRoot.requestID }, toRoot.operationID);

    expect(viaParent.kind).toBe("direct");
    expect(viaParent.receipts[0]?.status).toBe("admitted");
    expect(viaRoot.receipts[0]?.status).toBe("admitted");
    expect(promptTargets(ports).sort()).toEqual(["ses-alice", "ses-root"].sort());
  });

  test("send_direct_to_inactive_peer_fails_inactive_without_prompt_or_log", async () => {
    const { ports, svc, alice, bob } = rig();
    ports.activeSet.delete(bob);
    const setsBefore = ports.storageSets.length;
    const { requestID, operationID } = ids("inactive");

    const error = await captureError(svc.send(alice, { to: bob, text: "are you there", requestID }, operationID));
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).code).toBe("inactive");
    expect(ports.promptCalls).toHaveLength(0);
    expect(ports.storageSets.length).toBe(setsBefore);
    expect((await svc.history(alice, { limit: 10 })).messages).toHaveLength(0);
  });

  test("send_direct_to_other_family_fails_closed_without_prompt", async () => {
    const { ports, svc, alice } = rig();
    ports.addSession("ses-other-root", undefined, { agent: "other-agent" });
    ports.addSession("ses-stranger", "ses-other-root", { agent: "stranger-agent" });
    ports.activeSet.add("ses-other-root");
    ports.activeSet.add("ses-stranger");
    const { requestID, operationID } = ids("stranger");

    const error = await captureError(svc.send(alice, { to: "ses-stranger", text: "hi", requestID }, operationID));
    // An active attempt to reach another family is refused, never delivered.
    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).code).toBe("not_allowed");
    expect(ports.promptCalls).toHaveLength(0);
  });

  test("send_group_excludes_sender_inactive_and_archived", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    ports.addSession("ses-dave", "ses-root", { agent: "dave-agent" });
    ports.activeSet.add("ses-dave");
    ports.activeSet.delete(bob);
    ports.addSession(carol, "ses-root", { agent: "carol-agent", archived: true });
    const { requestID, operationID } = ids("group");

    const msg = await svc.send(alice, { to: "group", text: "team update", requestID }, operationID);

    expect(msg.kind).toBe("group");
    // Sender, inactive bob, and archived carol are skipped; root stays.
    expect(promptTargets(ports).sort()).toEqual(["ses-dave", "ses-root"].sort());
    for (const call of ports.promptCalls) {
      expect(call.delivery).toBe("steer");
      expect(call.resume).toBe(false);
    }
    const byId = new Map(msg.receipts.map((r) => [r.sessionID, r]));
    expect([...byId.keys()].sort()).toEqual(["ses-dave", "ses-root"].sort());
    expect(byId.get("ses-dave")?.status).toBe("admitted");
    expect(byId.get("ses-root")?.status).toBe("admitted");
  });

  test("send_group_partial_failure_marks_unknown_and_sanitizes_secrets", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    ports.promptHandler = async (input) => {
      if (input.sessionID === bob) throw new Error(`native boom secret-token-abc for ${input.sessionID}`);
      return { id: input.id, sessionID: input.sessionID };
    };
    const { requestID, operationID } = ids("partial");

    const msg = await svc.send(alice, { to: [bob, carol], text: "mixed", requestID }, operationID);

    const byId = new Map(msg.receipts.map((r) => [r.sessionID, r]));
    expect(byId.get(carol)?.status).toBe("admitted");
    // A rejected admission leaves state unclear, so it is unknown, never admitted.
    expect(byId.get(bob)?.status).toBe("unknown");
    expect(byId.get(bob)?.detail ?? "").not.toContain("secret-token-abc");
    const visible = await svc.history(alice, { limit: 10 });
    expect(JSON.stringify(visible)).not.toContain("secret-token-abc");
  });

  test("send_prompt_id_mismatch_marks_unknown", async () => {
    const { ports, svc, alice, bob } = rig();
    ports.promptHandler = async (input) => ({ id: "someone-elses-id", sessionID: input.sessionID });
    const { requestID, operationID } = ids("mismatch");

    const msg = await svc.send(alice, { to: bob, text: "hello", requestID }, operationID);
    expect(msg.receipts[0]?.status).toBe("unknown");
  });

  test("send_recipient_going_inactive_before_admission_is_not_prompted", async () => {
    const { ports, svc, root, alice, bob, carol } = rig();
    // Discovery and the admission check see bob; the per-recipient recheck
    // inside delivery reports him gone. Fallback also excludes him.
    ports.activeQueue.push(new Set([root, alice, bob, carol]));
    ports.activeQueue.push(new Set([root, alice, bob, carol]));
    ports.activeQueue.push(new Set([root, alice, carol]));
    ports.activeSet.delete(bob);
    const { requestID, operationID } = ids("race");

    // The failure is recorded explicitly instead of throwing: the message was
    // already validated when the recipient was still active.
    const message = await svc.send(alice, { to: bob, text: "race", requestID }, operationID);
    expect(promptTargets(ports).filter((id) => id === bob)).toHaveLength(0);
    const receipt = message.receipts.find((entry) => entry.sessionID === bob);
    expect(receipt?.status).toBe("failed");
    expect(receipt?.detail ?? "").not.toBe("");
  });

  test("send_retry_with_same_ids_does_not_redeliver", async () => {
    const { ports, svc, alice, bob } = rig();
    const first = await svc.send(alice, { to: bob, text: "once", requestID: "req-dedupe-fixed" }, "op-dedupe-fixed");
    expect(ports.promptCalls).toHaveLength(1);

    const second = await svc.send(alice, { to: bob, text: "once", requestID: "req-dedupe-fixed" }, "op-dedupe-fixed");
    expect(second.id).toBe(first.id);
    expect(second.receipts).toEqual(first.receipts);
    expect(ports.promptCalls).toHaveLength(1);

    // Dedupe is durable: a new service instance over the same ports agrees.
    const svc2 = createChatService(ports);
    const third = await svc2.send(alice, { to: bob, text: "once", requestID: "req-dedupe-fixed" }, "op-dedupe-fixed");
    expect(third.id).toBe(first.id);
    expect(ports.promptCalls).toHaveLength(1);
  });

  test("send_retry_after_unknown_keeps_stable_inbox_id", async () => {
    const { ports, svc, alice, bob } = rig();
    let attempts = 0;
    ports.promptHandler = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error(`native wobble secret-zzz unclear for ${input.id}`);
      return { id: input.id, sessionID: input.sessionID };
    };
    const { requestID, operationID } = ids("retry");

    const first = await svc.send(alice, { to: bob, text: "retry me", requestID }, operationID);
    expect(first.receipts[0]?.status).toBe("unknown");
    expect(JSON.stringify(first)).not.toContain("secret-zzz");

    const second = await svc.send(alice, { to: bob, text: "retry me", requestID }, operationID);
    expect(second.id).toBe(first.id);
    expect(ports.promptCalls).toHaveLength(2);
    expect(ports.promptCalls[1]?.id).toBe(ports.promptCalls[0]?.id);
    expect(second.receipts[0]?.status).toBe("admitted");
    expect(second.receipts[0]?.inboxID).toBe(ports.promptCalls[0]?.id);
    expect(JSON.stringify(second)).not.toContain("secret-zzz");
  });

  test("send_retry_keeps_stable_prompt_text_and_single_log_entry", async () => {
    const { ports, svc, alice, bob } = rig();
    let attempts = 0;
    ports.promptHandler = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error(`ambiguous ${input.id}`);
      return { id: input.id, sessionID: input.sessionID };
    };
    const { requestID, operationID } = ids("stable");

    const first = await svc.send(alice, { to: bob, text: "stable", requestID }, operationID);
    const second = await svc.send(alice, { to: bob, text: "stable", requestID }, operationID);

    expect(ports.promptCalls).toHaveLength(2);
    expect(ports.promptCalls[0]?.text).toBe(ports.promptCalls[1]?.text);
    const history = await svc.history(alice, { limit: 10 });
    expect(history.messages.filter((m) => m.id === first.id)).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  test("send_same_request_id_with_changed_text_or_target_conflicts", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    await svc.send(alice, { to: bob, text: "v1", requestID: "req-conflict-fixed" }, "op-conflict-1");

    const changedText = await captureError(
      svc.send(alice, { to: bob, text: "v2", requestID: "req-conflict-fixed" }, "op-conflict-2"),
    );
    expect(changedText).toBeInstanceOf(ChatError);
    expect((changedText as ChatError).code).toBe("id_conflict");

    const changedTarget = await captureError(
      svc.send(alice, { to: carol, text: "v1", requestID: "req-conflict-fixed" }, "op-conflict-3"),
    );
    expect((changedTarget as ChatError).code).toBe("id_conflict");
  });

  test("send_concurrent_sends_retain_both_records", async () => {
    const { ports, svc, alice, bob } = rig();
    const firstIds = ids("conc-a");
    const secondIds = ids("conc-b");

    const [m1, m2] = await Promise.all([
      svc.send(alice, { to: bob, text: "one", requestID: firstIds.requestID }, firstIds.operationID),
      svc.send(alice, { to: bob, text: "two", requestID: secondIds.requestID }, secondIds.operationID),
    ]);

    expect(m1.id).not.toBe(m2.id);
    expect(ports.promptCalls).toHaveLength(2);
    const history = await svc.history(alice, { limit: 10 });
    expect(history.messages.map((m) => m.id)).toEqual(expect.arrayContaining([m1.id, m2.id]));
  });

  test("send_failed_admission_is_not_retried_automatically", async () => {
    const { ports, svc, alice, bob } = rig();
    let calls = 0;
    ports.promptHandler = async (input) => {
      calls += 1;
      throw new Error(`native down for ${input.sessionID}`);
    };
    const { requestID, operationID } = ids("noretry");

    const msg = await svc.send(alice, { to: bob, text: "ping", requestID }, operationID);
    expect(calls).toBe(1);
    expect(msg.receipts[0]?.status).toBe("unknown");
    expect(JSON.stringify(msg)).not.toContain("native down");
  });

  test("send_text_and_recipient_count_boundaries", async () => {
    const { ports, svc, alice, bob } = rig();
    const maxText = "a".repeat(LIMITS.messageChars);
    const okIds = ids("size-ok");
    const overIds = ids("size-over");

    const ok = await svc.send(alice, { to: bob, text: maxText, requestID: okIds.requestID }, okIds.operationID);
    expect(ok.receipts[0]?.status).toBe("admitted");

    const over = await captureError(
      svc.send(alice, { to: bob, text: `${maxText}x`, requestID: overIds.requestID }, overIds.operationID),
    );
    expect(over).toBeInstanceOf(ChatError);
    expect((over as ChatError).code).toBe("invalid_input");

    const extras: string[] = [];
    for (let i = 0; i < 33; i += 1) {
      const id = `ses-r${i}`;
      ports.addSession(id, "ses-root", { agent: `r${i}-agent` });
      ports.activeSet.add(id);
      extras.push(id);
    }
    const manyOk = ids("many-ok");
    const many = await svc.send(alice, { to: extras.slice(0, 32), text: "wide", requestID: manyOk.requestID }, manyOk.operationID);
    expect(many.receipts).toHaveLength(32);
    const callsBefore = ports.promptCalls.length;
    const manyOver = ids("many-over");
    const rejected = await captureError(
      svc.send(alice, { to: extras, text: "too wide", requestID: manyOver.requestID }, manyOver.operationID),
    );
    expect((rejected as ChatError).code).toBe("invalid_input");
    expect(ports.promptCalls.length).toBe(callsBefore);
  });

  test("send_rate_limit_blocks_21st_message_per_minute_then_recovers", async () => {
    const { ports, svc, alice, bob } = rig();
    for (let i = 0; i < LIMITS.messagesPerMinute; i += 1) {
      const { requestID, operationID } = ids(`rate-${i}`);
      await svc.send(alice, { to: bob, text: `m${i}`, requestID }, operationID);
      ports.advance(1000);
    }
    const overIds = ids("rate-over");
    const limited = await captureError(
      svc.send(alice, { to: bob, text: "over", requestID: overIds.requestID }, overIds.operationID),
    );
    expect(limited).toBeInstanceOf(ChatError);
    expect((limited as ChatError).code).toBe("rate_limit");
    expect(ports.promptCalls).toHaveLength(LIMITS.messagesPerMinute);

    ports.advance(61_000);
    const againIds = ids("rate-again");
    const again = await svc.send(alice, { to: bob, text: "again", requestID: againIds.requestID }, againIds.operationID);
    expect(again.receipts[0]?.status).toBe("admitted");
  });

  test("send_retry_under_full_quota_returns_deduped_message", async () => {
    const { ports, svc, alice, bob } = rig();
    const firstIds = ids("quota-first");
    const first = await svc.send(alice, { to: bob, text: "m0", requestID: firstIds.requestID }, firstIds.operationID);
    for (let i = 1; i < LIMITS.messagesPerMinute; i += 1) {
      const { requestID, operationID } = ids(`quota-${i}`);
      await svc.send(alice, { to: bob, text: `m${i}`, requestID }, operationID);
      ports.advance(1000);
    }
    const callsBefore = ports.promptCalls.length;
    const dup = await svc.send(alice, { to: bob, text: "m0", requestID: firstIds.requestID }, firstIds.operationID);
    expect(dup.id).toBe(first.id);
    expect(ports.promptCalls.length).toBe(callsBefore);
  });

  test("send_single_recipient_is_direct_group_keyword_is_group", async () => {
    const { svc, alice, bob } = rig();
    const dmIds = ids("kind-dm");
    const groupIds = ids("kind-group");

    const dm = await svc.send(alice, { to: bob, text: "dm", requestID: dmIds.requestID }, dmIds.operationID);
    const group = await svc.send(alice, { to: "group", text: "group", requestID: groupIds.requestID }, groupIds.operationID);

    expect(dm.kind).toBe("direct");
    expect(group.kind).toBe("group");
  });
});

describe("reply", () => {
  test("reply_preserves_thread_and_recipients_excluding_self", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    const dmIds = ids("dm");
    const dm = await svc.send(alice, { to: bob, text: "starter", requestID: dmIds.requestID }, dmIds.operationID);
    ports.advance(1000);
    const base = ports.promptCalls.length;
    const replyIds = ids("reply");

    const reply = await svc.reply(bob, { messageID: dm.id, text: "got it", requestID: replyIds.requestID }, replyIds.operationID);

    expect(reply.threadID).toBe(dm.threadID);
    expect(reply.replyTo).toBe(dm.id);
    expect(reply.kind).toBe("direct");
    expect(promptTargets(ports).slice(base)).toEqual([alice]);
    const carolView = await svc.history(carol, { limit: 10 });
    expect(carolView.messages.map((m) => m.id)).not.toContain(reply.id);
    expect((await svc.history(alice, { limit: 10 })).messages.map((m) => m.id)).toContain(reply.id);
  });

  test("reply_skips_inactive_and_never_adds_new_members", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    const groupIds = ids("grp");
    const group = await svc.send(alice, { to: "group", text: "team", requestID: groupIds.requestID }, groupIds.operationID);
    expect(group.kind).toBe("group");
    ports.addSession("ses-dave", "ses-root", { agent: "dave-agent" });
    ports.activeSet.add("ses-dave");
    ports.activeSet.delete(carol);
    ports.advance(1000);
    const base = ports.promptCalls.length;
    const replyIds = ids("gr");

    const reply = await svc.reply(bob, { messageID: group.id, text: "ack", requestID: replyIds.requestID }, replyIds.operationID);

    expect(reply.threadID).toBe(group.threadID);
    expect(reply.replyTo).toBe(group.id);
    expect(reply.kind).toBe("group");
    // Original audience was alice/root/bob/carol; bob is self, carol is now
    // inactive, and newcomer dave was never in the thread.
    expect(promptTargets(ports).slice(base).sort()).toEqual(["ses-alice", "ses-root"].sort());
  });

  test("reply_retry_with_same_ids_does_not_redeliver", async () => {
    const { ports, svc, alice, bob } = rig();
    const dmIds = ids("dm2");
    const dm = await svc.send(alice, { to: bob, text: "starter", requestID: dmIds.requestID }, dmIds.operationID);
    const first = await svc.reply(bob, { messageID: dm.id, text: "ack", requestID: "req-rdedupe" }, "op-rdedupe");
    const callsAfterFirst = ports.promptCalls.length;

    const second = await svc.reply(bob, { messageID: dm.id, text: "ack", requestID: "req-rdedupe" }, "op-rdedupe");
    expect(second.id).toBe(first.id);
    expect(ports.promptCalls.length).toBe(callsAfterFirst);
  });

  test("reply_same_request_id_with_changed_text_conflicts", async () => {
    const { svc, alice, bob } = rig();
    const dmIds = ids("dm3");
    const dm = await svc.send(alice, { to: bob, text: "starter", requestID: dmIds.requestID }, dmIds.operationID);
    await svc.reply(bob, { messageID: dm.id, text: "ack", requestID: "req-rconflict" }, "op-rconflict-1");

    const conflict = await captureError(
      svc.reply(bob, { messageID: dm.id, text: "changed", requestID: "req-rconflict" }, "op-rconflict-2"),
    );
    expect(conflict).toBeInstanceOf(ChatError);
    expect((conflict as ChatError).code).toBe("id_conflict");
  });

  test("reply_to_unreadable_or_missing_message_fails_closed", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    ports.addSession("ses-other-root", undefined, { agent: "other-agent" });
    ports.addSession("ses-outsider", "ses-other-root", { agent: "outsider-agent" });
    ports.activeSet.add("ses-other-root");
    ports.activeSet.add("ses-outsider");
    const dmIds = ids("dm4");
    const dm = await svc.send(alice, { to: bob, text: "private", requestID: dmIds.requestID }, dmIds.operationID);
    const callsBefore = ports.promptCalls.length;
    const outsiderIds = ids("ro");
    const nonmemberIds = ids("rn");
    const missingIds = ids("rm");

    // Same-family non-participant and cross-family outsider cannot reply.
    // Guessed ids stay hidden, so not_found keeps existence concealed.
    expectFailClosed(
      await captureError(svc.reply(carol, { messageID: dm.id, text: "snoop", requestID: nonmemberIds.requestID }, nonmemberIds.operationID)),
      ["not_found"],
    );
    expectFailClosed(
      await captureError(svc.reply("ses-outsider", { messageID: dm.id, text: "snoop", requestID: outsiderIds.requestID }, outsiderIds.operationID)),
      ["not_found"],
    );
    expectFailClosed(
      await captureError(svc.reply(alice, { messageID: "msg-nope", text: "ghost", requestID: missingIds.requestID }, missingIds.operationID)),
      ["not_found"],
    );
    expect(ports.promptCalls.length).toBe(callsBefore);
  });

  test("reply_nested_preserves_root_thread", async () => {
    const { svc, alice, bob } = rig();
    const dmIds = ids("dm5");
    const dm = await svc.send(alice, { to: bob, text: "root", requestID: dmIds.requestID }, dmIds.operationID);
    const r1Ids = ids("r1");
    const r1 = await svc.reply(bob, { messageID: dm.id, text: "one", requestID: r1Ids.requestID }, r1Ids.operationID);
    const r2Ids = ids("r2");
    const r2 = await svc.reply(alice, { messageID: r1.id, text: "two", requestID: r2Ids.requestID }, r2Ids.operationID);

    expect(r2.threadID).toBe(dm.threadID);
    expect(r2.replyTo).toBe(r1.id);
  });
});

describe("history and receipt", () => {
  test("history_is_newest_first_and_pages_with_before_cursor", async () => {
    const { ports, svc, alice, bob } = rig();
    for (let i = 1; i <= 5; i += 1) {
      const { requestID, operationID } = ids(`page-${i}`);
      await svc.send(alice, { to: bob, text: `m${i}`, requestID }, operationID);
      ports.advance(1000);
    }

    const p1 = await svc.history(alice, { limit: 2 });
    expect(p1.messages.map((m) => m.text)).toEqual(["m5", "m4"]);
    expect(p1.next).toBeDefined();
    const p2 = await svc.history(alice, { limit: 2, before: p1.next });
    expect(p2.messages.map((m) => m.text)).toEqual(["m3", "m2"]);
    expect(p2.next).toBeDefined();
    const p3 = await svc.history(alice, { limit: 2, before: p2.next });
    expect(p3.messages.map((m) => m.text)).toEqual(["m1"]);
  });

  test("history_applies_cursor_after_visibility_filtering", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    const sendSharedDM = async (text: string, tag: string) => {
      const { requestID, operationID } = ids(tag);
      const msg = await svc.send(alice, { to: [bob, carol], text, requestID }, operationID);
      ports.advance(1000);
      return msg;
    };
    const sendDm = async (text: string, tag: string) => {
      const { requestID, operationID } = ids(tag);
      const msg = await svc.send(alice, { to: bob, text, requestID }, operationID);
      ports.advance(1000);
      return msg;
    };
    const g1 = await sendSharedDM("g1", "vg1");
    const d1 = await sendDm("d1", "vd1");
    const g2 = await sendSharedDM("g2", "vg2");
    const g3 = await sendSharedDM("g3", "vg3");

    const page1 = await svc.history(carol, { limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual([g3.id, g2.id]);
    expect(page1.next).toBeDefined();
    const page2 = await svc.history(carol, { limit: 2, before: page1.next });
    // The hidden DM must not consume a cursor slot: g1 still pages through.
    expect(page2.messages.map((m) => m.id)).toEqual([g1.id]);

    const bobFull = await svc.history(bob, { limit: 10 });
    expect(bobFull.messages.map((m) => m.id)).toEqual([g3.id, g2.id, d1.id, g1.id]);
  });

  test("history_hides_dm_from_nonparticipant_and_group_from_other_family", async () => {
    const { ports, svc, alice, bob, carol } = rig();
    ports.addSession("ses-other-root", undefined, { agent: "other-agent" });
    ports.addSession("ses-outsider", "ses-other-root", { agent: "outsider-agent" });
    ports.activeSet.add("ses-other-root");
    ports.activeSet.add("ses-outsider");
    const dmIds = ids("hid");
    const dm = await svc.send(alice, { to: bob, text: "private", requestID: dmIds.requestID }, dmIds.operationID);
    ports.advance(1000);
    const groupIds = ids("hgrp");
    const group = await svc.send(alice, { to: "group", text: "team", requestID: groupIds.requestID }, groupIds.operationID);

    expect((await svc.history(carol, { limit: 10 })).messages.map((m) => m.id)).not.toContain(dm.id);
    expect((await svc.history(carol, { limit: 10 })).messages.map((m) => m.id)).toContain(group.id);
    // Default input path also leaks nothing to an unrelated family.
    expect((await svc.history("ses-outsider")).messages).toHaveLength(0);
  });

  test("history_limit_must_be_between_1_and_50", async () => {
    const { svc, alice } = rig();
    expectFailClosed(await captureError(svc.history(alice, { limit: 0 })), ["invalid_input"]);
    expectFailClosed(await captureError(svc.history(alice, { limit: LIMITS.historyPage + 1 })), ["invalid_input"]);
    expect((await svc.history(alice, { limit: 1 })).messages).toHaveLength(0);
    expect((await svc.history(alice, { limit: LIMITS.historyPage })).messages).toHaveLength(0);
  });

  test("history_retains_only_newest_500_per_family", async () => {
    const { ports, svc, alice } = rig();
    const total = LIMITS.retainedMessages + 5;
    for (let i = 0; i < total; i += 1) {
      const { requestID, operationID } = ids(`keep-${i}`);
      await svc.send(alice, { to: "ses-bob", text: `keep-${i}`, requestID }, operationID);
      ports.advance(3100);
    }
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await svc.history(alice, { limit: 50, before });
      seen.push(...result.messages.map((m) => m.text));
      if (!result.next) break;
      before = result.next;
    }
    expect(seen).toHaveLength(LIMITS.retainedMessages);
    expect(seen[0]).toBe(`keep-${total - 1}`);
    expect(seen[seen.length - 1]).toBe("keep-5");
  });

  test("receipt_returns_message_to_participant_and_hides_from_outsider", async () => {
    const { ports, svc, alice, bob } = rig();
    ports.addSession("ses-other-root", undefined, { agent: "other-agent" });
    ports.addSession("ses-outsider", "ses-other-root", { agent: "outsider-agent" });
    ports.activeSet.add("ses-other-root");
    ports.activeSet.add("ses-outsider");
    const dmIds = ids("rc");
    const dm = await svc.send(alice, { to: bob, text: "private", requestID: dmIds.requestID }, dmIds.operationID);

    expect((await svc.receipt(bob, dm.id)).id).toBe(dm.id);
    expectFailClosed(await captureError(svc.receipt("ses-outsider", dm.id)), ["not_found"]);
    expectFailClosed(await captureError(svc.receipt("ses-carol", dm.id)), ["not_found"]);
  });

  test("reads_do_not_mutate_plugin_log", async () => {
    const { ports, svc, alice, bob } = rig();
    const dmIds = ids("ro2");
    const dm = await svc.send(alice, { to: bob, text: "logged", requestID: dmIds.requestID }, dmIds.operationID);
    const setsBefore = ports.storageSets.length;

    await svc.members(alice);
    await svc.history(alice, { limit: 5 });
    await svc.receipt(alice, dm.id);

    expect(ports.storageSets.length).toBe(setsBefore);
  });
});
