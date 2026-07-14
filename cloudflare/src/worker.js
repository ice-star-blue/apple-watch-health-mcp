const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const LIVE_FRESH_SECONDS = 15;
const RECENT_SECONDS = 5 * 60;
const MAX_UPLOAD_BYTES = 64 * 1024;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message) {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

function bearerMatches(request, expected) {
  return Boolean(expected) && request.headers.get("Authorization") === `Bearer ${expected}`;
}

function relay(env) {
  return env.HEALTH_RELAY.get(env.HEALTH_RELAY.idFromName("watch-health-global"));
}

function isoNow() {
  return new Date().toISOString();
}

function ageSeconds(isoDate) {
  const timestamp = Date.parse(isoDate || "");
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
}

function latestMetricDate(metrics = {}) {
  const timestamps = Object.values(metrics)
    .map((metric) => Date.parse(metric?.sampled_at || ""))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function freshnessForAge(age) {
  if (age === null) return "unknown";
  if (age <= LIVE_FRESH_SECONDS) return "live";
  if (age <= RECENT_SECONDS) return "recent";
  return "stale";
}

function toolsList() {
  return [
    {
      name: "watch_health_open_session",
      description: "Start here. Check Apple Watch connection, data freshness, live-measurement state, and the latest available health snapshot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Check Apple Watch health connection",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "watch_measure_now",
      description: "Request a fresh Apple Watch heart-rate sample. Returns a newly measured value when live mode is active; otherwise reports that the watch must start live mode.",
      inputSchema: {
        type: "object",
        properties: {
          wait_seconds: {
            type: "integer",
            minimum: 3,
            maximum: 25,
            default: 15,
            description: "How long to wait for a sample newer than this request.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Measure Apple Watch heart rate now",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "watch_get_latest_health",
      description: "Read all latest health metrics uploaded by the iPhone or Apple Watch, including timestamps and age. This does not claim old data is a new measurement.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Read latest Apple Watch health data",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function snapshotEnvelope(snapshot) {
  if (!snapshot) {
    return {
      connected: false,
      live_mode: false,
      freshness: "no_data",
      message: "No Apple Watch health data has been uploaded yet.",
    };
  }

  const age = ageSeconds(snapshot.sampled_at || snapshot.uploaded_at);
  const liveMode = snapshot.live_mode === true && age !== null && age <= RECENT_SECONDS;
  const freshness = freshnessForAge(age);
  const metrics = Object.fromEntries(
    Object.entries(snapshot.metrics || {}).map(([key, metric]) => {
      const metricAge = ageSeconds(metric?.sampled_at);
      return [key, {
        ...metric,
        age_seconds: metricAge,
        freshness: freshnessForAge(metricAge),
      }];
    })
  );

  return {
    ...snapshot,
    connected: age !== null && age <= RECENT_SECONDS,
    live_mode: liveMode,
    freshness,
    age_seconds: age,
    metrics,
  };
}

async function callTool(env, name, args) {
  if (name === "watch_health_open_session" || name === "watch_get_latest_health") {
    const response = await relay(env).fetch("https://relay/snapshot");
    const snapshot = response.status === 404 ? null : await response.json();
    return toolText(snapshotEnvelope(snapshot));
  }

  if (name === "watch_measure_now") {
    const waitSeconds = Math.min(25, Math.max(3, Number(args?.wait_seconds) || 15));
    const requestedAt = isoNow();
    const response = await relay(env).fetch("https://relay/measure", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ requested_at: requestedAt }),
    });
    const requestResult = await response.json();
    if (!response.ok) return toolText(requestResult, true);

    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const snapshotResponse = await relay(env).fetch("https://relay/snapshot");
      if (!snapshotResponse.ok) continue;
      const snapshot = await snapshotResponse.json();
      if (Date.parse(snapshot.sampled_at || "") > Date.parse(requestedAt)) {
        return toolText({ ok: true, measured_now: true, ...snapshotEnvelope(snapshot) });
      }
    }

    const latestResponse = await relay(env).fetch("https://relay/snapshot");
    const latest = latestResponse.ok ? await latestResponse.json() : null;
    return toolText({
      ok: false,
      measured_now: false,
      reason: "fresh_sample_timeout",
      message: "The watch was in live mode but no newer sample arrived before the timeout.",
      latest: snapshotEnvelope(latest),
    }, true);
  }

  return toolText(`Unknown tool: ${name}`, true);
}

async function handleMcp(request, env, pathToken) {
  if (!env.MCP_PATH_TOKEN || pathToken !== env.MCP_PATH_TOKEN) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "MCP endpoint expects POST" }, 405);

  let rpc;
  try {
    rpc = await request.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }

  try {
    if (rpc.method === "initialize") {
      return rpcResult(rpc.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "apple-watch-health", version: "0.1.0" },
        instructions: "Call watch_health_open_session first. Treat freshness=live as real-time. Always disclose age_seconds for recent or stale readings. watch_measure_now can obtain a new sample only while the user's visible Apple Watch live mode is active.",
      });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") return rpcResult(rpc.id, { tools: toolsList() });
    if (rpc.method === "tools/call") {
      return rpcResult(rpc.id, await callTool(env, rpc.params?.name, rpc.params?.arguments || {}));
    }
    return rpcError(rpc.id, -32601, "method not found");
  } catch (error) {
    return rpcError(rpc.id, -32000, error instanceof Error ? error.message : String(error));
  }
}

export class HealthRelay {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const snapshot = await this.state.storage.get("latest_snapshot");
      return snapshot ? json(snapshot) : json({ error: "no data" }, 404);
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      const payload = await request.json();
      const previous = await this.state.storage.get("latest_snapshot");
      const metrics = {
        ...(previous?.metrics || {}),
        ...(payload.metrics || {}),
      };
      const snapshot = {
        ...(previous || {}),
        ...payload,
        metrics,
        sampled_at: latestMetricDate(metrics) || payload.sampled_at || previous?.sampled_at || isoNow(),
        uploaded_at: isoNow(),
      };
      await this.state.storage.put("latest_snapshot", snapshot);
      return json({ ok: true, uploaded_at: snapshot.uploaded_at });
    }

    if (url.pathname === "/snapshot" && request.method === "DELETE") {
      await this.state.storage.deleteAll();
      return json({ ok: true, deleted: true });
    }

    if (url.pathname === "/measure" && request.method === "POST") {
      const body = await request.json();
      const requestedAt = body.requested_at || isoNow();
      const latest = await this.state.storage.get("latest_snapshot");

      if (!latest?.live_mode || ageSeconds(latest.sampled_at || latest.uploaded_at) > RECENT_SECONDS) {
        return json({
          ok: false,
          measured_now: false,
          reason: "live_mode_inactive",
          message: "Apple Watch live mode is not active. Open the Watch app and start G teacher live mode, then try again.",
          latest: snapshotEnvelope(latest),
        }, 409);
      }

      const command = { id: crypto.randomUUID(), type: "measure_heart_rate_now", requested_at: requestedAt };
      await this.state.storage.put("pending_command", command);
      return json({ ok: true, command });
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      const command = await this.state.storage.get("pending_command");
      if (!command) return json({ command: null });
      await this.state.storage.delete("pending_command");
      return json({ command });
    }

    return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcpMatch) return handleMcp(request, env, mcpMatch[1]);

    if (url.pathname === "/upload" && request.method === "POST") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_BYTES) {
        return json({ error: "payload too large" }, 413);
      }
      return relay(env).fetch("https://relay/upload", {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      });
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      return relay(env).fetch("https://relay/poll");
    }

    if (url.pathname === "/data" && request.method === "DELETE") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      return relay(env).fetch("https://relay/snapshot", { method: "DELETE" });
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true, service: "watch-health-mcp", time: isoNow() });
    }

    return json({ error: "not found" }, 404);
  },
};
