# Self-Hosted Backend (No Cloudflare Workers Paid Required)

This directory contains a self-hosted Python alternative to the Cloudflare Worker backend. It accepts Health Auto Export (HAE) webhooks directly, stores data in SQLite, and serves the same MCP tool interface.

## Why This Exists

The Cloudflare Worker backend requires:
- **Cloudflare Workers Paid plan** ($5/month) for Durable Objects
- **Custom iOS/watchOS app** compiled with Xcode + Apple Developer Program ($99/year)

This self-hosted backend requires:
- **$0** — runs on any machine you already have
- **Health Auto Export iOS app** ($3-40, one-time) instead of a custom Swift app
- **Python 3** (stdlib only, no dependencies)

## Architecture

```
iPhone (HAE app) ──HTTPS──→ Your reverse proxy / tunnel ──→ Python server (port 8080)
                                                                   │
                                                               SQLite DB
                                                                   │
MCP Client (ChatGPT, Hermes, etc.) ──HTTP──→ Python server /mcp (MCP JSON-RPC)
```

## Quick Start

### 1. Run the server

```bash
python3 health-mcp-server.py
```

Environment variables (all optional, see defaults in script):

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PORT` | `8787` | Port to listen on |
| `HEALTH_DB_PATH` | `~/.local/share/health-mcp/health.db` | SQLite database path |
| `HEALTH_UPLOAD_TOKEN` | (empty = open) | Bearer token for `/upload` endpoint |
| `HEALTH_MCP_TOKEN` | (empty = `/mcp` only) | Token for remote MCP at `/mcp/<token>` |

Generate tokens:

```bash
export HEALTH_UPLOAD_TOKEN=$(openssl rand -hex 32)
export HEALTH_MCP_TOKEN=$(openssl rand -hex 32)
python3 health-mcp-server.py
```

### 2. Configure Health Auto Export

In the HAE iOS app, create a **REST API Automation**:

1. **URL**: `https://<your-domain>/upload`
2. **HTTP Headers**: `Authorization: Bearer <UPLOAD_TOKEN>`
3. **Export Format**: JSON
4. **Data Type**: Health Metrics
5. Enable **Batch Requests** for large exports

### 3. Connect your MCP client

**Hermes** (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  watch_health:
    url: "http://<your-server-ip>:8080/mcp"
    timeout: 30
```

**Any MCP client** — use the endpoint:

```
http://<your-server-ip>:8080/mcp        # local / trusted network
http://<your-server-ip>:8080/mcp/<token> # remote (token-protected)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `watch_health_open_session` | Connection status, data freshness, latest snapshot |
| `watch_get_latest_health` | All latest metric values (heart rate, steps, sleep, oxygen, etc.) |
| `watch_get_health_history` | Sleep stages (7 days) or 3 most recent samples per metric |
| `watch_measure_now` | Returns latest data (real-time measurement requires custom watchOS app) |

## Supported Metrics

The server maps 80+ Health Auto Export metric names to clean keys:

| HAE Name | Mapped Key |
|----------|------------|
| `heart_rate` | `heart_rate` |
| `heart_rate_resting` | `resting_heart_rate` |
| `heart_rate_variability` | `hrv` |
| `step_count` | `steps` |
| `active_energy` | `active_energy` |
| `oxygen_saturation` | `oxygen_saturation` |
| `respiratory_rate` | `respiratory_rate` |
| `sleep_analysis` | `sleep` (with stage segments) |
| ... | (see full list in `health-mcp-server.py`) |

### Sleep Analysis

HAE sends sleep data as individual stage records with `sleepStage` values (0-4 or string names). The server stores these as segment records:

```json
{
  "stage": "deep",
  "value": 2.5,
  "unit": "hr",
  "started_at": "2026-07-17T03:00:00+10:00"
}
```

Sleep stages are retained for 7 days. All other metrics retain their 3 most recent samples.

## systemd Service

For production deployment, run as a systemd user service:

```ini
# ~/.config/systemd/user/health-mcp.service
[Unit]
Description=Apple Health MCP Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /path/to/health-mcp-server.py
Environment=HEALTH_DB_PATH=%h/.local/share/health-mcp/health.db
Environment=HEALTH_PORT=8080
EnvironmentFile=/path/to/.health-env
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Store tokens securely:

```bash
# /path/to/.health-env (chmod 600)
HEALTH_UPLOAD_TOKEN=<your-token>
HEALTH_MCP_TOKEN=<your-token>
```

Enable:

```bash
systemctl --user daemon-reload
systemctl --user enable --now health-mcp.service
```

## Comparison with Cloudflare Worker

| Feature | Cloudflare Worker | Self-Hosted Python |
|---------|-------------------|-------------------|
| Cost | $5/month (Workers Paid) | $0 |
| iOS app | Custom Swift (Xcode + $99/yr) | Health Auto Export ($3-40) |
| Real-time heart rate | Yes (`watch_measure_now`) | No (periodic snapshots) |
| Dependencies | Node.js, Wrangler | Python 3 (stdlib only) |
| Data storage | Durable Object (ephemeral) | SQLite (persistent) |
| HTTPS | Cloudflare (automatic) | Bring your own (Caddy, Cloudflare Tunnel, etc.) |

## License

MIT — same as the parent project.
