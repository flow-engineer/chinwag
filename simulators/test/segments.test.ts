// covers: simulators/src/platforms.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { smsSegments } from "../src/index.ts";

test("SMS segments: 160 GSM-7 or 70 Unicode characters fit one text, and extension characters count twice", () => {
  assert.deepEqual(smsSegments("a".repeat(160)), { encoding: "GSM-7", segments: 1, remaining: 0 });
  assert.deepEqual(smsSegments("a".repeat(161)), { encoding: "GSM-7", segments: 2, remaining: 145 });
  assert.deepEqual(smsSegments("é".repeat(69) + "😀"), { encoding: "Unicode", segments: 1, remaining: 0 });
  assert.deepEqual(smsSegments("a".repeat(70) + "😀"), { encoding: "Unicode", segments: 2, remaining: 63 });
  assert.deepEqual(smsSegments("€".repeat(80)), { encoding: "GSM-7", segments: 1, remaining: 0 });
  assert.deepEqual(smsSegments("€".repeat(80) + "a"), { encoding: "GSM-7", segments: 2, remaining: 145 });
});
