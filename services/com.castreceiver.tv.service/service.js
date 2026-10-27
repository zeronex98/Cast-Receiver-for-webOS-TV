/*
 * webOS TV Cast Receiver - background service
 * ------------------------------------------------------------------
 * Responsibilities:
 *   1. SSDP: advertise on the LAN and answer discovery probes so that
 *      phone casting apps can find this TV (DLNA renderer).
 *   2. UPnP: expose standard AVTransport / RenderingControl /
 *      ConnectionManager SOAP control endpoints plus GENA eventing.
 *   3. HTTP: long-poll /status plus a small JSON control API for the
 *      webOS front-end app.
 *   4. Extras: mobile remote page (remote.html) and subtitle proxy
 *      endpoint (/proxy).
 *
 * Compatibility target: Node 0.12+ (webOS TV 4.x ~ 7.x), ES5 syntax only.
 */
var os = require("os");
var fs = require("fs");
var http = require("http");
var https = require("https");
var net = require("net");
var dgram = require("dgram");
var crypto = require("crypto");
var url = require("url");
var path = require("path");
var Service = require("webos-service");

var service = new Service("com.castreceiver.tv.service");

/* ============================ Constants ============================ */

var VERSION = "0.0.6";
var STARTED_AT = Date.now();

/* Development mode: keep verbose logs for debugging. Logs are visible
 * through `ares-inspect` (app console) and the TV's Log Viewer (syslog).
 * Flip to false for a quiet production build. */
var DEBUG = true;

var HTTP_PORT_START = 49152;
var HTTP_PORT_END = 49180;
var HTTP_PORT = HTTP_PORT_START;

var SSDP_PORT = 1900;
var SSDP_ADDRESS = "239.255.255.250";
/* The TV's built-in DLNA stack keeps udp/1900, so M-SEARCH reception is
 * usually impossible on CN models. Faster alive bursts raise the odds of
 * passive discovery by controllers that listen for NOTIFY. */
var SSDP_ALIVE_INTERVAL_MS = 30000;
var SSDP_MAX_AGE = 300;

var DEVICE_UDN = "uuid:" + crypto.createHash("md5").update("webos-castreceiver-" + os.hostname()).digest("hex");
/* Device identity: the friendlyName shown in casting lists. Detected from
 * the TV at runtime so the receiver appears as the real model (e.g.
 * "LG OLED77C5PCA"), unless the user set a custom name. */
var MODEL_NAME = "";
var DEVICE_NAME = "LG电视·投屏助手";
var CUSTOM_NAME_FILE = path.join(__dirname, "device-name.json");

/* WiFi sharing: SSID auto-detected from the TV; password is user-entered
 * (the OS never exposes saved WiFi passwords). Persisted in settings.json.
 * The password is only ever returned over the Luna channel (local apps),
 * never over the LAN-facing HTTP API. */
var SETTINGS_FILE = path.join(__dirname, "settings.json");

function loadSettings() {
  try {
    var data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (data && data.wifi) {
      if (typeof data.wifi.ssid === "string") {
        state.wifi.ssid = data.wifi.ssid.slice(0, 32);
      }
      if (typeof data.wifi.password === "string") {
        state.wifi.password = data.wifi.password.slice(0, 63);
      }
      if (typeof data.wifi.ssidCustom === "boolean") {
        state.wifi.ssidCustom = data.wifi.ssidCustom;
      }
      debugLog("boot", "wifi settings loaded: ssid=" + state.wifi.ssid +
        " hasPassword=" + !!state.wifi.password);
    }
  } catch (error) {
    /* first run */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      wifi: {
        ssid: state.wifi.ssid,
        password: state.wifi.password,
        ssidCustom: state.wifi.ssidCustom
      }
    }));
  } catch (error) {
    debugLog("boot", "save settings failed: " + (error && error.message));
  }
}

/* Auto-detect the WiFi SSID the TV is connected to (best effort). */
function detectWifiSsid() {
  try {
    service.call("luna://com.webos.service.connectionmanager/getStatus", {}, function (response) {
      var payload = (response && response.payload) || {};
      var wifi = payload.wifi || payload.wifiInfo || {};
      var ssid = String(wifi.ssid || payload.ssid || "").trim();
      if (!ssid) {
        return;
      }
      state.detectedSsid = ssid;
      if (!state.wifi.ssidCustom && state.wifi.ssid !== ssid) {
        state.wifi.ssid = ssid;
        debugLog("boot", "wifi ssid detected: " + ssid);
        touchState([], false);
      }
    });
  } catch (error) {
    debugLog("boot", "wifi ssid detection unavailable: " + (error && error.message));
  }
}

/* payload: { ssid?: string, password?: string|null }
 *   ssid omitted   -> unchanged
 *   password null  -> clear; password ""/string -> set */
function setWifiSettings(payload) {
  var changed = false;
  if (typeof payload.ssid === "string") {
    var ssid = payload.ssid.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 32);
    if (ssid !== state.wifi.ssid) {
      state.wifi.ssid = ssid;
      changed = true;
    }
    state.wifi.ssidCustom = !!ssid && ssid !== state.detectedSsid;
  }
  if ("password" in payload) {
    var password = payload.password === null ? "" : String(payload.password || "").slice(0, 63);
    if (password !== state.wifi.password) {
      state.wifi.password = password;
      changed = true;
    }
  }
  if (changed) {
    debugLog("boot", "wifi settings updated: ssid=" + state.wifi.ssid +
      " hasPassword=" + !!state.wifi.password);
    saveSettings();
    touchState([], false);
  }
  return changed;
}

function defaultDeviceName() {
  if (!MODEL_NAME) {
    return "LG电视·投屏助手";
  }
  return /^LG/i.test(MODEL_NAME) ? MODEL_NAME : "LG " + MODEL_NAME;
}

/* Load a previously saved custom name (survives service restarts and TV
 * reboots; the web app additionally mirrors it to localStorage so it can
 * be restored even after an ipk update wipes this file). */
function loadCustomName() {
  try {
    var data = JSON.parse(fs.readFileSync(CUSTOM_NAME_FILE, "utf8"));
    if (data && typeof data.name === "string" && data.name.trim()) {
      state.customName = data.name.trim().slice(0, 40);
      state.nameCustom = true;
      DEVICE_NAME = state.customName;
      debugLog("boot", "custom device name loaded: " + DEVICE_NAME);
    }
  } catch (error) {
    /* first run */
  }
}

function saveCustomName() {
  try {
    fs.writeFileSync(CUSTOM_NAME_FILE, JSON.stringify({
      name: state.nameCustom ? state.customName : ""
    }));
  } catch (error) {
    debugLog("boot", "save device name failed: " + (error && error.message));
  }
}

/* name="" resets to the default model name. Returns true when changed. */
function setCustomName(name) {
  name = String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  var changed;
  if (!name) {
    state.customName = "";
    state.nameCustom = false;
    changed = DEVICE_NAME !== defaultDeviceName();
    DEVICE_NAME = defaultDeviceName();
  } else {
    state.customName = name;
    state.nameCustom = true;
    changed = DEVICE_NAME !== name;
    DEVICE_NAME = name;
  }
  saveCustomName();
  if (changed) {
    debugLog("boot", "device name -> " + DEVICE_NAME);
    touchState([], false);
    /* Re-announce so controllers update the cached name. */
    scheduleAliveBurst(0);
  }
  return changed;
}

function applyDeviceModel(model) {
  model = String(model || "").trim();
  /* getSystemInfo reports e.g. "OLED77C5PCA.ACNQLJD" — keep the model
   * part only, drop the SKU/region suffix. */
  model = model.split(".")[0].trim();
  if (!model) {
    return false;
  }
  MODEL_NAME = model;
  if (state.nameCustom) {
    return true; /* keep the user's custom name */
  }
  var friendly = /^LG/i.test(model) ? model : "LG " + model;
  if (friendly === DEVICE_NAME) {
    return true;
  }
  DEVICE_NAME = friendly;
  debugLog("boot", "friendlyName -> " + DEVICE_NAME);
  touchState([], false);
  /* Re-announce so controllers update the cached name. */
  scheduleAliveBurst(0);
  return true;
}

function detectDeviceModel() {
  var finish = function (model) {
    if (applyDeviceModel(model)) {
      return;
    }
    /* Fallback: webOS config key (older/newer firmware variants). */
    try {
      service.call("luna://com.webos.service.config/getConfigs", {
        configNames: ["tv.model.modelname", "tv.model.modeldisplayname"]
      }, function (response) {
        var configs = (response && response.payload && response.payload.configs) || {};
        var configModel = configs["tv.model.modeldisplayname"] || configs["tv.model.modelname"];
        if (configModel && applyDeviceModel(configModel)) {
          return;
        }
        debugLog("boot", "device model detection failed; keeping default name");
      });
    } catch (error) {
      debugLog("boot", "getConfigs unavailable: " + (error && error.message));
    }
  };

  try {
    service.call("luna://com.webos.service.tv.system/getSystemInfo", {
      keys: ["modelName", "serialNumber"]
    }, function (response) {
      var payload = (response && response.payload) || {};
      finish(payload.modelName || payload["tv.model.modelname"]);
    });
  } catch (error) {
    finish("");
  }
}
var DEVICE_TYPE = "urn:schemas-upnp-org:device:MediaRenderer:1";
var AVTRANSPORT_TYPE = "urn:schemas-upnp-org:service:AVTransport:1";
var RENDERINGCONTROL_TYPE = "urn:schemas-upnp-org:service:RenderingControl:1";
var CONNECTIONMANAGER_TYPE = "urn:schemas-upnp-org:service:ConnectionManager:1";
var SERVER_TOKEN = "Linux/1.0 UPnP/1.0 CastReceiver/" + VERSION;

/* SSDP targets that are announced in NOTIFY bursts and answered in M-SEARCH */
var SSDP_TARGETS = [
  DEVICE_UDN,
  "upnp:rootdevice",
  DEVICE_TYPE,
  AVTRANSPORT_TYPE,
  RENDERINGCONTROL_TYPE,
  CONNECTIONMANAGER_TYPE
];

var EVENT_SERVICE_MAP = {
  "/upnp/event/AVTransport": "AVTransport",
  "/upnp/event/RenderingControl": "RenderingControl",
  "/upnp/event/ConnectionManager": "ConnectionManager"
};

/* ConnectionManager sink protocol list: this is what controllers use to
 * decide "what can this TV play". Only containers decodable by the webOS TV
 * browser media pipeline are advertised. */
var SINK_PROTOCOL_INFO = [
  "http-get:*:video/mp4:*,http-get:*:video/mpeg:*,http-get:*:video/x-matroska:*," +
  "http-get:*:video/mp2t:*,http-get:*:video/quicktime:*,http-get:*:video/3gpp:*," +
  "http-get:*:video/3gpp2:*,http-get:*:video/webm:*,http-get:*:application/vnd.apple.mpegurl:*",
  "http-get:*:audio/mpeg:*,http-get:*:audio/mp4:*,http-get:*:audio/aac:*,http-get:*:audio/x-aac:*," +
  "http-get:*:audio/flac:*,http-get:*:audio/wav:*,http-get:*:audio/x-wav:*,http-get:*:audio/ogg:*," +
  "http-get:*:audio/x-m4a:*,http-get:*:audio/mp3:*",
  "http-get:*:image/jpeg:*,http-get:*:image/png:*,http-get:*:image/gif:*,http-get:*:image/bmp:*,http-get:*:image/webp:*",
  "http-get:*:text/vtt:*,http-get:*:application/x-subrip:*"
].join(",");

var PLAY_MODES = ["NORMAL", "REPEAT_ALL", "REPEAT_ONE", "SHUFFLE", "RANDOM"];
var TRANSPORT_STATES = ["NO_MEDIA_PRESENT", "STOPPED", "PAUSED_PLAYBACK", "PLAYING", "TRANSITIONING"];

var TRANSPORT_STATUS_OK = "OK";
var TRANSPORT_STATUS_ERROR = "ERROR";

/* Guard against pathological controllers pushing unbounded queue state. */
var MAX_QUEUE_LENGTH = 200;

/* AirPlay capability probe re-run interval (see the probe section below). */
var AIRPLAY_PROBE_INTERVAL_MS = 600000;

/* ============================ State ============================ */

var state = {
  rev: 1,
  transportState: "NO_MEDIA_PRESENT",
  transportStatus: TRANSPORT_STATUS_OK,
  playbackSpeed: "1",
  playMode: "NORMAL",
  volume: 50,
  mute: false,
  currentTrackIndex: 0,
  queue: [],
  nextMedia: null,
  currentMedia: null,
  duration: 0,
  position: 0,
  seekTarget: 0,
  seekSeq: 0,
  lastPositionAt: Date.now(),
  lastExternalCommandAt: 0,
  lastSeekCommandAt: 0,
  lastUpdatedAt: new Date().toISOString(),
  controller: null,
  appLuna: null,
  appBridge: "",
  customName: "",
  nameCustom: false,
  detectedSsid: "",
  wifi: {
    ssid: "",
    password: "",
    ssidCustom: false
  },
  airplay: {
    verdict: "pending",
    probedAt: null,
    mdns: { airplaySeen: false, raopSeen: false, services: [], responders: [] },
    tcp: { port7000: false, port7001: false, port7100: false },
    files: [],
    detail: "probe scheduled"
  }
};

