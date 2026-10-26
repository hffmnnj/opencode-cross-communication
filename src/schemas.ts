const participant = {
  type: "object",
  properties: {
    sessionID: { type: "string" }, parentID: { type: "string" }, agent: { type: "string" },
    title: { type: "string" }, archived: { type: "boolean" }, active: { type: "boolean" },
  },
  required: ["sessionID", "archived", "active"],
  additionalProperties: false,
} as const;

const receipt = {
  type: "object",
  properties: {
    sessionID: { type: "string" }, inboxID: { type: "string" },
    status: { type: "string", enum: ["pending", "admitted", "failed", "unknown"] },
    detail: { type: "string" },
  },
  required: ["sessionID", "inboxID", "status"],
  additionalProperties: false,
} as const;

export const messageOutput = {
  type: "object",
  properties: {
    id: { type: "string" }, rootID: { type: "string" }, threadID: { type: "string" },
    replyTo: { type: "string" }, from: participant, kind: { type: "string", enum: ["direct", "group"] },
    text: { type: "string" }, createdAt: { type: "number" },
    receipts: { type: "array", items: receipt },
  },
  required: ["id", "rootID", "threadID", "from", "kind", "text", "createdAt", "receipts"],
  additionalProperties: false,
} as const;

export const membersOutput = {
  type: "object",
  properties: {
    self: { type: "string" }, rootID: { type: "string" }, members: { type: "array", items: participant },
  },
  required: ["self", "rootID", "members"],
  additionalProperties: false,
} as const;

export const historyOutput = {
  type: "object",
  properties: { messages: { type: "array", items: messageOutput }, next: { type: "string" } },
  required: ["messages"],
  additionalProperties: false,
} as const;
