const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const LIVE_FRESH_SECONDS = 15;
const RECENT_SECONDS = 5 * 60;
const MAX_UPLOAD_BYTES = 256 * 1024;
const SLEEP_RETENTION_DAYS = 7;
const DEFAULT_HISTORY_COUNT = 3;
const MAX_SLEEP_RECORDS = 750;

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

function recordTimestamp(record) {
  const timestamp = Date.parse(record?.sampled_at || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function recordSignature(record) {
  return JSON.stringify([
    record?.sampled_at || null,
    record?.started_at || null,
    record?.stage || null,
    record?.source_device || null,
    record?.value ?? null,
    record?.unit || null,
  ]);
}

function retentionFor(metric) {
  return metric === "sleep"
    ? { mode: "duration", days: SLEEP_RETENTION_DAYS, max_records: MAX_SLEEP_RECORDS }
    : { mode: "count", count: DEFAULT_HISTORY_COUNT };
}

function pruneHistory(metric, records, now = Date.now()) {
  const unique = new Map();
  for (const record of records) {
    if (record && typeof record === "object") unique.set(recordSignature(record), record);
  }
  const sorted = [...unique.values()].sort((a, b) => recordTimestamp(b) - recordTimestamp(a));

  if (metric === "sleep") {
    const cutoff = now - SLEEP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    return sorted.filter((record) => recordTimestamp(record) >= cutoff).slice(0, MAX_SLEEP_RECORDS);
  }
  return sorted.slice(0, DEFAULT_HISTORY_COUNT);
}

function historiesForSnapshot(snapshot) {
  const histories = {};
  for (const [metric, records] of Object.entries(snapshot?.history || {})) {
    histories[metric] = Array.isArray(records) ? records : [];
  }
  for (const [metric, record] of Object.entries(snapshot?.metrics || {})) {
    histories[metric] = histories[metric]?.length ? histories[metric] : [record];
  }
  return histories;
}

function mergeHistories(previous, payload) {
  const histories = historiesForSnapshot(previous);

  for (const [metric, records] of Object.entries(payload?.history || {})) {
    if (!Array.isArray(records)) continue;
    histories[metric] = [...(histories[metric] || []), ...records];
  }
  for (const [metric, record] of Object.entries(payload?.metrics || {})) {
    histories[metric] = [...(histories[metric] || []), record];
  }

  return Object.fromEntries(
    Object.entries(histories)
      .map(([metric, records]) => [metric, pruneHistory(metric, records)])
      .filter(([, records]) => records.length)
  );
}

function historySummary(histories) {
  return Object.fromEntries(Object.entries(histories).map(([metric, records]) => [metric, {
    count: records.length,
    newest_sampled_at: records[0]?.sampled_at || null,
    oldest_sampled_at: records.at(-1)?.sampled_at || null,
    retention: retentionFor(metric),
  }]));
}

function recordWithFreshness(record) {
  const age = ageSeconds(record?.sampled_at);
  return { ...record, age_seconds: age, freshness: freshnessForAge(age) };
}

function freshnessForAge(age) {
  if (age === null) return "unknown";
  if (age <= LIVE_FRESH_SECONDS) return "live";
  if (age <= RECENT_SECONDS) return "recent";
  return "stale";
}

// ============================================================
// Health Auto Export (HAE) Adapter
// ============================================================
//
// HAE sends JSON payloads like:
// {
//   "data": {
//     "metrics": [
//       { "name": "heart_rate", "unit": "count/min", "qty": 65, "date": "2024-01-15 10:30:00 +1000" },
//       { "name": "step_count", "unit": "count", "qty": 5234, "date": "2024-01-15 10:30:00 +1000" },
//       ...
//     ]
//   }
// }
//
// HAE metric names -> worker metric keys
const HAE_METRIC_MAP = {
  "step_count": "steps",
  "heart_rate": "heart_rate",
  "heart_rate_resting": "resting_heart_rate",
  "heart_rate_variability": "hrv",
  "heart_rate_walking_average": "walking_heart_rate_average",
  "active_energy": "active_energy",
  "resting_energy": "resting_energy",
  "distance": "distance",
  "oxygen_saturation": "oxygen_saturation",
  "respiratory_rate": "respiratory_rate",
  "environmental_audio_exposure": "environmental_audio_exposure",
  "headphone_audio_exposure": "headphone_audio_exposure",
  "body_temperature": "body_temperature",
  "water_temperature": "water_temperature",
  "underwater_temperature": "underwater_temperature",
  "basal_body_temperature": "basal_body_temperature",
  "wrist_temperature": "wrist_temperature",
  "vo2_max": "vo2_max",
  "walking_speed": "walking_speed",
  "walking_step_length": "walking_step_length",
  "walking_double_support_percentage": "walking_double_support_percentage",
  "walking_asymmetry_percentage": "walking_asymmetry_percentage",
  "stair_ascent_speed": "stair_ascent_speed",
  "stair_descent_speed": "stair_descent_speed",
  "six_minute_walk_test_distance": "six_minute_walk_test_distance",
  "apple_walking_steadiness": "apple_walking_steadiness",
  "apple_exercise_time": "exercise_time",
  "apple_stand_time": "stand_time",
  "apple_move_time": "move_time",
  "cycling_speed": "cycling_speed",
  "cycling_power": "cycling_power",
  "cycling_cadence": "cycling_cadence",
  "cycling_functional_threshold_power": "cycling_ft_power",
  "push_count": "push_count",
  "swimming_stroke_count": "swimming_stroke_count",
  "swimming_distance": "swimming_distance",
  "height": "height",
  "body_mass": "body_mass",
  "body_mass_index": "bmi",
  "lean_body_mass": "lean_body_mass",
  "body_fat_percentage": "body_fat_percentage",
  "waist_circumference": "waist_circumference",
  "insulin_delivery": "insulin_delivery",
  "blood_glucose": "blood_glucose",
  "blood_pressure_systolic": "blood_pressure_systolic",
  "blood_pressure_diastolic": "blood_pressure_diastolic",
  "blood_pressure": "blood_pressure",
  "alcohol_content": "alcohol_content",
  "inhaler_usage": "inhaler_usage",
  "nictotine_cotinine": "nicotine_cotinine",
  "numberOfTimesFallen": "falls",
  "seat_time": "seat_time",
  "downhill_snow_sports_distance": "snow_sports_distance",
  "downhill_snow_sports_speed": "snow_sports_speed",
  "cervical_mucus_quality": "cervical_mucus_quality",
  "intermenstrual_bleeding": "intermenstrual_bleeding",
  "menstrual_flow": "menstrual_flow",
  "ovulation_test_result": "ovulation_test_result",
  "pregnancy_test_result": "pregnancy_test_result",
  "progesterone_test_result": "progesterone_test_result",
  "estrogen_test_result": "estrogen_test_result",
  "sexual_activity": "sexual_activity",
  "contraceptive": "contraceptive",
  "forced_expiratory_volume1": "fev1",
  "forced_vital_capacity": "fvc",
  "peak_expiratory_flow_rate": "peak_flow",
  "uv_index": "uv_index",
  "sleep_analysis": "sleep",
  "water": "water_intake",
  "caffeine": "caffeine",
  "nutrition": "nutrition",
};

// HAE sleep analysis comes as per-stage records:
// { "name": "sleep_analysis", "qty": 1.5, "unit": "hr", "date": "...", "sleepStage": "deep" }
// We convert to worker sleep format: { stage, started_at, sampled_at, value, unit }
const SLEEP_STAGE_MAP = {
  0: "in_bed",
  1: "awake",
  2: "core",
  3: "deep",
  4: "rem",
  "inBed": "in_bed",
  "asleep": "asleep",
  "asleepUnspecified": "asleep",
  "awake": "awake",
  "core": "core",
  "deep": "deep",
  "rem": "rem",
};

function parseHaeDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  // HAE dates: "2024-01-15 10:30:00 +1000" or "2024-01-15 10:30:00.123 +1000"
  // JS Date can parse: "2024-01-15T10:30:00+10:00" (ISO with offset)
  // Convert: replace space with T, convert +1000 to +10:00
  let s = dateStr.trim();
  // Replace first space (between date and time) with T
  s = s.replace(/^(\d{4}-\d{2}-\d{2})\s/, "$1T");
  // Convert timezone offset +1000 -> +10:00
  s = s.replace(/([+-])(\d{2})(\d{2})$/, "$1$2:$3");
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function isHaePayload(body) {
  return body && typeof body === "object" && body.data && body.data.metrics && Array.isArray(body.data.metrics);
}

function transformHaeToWorker(body) {
  const metrics = {};
  const history = {};
  const haeMetrics = body.data.metrics;

  for (const m of haeMetrics) {
    if (!m || !m.name || m.qty === undefined || m.qty === null) continue;

    const mappedKey = HAE_METRIC_MAP[m.name] || m.name;
    const sampledAt = parseHaeDate(m.date) || isoNow();

    if (mappedKey === "sleep") {
      // Sleep analysis needs special handling - collect as stage segments
      const stage = SLEEP_STAGE_MAP[m.sleepStage] || SLEEP_STAGE_MAP[String(m.sleepStage)] || "unknown";
      if (!history.sleep) history.sleep = [];
      history.sleep.push({
        stage,
        started_at: sampledAt,
        sampled_at: sampledAt,
        value: m.qty,
        unit: m.unit || "hr",
      });
    } else if (mappedKey === "blood_pressure" && m.systolic !== undefined) {
      // Some HAE versions send blood pressure as compound object
      metrics.blood_pressure_systolic = {
        value: m.systolic,
        unit: m.unit || "mmHg",
        sampled_at: sampledAt,
      };
      metrics.blood_pressure_diastolic = {
        value: m.diastolic,
        unit: m.unit || "mmHg",
        sampled_at: sampledAt,
      };
    } else {
      // Standard metric
      const record = {
        value: m.qty,
        unit: m.unit || "",
        sampled_at: sampledAt,
      };
      metrics[mappedKey] = record;
      // Also add to history
      if (!history[mappedKey]) history[mappedKey] = [];
      history[mappedKey].push(record);
    }
  }

  const allDates = [
    ...Object.values(metrics).map((r) => r.sampled_at),
    ...(history.sleep || []).map((r) => r.sampled_at),
  ].filter(Boolean);
  const sampledAt = allDates.length
    ? new Date(Math.max(...allDates.map((d) => Date.parse(d)))).toISOString()
    : isoNow();

  return {
    metrics,
    history,
    sampled_at: sampledAt,
    uploaded_at: isoNow(),
    source: "health_auto_export",
  };
}

// End HAE adapter
// ============================================================

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
      description: "Read the latest value for every health metric plus history counts and retention policies. Use watch_get_health_history for sleep stages or recent samples.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Read latest Apple Watch health data",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "watch_get_health_history",
      description: "Read retained health history. Sleep includes all stage segments from the last 7 days; other metrics include their 3 most recent samples.",
      inputSchema: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            description: "Optional metric key such as sleep, heart_rate, oxygen_saturation, or environmental_audio_exposure. Omit to return all retained history.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Read retained Apple Watch health history",
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
  const histories = historiesForSnapshot(snapshot);
  const metrics = Object.fromEntries(Object.entries(snapshot.metrics || {}).map(([key, metric]) => [key, recordWithFreshness(metric)]));

  return {
    ...snapshot,
    connected: age !== null && age <= RECENT_SECONDS,
    live_mode: liveMode,
    freshness,
    age_seconds: age,
    metrics,
    history_summary: historySummary(histories),
    retention_policy: {
      sleep: retentionFor("sleep"),
      all_other_metrics: retentionFor("heart_rate"),
    },
  };
}

function historyEnvelope(snapshot, requestedMetric) {
  if (!snapshot) return { connected: false, message: "No Apple Watch health data has been uploaded yet." };

  const histories = historiesForSnapshot(snapshot);
  const selected = requestedMetric
    ? { [requestedMetric]: histories[requestedMetric] || [] }
    : histories;
  const history = Object.fromEntries(
    Object.entries(selected).map(([metric, records]) => [metric, records.map(recordWithFreshness)])
  );

  return {
    generated_at: isoNow(),
    requested_metric: requestedMetric || null,
    retention_policy: {
      sleep: retentionFor("sleep"),
      all_other_metrics: retentionFor("heart_rate"),
    },
    history,
    history_summary: historySummary(selected),
  };
}

async function callTool(env, name, args) {
  if (name === "watch_health_open_session" || name === "watch_get_latest_health") {
    const response = await relay(env).fetch("https://relay/snapshot");
    const snapshot = response.status === 404 ? null : await response.json();
    return toolText(snapshotEnvelope(snapshot));
  }

  if (name === "watch_get_health_history") {
    const response = await relay(env).fetch("https://relay/snapshot");
    const snapshot = response.status === 404 ? null : await response.json();
    return toolText(historyEnvelope(snapshot, typeof args?.metric === "string" ? args.metric : null));
  }

  if (name === "watch_measure_now") {
    // Live mode not supported with HAE (no custom watch app running)
    // Return latest data with a clear message
    const response = await relay(env).fetch("https://relay/snapshot");
    const snapshot = response.status === 404 ? null : await response.json();
    return toolText({
      ok: false,
      measured_now: false,
      reason: "live_mode_not_supported",
      message: "Real-time heart rate measurement requires the custom watchOS app. Data is updated periodically by Health Auto Export instead.",
      latest: snapshotEnvelope(snapshot),
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
        serverInfo: { name: "apple-watch-health", version: "0.3.0-hae" },
        instructions: "Call watch_health_open_session first. Data is pushed periodically from Health Auto Export on iPhone. Use watch_get_latest_health for current metrics. Use watch_get_health_history for sleep stages (7 days) and recent samples (3 per metric). watch_measure_now is not supported in HAE mode.",
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
      const history = mergeHistories(previous, payload);
      const metrics = Object.fromEntries(
        Object.entries(history).filter(([, records]) => records.length).map(([metric, records]) => [metric, records[0]])
      );
      const snapshot = {
        ...(previous || {}),
        ...payload,
        metrics,
        history,
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
          message: "Apple Watch live mode is not active. Live mode requires the custom watchOS app (not available with Health Auto Export).",
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

    // MCP endpoint
    const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcpMatch) return handleMcp(request, env, mcpMatch[1]);

    // Upload endpoint - accepts both original format and HAE format
    if (url.pathname === "/upload" && request.method === "POST") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_BYTES) {
        return json({ error: "payload too large" }, 413);
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }

      // Detect and transform HAE format
      if (isHaePayload(parsed)) {
        const transformed = transformHaeToWorker(parsed);
        return relay(env).fetch("https://relay/upload", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(transformed),
        });
      }

      // Original format - pass through
      return relay(env).fetch("https://relay/upload", {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      });
    }

    // Bulk metrics endpoint - accepts multiple HAE batches
    if (url.pathname === "/upload/batch" && request.method === "POST") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_BYTES) {
        return json({ error: "payload too large" }, 413);
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }

      // Handle array of HAE payloads
      const payloads = Array.isArray(parsed) ? parsed : [parsed];
      const results = [];

      for (const payload of payloads) {
        if (isHaePayload(payload)) {
          const transformed = transformHaeToWorker(payload);
          const response = await relay(env).fetch("https://relay/upload", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify(transformed),
          });
          results.push(await response.json());
        } else {
          results.push({ ok: false, error: "not_hae_format" });
        }
      }

      return json({ results });
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      return relay(env).fetch("https://relay/poll");
    }

    if (url.pathname === "/data" && request.method === "DELETE") {
      if (!bearerMatches(request, env.UPLOAD_TOKEN)) return json({ error: "unauthorized" }, 401);
      return relay(env).fetch("https://relay/snapshot", { method: "DELETE" });
    }

    // Health check
    if (url.pathname === "/healthz") {
      return json({ ok: true, service: "watch-health-mcp", version: "0.3.0-hae", time: isoNow() });
    }

    return json({ error: "not found" }, 404);
  },
};
