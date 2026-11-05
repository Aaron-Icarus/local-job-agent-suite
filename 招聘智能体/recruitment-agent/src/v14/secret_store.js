const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function keyPath() {
  return process.env.V14_SECRET_KEY_PATH || path.join(__dirname, "..", "..", "data", "v1.4", "secret.key");
}

function loadKey() {
  const file = keyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
}

function encryptSecret(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  if (!value || !String(value).startsWith("v1:")) return "";
  const [, ivText, tagText, dataText] = String(value).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function maskSecret(value) {
  if (!value) return "";
  return `${String(value).slice(0, 3)}****${String(value).slice(-2)}`;
}

module.exports = { keyPath, encryptSecret, decryptSecret, maskSecret };