var subscribers = {
  AVTransport: {},
  RenderingControl: {},
  ConnectionManager: {}
};

var longPollWaiters = [];

var ssdpState = {
  bound: false,
  degraded: false,
  sender: null,
  listener: null
};

var localIpCache = { ip: "127.0.0.1", at: 0 };
var serviceBaseCache = { base: "", ip: "" };

/* ============================ Bootstrap ============================ */

startHttpServer();
startSsdp();
registerLunaMethods();
holdServiceAlive();
loadCustomName();
loadSettings();
detectDeviceModel();
detectWifiSsid();
setInterval(detectWifiSsid, 60000).unref();
setInterval(sweepSubscribers, 60000).unref();
console.log("[castreceiver] service started, version " + VERSION +
  " | debug=" + DEBUG +
  " | udn=" + DEVICE_UDN);
if (DEBUG) {
  console.log("[castreceiver] logs visible via ares-inspect or the TV Log Viewer");
}

process.on("uncaughtException", function (error) {
  console.error("[castreceiver] uncaughtException: " + (error && error.message));
  if (DEBUG && error && error.stack) {
    console.error(error.stack);
  }
});

/* Kick off the AirPlay capability probe shortly after boot, then re-probe
 * periodically (e.g. after the TV recovers from a reboot or the stack
 * appears following an update). */
setTimeout(runAirplayProbe, 4000);
setInterval(runAirplayProbe, AIRPLAY_PROBE_INTERVAL_MS).unref();

/* webOS terminates on-demand JS services ~5 seconds after the last
 * completed activity (idleTimeout in the platform's webos-service module).
 * Hold an internal activity for the whole process lifetime so the renderer
 * stays reachable between casting sessions — no client keepalive needed. */
var keepaliveActivity = null;

function holdServiceAlive() {
  try {
    service.activityManager.create("castreceiver-keepalive", function (activity) {
      keepaliveActivity = activity;
      debugLog("boot", "keepalive activity: " + (activity && activity.activityId));
    });
  } catch (error) {
    console.error("[castreceiver] keepalive activity failed: " + (error && error.message));
  }
}

/* ============================ Luna methods ============================ */

function registerLunaMethods() {
  service.register("status", function (message) {
    /* Subscription-aware: webOS kills on-demand JS services once no luna
     * client is active. The front-end keeps a status subscription alive
     * purely as a keepalive (HTTP long-poll remains the data channel);
     * luna pushes double as a fallback feed while HTTP is offline. */
    var respond = function () {
      message.respond(buildStatus());
    };

    respond();

    if (message.isSubscription) {
      var timer = setInterval(respond, 5000);
      message.on("cancel", function () {
        clearInterval(timer);
      });
    }
  });

  service.register("play", function (message) {
    var payload = message.payload || {};
    if (!payload.url) {
      return message.respond({ returnValue: false, errorText: "url is required" });
    }
    playSingleMedia(normalizeMedia(payload, payload.title || "Cast media"), true);
    message.respond({ returnValue: true, status: buildStatus() });
  });

  service.register("stop", function (message) {
    stopPlayback();
    message.respond({ returnValue: true, status: buildStatus() });
  });

  service.register("next", function (message) {
    advanceQueue(1, {});
    message.respond({ returnValue: true, status: buildStatus() });
  });

  service.register("previous", function (message) {
    advanceQueue(-1, {});
    message.respond({ returnValue: true, status: buildStatus() });
  });

  service.register("airplay", function (message) {
    runAirplayProbe();
    message.respond({ returnValue: true, airplay: state.airplay });
  });

  /* Full WiFi settings incl. the password — Luna channel only (local apps),
   * never exposed over the LAN HTTP API. */
  service.register("wifi", function (message) {
    message.respond({
      returnValue: true,
      ssid: state.wifi.ssid,
      password: state.wifi.password,
      hasPassword: !!state.wifi.password,
      ssidCustom: state.wifi.ssidCustom
    });
  });
}

/* ============================ HTTP server ============================ */

function startHttpServer() {
  var httpServer = http.createServer(handleHttpRequest);

  httpServer.on("clientError", function () {
    /* Client disconnected mid-request; ignore. */
  });
  httpServer.on("error", function (error) {
    if (error && error.code === "EADDRINUSE" && HTTP_PORT < HTTP_PORT_END) {
      HTTP_PORT += 1;
      console.log("[castreceiver] port busy, retrying on " + HTTP_PORT);
      startHttpServer();
      return;
    }
    console.error("[castreceiver] http server error: " + (error && error.message));
  });

  httpServer.listen(HTTP_PORT, function () {
    console.log("[castreceiver] http listening on " + HTTP_PORT);
  });
}

function handleHttpRequest(req, res) {
  req.on("error", function () {});

  var parsed = url.parse(req.url, true);
  var pathname = (parsed.pathname || "/").replace(/\/+$/, "") || "/";
  var query = parsed.query || {};

  /* Keep the log readable: skip heartbeat traffic. */
  if (pathname !== "/status" && pathname !== "/health") {
    rateLimitLog("http:" + pathname, 2000, "http", req.method + " " + pathname);
  }

  /* --- Static pages and description documents --- */
  if (req.method === "GET" || req.method === "HEAD") {
    if (pathname === "/" || pathname === "/remote" || pathname === "/remote.html") {
      return serveRemotePage(req, res);
    }
    if (pathname === "/status") {
      return handleStatusRequest(req, res, query);
    }
    if (pathname === "/info") {
      return sendJson(res, 200, buildInfo());
    }
    if (pathname === "/renderer/airplay") {
      runAirplayProbe();
      return sendJson(res, 200, { returnValue: true, airplay: state.airplay });
    }
    if (pathname === "/health") {
      return sendJson(res, 200, { returnValue: true, ok: true, ts: Date.now() });
    }
    if (pathname === "/device-desc.xml") {
      return sendXml(res, 200, buildDeviceDescription());
    }
    if (pathname === "/upnp/scpd/AVTransport.xml") {
      return sendXml(res, 200, AVTRANSPORT_SCPD);
    }
    if (pathname === "/upnp/scpd/RenderingControl.xml") {
      return sendXml(res, 200, RENDERING_CONTROL_SCPD);
    }
    if (pathname === "/upnp/scpd/ConnectionManager.xml") {
      return sendXml(res, 200, CONNECTION_MANAGER_SCPD);
    }
    if (pathname === "/proxy") {
      return handleSubtitleProxy(req, res, query);
    }
  }

  /* --- Front-end control API --- */
  if (req.method === "POST" && pathname.indexOf("/renderer/") === 0) {
    return readRequestBody(req, 1048576, function (body, err) {
      if (err) {
        return sendJson(res, 413, { error: "body too large" });
      }
      handleRendererApi(pathname, safeJsonParse(body) || {}, res, query);
    });
  }

  /* --- UPnP SOAP control points --- */
  if (req.method === "POST" && pathname === "/upnp/control/AVTransport") {
    return readRequestBody(req, 1048576, function (body) {
      trackController(req);
      handleAvTransportControl(resolveSoapAction(req, body), body, res);
    });
  }

  if (req.method === "POST" && pathname === "/upnp/control/RenderingControl") {
    return readRequestBody(req, 1048576, function (body) {
      trackController(req);
      handleRenderingControl(resolveSoapAction(req, body), body, res);
    });
  }

  if (req.method === "POST" && pathname === "/upnp/control/ConnectionManager") {
    return readRequestBody(req, 1048576, function (body) {
      handleConnectionManagerControl(resolveSoapAction(req, body), body, res);
    });
  }

  /* --- UPnP GENA event subscription --- */
  if (EVENT_SERVICE_MAP[pathname] && req.method === "SUBSCRIBE") {
    return handleSubscribe(req, res, pathname);
  }
  if (EVENT_SERVICE_MAP[pathname] && req.method === "UNSUBSCRIBE") {
    return handleUnsubscribe(req, res, pathname);
  }
  if (EVENT_SERVICE_MAP[pathname]) {
    return sendPlain(res, 405, "method not allowed");
  }

  if (req.method === "OPTIONS") {
    return sendOptions(res);
  }

  sendJson(res, 404, { error: "not found" });
}

/* ---- /status: plain request + long-poll ---- */

function handleStatusRequest(req, res, query) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "method not allowed" });
  }

  var waitSeconds = parsePositiveInt(query.wait, 0);
  var rev = parsePositiveInt(query.rev, -1);
  var light = query.light === "1";

  if (waitSeconds <= 0 || rev < 0 || state.rev !== rev) {
    return sendJson(res, 200, buildStatusFor(light));
  }

  waitSeconds = Math.min(waitSeconds, 20);
  var waiter = {
    res: res,
    rev: rev,
    light: light,
    timer: null,
    done: false
  };
  waiter.timer = setTimeout(function () {
    finishWaiter(waiter, buildStatusFor(waiter.light));
  }, waitSeconds * 1000);
  waiter.res.on("close", function () {
    finishWaiter(waiter, null);
  });
  longPollWaiters.push(waiter);
}

function finishWaiter(waiter, payload) {
  if (waiter.done) {
    return;
  }
  waiter.done = true;
  if (waiter.timer) {
    clearTimeout(waiter.timer);
  }
  var index = longPollWaiters.indexOf(waiter);
  if (index !== -1) {
    longPollWaiters.splice(index, 1);
  }
  if (payload && !waiter.res.finished && !waiter.res.headersSent) {
    try {
      sendJson(waiter.res, 200, payload);
    } catch (error) {
      /* Client already gone. */
    }
  }
}

function flushLongPollWaiters() {
  var snapshot = longPollWaiters.slice();
  var i;
  for (i = 0; i < snapshot.length; i += 1) {
    if (snapshot[i].rev < state.rev) {
      finishWaiter(snapshot[i], buildStatusFor(snapshot[i].light));
    }
  }
}

/* ---- /renderer/* JSON control API ---- */

function handleRendererApi(pathname, payload, res, query) {
  rateLimitLog("api:" + pathname, 2500, "api", "POST " + pathname +
    (payload && payload.url ? " url=" + String(payload.url).slice(0, 100) : ""));

  var light = !!(query && query.light === "1");
  var respond = function () {
    sendJson(res, 200, buildStatusFor(light));
  };

  switch (pathname) {
    case "/renderer/play":
      if (!payload.url) {
        return sendJson(res, 400, { error: "url is required" });
      }
      playSingleMedia(normalizeMedia(payload, payload.title || "Cast media"), payload.autoplay !== false);
      return respond();
    case "/renderer/queue":
      if (!Array.isArray(payload.items) || payload.items.length === 0) {
        return sendJson(res, 400, { error: "items array is required" });
      }
      replaceQueue(payload.items, !!payload.autoplay);
      return respond();
    case "/renderer/jump":
      if (typeof payload.index !== "number" || payload.index < 0 || payload.index >= state.queue.length) {
        return sendJson(res, 400, { error: "invalid index" });
      }
      jumpToTrack(payload.index);
      return respond();
    case "/renderer/next":
      advanceQueue(1, {});
      return respond();
    case "/renderer/previous":
      advanceQueue(-1, {});
      return respond();
    case "/renderer/stop":
      stopPlayback();
      return respond();
    case "/renderer/seek":
      if (typeof payload.position !== "number" || !isFinite(payload.position)) {
        return sendJson(res, 400, { error: "position number is required" });
      }
      requestSeek(Math.max(0, Math.floor(payload.position)), "renderer-api");
      return respond();
    case "/renderer/volume":
      if (typeof payload.volume !== "number" || !isFinite(payload.volume)) {
        return sendJson(res, 400, { error: "volume number is required" });
      }
      setVolume(clamp(Math.floor(payload.volume), 0, 100));
      return respond();
    case "/renderer/mute":
      setMute(!!payload.mute);
      return respond();
    case "/renderer/repeat":
      if (PLAY_MODES.indexOf(String(payload.mode || "").toUpperCase()) === -1) {
        return sendJson(res, 400, { error: "invalid mode" });
      }
      setPlayMode(String(payload.mode).toUpperCase());
      return respond();
    case "/renderer/state":
      return sendJson(res, 200, applyRendererStateUpdate(payload, light));
    case "/renderer/device-name":
      /* Custom name from the TV UI or the phone remote page; the app also
       * reports the TV model here as a fallback. */
      if (typeof payload.name === "string") {
        setCustomName(payload.name);
      } else if (payload.modelName) {
        applyDeviceModel(payload.modelName);
      }
      return respond();
    case "/renderer/wifi":
      /* Set WiFi sharing info for the join QR (password write-only). */
      setWifiSettings(payload);
      return respond();
    case "/renderer/airplay":
      runAirplayProbe();
      return sendJson(res, 200, { returnValue: true, airplay: state.airplay });
    default:
      return sendJson(res, 404, { error: "not found" });
  }
}

/* ---- Mobile remote page ---- */

var remotePageCache = null;

