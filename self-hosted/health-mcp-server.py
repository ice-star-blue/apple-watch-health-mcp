#!/usr/bin/env python3
"""
Apple Health MCP Server — Self-hosted
Receives Health Auto Export webhooks, stores in SQLite, serves MCP over HTTP.

Architecture:
  iPhone (HAE app) → HTTPS via Cloudflare Tunnel → this server (port 8787)
  Hermes MCP client → http://localhost:8787/mcp (zero latency)

Run: python3 health-mcp-server.py
"""

import json
import sqlite3
import os
import secrets
import time
import hashlib
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# ============================================================
# Config
# ============================================================

DB_PATH = os.environ.get("HEALTH_DB_PATH", os.path.expanduser("~/.local/share/health-mcp/health.db"))
UPLOAD_TOKEN = os.environ.get("HEALTH_UPLOAD_TOKEN", "")
MCP_TOKEN = os.environ.get("HEALTH_MCP_TOKEN", "")
PORT = int(os.environ.get("HEALTH_PORT", "8787"))

LIVE_FRESH_SECONDS = 15
RECENT_SECONDS = 5 * 60
SLEEP_RETENTION_DAYS = 7
DEFAULT_HISTORY_COUNT = 3
MAX_SLEEP_RECORDS = 750
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MCP_PROTOCOL_VERSION = "2025-06-18"

# ============================================================
# HAE Metric Mapping
# ============================================================

HAE_METRIC_MAP = {
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
    "vo2_max": "vo2_max",
    "walking_speed": "walking_speed",
    "walking_step_length": "walking_step_length",
    "walking_double_support_percentage": "walking_double_support_percentage",
    "walking_asymmetry_percentage": "walking_asymmetry_percentage",
    "apple_walking_steadiness": "apple_walking_steadiness",
    "apple_exercise_time": "exercise_time",
    "apple_stand_time": "stand_time",
    "apple_move_time": "move_time",
    "cycling_speed": "cycling_speed",
    "cycling_power": "cycling_power",
    "cycling_cadence": "cycling_cadence",
    "height": "height",
    "body_mass": "body_mass",
    "body_mass_index": "bmi",
    "lean_body_mass": "lean_body_mass",
    "body_fat_percentage": "body_fat_percentage",
    "waist_circumference": "waist_circumference",
    "blood_glucose": "blood_glucose",
    "blood_pressure_systolic": "blood_pressure_systolic",
    "blood_pressure_diastolic": "blood_pressure_diastolic",
    "blood_pressure": "blood_pressure",
    "sleep_analysis": "sleep",
    "water": "water_intake",
    "caffeine": "caffeine",
}

SLEEP_STAGE_MAP = {
    0: "in_bed", 1: "awake", 2: "core", 3: "deep", 4: "rem",
    "inBed": "in_bed", "asleep": "asleep", "awake": "awake",
    "core": "core", "deep": "deep", "rem": "rem",
}

