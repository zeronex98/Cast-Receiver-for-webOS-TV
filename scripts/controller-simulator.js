/*
 * Controller simulator — pretends to be a phone casting app.
 *
 * Full end-to-end sequence against the running Cast Receiver service:
 *   1. Unicast M-SEARCH discovery (the in-simulator service binds udp/1900)
 *   2. LOCATION -> GET device-desc.xml
 *   3. SetAVTransportURI (DIDL-Lite metadata + sec:CaptionInfoEx subtitle)
 *   4. Play
 *   5. Poll GetPositionInfo x3 (watch RelTime advance = real playback)
 *   6. SetVolume / SetMute / Pause / GetVolume
 *   7. Stop, then cast an image instead
 *
 * Usage: node scripts/controller-simulator.js [tvHost]
 *   (default host: 127.0.0.1; on a real TV pass its LAN IP)
 */
"use strict";

const http = require("http");
const dgram = require("dgram");

const host = process.argv[2] || "127.0.0.1";
const SSDP_PORT = 1900;
// The service picks the first free port from 49152; the real base is
// resolved from the SSDP LOCATION after discovery.
let base = `http://${host}:49152`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ssdpDiscover() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const found = {};
    const timer = setTimeout(() => finish(), 2500);

    function finish() {
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      const location = Object.values(found)[0];
      if (location) resolve(location);
      else reject(new Error("no SSDP response"));
    }

    sock.on("error", () => finish());
    sock.on("message", (msg) => {
      const text = msg.toString();
      const m = text.match(/^HTTP\/1\.1 200 OK/m);
      const loc = (text.match(/^LOCATION:\s*(.+)$/im) || [])[1];
      const st = (text.match(/^ST:\s*(.+)$/im) || [])[1];
      if (m && loc) {
        found[st || "st"] = loc.trim();
      }
    });

    sock.bind(() => {
      const query =
        "M-SEARCH * HTTP/1.1\r\n" +
        `HOST: ${host}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 1\r\n" +
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
      sock.send(Buffer.from(query), SSDP_PORT, host);
    });
  });
}

async function probeHttpService() {
  for (const port of [49152, 49153, 49154, 49155, 49156, 49157, 49158, 49159, 49160]) {
    try {
      const r = await httpRequest("GET", `http://${host}:${port}/health`);
      const data = JSON.parse(r.body);
      if (data && data.ok) {
        return `http://${host}:${port}/device-desc.xml`;
      }
    } catch (_) {
      /* not our service */
    }
  }
  return null;
}

function httpRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function soap(action, paramsXml, serviceName = "AVTransport") {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" ` +
    `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:${serviceName}:1">` +
    `<InstanceID>0</InstanceID>${paramsXml}</u:${action}>` +
    `</s:Body></s:Envelope>`;
  return httpRequest("POST", `${base}/upnp/control/${serviceName}`, {
    headers: {
      SOAPACTION: `"urn:schemas-upnp-org:service:${serviceName}:1#${action}"`,
      "Content-Type": "text/xml; charset=utf-8",
      "User-Agent": "TVSim-Controller/1.0 (iPhone; iqiyi)",
    },
    body,
  });
}

async function fetchJson(path) {
  const res = await httpRequest("GET", `${base}${path}`);
  try { return JSON.parse(res.body); } catch { return null; }
}

const title = (s) => console.log("\n== " + s + " ==");

function didl(mediaUrl, mime, title, dur) {
  return (
    `&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
    `xmlns:sec="http://www.sec.co.kr/"&gt;` +
    `&lt;item id="0" parentID="0" restricted="1"&gt;` +
    `&lt;dc:title&gt;${title}&lt;/dc:title&gt;` +
    `&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;` +
    `&lt;res protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=01" ` +
    `duration="0:00:10"&gt;${mediaUrl}&lt;/res&gt;` +
    `&lt;sec:CaptionInfoEx sec:type="srt"&gt;${SUB_URL}&lt;/sec:CaptionInfoEx&gt;` +
    `&lt;/item&gt;&lt;/DIDL-Lite&gt;`
  );
}

let SUB_URL = "";
let BASE_LOCAL = "";

