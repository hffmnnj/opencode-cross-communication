import { Service } from "@opencode/client/service";

// Service.discover probes the registration before returning it. Confine that
// probe in this worker: a malformed registration must not send its password to
// a remote origin or follow a redirect. Never alter the host's global fetch.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password) throw new Error("Invalid discovery origin");
  return nativeFetch(input, { ...init, redirect: "error" });
};

self.onmessage = async event => {
  try {
    const endpoint = await Service.discover(event.data);
    self.postMessage({ endpoint });
  } catch {
    self.postMessage({});
  }
};
