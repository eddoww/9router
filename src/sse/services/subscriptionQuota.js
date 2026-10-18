import { createHash } from "node:crypto";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { SUBSCRIPTION_QUOTA_CONFIG } from "open-sse/config/errorConfig.js";
import { getModelQuotaFamily } from "open-sse/config/providerModels.js";
import { CODEX_REVIEW_SUFFIX } from "open-sse/providers/models/helpers.js";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";

const snapshots = new Map();
let activeLookups = 0;

function cleanModel(model) {
  return String(model || "").split("/").pop().replace(/\([^()]+\)\s*$/, "").trim().toLowerCase();
}

function applies(provider, name, model) {
  if (provider === "codex") {
    if (!model) return false;
    const family = getModelQuotaFamily("cx", model);
    const prefix = family === "review" || model.endsWith(CODEX_REVIEW_SUFFIX)
      ? "review_" : model.includes("spark") ? "spark_" : "";
    return name === `${prefix}session` || name === `${prefix}weekly`;
  }
  if (name === "session (5h)" || name === "weekly (7d)") return true;
  const scope = /^weekly (.+) \(7d\)$/.exec(name)?.[1];
  if (!scope || !model) return false;
  const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `-${normalize(model)}-`.includes(`-${normalize(scope)}-`);
}

/** Return only confirmed exhaustion deadlines, never an availability assertion. */
export function subscriptionQuotaReset(usage, provider, model, now = Date.now()) {
  if (!usage?.quotas || usage.message || usage.error) return null;
  const resets = Object.entries(usage.quotas)
    .filter(([name]) => applies(provider, name, cleanModel(model)))
    .filter(([, quota]) => quota?.unlimited !== true &&
      ((Number.isFinite(quota?.remaining) && quota.remaining <= 0) ||
       (Number.isFinite(quota?.remainingPercentage) && quota.remainingPercentage <= 0) ||
       (Number.isFinite(quota?.used) && Number.isFinite(quota?.total) &&
        quota.total > 0 && quota.used >= quota.total)))
    .map(([, quota]) => quota.resetAt ? new Date(quota.resetAt).getTime() : NaN)
    .filter(reset => Number.isFinite(reset) && reset > now);
  return resets.length ? Math.max(...resets) : null;
}

async function readSnapshot(connection) {
  const { provider, id, accessToken, providerSpecificData } = connection;
  const key = `${provider}:${id}`;
  // Credential or route changes invalidate a cached read without placing secrets in keys.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([accessToken, providerSpecificData])).digest("hex");
  const now = Date.now();
  const hit = snapshots.get(key);
  if (hit?.fingerprint === fingerprint) {
    if (hit.pending || hit.expiresAt > now) return hit.promise;
  } else if (hit?.pending) {
    return null;
  }

  for (const [entryKey, entry] of snapshots) {
    if (!entry.pending && entry.expiresAt <= now) snapshots.delete(entryKey);
  }
  if (activeLookups >= SUBSCRIPTION_QUOTA_CONFIG.maxConcurrent) return null;
  if (!snapshots.has(key) && snapshots.size >= SUBSCRIPTION_QUOTA_CONFIG.maxEntries) return null;

  const controller = new AbortController();
  const entry = { fingerprint, pending: true, expiresAt: 0, promise: null };
  activeLookups++;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, SUBSCRIPTION_QUOTA_CONFIG.timeoutMs);
  });
  const lookup = (async () => {
    try {
      const proxyOptions = await resolveConnectionProxyConfig(providerSpecificData || {});
      if (controller.signal.aborted || proxyOptions?.source === "error") return null;
      const options = { freshOnly: true, signal: controller.signal, providerSpecificData };
      const usage = provider === "claude"
        ? await getClaudeUsage(accessToken, proxyOptions, options)
        : await getCodexUsage(accessToken, proxyOptions, options);
      return controller.signal.aborted ? null : usage;
    } catch {
      // Quota lookup failures must preserve normal fallback and never log credentials.
      return null;
    } finally {
      entry.pending = false;
      activeLookups--;
    }
  })();
  entry.promise = Promise.race([lookup, timeout]).finally(() => {
    clearTimeout(timer);
    entry.expiresAt = Date.now() + SUBSCRIPTION_QUOTA_CONFIG.cacheMs;
  });
  snapshots.set(key, entry);
  return entry.promise;
}

/** At most one live lookup per connection/30s, including failures and 429 bursts. */
export async function getSubscriptionQuotaReset(connection, model) {
  if (!connection?.id || !connection.accessToken ||
      !["claude", "codex"].includes(connection.provider) ||
      (connection.authType && connection.authType !== "oauth")) return null;
  const usage = await readSnapshot(connection);
  return subscriptionQuotaReset(usage, connection.provider, model);
}