function loadRemotePage() {
  if (remotePageCache === null) {
    try {
      remotePageCache = fs.readFileSync(path.join(__dirname, "remote.html"), "utf8");
    } catch (error) {
      remotePageCache = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>投屏助手</title></head>" +
        "<body style=\"font-family:sans-serif;background:#0d2233;color:#e8f4fd;text-align:center;padding:48px\">" +
        "<h1>遥控页面缺失</h1><p>remote.html 未随服务安装。</p></body></html>";
    }
  }
  return remotePageCache;
}

function serveRemotePage(req, res) {
  var body = loadRemotePage();
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    SERVER: SERVER_TOKEN
  });
  if (req.method === "HEAD") {
    return res.end();
  }
  res.end(body);
}

/* ---- Subtitle proxy ---- */

function handleSubtitleProxy(req, res, query) {
  var target = String(query.url || "");
  if (!/^https?:\/\//i.test(target)) {
    return sendJson(res, 400, { error: "url must be http(s)" });
  }

  var parsedTarget = url.parse(target);
  if (!parsedTarget.hostname) {
    return sendJson(res, 400, { error: "invalid url" });
  }

  var redirects = 0;
  var transport = parsedTarget.protocol === "https:" ? https : http;

  var request = transport.request({
    hostname: parsedTarget.hostname,
    port: parsedTarget.port || (parsedTarget.protocol === "https:" ? 443 : 80),
    path: (parsedTarget.path || "/") + (parsedTarget.search || ""),
    method: "GET",
    headers: {
      "User-Agent": "Lavf/58.29.100",
      Accept: "*/*",
      Connection: "close"
    },
    timeout: 15000
  }, function (upstream) {
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location && redirects < 3) {
      redirects += 1;
      upstream.resume();
      request.abort();
      return handleSubtitleProxy(req, res, { url: url.resolve(target, upstream.headers.location) });
    }
    if (upstream.statusCode !== 200) {
      return sendJson(res, 502, { error: "upstream status " + upstream.statusCode });
    }

    var contentType = String(upstream.headers["content-type"] || "application/octet-stream");
    if (!/text|xml|plain|subrip|vtt/i.test(contentType)) {
      contentType = "application/octet-stream";
    }
    if (!/charset/i.test(contentType)) {
      contentType += "; charset=utf-8";
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });

    var served = 0;
    upstream.on("data", function (chunk) {
      served += chunk.length;
      if (served > 8388608) {
        request.abort();
        res.end();
        return;
      }
      res.write(chunk);
    });
    upstream.on("end", function () {
      res.end();
    });
    upstream.on("error", function () {
      try { res.end(); } catch (error) {}
    });
  });

  request.on("timeout", function () {
    request.abort();
    try { sendJson(res, 504, { error: "upstream timeout" }); } catch (error) {}
  });
  request.on("error", function () {
    try { sendJson(res, 502, { error: "upstream error" }); } catch (error) {}
  });
  request.end();
}

/* ============================ SSDP ============================ */

function startSsdp() {
  var listener = dgram.createSocket("udp4");
  var bindAttempt = 0;

  listener.on("error", function (error) {
    if (ssdpState.bound || ssdpState.degraded) {
      return;
    }
    /* Port 1900 may already be taken by the TV's built-in DLNA/SmartShare
     * stack: retry with a different bind style, then degrade to
     * announce-only mode (alive NOTIFY bursts still reach NOTIFY-aware
     * controllers). */
    bindAttempt += 1;
    if (bindAttempt === 2) {
      try {
        listener.bind(SSDP_PORT, onBindSuccess);
        return;
      } catch (error2) {}
    }
    degradeSsdp(error);
  });

  listener.on("message", function (msg, rinfo) {
    handleSsdpMessage(msg, rinfo);
  });

  ssdpState.listener = listener;

  try {
    listener.bind({ port: SSDP_PORT, reuseAddr: true }, onBindSuccess);
  } catch (error) {
    bindAttempt += 1;
    try {
      listener.bind(SSDP_PORT, onBindSuccess);
    } catch (error2) {
      degradeSsdp(error2);
    }
  }

  /* Fallback: if still not bound after 1.2s, switch to announce-only mode. */
  setTimeout(function () {
    if (!ssdpState.bound && !ssdpState.degraded) {
      degradeSsdp(null);
    }
  }, 1200);

  function onBindSuccess() {
    if (ssdpState.bound) {
      return;
    }
    ssdpState.bound = true;
    ssdpState.sender = listener;
    try {
      listener.addMembership(SSDP_ADDRESS);
      listener.setMulticastTTL(4);
      listener.setMulticastLoopback(false);
    } catch (error) {
      /* Joining the multicast group can fail on some interfaces;
       * that only disables M-SEARCH reception, alive bursts still work. */
    }
    console.log("[castreceiver] ssdp listening on udp/" + SSDP_PORT);
    scheduleAliveBurst(0);
  }

  function degradeSsdp(sourceError) {
    if (ssdpState.bound || ssdpState.degraded) {
      return;
    }
    ssdpState.degraded = true;
    ssdpState.sender = createSenderSocket();
    console.log("[castreceiver] ssdp bind failed (" +
      ((sourceError && sourceError.code) || "unknown") + "), announce-only mode");
    scheduleAliveBurst(0);
  }
}

function createSenderSocket() {
  var socket = dgram.createSocket("udp4");
  socket.on("error", function () {});
  return socket;
}

function handleSsdpMessage(msg, rinfo) {
  var text = msg.toString("utf8");
  var startLine = text.split("\r\n")[0] || "";

  if (startLine.indexOf("M-SEARCH") === -1 || text.indexOf("ssdp:discover") === -1) {
    return;
  }

  var st = (getHeaderLineValue(text, "ST") || "").trim();
  if (!st) {
    return;
  }

  rateLimitLog("msearch:" + st + ":" + rinfo.address, 2500, "ssdp",
    "M-SEARCH st=" + st + " from=" + rinfo.address + ":" + rinfo.port);

  var mx = parseInt(getHeaderLineValue(text, "MX") || "1", 10);
  if (!isFinite(mx) || mx < 1) {
    mx = 1;
  }
  var maxDelay = Math.min(mx * 1000, 3000);

  if (st === "ssdp:all") {
    var i;
    for (i = 0; i < SSDP_TARGETS.length; i += 1) {
      scheduleSearchResponse(SSDP_TARGETS[i], rinfo, maxDelay + i * 120);
    }
    return;
  }

  if (SSDP_TARGETS.indexOf(st) !== -1) {
    scheduleSearchResponse(st, rinfo, Math.floor(Math.random() * maxDelay));
  }
}

function scheduleSearchResponse(st, rinfo, delay) {
  var respond = function () {
    sendSearchResponse(st, rinfo);
  };
  setTimeout(respond, Math.max(0, delay));
  setTimeout(respond, Math.max(0, delay) + 180);
}

function sendSearchResponse(st, rinfo) {
  var payload = toBuffer(
    "HTTP/1.1 200 OK\r\n" +
    "CACHE-CONTROL: max-age=" + SSDP_MAX_AGE + "\r\n" +
    "DATE: " + new Date().toUTCString() + "\r\n" +
    "EXT:\r\n" +
    "LOCATION: " + getServiceBase() + "/device-desc.xml\r\n" +
    "SERVER: " + SERVER_TOKEN + "\r\n" +
    "ST: " + st + "\r\n" +
    "USN: " + buildUsn(st) + "\r\n\r\n"
  );
  try {
    (ssdpState.sender || ssdpState.listener).send(payload, 0, payload.length, rinfo.port, rinfo.address);
  } catch (error) {}
}

function scheduleAliveBurst(delay) {
  debugLog("ssdp", "alive burst: " + SSDP_TARGETS.length + " targets (" + (ssdpState.degraded ? "announce-only" : "multicast listener") + ")");
  var i;
  for (i = 0; i < SSDP_TARGETS.length; i += 1) {
    (function (target, offset) {
      setTimeout(function () {
        sendAliveOrBye(target, "ssdp:alive");
      }, (delay || 0) + offset * 150);
    }(SSDP_TARGETS[i], i));
  }
  if (!ssdpState.aliveTimer) {
    ssdpState.aliveTimer = setInterval(function () {
      scheduleAliveBurst(0);
    }, SSDP_ALIVE_INTERVAL_MS);
  }
}

function sendAliveOrBye(target, nts) {
  var payload = toBuffer(
    "NOTIFY * HTTP/1.1\r\n" +
    "HOST: " + SSDP_ADDRESS + ":" + SSDP_PORT + "\r\n" +
    "CACHE-CONTROL: max-age=" + SSDP_MAX_AGE + "\r\n" +
    "LOCATION: " + getServiceBase() + "/device-desc.xml\r\n" +
    "NT: " + target + "\r\n" +
    "NTS: " + nts + "\r\n" +
    "SERVER: " + SERVER_TOKEN + "\r\n" +
    "USN: " + buildUsn(target) + "\r\n\r\n"
  );
  try {
    (ssdpState.sender || ssdpState.listener).send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDRESS);
  } catch (error) {}
}

function sendByeByeAll() {
  var i;
  for (i = 0; i < SSDP_TARGETS.length; i += 1) {
    sendAliveOrBye(SSDP_TARGETS[i], "ssdp:byebye");
  }
}

process.on("SIGINT", function () {
  sendByeByeAll();
  setTimeout(function () {
    process.exit(0);
  }, 300);
});
process.on("SIGTERM", function () {
  sendByeByeAll();
  setTimeout(function () {
    process.exit(0);
  }, 300);
});

function buildUsn(target) {
  return target === DEVICE_UDN ? DEVICE_UDN : DEVICE_UDN + "::" + target;
}

/* ============================ SOAP: AVTransport ============================ */

function resolveSoapAction(req, body) {
  var header = String(req.headers.soapaction || "").replace(/"/g, "").trim();
  if (header) {
    return header;
  }
  var match = body.match(/<(\w+)[^>]*xmlns[^>]*>/);
  return match ? match[1] : "";
}

function handleAvTransportControl(action, body, res) {
  rateLimitLog("soap:" + action, 2500, "soap", "AVTransport action=" + action);
  if (endsWith(action, "#SetAVTransportURI")) {
    return handleSetAvTransportUri(body, false, res);
  }
  if (endsWith(action, "#SetNextAVTransportURI")) {
    return handleSetAvTransportUri(body, true, res);
  }
  if (endsWith(action, "#Play")) {
    if (state.currentMedia) {
      state.transportStatus = TRANSPORT_STATUS_OK;
      debugLog("soap", "Play (external)");
      setTransportState("PLAYING", "external");
    }
    return sendSoapResponse(res, emptyActionResponse("u:PlayResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#Pause")) {
    if (state.currentMedia) {
      setTransportState("PAUSED_PLAYBACK", "external");
    }
    return sendSoapResponse(res, emptyActionResponse("u:PauseResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#Stop")) {
    state.position = 0;
    state.lastPositionAt = Date.now();
    setTransportState(state.currentMedia ? "STOPPED" : "NO_MEDIA_PRESENT", "external");
    return sendSoapResponse(res, emptyActionResponse("u:StopResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#Seek")) {
    var target = extractTagValue(body, "Target");
    var seconds = parseTimeToSeconds(target);
    if (seconds >= 0 && state.currentMedia) {
      requestSeek(seconds, "external");
    }
    return sendSoapResponse(res, emptyActionResponse("u:SeekResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#Next")) {
    advanceQueue(1, { source: "external" });
    return sendSoapResponse(res, emptyActionResponse("u:NextResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#Previous")) {
    advanceQueue(-1, { source: "external" });
    return sendSoapResponse(res, emptyActionResponse("u:PreviousResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#SetPlayMode")) {
    var mode = (extractTagValue(body, "NewPlayMode") || "").toUpperCase();
    setPlayMode(mode);
    return sendSoapResponse(res, emptyActionResponse("u:SetPlayModeResponse", AVTRANSPORT_TYPE));
  }
  if (endsWith(action, "#GetTransportInfo")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetTransportInfoResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<CurrentTransportState>" + escapeXml(state.transportState) + "</CurrentTransportState>" +
      "<CurrentTransportStatus>" + escapeXml(state.transportStatus) + "</CurrentTransportStatus>" +
      "<CurrentSpeed>" + escapeXml(state.playbackSpeed) + "</CurrentSpeed>" +
      "</u:GetTransportInfoResponse>"
    ));
  }
  if (endsWith(action, "#GetPositionInfo")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetPositionInfoResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<Track>" + (state.currentMedia ? state.currentTrackIndex + 1 : 0) + "</Track>" +
      "<TrackDuration>" + formatSeconds(state.duration) + "</TrackDuration>" +
      "<TrackMetaData>" + escapeXml(buildDidlForMedia(state.currentMedia)) + "</TrackMetaData>" +
      "<TrackURI>" + escapeXml(currentMediaUrl()) + "</TrackURI>" +
      "<RelTime>" + formatSeconds(estimatePosition()) + "</RelTime>" +
      "<AbsTime>" + formatSeconds(estimatePosition()) + "</AbsTime>" +
      "<RelCount>2147483647</RelCount>" +
      "<AbsCount>2147483647</AbsCount>" +
      "</u:GetPositionInfoResponse>"
    ));
  }
  if (endsWith(action, "#GetMediaInfo")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetMediaInfoResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<NrTracks>" + Math.max(1, state.queue.length) + "</NrTracks>" +
      "<MediaDuration>" + formatSeconds(state.duration) + "</MediaDuration>" +
      "<CurrentURI>" + escapeXml(currentMediaUrl()) + "</CurrentURI>" +
      "<CurrentURIMetaData>" + escapeXml(buildDidlForMedia(state.currentMedia)) + "</CurrentURIMetaData>" +
      "<NextURI>" + escapeXml((state.nextMedia && state.nextMedia.url) || "") + "</NextURI>" +
      "<NextURIMetaData>" + escapeXml(buildDidlForMedia(state.nextMedia)) + "</NextURIMetaData>" +
      "<PlayMedium>NETWORK</PlayMedium>" +
      "<RecordMedium>NOT_IMPLEMENTED</RecordMedium>" +
      "<WriteStatus>NOT_IMPLEMENTED</WriteStatus>" +
      "</u:GetMediaInfoResponse>"
    ));
  }
  if (endsWith(action, "#GetDeviceCapabilities")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetDeviceCapabilitiesResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<PlayMedia>NETWORK</PlayMedia>" +
      "<RecMedia>NOT_IMPLEMENTED</RecMedia>" +
      "<RecQualityModes>NOT_IMPLEMENTED</RecQualityModes>" +
      "</u:GetDeviceCapabilitiesResponse>"
    ));
  }
  if (endsWith(action, "#GetTransportSettings")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetTransportSettingsResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<PlayMode>" + escapeXml(state.playMode) + "</PlayMode>" +
      "<RecQualityMode>NOT_IMPLEMENTED</RecQualityMode>" +
      "</u:GetTransportSettingsResponse>"
    ));
  }
  if (endsWith(action, "#GetCurrentTransportActions")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetCurrentTransportActionsResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<Actions>" + escapeXml(getCurrentTransportActions()) + "</Actions>" +
      "</u:GetCurrentTransportActionsResponse>"
    ));
  }
  if (endsWith(action, "#GetSearchCapabilities")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetSearchCapabilitiesResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<SearchCaps></SearchCaps>" +
      "</u:GetSearchCapabilitiesResponse>"
    ));
  }
  if (endsWith(action, "#GetSortCapabilities")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetSortCapabilitiesResponse xmlns:u=\"" + AVTRANSPORT_TYPE + "\">" +
      "<SortCaps></SortCaps>" +
      "</u:GetSortCapabilitiesResponse>"
    ));
  }
  return sendSoapResponse(res, buildSoapError("Unsupported or invalid action", 401));
}

