import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.fetch }));
let getClaudeUsage, getCodexUsage;
const NOW = Date.parse("2026-10-18T09:00:00Z");
const reset = "2026-10-18T18:00:00.000Z";
const response = data => ({ ok: true, json: async () => data });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  ({ getClaudeUsage } = await import("../../open-sse/services/usage/claude.js"));
  ({ getCodexUsage } = await import("../../open-sse/services/usage/codex.js"));
});
afterEach(() => vi.useRealTimers());

describe("fresh error-path usage handlers", () => {
  it("bypasses optimistic Claude dashboard cache and parses scoped weekly windows", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ five_hour: { utilization: 1, resets_at: reset } }));
    await getClaudeUsage("test-token");
    mocks.fetch.mockResolvedValueOnce(response({
      five_hour: { utilization: 100, resets_at: reset },
      seven_day: { utilization: 100, resets_at: reset },
      seven_day_sonnet: { utilization: 100, resets_at: reset },
      limits: [{ kind: "weekly_scoped", percent: 100, resets_at: reset,
        scope: { model: { display_name: "Fable" } } }],
    }));
    const controller = new AbortController();
    const usage = await getClaudeUsage("test-token", { strictProxy: true },
      { freshOnly: true, signal: controller.signal });
    expect(usage.quotas["session (5h)"].remaining).toBe(0);
    expect(usage.quotas["weekly sonnet (7d)"].resetAt).toBe(reset);
    expect(usage.quotas["weekly fable (7d)"].remaining).toBe(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][1].signal).toBe(controller.signal);
    expect(mocks.fetch.mock.calls[1][2]).toEqual({ strictProxy: true });
  });

  it("never substitutes stale exhausted dashboard usage for a failed fresh read", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ five_hour: { utilization: 100, resets_at: reset } }));
    await getClaudeUsage("test-token");
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const usage = await getClaudeUsage("test-token", null, { freshOnly: true });
    expect(usage.quotas).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("honors Claude quota-endpoint 429 cooldown without legacy or stale reads", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 429 });
    expect((await getClaudeUsage("test-token", null, { freshOnly: true })).quotas).toBeUndefined();
    expect((await getClaudeUsage("test-token", null, { freshOnly: true })).quotas).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards the Codex workspace, proxy and abort signal while preserving quota families", async () => {
    mocks.fetch.mockResolvedValue(response({
      rate_limit: { primary_window: { used_percent: 10, reset_at: reset } },
      code_review_rate_limit: { primary_window: { used_percent: 100, reset_at: reset } },
    }));
    const controller = new AbortController();
    const proxy = { strictProxy: true, proxyPoolId: "strict-pool" };
    const usage = await getCodexUsage("test-token", proxy, {
      signal: controller.signal,
      providerSpecificData: { workspaceId: "selected-workspace", accountId: "different-account" },
    });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      signal: controller.signal, headers: expect.objectContaining({
        Authorization: "Bearer test-token", "ChatGPT-Account-ID": "selected-workspace",
      }),
    }), proxy);
    expect(usage.quotas.session.remaining).toBe(90);
    expect(usage.quotas.review_session.remaining).toBe(0);
  });
});
