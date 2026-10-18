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
      // Screenshot (and any image result) comes back as an image content block.
      if (result && typeof result === "object" && result.image) {
        return ok(id, { content: [
          { type: "image", data: result.image, mimeType: result.mime || "image/jpeg" },
          { type: "text", text: `screenshot ${result.w}x${result.h}` }
        ] });
      }
      return ok(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true });
    }
  }
  return jsonRpcErrorObj(id, -32601, "method not found: " + method);
}

// ---------- tool definitions ----------

const TOOLS = [
  // status / find
  { name: "phone_status", description: "Read the phone's current state: battery and charging, storage, network type, screen on/off, ringer mode, Do Not Disturb, and volume levels.", inputSchema: { type: "object", properties: {} } },
  { name: "ring_phone", description: "Ring the phone loudly to find it, even if it is on silent. Rings and vibrates.", inputSchema: { type: "object", properties: { seconds: { type: "integer", description: "1-120, default 15." } } } },
  { name: "stop_ring", description: "Stop a ring started by ring_phone.", inputSchema: { type: "object", properties: {} } },
  { name: "flashlight", description: "Turn the phone's flashlight on or off.", inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] } },
  { name: "vibrate", description: "Vibrate the phone once.", inputSchema: { type: "object", properties: { ms: { type: "integer", description: "100-5000, default 800." } } } },
  { name: "get_location", description: "Get the phone's current GPS location (lat/lng, accuracy, a maps link, and the street address).", inputSchema: { type: "object", properties: {} } },

  // audio / media
  { name: "set_volume", description: "Set a volume stream to a 0-100 level.", inputSchema: { type: "object", properties: { stream: { type: "string", enum: ["media", "ring", "alarm", "call", "notification"] }, level: { type: "integer" } }, required: ["level"] } },
  { name: "set_ringer", description: "Set the ringer mode.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["normal", "vibrate", "silent"] } }, required: ["mode"] } },
  { name: "set_dnd", description: "Set Do Not Disturb mode (needs DND access).", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["off", "priority", "alarms", "none"] } }, required: ["mode"] } },
  { name: "media_control", description: "Control whatever is playing: play/pause, next, previous, stop.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["toggle", "play", "pause", "next", "prev", "stop"] } }, required: ["action"] } },
  { name: "now_playing", description: "What media is currently playing (app, title, artist).", inputSchema: { type: "object", properties: {} } },

  // alarms (Phone Link's own, fully controllable)
  { name: "list_alarms", description: "List all Phone Link alarms with their id, time, label, repeat days, and on/off state.", inputSchema: { type: "object", properties: {} } },
  { name: "add_alarm", description: "Add an alarm. days can be omitted (one-time), or 'daily'/'weekdays'/'weekends', or a list like ['mon','tue'].", inputSchema: { type: "object", properties: { hour: { type: "integer" }, minute: { type: "integer" }, label: { type: "string" }, days: {}, vibrate: { type: "boolean" }, enabled: { type: "boolean" } }, required: ["hour", "minute"] } },
  { name: "update_alarm", description: "Change an existing alarm by id (any of hour, minute, label, days, enabled, vibrate).", inputSchema: { type: "object", properties: { id: { type: "integer" }, hour: { type: "integer" }, minute: { type: "integer" }, label: { type: "string" }, days: {}, vibrate: { type: "boolean" }, enabled: { type: "boolean" } }, required: ["id"] } },
  { name: "delete_alarm", description: "Delete an alarm by id.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "toggle_alarm", description: "Enable or disable an alarm by id.", inputSchema: { type: "object", properties: { id: { type: "integer" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] } },
  { name: "set_timer", description: "Start a countdown timer in the phone's Clock app.", inputSchema: { type: "object", properties: { seconds: { type: "integer" }, label: { type: "string" } }, required: ["seconds"] } },

  // notifications
  { name: "list_notifications", description: "List current notifications with their key, app, title, text, and available actions (including which can be replied to).", inputSchema: { type: "object", properties: { include_ongoing: { type: "boolean", description: "Include persistent/ongoing notifications. Default false." } } } },
  { name: "reply_notification", description: "Reply to a notification that has a reply field (WhatsApp, Messages, etc.) using its key.", inputSchema: { type: "object", properties: { key: { type: "string" }, text: { type: "string" } }, required: ["key", "text"] } },
  { name: "tap_notification_action", description: "Tap one of a notification's action buttons by index (see list_notifications).", inputSchema: { type: "object", properties: { key: { type: "string" }, index: { type: "integer" } }, required: ["key", "index"] } },
  { name: "dismiss_notification", description: "Dismiss/clear a notification by key.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },

  // calls + sms
  { name: "call_log", description: "Recent calls (number, name, type, time, duration).", inputSchema: { type: "object", properties: { limit: { type: "integer", description: "default 20, max 100" } } } },
  { name: "place_call", description: "Place a phone call to a number.", inputSchema: { type: "object", properties: { number: { type: "string" } }, required: ["number"] } },
  { name: "answer_call", description: "Answer the currently ringing call.", inputSchema: { type: "object", properties: {} } },
  { name: "end_call", description: "End the current call.", inputSchema: { type: "object", properties: {} } },
  { name: "call_state", description: "Whether the phone is currently in a call.", inputSchema: { type: "object", properties: {} } },
  { name: "list_sms", description: "Recent SMS/MMS messages across all threads.", inputSchema: { type: "object", properties: { limit: { type: "integer", description: "default 20" } } } },
  { name: "read_sms_thread", description: "Read the SMS thread with a given phone number.", inputSchema: { type: "object", properties: { address: { type: "string" }, limit: { type: "integer" } }, required: ["address"] } },
  { name: "send_sms", description: "Send an SMS text message.", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },

  // sensors / usage
  { name: "bluetooth_status", description: "Bluetooth state and paired devices, and which are connected.", inputSchema: { type: "object", properties: {} } },
  { name: "activity_state", description: "The phone's current motion activity (still, walking, driving, etc.).", inputSchema: { type: "object", properties: {} } },
  { name: "screen_time", description: "Today's per-app screen time and total (needs usage access).", inputSchema: { type: "object", properties: {} } },

  // screen control (accessibility) - drive apps like a browser
  { name: "screenshot", description: "Take a screenshot of the phone and return it as an image so you can see what's on screen.", inputSchema: { type: "object", properties: { max_width: { type: "integer", description: "downscale width, default 900" }, quality: { type: "integer", description: "JPEG quality 30-90, default 55" } } } },
  { name: "screen_dump", description: "Read the on-screen UI as text: visible labels, buttons and input fields, each with tap coordinates. Use before tapping.", inputSchema: { type: "object", properties: {} } },
  { name: "tap", description: "Tap the screen at x,y (coordinates from screen_dump or a screenshot).", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
  { name: "long_press", description: "Long-press the screen at x,y.", inputSchema: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
  { name: "swipe", description: "Swipe from x1,y1 to x2,y2.", inputSchema: { type: "object", properties: { x1: { type: "integer" }, y1: { type: "integer" }, x2: { type: "integer" }, y2: { type: "integer" }, ms: { type: "integer" } }, required: ["x1", "y1", "x2", "y2"] } },
  { name: "scroll", description: "Scroll the screen up, down, left, or right.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } }, required: ["direction"] } },
  { name: "type_text", description: "Type text into the currently focused text field.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "tap_text", description: "Find an on-screen element by its visible text and tap it.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "global_action", description: "Perform a system navigation action.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["back", "home", "recents", "notifications", "quick_settings", "lock", "power_dialog", "screenshot"] } }, required: ["action"] } },

  // apps / system / clipboard
  { name: "list_apps", description: "List installed apps and their package names (for open_app).", inputSchema: { type: "object", properties: { only_launchable: { type: "boolean", description: "Default true." } } } },
  { name: "open_app", description: "Open an app by package name.", inputSchema: { type: "object", properties: { package: { type: "string" } }, required: ["package"] } },
  { name: "open_url", description: "Open a link or deep link on the phone.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "set_clipboard", description: "Put text on the phone's clipboard.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "get_clipboard", description: "Read the phone's clipboard (best-effort; Android limits background reads).", inputSchema: { type: "object", properties: {} } },

  // owner interaction
  { name: "speak", description: "Make the phone speak text out loud.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "show_popup", description: "Show a full-screen message on the phone (even over the lock screen).", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "ask_on_phone", description: "Show a question on the phone with answer buttons and WAIT for the owner to tap one. Use for confirm-before-acting prompts.", inputSchema: { type: "object", properties: { message: { type: "string" }, buttons: { type: "array", items: { type: "string" } }, timeout_seconds: { type: "integer" } }, required: ["message"] } }
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
    get_location: ["location", {}],

    set_volume: ["set_volume", { stream: args.stream || "media", level: args.level }],
    set_ringer: ["set_ringer", { mode: args.mode }],
    set_dnd: ["set_dnd", { mode: args.mode }],
    media_control: ["media_control", { action: args.action }],
    now_playing: ["now_playing", {}],

    list_alarms: ["alarm_list", {}],
    add_alarm: ["alarm_add", { hour: args.hour, minute: args.minute, label: args.label, days: args.days, vibrate: args.vibrate, enabled: args.enabled }],
    update_alarm: ["alarm_update", { id: args.id, hour: args.hour, minute: args.minute, label: args.label, days: args.days, vibrate: args.vibrate, enabled: args.enabled }],
    delete_alarm: ["alarm_delete", { id: args.id }],
    toggle_alarm: ["alarm_toggle", { id: args.id, enabled: args.enabled }],
    set_timer: ["set_timer", { seconds: args.seconds, label: args.label }],

    list_notifications: ["notif_list", { includeOngoing: !!args.include_ongoing }],
    reply_notification: ["notif_reply", { key: args.key, text: args.text }],
    tap_notification_action: ["notif_action", { key: args.key, index: args.index }],
    dismiss_notification: ["notif_dismiss", { key: args.key }],

    call_log: ["call_log", { limit: args.limit }],
    place_call: ["place_call", { number: args.number }],
    answer_call: ["answer_call", {}],
    end_call: ["end_call", {}],
    call_state: ["call_state", {}],
    list_sms: ["sms_recent", { limit: args.limit }],
    read_sms_thread: ["sms_thread", { address: args.address, limit: args.limit }],
    send_sms: ["send_sms", { to: args.to, text: args.text }],

    bluetooth_status: ["bluetooth", {}],
    activity_state: ["activity", {}],
    screen_time: ["screen_time", {}],

    screenshot: ["screenshot", { maxWidth: args.max_width, quality: args.quality }],
    screen_dump: ["screen_dump", {}],
    tap: ["tap", { x: args.x, y: args.y }],
    long_press: ["long_press", { x: args.x, y: args.y }],
    swipe: ["swipe", { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, ms: args.ms }],
    scroll: ["scroll", { direction: args.direction }],
    type_text: ["input_text", { text: args.text }],
    tap_text: ["tap_text", { text: args.text }],
    global_action: ["global_action", { action: args.action }],

    list_apps: ["list_apps", { onlyLaunchable: args.only_launchable !== false }],
    open_app: ["open_app", { package: args.package }],
    open_url: ["open_url", { url: args.url }],
    set_clipboard: ["set_clipboard", { text: args.text }],
    get_clipboard: ["get_clipboard", {}],

    speak: ["speak", { text: args.text }],
    show_popup: ["show_popup", { message: args.message }]
  };
  const entry = map[name];
  if (!entry) throw new Error("unknown tool: " + name);
  const [cmd, params] = entry;
  // screen control + location can take longer
  const slow = ["screenshot", "location", "screen_dump", "swipe", "scroll"].includes(cmd);
  return hubCmd(env, cmd, clean(params), slow ? 30000 : 20000);
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