function handleSetAvTransportUri(body, isNext, res) {
  var rawUri = extractTagValue(body, isNext ? "NextURI" : "CurrentURI");
  var metadataXml = extractTagValue(body, isNext ? "NextURIMetaData" : "CurrentURIMetaData");

  /* Tolerate sloppy controllers that stuff DIDL-Lite into the URI field:
   * recover the res URL from the embedded metadata. */
  if (/<DIDL-Lite|<res\b/i.test(rawUri) && !/^https?:\/\//i.test(rawUri.trim())) {
    if (!metadataXml) {
      metadataXml = rawUri;
    }
    var parsed = parseDidlMetadata(metadataXml, "");
    if (parsed.resUrl) {
      rawUri = parsed.resUrl;
    }
  }

  var media = buildMediaFromUpnp(rawUri, metadataXml);
  if (!media) {
    debugLog("soap", "SetAVTransportURI rejected: no usable media URI");
    return sendSoapResponse(res, buildSoapError("Invalid URI", 716));
  }

  debugLog("soap", "SetAVTransportURI(isNext=" + isNext + ") title=\"" + media.title +
    "\" type=" + media.mimeType + " subs=" + media.subtitles.length +
    " url=" + media.url.slice(0, 120));

  markExternalCommand();

  if (isNext) {
    state.nextMedia = media;
    if (state.queue.length === 0) {
      state.queue = [media];
      state.currentTrackIndex = 0;
      state.currentMedia = media;
    } else if (state.currentTrackIndex === state.queue.length - 1) {
      if (state.queue.length < MAX_QUEUE_LENGTH) {
        state.queue.push(media);
      } else {
        debugLog("soap", "queue full (" + MAX_QUEUE_LENGTH + "), SetNextAVTransportURI ignored");
      }
    } else {
      state.queue[state.currentTrackIndex + 1] = media;
    }
    touchState(["AVTransport"], true);
    return sendSoapResponse(res, emptyActionResponse("u:SetNextAVTransportURIResponse", AVTRANSPORT_TYPE));
  }

  state.queue = [media];
  state.currentTrackIndex = 0;
  state.currentMedia = media;
  state.nextMedia = null;
  state.position = 0;
  state.duration = media.duration || 0;
  state.transportState = "STOPPED";
  state.transportStatus = TRANSPORT_STATUS_OK;
  state.lastPositionAt = Date.now();
  touchState(["AVTransport", "ConnectionManager"], true);
  sendSoapResponse(res, emptyActionResponse("u:SetAVTransportURIResponse", AVTRANSPORT_TYPE));
}

/* ============================ SOAP: RenderingControl ============================ */

function handleRenderingControl(action, body, res) {
  if (endsWith(action, "#GetVolume")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetVolumeResponse xmlns:u=\"" + RENDERINGCONTROL_TYPE + "\">" +
      "<CurrentVolume>" + state.volume + "</CurrentVolume>" +
      "</u:GetVolumeResponse>"
    ));
  }
  if (endsWith(action, "#SetVolume")) {
    var desired = parseInt(extractTagValue(body, "DesiredVolume"), 10);
    if (!isNaN(desired)) {
      setVolume(clamp(desired, 0, 100));
    }
    return sendSoapResponse(res, emptyActionResponse("u:SetVolumeResponse", RENDERINGCONTROL_TYPE));
  }
  if (endsWith(action, "#GetMute")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetMuteResponse xmlns:u=\"" + RENDERINGCONTROL_TYPE + "\">" +
      "<CurrentMute>" + (state.mute ? 1 : 0) + "</CurrentMute>" +
      "</u:GetMuteResponse>"
    ));
  }
  if (endsWith(action, "#SetMute")) {
    setMute(extractTagValue(body, "DesiredMute") === "1");
    return sendSoapResponse(res, emptyActionResponse("u:SetMuteResponse", RENDERINGCONTROL_TYPE));
  }
  if (endsWith(action, "#ListPresets")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:ListPresetsResponse xmlns:u=\"" + RENDERINGCONTROL_TYPE + "\">" +
      "<CurrentPresetNameList>FactoryDefaults</CurrentPresetNameList>" +
      "</u:ListPresetsResponse>"
    ));
  }
  if (endsWith(action, "#SelectPreset")) {
    return sendSoapResponse(res, emptyActionResponse("u:SelectPresetResponse", RENDERINGCONTROL_TYPE));
  }
  return sendSoapResponse(res, buildSoapError("Unsupported or invalid action", 401));
}

/* ============================ SOAP: ConnectionManager ============================ */

function handleConnectionManagerControl(action, body, res) {
  if (endsWith(action, "#GetProtocolInfo")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetProtocolInfoResponse xmlns:u=\"" + CONNECTIONMANAGER_TYPE + "\">" +
      "<Source></Source>" +
      "<Sink>" + escapeXml(SINK_PROTOCOL_INFO) + "</Sink>" +
      "</u:GetProtocolInfoResponse>"
    ));
  }
  if (endsWith(action, "#GetCurrentConnectionIDs")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetCurrentConnectionIDsResponse xmlns:u=\"" + CONNECTIONMANAGER_TYPE + "\">" +
      "<ConnectionIDs>0</ConnectionIDs>" +
      "</u:GetCurrentConnectionIDsResponse>"
    ));
  }
  if (endsWith(action, "#GetCurrentConnectionInfo")) {
    return sendSoapResponse(res, soapEnvelope(
      "<u:GetCurrentConnectionInfoResponse xmlns:u=\"" + CONNECTIONMANAGER_TYPE + "\">" +
      "<RcsID>0</RcsID>" +
      "<AVTransportID>0</AVTransportID>" +
      "<ProtocolInfo>" + escapeXml(currentConnectionProtocolInfo()) + "</ProtocolInfo>" +
      "<PeerConnectionManager></PeerConnectionManager>" +
      "<PeerConnectionID>-1</PeerConnectionID>" +
      "<Direction>Input</Direction>" +
      "<Status>" + escapeXml(state.transportStatus === TRANSPORT_STATUS_ERROR ? "ERROR" : "OK") + "</Status>" +
      "</u:GetCurrentConnectionInfoResponse>"
    ));
  }
  return sendSoapResponse(res, buildSoapError("Unsupported or invalid action", 401));
}

/* ============================ GENA eventing ============================ */

function handleSubscribe(req, res, pathname) {
  var serviceName = EVENT_SERVICE_MAP[pathname];
  debugLog("gena", "SUBSCRIBE " + serviceName);
  var sid = req.headers.sid;
  var callbackHeader = req.headers.callback;
  var timeout = parseTimeoutHeader(req.headers.timeout);

  if (sid && subscribers[serviceName][sid]) {
    subscribers[serviceName][sid].expiresAt = Date.now() + timeout * 1000;
    res.writeHead(200, { SID: sid, TIMEOUT: "Second-" + timeout, SERVER: SERVER_TOKEN });
    return res.end();
  }

  if (!callbackHeader) {
    return sendPlain(res, 412, "Missing CALLBACK header");
  }
  var callbackUrls = callbackHeader.match(/<([^>]+)>/g);
  if (!callbackUrls || callbackUrls.length === 0) {
    return sendPlain(res, 412, "Invalid CALLBACK header");
  }

  sid = "uuid:" + crypto.randomBytes(16).toString("hex");
  subscribers[serviceName][sid] = {
    sid: sid,
    callbackUrl: callbackUrls[0].slice(1, -1),
    seq: 0,
    expiresAt: Date.now() + timeout * 1000
  };

  res.writeHead(200, { SID: sid, TIMEOUT: "Second-" + timeout, SERVER: SERVER_TOKEN });
  res.end();
  sendEventNotification(serviceName, subscribers[serviceName][sid], true);
}

function handleUnsubscribe(req, res, pathname) {
  var serviceName = EVENT_SERVICE_MAP[pathname];
  var sid = req.headers.sid;
  if (sid && subscribers[serviceName][sid]) {
    delete subscribers[serviceName][sid];
  }
  res.writeHead(200, { SERVER: SERVER_TOKEN });
  res.end();
}

function sweepSubscribers() {
  var names = Object.keys(subscribers);
  var i;
  var sids;
  var j;
  for (i = 0; i < names.length; i += 1) {
    sids = Object.keys(subscribers[names[i]]);
    for (j = 0; j < sids.length; j += 1) {
      if (subscribers[names[i]][sids[j]].expiresAt <= Date.now()) {
        delete subscribers[names[i]][sids[j]];
      }
    }
  }
}

function notifySubscribers(serviceName) {
  var sids = Object.keys(subscribers[serviceName]);
  var i;
  var subscription;
  for (i = 0; i < sids.length; i += 1) {
    subscription = subscribers[serviceName][sids[i]];
    if (subscription.expiresAt <= Date.now()) {
      delete subscribers[serviceName][sids[i]];
      continue;
    }
    sendEventNotification(serviceName, subscription, false);
  }
}

function sendEventNotification(serviceName, subscription, isInitial) {
  var body = buildEventPropertySet(serviceName);
  var target = url.parse(subscription.callbackUrl);
  if (DEBUG) {
    debugLog("gena", "NOTIFY " + serviceName + " seq=" + subscription.seq +
      " callback=" + subscription.callbackUrl.slice(0, 60));
  }
  var request = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: target.path || "/",
    method: "NOTIFY",
    headers: {
      HOST: target.host,
      "CONTENT-TYPE": "text/xml; charset=\"utf-8\"",
      NT: "upnp:event",
      NTS: "upnp:propchange",
      SID: subscription.sid,
      SEQ: isInitial ? 0 : subscription.seq,
      "CONTENT-LENGTH": Buffer.byteLength(body)
    }
  });
  request.setTimeout(5000, function () {
    request.abort();
  });
  request.on("error", function () {});
  request.end(body);
  subscription.seq = (subscription.seq + 1) % 4294967296;
}

function buildEventPropertySet(serviceName) {
  var payload;
  if (serviceName === "AVTransport") {
    payload = "<LastChange>" + escapeXml(buildAvTransportLastChange()) + "</LastChange>";
  } else if (serviceName === "RenderingControl") {
    payload = "<LastChange>" + escapeXml(buildRenderingControlLastChange()) + "</LastChange>";
  } else {
    payload =
      "<SourceProtocolInfo></SourceProtocolInfo>" +
      "<SinkProtocolInfo>" + escapeXml(SINK_PROTOCOL_INFO) + "</SinkProtocolInfo>" +
      "<CurrentConnectionIDs>0</CurrentConnectionIDs>";
  }

  return [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<e:propertyset xmlns:e=\"urn:schemas-upnp-org:event-1-0\">",
    "<e:property>",
    payload,
    "</e:property>",
    "</e:propertyset>"
  ].join("");
}

