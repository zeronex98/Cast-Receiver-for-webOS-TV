/*
 * webOS TV Cast Receiver - front-end app
 * ------------------------------------------------------------------
 * Data flow:
 *   phone cast app --SOAP--> background service --long-poll /status--> this app
 *   this app --POST /renderer/state--> background service --GENA events--> phone
 *
 * The front-end has one job: render the service state faithfully on the TV
 * screen and report real player state (position/duration/volume/errors)
 * back to the service.
 */
(function () {
  "use strict";

  /* Development mode: keep console logs for debugging. Visible via
   * `ares-inspect --device tv com.castreceiver.tv`. Flip to false for a
   * quiet production build. */
  var DEBUG = true;

  function debugLog(category, message) {
    if (!DEBUG) {
      return;
    }
    console.log("[castreceiver][" + category + "] " + message);
  }

  /* ============================ DOM ============================ */

  function $(id) {
    return document.getElementById(id);
  }

  var el = {
    idleView: $("idleView"),
    deviceName: $("deviceName"),
    ipChip: $("ipChip"),
    serviceChip: $("serviceChip"),
    helpButton: $("helpButton"),
    remoteHintButton: $("remoteHintButton"),
    exitButton: $("exitButton"),
    qrCanvas: $("qrCanvas"),
    qrFallback: $("qrFallback"),
    remoteUrlText: $("remoteUrlText"),
    wifiQrCanvas: $("wifiQrCanvas"),
    wifiQrFallback: $("wifiQrFallback"),
    wifiSsidText: $("wifiSsidText"),
    wifiQrDesc: $("wifiQrDesc"),
    footerState: $("footerState"),
    footerVersion: $("footerVersion"),

    stageView: $("stageView"),
    player: $("player"),
    imageViewer: $("imageViewer"),
    audioStage: $("audioStage"),
    audioArt: $("audioArt"),
    audioTitle: $("audioTitle"),
    audioArtist: $("audioArtist"),
    audioBarFill: $("audioBarFill"),
    audioTimeNow: $("audioTimeNow"),
    audioTimeTotal: $("audioTimeTotal"),

    hud: $("hud"),
    hudSource: $("hudSource"),
    hudTitle: $("hudTitle"),
    hudBarFill: $("hudBarFill"),
    hudTimeNow: $("hudTimeNow"),
    hudTimeTotal: $("hudTimeTotal"),
    hudState: $("hudState"),
    endCastButton: $("endCastButton"),
    playPauseButton: $("playPauseButton"),
    buffering: $("buffering"),

    helpOverlay: $("helpOverlay"),
    helpClose: $("helpClose"),
    debugForm: $("debugForm"),
    debugUrl: $("debugUrl"),
    debugType: $("debugType"),
    debugStop: $("debugStop"),
    nameInput: $("nameInput"),
    nameSaveButton: $("nameSaveButton"),
    wifiSsidInput: $("wifiSsidInput"),
    wifiPasswordInput: $("wifiPasswordInput"),
    wifiSaveButton: $("wifiSaveButton"),
    wifiClearButton: $("wifiClearButton"),

    airplayLine: $("airplayLine"),

    toast: $("toast")
  };

  /* ============================ Global state ============================ */

  var DEFAULT_PORT_CANDIDATES = [49152, 49153, 49154, 49155, 49156, 49157, 49158, 49159, 49160];
  var BASE = null;              // background service HTTP base URL
  var status = null;            // last /status snapshot
  var lastRev = -1;
  var pollBackoff = 0;

  var lastFingerprint = "";
  var lastTransportApplied = "";
  var desiredPlaying = false;
  var stoppedSince = 0;
  var seekSeqApplied = 0;
  var pendingSeek = null;

  var lastReportedVolume = -1;
  var lastReportedMute = null;
  var lastReportedTransport = "";
  var lastReportedStatus = "";
  var lastReportAt = 0;
  var lastVolumeEventAt = 0;
  var lastBarPct = "";
  var pageHidden = false;

  var hudHideTimer = null;
  var bufferingTimer = null;
  var toastTimer = null;
  var exitArmedAt = 0;
  var retryCount = 0;
  var offlineNotified = false;
  var degradedNotified = false;
  var nameRestoreChecked = false;

  var lunaAvailable = (typeof window.webOS !== "undefined" &&
    window.webOS && typeof window.webOS.service !== "undefined" &&
    typeof window.webOS.service.request === "function") ||
    (typeof navigator !== "undefined" && navigator.service && typeof navigator.service.request === "function") ||
    (typeof window.PalmServiceBridge === "function");
  var lunaBridgeKind = (typeof window.webOS !== "undefined" && window.webOS && window.webOS.service)
    ? "webos.js"
    : ((typeof navigator !== "undefined" && navigator.service && navigator.service.request) ? "navigator.service" : (lunaAvailable ? "PalmServiceBridge" : "none"));
  var lunaAudioOk = null; // null=unknown, true=available, false=unavailable

  /* ============================ Common helpers ============================ */

  function request(method, path, body, callback, timeoutMs) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open(method, path, true);
      if (body !== undefined) {
        xhr.setRequestHeader("Content-Type", "application/json");
      }
      xhr.timeout = timeoutMs || 20000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) {
          return;
        }
        var data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (error) {}
        callback((xhr.status >= 200 && xhr.status < 300) ? data : null);
      };
      xhr.onerror = function () {
        callback(null);
      };
      xhr.ontimeout = function () {
        callback(null);
      };
      xhr.send(body === undefined ? null : JSON.stringify(body));
    } catch (error) {
      callback(null);
    }
  }

  function postState(extra) {
    if (!BASE) {
      return;
    }
    var payload = extra || {};
    var player = el.player;
    if (payload.position === undefined) {
      payload.position = Math.floor(player.currentTime || 0);
    }
    if (payload.duration === undefined) {
      payload.duration = Math.floor(player.duration || 0) || 0;
    }
    if (payload.volume === undefined && lastReportedVolume >= 0) {
      payload.volume = lastReportedVolume;
    }
    if (payload.mute === undefined && lastReportedMute !== null) {
      payload.mute = lastReportedMute;
    }
    /* Diagnostic: which luna transport the front-end ended up with. */
    payload.appLuna = lunaAvailable;
    payload.appBridge = lunaBridgeKind;
    request("POST", BASE + "/renderer/state?light=1", payload, function (data) {
      if (data && data.rev) {
        lastRev = Math.max(lastRev, data.rev);
      }
    }, 6000);
  }

  function formatTime(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var mm = (m < 10 ? "0" : "") + m;
    var ss = (r < 10 ? "0" : "") + r;
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  function showToast(text, durationMs) {
    el.toast.textContent = text;
    el.toast.classList.add("visible");
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      el.toast.classList.remove("visible");
    }, durationMs || 3200);
  }

  /* Cached DOM writes: the TV repaints at 4K, so skip textContent writes
   * that would not change anything. */
  function setTextCached(node, text) {
    if (!node || node.__lastText === text) {
      return;
    }
    node.__lastText = text;
    node.textContent = text;
  }

  function mediaFingerprint(media) {
    if (!media) {
      return "";
    }
    var subs = (media.subtitles || []).map(function (s) { return s.url; }).join("|");
    return [media.url, media.mimeType, media.mediaType, subs].join("#");
  }

  /* ============================ Luna wrappers ============================ */

  /* Luna transport with three fallbacks (webOS TV provides
   * PalmServiceBridge / navigator.service to web apps; webOS.js is only
   * present when the platform injects it):
   *   1. webOS.service.request   (webOS.js)
   *   2. navigator.service.request
   *   3. PalmServiceBridge       (legacy bridge)
   */
  function lunaRequest(uri, method, params, onSuccess, onFailure, opts) {
    opts = opts || {};
    if (!lunaAvailable) {
      if (onFailure) {
        onFailure({ errorText: "no luna bridge" });
      }
      return;
    }

    /* 1) webOS.js */
    if (window.webOS && window.webOS.service && typeof window.webOS.service.request === "function") {
      try {
        window.webOS.service.request(uri, {
          method: method,
          parameters: params || {},
          subscribe: !!opts.subscribe,
          resubscribe: !!opts.resubscribe,
          onSuccess: function (response) {
            if (onSuccess) {
              onSuccess(response);
            }
          },
          onFailure: function (response) {
            if (onFailure) {
              onFailure(response);
            }
          }
        });
        return;
      } catch (error) {
        /* fall through */
      }
    }

    /* 2) navigator.service (modern platform API) */
    if (navigator.service && typeof navigator.service.request === "function") {
      try {
        navigator.service.request(uri, {
          method: method,
          parameters: params || {},
          subscribe: !!opts.subscribe,
          resubscribe: !!opts.resubscribe,
          onSuccess: function (response) {
            if (onSuccess) {
              onSuccess(response);
            }
          },
          onFailure: function (response) {
            if (onFailure) {
              onFailure(response);
            }
          }
        });
        return;
      } catch (error) {
        /* fall through */
      }
    }

    /* 3) PalmServiceBridge */
    if (typeof window.PalmServiceBridge === "function") {
      try {
        var bridge = new window.PalmServiceBridge();
        var payload = {};
        var key;
        for (key in (params || {})) {
          payload[key] = params[key];
        }
        if (opts.subscribe) {
          payload.subscribe = true;
        }
        bridge.onservicecallback = function (message) {
          var data = null;
          try {
            data = JSON.parse(message);
          } catch (error) {}
          if (data && data.returnValue === false) {
            if (onFailure) {
              onFailure(data);
            }
          } else if (onSuccess) {
            onSuccess(data);
          }
          if (!opts.subscribe) {
            try {
              bridge.cancel();
            } catch (error) {}
          }
        };
        bridge.call(uri.replace(/\/+$/, "") + "/" + method, JSON.stringify(payload));
        return;
      } catch (error) {
        /* fall through */
      }
    }

    if (onFailure) {
      onFailure({ errorText: "luna call failed" });
    }
  }

  /* System volume: prefer Luna (the real TV volume), fall back to the
   * HTML5 element volume when the Luna call is unavailable. */
  function applySystemVolume(volume, isFromTv) {
    volume = Math.max(0, Math.min(100, Math.floor(volume)));
    if (lunaAudioOk !== false) {
      lunaRequest("luna://com.webos.audio/", "setVolume", { volume: volume }, function () {
        if (lunaAudioOk !== true) {
          lunaAudioOk = true;
          subscribeTvVolume();
        }
      }, function () {
        lunaAudioOk = false;
        el.player.volume = volume / 100;
      });
    } else {
      el.player.volume = volume / 100;
    }
    if (!isFromTv) {
      lastReportedVolume = volume;
    }
  }

  function applySystemMute(mute) {
    if (lunaAudioOk !== false) {
      lunaRequest("luna://com.webos.audio/", "setMute", { mute: !!mute }, null, function () {
        lunaAudioOk = false;
        el.player.muted = !!mute;
      });
    } else {
      el.player.muted = !!mute;
    }
    lastReportedMute = !!mute;
  }

  function subscribeTvVolume() {
    if (lunaAudioOk !== true) {
      return;
    }
    lunaRequest("luna://com.webos.audio", "getVolume", {}, function (response) {
      if (!response || typeof response.volume !== "number") {
        return;
      }
      var volume = Math.round(response.volume);
      var mute = !!response.mute;
      lastVolumeEventAt = Date.now();
      if (volume !== lastReportedVolume) {
        lastReportedVolume = volume;
        postState({ volume: volume, mute: mute });
      }
      if (mute !== lastReportedMute) {
        lastReportedMute = mute;
        postState({ mute: mute });
      }
    }, function () {
      lunaAudioOk = false;
    }, { subscribe: true, resubscribe: true });
  }

  function pollTvVolumeFallback() {
    /* Fallback when the Luna volume subscription is unavailable:
     * read the system volume occasionally. Skip while the subscription
     * is delivering events (it covers TV-remote volume changes). */
    if (lunaAudioOk !== true) {
      return;
    }
    if (Date.now() - lastVolumeEventAt < 30000) {
      return;
    }
    lunaRequest("luna://com.webos.audio/", "getVolume", {}, function (response) {
      if (response && typeof response.volume === "number") {
        var volume = Math.round(response.volume);
        if (volume !== lastReportedVolume) {
          lastReportedVolume = volume;
          postState({ volume: volume });
        }
      }
    }, null);
  }

  /* ============================ Base URL discovery & polling ============================ */

  function resolveBase(done) {
    /* 1. Ask the background service over Luna (most reliable). */
    lunaRequest("luna://com.castreceiver.tv.service", "status", {}, function (response) {
      if (response && response.service && response.service.base) {
        debugLog("boot", "base via luna: " + response.service.base);
        done(response.service.base);
        return;
      }
      probeDefault(done);
    }, function () {
      debugLog("boot", "luna status failed; probing default ports");
      probeDefault(done);
    });
  }

  function probeDefault(done) {
    var index = 0;
    var probeNext = function () {
      if (index >= DEFAULT_PORT_CANDIDATES.length) {
        done(null);
        return;
      }
      var candidate = "http://127.0.0.1:" + DEFAULT_PORT_CANDIDATES[index];
      index += 1;
      request("GET", candidate + "/health", undefined, function (data) {
        if (data && data.ok) {
          done(candidate);
        } else {
          probeNext();
        }
      }, 2200);
    };
    probeNext();
  }

  function startPolling() {
    var waitSeconds = 10;
    var path = BASE + "/status?light=1" + (lastRev >= 0 ? "&rev=" + lastRev + "&wait=" + waitSeconds : "");
    request("GET", path, undefined, function (data) {
      if (data && data.returnValue) {
        offlineNotified = false;
        pollBackoff = 0;
        lastRev = data.rev;
        status = data;
        applyStatus(data);
        startPolling();
      } else {
        debugLog("poll", "request failed; entering offline retry");
        handleOffline();
      }
    }, 22000);
  }

  function handleOffline() {
    if (!offlineNotified) {
      offlineNotified = true;
      setServiceChip(false, "后台服务未连接");
      showToast("与后台服务失去连接，正在重试…", 4000);
    }
    pollBackoff = Math.min(pollBackoff + 1000, 6000);
    setTimeout(function () {
      if (!BASE) {
        resolveBase(function (base) {
          if (base) {
            BASE = base;
            lastRev = -1;
            startPolling();
          } else {
            handleOffline();
          }
        });
        return;
      }
      /* The service may have restarted on a different port. */
      request("GET", BASE + "/health", undefined, function (data) {
        if (data && data.ok) {
          startPolling();
        } else {
          BASE = null;
          handleOffline();
        }
      }, 2200);
    }, 1500 + pollBackoff);
  }

  /* ============================ Status handling ============================ */

  function applyStatus(data) {
    updateIdleInfo(data);
    /* The WiFi QR lives on the idle page, which returns early when no media
     * is active — update it here so it draws in both idle and playback states. */
    updateWifiQr(data);

    /* After an ipk update the service-side name file is wiped; restore the
     * user's custom name from localStorage when the service reports the
     * default (model) name. */
    if (!nameRestoreChecked && data.service) {
      nameRestoreChecked = true;
      try {
        var storedName = localStorage.getItem("customDeviceName");
        if (storedName && data.nameCustom === false && storedName !== data.service.name && BASE) {
          debugLog("boot", "restoring custom device name: " + storedName);
          request("POST", BASE + "/renderer/device-name", { name: storedName }, null, 5000);
        }
      } catch (error) {}
    }

    var media = data.currentMedia;

    /* After Stop (or a finished queue) stay on the player for a short
     * while, then fall back to the idle guide page. After a minute of
     * idling, fully release the decoder and network buffers. */
    if (media && (data.transportState === "STOPPED" || data.transportState === "NO_MEDIA_PRESENT")) {
      if (!stoppedSince) {
        stoppedSince = Date.now();
      }
      var idleMs = Date.now() - stoppedSince;
      if (idleMs > 15000) {
        showIdle();
        desiredPlaying = false;
        if (idleMs > 60000 && lastFingerprint) {
          resetPlayers();
          lastFingerprint = "";
        }
        return;
      }
    } else {
      stoppedSince = 0;
    }

    if (!media) {
      showIdle();
      resetPlayers();
      lastFingerprint = "";
      desiredPlaying = false;
      return;
    }

    showStage(media);

    var fingerprint = mediaFingerprint(media);
    if (fingerprint !== lastFingerprint) {
      debugLog("media", "load type=" + media.mediaType + " mime=" + media.mimeType +
        " title=\"" + media.title + "\" subs=" + media.subtitles.length +
        " url=" + media.url.slice(0, 120));
      lastFingerprint = fingerprint;
      retryCount = 0;
      seekSeqApplied = data.seekSeq || 0; /* drop stale seeks on track change */
      pendingSeek = null;
      loadMedia(media, data);
    }

    desiredPlaying = data.transportState === "PLAYING";
    applyTransport(data.transportState);
    applySeek(data);
    applyPlayMode(data.playMode);

    if (typeof data.volume === "number" && data.volume !== lastReportedVolume) {
      debugLog("volume", "apply volume=" + data.volume + " mute=" + data.mute);
      applySystemVolume(data.volume, false);
      lastReportedVolume = data.volume;
    }
    if (typeof data.mute === "boolean" && data.mute !== lastReportedMute) {
      debugLog("volume", "apply mute=" + data.mute);
      applySystemMute(data.mute);
      lastReportedMute = data.mute;
    }

    if (pageHidden) {
      /* Backgrounded: keep state in sync but skip all UI painting. */
      return;
    }

    renderHud(data);
    renderAudioStage(data);
    renderOverlayProgress(data);
    renderAirplay(data);
  }
  function updateIdleInfo(data) {
    var svc = data.service || {};
    setTextCached(el.deviceName, svc.name || "投屏助手");
    setTextCached(el.footerVersion, "v" + (svc.version || "1.0.0"));

    if (svc.ip) {
      setTextCached(el.ipChip, "IP " + svc.ip);
      if (el.ipChip.className !== "meta-chip ok") {
        el.ipChip.className = "meta-chip ok";
      }
    }

    setServiceChip(true, "服务运行中 · 端口 " + svc.port);

    if (svc.ssdpDegraded && !degradedNotified) {
      degradedNotified = true;
      setTextCached(el.footerState, "SSDP 端口被电视占用 · 已切换为广播模式");
      showToast("检测到 SSDP 端口冲突，已切换为广播模式（部分 App 可能搜不到）", 6000);
    } else if (svc.ssdpBound) {
      setTextCached(el.footerState, "DLNA Renderer 运行中");
    }

    if (svc.remoteUrl && svc.remoteUrl !== lastQrUrl) {
      lastQrUrl = svc.remoteUrl;
      el.remoteUrlText.textContent = svc.remoteUrl;
      drawQr(svc.remoteUrl);
    }
  }

  function setServiceChip(ok, text) {
    var cls = "meta-chip " + (ok ? "ok" : "bad");
    setTextCached(el.serviceChip, text);
    if (el.serviceChip.className !== cls) {
      el.serviceChip.className = cls;
    }
  }

  /* AirPlay capability display: the service probes the local stack
   * (mDNS + ports + files) and reports a verdict. */
  var airplayToastShown = false;
  var lastQrUrl = "";

  function renderAirplay(data) {
    if (!el.airplayLine || !data.airplay || data.airplay.verdict === "pending") {
      return;
    }
    var verdict = data.airplay.verdict;
    var text;
    var color = "var(--muted)";
    if (verdict === "present") {
      text = "AirPlay 检测：本机协议栈已就绪（监听 7000 端口），苹果设备可直接投屏";
      color = "var(--ok)";
      if (!airplayToastShown) {
        airplayToastShown = true;
        showToast("检测到本机 AirPlay 接收器，苹果设备可直接投屏", 5000);
      }
    } else if (verdict === "partial") {
      text = "AirPlay 检测：发现相关文件但无监听端口，实际不可用";
    } else {
      text = "AirPlay 检测：本机无此协议栈（国行机型未预装，且应用无法开启），请使用 DLNA 投屏";
    }
    setTextCached(el.airplayLine, text);
    if (el.airplayLine.__lastColor !== color) {
      el.airplayLine.__lastColor = color;
      el.airplayLine.style.color = color;
    }
  }

  function showIdle() {
    el.stageView.classList.remove("visible");
    el.idleView.style.display = "";
    el.hud.classList.remove("visible");
    hideBuffering();
  }

  function showStage(media) {
    el.idleView.style.display = "none";
    el.stageView.classList.add("visible");
    el.stageView.className = "stage-view visible mode-" + (media.mediaType || "video");

    if (media.mediaType === "audio") {
      if (media.albumArtUrl) {
        var img = document.createElement("img");
        img.src = media.albumArtUrl;
        el.audioArt.innerHTML = "";
        el.audioArt.appendChild(img);
        img.onerror = function () {
          el.audioArt.innerHTML = "<span>♪</span>";
        };
      } else {
        el.audioArt.innerHTML = "<span>♪</span>";
      }
    }
  }

  function resetPlayers() {
    if (!el.player.src && !el.imageViewer.getAttribute("src")) {
      return;
    }
    el.player.pause();
    el.player.removeAttribute("src");
    el.player.load();
    el.imageViewer.removeAttribute("src");
    clearSubtitles();
    el.audioStage.style.opacity = "";
  }

  /* ============================ Media loading ============================ */

  function loadMedia(media, data) {
    clearSubtitles();
    hideBuffering();

    if (media.mediaType === "image") {
      el.player.pause();
      el.player.removeAttribute("src");
      el.player.load();
      loadImage(media);
      return;
    }

    el.imageViewer.removeAttribute("src");
    el.player.preload = "auto";
    el.player.src = media.url;
    el.player.load();
    attachSubtitles(media);

    el.audioTitle.textContent = media.title || "未在播放";
    el.audioArtist.textContent = [media.artist, media.album].filter(Boolean).join(" · ") || "投屏播放中";

    if (data && data.transportState === "PLAYING") {
      tryPlay();
    }
    showHud();
  }

  function loadImage(media) {
    el.imageViewer.onload = function () {
      hideBuffering();
      showHud();
    };
    el.imageViewer.onerror = function () {
      el.imageViewer.removeAttribute("src");
      reportPlaybackError("图片加载失败");
    };
    el.buffering.classList.add("visible");
    el.imageViewer.src = media.url;
  }

  function tryPlay() {
    var promise = el.player.play();
    if (promise && typeof promise["catch"] === "function") {
      promise["catch"](function () {
        /* Autoplay rejected: silently wait for the next applyTransport. */
      });
    }
  }

  function applyTransport(transportState) {
    if (transportState === lastTransportApplied) {
      return;
    }
    debugLog("transport", "apply " + lastTransportApplied + " -> " + transportState);
    lastTransportApplied = transportState;

    if (transportState === "PLAYING") {
      if (el.player.paused && el.player.src) {
        tryPlay();
      }
    } else if (transportState === "PAUSED_PLAYBACK" || transportState === "STOPPED" || transportState === "TRANSITIONING") {
      if (!el.player.paused) {
        el.player.pause();
      }
    }

    if (transportState === "PLAYING") {
      showHud(false); /* HUD auto-hides once playing */
    } else {
      showHud(true);
    }
  }

  function applySeek(data) {
    if ((data.seekSeq || 0) <= seekSeqApplied) {
      return;
    }
    seekSeqApplied = data.seekSeq || 0;
    debugLog("seek", "remote seek -> " + (data.seekTarget || 0) + "s (seq " + seekSeqApplied + ")");
    pendingSeek = data.seekTarget || 0;
    tryApplyPendingSeek();
  }

  function tryApplyPendingSeek() {
    if (pendingSeek === null) {
      return;
    }
    if (el.player.readyState >= 1 && el.player.src) {
      try {
        el.player.currentTime = pendingSeek;
      } catch (error) {}
      pendingSeek = null;
    }
  }

  function applyPlayMode(playMode) {
    el.player.loop = playMode === "REPEAT_ONE";
  }

  /* ============================ Subtitles ============================ */

  function clearSubtitles() {
    var tracks = el.player.querySelectorAll("track");
    for (var i = 0; i < tracks.length; i += 1) {
      tracks[i].remove();
    }
  }

  function attachSubtitles(media) {
    var subs = media.subtitles || [];
    subs.forEach(function (sub, index) {
      fetchSubtitle(sub, index === 0);
    });
  }

  function fetchSubtitle(sub, isDefault) {
    var proxyUrl = BASE + "/proxy?url=" + encodeURIComponent(sub.url);
    var xhr = new XMLHttpRequest();
    xhr.open("GET", proxyUrl, true);
    xhr.timeout = 12000;
    xhr.onload = function () {
      if (xhr.status !== 200 || !xhr.responseText) {
        showToast("字幕加载失败", 3000);
        return;
      }
      var text = xhr.responseText;
      if (!/^WEBVTT/i.test(text.trim())) {
        text = srtToVtt(text);
        if (!text) {
          showToast("字幕格式不支持", 3000);
          return;
        }
      }
      try {
        var blob = new Blob([text], { type: "text/vtt" });
        var track = document.createElement("track");
        track.kind = sub.kind || "subtitles";
        track.label = sub.label || "字幕";
        track.srclang = sub.srclang || "zh";
        track.src = URL.createObjectURL(blob);
        if (isDefault) {
          track["default"] = true;
        }
        el.player.appendChild(track);
      } catch (error) {
        showToast("字幕加载失败", 3000);
      }
    };
    xhr.onerror = function () {
      showToast("字幕加载失败", 3000);
    };
    xhr.ontimeout = function () {
      showToast("字幕加载超时", 3000);
    };
    xhr.send();
  }

  function srtToVtt(srt) {
    try {
      var lines = String(srt).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      var out = ["WEBVTT", ""];
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (/-->/.test(line)) {
          line = line.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/, function (all, h1, m1, h2, m2) {
            return h1 + "." + padMs(m1) + " --> " + h2 + "." + padMs(m2);
          });
        }
        out.push(line);
      }
      return out.join("\n");
    } catch (error) {
      return "";
    }
  }

  function padMs(text) {
    while (text.length < 3) {
      text += "0";
    }
    return text;
  }

  /* ============================ HUD / rendering ============================ */

  function showHud(stick) {
    el.hud.classList.add("visible");
    if (hudHideTimer) {
      clearTimeout(hudHideTimer);
      hudHideTimer = null;
    }
    if (!stick && desiredPlaying) {
      hudHideTimer = setTimeout(function () {
        el.hud.classList.remove("visible");
      }, 5000);
    }
  }

  /* Buffering indicator: `waiting`/`stalled` can fire spuriously on some
   * webOS builds without a matching `playing` event, so show it only after
   * a short grace period and hide it as soon as media time advances. */
  function hideBuffering() {
    if (bufferingTimer) {
      clearTimeout(bufferingTimer);
      bufferingTimer = null;
    }
    el.buffering.classList.remove("visible");
  }

  function scheduleBuffering() {
    if (!desiredPlaying || el.player.paused || el.player.ended || bufferingTimer) {
      return;
    }
    bufferingTimer = setTimeout(function () {
      bufferingTimer = null;
      if (desiredPlaying && !el.player.paused && !el.player.ended && el.player.readyState < 3) {
        el.buffering.classList.add("visible");
      }
    }, 800);
  }

  function renderHud(data) {
    var media = data.currentMedia;
    if (!media) {
      return;
    }
    var source = "投屏中";
    if (data.controller && data.controller.name && data.controller.name !== "Unknown device") {
      source = "投屏中 · 来自 " + data.controller.name;
    }
    setTextCached(el.hudSource, source);
    setTextCached(el.hudTitle, media.title || "");

    var duration = data.duration || Math.floor(el.player.duration || 0);
    var position = Math.floor(el.player.currentTime || data.position || 0);
    setTextCached(el.hudTimeNow, formatTime(position));
    setTextCached(el.hudTimeTotal, formatTime(duration));
    if (duration > 0) {
      var pct = Math.min(100, (position / duration) * 100).toFixed(2) + "%";
      if (pct !== lastBarPct) {
        lastBarPct = pct;
        el.hudBarFill.style.width = pct;
        el.audioBarFill.style.width = pct;
      }
    }
    setTextCached(el.hudState, transportText(data.transportState, data.transportStatus));
    var isPlaying = data.transportState === "PLAYING";
    if (isPlaying) {
      el.playPauseButton.classList.add("playing");
    } else {
      el.playPauseButton.classList.remove("playing");
    }
    el.playPauseButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
  }

  function renderAudioStage(data) {
    var media = data.currentMedia;
    if (!media || media.mediaType !== "audio") {
      return;
    }
    setTextCached(el.audioTitle, media.title || "未在播放");
    setTextCached(el.audioArtist, [media.artist, media.album].filter(Boolean).join(" · ") || "投屏播放中");
    var duration = data.duration || Math.floor(el.player.duration || 0);
    var position = Math.floor(el.player.currentTime || data.position || 0);
    setTextCached(el.audioTimeNow, formatTime(position));
    setTextCached(el.audioTimeTotal, formatTime(duration));
  }

  function renderOverlayProgress(data) {
    /* image mode has no progress bar; keep HUD status text fresh. */
    if (data.currentMedia && data.currentMedia.mediaType === "image") {
      setTextCached(el.hudTimeNow, "—");
      setTextCached(el.hudTimeTotal, "—");
      if (lastBarPct !== "0%") {
        lastBarPct = "0%";
        el.hudBarFill.style.width = "0%";
        el.audioBarFill.style.width = "0%";
      }
      setTextCached(el.hudState, transportText(data.transportState, data.transportStatus));
    }
  }

  function transportText(transportState, transportStatus) {
    if (transportStatus === "ERROR") {
      return "播放出错";
    }
    switch (transportState) {
      case "PLAYING": return "正在播放";
      case "PAUSED_PLAYBACK": return "已暂停";
      case "TRANSITIONING": return "缓冲中";
      case "STOPPED": return "已停止";
      default: return "就绪";
    }
  }

  /* ============================ Player events ============================ */

  function bindPlayerEvents() {
    var player = el.player;

    player.addEventListener("loadedmetadata", function () {
      debugLog("player", "loadedmetadata duration=" + Math.floor(player.duration || 0) + "s");
      hideBuffering();
      tryApplyPendingSeek();
      var duration = Math.floor(player.duration || 0);
      if (duration > 0) {
        postState({ duration: duration });
      }
    });

    player.addEventListener("canplay", function () {
      hideBuffering();
      if (desiredPlaying && player.paused && player.src) {
        tryPlay();
      }
      tryApplyPendingSeek();
    });

    player.addEventListener("waiting", function () {
      scheduleBuffering();
    });

    player.addEventListener("stalled", function () {
      scheduleBuffering();
    });

    player.addEventListener("playing", function () {
      debugLog("player", "playing at " + Math.floor(player.currentTime || 0) + "s");
      hideBuffering();
      postState({ transportState: "PLAYING", transportStatus: "OK" });
      showHud(false);
    });

    player.addEventListener("play", function () {
      postState({ transportState: "PLAYING" });
    });

    player.addEventListener("pause", function () {
      debugLog("player", "paused at " + Math.floor(player.currentTime || 0) + "s");
      if (!player.ended) {
        hideBuffering();
        postState({ transportState: "PAUSED_PLAYBACK" });
        showHud(true);
      }
    });

    player.addEventListener("ended", function () {
      debugLog("player", "ended; reporting for auto-advance");
      el.buffering.classList.add("visible");
      postState({ transportState: "STOPPED", mediaEnded: true });
    });

    player.addEventListener("error", function () {
      var code = player.error ? player.error.code : 0;
      debugLog("player", "error code=" + code);
      var reason = code === 2 ? "网络错误" : (code === 3 ? "解码失败" : (code === 4 ? "格式不支持" : "播放错误"));
      reportPlaybackError(reason, code);
    });

    player.addEventListener("timeupdate", function () {
      /* Media time advances only while playback is healthy; clear any
       * spinner left behind by a spurious waiting/stalled event. */
      if (!player.paused && el.buffering.classList.contains("visible")) {
        hideBuffering();
      }
      var now = Date.now();
      if (now - lastReportAt < 1800) {
        renderLocalProgress();
        return;
      }
      lastReportAt = now;
      postState({});
      renderLocalProgress();
    });

    player.addEventListener("volumechange", function () {
      var volume = Math.round(player.volume * 100);
      if (lunaAudioOk === false && volume !== lastReportedVolume) {
        lastReportedVolume = volume;
        postState({ volume: volume, mute: !!player.muted });
      }
    });
  }

  function renderLocalProgress() {
    if (!isStageVisible() || pageHidden) {
      return;
    }
    var player = el.player;
    var duration = Math.floor(player.duration || 0);
    var position = Math.floor(player.currentTime || 0);
    var nowText = formatTime(position);
    var totalText = formatTime(duration);
    setTextCached(el.hudTimeNow, nowText);
    setTextCached(el.hudTimeTotal, totalText);
    setTextCached(el.audioTimeNow, nowText);
    setTextCached(el.audioTimeTotal, totalText);
    if (duration > 0) {
      var pct = Math.min(100, (position / duration) * 100).toFixed(2) + "%";
      if (pct !== lastBarPct) {
        lastBarPct = pct;
        el.hudBarFill.style.width = pct;
        el.audioBarFill.style.width = pct;
      }
    }
  }

  function reportPlaybackError(reason, code) {
    hideBuffering();
    showToast("播放失败：" + reason, 5000);
    postState({ transportStatus: "ERROR" });

    /* Auto-retry once on network errors. */
    if (code === 2 && retryCount < 1 && status && status.currentMedia) {
      retryCount += 1;
      var currentUrl = status.currentMedia.url;
      setTimeout(function () {
        if (el.player.src && status && status.currentMedia && status.currentMedia.url === currentUrl) {
          showToast("正在重试连接…", 2500);
          el.player.load();
          if (desiredPlaying) {
            tryPlay();
          }
        }
      }, 2500);
    }
  }

  /* ============================ Keyboard / TV remote ============================ */

  function onKey(event) {
    var code = event.keyCode;
    var key = event.key || "";

    var handled = true;
    if (code === 415 || key === "MediaPlay") {
      debugLog("remote", "key play");
      playToggle(true);
    } else if (code === 19 || key === "MediaPause") {
      debugLog("remote", "key pause");
      playToggle(false);
    } else if (code === 10252 || key === "MediaPlayPause") {
      debugLog("remote", "key playpause");
      togglePlayback();
    } else if (isStageVisible() && isConfirmKey(code, key)) {
      debugLog("remote", "key confirm -> playpause");
      togglePlayback();
    } else if (code === 413 || key === "MediaStop") {
      debugLog("remote", "key stop");
      request("POST", BASE + "/renderer/stop", {}, null, 6000);
      showToast("已停止投屏", 2000);
    } else if (code === 417 || key === "MediaFastForward") {
      debugLog("remote", "key ff+30");
      seekLocal(30);
    } else if (code === 412 || key === "MediaRewind") {
      debugLog("remote", "key rw-30");
      seekLocal(-30);
    } else if (code === 37 || key === "ArrowLeft") {
      /* D-pad left: seek back 10s while casting */
      debugLog("remote", "key left -10s");
      seekLocal(-10);
    } else if (code === 39 || key === "ArrowRight") {
      debugLog("remote", "key right +10s");
      seekLocal(10);
    } else if (code === 38 || key === "ArrowUp" || code === 40 || key === "ArrowDown") {
      /* D-pad up/down: bring up the HUD (progress bar) */
      showHud();
    } else if (code === 461 || key === "BrowserBack" || key === "Back" || key === "GoBack") {
      debugLog("remote", "key back");
      handleBack();
    } else if (code === 403 || key === "Info") {
      debugLog("remote", "key info");
      showHud();
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
    }
  }

  function isStageVisible() {
    return el.stageView.classList.contains("visible");
  }

  /* Remote OK / Enter during playback toggles play/pause. Several key
   * shapes are accepted because firmwares differ (13 is the standard). */
  function isConfirmKey(code, key) {
    return code === 13 || code === 128 ||
      key === "Enter" || key === "OK" || key === "Select" || key === "Accept";
  }

  /* Shared by the HUD button, media keys, and the remote OK key. Reports
   * the new state with force so it also applies right after a controller
   * command (the service otherwise ignores state echoes for 3 seconds). */
  function togglePlayback() {
    if (!el.player.src) {
      return;
    }
    var shouldPause = !el.player.paused;
    playToggle(!shouldPause);
    postState({
      transportState: shouldPause ? "PAUSED_PLAYBACK" : "PLAYING",
      force: true
    });
  }

  function playToggle(play) {
    if (!el.player.src) {
      return;
    }
    if (play) {
      tryPlay();
    } else {
      el.player.pause();
    }
    showHud();
  }

  function seekLocal(delta) {
    if (!el.player.src || !isFinite(el.player.duration) || el.player.duration <= 0) {
      return;
    }
    seekTo((el.player.currentTime || 0) + delta);
  }

  /* End the current cast: tell the service to stop, silence local playback
   * immediately and jump back to the idle guide page. The backdated
   * stoppedSince makes the idle-page rule apply on the next status. */
  function endCast() {
    debugLog("cast", "end cast pressed");
    if (BASE) {
      request("POST", BASE + "/renderer/stop", {}, function (data) {
        if (data && data.rev) {
          lastRev = Math.max(lastRev, data.rev);
        }
      }, 6000);
    }
    el.player.pause();
    stoppedSince = Date.now() - 16000;
    desiredPlaying = false;
    showIdle();
    showToast("已结束投屏", 2200);
  }

  function seekTo(target) {
    if (!el.player.src || !isFinite(el.player.duration) || el.player.duration <= 0) {
      return;
    }
    target = Math.max(0, Math.min(el.player.duration - 0.5, target));
    try {
      el.player.currentTime = target;
    } catch (error) {
      return;
    }
    seekSeqApplied = (status && status.seekSeq) || 0; /* local seek overrides any pending remote seek */
    pendingSeek = null;
    postState({ position: Math.floor(target) });
    showHud();
    renderLocalProgress();
  }

  function handleBack() {
    var now = Date.now();
    if (el.helpOverlay.classList.contains("open")) {
      el.helpOverlay.classList.remove("open");
      return;
    }
    if (now - exitArmedAt < 2600) {
      try {
        window.close();
      } catch (error) {}
      return;
    }
    if (isStageVisible() && !el.hud.classList.contains("visible")) {
      showHud();
      return;
    }
    exitArmedAt = now;
    showToast("再按一次返回键退出应用", 2400);
  }

  /* ============================ Overlay / buttons ============================ */

  function bindUi() {
    el.helpButton.addEventListener("click", function () {
      /* Prefill the device-name editor with the current name. */
      if (el.nameInput) {
        el.nameInput.value = (status && status.service && status.service.name) || "";
      }
      if (el.wifiSsidInput && status && status.wifi) {
        el.wifiSsidInput.value = status.wifi.ssid || "";
      }
      if (el.wifiPasswordInput) {
        el.wifiPasswordInput.value = "";
      }
      el.helpOverlay.classList.add("open");
    });
    el.helpClose.addEventListener("click", function () {
      el.helpOverlay.classList.remove("open");
    });
    el.exitButton.addEventListener("click", function () {
      try {
        window.close();
      } catch (error) {}
    });
    el.remoteHintButton.addEventListener("click", function () {
      var url = el.remoteUrlText.textContent;
      if (url && url !== "—") {
        showToast("手机浏览器打开 " + url, 6000);
      } else {
        showToast("等待后台服务就绪后显示遥控地址", 3000);
      }
    });

    el.debugForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var url = el.debugUrl.value.trim();
      if (!url || !BASE) {
        return;
      }
      request("POST", BASE + "/renderer/play", {
        url: url,
        title: "手动推送",
        mimeType: el.debugType.value
      }, function (data) {
        if (data) {
          lastRev = Math.max(lastRev, data.rev || lastRev);
          showToast("已推送到电视", 2200);
        } else {
          showToast("推送失败", 2500);
        }
      }, 6000);
    });

    el.debugStop.addEventListener("click", function () {
      request("POST", BASE + "/renderer/stop", {}, null, 6000);
    });

    /* Top-left "end cast" button: stop playback and go back to idle. */
    el.endCastButton.addEventListener("click", function (event) {
      event.stopPropagation();
      endCast();
    });

    /* Play / pause button in the HUD (magic-remote pointer). */
    el.playPauseButton.addEventListener("click", function (event) {
      event.stopPropagation();
      togglePlayback();
    });

    /* Device name editor (help overlay). Empty value = reset to default. */
    el.nameSaveButton.addEventListener("click", function () {
      if (!BASE) {
        return;
      }
      var name = el.nameInput.value.trim();
      request("POST", BASE + "/renderer/device-name", { name: name }, function (data) {
        if (data) {
          lastRev = Math.max(lastRev, data.rev || lastRev);
          showToast(name ? "设备名称已更新" : "已恢复默认名称", 2200);
          try {
            if (name) {
              localStorage.setItem("customDeviceName", name);
            } else {
              localStorage.removeItem("customDeviceName");
            }
          } catch (error) {}
        } else {
          showToast("名称更新失败", 2500);
        }
      }, 6000);
    });

    /* WiFi sharing settings (help overlay). */
    el.wifiSaveButton.addEventListener("click", function () {
      if (!BASE) {
        return;
      }
      var payload = { ssid: el.wifiSsidInput.value.trim() };
      var password = el.wifiPasswordInput.value;
      if (password !== "") {
        payload.password = password;
      }
      request("POST", BASE + "/renderer/wifi", payload, function (data) {
        if (data) {
          lastRev = Math.max(lastRev, data.rev || lastRev);
          el.wifiPasswordInput.value = "";
          showToast("WiFi 二维码已更新", 2200);
        } else {
          showToast("保存失败", 2500);
        }
      }, 6000);
    });

    el.wifiClearButton.addEventListener("click", function () {
      if (!BASE) {
        return;
      }
      request("POST", BASE + "/renderer/wifi", { password: null }, function (data) {
        if (data) {
          lastRev = Math.max(lastRev, data.rev || lastRev);
          el.wifiPasswordInput.value = "";
          showToast("已清除 WiFi 密码", 2200);
        }
      }, 6000);
    });

    /* Magic-remote pointer movement reveals the HUD (end button / seek bar). */
    var lastMouseShow = 0;
    document.addEventListener("mousemove", function () {
      var now = Date.now();
      if (now - lastMouseShow < 1200) {
        return;
      }
      lastMouseShow = now;
      if (isStageVisible()) {
        showHud();
      }
    });

    /* Click / magic-remote pointer anywhere on the bottom control block
     * (progress bar + time row) seeks; the play/pause button is excluded. */
    var hudBar = document.getElementById("hudBar");
    var hudBottom = document.querySelector(".hud-bottom");
    if (hudBar && hudBottom) {
      hudBottom.addEventListener("click", function (event) {
        if (event.target && event.target.closest &&
            event.target.closest("#playPauseButton")) {
          return;
        }
        event.stopPropagation();
        var rect = hudBar.getBoundingClientRect();
        if (!rect.width) {
          return;
        }
        var ratio = (event.clientX - rect.left) / rect.width;
        ratio = Math.max(0, Math.min(1, ratio));
        var duration = el.player.duration;
        if (isFinite(duration) && duration > 0) {
          debugLog("seek", "bar click -> " + Math.floor(ratio * duration) + "s");
          seekTo(ratio * duration);
        }
      });
    }

    document.addEventListener("visibilitychange", function () {
      pageHidden = !!document.hidden;
      debugLog("boot", "page hidden=" + pageHidden);
      if (pageHidden) {
        if (hudHideTimer) {
          clearTimeout(hudHideTimer);
          hudHideTimer = null;
        }
        return;
      }
      /* Back in foreground: repaint from the latest snapshot. */
      if (status) {
        applyStatus(status);
      }
    });

    document.addEventListener("keydown", onKey);
    document.addEventListener("click", function () {
      if (isStageVisible()) {
        showHud();
      }
    });
  }

  /* Luna keepalive: webOS reaps idle on-demand JS services, so the
   * front-end holds a permanent status subscription. Payloads are used
   * only as a fallback feed while the HTTP channel is offline. */
  function startLunaKeepalive() {
    if (!lunaAvailable) {
      return;
    }
    lunaRequest("luna://com.castreceiver.tv.service", "status", { subscribe: true }, function (response) {
      if (response && response.returnValue && !BASE) {
        /* HTTP channel down: luna push as fallback, and adopt the
         * service base URL it carries */
        debugLog("poll", "luna fallback push applied (rev " + response.rev + ")");
        lastRev = response.rev;
        status = response;
        applyStatus(response);
        if (response.service && response.service.base) {
          BASE = response.service.base;
          startPolling();
        }
      }
    }, function () {
      /* Subscription dropped (service reaped or TV restarted):
       * retry — calling luna again re-spawns the service. */
      debugLog("boot", "luna keepalive lost; retrying in 5s");
      setTimeout(startLunaKeepalive, 5000);
    }, { subscribe: true, resubscribe: true });
  }

  /* Device model fallback: if the service could not read the TV model
   * itself, report it from the app side (different ACG permissions). */
  function reportDeviceModel() {
    if (!lunaAvailable || !BASE) {
      return;
    }
    lunaRequest("luna://com.webos.service.tv.system", "getSystemInfo", { keys: ["modelName"] }, function (response) {
      if (response && response.modelName && BASE) {
        debugLog("boot", "app-side model: " + response.modelName);
        request("POST", BASE + "/renderer/device-name", { modelName: response.modelName }, null, 5000);
      }
    }, null);
  }

  /* ============================ QR code ============================ */

  /* qrcode-generator defaults to Latin-1 byte encoding; override with a
   * proper UTF-8 encoder so Chinese SSIDs/passwords scan correctly. */
  (function setupQrUtf8() {
    if (typeof qrcode !== "function") {
      return;
    }
    qrcode.stringToBytes = function (text) {
      var bytes = [];
      for (var i = 0; i < text.length; i += 1) {
        var code = text.charCodeAt(i);
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          var next = text.charCodeAt(i + 1);
          var combined = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          bytes.push(
            0xf0 | (combined >> 18),
            0x80 | ((combined >> 12) & 0x3f),
            0x80 | ((combined >> 6) & 0x3f),
            0x80 | (combined & 0x3f)
          );
          i += 1;
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      return bytes;
    };
  }());

  function drawQrTo(canvas, fallback, text) {
    try {
      var qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();

      var size = 360;
      var margin = 16;
      var count = qr.getModuleCount();
      var cell = Math.floor((size - margin * 2) / count);
      var offset = Math.floor((size - cell * count) / 2);

      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#0b1b28";
      for (var row = 0; row < count; row += 1) {
        for (var col = 0; col < count; col += 1) {
          if (qr.isDark(row, col)) {
            ctx.fillRect(offset + col * cell, offset + row * cell, cell, cell);
          }
        }
      }
      canvas.style.display = "block";
      fallback.style.display = "none";
    } catch (error) {
      canvas.style.display = "none";
      fallback.style.display = "flex";
    }
  }

  function drawQr(text) {
    drawQrTo(el.qrCanvas, el.qrFallback, text);
  }

  /* WiFi join QR: standard "WIFI:" payload — iOS Camera joins natively,
   * Android 10+ scans it from Settings > WiFi. */
  var lastWifiKey = "";

  function escapeWifiField(value) {
    return String(value || "").replace(/([\\;,:"])/g, "\\$1");
  }

  function drawWifiQr(ssid, password) {
    if (!ssid) {
      el.wifiQrCanvas.style.display = "none";
      el.wifiQrFallback.style.display = "flex";
      el.wifiQrFallback.innerHTML = "未检测到 WiFi<br>请在设置中填写";
      return;
    }
    var payload = "WIFI:T:WPA;S:" + escapeWifiField(ssid) + ";";
    if (password) {
      payload += "P:" + escapeWifiField(password) + ";";
    }
    payload += ";";
    drawQrTo(el.wifiQrCanvas, el.wifiQrFallback, payload);
    setTextCached(el.wifiSsidText, "网络：" + ssid);
    setTextCached(el.wifiQrDesc, password
      ? "iPhone 用相机扫码 · 安卓用 WiFi 设置扫码"
      : "未设置密码：扫码后手动输入密码（可在设置中填写）");
  }

  function updateWifiQr(data) {
    var wifi = data.wifi;
    if (!wifi) {
      return;
    }
    var key = (wifi.ssid || "") + "|" + (wifi.hasPassword ? "1" : "0");
    if (key === lastWifiKey) {
      return;
    }
    lastWifiKey = key;
    debugLog("boot", "wifi qr update ssid=" + (wifi.ssid || "(none)") +
      " hasPassword=" + !!wifi.hasPassword);
    if (!wifi.ssid) {
      drawWifiQr("", "");
      return;
    }
    /* Fetch the password over Luna (never exposed on the HTTP API); if the
     * channel is unavailable, still draw an SSID-only QR. */
    lunaRequest("luna://com.castreceiver.tv.service", "wifi", {}, function (response) {
      drawWifiQr(wifi.ssid, (response && response.password) || "");
    }, function () {
      drawWifiQr(wifi.ssid, "");
    });
  }

  /* ============================ Bootstrap ============================ */

  function init() {
    debugLog("boot", "front-end starting; lunaAvailable=" + lunaAvailable);
    bindPlayerEvents();
    bindUi();
    el.footerVersion.textContent = "v0.0.6";

    if (!lunaAvailable) {
      lunaAudioOk = false;
    } else {
      /* Subscribe to system volume changes right away. */
      lunaRequest("luna://com.webos.audio/", "getVolume", {}, function (response) {
        if (response && typeof response.volume === "number") {
          lunaAudioOk = true;
          lastReportedVolume = Math.round(response.volume);
          lastReportedMute = !!response.mute;
          subscribeTvVolume();
        }
      }, function () {
        lunaAudioOk = false;
      });
    }

    resolveBase(function (base) {
      if (!base) {
        setServiceChip(false, "后台服务未运行");
        showToast("未检测到后台服务，请确认应用已正确安装", 5000);
        setTimeout(function () {
          resolveBase(function (retryBase) {
            if (retryBase) {
              BASE = retryBase;
              startPolling();
            } else {
              handleOffline();
            }
          });
        }, 4000);
        return;
      }
      BASE = base;
      setServiceChip(true, "服务已连接");
      debugLog("boot", "polling started");
      startPolling();
      startLunaKeepalive();
      reportDeviceModel();
      postState({});
      setInterval(pollTvVolumeFallback, 15000);
    });
  }

  init();
}());
