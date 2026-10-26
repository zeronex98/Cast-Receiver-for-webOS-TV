/*
 * Bump the project version everywhere it is stored.
 *
 *   node scripts/bump-version.js 1.2.0
 *
 * Touches:
 *   - app/appinfo.json
 *   - packageinfo.json
 *   - services/com.castreceiver.tv.service/package.json
 *   - services/com.castreceiver.tv.service/service.js  (VERSION constant)
 *   - app/app.js                                       (footer text)
 *   - app/index.html                                   (static footer text)
 */
"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/bump-version.js <x.y.z>");
  process.exit(1);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

function writeJson(relative, data) {
  fs.writeFileSync(path.join(ROOT, relative), JSON.stringify(data, null, 2) + "\n");
}

function patchFile(relative, pattern, replacement) {
  var file = path.join(ROOT, relative);
  var source = fs.readFileSync(file, "utf8");
  var updated = source.replace(pattern, replacement);
  if (updated === source) {
    console.warn("  ! no change in " + relative + " (pattern not found)");
    return;
  }
  fs.writeFileSync(file, updated);
  console.log("  ok " + relative);
}

/* JSON metadata */
["app/appinfo.json", "packageinfo.json", "services/com.castreceiver.tv.service/package.json"].forEach(function (relative) {
  var data = readJson(relative);
  data.version = version;
  writeJson(relative, data);
  console.log("  ok " + relative);
});

/* Service VERSION constant */
patchFile(
  "services/com.castreceiver.tv.service/service.js",
  /var VERSION = "\d+\.\d+\.\d+";/,
  'var VERSION = "' + version + '";'
);

/* Front-end footer (both the dynamic text and the static fallback) */
patchFile("app/app.js", /textContent = "v\d+\.\d+\.\d+";/, 'textContent = "v' + version + '";');
patchFile("app/index.html", /id="footerVersion">v\d+\.\d+\.\d+</, 'id="footerVersion">v' + version + "<");

console.log("Version bumped to " + version + ".");
