/*
 * Generate the PNG assets required by a webOS TV app
 * (icon.png / largeIcon.png / bgImage.png).
 * Pure Node implementation (zlib + hand-written PNG encoder),
 * no third-party dependencies.
 *
 *   node scripts/gen-assets.js
 *
 * App icon artwork: a vivid blue/mint glass tile with a TV screen, play
 * symbol, and subtle wireless signal. The app background remains dark navy.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

/* ---------------- PNG encoder ---------------- */

var CRC_TABLE = (function () {
  var table = new Array(256);
  var c;
  var n;
  var k;
  for (n = 0; n < 256; n += 1) {
    c = n;
    for (k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  var c = 0xffffffff;
  var i;
  for (i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, "ascii");
  var crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  var signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  var stride = width * 4;
  var raw = Buffer.alloc((stride + 1) * height);
  var y;
  for (y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/* ---------------- Drawing ---------------- */

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smooth(edge0, edge1, x) {
  var t = (x - edge0) / (edge1 - edge0);
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  var cx = Math.max(x0, Math.min(px, x1));
  var cy = Math.max(y0, Math.min(py, y1));
  var dx = px - cx;
  var dy = py - cy;
  var outside = Math.sqrt(dx * dx + dy * dy);
  var inside = Math.min(px - x0, x1 - px, py - y0, y1 - py);
  return Math.max(outside, inside) - r;
}

function sdArc(px, py, cx, cy, r, start, end) {
  // Signed distance from a plane to a circular arc
  // (start/end in radians, start < end).
  var dx = px - cx;
  var dy = py - cy;
  var d = Math.sqrt(dx * dx + dy * dy);
  var a = Math.atan2(dy, dx);
  var normal = (a - start) % (Math.PI * 2);
  if (normal < 0) {
    normal += Math.PI * 2;
  }
  if (normal > end - start) {
    // Outside the angular range: distance to the nearest arc endpoint.
    var ex = cx + r * Math.cos(end);
    var ey = cy + r * Math.sin(end);
    var sx = cx + r * Math.cos(start);
    var sy = cy + r * Math.sin(start);
    var de = Math.sqrt((px - ex) * (px - ex) + (py - ey) * (py - ey));
    var ds = Math.sqrt((px - sx) * (px - sx) + (py - sy) * (py - sy));
    return Math.min(de, ds);
  }
  return Math.abs(d - r);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  var dx = bx - ax;
  var dy = by - ay;
  var lengthSquared = dx * dx + dy * dy;
  var t = lengthSquared ? ((px - ax) * dx + (py - ay) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  dx = px - (ax + t * dx);
  dy = py - (ay + t * dy);
  return Math.sqrt(dx * dx + dy * dy);
}

function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  var d = Math.min(
    distanceToSegment(px, py, ax, ay, bx, by),
    distanceToSegment(px, py, bx, by, cx, cy),
    distanceToSegment(px, py, cx, cy, ax, ay)
  );
  var ab = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  var bc = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  var ca = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return ab >= 0 && bc >= 0 && ca >= 0 || ab <= 0 && bc <= 0 && ca <= 0 ? -d : d;
}

function paintShape(color, target, distance, softness) {
  var coverage = 1 - smooth(-softness, softness, distance);
  color[0] = mix(color[0], target[0], coverage);
  color[1] = mix(color[1], target[1], coverage);
  color[2] = mix(color[2], target[2], coverage);
}

/**
 * Color at normalized coordinates (u, v) in 0..1.
 *
 * bright=true  -> app icon: vivid blue->mint gradient with a glass tile,
 *                 television outline, play symbol, and wireless detail.
 * bright=false -> app background image: dark navy gradient (the UI theme
 *                 depends on a dark backdrop).
 */
function pixelColor(u, v, size, withGlyph, bright) {
  var r;
  var g;
  var b;

  if (bright) {
    // Vivid diagonal gradient: #1B6BFF -> #21CFAE with a soft highlight
    var t2 = u * 0.55 + v * 0.45;
    r = mix(27, 33, t2);
    g = mix(107, 207, t2);
    b = mix(255, 174, t2);
    var hl = Math.max(0, 1 - Math.sqrt((u - 0.22) * (u - 0.22) + (v - 0.16) * (v - 0.16)) * 2.1);
    r += hl * 30;
    g += hl * 34;
    b += hl * 20;
  } else {
    // Dark navy gradient: #0d2233 -> #1a5468 with a soft glow
    var t = u * 0.45 + v * 0.55;
    r = mix(13, 26, t);
    g = mix(34, 84, t);
    b = mix(51, 108, t);
    var glow = Math.max(0, 1 - Math.sqrt((u - 0.25) * (u - 0.25) + (v - 0.12) * (v - 0.12)) * 2.2);
    glow = glow * glow * 46;
    r += glow * 0.35;
    g += glow * 0.8;
    b += glow * 1.0;
  }

  var alpha = 1;
  if (withGlyph) {
    var px = u * size;
    var py = v * size;
    var s = size;
    var color = [r, g, b];
    var aa = Math.max(0.7, size * 0.006);

    /* A softly tinted rounded tile adds depth while preserving the vivid
     * gradient at the corners of the icon. */
    var tile = sdRoundRect(px, py, 0.105 * s, 0.105 * s, 0.895 * s, 0.895 * s, 0.19 * s);
    paintShape(color, [8, 24, 54], tile, aa);
    var tileEdge = Math.abs(tile) - 0.012 * s;
    paintShape(color, [137, 246, 237], tileEdge, aa);

    /* TV screen: a clean bright bezel around a dark display. */
    var outerScreen = sdRoundRect(px, py, 0.205 * s, 0.235 * s, 0.795 * s, 0.695 * s, 0.075 * s);
    paintShape(color, [239, 250, 255], outerScreen, aa);
    var innerScreen = sdRoundRect(px, py, 0.252 * s, 0.282 * s, 0.748 * s, 0.648 * s, 0.038 * s);
    paintShape(color, [8, 31, 59], innerScreen, aa);

    /* Mint play glyph centered on the display. */
    var play = sdTriangle(
      px, py,
      0.438 * s, 0.365 * s,
      0.438 * s, 0.565 * s,
      0.605 * s, 0.465 * s
    );
    paintShape(color, [104, 247, 205], play, aa);

    /* TV stand and foot. */
    var stand = sdRoundRect(px, py, 0.473 * s, 0.685 * s, 0.527 * s, 0.795 * s, 0.022 * s);
    paintShape(color, [239, 250, 255], stand, aa);
    var foot = sdRoundRect(px, py, 0.365 * s, 0.785 * s, 0.635 * s, 0.835 * s, 0.022 * s);
    paintShape(color, [239, 250, 255], foot, aa);

    /* Small cast-wave mark in the upper-right corner of the tile. */
    var signalX = 0.735 * s;
    var signalY = 0.205 * s;
    var signalDot = Math.sqrt((px - signalX) * (px - signalX) + (py - signalY) * (py - signalY)) - 0.018 * s;
    paintShape(color, [255, 255, 255], signalDot, aa);
    var wave1 = sdArc(px, py, signalX, signalY, 0.055 * s, Math.PI, Math.PI * 1.5) - 0.012 * s;
    var wave2 = sdArc(px, py, signalX, signalY, 0.095 * s, Math.PI, Math.PI * 1.5) - 0.012 * s;
    paintShape(color, [255, 255, 255], Math.min(wave1, wave2), aa);

    r = color[0];
    g = color[1];
    b = color[2];
  }

  return [Math.min(255, Math.round(r)), Math.min(255, Math.round(g)), Math.min(255, Math.round(b)), Math.round(alpha * 255)];
}

function render(size, withGlyph, bright) {
  var buf = Buffer.alloc(size * size * 4);
  var x;
  var y;
  var c;
  for (y = 0; y < size; y += 1) {
    for (x = 0; x < size; x += 1) {
      c = pixelColor((x + 0.5) / size, (y + 0.5) / size, size, withGlyph, bright);
      var o = (y * size + x) * 4;
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      buf[o + 3] = c[3];
    }
  }
  return buf;
}

function renderWide(width, height) {
  var buf = Buffer.alloc(width * height * 4);
  var x;
  var y;
  var c;
  for (y = 0; y < height; y += 1) {
    for (x = 0; x < width; x += 1) {
      c = pixelColor((x + 0.5) / width, (y + 0.5) / height, Math.min(width, height), false, false);
      var o = (y * width + x) * 4;
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      buf[o + 3] = c[3];
    }
  }
  return buf;
}

var outDir = path.join(__dirname, "..", "app");
fs.writeFileSync(path.join(outDir, "icon.png"), encodePng(80, 80, render(80, true, true)));
fs.writeFileSync(path.join(outDir, "largeIcon.png"), encodePng(130, 130, render(130, true, true)));
fs.writeFileSync(path.join(outDir, "bgImage.png"), encodePng(1920, 1080, renderWide(1920, 1080)));
console.log("icon.png / largeIcon.png / bgImage.png generated into " + outDir);
