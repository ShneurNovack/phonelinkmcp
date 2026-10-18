// Phone Link MCP Worker
// - /device        : the phone's app connects here over WebSocket (the only channel to the phone)
// - / (bearer_token): MCP server Rory talks to; each tool relays a command to the phone and waits
//
// Auth: phone uses ?key=<DEVICE_KEY>, Rory uses ?bearer_token=<MCP_TOKEN>.

const PROTOCOL_VERSION = "2024-11-05";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- phone websocket ----
    if (url.pathname === "/device") {
      const key = url.searchParams.get("key") || "";
      if (!env.DEVICE_KEY || key !== env.DEVICE_KEY) {
        return new Response("unauthorized", { status: 401 });
      }
      const id = env.HUB.idFromName("singleton");
      return env.HUB.get(id).fetch(request);
    }

    // ---- MCP endpoint ----
    const token = url.searchParams.get("bearer_token") ||
      (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const authed = env.MCP_TOKEN && token === env.MCP_TOKEN;

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "phonelinkmcp",
        status: "ok",
        device_online: authed ? await hubOnline(env) : undefined,
        note: "POST JSON-RPC with ?bearer_token= to use the MCP server."
      });
    }

    if (request.method === "POST") {
      if (!authed) return jsonRpcError(null, -32001, "unauthorized");
      let body;
      try { body = await request.json(); } catch { return jsonRpcError(null, -32700, "parse error"); }
      return handleRpc(body, env);
    }

    return new Response("not found", { status: 404 });
  }
};

async function hubOnline(env) {
  const id = env.HUB.idFromName("singleton");
  const r = await env.HUB.get(id).fetch("https://hub/online");
  return (await r.json()).online;
}

// ---------- MCP JSON-RPC ----------

async function handleRpc(body, env) {
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) { const r = await dispatch(m, env); if (r) out.push(r); }
    return json(out);
  }
  const r = await dispatch(body, env);
  return r ? json(r) : new Response(null, { status: 204 });
}

async function dispatch(msg, env) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "phonelinkmcp", version: "1.0.0" }
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null; // notification, no response
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args, env);
      return ok(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true });
    }
  }
  return jsonRpcErrorObj(id, -32601, "method not found: " + method);
}

// ---------- tool definitions ----------

const TOOLS = [
  { name: "phone_status", description: "Read the phone's current state: battery and charging, storage, network type, screen on/off, ringer mode, Do Not Disturb, and volume levels.", inputSchema: { type: "object", properties: {} } },
  { name: "ring_phone", description: "Ring the phone loudly to find it, even if it is on silent. Rings for a few seconds and vibrates.", inputSchema: { type: "object", properties: { seconds: { type: "integer", description: "How long to ring, 1-120. Default 15." } } } },
  { name: "stop_ring", description: "Stop a ring started by ring_phone.", inputSchema: { type: "object", properties: {} } },
  { name: "flashlight", description: "Turn the phone's flashlight (torch) on or off.", inputSchema: { type: "object", properties: { on: { type: "boolean", description: "true = on, false = off" } }, required: ["on"] } },
  { name: "vibrate", description: "Vibrate the phone once.", inputSchema: { type: "object", properties: { ms: { type: "integer", description: "Duration in milliseconds, 100-5000. Default 800." } } } },
  { name: "set_volume", description: "Set a volume stream on the phone to a 0-100 level.", inputSchema: { type: "object", properties: { stream: { type: "string", enum: ["media", "ring", "alarm", "call", "notification"], description: "Which volume to set. Default media." }, level: { type: "integer", description: "0-100" } }, required: ["level"] } },
  { name: "media_control", description: "Send a media transport key to the phone: play/pause, next, previous, or stop. Best-effort for whatever app is playing.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["toggle", "play", "pause", "next", "prev", "stop"] } }, required: ["action"] } },
  { name: "set_alarm", description: "Set a real alarm in the phone's Clock app.", inputSchema: { type: "object", properties: { hour: { type: "integer", description: "0-23" }, minute: { type: "integer", description: "0-59" }, label: { type: "string" } }, required: ["hour", "minute"] } },
  { name: "set_timer", description: "Start a countdown timer in the phone's Clock app.", inputSchema: { type: "object", properties: { seconds: { type: "integer", description: "1-86400" }, label: { type: "string" } }, required: ["seconds"] } },
  { name: "open_app", description: "Open an app on the phone by its package name.", inputSchema: { type: "object", properties: { package: { type: "string", description: "e.g. com.google.android.apps.maps" } }, required: ["package"] } },
  { name: "open_url", description: "Open a link or deep link on the phone.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "speak", description: "Make the phone speak text out loud via text-to-speech.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "show_popup", description: "Show a full-screen message on the phone (appears even over the lock screen). Dismissed with an OK button.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "ask_on_phone", description: "Show a question on the phone with answer buttons and WAIT for the owner to tap one. Returns the chosen value. Use this for confirm-before-acting prompts.", inputSchema: { type: "object", properties: { message: { type: "string" }, buttons: { type: "array", description: "Button labels, e.g. [\"Yes\",\"No\"]. Defaults to Yes/No.", items: { type: "string" } }, timeout_seconds: { type: "integer", description: "How long to wait for a tap, default 120." } }, required: ["message"] } }
];