function buildAvTransportLastChange() {
  return [
    "<Event xmlns=\"" + AVTRANSPORT_TYPE + "\">",
    "<InstanceID val=\"0\">",
    "<TransportState val=\"" + escapeXml(state.transportState) + "\"/>",
    "<TransportStatus val=\"" + escapeXml(state.transportStatus) + "\"/>",
    "<PlaybackSpeed val=\"" + escapeXml(state.playbackSpeed) + "\"/>",
    "<PlayMode val=\"" + escapeXml(state.playMode) + "\"/>",
    "<NumberOfTracks val=\"" + Math.max(1, state.queue.length) + "\"/>",
    "<CurrentTrack val=\"" + (state.currentMedia ? state.currentTrackIndex + 1 : 0) + "\"/>",
    "<CurrentTrackDuration val=\"" + formatSeconds(state.duration) + "\"/>",
    "<CurrentMediaDuration val=\"" + formatSeconds(state.duration) + "\"/>",
    "<CurrentTrackURI val=\"" + escapeXml(currentMediaUrl()) + "\"/>",
    "<CurrentTrackMetaData val=\"" + escapeXml(buildDidlForMedia(state.currentMedia)) + "\"/>",
    "<AVTransportURI val=\"" + escapeXml(currentMediaUrl()) + "\"/>",
    "<AVTransportURIMetaData val=\"" + escapeXml(buildDidlForMedia(state.currentMedia)) + "\"/>",
    "<NextAVTransportURI val=\"" + escapeXml((state.nextMedia && state.nextMedia.url) || "") + "\"/>",
    "<CurrentTransportActions val=\"" + escapeXml(getCurrentTransportActions()) + "\"/>",
    "</InstanceID>",
    "</Event>"
  ].join("");
}

function buildRenderingControlLastChange() {
  return [
    "<Event xmlns=\"" + RENDERINGCONTROL_TYPE + "\">",
    "<InstanceID val=\"0\">",
    "<Volume channel=\"Master\" val=\"" + state.volume + "\"/>",
    "<Mute channel=\"Master\" val=\"" + (state.mute ? 1 : 0) + "\"/>",
    "</InstanceID>",
    "</Event>"
  ].join("");
}

/* ============================ Playback state machine ============================ */

function touchState(serviceNames, soapNotify) {
  state.rev += 1;
  state.lastUpdatedAt = new Date().toISOString();
  flushLongPollWaiters();
  if (soapNotify) {
    (serviceNames || []).forEach(notifySubscribers);
  }
}

function setTransportState(nextState, source) {
  if (TRANSPORT_STATES.indexOf(nextState) === -1 || state.transportState === nextState) {
    return;
  }
  debugLog("state", "transportState: " + state.transportState + " -> " + nextState +
    (source ? " (" + source + ")" : ""));
  state.transportState = nextState;
  if (source === "external") {
    markExternalCommand();
  }
  touchState(["AVTransport"], true);
}

function markExternalCommand() {
  state.lastExternalCommandAt = Date.now();
}

function requestSeek(seconds, source) {
  state.seekTarget = seconds;
  state.seekSeq += 1;
  state.position = seconds;
  state.lastPositionAt = Date.now();
  if (source === "external") {
    markExternalCommand();
    state.lastSeekCommandAt = Date.now();
  }
  touchState(["AVTransport"], true);
}

function setVolume(volume) {
  volume = clamp(volume, 0, 100);
  var changed = state.volume !== volume;
  state.volume = volume;
  if (changed) {
    markExternalCommand();
    touchState(["RenderingControl"], true);
  } else {
    touchState([], false);
  }
}

function setMute(mute) {
  var changed = state.mute !== mute;
  state.mute = !!mute;
  if (changed) {
    markExternalCommand();
    touchState(["RenderingControl"], true);
  } else {
    touchState([], false);
  }
}

function setPlayMode(mode) {
  mode = String(mode || "").toUpperCase();
  if (PLAY_MODES.indexOf(mode) === -1 || mode === state.playMode) {
    return;
  }
  state.playMode = mode;
  touchState(["AVTransport"], true);
}

function playSingleMedia(media, autoplay) {
  state.queue = [media];
  state.currentTrackIndex = 0;
  state.currentMedia = media;
  state.nextMedia = null;
  state.position = 0;
  state.duration = media.duration || 0;
  state.transportStatus = TRANSPORT_STATUS_OK;
  state.lastPositionAt = Date.now();
  state.transportState = autoplay ? "PLAYING" : "STOPPED";
  touchState(["AVTransport", "ConnectionManager"], true);
}

function replaceQueue(items, autoplay) {
  if (items.length > MAX_QUEUE_LENGTH) {
    debugLog("state", "queue truncated: " + items.length + " -> " + MAX_QUEUE_LENGTH);
    items = items.slice(0, MAX_QUEUE_LENGTH);
  }
  state.queue = items.map(function (item, index) {
    return normalizeMedia(item, item.title || ("Track " + (index + 1)));
  });
  state.currentTrackIndex = 0;
  state.currentMedia = state.queue[0] || null;
  state.nextMedia = state.queue[1] || null;
  state.position = 0;
  state.duration = state.currentMedia ? state.currentMedia.duration || 0 : 0;
  state.transportStatus = TRANSPORT_STATUS_OK;
  state.lastPositionAt = Date.now();
  state.transportState = autoplay && state.currentMedia ? "PLAYING" : (state.currentMedia ? "STOPPED" : "NO_MEDIA_PRESENT");
  touchState(["AVTransport"], true);
}

function jumpToTrack(index) {
  if (index < 0 || index >= state.queue.length) {
    return;
  }
  state.currentTrackIndex = index;
  state.currentMedia = state.queue[index];
  state.nextMedia = state.queue[index + 1] || null;
  state.position = 0;
  state.duration = state.currentMedia ? state.currentMedia.duration || 0 : 0;
  state.transportStatus = TRANSPORT_STATUS_OK;
  state.lastPositionAt = Date.now();
  state.transportState = state.currentMedia ? "PLAYING" : "NO_MEDIA_PRESENT";
  touchState(["AVTransport"], true);
}

function stopPlayback() {
  state.position = 0;
  state.lastPositionAt = Date.now();
  state.transportStatus = TRANSPORT_STATUS_OK;
  setTransportState(state.currentMedia ? "STOPPED" : "NO_MEDIA_PRESENT", "external");
}

function advanceQueue(delta, options) {
  options = options || {};
  if (state.queue.length === 0) {
    state.currentMedia = null;
    state.nextMedia = null;
    state.currentTrackIndex = 0;
    state.duration = 0;
    state.position = 0;
    state.transportState = "NO_MEDIA_PRESENT";
    return touchState(["AVTransport"], true);
  }

  var nextIndex;
  if (options.source === "auto" || state.playMode === "REPEAT_ALL" || state.playMode === "SHUFFLE" || state.playMode === "RANDOM") {
    if (state.playMode === "NORMAL" && options.source === "auto") {
      /* NORMAL auto-advance: stop after the last track. */
      if (state.currentTrackIndex + 1 < state.queue.length) {
        nextIndex = state.currentTrackIndex + 1;
      } else {
        state.transportState = "STOPPED";
        state.position = 0;
        state.lastPositionAt = Date.now();
        return touchState(["AVTransport"], true);
      }
    } else {
      nextIndex = pickAutoNextIndex();
    }
  } else {
    nextIndex = clamp(state.currentTrackIndex + delta, 0, state.queue.length - 1);
    if (nextIndex === state.currentTrackIndex && delta > 0) {
      /* NORMAL mode + Next on the last track: treat as Stop. */
      state.transportState = "STOPPED";
      state.position = 0;
      state.lastPositionAt = Date.now();
      return touchState(["AVTransport"], true);
    }
  }

  state.currentTrackIndex = nextIndex;
  state.currentMedia = state.queue[nextIndex] || null;
  state.nextMedia = state.queue[nextIndex + 1] || null;
  state.position = 0;
  state.duration = state.currentMedia ? state.currentMedia.duration || 0 : 0;
  state.transportStatus = TRANSPORT_STATUS_OK;
  state.lastPositionAt = Date.now();
  state.transportState = state.currentMedia ? "PLAYING" : "NO_MEDIA_PRESENT";
  touchState(["AVTransport"], true);
}

function pickAutoNextIndex() {
  if (state.queue.length === 1) {
    return state.currentTrackIndex;
  }
  if (state.playMode === "SHUFFLE" || state.playMode === "RANDOM") {
    var next = state.currentTrackIndex;
    while (next === state.currentTrackIndex) {
      next = Math.floor(Math.random() * state.queue.length);
    }
    return next;
  }
  return (state.currentTrackIndex + 1) % state.queue.length;
}

/**
 * State updates reported by the front-end player.
 *
 * Debounce rule: an explicit controller command (Play/Pause/Seek) within
 * the last 3 seconds always wins over front-end reports, so that a remote
 * pause and the local heartbeat cannot fight each other.
 */
function applyRendererStateUpdate(payload, light) {
  var now = Date.now();
  var notifyServices = [];
  var soapNotify = false;
  var recentCommand = now - state.lastExternalCommandAt < 3000;
  var recentSeek = now - state.lastSeekCommandAt < 4000;

  if (typeof payload.position === "number" && isFinite(payload.position) && !recentSeek) {
    state.position = Math.max(0, Math.floor(payload.position));
    state.lastPositionAt = now;
  }

  if (typeof payload.duration === "number" && isFinite(payload.duration) && payload.duration > 0) {
    if (Math.floor(payload.duration) !== state.duration) {
      state.duration = Math.max(0, Math.floor(payload.duration));
      notifyServices.push("AVTransport");
      soapNotify = true;
    }
  }

  if (payload.transportState && TRANSPORT_STATES.indexOf(payload.transportState) !== -1) {
    if ((payload.force === true || !recentCommand) && payload.transportState !== state.transportState) {
      state.transportState = payload.transportState;
      notifyServices.push("AVTransport");
      soapNotify = true;
    }
  }

  if (payload.transportStatus === TRANSPORT_STATUS_ERROR || payload.transportStatus === TRANSPORT_STATUS_OK) {
    if (payload.transportStatus !== state.transportStatus) {
      state.transportStatus = payload.transportStatus;
      notifyServices.push("AVTransport");
      soapNotify = true;
    }
  }

  if (typeof payload.volume === "number" && isFinite(payload.volume)) {
    var volume = clamp(Math.floor(payload.volume), 0, 100);
    if (!recentCommand && volume !== state.volume) {
      state.volume = volume;
      notifyServices.push("RenderingControl");
      soapNotify = true;
    }
  }

  if (typeof payload.mute === "boolean" && !recentCommand && payload.mute !== state.mute) {
    state.mute = payload.mute;
    notifyServices.push("RenderingControl");
    soapNotify = true;
  }

  if (typeof payload.appLuna === "boolean") {
    state.appLuna = payload.appLuna;
  }
  if (typeof payload.appBridge === "string") {
    state.appBridge = payload.appBridge;
  }

  if (payload.mediaEnded) {
    applyAutoAdvance();
  }

  touchState(notifyServices, soapNotify);
  return buildStatusFor(light);
}

function applyAutoAdvance() {
  if (state.queue.length === 0) {
    return;
  }
  if (state.playMode === "REPEAT_ONE") {
    state.position = 0;
    state.lastPositionAt = Date.now();
    state.transportState = "PLAYING";
    return;
  }
  advanceQueue(1, { source: "auto" });
}

function trackController(req) {
  var userAgent = String(req.headers["user-agent"] || "");
  var address = (req.socket && req.socket.remoteAddress) || "";
  var now = Date.now();

  if (!state.controller || state.controller.address !== address) {
    state.controller = {
      address: address,
      userAgent: userAgent,
      name: guessControllerName(userAgent),
      since: new Date().toISOString()
    };
    touchState([], false);
  } else {
    state.controller.lastSeenAt = now;
  }
}

function guessControllerName(userAgent) {
  var ua = String(userAgent || "");
  var map = [
    ["iqiyi", "爱奇艺"], ["qiyi", "爱奇艺"],
    ["bilibili", "哔哩哔哩"],
    ["youku", "优酷"],
    ["qqmusic", "QQ音乐"], ["tencent", "腾讯视频"], ["qqbrowser", "QQ浏览器"],
    ["netease", "网易云音乐"],
    ["migu", "咪咕"],
    ["sohu", "搜狐视频"],
    ["lebo", "LeBo Cast"], ["happycast", "LeBo Cast"],
    ["bubbleupnp", "BubbleUPnP"],
    ["kodi", "Kodi"],
    ["airplay", "AirPlay"]
  ];
  var lower = ua.toLowerCase();
  var i;
  for (i = 0; i < map.length; i += 1) {
    if (lower.indexOf(map[i][0]) !== -1) {
      return map[i][1];
    }
  }
  if (ua) {
    return "LAN device";
  }
  return "Unknown device";
}

/* ============================ Media metadata ============================ */

