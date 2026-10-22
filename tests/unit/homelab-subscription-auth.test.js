import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModelLockUntil, isModelLockActive } from "../../open-sse/services/accountFallback.js";

const mocks = vi.hoisted(() => ({
  connections: vi.fn(), update: vi.fn(), quota: vi.fn(), settings: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.connections, updateProviderConnection: mocks.update,
  getSettings: mocks.settings,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn(),
}));
vi.mock("@/sse/services/subscriptionQuota.js", async importOriginal => ({
  ...await importOriginal(), getSubscriptionQuotaReset: mocks.quota,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: vi.fn(), getAntigravityModelQuota: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { clearAccountError, getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
const NOW = Date.parse("2026-10-18T09:00:00Z");
const HOUR = 3600000;
const iso = hours => new Date(NOW + hours * HOUR).toISOString();
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.connections.mockResolvedValue([{ id: "a", provider: "claude", accessToken: "test-token", backoffLevel: 15 }]);
  mocks.settings.mockResolvedValue({});
  mocks.quota.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("subscription failure persistence", () => {
  it.each(["claude", "codex", "cc", "cx"])("preserves a verified %s reset beyond 30 minutes", async provider => {
    mocks.quota.mockResolvedValue(NOW + 9 * HOUR);
    const result = await markAccountUnavailable("a", 429, "usage limit reached", provider, "model");
    expect(result.cooldownMs).toBe(9 * HOUR);
    expect(mocks.update).toHaveBeenCalledWith("a",
      expect.objectContaining({ modelLock_model: iso(9), backoffLevel: 0 }));
  });

  it("combines an explicit Codex reset with a later exhausted quota window", async () => {
    mocks.quota.mockResolvedValue(NOW + 12 * HOUR);
    const result = await markAccountUnavailable("a", 429, "usage limit", "codex", "model", NOW + HOUR);
    expect(result.cooldownMs).toBe(12 * HOUR);
  });

  it("preserves precise upstream Codex resets when live usage is unavailable", async () => {
    const result = await markAccountUnavailable("a", 429, "usage limit", "codex", "model", NOW + 5 * HOUR);
    expect(result.cooldownMs).toBe(5 * HOUR);
  });

  it("keeps ordinary 429 fallback when usage does not confirm applicable exhaustion", async () => {
    const result = await markAccountUnavailable("a", 429, "too many requests", "claude", "model");
    expect(result.cooldownMs).toBe(300000);
    expect(mocks.update).toHaveBeenCalledWith("a", expect.objectContaining({
      modelLock_model: new Date(NOW + 300000).toISOString(),
    }));
  });

  it("does not consult subscription usage for non-429 errors", async () => {
    await markAccountUnavailable("a", 503, "capacity", "claude", "model");
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it("retains the cap for unverified reset hints on other providers", async () => {
    const result = await markAccountUnavailable("a", 429, "rate limit", "other", "model", NOW + 5 * HOUR);
    expect(result.cooldownMs).toBe(1800000);
  });

  it("retains Antigravity's exact reset", async () => {
    const result = await markAccountUnavailable("a", 429, "rate limit", "antigravity", "model", NOW + 5 * HOUR);
    expect(result.cooldownMs).toBe(5 * HOUR);
  });

  it.each([NaN, Infinity, NOW - 1])("ignores invalid or expired explicit reset %s", async reset => {
    const result = await markAccountUnavailable("a", 429, "rate limit", "codex", "model", reset);
    expect(result.cooldownMs).toBe(300000);
  });
});

describe("Codex shared exhaustion scope", () => {
  async function exhaust(model, reset = NOW + 12 * HOUR, explicit = null) {
    const conn = { id: "a", provider: "codex", accessToken: "test-token" };
    mocks.connections.mockResolvedValue([conn]);
    mocks.quota.mockResolvedValue(reset);
    await markAccountUnavailable("a", 429, "quota", "cx", model, explicit);
    expect(mocks.connections).toHaveBeenLastCalledWith({ provider: "codex" });
    Object.assign(conn, mocks.update.mock.calls.at(-1)[1]);
    return conn;
  }

  it("blocks a normal model switch but allows review and Spark", async () => {
    const conn = await exhaust("gpt-5.4");
    expect(conn.modelLock___codex_quota_normal).toBe(iso(12));
    expect(await getProviderCredentials("cx", null, "gpt-5.3-codex"))
      .toMatchObject({ allRateLimited: true, retryAfter: iso(12) });
    for (const model of ["gpt-5.4-review", "gpt-5.3-codex-spark"]) {
      expect(await getProviderCredentials("codex", null, model)).toMatchObject({ connectionId: "a" });
    }
  });

  it.each([
    ["cx/gpt-5.4-review(high)", "gpt-5.3-codex-review", "review"],
    ["gpt-5.3-codex-spark", "gpt-5.3-codex-spark(high)", "spark"],
  ])("keeps %s exhaustion in its quota family", async (model, sibling, scope) => {
    const conn = await exhaust(model);
    expect(conn[`modelLock___codex_quota_${scope}`]).toBe(iso(12));
    expect(await getProviderCredentials("codex", null, sibling)).toMatchObject({ allRateLimited: true });
    expect(await getProviderCredentials("codex", null, "gpt-5.4")).toMatchObject({ connectionId: "a" });
  });

  it("does not broaden a transient Retry-After-only 429", async () => {
    const conn = await exhaust("gpt-5.4", null, NOW + 2 * HOUR);
    expect(conn.modelLock___codex_quota_normal).toBeUndefined();
    expect(await getProviderCredentials("codex", null, "gpt-5.3-codex")).toMatchObject({ connectionId: "a" });
    expect(await getProviderCredentials("codex", null, "gpt-5.4"))
      .toMatchObject({ allRateLimited: true, retryAfter: iso(2) });
  });

  it("combines a later Retry-After with confirmed exhaustion without broadening the header", async () => {
    const conn = await exhaust("gpt-5.4", NOW + 2 * HOUR, NOW + 12 * HOUR);
    expect(conn.modelLock___codex_quota_normal).toBe(iso(2));
    expect(await getProviderCredentials("codex", null, "gpt-5.4"))
      .toMatchObject({ allRateLimited: true, retryAfter: iso(12) });
    expect(await getProviderCredentials("codex", null, "gpt-5.3-codex"))
      .toMatchObject({ allRateLimited: true, retryAfter: iso(2) });
  });

  it("does not clear shared exhaustion on a successful independent lane", async () => {
    const conn = await exhaust("gpt-5.4");
    await clearAccountError("a", conn, "gpt-5.4-review");
    expect(mocks.update.mock.calls.at(-1)[1]).not.toHaveProperty("modelLock___codex_quota_normal");
    vi.setSystemTime(NOW + 13 * HOUR);
    await clearAccountError("a", conn, "gpt-5.4-review");
    expect(mocks.update.mock.calls.at(-1)[1]).toMatchObject({ modelLock___codex_quota_normal: null });
  });
});

describe("account/model pool deadlines", () => {
  it("uses the latest applicable lock on each account, then the earliest eligible account", async () => {
    mocks.connections.mockResolvedValue([
      { id: "a", modelLock_model: iso(2), modelLock___all: iso(8), modelLock_unrelated: iso(1) },
      { id: "b", modelLock_model: iso(5), modelLock_review: iso(0.1) },
      { id: "disabled-for-model", modelLock_model: iso(0.2), providerSpecificData: { enabledModels: ["other"] } },
    ]);
    const result = await getProviderCredentials("codex", null, "model");
    expect(result).toMatchObject({ allRateLimited: true, retryAfter: iso(5), retryAfterHuman: "reset after 5h" });
  });

  it("honors an active account-wide lock when the requested model lock has expired", () => {
    const conn = { modelLock_model: iso(-1), modelLock___all: iso(3) };
    expect(isModelLockActive(conn, "model")).toBe(true);
    expect(getModelLockUntil(conn, "model")).toBe(iso(3));
    expect(getModelLockUntil({ modelLock_other: iso(4) }, "model")).toBeNull();
  });

  it("keeps a healthy eligible account in rotation despite an unrelated lock", async () => {
    mocks.connections.mockResolvedValue([
      { id: "a", modelLock_model: iso(3) },
      { id: "b", modelLock_review: iso(6) },
    ]);
    expect(await getProviderCredentials("codex", null, "model")).toMatchObject({ connectionId: "b" });
  });

  it("returns no reset from accounts that cannot serve the requested model", async () => {
    mocks.connections.mockResolvedValue([
      { id: "a", modelLock_model: iso(2), providerSpecificData: { enabledModels: ["other"] } },
    ]);
    expect(await getProviderCredentials("codex", null, "model")).toBeNull();
  });
});
