import { expect, test } from "bun:test";
import { Host } from "@opencode/plugin/host";
import { fileURLToPath } from "node:url";

test("native_directory_loader_finds_the_root_entrypoint", () => {
  const directory = fileURLToPath(new URL("../", import.meta.url));
  const entrypoints = Host.resolve({ directory });
  expect(entrypoints.server).toBeDefined();
  expect(entrypoints.server).toContain("index.ts");
});