// ---------- tool execution ----------

async function callTool(name, args, env) {
  if (name === "ask_on_phone") {
    const buttons = (args.buttons && args.buttons.length ? args.buttons : ["Yes", "No"])
      .map(l => ({ label: String(l), value: String(l) }));
    return hubAsk(env, String(args.message || ""), buttons, (args.timeout_seconds || 120) * 1000);
  }

  const map = {
    phone_status: ["get_state", {}],
    ring_phone: ["ring_phone", { seconds: args.seconds }],
    stop_ring: ["stop_ring", {}],
    flashlight: ["flashlight", { on: !!args.on }],
    vibrate: ["vibrate", { ms: args.ms }],
    set_volume: ["set_volume", { stream: args.stream || "media", level: args.level }],
    media_control: ["media_control", { action: args.action }],
    set_alarm: ["set_alarm", { hour: args.hour, minute: args.minute, label: args.label }],
    set_timer: ["set_timer", { seconds: args.seconds, label: args.label }],
    open_app: ["open_app", { package: args.package }],
    open_url: ["open_url", { url: args.url }],
    speak: ["speak", { text: args.text }],
    show_popup: ["show_popup", { message: args.message }]
  };
  const entry = map[name];
  if (!entry) throw new Error("unknown tool: " + name);
  const [cmd, params] = entry;
  return hubCmd(env, cmd, clean(params), 20000);
}

function clean(o) {
  const out = {};
  for (const k in o) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

async function hubCmd(env, cmd, params, timeoutMs) {
  const id = env.HUB.idFromName("singleton");
  const r = await env.HUB.get(id).fetch("https://hub/cmd", {
    method: "POST",
    body: JSON.stringify({ cmd, params, timeoutMs })
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "phone error");
  return data.result;
}

async function hubAsk(env, message, buttons, timeoutMs) {
  const id = env.HUB.idFromName("singleton");
  const r = await env.HUB.get(id).fetch("https://hub/ask", {
    method: "POST",
    body: JSON.stringify({ message, buttons, timeoutMs })
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "phone error");
  return { answer: data.value };
}

// ---------- helpers ----------

function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcErrorObj(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function jsonRpcError(id, code, message) { return json(jsonRpcErrorObj(id, code, message)); }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// ======================================================================
// Durable Object: holds the one phone connection and relays commands.
// ======================================================================

export class DeviceHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.socket = null;
    this.deviceName = null;
    this.pending = new Map();   // command id -> {resolve, reject, timer}
    this.prompts = new Map();   // promptId -> {resolve, reject, timer}
    this.seq = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/device") {
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      server.accept();
      this.deviceName = url.searchParams.get("name") || "phone";
      // Replace any old socket.
      if (this.socket) { try { this.socket.close(1000, "replaced"); } catch (e) {} }
      this.socket = server;

      server.addEventListener("message", (ev) => this.onMessage(ev.data));
      server.addEventListener("close", () => { if (this.socket === server) this.socket = null; });
      server.addEventListener("error", () => { if (this.socket === server) this.socket = null; });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/online") {
      return json({ online: !!this.socket, name: this.deviceName });
    }

    if (url.pathname === "/cmd") {
      const { cmd, params, timeoutMs } = await request.json();
      if (!this.socket) return json({ ok: false, error: "phone not connected" });
      try {
        const result = await this.sendCommand(cmd, params || {}, timeoutMs || 20000);
        return json({ ok: true, result });
      } catch (e) {
        return json({ ok: false, error: e.message || String(e) });
      }
    }

    if (url.pathname === "/ask") {
      const { message, buttons, timeoutMs } = await request.json();
      if (!this.socket) return json({ ok: false, error: "phone not connected" });
      try {
        const value = await this.askPrompt(message, buttons, timeoutMs || 120000);
        return json({ ok: true, value });
      } catch (e) {
        return json({ ok: false, error: e.message || String(e) });
      }
    }

    return new Response("not found", { status: 404 });
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "promptAnswer" && msg.promptId) {
      const p = this.prompts.get(msg.promptId);
      if (p) { clearTimeout(p.timer); this.prompts.delete(msg.promptId); p.resolve(msg.value); }
      return;
    }
    if (msg.type === "ping") return;

    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result ?? {});
      else p.reject(new Error(msg.error || "phone error"));
    }
  }

  sendCommand(cmd, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = "c" + (++this.seq) + "-" + Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("phone did not reply in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, cmd, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("send failed: " + e.message));
      }
    });
  }

  askPrompt(message, buttons, timeoutMs) {
    return new Promise((resolve, reject) => {
      const promptId = "p" + (++this.seq) + "-" + Date.now();
      const timer = setTimeout(() => {
        this.prompts.delete(promptId);
        reject(new Error("no answer on the phone in time"));
      }, timeoutMs);
      this.prompts.set(promptId, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({
          id: "show-" + promptId, cmd: "show_popup",
          params: { message, buttons, promptId }
        }));
      } catch (e) {
        clearTimeout(timer);
        this.prompts.delete(promptId);
        reject(new Error("send failed: " + e.message));
      }
    });
  }
}
