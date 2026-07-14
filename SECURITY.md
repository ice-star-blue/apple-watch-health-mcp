# Security

## Secret handling

- Never commit `RelayConfig.plist`, `.dev.vars`, `.private-endpoint`, API tokens, health exports, provisioning profiles, or screenshots containing personal health data.
- Generate different high-entropy values for `UPLOAD_TOKEN` and `MCP_PATH_TOKEN`.
- Treat the complete MCP URL as a password because the path token grants read access.
- Rotate both tokens immediately if a URL, app build, terminal log, or screenshot is exposed.
- Use a dedicated Cloudflare Worker for each person. This demo is not designed for multiple users or clinical use.

## Reporting

Please avoid putting real health data or working credentials in a public issue. Describe the affected component and a minimal reproduction with synthetic values.

## Known design boundary

The upload token is packaged with the client App and can be recovered by someone who controls the installed binary. Production systems should use per-device authentication, token rotation, rate limiting, audit logging, and encrypted storage with a documented retention policy.
