import test from "node:test";
import assert from "node:assert/strict";
import { parseSymlinkMappings } from "../src/symlinkBootstrap";

test("parseSymlinkMappings supports comma-separated source=target pairs", () => {
  const mappings = parseSymlinkMappings("/app/logs=/appdata/bot/logs,/app/workspace=/appdata/upstream/workspace");

  assert.deepEqual(mappings, [
    { source: "/app/logs", target: "/appdata/bot/logs" },
    { source: "/app/workspace", target: "/appdata/upstream/workspace" }
  ]);
});

test("parseSymlinkMappings also accepts colon-separated pairs", () => {
  const mappings = parseSymlinkMappings("/app/cache:/appdata/cache");

  assert.deepEqual(mappings, [{ source: "/app/cache", target: "/appdata/cache" }]);
});
