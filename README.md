# phonelinkmcp

Cloudflare Worker that links Rory to Zami's phone (the "Phone Link" Android app).

- `GET /device?key=<DEVICE_KEY>` - the phone app connects here over WebSocket. This is the only channel to the phone; no ADB is involved.
- `POST /?bearer_token=<MCP_TOKEN>` - MCP server Rory uses. One tool per phone action; each relays a command down the live socket and waits for the phone's reply.

State is held in a single Durable Object (`DeviceHub`) that owns the phone socket and correlates requests to replies.

## Secrets
- `DEVICE_KEY` - shared secret the phone app presents.
- `MCP_TOKEN` - bearer token Rory's custom connector presents.

## Tools (Phase 1)
phone_status, ring_phone, stop_ring, flashlight, vibrate, set_volume, media_control,
set_alarm, set_timer, open_app, open_url, speak, show_popup, ask_on_phone.
