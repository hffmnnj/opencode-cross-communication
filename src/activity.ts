import { ChatError, type ChatPorts } from "./contract.ts";
import type { Endpoint } from "@opencode/client/service";

interface ActivityOptions {
  readonly baseURL?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly pid?: number;
  readonly discover?: (signal: AbortSignal) => Promise<Endpoint | undefined>;
  readonly registrationFile?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loopbackOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ChatError("unavailable", "The activity API must be an explicit loopback HTTP origin.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ChatError("unavailable", "The activity API must be an explicit loopback HTTP origin.");
  }
  return url;
}

// Discovery probes the registration using fetch. Isolate its loopback and
// redirect restrictions in a worker instead of mutating the server's fetch.
function discover(signal: AbortSignal, file?: string): Promise<Endpoint | undefined> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../discover-worker.js", import.meta.url));
    const finish = (endpoint?: Endpoint, error?: unknown) => {
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      if (error) reject(error); else resolve(endpoint);
    };
    const onAbort = () => finish(undefined, new Error("Discovery cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = event => finish(event.data?.endpoint);
    worker.onerror = event => { event.preventDefault(); finish(undefined, new Error("Discovery failed")); };
    if (signal.aborted) onAbort(); else worker.postMessage({ file });
  });
}

/** V2's plugin context omits session.active, so read it from this same process's HTTP API. */
export function createActiveSessionReader(options: ActivityOptions = {}): ChatPorts["session"]["active"] {
  const explicitURL = options.baseURL === undefined ? undefined : loopbackOrigin(options.baseURL);
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const pid = options.pid ?? process.pid;
  return async requestOptions => {
    const signal = AbortSignal.any([
      ...(requestOptions?.signal ? [requestOptions.signal] : []),
      AbortSignal.timeout(5_000),
    ]);
    try {
      signal.throwIfAborted();
      const endpoint: Endpoint | undefined = explicitURL
        ? { url: explicitURL.href, auth: { type: "basic", username: env.OPENCODE_SERVER_USERNAME ?? "opencode", password: env.OPENCODE_SERVER_PASSWORD ?? "" } }
        : await (options.discover ? options.discover(signal) : discover(signal, options.registrationFile));
      signal.throwIfAborted();
      if (!endpoint || !endpoint.auth || endpoint.auth.type !== "basic" || !endpoint.auth.password
        || !endpoint.auth.username || endpoint.auth.username.includes(":")) throw new Error("Credentials unavailable");
      const url = loopbackOrigin(endpoint.url);
      const authorization = `Basic ${Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`).toString("base64")}`;
      const request = async (path: string): Promise<unknown> => {
        signal.throwIfAborted();
        const response = await fetcher(new URL(path, url).href, {
          method: "GET", redirect: "error", signal, headers: { Authorization: authorization },
        });
        if (!response.ok) throw new Error("Activity API request failed");
        return response.json();
      };
      const info = await request("/api/info");
      if (!object(info) || info.pid !== pid) throw new Error("Wrong server process");
      const result = await request("/api/session/active");
      if (!object(result) || !object(result.data)) throw new Error("Invalid activity response");
      const active: Record<string, { type: "running" }> = Object.create(null);
      for (const [sessionID, state] of Object.entries(result.data)) {
        if (!sessionID.startsWith("ses") || !object(state) || state.type !== "running") {
          throw new Error("Invalid activity entry");
        }
        active[sessionID] = { type: "running" };
      }
      return active;
    } catch {
      throw new ChatError("unavailable", "Native session activity could not be verified.");
    }
  };
}