# ============================================================
# Database
# ============================================================

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            metric_key TEXT NOT NULL,
            value REAL,
            unit TEXT,
            sampled_at TEXT NOT NULL,
            source TEXT DEFAULT 'health_auto_export',
            PRIMARY KEY (metric_key, sampled_at)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sleep_segments (
            stage TEXT NOT NULL,
            value REAL,
            unit TEXT,
            started_at TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            source TEXT DEFAULT 'health_auto_export',
            PRIMARY KEY (stage, started_at)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_metrics_key_time ON metrics(metric_key, sampled_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sleep_time ON sleep_segments(sampled_at DESC)")
    conn.commit()
    conn.close()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ============================================================
# Date Parsing (HAE format → ISO 8601)
# ============================================================

def parse_hae_date(date_str):
    """Parse HAE date format: '2024-01-15 10:30:00 +1000' → ISO 8601"""
    if not date_str or not isinstance(date_str, str):
        return None
    s = date_str.strip()
    # Replace space between date and time with T
    s = s.replace(" ", "T", 1) if " " in s else s
    # Convert +1000 → +10:00
    if len(s) >= 5 and s[-5] in "+-" and s[-4:].isdigit():
        s = s[:-2] + ":" + s[-2:]
    try:
        dt = datetime.fromisoformat(s)
        return dt.isoformat()
    except (ValueError, TypeError):
        return None

def iso_now():
    return datetime.now(timezone.utc).isoformat()

def age_seconds(iso_date):
    if not iso_date:
        return None
    try:
        dt = datetime.fromisoformat(iso_date.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))
    except (ValueError, TypeError):
        return None

def freshness_for_age(age):
    if age is None:
        return "unknown"
    if age <= LIVE_FRESH_SECONDS:
        return "live"
    if age <= RECENT_SECONDS:
        return "recent"
    return "stale"

# ============================================================
# HAE Payload Transform
# ============================================================

def is_hae_payload(body):
    return isinstance(body, dict) and "data" in body and "metrics" in body.get("data", {}) and isinstance(body["data"]["metrics"], list)

def transform_hae(body):
    """Transform HAE payload to (metrics_dict, sleep_list).

    Handles both formats:
    - Flat: [{name, qty, unit, date}] (older/test format)
    - Nested v2: [{name, units, data: [{date, qty, source}]}] (real HAE export)
    """
    metrics = {}
    sleep_segments = []

    for m in body["data"]["metrics"]:
        if not m or "name" not in m:
            continue

        mapped_key = HAE_METRIC_MAP.get(m["name"], m["name"])
        unit = m.get("units") or m.get("unit") or ""

        # Nested v2 format: metric has a "data" array of samples
        if "data" in m and isinstance(m["data"], list):
            samples = m["data"]
            if not samples:
                continue

            if mapped_key == "sleep":
                # Store all sleep segments
                for s in samples:
                    if s.get("qty") is None:
                        continue
                    sampled_at = parse_hae_date(s.get("date")) or iso_now()
                    stage = SLEEP_STAGE_MAP.get(s.get("sleepStage"), SLEEP_STAGE_MAP.get(str(s.get("sleepStage")), "unknown"))
                    sleep_segments.append({
                        "stage": stage,
                        "value": s["qty"],
                        "unit": unit or "hr",
                        "started_at": sampled_at,
                        "sampled_at": sampled_at,
                    })
            elif mapped_key == "blood_pressure":
                # Take most recent sample
                latest = max(samples, key=lambda s: s.get("date", ""))
                if latest.get("qty") is not None:
                    sampled_at = parse_hae_date(latest.get("date")) or iso_now()
                    bp_val = str(latest["qty"])
                    if "/" in bp_val:
                        sys_val, dia_val = bp_val.split("/", 1)
                        metrics["blood_pressure_systolic"] = {"value": float(sys_val), "unit": "mmHg", "sampled_at": sampled_at}
                        metrics["blood_pressure_diastolic"] = {"value": float(dia_val), "unit": "mmHg", "sampled_at": sampled_at}
            else:
                # Take most recent sample for this metric
                latest = max(samples, key=lambda s: s.get("date", ""))
                if latest.get("qty") is None:
                    continue
                sampled_at = parse_hae_date(latest.get("date")) or iso_now()
                metrics[mapped_key] = {
                    "value": latest["qty"],
                    "unit": unit,
                    "sampled_at": sampled_at,
                }

        # Flat format (qty directly on metric)
        elif m.get("qty") is not None:
            sampled_at = parse_hae_date(m.get("date")) or iso_now()

            if mapped_key == "sleep":
                stage = SLEEP_STAGE_MAP.get(m.get("sleepStage"), SLEEP_STAGE_MAP.get(str(m.get("sleepStage")), "unknown"))
                sleep_segments.append({
                    "stage": stage,
                    "value": m["qty"],
                    "unit": unit or "hr",
                    "started_at": sampled_at,
                    "sampled_at": sampled_at,
                })
            elif mapped_key == "blood_pressure" and "systolic" in m:
                metrics["blood_pressure_systolic"] = {"value": m["systolic"], "unit": "mmHg", "sampled_at": sampled_at}
                metrics["blood_pressure_diastolic"] = {"value": m["diastolic"], "unit": "mmHg", "sampled_at": sampled_at}
            else:
                metrics[mapped_key] = {
                    "value": m["qty"],
                    "unit": unit,
                    "sampled_at": sampled_at,
                }

    return metrics, sleep_segments

def store_metrics(metrics, sleep_segments):
    conn = get_db()
    now = iso_now()
    
    for key, rec in metrics.items():
        conn.execute(
            "INSERT OR REPLACE INTO metrics (metric_key, value, unit, sampled_at, source) VALUES (?, ?, ?, ?, ?)",
            (key, rec["value"], rec["unit"], rec["sampled_at"], "health_auto_export")
        )
    
    for seg in sleep_segments:
        conn.execute(
            "INSERT OR REPLACE INTO sleep_segments (stage, value, unit, started_at, sampled_at, source) VALUES (?, ?, ?, ?, ?, ?)",
            (seg["stage"], seg["value"], seg["unit"], seg["started_at"], seg["sampled_at"], "health_auto_export")
        )
    
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", ("last_upload", now))
    conn.commit()
    conn.close()

# ============================================================
# Data Retrieval
# ============================================================

def get_latest_metrics():
    conn = get_db()
    rows = conn.execute("""
        SELECT m.* FROM metrics m
        INNER JOIN (
            SELECT metric_key, MAX(sampled_at) as max_time
            FROM metrics GROUP BY metric_key
        ) latest ON m.metric_key = latest.metric_key AND m.sampled_at = latest.max_time
    """).fetchall()
    conn.close()
    
    result = {}
    for row in rows:
        age = age_seconds(row["sampled_at"])
        result[row["metric_key"]] = {
            "value": row["value"],
            "unit": row["unit"],
            "sampled_at": row["sampled_at"],
            "age_seconds": age,
            "freshness": freshness_for_age(age),
        }
    return result

def get_history(metric=None):
    conn = get_db()
    
    result = {}
    
    if metric is None or metric == "sleep":
        cutoff = datetime.now(timezone.utc) - timedelta(days=SLEEP_RETENTION_DAYS)
        sleep_rows = conn.execute(
            "SELECT * FROM sleep_segments WHERE sampled_at >= ? ORDER BY sampled_at DESC LIMIT ?",
            (cutoff.isoformat(), MAX_SLEEP_RECORDS)
        ).fetchall()
        if sleep_rows:
            result["sleep"] = [{
                "stage": r["stage"],
                "value": r["value"],
                "unit": r["unit"],
                "started_at": r["started_at"],
                "sampled_at": r["sampled_at"],
                "age_seconds": age_seconds(r["sampled_at"]),
                "freshness": freshness_for_age(age_seconds(r["sampled_at"])),
            } for r in sleep_rows]
    
    if metric is None or metric != "sleep":
        if metric:
            keys = [metric]
        else:
            keys = [r["metric_key"] for r in conn.execute("SELECT DISTINCT metric_key FROM metrics").fetchall()]
        
        for key in keys:
            rows = conn.execute(
                "SELECT * FROM metrics WHERE metric_key = ? ORDER BY sampled_at DESC LIMIT ?",
                (key, DEFAULT_HISTORY_COUNT)
            ).fetchall()
            if rows:
                result[key] = [{
                    "value": r["value"],
                    "unit": r["unit"],
                    "sampled_at": r["sampled_at"],
                    "age_seconds": age_seconds(r["sampled_at"]),
                    "freshness": freshness_for_age(age_seconds(r["sampled_at"])),
                } for r in rows]
    
    conn.close()
    return result

def get_last_upload():
    conn = get_db()
    row = conn.execute("SELECT value FROM meta WHERE key = 'last_upload'").fetchone()
    conn.close()
    return row["value"] if row else None

def get_snapshot():
    metrics = get_latest_metrics()
    if not metrics:
        return None
    
    all_dates = [r["sampled_at"] for r in metrics.values()]
    latest_sample = max(all_dates) if all_dates else None
    age = age_seconds(latest_sample or get_last_upload())
    
    return {
        "connected": age is not None and age <= RECENT_SECONDS,
        "live_mode": False,
        "freshness": freshness_for_age(age),
        "age_seconds": age,
        "sampled_at": latest_sample,
        "uploaded_at": get_last_upload(),
        "source": "health_auto_export",
        "metrics": metrics,
        "retention_policy": {
            "sleep": {"mode": "duration", "days": SLEEP_RETENTION_DAYS},
            "all_other_metrics": {"mode": "count", "count": DEFAULT_HISTORY_COUNT},
        },
    }

# ============================================================
# MCP Protocol
# ============================================================

MCP_TOOLS = [
    {
        "name": "watch_health_open_session",
        "description": "Start here. Check Apple Watch connection, data freshness, and the latest health snapshot.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "watch_get_latest_health",
        "description": "Read the latest value for every health metric (heart rate, steps, sleep, oxygen, etc).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "watch_get_health_history",
        "description": "Read retained health history. Sleep includes all stage segments from the last 7 days; other metrics include their 3 most recent samples.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "metric": {
                    "type": "string",
                    "description": "Optional: heart_rate, steps, sleep, oxygen_saturation, etc. Omit for all metrics.",
                }
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "watch_measure_now",
        "description": "Check for a fresh heart rate reading. Returns latest data with a note that real-time measurement requires the custom watchOS app.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]

def handle_mcp_call(name, args):
    if name in ("watch_health_open_session", "watch_get_latest_health"):
        snapshot = get_snapshot()
        if not snapshot:
            return {"connected": False, "freshness": "no_data", "message": "No health data uploaded yet."}
        return snapshot
    
    if name == "watch_get_health_history":
        metric = args.get("metric") if isinstance(args, dict) else None
        history = get_history(metric)
        return {
            "generated_at": iso_now(),
            "requested_metric": metric,
            "history": history,
        }
    
    if name == "watch_measure_now":
        snapshot = get_snapshot()
        return {
            "ok": False,
            "measured_now": False,
            "reason": "live_mode_not_supported",
            "message": "Real-time heart rate requires the custom watchOS app. Data is updated periodically by Health Auto Export.",
            "latest": snapshot,
        }
    
    return {"error": f"Unknown tool: {name}"}

# ============================================================
# HTTP Server
# ============================================================

class HealthMCPHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        import sys, os
        if os.environ.get("HEALTH_DEBUG"):
            sys.stderr.write("[%s] %s\n" % (iso_now(), format % args))
    
    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    
    def _bearer_ok(self, expected):
        if not expected:
            return True
        # Accept either Authorization: Bearer <token> or X-API-KEY: <token>
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {expected}":
            return True
        api_key = self.headers.get("X-API-KEY", "")
        return api_key == expected
    
    def do_GET(self):
        path = urlparse(self.path).path
        
        if path == "/healthz":
            self._send_json({"ok": True, "service": "health-mcp", "version": "1.0.0", "time": iso_now()})
            return
        
        if path == "/snapshot":
            snapshot = get_snapshot()
            if not snapshot:
                self._send_json({"connected": False, "message": "No data yet"}, 404)
            else:
                self._send_json(snapshot)
            return
        
        self._send_json({"error": "not found"}, 404)
    
    def do_POST(self):
        path = urlparse(self.path).path
        content_length = int(self.headers.get("Content-Length", 0))
        
        if content_length > MAX_UPLOAD_BYTES:
            self._send_json({"error": "payload too large"}, 413)
            return
        
        raw_body = self.rfile.read(content_length) if content_length else b""

        
        try:
            body = json.loads(raw_body) if raw_body else {}
        except json.JSONDecodeError:
            self._send_json({"error": "invalid JSON"}, 400)
            return
        
        # === HAE Upload Endpoint (also accepts /api/health-export) ===
        if path in ("/upload", "/api/health-export"):
            if not self._bearer_ok(UPLOAD_TOKEN):
                self._send_json({"error": "unauthorized"}, 401)
                return
            
            if is_hae_payload(body):
                metrics, sleep_segments = transform_hae(body)
                store_metrics(metrics, sleep_segments)
                metric_count = len(metrics) + len(sleep_segments)
                print(f"[{iso_now()}] Upload: {metric_count} metrics stored")
                self._send_json({"ok": True, "metrics_stored": metric_count, "uploaded_at": iso_now()})
            else:
                self._send_json({"error": "not HAE format — expected {data: {metrics: [...]}}"}, 400)
            return
        
        # === MCP Endpoint ===
        # Path: /mcp/<token>
        if path.startswith("/mcp/"):
            token = path.split("/mcp/", 1)[1]
            if MCP_TOKEN and token != MCP_TOKEN:
                self._send_json({"error": "not found"}, 404)
                return
            
            rpc = body
            rpc_id = rpc.get("id")
            method = rpc.get("method")
            
            if method == "initialize":
                self._send_json({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "apple-watch-health", "version": "1.0.0-selfhosted"},
                        "instructions": "Health data from Apple Watch via Health Auto Export. Call watch_health_open_session first. Use watch_get_latest_health for current metrics. Use watch_get_health_history for trends.",
                    },
                })
                return
            
            if method == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            
            if method == "tools/list":
                self._send_json({"jsonrpc": "2.0", "id": rpc_id, "result": {"tools": MCP_TOOLS}})
                return
            
            if method == "tools/call":
                tool_name = rpc.get("params", {}).get("name", "")
                tool_args = rpc.get("params", {}).get("arguments", {})
                result = handle_mcp_call(tool_name, tool_args)
                text = json.dumps(result, indent=2) if not isinstance(result, str) else result
                self._send_json({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {"content": [{"type": "text", "text": text}]},
                })
                return
            
            self._send_json({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": {"code": -32601, "message": "method not found"},
            })
            return
        
        # === MCP Endpoint (no token, for localhost) ===
        if path == "/mcp":
            rpc = body
            rpc_id = rpc.get("id")
            method = rpc.get("method")
            
            if method == "initialize":
                self._send_json({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "apple-watch-health", "version": "1.0.0-selfhosted"},
                        "instructions": "Health data from Apple Watch via Health Auto Export.",
                    },
                })
                return
            
            if method == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            
            if method == "tools/list":
                self._send_json({"jsonrpc": "2.0", "id": rpc_id, "result": {"tools": MCP_TOOLS}})
                return
            
            if method == "tools/call":
                tool_name = rpc.get("params", {}).get("name", "")
                tool_args = rpc.get("params", {}).get("arguments", {})
                result = handle_mcp_call(tool_name, tool_args)
                text = json.dumps(result, indent=2) if not isinstance(result, str) else result
                self._send_json({
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {"content": [{"type": "text", "text": text}]},
                })
                return
            
            self._send_json({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "error": {"code": -32601, "message": "method not found"},
            })
            return
        
        self._send_json({"error": "not found"}, 404)
    
    def do_DELETE(self):
        path = urlparse(self.path).path
        
        if path == "/data":
            if not self._bearer_ok(UPLOAD_TOKEN):
                self._send_json({"error": "unauthorized"}, 401)
                return
            conn = get_db()
            conn.execute("DELETE FROM metrics")
            conn.execute("DELETE FROM sleep_segments")
            conn.execute("DELETE FROM meta")
            conn.commit()
            conn.close()
            self._send_json({"ok": True, "deleted": True})
            return
        
        self._send_json({"error": "not found"}, 404)


def main():
    init_db()
    
    if not UPLOAD_TOKEN:
        print("WARNING: HEALTH_UPLOAD_TOKEN not set — /upload endpoint is open!")
    if not MCP_TOKEN:
        print("INFO: HEALTH_MCP_TOKEN not set — /mcp endpoint uses /mcp (no token, localhost only)")
    
    server = HTTPServer(("0.0.0.0", PORT), HealthMCPHandler)
    print(f"Health MCP Server v1.0.0 starting on http://127.0.0.1:{PORT}")
    print(f"  DB: {DB_PATH}")
    print(f"  Upload: POST /upload (Bearer token auth)")
    print(f"  MCP:    POST /mcp (localhost) or /mcp/<token> (remote)")
    print(f"  Health: GET  /healthz")
    print()
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
