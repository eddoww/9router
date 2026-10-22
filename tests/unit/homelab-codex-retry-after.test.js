import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const NOW = Date.parse("2026-10-23T10:00:00Z");
const executor = new CodexExecutor();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());
const parse = (header, body = "", status = 429) => parseUpstreamError(new Response(body, {
  status, headers: header === null ? {} : { "Retry-After": header },
}), executor);
const usage = fields => JSON.stringify({ error: { type: "usage_limit_reached", message: "Quota exhausted", ...fields } });

describe("Codex Retry-After through the upstream parse path", () => {
  it.each(["7200", new Date(NOW + 7200000).toUTCString()])("respects %s beyond transient cooldown caps", async header => {
    expect(await parse(header)).toMatchObject({ statusCode: 429, resetsAtMs: NOW + 7200000 });
  });
  it.each(["", "garbage", "-1", "1.5", "Infinity", "1e9", "9".repeat(400), "0", new Date(NOW - 1000).toUTCString()])("ignores invalid/expired header %s", async header => {
    expect((await parse(header)).resetsAtMs).toBeUndefined();
  });
  it.each(["", "not JSON", '{"error":{"message":"model at capacity"}}'])("honors headers despite body %s", async body => {
    expect((await parse("60", body)).resetsAtMs).toBe(NOW + 60000);
  });
  it("takes the latest header and body reset", async () => {
    expect(await parse("7200", usage({ resets_at: NOW / 1000 + 3600 })))
      .toMatchObject({ resetsAtMs: NOW + 7200000, message: "Quota exhausted" });
    expect(await parse("60", usage({ resets_at: NOW / 1000 + 3600, resets_in_seconds: 7200 })))
      .toMatchObject({ resetsAtMs: NOW + 7200000 });
  });
  it("preserves body reset without a valid header", async () => {
    expect((await parse(null, usage({ resets_in_seconds: 90 }))).resetsAtMs).toBe(NOW + 90000);
  });
  it("does not apply Retry-After to non-429 errors", async () => {
    expect((await parse("7200", "busy", 503)).resetsAtMs).toBeUndefined();
  });
});
