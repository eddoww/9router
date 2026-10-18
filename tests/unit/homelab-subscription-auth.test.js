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
vi.mock("@/sse/services/subscriptionQuota.js", () => ({ getSubscriptionQuotaReset: mocks.quota }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: vi.fn(), getAntigravityModelQuota: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";
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