function buildMediaFromUpnp(rawUri, metadataXml) {
  var mediaUrl = rawUri;
  var parsed = parseDidlMetadata(metadataXml || "", mediaUrl);

  if (!mediaUrl && parsed.resUrl) {
    mediaUrl = parsed.resUrl;
  }
  if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
    return null;
  }

  return normalizeMedia({
    url: mediaUrl,
    title: parsed.title,
    mimeType: parsed.mimeType,
    duration: parsed.duration,
    subtitles: parsed.subtitles,
    albumArtUrl: parsed.albumArtUrl,
    className: parsed.className,
    artist: parsed.artist,
    album: parsed.album,
    description: parsed.description
  }, parsed.title || "Cast media");
}

function normalizeMedia(payload, fallbackTitle) {
  var mediaUrl = payload.url || "";
  var mimeType = payload.mimeType && payload.mimeType !== "*/*" ? payload.mimeType : guessMimeType(mediaUrl);
  var subtitles = Array.isArray(payload.subtitles) ? payload.subtitles.map(normalizeSubtitle) : [];

  return {
    url: mediaUrl,
    title: (payload.title || fallbackTitle || "Cast media").slice(0, 200),
    mimeType: mimeType,
    mediaType: inferMediaType(mimeType, payload.className, mediaUrl),
    duration: typeof payload.duration === "number" && payload.duration > 0 ? Math.floor(payload.duration) : 0,
    subtitles: subtitles,
    albumArtUrl: payload.albumArtUrl || "",
    className: payload.className || "",
    artist: payload.artist || "",
    album: payload.album || "",
    description: payload.description || ""
  };
}

function normalizeSubtitle(item) {
  var url = item.url || "";
  return {
    url: url,
    label: item.label || "Subtitle",
    srclang: item.srclang || "zh",
    kind: item.kind || "subtitles",
    mimeType: item.mimeType || guessMimeType(url)
  };
}

function parseDidlMetadata(xml, mediaUrl) {
  var result = {
    title: "",
    mimeType: "",
    duration: 0,
    subtitles: [],
    albumArtUrl: "",
    className: "",
    artist: "",
    album: "",
    description: "",
    resUrl: ""
  };
  if (!xml) {
    result.title = titleFromUrl(mediaUrl);
    return result;
  }

  result.title = extractTagValue(xml, "dc:title") || extractTagValue(xml, "title") || titleFromUrl(mediaUrl);
  result.className = extractTagValue(xml, "upnp:class");
  result.albumArtUrl = extractTagValue(xml, "upnp:albumArtURI");
  result.artist = extractTagValue(xml, "upnp:artist") || extractTagValue(xml, "dc:creator");
  result.album = extractTagValue(xml, "upnp:album");
  result.description = extractTagValue(xml, "dc:description");

  var resMatch = xml.match(/<res\b([^>]*)>([\s\S]*?)<\/res>/i);
  if (resMatch) {
    var attrs = resMatch[1] || "";
    var protocolMatch = attrs.match(/protocolInfo\s*=\s*"([^"]*)"/i);
    if (protocolMatch) {
      var parts = protocolMatch[1].split(":");
      if (parts.length >= 3 && parts[2] && parts[2] !== "*") {
        result.mimeType = parts[2];
      }
    }
    var durationMatch = attrs.match(/duration\s*=\s*"([^"]*)"/i);
    if (durationMatch) {
      result.duration = parseTimeToSeconds(durationMatch[1]);
    }
    result.resUrl = decodeXml((resMatch[2] || "").trim());
  }

  result.subtitles = extractSubtitles(xml);
  return result;
}

function extractSubtitles(xml) {
  var items = [];
  var regex = /<(?:sec:CaptionInfoEx|sec:CaptionInfo|pv:subtitleFileUri)\b([^>]*)>([\s\S]*?)<\/(?:sec:CaptionInfoEx|sec:CaptionInfo|pv:subtitleFileUri)>/ig;
  var match;
  while ((match = regex.exec(xml))) {
    var subtitleUrl = decodeXml((match[2] || "").trim());
    if (!subtitleUrl || !/^https?:\/\//i.test(subtitleUrl)) {
      continue;
    }
    var typeAttr = (match[1] || "").match(/(?:sec:)?type\s*=\s*"([^"]*)"/i);
    items.push(normalizeSubtitle({
      url: subtitleUrl,
      label: "Subtitle " + (items.length + 1),
      mimeType: subtitleMimeFromType(typeAttr ? typeAttr[1] : "", subtitleUrl)
    }));
  }
  return items;
}

function subtitleMimeFromType(type, subtitleUrl) {
  if (/srt/i.test(type)) {
    return "application/x-subrip";
  }
  if (/vtt|w3tt/i.test(type)) {
    return "text/vtt";
  }
  return guessMimeType(subtitleUrl);
}

function guessMimeType(mediaUrl) {
  mediaUrl = String(mediaUrl || "").split("?")[0];
  if (/\.m3u8$/i.test(mediaUrl)) {
    return "application/vnd.apple.mpegurl";
  }
  if (/\.mp4$|\.m4v$/i.test(mediaUrl)) {
    return "video/mp4";
  }
  if (/\.mkv$/i.test(mediaUrl)) {
    return "video/x-matroska";
  }
  if (/\.ts$/i.test(mediaUrl)) {
    return "video/mp2t";
  }
  if (/\.mov$/i.test(mediaUrl)) {
    return "video/quicktime";
  }
  if (/\.3gp$|\.3g2$/i.test(mediaUrl)) {
    return "video/3gpp";
  }
  if (/\.webm$/i.test(mediaUrl)) {
    return "video/webm";
  }
  if (/\.mp3$/i.test(mediaUrl)) {
    return "audio/mpeg";
  }
  if (/\.m4a$/i.test(mediaUrl)) {
    return "audio/mp4";
  }
  if (/\.aac$/i.test(mediaUrl)) {
    return "audio/aac";
  }
  if (/\.flac$/i.test(mediaUrl)) {
    return "audio/flac";
  }
  if (/\.wav$/i.test(mediaUrl)) {
    return "audio/wav";
  }
  if (/\.ogg$|\.opus$/i.test(mediaUrl)) {
    return "audio/ogg";
  }
  if (/\.jpe?g$/i.test(mediaUrl)) {
    return "image/jpeg";
  }
  if (/\.png$/i.test(mediaUrl)) {
    return "image/png";
  }
  if (/\.gif$/i.test(mediaUrl)) {
    return "image/gif";
  }
  if (/\.bmp$/i.test(mediaUrl)) {
    return "image/bmp";
  }
  if (/\.webp$/i.test(mediaUrl)) {
    return "image/webp";
  }
  if (/\.vtt$/i.test(mediaUrl)) {
    return "text/vtt";
  }
  if (/\.srt$/i.test(mediaUrl)) {
    return "application/x-subrip";
  }
  return "video/mp4";
}

function inferMediaType(mimeType, className, mediaUrl) {
  mimeType = String(mimeType || "");
  className = String(className || "");
  if (/^audio\//i.test(mimeType) || /audioitem/i.test(className)) {
    return "audio";
  }
  if (/^image\//i.test(mimeType) || /imageitem|photo/i.test(className) || /\.(png|jpe?g|gif|bmp|webp)($|\?)/i.test(mediaUrl || "")) {
    return "image";
  }
  return "video";
}

function titleFromUrl(mediaUrl) {
  try {
    var withoutQuery = String(mediaUrl || "").split("?")[0];
    var parts = withoutQuery.split("/");
    var name = decodeURIComponent(parts[parts.length - 1] || "");
    name = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_+.]/g, " ").trim();
    return name.slice(0, 120);
  } catch (error) {
    return "";
  }
}

function buildDidlForMedia(media) {
  if (!media) {
    return "";
  }

  var subtitleXml = (media.subtitles || []).map(function (subtitle) {
    var type = /subrip/i.test(subtitle.mimeType) ? "srt" : "vtt";
    return "<sec:CaptionInfoEx sec:type=\"" + type + "\">" + escapeXml(subtitle.url) + "</sec:CaptionInfoEx>";
  }).join("");

  return [
    "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns:sec=\"http://www.sec.co.kr/\">",
    "<item id=\"0\" parentID=\"0\" restricted=\"1\">",
    "<dc:title>" + escapeXml(media.title) + "</dc:title>",
    "<upnp:class>" + escapeXml(media.className || mediaTypeToUpnpClass(media.mediaType)) + "</upnp:class>",
    media.artist ? "<upnp:artist>" + escapeXml(media.artist) + "</upnp:artist>" : "",
    media.album ? "<upnp:album>" + escapeXml(media.album) + "</upnp:album>" : "",
    media.albumArtUrl ? "<upnp:albumArtURI>" + escapeXml(media.albumArtUrl) + "</upnp:albumArtURI>" : "",
    media.description ? "<dc:description>" + escapeXml(media.description) + "</dc:description>" : "",
    "<res protocolInfo=\"http-get:*:" + escapeXml(media.mimeType) + ":*\"" +
      (media.duration ? " duration=\"" + formatSeconds(media.duration) + "\"" : "") + ">" +
      escapeXml(media.url) + "</res>",
    subtitleXml,
    "</item>",
    "</DIDL-Lite>"
  ].join("");
}

function mediaTypeToUpnpClass(mediaType) {
  if (mediaType === "audio") {
    return "object.item.audioItem.musicTrack";
  }
  if (mediaType === "image") {
    return "object.item.imageItem.photo";
  }
  return "object.item.videoItem";
}

function currentMediaUrl() {
  return (state.currentMedia && state.currentMedia.url) || "";
}

function currentConnectionProtocolInfo() {
  return state.currentMedia && state.currentMedia.mimeType
    ? "http-get:*:" + state.currentMedia.mimeType + ":*"
    : "";
}

function getCurrentTransportActions() {
  var actions = [];
  if (state.currentMedia) {
    actions.push("Play", "Stop", "Pause", "Seek");
    if (state.currentTrackIndex < state.queue.length - 1 || state.playMode !== "NORMAL") {
      actions.push("Next");
    }
    if (state.currentTrackIndex > 0 || state.playMode !== "NORMAL") {
      actions.push("Previous");
    }
  }
  return actions.join(",");
}

function estimatePosition() {
  var position = state.position;
  if (state.transportState === "PLAYING") {
    position += (Date.now() - state.lastPositionAt) / 1000;
  }
  if (state.duration > 0) {
    position = Math.min(position, state.duration);
  }
  return Math.max(0, position);
}

/* ============================ AirPlay capability probe ============================ */

/*
 * Chinese-mainland ("CN") LG TVs ship without the licensed AirPlay receiver
 * stack; there is no hidden switch an app could flip to re-enable it.
 * What this service does instead is DETECT whether the stack exists on the
 * running TV, using three independent signals:
 *
 *   1. mDNS/DNS-SD legacy query for `_airplay._tcp` / `_raop._tcp` responders.
 *      NOTE: a responder on the LAN may also be another device (e.g. an
 *      iPhone or Mac), so mDNS alone is diagnostic only.
 *   2. TCP probe of the local AirPlay ports: 7000 (RTSP), 7001, 7100.
 *      An open local port is the strongest "stack present" signal.
 *   3. Filesystem check for typical receiver binaries/marker files.
 *
 * The verdict is stored in state.airplay and served via /status so the TV
 * front-end can tell the user whether real AirPlay is available on this box.
 */

var AIRPLAY_FILE_CANDIDATES = [
  "/usr/sbin/airplayd",
  "/usr/bin/airplayd",
  "/usr/sbin/raopd",
  "/usr/bin/raopd",
  "/usr/libexec/airplayd",
  "/var/luna/preferences/airplay",
  "/media/cryptofs/apps/usr/bin/airplayd"
];

var airplayProbeInFlight = false;

function runAirplayProbe() {
  if (airplayProbeInFlight) {
    return;
  }
  airplayProbeInFlight = true;
  debugLog("airplay", "probe started");
  var result = {
    verdict: "absent",
    probedAt: new Date().toISOString(),
    mdns: { airplaySeen: false, raopSeen: false, services: [], responders: [] },
    tcp: { port7000: false, port7001: false, port7100: false },
    files: [],
    detail: ""
  };

  var sectionsPending = 3;
  var sectionDone = function () {
    sectionsPending -= 1;
    if (sectionsPending > 0) {
      return;
    }

    if (result.tcp.port7000 || result.tcp.port7001 || result.tcp.port7100) {
      result.verdict = "present";
      result.detail = "AirPlay receiver is listening on this TV (local port " +
        (result.tcp.port7000 ? "7000" : (result.tcp.port7001 ? "7001" : "7100")) +
        "). Apple devices can cast directly.";
    } else if (result.files.length > 0) {
      result.verdict = "partial";
      result.detail = "AirPlay-related files exist but no receiver is listening.";
    } else if (result.mdns.airplaySeen || result.mdns.raopSeen) {
      result.verdict = "absent";
      result.detail = "No local AirPlay stack. A responder was seen on the LAN, " +
        "but it belongs to another device.";
    } else {
      result.verdict = "absent";
      result.detail = "This TV ships without the licensed AirPlay stack " +
        "(CN models). Use DLNA casting instead.";
    }

    state.airplay = result;
    airplayProbeInFlight = false;
    touchState([], false);
    debugLog("airplay", "verdict=" + result.verdict +
      " tcp7000=" + result.tcp.port7000 +
      " mdnsAirplay=" + result.mdns.airplaySeen +
      " mdnsRaop=" + result.mdns.raopSeen +
      " files=" + result.files.length);
  };

  probeAirplayMdns(result, sectionDone);
  probeAirplayTcp(result, sectionDone);
  probeAirplayFiles(result, sectionDone);
}

