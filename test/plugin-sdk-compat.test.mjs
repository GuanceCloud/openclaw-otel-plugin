import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release bundle uses focused OpenClaw SDK entry points", async () => {
  const bundle = await readFile(new URL("../dist/index.cjs", import.meta.url), "utf8");

  assert.doesNotMatch(bundle, /["']openclaw\/plugin-sdk["']/);
  assert.match(bundle, /["']openclaw\/plugin-sdk\/diagnostic-runtime["']/);
});
