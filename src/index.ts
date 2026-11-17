import { Plugin } from "@opencode/plugin";
import { createActiveSessionReader } from "./activity.ts";
import type { ChatPorts } from "./contract.ts";
import { createChatService } from "./service.ts";
import { registerTools } from "./tools.ts";
import { createSessionService } from "./sessions.ts";
import { registerSessionTools } from "./session-tools.ts";

export { createChatService } from "./service.ts";
export { ChatError, LIMITS } from "./contract.ts";
export type { ChatService, ChatMessage, DeliveryReceipt } from "./contract.ts";

export default Plugin.define({
  id: "opencode-cross-communication",
  async setup(ctx) {
    if (ctx.options.apiBaseURL !== undefined && typeof ctx.options.apiBaseURL !== "string") {
      throw new Error("opencode-cross-communication: apiBaseURL must be a loopback HTTP origin.");
    }
    const ports: ChatPorts = {
      session: {
        active: createActiveSessionReader({ baseURL: ctx.options.apiBaseURL }),
        get: (input, options) => ctx.session.get(input, options),
        list: (input, options) => ctx.session.list(input, options),
        prompt: (input, options) => ctx.session.prompt(input, options),
      },
      storage: {
        get: key => ctx.storage.get(key),
        set: (key, value) => ctx.storage.set(key, JSON.parse(JSON.stringify(value))),
      },
    };
    const service = createChatService(ports);
    await registerTools(ctx, service);
    await registerSessionTools(ctx, createSessionService(ports));
  },
});
