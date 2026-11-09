import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActiveSessionReader } from "../src/activity.ts";

// Fixture HTTP listener only: this is not an OpenCode host or database.
test("discovery_worker_confines_the_real_service_probe", async () => {
  let calls = 0;
  let redirect = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      calls++;
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`);
      return redirect
        ? new Response(null, { status: 302, headers: { location: "/redirected" } })
        : Response.json({ pid: 42, version: "2.1.4" });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "chat-discovery-"));
  const file = join(directory, "service.json");
  const run = async (url: string) => {
    await writeFile(file, JSON.stringify({ url, pid: 42, version: "2.1.4", password: "fixture-password" }));
    const worker = new Worker(new URL("../discover-worker.js", import.meta.url));
    try {
      return await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker timed out")), 5000);
        worker.onmessage = event => { clearTimeout(timer); resolve(event.data.endpoint); };
        worker.onerror = error => { clearTimeout(timer); reject(error); };
        worker.postMessage({ file });
      });
    } finally { worker.terminate(); }
  };
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    expect(await run(origin)).toEqual({ url: origin, auth: { type: "basic", username: "opencode", password: "fixture-password" } });
    expect(calls).toBe(1);
    redirect = true;
    expect(await run(origin)).toBeUndefined();
    expect(calls).toBe(2); // the redirect is not followed
    expect(await run(`http://localhost:${server.port}`)).toBeUndefined();
    expect(calls).toBe(2); // no DNS or request to a non-literal origin
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("activity_discovers_and_authenticates_through_the_worker", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:fixture-password").toString("base64")}`);
      return Response.json(new URL(request.url).pathname === "/api/info"
        ? { pid: process.pid, version: "2.1.4" }
        : { data: { ses_live: { type: "running" } } });
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "chat-activity-"));
  try {
    await mkdir(join(directory, "opencode"));
    await writeFile(join(directory, "opencode", "service.json"), JSON.stringify({
      url: `http://127.0.0.1:${server.port}`, pid: process.pid, version: "2.1.4", password: "fixture-password",
    }));
    const read = createActiveSessionReader({ registrationFile: join(directory, "opencode", "service.json") });
    expect({ ...await read() }).toEqual({ ses_live: { type: "running" } });
    expect(paths).toEqual(["/api/info", "/api/info", "/api/session/active"]);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
