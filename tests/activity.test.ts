import { expect, test } from "bun:test";
import { createActiveSessionReader } from "../src/activity.ts";

const env = { OPENCODE_SERVER_USERNAME: "fixture", OPENCODE_SERVER_PASSWORD: "fixture-password" };
const baseURL = "http://127.0.0.1:4108";

test("activity_reads_only_the_authenticated_same_process_registry", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const read = createActiveSessionReader({
    baseURL, env, pid: 42,
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return Response.json(url.endsWith("/api/info") ? { pid: 42 } : { data: { ses_live: { type: "running" } } });
    },
  });
  expect({ ...await read() }).toEqual({ ses_live: { type: "running" } });
  expect(requests.map(request => request.url)).toEqual([
    "http://127.0.0.1:4108/api/info", "http://127.0.0.1:4108/api/session/active",
  ]);
  for (const { init } of requests) {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${Buffer.from("fixture:fixture-password").toString("base64")}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
});

test("activity_refuses_another_server_process_before_reading_its_registry", async () => {
  const paths: string[] = [];
  const read = createActiveSessionReader({ baseURL, env, pid: 42, fetcher: async url => {
    paths.push(new URL(url).pathname);
    return Response.json({ pid: 99 });
  } });
  await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  expect(paths).toEqual(["/api/info"]);
});

test("activity_rejects_missing_credentials_without_network_access", async () => {
  let calls = 0;
  const read = createActiveSessionReader({ baseURL, env: {}, fetcher: async () => { calls++; return Response.json({}); } });
  await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  expect(calls).toBe(0);
});

test("activity_rejects_remote_or_credential_bearing_origins", () => {
  for (const baseURL of ["https://example.com", "http://localhost:4108", "http://127.0.0.1:4108/path", "http://name:password@127.0.0.1:4108", "http://127.0.0.1:4108?token=x"]) {
    expect(() => createActiveSessionReader({ baseURL })).toThrow("loopback HTTP origin");
  }
});

test("activity_rejects_malformed_or_inactive_registry_entries", async () => {
  for (const data of [[], null, { ses_live: { type: "idle" } }, { unexpected: { type: "running" } }]) {
    const read = createActiveSessionReader({ baseURL, env, pid: 42, fetcher: async url => Response.json(url.endsWith("/api/info") ? { pid: 42 } : { data }) });
    await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  }
});

test("activity_sanitizes_transport_errors_and_http_failures", async () => {
  for (const fetcher of [
    async () => { throw new Error("fixture-password private native error"); },
    async () => new Response("fixture-password private native error", { status: 401 }),
  ]) {
    const read = createActiveSessionReader({ baseURL, env, pid: 42, fetcher });
    await expect(read()).rejects.toMatchObject({ code: "unavailable", message: "Native session activity could not be verified." });
  }
});

test("activity_respects_cancellation_before_network_access", async () => {
  let calls = 0;
  const read = createActiveSessionReader({ baseURL, env, fetcher: async () => { calls++; return Response.json({}); } });
  await expect(read({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "unavailable" });
  expect(calls).toBe(0);
});

test("activity_uses_discovered_dynamic_origin_and_credentials", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const read = createActiveSessionReader({
    pid: 42, env: {},
    discover: async () => ({ url: "http://127.0.0.1:52347", auth: { type: "basic", username: "opencode", password: "managed-secret" } }),
    fetcher: async (url, init) => {
      seen.push({ url, authorization: new Headers(init.headers).get("authorization") });
      return Response.json(url.endsWith("/api/info") ? { pid: 42 } : { data: { ses_live: { type: "running" } } });
    },
  });
  expect({ ...await read() }).toEqual({ ses_live: { type: "running" } });
  expect(seen.map(item => item.url)).toEqual(["http://127.0.0.1:52347/api/info", "http://127.0.0.1:52347/api/session/active"]);
  expect(seen.every(item => item.authorization === `Basic ${Buffer.from("opencode:managed-secret").toString("base64")}`)).toBe(true);
});

test("activity_fails_closed_for_invalid_or_wrong_discovery", async () => {
  const auth = { type: "basic" as const, username: "opencode", password: "secret" };
  for (const endpoint of [undefined, { url: "http://example.com", auth }, { url: baseURL }, { url: baseURL, auth: { ...auth, password: "" } }]) {
    let calls = 0;
    const read = createActiveSessionReader({ discover: async () => endpoint, fetcher: async () => { calls++; return Response.json({}); } });
    await expect(read()).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(0);
  }
  const paths: string[] = [];
  const read = createActiveSessionReader({ pid: 42, discover: async () => ({ url: baseURL, auth }), fetcher: async url => {
    paths.push(new URL(url).pathname);
    return Response.json({ pid: 99 });
  } });
  await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  expect(paths).toEqual(["/api/info"]);
});

test("activity_rediscovers_per_call_and_does_not_leak_discovery_errors", async () => {
  let discoveries = 0;
  const read = createActiveSessionReader({ discover: async () => { discoveries++; throw new Error("secret discovery error"); } });
  for (let i = 0; i < 2; i++) {
    await expect(read()).rejects.toMatchObject({ code: "unavailable", message: "Native session activity could not be verified." });
  }
  expect(discoveries).toBe(2);
});