/* --- mDNS/DNS-SD legacy unicast query --- */

function probeAirplayMdns(result, done) {
  var socket = dgram.createSocket("udp4");
  var closed = false;

  var closeOnce = function () {
    if (closed) {
      return;
    }
    closed = true;
    try {
      socket.close();
    } catch (error) {}
    done();
  };

  socket.on("error", function () {
    closeOnce();
  });

  socket.on("message", function (msg) {
    try {
      parseMdnsResponse(msg, result);
    } catch (error) {
      debugLog("airplay", "mdns parse error: " + error.message);
    }
  });

  var query = buildMdnsQuery(["_airplay._tcp.local", "_raop._tcp.local"]);
  socket.send(query, 0, query.length, 5353, "224.0.0.251", function () {});
  setTimeout(closeOnce, 2500);
}

function buildMdnsQuery(names) {
  var bytes = [
    0x00, 0x00, /* transaction id */
    0x00, 0x00, /* flags: standard query */
    0x00, names.length,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ];
  var i;
  var j;
  for (i = 0; i < names.length; i += 1) {
    var labels = names[i].split(".");
    for (j = 0; j < labels.length; j += 1) {
      bytes.push(labels[j].length);
      var labelBytes = Buffer.from ? Buffer.from(labels[j], "ascii") : new Buffer(labels[j], "ascii");
      for (var k = 0; k < labelBytes.length; k += 1) {
        bytes.push(labelBytes[k]);
      }
    }
    bytes.push(0x00);
    bytes.push(0x00, 0x0C); /* QTYPE = PTR */
    bytes.push(0x00, 0x01); /* QCLASS = IN */
  }
  return toBuffer(bytes);
}

function parseMdnsResponse(msg, result) {
  var offset = 12; /* skip header */
  var qdcount = msg.readUInt16BE(4);
  var ancount = msg.readUInt16BE(6);

  var i;
  for (i = 0; i < qdcount; i += 1) {
    var q = readDnsName(msg, offset);
    offset = q.end + 4; /* qtype + qclass */
  }

  for (i = 0; i < ancount && offset < msg.length; i += 1) {
    var answer = readDnsName(msg, offset);
    offset = answer.end;
    if (offset + 10 > msg.length) {
      break;
    }
    var type = msg.readUInt16BE(offset);
    var rdlength = msg.readUInt16BE(offset + 8);
    var rdata = offset + 10;
    offset = rdata + rdlength;

    if (type === 12 && rdlength > 0) { /* PTR */
      var ptr = readDnsName(msg, rdata);
      var target = ptr.name || "";
      if (target.indexOf("_airplay._tcp") !== -1) {
        result.mdns.airplaySeen = true;
        if (result.mdns.services.indexOf(target) === -1) {
          result.mdns.services.push(target);
        }
      } else if (target.indexOf("_raop._tcp") !== -1) {
        result.mdns.raopSeen = true;
        if (result.mdns.services.indexOf(target) === -1) {
          result.mdns.services.push(target);
        }
      }
    } else if (type === 1 && rdlength === 4) { /* A */
      result.mdns.responders.push(
        msg[rdata] + "." + msg[rdata + 1] + "." + msg[rdata + 2] + "." + msg[rdata + 3]
      );
    }
  }
}

function readDnsName(msg, offset) {
  var labels = [];
  var jumped = false;
  var end = offset;
  var guard = 0;

  while (guard < 64) {
    guard += 1;
    var len = msg[offset];
    if (len === 0) {
      offset += 1;
      if (!jumped) {
        end = offset;
      }
      break;
    }
    if ((len & 0xC0) === 0xC0) {
      if (!jumped) {
        end = offset + 2;
      }
      offset = ((len & 0x3F) << 8) | msg[offset + 1];
      jumped = true;
      continue;
    }
    labels.push(msg.toString("utf8", offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  return { name: labels.join("."), end: end };
}

/* --- Local TCP port probe --- */

function probeAirplayTcp(result, done) {
  var ports = [7000, 7001, 7100];
  var socketsPending = ports.length;

  var socketDone = function () {
    socketsPending -= 1;
    if (socketsPending === 0) {
      done();
    }
  };

  ports.forEach(function (port) {
    var settled = false;
    var settle = function (open) {
      if (settled) {
        return;
      }
      settled = true;
      if (open) {
        result.tcp["port" + port] = true;
        debugLog("airplay", "local port " + port + " is open");
      }
      try {
        socket.destroy();
      } catch (error) {}
      socketDone();
    };

    var socket = net.connect(port, "127.0.0.1", function () {
      settle(true);
    });
    socket.setTimeout(700, function () {
      settle(false);
    });
    socket.on("error", function () {
      settle(false);
    });
  });
}

/* --- Filesystem probe --- */

function probeAirplayFiles(result, done) {
  var i;
  for (i = 0; i < AIRPLAY_FILE_CANDIDATES.length; i += 1) {
    try {
      if (fs.existsSync(AIRPLAY_FILE_CANDIDATES[i])) {
        result.files.push(AIRPLAY_FILE_CANDIDATES[i]);
        debugLog("airplay", "found file: " + AIRPLAY_FILE_CANDIDATES[i]);
      }
    } catch (error) {}
  }
  done();
}

/* ============================ Status output ============================ */

function buildStatus() {
  return {
    returnValue: true,
    rev: state.rev,
    transportState: state.transportState,
    transportStatus: state.transportStatus,
    playbackSpeed: state.playbackSpeed,
    playMode: state.playMode,
    volume: state.volume,
    mute: state.mute,
    duration: state.duration,
    position: Math.floor(estimatePosition()),
    seekTarget: state.seekTarget,
    seekSeq: state.seekSeq,
    queueLength: state.queue.length,
    currentTrackIndex: state.currentTrackIndex,
    currentMedia: state.currentMedia,
    nextMedia: state.nextMedia,
    queue: state.queue,
    controller: state.controller,
    appLuna: state.appLuna,
    appBridge: state.appBridge,
    customName: state.customName,
    nameCustom: state.nameCustom,
    wifi: {
      ssid: state.wifi.ssid,
      hasPassword: !!state.wifi.password,
      ssidCustom: state.wifi.ssidCustom
    },
    airplay: state.airplay,
    service: buildServiceInfo(),
    lastUpdatedAt: state.lastUpdatedAt
  };
}

/* Lightweight status for the TV front-end: it never renders the queue,
 * so skip that (potentially large) array on every poll. */
function buildStatusFor(light) {
  var status = buildStatus();
  if (light) {
    delete status.queue;
  }
  return status;
}

function buildInfo() {
  return {
    returnValue: true,
    service: buildServiceInfo(),
    transportState: state.transportState,
    currentMedia: state.currentMedia,
    airplay: state.airplay
  };
}

function buildServiceInfo() {
  var ip = getLocalIp();
  return {
    name: DEVICE_NAME,
    friendlyName: DEVICE_NAME,
    ip: ip,
    port: HTTP_PORT,
    base: "http://" + ip + ":" + HTTP_PORT,
    udn: DEVICE_UDN,
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    ssdpBound: ssdpState.bound,
    ssdpDegraded: ssdpState.degraded,
    remoteUrl: "http://" + ip + ":" + HTTP_PORT + "/"
  };
}

/* ============================ Device description & SCPD ============================ */

function buildDeviceDescription() {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<root xmlns=\"urn:schemas-upnp-org:device-1-0\" xmlns:dlna=\"urn:schemas-dlna-org:device-1-0\">",
    "<specVersion><major>1</major><minor>0</minor></specVersion>",
    "<URLBase>" + escapeXml(getServiceBase()) + "/</URLBase>",
    "<device>",
    "<deviceType>" + DEVICE_TYPE + "</deviceType>",
    "<friendlyName>" + escapeXml(DEVICE_NAME) + "</friendlyName>",
    "<manufacturer>CastReceiver Project</manufacturer>",
    "<modelDescription>webOS TV DLNA cast renderer</modelDescription>",
    "<modelName>webOS TV Cast Receiver</modelName>",
    "<modelNumber>" + VERSION + "</modelNumber>",
    "<serialNumber>" + DEVICE_UDN.slice(5, 21) + "</serialNumber>",
    "<UDN>" + DEVICE_UDN + "</UDN>",
    "<dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>",
    "<serviceList>",
    buildServiceDescription(AVTRANSPORT_TYPE, "AVTransport", "/upnp/control/AVTransport", "/upnp/event/AVTransport", "/upnp/scpd/AVTransport.xml"),
    buildServiceDescription(RENDERINGCONTROL_TYPE, "RenderingControl", "/upnp/control/RenderingControl", "/upnp/event/RenderingControl", "/upnp/scpd/RenderingControl.xml"),
    buildServiceDescription(CONNECTIONMANAGER_TYPE, "ConnectionManager", "/upnp/control/ConnectionManager", "/upnp/event/ConnectionManager", "/upnp/scpd/ConnectionManager.xml"),
    "</serviceList>",
    "</device>",
    "</root>"
  ].join("");
}

function buildServiceDescription(type, id, controlUrl, eventUrl, scpdUrl) {
  return [
    "<service>",
    "<serviceType>" + type + "</serviceType>",
    "<serviceId>urn:upnp-org:serviceId:" + id + "</serviceId>",
    "<controlURL>" + controlUrl + "</controlURL>",
    "<eventSubURL>" + eventUrl + "</eventSubURL>",
    "<SCPDURL>" + scpdUrl + "</SCPDURL>",
    "</service>"
  ].join("");
}

/* ============================ SOAP output ============================ */

function soapEnvelope(innerXml) {
  return [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">",
    "<s:Body>",
    innerXml,
    "</s:Body>",
    "</s:Envelope>"
  ].join("");
}

function emptyActionResponse(actionName, serviceType) {
  return soapEnvelope("<" + actionName + " xmlns:u=\"" + serviceType + "\"/>");
}

function buildSoapError(message, code) {
  return soapEnvelope(
    "<s:Fault>" +
    "<faultcode>s:Client</faultcode>" +
    "<faultstring>UPnPError</faultstring>" +
    "<detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\">" +
    "<errorCode>" + (code || 402) + "</errorCode>" +
    "<errorDescription>" + escapeXml(message) + "</errorDescription>" +
    "</UPnPError></detail>" +
    "</s:Fault>"
  );
}

function sendSoapResponse(res, payload) {
  res.writeHead(200, {
    "Content-Type": "text/xml; charset=\"utf-8\"",
    "Content-Length": Buffer.byteLength(payload),
    SERVER: SERVER_TOKEN,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload);
}

/* ============================ Common output helpers ============================ */

function sendXml(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/xml; charset=\"utf-8\"",
    "Content-Length": Buffer.byteLength(payload),
    SERVER: SERVER_TOKEN,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload);
}

function sendJson(res, statusCode, payload) {
  var body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function sendPlain(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload);
}

function sendOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,SUBSCRIBE,UNSUBSCRIBE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,SOAPACTION,CALLBACK,NT,SID,TIMEOUT,Range",
    "Access-Control-Max-Age": "600"
  });
  res.end();
}

function readRequestBody(req, maxBytes, callback) {
  var chunks = [];
  var size = 0;
  var aborted = false;
  req.on("data", function (chunk) {
    if (aborted) {
      return;
    }
    size += chunk.length;
    if (size > maxBytes) {
      aborted = true;
      return callback(null, true);
    }
    chunks.push(chunk);
  });
  req.on("end", function () {
    if (!aborted) {
      callback(Buffer.concat(chunks).toString("utf8"), false);
    }
  });
  req.on("error", function () {
    if (!aborted) {
      aborted = true;
      callback(null, true);
    }
  });
}

/* ============================ Utility functions ============================ */

function debugLog(category, message) {
  if (!DEBUG) {
    return;
  }
  console.log("[castreceiver][" + category + "] " + message);
}

/* Rate-limited debug log for high-frequency events (status polls,
 * M-SEARCH storms): skip identical keys within the window. */
var debugRateMap = {};

function rateLimitLog(key, windowMs, category, message) {
  var now = Date.now();
  if (debugRateMap[key] && now - debugRateMap[key] < windowMs) {
    return;
  }
  debugRateMap[key] = now;
  debugLog(category, message);
}

function toBuffer(text) {
  if (typeof Buffer.from === "function") {
    return Buffer.from(text, "utf8");
  }
  return new Buffer(text, "utf8");
}

function getServiceBase() {
  var ip = getLocalIp();
  if (serviceBaseCache.base === "" || serviceBaseCache.ip !== ip) {
    serviceBaseCache.ip = ip;
    serviceBaseCache.base = "http://" + ip + ":" + HTTP_PORT;
  }
  return serviceBaseCache.base;
}

