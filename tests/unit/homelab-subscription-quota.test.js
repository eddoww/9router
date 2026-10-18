import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_QUOTA_CONFIG as CONFIG } from "../../open-sse/config/errorConfig.js";

const mocks = vi.hoisted(() => ({
  proxy: vi.fn(),
  claude: vi.fn(),
  codex: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: mocks.proxy }));
vi.mock("open-sse/services/usage/claude.js", () => ({ getClaudeUsage: mocks.claude }));
vi.mock("open-sse/services/usage/codex.js", () => ({ getCodexUsage: mocks.codex }));

const NOW = Date.parse("2026-10-18T09:00:00Z");
const HOUR = 3600000;
const quota = (hours, used = 100) => ({
  used, total: 100, remaining: 100 - used, resetAt: new Date(NOW + hours * HOUR).toISOString(),
});
let getReset, parseReset;
const connection = (id = "a", provider = "claude") => ({
  id, provider, authType: "oauth", accessToken: "private-test-token",
  providerSpecificData: { proxyPoolId: "strict-pool" },
});

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.proxy.mockResolvedValue({ source: "pool", strictProxy: true, proxyPoolId: "strict-pool" });
  mocks.claude.mockResolvedValue({ quotas: { "session (5h)": quota(2) } });
  mocks.codex.mockResolvedValue({ quotas: { session: quota(3) } });
  const module = await import("../../src/sse/services/subscriptionQuota.js");
  getReset = module.getSubscriptionQuotaReset;
  parseReset = module.subscriptionQuotaReset;
});
afterEach(() => vi.useRealTimers());

describe("applicable subscription windows", () => {
  it("waits for the latest exhausted Claude window, ignoring healthy later windows", () => {
    const usage = { quotas: {
      "session (5h)": quota(1),
      "weekly (7d)": quota(9),
      "weekly sonnet (7d)": quota(12, 60),
    } };
    expect(parseReset(usage, "claude", "claude-sonnet-5")).toBe(NOW + 9 * HOUR);
  });

  it("applies scoped weekly names with model boundaries and thinking suffixes", () => {
    const usage = { quotas: {
      "weekly sonnet (7d)": quota(9),
      "weekly fable (7d)": quota(4),
      "session (5h)": quota(1),
    } };
    expect(parseReset(usage, "claude", "cc/claude-fable-5(high)")).toBe(NOW + 4 * HOUR);
    expect(parseReset(usage, "claude", "claude-sonnet-5")).toBe(NOW + 9 * HOUR);
    expect(parseReset(usage, "claude", "claude-sonnetish-5")).toBe(NOW + HOUR);
    expect(parseReset(usage, "claude", null)).toBe(NOW + HOUR);
  });

  it("matches full scoped display names without blocking a different model version", () => {
    const usage = { quotas: { "weekly claude fable 5 (7d)": quota(8) } };
    expect(parseReset(usage, "claude", "claude-fable-5")).toBe(NOW + 8 * HOUR);
    expect(parseReset(usage, "claude", "claude-fable-6")).toBeNull();
  });

  it("keeps normal, review, and Spark Codex allowances separate", () => {
    const usage = { quotas: {
      session: quota(1), weekly: quota(6),
      review_session: quota(2), review_weekly: quota(8),
      spark_weekly: quota(10),
    } };
    expect(parseReset(usage, "codex", "cx/gpt-5.6-sol(high)")).toBe(NOW + 6 * HOUR);
    expect(parseReset(usage, "codex", "gpt-5.6-sol-review(high)")).toBe(NOW + 8 * HOUR);
    expect(parseReset(usage, "codex", "codex-auto-review")).toBe(NOW + 8 * HOUR);
    expect(parseReset(usage, "codex", "gpt-5.3-codex-spark")).toBe(NOW + 10 * HOUR);
    expect(parseReset(usage, "codex", null)).toBeNull();
  });

  it.each([
    null, {}, { message: "quota API unavailable", quotas: { session: quota(2) } },
    { quotas: {} },
    { quotas: { session: quota(-1) } },
    { quotas: { session: { ...quota(2), resetAt: "invalid" } } },
    { quotas: { session: { used: 100, total: 100 } } },
    { quotas: { session: { resetAt: quota(2).resetAt } } },
    { quotas: { session: quota(2, 99) } },
    { quotas: { session: { ...quota(2), unlimited: true } } },
  ])("does not invent a subscription reset from unknown, stale, or healthy data: %j", usage => {
    expect(parseReset(usage, "codex", "gpt-5.6-sol")).toBeNull();
  });
});