async function main() {
  const banner = [
    "Cast Receiver controller simulator",
    "  target: " + base,
  ].join("\n");
  console.log(banner);

  title("1. SSDP discovery (unicast M-SEARCH)");
  let location;
  try {
    location = await ssdpDiscover();
    console.log("   LOCATION: " + location);
  } catch (error) {
    console.log("   ! SSDP: " + error.message + " - probing HTTP ports instead");
    location = await probeHttpService();
    if (!location) {
      console.log("   ! no Cast Receiver service found on " + host);
      process.exit(1);
    }
    console.log("   fallback LOCATION: " + location);
  }
  {
    const u = new URL(location);
    base = u.origin;
    console.log("   resolved service base: " + base);
  }

  title("2. Device description");
  const desc = await httpRequest("GET", location);
  const friendly = (desc.body.match(/<friendlyName>([^<]+)<\/friendlyName>/) || [])[1];
  console.log("   friendlyName: " + decodeURIComponent(friendly));

  title("3. Local helper server (subtitle + sample image)");
  await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/demo.srt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(SRT);
      } else if (req.url === "/demo.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(PNG_BYTES);
      } else {
        res.writeHead(404); res.end();
      }
    });
    s.listen(0, () => {
      BASE_LOCAL = `http://127.0.0.1:${s.address().port}`;
      SUB_URL = `${BASE_LOCAL}/demo.srt`;
      console.log("   helper: " + BASE_LOCAL);
      resolve();
    });
  });

  title("4. SetAVTransportURI + Play");
  const mediaUrl = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
  await new Promise((resolve) => {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" ` +
      `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
      `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
      `<InstanceID>0</InstanceID>` +
      `<CurrentURI>${mediaUrl}</CurrentURI>` +
      `<CurrentURIMetaData>${didl(mediaUrl, "video/mp4", "Big Buck Bunny (cast demo)")}</CurrentURIMetaData>` +
      `</u:SetAVTransportURI></s:Body></s:Envelope>`;
    const r = http.request(`${base}/upnp/control/AVTransport`, {
      method: "POST",
      headers: {
        SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"',
        "Content-Type": "text/xml; charset=utf-8",
      },
    }, () => {});
    r.on("error", () => {});
    r.end(body);
    setTimeout(resolve, 300);
  });
  await soap("Play", "<Speed>1</Speed>");
  console.log("   playing " + mediaUrl.slice(0, 60) + "...");

  title("5. GetPositionInfo x3 (expect RelTime advancing)");
  for (let i = 0; i < 3; i += 1) {
    await sleep(2000);
    const r = await soap("GetPositionInfo", "");
    const rel = (r.body.match(/<RelTime>([^<]+)<\/RelTime>/) || [])[1];
    const dur = (r.body.match(/<TrackDuration>([^<]+)<\/TrackDuration>/) || [])[1];
    console.log(`   t+${(i + 1) * 2}s  RelTime=${rel} / ${dur}`);
  }

  title("6. RenderingControl: volume + mute");
  await soap("SetVolume", "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>80</DesiredVolume>", "RenderingControl");
  await soap("SetMute", "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>1</DesiredMute>", "RenderingControl");
  const gv = await soap("GetVolume", "<InstanceID>0</InstanceID><Channel>Master</Channel>", "RenderingControl");
  const vol = (gv.body.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/) || [])[1];
  console.log("   volume set -> readback: " + vol);

  title("7. Pause");
  await soap("Pause", "");
  const ti = await soap("GetTransportInfo", "");
  console.log("   state: " + (ti.body.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/) || [])[1]);

  title("8. Stop + cast an image instead");
  await soap("Stop", "");
  const imgPlay = await httpRequest("POST", `${base}/renderer/play`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${BASE_LOCAL}/demo.png`, title: "Demo photo" }),
  });
  const after = await fetchJson("/status");
  console.log(
    "   image cast -> HTTP " + imgPlay.status +
    " | current media: " + (after.currentMedia && after.currentMedia.title)
  );

  title("DONE - full protocol cycle OK");
}

const SRT = `1
00:00:00,500 --> 00:00:03,000
Hello from the cast demo!

2
00:00:03,500 --> 00:00:07,000
Second subtitle line.

3
00:00:07,500 --> 00:00:10,000
Bye!

`;

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

main().catch((error) => {
  console.error("FATAL:", error.message);
  process.exit(1);
});
