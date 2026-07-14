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

test("rejects uploads without the private token", async () => {
  const response = await worker.fetch(new Request("https://example.test/upload", { method: "POST", body: "{}" }), makeEnvironment());
  assert.equal(response.status, 401);
});

test("uploads a snapshot and returns it through MCP", async () => {
  const env = makeEnvironment();
  const sampledAt = new Date().toISOString();
  const upload = await worker.fetch(new Request("https://example.test/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.UPLOAD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sampled_at: sampledAt,
      device: "test",
      metrics: { heart_rate: { value: 72, unit: "BPM", sampled_at: sampledAt } },
    }),
  }), env);
  assert.equal(upload.status, 200);

  const mcp = await worker.fetch(new Request(`https://example.test/mcp/${env.MCP_PATH_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "watch_get_latest_health", arguments: {} },
    }),
  }), env);
  const body = await mcp.json();
  assert.equal(mcp.status, 200);
  assert.match(body.result.content[0].text, /72/);
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