describe("bounded live lookup", () => {
  it("deduplicates concurrent models for an account but calculates their scopes separately", async () => {
    mocks.claude.mockResolvedValue({ quotas: {
      "weekly sonnet (7d)": quota(3), "weekly fable (7d)": quota(7),
    } });
    const results = await Promise.all([
      getReset(connection(), "claude-sonnet-5"),
      getReset(connection(), "claude-fable-5"),
      getReset(connection(), "claude-sonnet-5"),
    ]);
    expect(results).toEqual([NOW + 3 * HOUR, NOW + 7 * HOUR, NOW + 3 * HOUR]);
    expect(mocks.claude).toHaveBeenCalledTimes(1);
    expect(mocks.claude).toHaveBeenCalledWith("private-test-token",
      expect.objectContaining({ strictProxy: true, proxyPoolId: "strict-pool" }),
      expect.objectContaining({ freshOnly: true, signal: expect.any(AbortSignal) }));
  });

  it("isolates accounts, providers, token rotations, and proxy changes", async () => {
    await getReset(connection(), "claude-sonnet-5");
    await getReset(connection("b"), "claude-sonnet-5");
    await getReset(connection("a", "codex"), "gpt-5.6-sol");
    const changed = { ...connection(), accessToken: "rotated-test-token" };
    await getReset(changed, "claude-sonnet-5");
    await getReset({ ...changed, providerSpecificData: { proxyPoolId: "new-pool" } }, "claude-sonnet-5");
    expect(mocks.claude).toHaveBeenCalledTimes(4);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
  });

  it("refreshes after TTL and never reuses a successful reading after failure", async () => {
    expect(await getReset(connection(), "claude-sonnet-5")).toBe(NOW + 2 * HOUR);
    mocks.claude.mockRejectedValue(new Error("network failed"));
    await vi.advanceTimersByTimeAsync(CONFIG.cacheMs + 1);
    expect(await getReset(connection(), "claude-sonnet-5")).toBeNull();
    expect(await getReset(connection(), "claude-sonnet-5")).toBeNull();
    expect(mocks.claude).toHaveBeenCalledTimes(2);
  });

  it("rechecks reset validity on every cached read", async () => {
    mocks.claude.mockResolvedValue({ quotas: { "session (5h)": quota(0.001) } });
    expect(await getReset(connection(), "claude-sonnet-5")).toBe(NOW + 3600);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await getReset(connection(), "claude-sonnet-5")).toBeNull();
    expect(mocks.claude).toHaveBeenCalledTimes(1);
  });

  it("bounds response time, aborts requests, and deduplicates a stuck transport past TTL", async () => {
    let finish;
    mocks.claude.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = getReset(connection(), "claude-sonnet-5");
    await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs);
    expect(await pending).toBeNull();
    expect(mocks.claude.mock.calls[0][2].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(CONFIG.cacheMs + 1);
    expect(await getReset(connection(), "claude-sonnet-5")).toBeNull();
    expect(mocks.claude).toHaveBeenCalledTimes(1);
    finish({ quotas: { "session (5h)": quota(10) } });
    await vi.advanceTimersByTimeAsync(1);
    mocks.claude.mockResolvedValue({ quotas: { "session (5h)": quota(2) } });
    expect(await getReset(connection(), "claude-sonnet-5")).toBe(NOW + 2 * HOUR);
  });

  it("bounds even proxy resolution and starts no request after its deadline", async () => {
    let finish;
    mocks.proxy.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = getReset(connection(), "claude-sonnet-5");
    await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs);
    expect(await pending).toBeNull();
    finish({ strictProxy: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it("allows at most four active upstream lookups, including timed out transports", async () => {
    const finishes = [];
    mocks.claude.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const pending = Array.from({ length: CONFIG.maxConcurrent + 2 }, (_, i) =>
      getReset(connection(`account-${i}`), "claude-sonnet-5"));
    await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs);
    expect(await Promise.all(pending)).toEqual(Array(CONFIG.maxConcurrent + 2).fill(null));
    await vi.advanceTimersByTimeAsync(CONFIG.cacheMs + 1);
    expect(await getReset(connection("another"), "claude-sonnet-5")).toBeNull();
    expect(mocks.claude).toHaveBeenCalledTimes(CONFIG.maxConcurrent);
    finishes.forEach(finish => finish(null));
    await vi.advanceTimersByTimeAsync(1);
  });

  it("bounds cache size and reclaims expired entries", async () => {
    for (let i = 0; i <= CONFIG.maxEntries; i++) {
      await getReset(connection(`account-${i}`), "claude-sonnet-5");
    }
    expect(mocks.claude).toHaveBeenCalledTimes(CONFIG.maxEntries);
    await vi.advanceTimersByTimeAsync(CONFIG.cacheMs + 1);
    expect(await getReset(connection("new"), "claude-sonnet-5")).toBe(NOW + 2 * HOUR);
    expect(mocks.claude).toHaveBeenCalledTimes(CONFIG.maxEntries + 1);
  });

  it("does not bypass failed proxy resolution", async () => {
    mocks.proxy.mockResolvedValue({ source: "error", strictProxy: false });
    expect(await getReset(connection(), "claude-sonnet-5")).toBeNull();
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it.each([
    null, { ...connection(), accessToken: null },
    connection("a", "openai"), { ...connection(), authType: "apikey" },
  ])("skips unsupported credentials: %j", async conn => {
    expect(await getReset(conn, "claude-sonnet-5")).toBeNull();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
});