function getLocalIp() {
  var now = Date.now();
  if (now - localIpCache.at < 10000 && localIpCache.ip !== "127.0.0.1") {
    return localIpCache.ip;
  }

  var best = null;
  var bestScore = -1;
  var interfaces = os.networkInterfaces();
  var names = Object.keys(interfaces);
  var i;
  var j;
  for (i = 0; i < names.length; i += 1) {
    var entries = interfaces[names[i]] || [];
    for (j = 0; j < entries.length; j += 1) {
      var entry = entries[j];
      var family = entry.family === "IPv4" || entry.family === 4 ? "IPv4" : "";
      if (!family || entry.internal) {
        continue;
      }
      var score = 0;
      if (/^192\.168\./.test(entry.address)) {
        score = 3;
      } else if (/^10\./.test(entry.address)) {
        score = 2;
      } else if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(entry.address)) {
        score = 2;
      } else {
        score = 1;
      }
      if (/wlan|wifi|wlp|en0/i.test(names[i]) && score > 0) {
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = entry.address;
      }
    }
  }

  var ip = best || "127.0.0.1";
  if (ip !== localIpCache.ip) {
    localIpCache.ip = ip;
    serviceBaseCache.base = "";
    /* Re-broadcast soon after an IP change so controllers do not keep a
     * stale LOCATION. */
    scheduleAliveBurst(0);
  }
  localIpCache.at = now;
  return ip;
}

function extractTagValue(xml, tagName) {
  var match = String(xml || "").match(new RegExp("<" + escapeRegExp(tagName) + "[^>]*>([\\s\\S]*?)</" + escapeRegExp(tagName) + ">", "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function parseTimeToSeconds(value) {
  var text = String(value || "").trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.floor(parseFloat(text));
  }
  var parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return 0;
  }
  var seconds = 0;
  var i;
  for (i = 0; i < parts.length; i += 1) {
    var num = parseFloat(parts[i]);
    if (isNaN(num)) {
      return 0;
    }
    seconds = seconds * 60 + num;
  }
  return Math.floor(seconds);
}

function formatSeconds(totalSeconds) {
  var seconds = Math.max(0, Math.floor(totalSeconds || 0));
  var hours = Math.floor(seconds / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  var remainder = seconds % 60;
  return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(remainder);
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

function parseTimeoutHeader(timeoutHeader) {
  var match = String(timeoutHeader || "Second-300").match(/Second-(\d+)/i);
  var seconds = match ? parseInt(match[1], 10) : 300;
  if (!isFinite(seconds) || seconds <= 0) {
    seconds = 300;
  }
  return Math.max(30, seconds);
}

function getHeaderLineValue(rawRequest, headerName) {
  var match = String(rawRequest || "").match(new RegExp("^" + escapeRegExp(headerName) + ":\\s*(.+)$", "im"));
  return match ? match[1] : "";
}

function parsePositiveInt(value, fallback) {
  var num = parseInt(value, 10);
  return isNaN(num) || num < 0 ? fallback : num;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function endsWith(text, suffix) {
  return String(text || "").slice(0 - suffix.length) === suffix;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (all, num) {
      return String.fromCharCode(parseInt(num, 10));
    })
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/* ============================ SCPD documents ============================ */

var AVTRANSPORT_SCPD = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">",
  "<specVersion><major>1</major><minor>0</minor></specVersion>",
  "<serviceStateTable>",
  svar("TransportState", "string", false, "NO_MEDIA_PRESENT,STOPPED,PAUSED_PLAYBACK,PLAYING,TRANSITIONING"),
  svar("TransportStatus", "string", false, "OK,ERROR,VERSION_MISMATCH"),
  svar("PlaybackSpeed", "string", true, "1"),
  svar("AVTransportURI", "string", true, ""),
  svar("AVTransportURIMetaData", "string", true, ""),
  svar("NextAVTransportURI", "string", true, ""),
  svar("NextAVTransportURIMetaData", "string", true, ""),
  svar("CurrentTrack", "ui4", true, "0"),
  svar("NumberOfTracks", "ui4", true, "0"),
  svar("CurrentTrackDuration", "string", true, "0:00:00"),
  svar("CurrentMediaDuration", "string", true, "0:00:00"),
  svar("CurrentTrackURI", "string", true, ""),
  svar("CurrentTrackMetaData", "string", true, ""),
  svar("CurrentTransportActions", "string", true, ""),
  svar("PlayMode", "string", true, "NORMAL"),
  svar("RelTime", "string", true, "0:00:00"),
  svar("AbsTime", "string", true, "0:00:00"),
  svar("RelCount", "i4", true, "2147483647"),
  svar("AbsCount", "i4", true, "2147483647"),
  svar("PlayMedium", "string", true, "NONE"),
  svar("RecordMedium", "string", true, "NOT_IMPLEMENTED"),
  svar("WriteStatus", "string", true, "NOT_IMPLEMENTED"),
  svar("PlayMedia", "string", true, "NETWORK"),
  svar("RecMedia", "string", true, "NOT_IMPLEMENTED"),
  svar("RecQualityModes", "string", true, "NOT_IMPLEMENTED"),
  svar("A_ARG_TYPE_InstanceID", "ui4", false, "0"),
  svar("A_ARG_TYPE_SeekMode", "string", false, "REL_TIME,ABS_TIME"),
  svar("A_ARG_TYPE_Target", "string", false, ""),
  svar("SearchCaps", "string", true, ""),
  svar("SortCaps", "string", true, ""),
  "</serviceStateTable>",
  "<actionList>",
  action("SetAVTransportURI", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("CurrentURI", "in", "AVTransportURI"),
    arg("CurrentURIMetaData", "in", "AVTransportURIMetaData")
  ]),
  action("SetNextAVTransportURI", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("NextURI", "in", "NextAVTransportURI"),
    arg("NextURIMetaData", "in", "NextAVTransportURIMetaData")
  ]),
  action("Play", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Speed", "in", "PlaybackSpeed")
  ]),
  action("Pause", [arg("InstanceID", "in", "A_ARG_TYPE_InstanceID")]),
  action("Stop", [arg("InstanceID", "in", "A_ARG_TYPE_InstanceID")]),
  action("Seek", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Unit", "in", "A_ARG_TYPE_SeekMode"),
    arg("Target", "in", "A_ARG_TYPE_Target")
  ]),
  action("Next", [arg("InstanceID", "in", "A_ARG_TYPE_InstanceID")]),
  action("Previous", [arg("InstanceID", "in", "A_ARG_TYPE_InstanceID")]),
  action("SetPlayMode", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("NewPlayMode", "in", "PlayMode")
  ]),
  action("GetTransportInfo", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("CurrentTransportState", "out", "TransportState"),
    arg("CurrentTransportStatus", "out", "TransportStatus"),
    arg("CurrentSpeed", "out", "PlaybackSpeed")
  ]),
  action("GetPositionInfo", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Track", "out", "CurrentTrack"),
    arg("TrackDuration", "out", "CurrentTrackDuration"),
    arg("TrackMetaData", "out", "CurrentTrackMetaData"),
    arg("TrackURI", "out", "CurrentTrackURI"),
    arg("RelTime", "out", "RelTime"),
    arg("AbsTime", "out", "AbsTime"),
    arg("RelCount", "out", "RelCount"),
    arg("AbsCount", "out", "AbsCount")
  ]),
  action("GetMediaInfo", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("NrTracks", "out", "NumberOfTracks"),
    arg("MediaDuration", "out", "CurrentMediaDuration"),
    arg("CurrentURI", "out", "AVTransportURI"),
    arg("CurrentURIMetaData", "out", "AVTransportURIMetaData"),
    arg("NextURI", "out", "NextAVTransportURI"),
    arg("NextURIMetaData", "out", "NextAVTransportURIMetaData"),
    arg("PlayMedium", "out", "PlayMedium"),
    arg("RecordMedium", "out", "RecordMedium"),
    arg("WriteStatus", "out", "WriteStatus")
  ]),
  action("GetDeviceCapabilities", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("PlayMedia", "out", "PlayMedia"),
    arg("RecMedia", "out", "RecMedia"),
    arg("RecQualityModes", "out", "RecQualityModes")
  ]),
  action("GetTransportSettings", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("PlayMode", "out", "PlayMode"),
    arg("RecQualityMode", "out", "RecQualityModes")
  ]),
  action("GetCurrentTransportActions", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Actions", "out", "CurrentTransportActions")
  ]),
  action("GetSearchCapabilities", [arg("SearchCaps", "out", "SearchCaps")]),
  action("GetSortCapabilities", [arg("SortCaps", "out", "SortCaps")]),
  "</actionList>",
  "</scpd>"
].join("");

var RENDERING_CONTROL_SCPD = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">",
  "<specVersion><major>1</major><minor>0</minor></specVersion>",
  "<serviceStateTable>",
  "<stateVariable sendEvents=\"yes\"><name>Volume</name><dataType>ui2</dataType>",
  "<allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange></stateVariable>",
  "<stateVariable sendEvents=\"yes\"><name>Mute</name><dataType>boolean</dataType></stateVariable>",
  svar("A_ARG_TYPE_Channel", "string", false, "Master"),
  svar("A_ARG_TYPE_InstanceID", "ui4", false, "0"),
  svar("A_ARG_TYPE_PresetName", "string", false, "FactoryDefaults"),
  svar("CurrentPresetNameList", "string", true, ""),
  "</serviceStateTable>",
  "<actionList>",
  action("GetVolume", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Channel", "in", "A_ARG_TYPE_Channel"),
    arg("CurrentVolume", "out", "Volume")
  ]),
  action("SetVolume", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Channel", "in", "A_ARG_TYPE_Channel"),
    arg("DesiredVolume", "in", "Volume")
  ]),
  action("GetMute", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Channel", "in", "A_ARG_TYPE_Channel"),
    arg("CurrentMute", "out", "Mute")
  ]),
  action("SetMute", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("Channel", "in", "A_ARG_TYPE_Channel"),
    arg("DesiredMute", "in", "Mute")
  ]),
  action("ListPresets", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("CurrentPresetNameList", "out", "CurrentPresetNameList")
  ]),
  action("SelectPreset", [
    arg("InstanceID", "in", "A_ARG_TYPE_InstanceID"),
    arg("PresetName", "in", "A_ARG_TYPE_PresetName")
  ]),
  "</actionList>",
  "</scpd>"
].join("");

var CONNECTION_MANAGER_SCPD = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">",
  "<specVersion><major>1</major><minor>0</minor></specVersion>",
  "<serviceStateTable>",
  "<stateVariable sendEvents=\"yes\"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>",
  "<stateVariable sendEvents=\"yes\"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>",
  "<stateVariable sendEvents=\"yes\"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>",
  svar("A_ARG_TYPE_ConnectionID", "i4", false, "0"),
  svar("A_ARG_TYPE_ConnectionStatus", "string", false, "OK,ERROR,TIMED_OUT,INVALID_ARGS"),
  svar("A_ARG_TYPE_Direction", "string", false, "Input,Output"),
  svar("A_ARG_TYPE_ProtocolInfo", "string", false, ""),
  "</serviceStateTable>",
  "<actionList>",
  action("GetProtocolInfo", [
    arg("Source", "out", "SourceProtocolInfo"),
    arg("Sink", "out", "SinkProtocolInfo")
  ]),
  action("GetCurrentConnectionIDs", [
    arg("ConnectionIDs", "out", "CurrentConnectionIDs")
  ]),
  action("GetCurrentConnectionInfo", [
    arg("ConnectionID", "in", "A_ARG_TYPE_ConnectionID"),
    arg("RcsID", "out", "A_ARG_TYPE_ConnectionID"),
    arg("AVTransportID", "out", "A_ARG_TYPE_ConnectionID"),
    arg("ProtocolInfo", "out", "A_ARG_TYPE_ProtocolInfo"),
    arg("PeerConnectionManager", "out", "A_ARG_TYPE_ProtocolInfo"),
    arg("PeerConnectionID", "out", "A_ARG_TYPE_ConnectionID"),
    arg("Direction", "out", "A_ARG_TYPE_Direction"),
    arg("Status", "out", "A_ARG_TYPE_ConnectionStatus")
  ]),
  "</actionList>",
  "</scpd>"
].join("");

function svar(name, dataType, sendEvents, allowedValues) {
  var xml = "<stateVariable sendEvents=\"" + (sendEvents ? "yes" : "no") + "\">" +
    "<name>" + name + "</name><dataType>" + dataType + "</dataType>";
  if (allowedValues) {
    xml += "<allowedValueList>";
    var values = allowedValues.split(",");
    var i;
    for (i = 0; i < values.length; i += 1) {
      xml += "<allowedValue>" + values[i] + "</allowedValue>";
    }
    xml += "</allowedValueList>";
  }
  xml += "</stateVariable>";
  return xml;
}

function action(name, args) {
  var xml = "<action><name>" + name + "</name>";
  if (args && args.length) {
    xml += "<argumentList>";
    var i;
    for (i = 0; i < args.length; i += 1) {
      xml += "<argument><name>" + args[i].name + "</name><direction>" + args[i].direction + "</direction>" +
        "<relatedStateVariable>" + args[i].related + "</relatedStateVariable></argument>";
    }
    xml += "</argumentList>";
  }
  xml += "</action>";
  return xml;
}

function arg(name, direction, related) {
  return { name: name, direction: direction, related: related };
}
