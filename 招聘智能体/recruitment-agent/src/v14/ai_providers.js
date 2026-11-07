const crypto = require("crypto");
const { nowIso } = require("./jobs_repo");
const { encryptSecret, decryptSecret, maskSecret } = require("./secret_store");

function listProviders(db, options = {}) {
  const rows = db.prepare("SELECT * FROM ai_providers ORDER BY sort_order ASC, created_at ASC").all();
  return rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    api_key_masked: row.key_cipher ? "****" : "",
    has_key: Boolean(row.key_cipher),
    ...(options.includeSecret ? { api_key: decryptSecret(row.key_cipher) } : {}),
  }));
}

function getProvider(db, id, options = {}) {
  const row = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    api_key_masked: row.key_cipher ? "****" : "",
    has_key: Boolean(row.key_cipher),
    ...(options.includeSecret ? { api_key: decryptSecret(row.key_cipher) } : {}),
  };
}

function saveProvider(db, input = {}) {
  const id = String(input.id || crypto.randomUUID());
  const now = nowIso();
  const existing = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id);
  const keyCipher = input.api_key === undefined
    ? existing?.key_cipher || ""
    : input.api_key
      ? encryptSecret(input.api_key)
      : "";
  db.prepare(
    `INSERT INTO ai_providers(id, name, type, base_url, model, command, key_cipher, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, base_url = excluded.base_url,
       model = excluded.model, command = excluded.command, key_cipher = excluded.key_cipher,
       enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = excluded.updated_at`
  ).run(
    id,
    String(input.name || "未命名供应商"),
    String(input.type || "openai"),
    String(input.base_url || ""),
    String(input.model || ""),
    String(input.command || ""),
    keyCipher,
    input.enabled === false ? 0 : 1,
    Number(input.sort_order == null ? 100 : input.sort_order),
    existing?.created_at || now,
    now
  );
  return getProvider(db, id);
}

function deleteProvider(db, id) {
  return Number(db.prepare("DELETE FROM ai_providers WHERE id = ?").run(id).changes || 0);
}

async function testProvider(db, id, options = {}) {
  const provider = getProvider(db, id, { includeSecret: true });
  if (!provider) throw new Error("供应商不存在");
  const tester = options.test || defaultTest;
  const result = await tester(provider);
  db.prepare("UPDATE ai_providers SET last_test_at = ?, last_status = ? WHERE id = ?").run(
    nowIso(),
    result.ok ? "ok" : String(result.error || "failed").slice(0, 500),
    id
  );
  return { ...result, provider: getProvider(db, id) };
}

async function defaultTest(provider) {
  if (provider.type === "codex") {
    return { ok: Boolean(provider.command), detail: provider.command ? "configured" : "missing command" };
  }
  if (!provider.base_url || !provider.api_key) return { ok: false, error: "缺少 Base URL 或 API Key" };
  const url = `${provider.base_url.replace(/\/+$/, "")}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "只回复 OK" }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await response.json().catch(() => ({}));
    const error = json.error?.message || `HTTP ${response.status}`;
    return { ok: response.ok, status: response.status, error: response.ok ? "" : error.slice(0, 500) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function runWithFallback(db, call, options = {}) {
  const providers = listProviders(db).filter((item) => item.enabled);
  const errors = [];
  for (const provider of providers) {
    try {
      const result = await call(getProvider(db, provider.id, { includeSecret: true }), provider);
      return { ok: true, provider, result, errors };
    } catch (error) {
      errors.push({ providerId: provider.id, name: provider.name, error: error.message });
    }
  }
  return { ok: false, provider: null, result: null, errors };
}

module.exports = {
  listProviders,
  getProvider,
  saveProvider,
  deleteProvider,
  testProvider,
  runWithFallback,
  maskSecret,
};
