import test from "node:test";
import assert from "node:assert/strict";
import worker, { HealthRelay } from "../src/worker.js";

function makeEnvironment() {
  const values = new Map();
  const state = {
    storage: {
      get: async (key) => values.get(key),
      put: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
      deleteAll: async () => values.clear(),
    },
  };
  const relay = new HealthRelay(state);
  const relayStub = {
    fetch: (input, init) => relay.fetch(input instanceof Request ? input : new Request(input, init)),
  };

  return {
    UPLOAD_TOKEN: "upload-token-for-tests-only-1234567890",
    MCP_PATH_TOKEN: "mcp-token-for-tests-only-1234567890",
    HEALTH_RELAY: {
      idFromName: (name) => name,
      get: () => relayStub,
    },
  };
}

async function uploadPayload(env, payload) {
  return worker.fetch(new Request("https://example.test/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPLOAD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }), env);
}

async function callTool(env, name, args = {}) {
  const response = await worker.fetch(new Request(`https://example.test/mcp/${env.MCP_PATH_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }), env);
  const body = await response.json();
  return JSON.parse(body.result.content[0].text);
}

test("rejects uploads without the private token", async () => {
  const response = await worker.fetch(new Request("https://example.test/upload", { method: "POST", body: "{}" }), makeEnvironment());
  assert.equal(response.status, 401);
});

test("uploads a snapshot and returns it through MCP", async () => {
  const env = makeEnvironment();
  const sampledAt = new Date().toISOString();
  const upload = await uploadPayload(env, {
    sampled_at: sampledAt,
    device: "test",
    metrics: { heart_rate: { value: 72, unit: "BPM", sampled_at: sampledAt } },
  });
  assert.equal(upload.status, 200);

  const latest = await callTool(env, "watch_get_latest_health");
  assert.equal(latest.metrics.heart_rate.value, 72);
  assert.equal(latest.history_summary.heart_rate.count, 1);
});

test("keeps three recent values and seven days of sleep stages without duplicates", async () => {
  const env = makeEnvironment();
  const now = Date.now();
  const at = (offset) => new Date(now + offset).toISOString();
  const payload = {
    sampled_at: at(0),
    device: "test",
    history: {
      heart_rate: [0, 1, 2, 3].map((index) => ({
        value: 70 + index,
        unit: "BPM",
        sampled_at: at(-index * 60_000),
      })),
      sleep: [
        { value: 40, unit: "min", stage: "asleep_deep", started_at: at(-2 * 60 * 60_000), sampled_at: at(-80 * 60_000) },
        { value: 30, unit: "min", stage: "asleep_rem", started_at: at(-80 * 60_000), sampled_at: at(-50 * 60_000) },
        { value: 60, unit: "min", stage: "asleep_core", started_at: at(-8 * 24 * 60 * 60_000), sampled_at: at(-8 * 24 * 60 * 60_000 + 60 * 60_000) },
      ],
    },
  };

  assert.equal((await uploadPayload(env, payload)).status, 200);
  assert.equal((await uploadPayload(env, payload)).status, 200);

  const history = await callTool(env, "watch_get_health_history");
  assert.deepEqual(history.history.heart_rate.map((record) => record.value), [70, 71, 72]);
  assert.equal(history.history.sleep.length, 2);
  assert.deepEqual(history.history.sleep.map((record) => record.stage).sort(), ["asleep_deep", "asleep_rem"]);
  assert.equal(history.history_summary.sleep.retention.days, 7);
  assert.equal(history.history_summary.heart_rate.retention.count, 3);
});

test("deletes the stored snapshot", async () => {
  const env = makeEnvironment();
  const response = await worker.fetch(new Request("https://example.test/data", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.UPLOAD_TOKEN}` },
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: true });
});
