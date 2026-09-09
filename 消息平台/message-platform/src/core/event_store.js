const path = require("path");
const { readJson, writeJson } = require("./json_file");

class EventStore {
  constructor(rootDir, storePath = "data/state/inbound_events.json") {
    this.storePath = path.resolve(rootDir, storePath);
    this.state = readJson(this.storePath, { events: {} });
    this.state.events = this.state.events || {};
  }

  key(channelAccountId, eventId) {
    return `${channelAccountId || "default"}:${eventId || ""}`;
  }

  claim(channelAccountId, eventId) {
    if (!eventId) return { claimed: true, key: "", record: null };
    const key = this.key(channelAccountId, eventId);
    const existing = this.state.events[key];
    if (existing) return { claimed: false, key, record: existing };
    const record = { channel_account_id: channelAccountId || "default", event_id: eventId, status: "processing", created_at: new Date().toISOString() };
    this.state.events[key] = record;
    writeJson(this.storePath, this.state);
    return { claimed: true, key, record };
  }

  finish(key, status, detail = {}) {
    if (!key || !this.state.events[key]) return;
    this.state.events[key] = { ...this.state.events[key], status, updated_at: new Date().toISOString(), ...detail };
    const entries = Object.entries(this.state.events).slice(-2000);
    this.state.events = Object.fromEntries(entries);
    writeJson(this.storePath, this.state);
  }
}

module.exports = { EventStore };
