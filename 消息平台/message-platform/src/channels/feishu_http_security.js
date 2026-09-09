const crypto = require("crypto");

const seenNonces = new Map();

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|y|on)$/i.test(String(value));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanupNonces(nowSeconds, maxAgeSeconds) {
  for (const [key, seenAt] of seenNonces) {
    if (nowSeconds - seenAt > maxAgeSeconds) seenNonces.delete(key);
  }
}

function verifyFeishuHttpRequest({ headers = {}, rawBody = "", body = {}, nowSeconds = Math.floor(Date.now() / 1000), env = process.env }) {
  const requireAuth = bool(env.FEISHU_HTTP_CALLBACK_REQUIRE_AUTH, true);
  const verificationToken = String(env.FEISHU_EVENT_VERIFY_TOKEN || "");
  const encryptKey = String(env.FEISHU_EVENT_ENCRYPT_KEY || "");
  if (!verificationToken && !encryptKey) {
    if (requireAuth) return { ok: false, status: 503, reason: "callback_auth_not_configured" };
    return { ok: true, mode: "explicitly_unprotected" };
  }

  const timestamp = String(headers["x-lark-request-timestamp"] || "");
  const nonce = String(headers["x-lark-request-nonce"] || "");
  const signature = String(headers["x-lark-signature"] || "");
  const maxAgeSeconds = Math.max(60, Number(env.FEISHU_HTTP_CALLBACK_MAX_SKEW_SECONDS || 300));

  if (timestamp) {
    const numericTimestamp = Number(timestamp);
    if (!Number.isFinite(numericTimestamp) || Math.abs(nowSeconds - numericTimestamp) > maxAgeSeconds) {
      return { ok: false, status: 401, reason: "callback_timestamp_expired" };
    }
  }

  if (encryptKey) {
    if (!timestamp || !nonce || !signature) return { ok: false, status: 401, reason: "callback_signature_headers_missing" };
    const computed = crypto.createHash("sha256").update(timestamp + nonce + encryptKey + rawBody).digest("hex");
    if (!safeEqual(computed, signature)) return { ok: false, status: 401, reason: "callback_signature_invalid" };
  }

  if (verificationToken) {
    const receivedToken = body?.header?.token || body?.token || "";
    if (!safeEqual(receivedToken, verificationToken)) return { ok: false, status: 401, reason: "callback_verification_token_invalid" };
  }

  if (body?.encrypt) return { ok: false, status: 400, reason: "encrypted_callback_payload_not_supported_use_sdk_or_plain_verified_callback" };

  const eventId = String(body?.header?.event_id || body?.event_id || "");
  if ((timestamp && nonce) || eventId) {
    cleanupNonces(nowSeconds, maxAgeSeconds);
    const replayKey = timestamp && nonce ? `request:${timestamp}:${nonce}:${signature}` : `event:${eventId}`;
    if (seenNonces.has(replayKey)) return { ok: false, status: 409, reason: "callback_replay_detected" };
    seenNonces.set(replayKey, nowSeconds);
  }
  return { ok: true, mode: encryptKey ? "signature_and_token" : "verification_token" };
}

function clearReplayCache() {
  seenNonces.clear();
}

module.exports = { verifyFeishuHttpRequest, clearReplayCache };
