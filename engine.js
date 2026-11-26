/* RailPulse analysis engine.
 *
 * A dependency free GTFS timetable parser and rail operations analyzer. The
 * same file runs as a plain browser script (attaches to window.RailPulse) and
 * as a CommonJS module (module.exports). No build step, no network calls, no
 * external packages.
 *
 * The normalized unit of data is a Service, one direction of one route:
 *   {
 *     id, name, shortName, operator, kind, directionLabel, colorKey,
 *     source: "synthetic" | "gtfs",
 *     plannedHeadwaySec, startSec, endSec,
 *     stops:  [ { id, code, name, lat, lon, miles, dwellSec } ],
 *     trips:  [ { tripId, routeId, headsign, direction, serviceId,
 *                 stopTimes: [ { stopId, seq, arrivalSec, departureSec,
 *                                miles, headsign } ] } ],
 *     observedTrips: [ ...same shape... ] | null
 *   }
 *
 * All times are seconds from the start of the service day and may exceed
 * 86400 for trips running after midnight, exactly like GTFS HH:MM:SS.
 */
(function (root) {
  "use strict";
  var ns = root.RailPulse || (root.RailPulse = {});

  /* ------------------------------------------------------------------ *
   * Math and stats helpers
   * ------------------------------------------------------------------ */

  var EARTH_RADIUS_MILES = 3958.7614585;
  var DEG = Math.PI / 180;

  function isFiniteNum(x) { return typeof x === "number" && isFinite(x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function round(x, dp) { var f = Math.pow(10, dp || 0); return Math.round(x * f) / f; }

  function mean(a) {
    if (!a || !a.length) return 0;
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (isFiniteNum(a[i])) { s += a[i]; n++; }
    return n ? s / n : 0;
  }
  function stddev(a) {
    if (!a || a.length < 2) return 0;
    var clean = a.filter(isFiniteNum);
    if (clean.length < 2) return 0;
    var m = mean(clean), s = 0;
    for (var i = 0; i < clean.length; i++) { var d = clean[i] - m; s += d * d; }
    return Math.sqrt(s / (clean.length - 1));
  }
  function percentile(sorted, p) {
    if (!sorted || !sorted.length) return 0;
    var idx = clamp(p, 0, 1) * (sorted.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function median(a) {
    if (!a || !a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    return percentile(s, 0.5);
  }
  function sum(a) { if (!a || !a.length) return 0; var t = 0; for (var i = 0; i < a.length; i++) if (isFiniteNum(a[i])) t += a[i]; return t; }

  function populationVariance(a) {
    if (!Array.isArray(a) || !a.length) return 0;
    var clean = a.filter(isFiniteNum);
    if (!clean.length) return 0;
    var m = mean(clean);
    if (!isFiniteNum(m)) return Infinity;
    var s = 0;
    for (var i = 0; i < clean.length; i++) {
      var d = clean[i] - m, sq = d * d;
      if (!isFiniteNum(sq)) return Infinity;
      s += sq;
    }
    return s / clean.length;
  }

  /* Convenience: variation of a sample around its mean. */
  function coefficientOfVariation(a) {
    var m = mean(a);
    if (!m) return 0;
    return stddev(a) / m;
  }

  /* Haversine distance in miles between two WGS84 points. */
  function geoDistanceMiles(a, b) {
    var dLat = (b[0] - a[0]) * DEG;
    var dLon = (b[1] - a[1]) * DEG;
    var la1 = a[0] * DEG, la2 = b[0] * DEG;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(clamp(h, 0, 1)));
  }

  /* Linear interpolation along a polyline of [lat, lon] anchors by
   * cumulative distance. Returns the point at fraction t in [0, 1]. */
  function pointAlong(anchors, t) {
    if (!anchors || !anchors.length) return [0, 0];
    if (anchors.length === 1) return [anchors[0][0], anchors[0][1]];
    var segs = [], total = 0, i;
    for (i = 0; i < anchors.length - 1; i++) {
      var d = geoDistanceMiles(anchors[i], anchors[i + 1]);
      segs.push(d);
      total += d;
    }
    if (total <= 0) return [anchors[0][0], anchors[0][1]];
    var target = clamp(t, 0, 1) * total, acc = 0;
    for (i = 0; i < segs.length; i++) {
      if (acc + segs[i] >= target || i === segs.length - 1) {
        var f = segs[i] > 0 ? (target - acc) / segs[i] : 0;
        return [
          anchors[i][0] + (anchors[i + 1][0] - anchors[i][0]) * f,
          anchors[i][1] + (anchors[i + 1][1] - anchors[i][1]) * f
        ];
      }
      acc += segs[i];
    }
    return [anchors[anchors.length - 1][0], anchors[anchors.length - 1][1]];
  }

  /* Given station mileposts and corridor anchors, assign approximate WGS84
   * coordinates by interpolating each station's normalized route distance. */
  function interpolateStationCoordinates(anchors, stations) {
    var originMile = stations.length ? stations[0][2] : 0;
    var maxMile = originMile, i;
    for (i = 0; i < stations.length; i++) {
      if (stations[i][2] > maxMile) maxMile = stations[i][2];
    }
    var mileSpan = maxMile - originMile;
    if (mileSpan <= 0) mileSpan = 1;
    var out = [];
    for (i = 0; i < stations.length; i++) {
      var p = pointAlong(anchors, (stations[i][2] - originMile) / mileSpan);
      out.push([round(p[0], 6), round(p[1], 6)]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Time formatting and parsing
   * ------------------------------------------------------------------ */

  /* Parse a GTFS HH:MM:SS (or H:MM:SS) string into seconds from service-day
   * start. Hours may exceed 23 for after-midnight trips. Returns NaN on bad
   * input. */
  function parseGtfsTime(str) {
    if (str == null) return NaN;
    var s = String(str).trim();
    if (!/^\d{1,3}:\d{2}:\d{2}$/.test(s)) return NaN;
    var parts = s.split(":");
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var sec = parseInt(parts[2], 10);
    if (m > 59 || sec > 59) return NaN;
    return h * 3600 + m * 60 + sec;
  }

  /* Format seconds-from-service-day-start back to HH:MM:SS. Hours above 24
   * are preserved (GTFS style), so 25:10:00 stays 25:10:00. */
  function formatGtfsTime(sec) {
    if (!isFiniteNum(sec) || sec < 0) return "";
    var t = Math.round(sec);
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  }

  /* Format a number of seconds as a compact human duration, e.g. 7m 30s. */
  function formatDuration(sec) {
    if (!isFiniteNum(sec)) return "n/a";
    var neg = sec < 0;
    var t = Math.round(Math.abs(sec));
    var m = Math.floor(t / 60);
    var s = t % 60;
    var out = m > 0 ? (m + "m") : "";
    if (s > 0 || m === 0) out += (out ? " " : "") + s + "s";
    return (neg ? "-" : "") + out;
  }

  /* ------------------------------------------------------------------ *
   * CSV parsing (RFC 4180)
   * ------------------------------------------------------------------ */

  /* Split a single CSV row into fields, honoring double quotes and doubled
   * quote escapes. */
  function splitCsvRow(row) {
    var fields = [], cur = "", i = 0, inQuotes = false, closedQuote = false;
    while (i < row.length) {
      var c = row.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (row.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
          inQuotes = false; closedQuote = true; i++; continue;
        }
        cur += c; i++; continue;
      }
      if (closedQuote && c !== ",") throw new Error("Invalid CSV: characters after closing quote");
      if (c === '"' && cur === "" && !closedQuote) { inQuotes = true; i++; continue; }
      if (c === '"') throw new Error("Invalid CSV: quote inside unquoted field");
      if (c === ",") { fields.push(cur); cur = ""; closedQuote = false; i++; continue; }
      cur += c; i++;
    }
    if (inQuotes) throw new Error("Invalid CSV: unterminated quoted field");
    fields.push(cur);
    return fields;
  }

  function stripBom(s) {
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  }

  /* Parse CSV text into an array of row objects keyed by header names.
   * Handles quoted fields containing commas, quoted newlines, CRLF and LF
   * line endings, and a UTF-8 BOM. Blank trailing rows are skipped. */
  function parseCsv(text) {
    text = stripBom(String(text));
    if (!text.trim()) return [];
    var rows = [];
    var field = "", record = [], inQuotes = false, closedQuote = false, i = 0;
    while (i < text.length) {
      var c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; closedQuote = true; i++; continue;
        }
        field += c; i++; continue;
      }
      if (closedQuote && c !== "," && c !== "\r" && c !== "\n") throw new Error("Invalid CSV: characters after closing quote");
      if (c === '"' && field === "" && !closedQuote) { inQuotes = true; i++; continue; }
      if (c === '"') throw new Error("Invalid CSV: quote inside unquoted field");
      if (c === ",") { record.push(field); field = ""; closedQuote = false; i++; continue; }
      if (c === "\r" || c === "\n") {
        if (c === "\r" && text.charAt(i + 1) === "\n") i++;
        record.push(field);
        rows.push(record);
        record = []; field = ""; closedQuote = false; i++; continue;
      }
      field += c; i++;
    }
    if (inQuotes) throw new Error("Invalid CSV: unterminated quoted field");
    if (field !== "" || record.length || closedQuote) { record.push(field); rows.push(record); }

    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    var names = Object.create(null);
    header.forEach(function (name) {
      if (!name || names[name]) throw new Error("Invalid CSV: empty or duplicate header " + name);
      names[name] = true;
    });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var raw = rows[r];
      if (raw.length === 1 && raw[0].trim() === "") continue;
      if (raw.length > header.length) throw new Error("Invalid CSV: too many fields on record " + (r + 1));
      var obj = Object.create(null);
      for (var k = 0; k < header.length; k++) {
        if (header[k] === "") continue;
        obj[header[k]] = raw[k] === undefined ? "" : raw[k];
      }
      out.push(obj);
    }
    return out;
  }

  /* ZIP extraction uses central-directory sizes, verifies CRC32 and bounds,
   * and includes a raw DEFLATE decoder for browsers without that stream type.
   * ZIP64, encrypted archives and unsupported codecs are rejected explicitly. */
  var MAX_FEED_BYTES = 128 * 1024 * 1024;
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function inflateRawFallback(bytes, expectedSize) {
    var out = new Uint8Array(expectedSize), count = 0, bit = 0;
    function bits(n) {
      if (bit + n > bytes.length * 8) throw new Error("Invalid DEFLATE: truncated bitstream");
      var v = 0;
      for (var i = 0; i < n; i++, bit++) v |= ((bytes[bit >>> 3] >>> (bit & 7)) & 1) << i;
      return v;
    }
    function emit(v) {
      if (count >= expectedSize) throw new Error("Invalid DEFLATE: expanded size exceeds ZIP header");
      out[count++] = v;
    }
    function tree(lengths) {
      var counts = new Uint16Array(16), next = new Uint16Array(16), tables = [], max = 0;
      lengths.forEach(function (n) {
        if (n < 0 || n > 15) throw new Error("Invalid DEFLATE: Huffman length");
        if (n) { counts[n]++; max = Math.max(max, n); }
      });
      var code = 0, remaining = 1;
      for (var n = 1; n <= 15; n++) {
        remaining = remaining * 2 - counts[n];
        if (remaining < 0) throw new Error("Invalid DEFLATE: oversubscribed Huffman tree");
        code = (code + counts[n - 1]) << 1;
        next[n] = code;
        tables[n] = Object.create(null);
      }
      lengths.forEach(function (len, symbol) {
        if (!len) return;
        var v = next[len]++, rev = 0;
        for (var j = 0; j < len; j++) { rev = (rev << 1) | (v & 1); v >>>= 1; }
        tables[len][rev] = symbol;
      });
      return { max: max, tables: tables };
    }
    function decode(t) {
      var v = 0;
      for (var n = 1; n <= t.max; n++) {
        v |= bits(1) << (n - 1);
        if (t.tables[n][v] !== undefined) return t.tables[n][v];
      }
      throw new Error("Invalid DEFLATE: unknown Huffman symbol");
    }
    var lenBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    var lenExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    var distBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    var distExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    var done = false;
    while (!done) {
      done = bits(1) === 1;
      var type = bits(2);
      if (type === 0) {
        bit = (bit + 7) & ~7;
        var size = bits(16), inverse = bits(16);
        if ((size ^ inverse) !== 65535) throw new Error("Invalid DEFLATE: stored block length");
        for (var j = 0; j < size; j++) emit(bits(8));
        continue;
      }
      if (type === 3) throw new Error("Invalid DEFLATE: reserved block type");
      var litLengths = [], distLengths = [];
      if (type === 1) {
        for (var i = 0; i < 288; i++) litLengths.push(i <= 143 ? 8 : i <= 255 ? 9 : i <= 279 ? 7 : 8);
        for (i = 0; i < 32; i++) distLengths.push(5);
      } else {
        var nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4;
        if (nl > 286 || nd > 32) throw new Error("Invalid DEFLATE: table size");
        var order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        var codeLengths = new Array(19).fill(0);
        for (i = 0; i < nc; i++) codeLengths[order[i]] = bits(3);
        var ct = tree(codeLengths), all = [];
        while (all.length < nl + nd) {
          var symbol = decode(ct);
          if (symbol < 16) all.push(symbol);
          else {
            if (symbol === 16 && !all.length) throw new Error("Invalid DEFLATE: repeat without predecessor");
            var repeat = symbol === 16 ? bits(2) + 3 : symbol === 17 ? bits(3) + 3 : bits(7) + 11;
            var value = symbol === 16 ? all[all.length - 1] : 0;
            if (all.length + repeat > nl + nd) throw new Error("Invalid DEFLATE: excessive code repeat");
            while (repeat--) all.push(value);
          }
        }
        litLengths = all.slice(0, nl); distLengths = all.slice(nl);
      }
      if (!litLengths[256]) throw new Error("Invalid DEFLATE: no end-of-block code");
      var lt = tree(litLengths), dt = tree(distLengths), sym;
      while ((sym = decode(lt)) !== 256) {
        if (sym < 256) { emit(sym); continue; }
        var index = sym - 257;
        if (index < 0 || index >= lenBase.length) throw new Error("Invalid DEFLATE: reserved length code");
        var length = lenBase[index] + bits(lenExtra[index]);
        var dsym = decode(dt);
        if (dsym >= distBase.length) throw new Error("Invalid DEFLATE: reserved distance code");
        var distance = distBase[dsym] + bits(distExtra[dsym]);
        if (distance > count) throw new Error("Invalid DEFLATE: invalid back reference");
        while (length--) emit(out[count - distance]);
      }
    }
    if (count !== expectedSize) throw new Error("Invalid DEFLATE: expanded size mismatch");
    return out;
  }

  function readZip(arrayBuffer) {
    return Promise.resolve().then(function () {
      var dv = new DataView(arrayBuffer), bytes = new Uint8Array(arrayBuffer), n = bytes.length;
      if (n > MAX_FEED_BYTES) throw new Error("GTFS ZIP exceeds the 128 MiB input limit");
      function bounds(offset, length, limit) {
        if (offset < 0 || length < 0 || offset + length > (limit == null ? n : limit)) {
          throw new Error("Invalid ZIP: truncated or out-of-bounds entry");
        }
      }
      var end = -1;
      for (var i = n - 22; i >= Math.max(0, n - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) === n) { end = i; break; }
      }
      if (end < 0) throw new Error("Invalid ZIP: end of central directory not found");
      var entries = dv.getUint16(end + 10, true), size = dv.getUint32(end + 12, true);
      var offset = dv.getUint32(end + 16, true);
      if (dv.getUint16(end + 4, true) || dv.getUint16(end + 6, true) || entries !== dv.getUint16(end + 8, true)) {
        throw new Error("Unsupported ZIP: split archives");
      }
      if (entries === 65535 || size === 0xFFFFFFFF || offset === 0xFFFFFFFF) throw new Error("Unsupported ZIP: ZIP64");
      if (entries > 1024) throw new Error("GTFS ZIP exceeds the 1024 entry limit");
      bounds(offset, size, end);
      var decoder = new TextDecoder("utf-8", { fatal: true }), files = Object.create(null), expanded = 0;
      function decodeField(slice, what) {
        try { return decoder.decode(slice); } catch (err) { throw new Error("Invalid ZIP: non-UTF-8 " + what); }
      }
      var cur = offset;
      for (var e = 0; e < entries; e++) {
        bounds(cur, 46, offset + size);
        if (dv.getUint32(cur, true) !== 0x02014b50) throw new Error("Invalid ZIP: central directory signature");
        var flags = dv.getUint16(cur + 8, true), method = dv.getUint16(cur + 10, true);
        var expectedCrc = dv.getUint32(cur + 16, true), compSize = dv.getUint32(cur + 20, true), rawSize = dv.getUint32(cur + 24, true);
        var nameLen = dv.getUint16(cur + 28, true), extraLen = dv.getUint16(cur + 30, true), commentLen = dv.getUint16(cur + 32, true);
        var local = dv.getUint32(cur + 42, true);
        bounds(cur + 46, nameLen + extraLen + commentLen, offset + size);
        var fullName = decodeField(bytes.subarray(cur + 46, cur + 46 + nameLen), "filename");
        var base = fullName.split("/").pop();
        cur += 46 + nameLen + extraLen + commentLen;
        if (!base || !/\.(txt|csv)$/i.test(base)) continue;
        if (flags & 1) throw new Error("Unsupported ZIP: encrypted entries");
        if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression method " + method);
        expanded += rawSize;
        if (expanded > MAX_FEED_BYTES) throw new Error("GTFS ZIP exceeds the 128 MiB expanded limit");
        if (Object.prototype.hasOwnProperty.call(files, base)) throw new Error("Invalid ZIP: duplicate filename " + base);
        bounds(local, 30, offset);
        if (dv.getUint32(local, true) !== 0x04034b50 || dv.getUint16(local + 8, true) !== method || (dv.getUint16(local + 6, true) & 1)) {
          throw new Error("Invalid ZIP: local header mismatch");
        }
        var localNameLen = dv.getUint16(local + 26, true), localExtraLen = dv.getUint16(local + 28, true);
        bounds(local + 30, localNameLen + localExtraLen, offset);
        if (decodeField(bytes.subarray(local + 30, local + 30 + localNameLen), "filename") !== fullName) throw new Error("Invalid ZIP: filename mismatch");
        var start = local + 30 + localNameLen + localExtraLen;
        bounds(start, compSize, offset);
        var compressed = bytes.subarray(start, start + compSize);
        var raw = method === 0 ? compressed : inflateRawFallback(compressed, rawSize);
        if (raw.length !== rawSize) throw new Error("Invalid ZIP: expanded size mismatch for " + base);
        if (crc32(raw) !== expectedCrc) throw new Error("Invalid ZIP: CRC32 mismatch for " + base);
        files[base] = decodeField(raw, "GTFS table " + base);
      }
      if (cur !== offset + size) throw new Error("Invalid ZIP: central directory size mismatch");
      return files;
    });
  }

  /* Read a GTFS feed from a File, Blob, ArrayBuffer, or a plain object of
   * { filename: text } (loose CSV files pasted into the page). Always returns
   * a Promise of { filename: text }. ZIP detection uses the PK magic bytes;
   * otherwise the input is treated as either loose CSV text or a file map. */
  function normalizeFeedFiles(files) {
    var out = Object.create(null), total = 0;
    Object.keys(files).forEach(function (filename) {
      if (typeof files[filename] !== "string") throw new Error("GTFS file maps must contain text values");
      total += files[filename].length;
      if (total > MAX_FEED_BYTES) throw new Error("GTFS file map exceeds the 128 MiB text limit");
      var base = filename.split("/").pop().toLowerCase();
      if (/^(agency|routes|stops|trips|stop_times|calendar|calendar_dates)\.csv$/.test(base)) base = base.slice(0, -4) + ".txt";
      if (Object.prototype.hasOwnProperty.call(out, base)) throw new Error("Duplicate GTFS filename " + base);
      out[base] = files[filename];
    });
    return out;
  }

  /* PK\x03\x04 local file header, PK\x05\x06 empty-archive EOCD, PK\x07\x08
   * spanned marker: the only legal ways a ZIP begins. */
  function isZipBytes(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B &&
      ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) ||
       (bytes[2] === 7 && bytes[3] === 8));
  }

  /* Identify a single loose CSV table from its header row. */
  function detectLooseText(text) {
    var header = stripBom(text).slice(0, 500).split(/\r?\n/)[0].toLowerCase().split(",");
    var name = header.indexOf("arrival_time") >= 0 && header.indexOf("stop_sequence") >= 0 ? "stop_times.txt" :
      header.indexOf("stop_lat") >= 0 ? "stops.txt" : header.indexOf("route_type") >= 0 ? "routes.txt" :
      header.indexOf("exception_type") >= 0 ? "calendar_dates.txt" : header.indexOf("start_date") >= 0 ? "calendar.txt" :
      header.indexOf("agency_name") >= 0 ? "agency.txt" : header.indexOf("trip_id") >= 0 ? "trips.txt" : null;
    if (!name) throw new Error("Unrecognized GTFS CSV header");
    var map = Object.create(null); map[name] = text; return map;
  }

  /* Binary input: PK magic means ZIP; anything else is decoded as loose
   * CSV text so a File/Blob of plain CSV still imports. */
  function readBinaryInput(ab) {
    var bytes = new Uint8Array(ab);
    if (bytes.byteLength > MAX_FEED_BYTES) throw new Error("GTFS input exceeds the 128 MiB limit");
    if (isZipBytes(bytes)) return readZip(ab).then(normalizeFeedFiles);
    return Promise.resolve().then(function () {
      return detectLooseText(new TextDecoder("utf-8").decode(bytes));
    });
  }

  function readFeedFiles(input) {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      if (input instanceof ArrayBuffer) return readBinaryInput(input);
      if (ArrayBuffer.isView(input)) return readBinaryInput(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
      if (typeof input.arrayBuffer === "function") return Promise.resolve().then(function () { return input.arrayBuffer(); }).then(readBinaryInput);
      return Promise.resolve().then(function () { return normalizeFeedFiles(input); });
    }
    if (typeof input === "string") {
      return Promise.resolve().then(function () {
        if (input.length > MAX_FEED_BYTES) throw new Error("GTFS input exceeds the 128 MiB limit");
        return detectLooseText(input);
      });
    }
    return Promise.reject(new Error("Unsupported GTFS input"));
  }

  /* ------------------------------------------------------------------ *
   * GTFS calendar helpers
   * ------------------------------------------------------------------ */

  var DOW_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  function parseYmd(s) {
    var m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    // UTC date keeps weekday calculation independent of the host timezone.
    var date = new Date(0);
    date.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
    date.setUTCHours(0, 0, 0, 0);
    return date.getUTCFullYear() === +m[1] && date.getUTCMonth() === +m[2] - 1 && date.getUTCDate() === +m[3] ? +date : null;
  }

  function dateStr(ymd) { return String(ymd).trim(); }

  /* JS getUTCDay: 0 Sunday .. 6 Saturday. GTFS DOW_KEYS: 0 Monday .. 6 Sunday. */
  function gtfsDowIndex(utcMs) {
    var d = new Date(utcMs).getUTCDay();
    return (d + 6) % 7;
  }

  /* Resolve which service_ids run on a given service date. Honors
   * calendar.txt weekly patterns bounded by start_date/end_date, plus
   * calendar_dates.txt exceptions (1 = added, 2 = removed). If the feed has
   * calendar_dates-only feeds use explicit adds. With neither calendar table,
   * trips.txt supplies a permissive service-id fallback. */
  function resolveActiveServices(files, dateStrValue) {
    dateStrValue = dateStr(dateStrValue);
    var target = parseYmd(dateStrValue);
    if (target === null) {
      return { active: null, error: "Invalid service date (expected YYYYMMDD)" };
    }
    var calendar = files["calendar.txt"] ? parseCsv(files["calendar.txt"]) : [];
    var calDates = files["calendar_dates.txt"] ? parseCsv(files["calendar_dates.txt"]) : [];
    var trips = files["trips.txt"] ? parseCsv(files["trips.txt"]) : [];
    var active = Object.create(null), i, row;
    if (!calendar.length && !calDates.length) {
      trips.forEach(function (t) {
        var tsid = String(t.service_id || "").trim();
        if (tsid) active[tsid] = true;
      });
    }

    for (i = 0; i < calendar.length; i++) {
      row = calendar[i];
      var sid = String(row.service_id || "").trim();
      if (!sid) continue;
      var start = parseYmd(row.start_date), end = parseYmd(row.end_date);
      if (start === null || end === null) continue;
      if (target < start || target > end) continue;
      if (String(row[DOW_KEYS[gtfsDowIndex(target)]] || "").trim() === "1") active[sid] = true;
    }

    for (i = 0; i < calDates.length; i++) {
      row = calDates[i];
      var dsid = String(row.service_id || "").trim();
      if (!dsid || dateStr(row.date) !== dateStrValue) continue;
      var etype = String(row.exception_type || "").trim();
      if (etype === "1") active[dsid] = true;
      else if (etype === "2") delete active[dsid];
    }

    return { active: active, error: null };
  }

  /* ------------------------------------------------------------------ *
   * GTFS static feed parser
   * ------------------------------------------------------------------ */

  function numOr(v, dflt) {
    var n = parseFloat(v);
    return isFiniteNum(n) ? n : dflt;
  }

  /* Utility for consumers that want the direction with the most trips.
   * The parser itself preserves every direction and stop pattern. */
  function directionOf(t) { var d = String(t.direction_id == null ? "0" : t.direction_id).trim(); return d === "" ? "0" : d; }

  function dominantDirection(trips) {
    var counts = Object.create(null), best = "0", bestN = -1;
    for (var i = 0; i < trips.length; i++) {
      var d = directionOf(trips[i]);
      counts[d] = (counts[d] || 0) + 1;
      if (counts[d] > bestN) { bestN = counts[d]; best = d; }
    }
    return best;
  }

  /* Stop patterns are analyzed separately: a branch or express pattern cannot
   * inherit zero mileposts from a longer representative trip. Repeated visits
   * get stable visit ids so loop arrivals remain distinct on the distance axis. */
  function stopPattern(times) { return JSON.stringify(times.map(function (t) { return t.stop_id; })); }

  function normalizeGtfsTimes(rows, stops, tripId) {
    var times = rows.slice().sort(function (a, b) { return numOr(a.stop_sequence, 0) - numOr(b.stop_sequence, 0); });
    var previousSeq = -Infinity;
    times = times.map(function (r) {
      var stop = stops[r.stop_id], seqStr = String(r.stop_sequence == null ? "" : r.stop_sequence).trim();
      var seq = /^\d+$/.test(seqStr) ? Number(seqStr) : NaN;
      if (!stop) throw new Error("unknown stop " + r.stop_id);
      if (!Number.isInteger(seq) || seq < 0 || seq <= previousSeq) throw new Error("invalid stop_sequence");
      previousSeq = seq;
      var lat = Number(stop.stop_lat), lon = Number(stop.stop_lon);
      if (!String(stop.stop_lat || "").trim() || !String(stop.stop_lon || "").trim() || !isFiniteNum(lat) || !isFiniteNum(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("invalid stop coordinates");
      var a = parseGtfsTime(r.arrival_time), d = parseGtfsTime(r.departure_time);
      if ((String(r.arrival_time || "").trim() && !isFiniteNum(a)) || (String(r.departure_time || "").trim() && !isFiniteNum(d))) throw new Error("invalid stop timestamp");
      if (!isFiniteNum(a) && isFiniteNum(d)) a = d;
      if (!isFiniteNum(d) && isFiniteNum(a)) d = a;
      return Object.assign({}, r, { arrivalSec: a, departureSec: d, coords: [lat, lon] });
    });
    if (!times.length || !isFiniteNum(times[0].arrivalSec) || !isFiniteNum(times[times.length - 1].arrivalSec)) throw new Error("missing endpoint time");
    for (var i = 1; i < times.length - 1; i++) {
      if (isFiniteNum(times[i].arrivalSec)) continue;
      var first = i - 1, last = i + 1;
      while (last < times.length && !isFiniteNum(times[last].arrivalSec)) last++;
      var distance = [0], total = 0;
      for (var j = first + 1; j <= last; j++) { total += geoDistanceMiles(times[j - 1].coords, times[j].coords); distance.push(total); }
      var span = times[last].arrivalSec - times[first].departureSec;
      if (span < 0) throw new Error("decreasing endpoint times");
      for (j = i; j < last; j++) {
        var fraction = total > 0 ? distance[j - first] / total : (j - first) / (last - first);
        times[j].arrivalSec = times[j].departureSec = Math.round(times[first].departureSec + span * fraction);
      }
      i = last - 1;
    }
    for (i = 0; i < times.length; i++) {
      if (times[i].departureSec < times[i].arrivalSec || (i && times[i].arrivalSec < times[i - 1].departureSec)) throw new Error("decreasing arrival/departure times");
    }
    return times;
  }

  function buildServiceFromGtfs(routeId, directionId, ctx, pattern, patternIndex) {
    var route = ctx.routeById[routeId] || {};
    var agency = ctx.agencyById[route.agency_id] || ctx.firstAgency || {};
    var routeTrips = ctx.trips.filter(function (t) {
      var times = ctx.timesByTrip[t.trip_id];
      return t.route_id === routeId && directionOf(t) === directionId && times && stopPattern(times) === pattern;
    });
    if (!routeTrips.length) return null;
    var representative = ctx.timesByTrip[routeTrips[0].trip_id];
    var counts = Object.create(null), cum = 0;
    representative.forEach(function (t) { counts[t.stop_id] = (counts[t.stop_id] || 0) + 1; });
    var hasLoops = Object.keys(counts).some(function (id) { return counts[id] > 1; });
    var stops = representative.map(function (t, i) {
      var row = ctx.stopById[t.stop_id];
      if (i) cum += geoDistanceMiles(representative[i - 1].coords, t.coords);
      return {
        id: hasLoops ? JSON.stringify([t.stop_id, i + 1]) : t.stop_id,
        gtfsStopId: t.stop_id,
        code: row.stop_code || t.stop_id,
        name: row.stop_name || t.stop_id,
        lat: t.coords[0], lon: t.coords[1], miles: round(cum, 3),
        dwellSec: t.departureSec - t.arrivalSec
      };
    });
    var trips = routeTrips.map(function (trip) {
      var times = ctx.timesByTrip[trip.trip_id].map(function (t, i) {
        return { stopId: stops[i].id, gtfsStopId: t.stop_id, seq: Number(t.stop_sequence),
          arrivalSec: t.arrivalSec, departureSec: t.departureSec, miles: stops[i].miles,
          headsign: trip.trip_headsign || route.route_long_name || "" };
      });
      return { tripId: trip.trip_id, routeId: routeId, headsign: trip.trip_headsign || route.route_long_name || "",
        direction: directionId, serviceId: trip.service_id || "", stopTimes: times, startTime: times[0].arrivalSec };
    }).sort(function (a, b) { return a.startTime - b.startTime; });
    stops.forEach(function (stop, i) { stop.dwellSec = mean(trips.map(function (trip) { return trip.stopTimes[i].departureSec - trip.stopTimes[i].arrivalSec; })); });
    var gaps = [];
    for (var i = 1; i < trips.length; i++) if (trips[i].startTime > trips[i - 1].startTime) gaps.push(trips[i].startTime - trips[i - 1].startTime);
    var name = route.route_long_name || route.route_short_name || routeId;
    return {
      id: "gtfs-" + routeId + "-d" + directionId + (patternIndex ? "-p" + patternIndex : ""),
      name: name, shortName: route.route_short_name || name,
      operator: agency.agency_name || "GTFS feed", kind: gtfsRouteKind(route.route_type),
      directionLabel: "Direction " + directionId + " | " + (trips[0].headsign || stops[stops.length - 1].name),
      colorKey: gtfsColorKey(route), source: "gtfs", distanceSource: "cumulative haversine estimate",
      routeId: routeId, plannedHeadwaySec: gaps.length ? Math.round(median(gaps)) : 0,
      startSec: trips[0].startTime, endSec: Math.max.apply(null, trips.map(function (t) { return t.stopTimes[t.stopTimes.length - 1].departureSec; })),
      stops: stops, trips: trips, observedTrips: null, stopIndex: indexStops(stops)
    };
  }

  function gtfsRouteKind(t) {
    var n = parseInt(t, 10);
    if (n === 0 || n === 5 || n === 7) return "light rail";
    if (n === 1 || n === 12) return "metro";
    if (n === 2) return "commuter rail";
    if (n === 3) return "bus";
    if (n === 4) return "ferry";
    return "rail";
  }

  function gtfsColorKey(route) {
    var hex = String(route.route_color || "").trim();
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return "#" + hex;
    return 1;
  }

  function stopTimeKey(tripId, stopId) { return JSON.stringify([tripId, stopId]); }

  function indexStops(stops) {
    var idx = Object.create(null);
    for (var i = 0; i < stops.length; i++) if (stops[i] && stops[i].id != null) idx[stops[i].id] = stops[i];
    return idx;
  }

  /* Parse a GTFS static feed into normalized Services.
   *
   * options:
   *   files        { filename: text } extracted CSV files (or raw input to
   *                readFeedFiles: File, Blob, ArrayBuffer, file map, string)
   *   date         "YYYYMMDD" service date (default: the busiest date in
   *                calendar / calendar_dates, else today UTC)
   *   routeId      optional: only build this route
   *   maxServices  cap on returned services (default 12)
   *
   * Returns a Promise of {
   *   services, date, activeServiceCount, routeCount, warnings, files
   * }.
   */
  function parseGtfs(options) {
    options = options || {};
    return readFeedFiles(options.files).then(function (files) {
      var required = ["trips.txt", "stop_times.txt", "stops.txt"];
      var missing = required.filter(function (f) { return !files[f]; });
      if (missing.length) {
        throw new Error("GTFS feed missing required files: " + missing.join(", "));
      }
      var routes = files["routes.txt"] ? parseCsv(files["routes.txt"]) : [];
      var agencies = files["agency.txt"] ? parseCsv(files["agency.txt"]) : [];
      var trips = parseCsv(files["trips.txt"]);
      var stopsRows = parseCsv(files["stops.txt"]);
      var stopTimes = parseCsv(files["stop_times.txt"]);

      function unique(rows, key, table) {
        var seen = Object.create(null);
        rows.forEach(function (row) { if (!row[key] || seen[row[key]]) throw new Error("GTFS " + table + ": missing or duplicate " + key); seen[row[key]] = true; });
      }
      unique(routes, "route_id", "routes.txt"); unique(trips, "trip_id", "trips.txt"); unique(stopsRows, "stop_id", "stops.txt");
      var routeById = Object.create(null), i;
      for (i = 0; i < routes.length; i++) routeById[routes[i].route_id] = routes[i];
      var agencyById = Object.create(null);
      for (i = 0; i < agencies.length; i++) agencyById[agencies[i].agency_id] = agencies[i];

      var stopById = Object.create(null);
      for (i = 0; i < stopsRows.length; i++) stopById[stopsRows[i].stop_id] = stopsRows[i];

      var timesByTrip = Object.create(null);
      var warnings = [];
      if (trips.length && !("route_id" in trips[0])) warnings.push("trips.txt is missing route_id; its trips cannot be grouped by route.");
      var knownTripIds = Object.create(null), orphanRows = 0;
      for (i = 0; i < trips.length; i++) knownTripIds[trips[i].trip_id] = true;
      for (i = 0; i < stopTimes.length; i++) {
        var tid = stopTimes[i].trip_id;
        if (!knownTripIds[tid]) { orphanRows++; continue; }
        (timesByTrip[tid] || (timesByTrip[tid] = [])).push(stopTimes[i]);
      }
      if (orphanRows) warnings.push("stop_times.txt lists " + orphanRows + " row(s) for trip_ids missing from trips.txt; ignored.");

      for (var tid in timesByTrip) {
        try { timesByTrip[tid] = normalizeGtfsTimes(timesByTrip[tid], stopById, tid); }
        catch (err) { delete timesByTrip[tid]; warnings.push("Skipping trip " + tid + ": " + err.message + "."); }
      }

      // Choose a service date with the most planned trips when unspecified.
      var date = options.date || guessBusiestDate(files);
      var resolved = resolveActiveServices(files, date);
      if (resolved.error) throw new Error(resolved.error);
      var active = resolved.active;

      // Restrict trips to active services if calendar data is meaningful.
      var calDates = files["calendar_dates.txt"] ? parseCsv(files["calendar_dates.txt"]) : [];
      var calendar = files["calendar.txt"] ? parseCsv(files["calendar.txt"]) : [];
      var hasCalendarData = calendar.length || calDates.length;
      var activeTrips = trips.filter(function (t) {
        return timesByTrip[t.trip_id] && (!hasCalendarData || active[String(t.service_id || "").trim()]);
      });
      if (!activeTrips.length) warnings.push("No usable trips are active on the selected service date.");

      // Group by route, preserving directions and coherent stop patterns.
      var byRoute = Object.create(null);
      for (i = 0; i < activeTrips.length; i++) {
        var rid = activeTrips[i].route_id;
        (byRoute[rid] || (byRoute[rid] = [])).push(activeTrips[i]);
      }

      var ctx = {
        routeById: routeById, agencyById: agencyById,
        firstAgency: agencies[0] || {},
        stopById: stopById, timesByTrip: timesByTrip, trips: activeTrips
      };

      if (!routes.length) warnings.push("No routes.txt: using route ids from trips.txt.");
      if (!hasCalendarData) warnings.push("No calendar data: all trips treated as active for the selected date.");

      var routeIds = Object.keys(byRoute).sort();
      if (options.routeId) routeIds = routeIds.filter(function (r) { return r === options.routeId; });

      var services = [];
      var maxServices = options.maxServices == null ? 12 : options.maxServices;
      if (!Number.isInteger(maxServices) || maxServices < 0 || maxServices > 1024) throw new Error("maxServices must be an integer from 0 to 1024");
      for (i = 0; i < routeIds.length && services.length < maxServices; i++) {
        var routeTrips = byRoute[routeIds[i]], groups = Object.create(null);
        routeTrips.forEach(function (t) {
          var direction = directionOf(t), pattern = stopPattern(timesByTrip[t.trip_id]);
          (groups[direction] || (groups[direction] = Object.create(null)))[pattern] = true;
        });
        var directions = Object.keys(groups).sort();
        for (var d = 0; d < directions.length; d++) {
          var patterns = Object.keys(groups[directions[d]]);
          for (var k = 0; k < patterns.length && services.length < maxServices; k++) {
            var svc = buildServiceFromGtfs(routeIds[i], directions[d], ctx, patterns[k], k);
            if (svc) services.push(svc);
          }
        }
      }

      return {
        services: services,
        date: date,
        activeServiceCount: Object.keys(active).length,
        routeCount: routeIds.length,
        warnings: warnings,
        files: files
      };
    });
  }

  function guessBusiestDate(files) {
    var calendar = files["calendar.txt"] ? parseCsv(files["calendar.txt"]) : [];
    var exceptions = files["calendar_dates.txt"] ? parseCsv(files["calendar_dates.txt"]) : [];
    var trips = files["trips.txt"] ? parseCsv(files["trips.txt"]) : [];
    var candidates = Object.create(null), weights = Object.create(null), exceptionDays = new Set(exceptions.map(function (r) { return dateStr(r.date); }));
    trips.forEach(function (t) { var sid = String(t.service_id || "").trim(); weights[sid] = (weights[sid] || 0) + 1; });
    function ymd(ms) { var d = new Date(ms); return String(d.getUTCFullYear()).padStart(4, "0") + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()); }
    exceptions.forEach(function (r) { if (parseYmd(r.date) !== null) candidates[dateStr(r.date)] = true; });
    calendar.forEach(function (r) {
      var start = parseYmd(r.start_date), end = parseYmd(r.end_date);
      if (start === null || end === null) return;
      for (var i = 0; i < 7 && start + i * 86400000 <= end; i++) {
        var day = start + i * 86400000;
        candidates[ymd(day)] = true;
        // A holiday may remove the first occurrence of a weekday. Also inspect
        // its first ordinary occurrence rather than selecting an empty day.
        while (exceptionDays.has(ymd(day)) && day <= end) day += 7 * 86400000;
        if (day <= end) candidates[ymd(day)] = true;
      }
    });
    var best = null, bestN = -1;
    Object.keys(candidates).sort().forEach(function (date) {
      var active = resolveActiveServices(files, date).active || {};
      var n = Object.keys(active).reduce(function (sum, id) { return sum + (weights[id] || 0); }, 0);
      if (n > bestN) { best = date; bestN = n; }
    });
    return best || ymd(Date.now());
  }

  /* ------------------------------------------------------------------ *
   * Synthetic timetable builder (from the preloaded corridor bundle)
   * ------------------------------------------------------------------ */

  function getCorridors() {
    return (ns.CORRIDORS || (root.RailPulse && root.RailPulse.CORRIDORS) || []);
  }

  /* Build a normalized Service from a corridor definition. Each trip is a
   * train departing the origin at startSec + k * headwaySec. Running time
   * between adjacent stations is the route-mile delta converted at the
   * corridor's average speed; dwell is the planned station dwell. */
  function buildSyntheticService(corridor, options) {
    options = options || {};
    if (!corridor || !Array.isArray(corridor.stations) || !corridor.stations.length) throw new Error("A corridor needs at least one station");
    corridor.stations.forEach(function (s, i) {
      if (!isFiniteNum(s[2]) || s[2] < 0 || (i && s[2] < corridor.stations[i - 1][2]) || !isFiniteNum(s[3]) || s[3] < 0) throw new Error("Station mileposts and dwells must be finite and nondecreasing");
    });
    var coords = interpolateStationCoordinates(corridor.anchors, corridor.stations);
    var stops = corridor.stations.map(function (s, i) {
      return {
        id: corridor.id + "-" + s[0] + "-" + i,
        code: s[0],
        name: s[1],
        lat: coords[i][0],
        lon: coords[i][1],
        miles: s[2],
        dwellSec: s[3]
      };
    });

    var speedMph = corridor.speedMph != null ? corridor.speedMph : 40;
    var secPerMile = 3600 / speedMph;
    var headway = options.headwaySec != null ? options.headwaySec : (corridor.headwaySec != null ? corridor.headwaySec : 600);
    var startSec = options.startSec != null ? options.startSec : (corridor.startSec != null ? corridor.startSec : 5 * 3600);
    var endSec = options.endSec != null ? options.endSec : (corridor.endSec != null ? corridor.endSec : 24 * 3600);

    if (!isFiniteNum(speedMph) || speedMph <= 0 || !isFiniteNum(headway) || headway <= 0 || !isFiniteNum(startSec) || !isFiniteNum(endSec) || startSec < 0 || endSec < startSec) throw new Error("Invalid synthetic speed, headway or service span");
    if (Math.floor((endSec - startSec) / headway) > 10000) throw new Error("Synthetic service exceeds the 10001 trip limit");

    // Cumulative scheduled run from the origin to each stop, including dwells
    // at intermediate stations.
    var legOffsets = [0], i;
    for (i = 1; i < stops.length; i++) {
      var runSec = (stops[i].miles - stops[i - 1].miles) * secPerMile;
      var dwellAtPrev = stops[i - 1].dwellSec;
      legOffsets.push(legOffsets[i - 1] + runSec + dwellAtPrev);
    }

    var trips = [];
    var tripCount = Math.max(1, Math.floor((endSec - startSec) / headway) + 1);
    for (var k = 0; k < tripCount; k++) {
      var depart = startSec + k * headway;
      var stopTimes = [];
      for (i = 0; i < stops.length; i++) {
        var arr = depart + legOffsets[i];
        var dep = arr + stops[i].dwellSec;
        stopTimes.push({
          stopId: stops[i].id,
          seq: i + 1,
          arrivalSec: Math.round(arr),
          departureSec: Math.round(dep),
          miles: stops[i].miles,
          headsign: corridor.directionLabel
        });
      }
      trips.push({
        tripId: corridor.routeId + "-" + pad2(k + 1),
        routeId: corridor.routeId,
        headsign: corridor.directionLabel,
        direction: "0",
        serviceId: "SYNTH",
        stopTimes: stopTimes,
        startTime: Math.round(depart)
      });
    }

    var svc = {
      id: corridor.id,
      name: corridor.name,
      shortName: corridor.shortName,
      operator: corridor.operator,
      kind: corridor.kind,
      directionLabel: corridor.directionLabel,
      colorKey: corridor.colorKey,
      source: "synthetic",
      routeId: corridor.routeId,
      plannedHeadwaySec: headway,
      startSec: startSec,
      endSec: endSec,
      stops: stops,
      trips: trips,
      observedTrips: null,
      stopIndex: indexStops(stops)
    };
    return svc;
  }

  function listCorridors() {
    return getCorridors().map(function (c) {
      return {
        id: c.id, name: c.name, shortName: c.shortName, operator: c.operator,
        kind: c.kind, routeId: c.routeId, colorKey: c.colorKey,
        stationCount: c.stations.length, headwaySec: c.headwaySec,
        startSec: c.startSec, endSec: c.endSec, directionLabel: c.directionLabel
      };
    });
  }

  /* Build all preloaded synthetic services. */
  function buildAllSyntheticServices() {
    return getCorridors().map(function (c) { return buildSyntheticService(c); });
  }

  /* ------------------------------------------------------------------ *
   * Disruption simulator (seeded, reproducible)
   * ------------------------------------------------------------------ *
   * Produces an "observed" trip layer from the schedule by injecting a modest
   * amount of realistic noise: small departure drift, dwell variability, and
   * occasional propagating delays that cause trains to bunch. Used to give the
   * bunching and reliability analyzers something to measure offline. A real
   * GTFS-RT feed, when supplied through applyRealtime, replaces this layer.
   */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function simulateObserved(service, options) {
    options = options || {};
    var seed = options.seed == null ? 20261108 : options.seed;
    var rng = mulberry32(seed);
    var intensity = options.intensity == null ? 1 : options.intensity;
    if (!isFiniteNum(intensity) || intensity < 0 || intensity > 10) throw new Error("Disruption intensity must be from 0 to 10");
    var carryDelay = 0; // delay propagating from earlier trains in the day
    var observed = [];
    for (var t = 0; t < service.trips.length; t++) {
      var trip = service.trips[t];
      var offset = (rng() - 0.45) * 90 * intensity + carryDelay;
      // Rare single-train incident that adds a large delay, and lets a
      // following train catch up (a bunching event).
      var incident = rng() < 0.06 * intensity;
      if (incident) offset += (200 + rng() * 400) * intensity;
      carryDelay = incident ? offset * 0.45 : offset * 0.12;
      var stTimes = [], acc = offset;
      for (var i = 0; i < trip.stopTimes.length; i++) {
        var st = trip.stopTimes[i];
        var drift = (rng() - 0.5) * 12 * intensity;
        acc += drift;
        var arr = Math.max(0, st.arrivalSec + acc);
        if (i) arr = Math.max(arr, stTimes[i - 1].departureSec + st.arrivalSec - trip.stopTimes[i - 1].departureSec);
        var dwell = Math.max(0, st.departureSec - st.arrivalSec + (rng() - 0.5) * 20 * intensity);
        var dep = arr + dwell;
        acc = dep - st.departureSec;
        stTimes.push({
          stopId: st.stopId, seq: st.seq, arrivalSec: Math.round(arr),
          departureSec: Math.round(dep), miles: st.miles, headsign: st.headsign
        });
      }
      observed.push({
        tripId: trip.tripId, routeId: trip.routeId, headsign: trip.headsign,
        direction: trip.direction, serviceId: trip.serviceId,
        stopTimes: stTimes, startTime: stTimes[0] ? stTimes[0].arrivalSec : trip.startTime
      });
    }
    return observed;
  }

  /* Shared-platform cascade. Trains retain their scheduled running times,
   * cannot pass a platform still occupied by their leader, and may be held
   * at stations to restore a chosen fraction of the planned arrival spacing.
   * This is an illustrative single-direction queue, not a signaling model. */
  function simulateCascade(service, options) {
    options = options || {};
    var count = service.trips.length;
    if (!count || !service.stops.length) return { observedTrips: [], holds: [], delayedTrips: 0, totalTerminalDelaySec: 0, maxDelaySec: 0, holdSec: 0 };
    var incidentTrip = options.incidentTripIndex == null ? Math.min(4, count - 1) : options.incidentTripIndex;
    var incidentStop = options.incidentStopIndex == null ? Math.min(8, service.stops.length - 1) : options.incidentStopIndex;
    var incidentSec = options.incidentSec == null ? 900 : options.incidentSec;
    var separation = options.minSeparationSec == null ? 45 : options.minSeparationSec;
    var spacingRatio = options.spacingRatio == null ? 0.75 : options.spacingRatio;
    if (!Number.isInteger(incidentTrip) || incidentTrip < 0 || incidentTrip >= count || !Number.isInteger(incidentStop) || incidentStop < 0 || incidentStop >= service.stops.length) throw new Error("Invalid incident trip or station index");
    if (!isFiniteNum(incidentSec) || incidentSec < 0 || incidentSec > 86400 || !isFiniteNum(separation) || separation < 0 || !isFiniteNum(spacingRatio) || spacingRatio < 0 || spacingRatio > 1) throw new Error("Invalid incident duration or spacing");
    var observed = [], holds = [], holdSec = 0;
    service.trips.forEach(function (trip, t) {
      var times = [];
      if (!trip || !Array.isArray(trip.stopTimes)) { observed.push(Object.assign({}, trip, { stopTimes: [], startTime: trip ? trip.startTime : 0 })); return; }
      trip.stopTimes.forEach(function (st, i) {
        if (!st) { var prevT = times[times.length - 1], t0 = prevT ? prevT.departureSec : 0; times.push({ arrivalSec: t0, departureSec: t0 }); return; }
        var prevSt = trip.stopTimes[i - 1], prevT2 = times[times.length - 1];
        var arrival = i && prevT2 && prevSt ? prevT2.departureSec + st.arrivalSec - prevSt.departureSec : st.arrivalSec;
        var leader = t ? observed[t - 1].stopTimes[i] : null;
        // leader.departureSec is already integer-stored; ceil keeps the
        // post-rounding arrival >= departure + separation for fractional seps.
        if (leader) arrival = Math.max(arrival, Math.ceil(leader.departureSec + separation));
        var hold = leader && options.regulate ? Math.max(0, leader.arrivalSec + service.plannedHeadwaySec * spacingRatio - arrival) : 0;
        var roundedHold = hold > 0 ? Math.round(hold) : 0;
        var dwell = st.departureSec - st.arrivalSec;
        if (t === incidentTrip && i === incidentStop) dwell += incidentSec;
        if (roundedHold > 0) {
          holdSec += roundedHold;
          if (i > 0) {
            times[i - 1].departureSec += roundedHold;
            holds.push({ tripId: trip.tripId, stopId: times[i - 1].stopId, seconds: roundedHold });
            arrival += roundedHold;
          } else {
            dwell += roundedHold;
            holds.push({ tripId: trip.tripId, stopId: st.stopId, seconds: roundedHold });
          }
        }
        times.push(Object.assign({}, st, { arrivalSec: Math.round(arrival), departureSec: Math.round(arrival + dwell) }));
      });
      observed.push(Object.assign({}, trip, { stopTimes: times, startTime: times.length ? times[0].arrivalSec : trip.startTime }));
    });
    var terminalDelays = observed.map(function (t, i) {
      var schedTimes = service.trips[i] && Array.isArray(service.trips[i].stopTimes) ? service.trips[i].stopTimes : [];
      var schedLast = schedTimes[schedTimes.length - 1];
      var obsLast = t.stopTimes[t.stopTimes.length - 1];
      return obsLast && schedLast ? obsLast.arrivalSec - schedLast.arrivalSec : 0;
    });
    return {
      observedTrips: observed, holds: holds, incidentTripId: service.trips[incidentTrip] ? service.trips[incidentTrip].tripId : null,
      incidentStopId: service.stops[incidentStop] ? service.stops[incidentStop].id : null, incidentSec: incidentSec, minSeparationSec: separation,
      spacingRatio: spacingRatio, regulated: !!options.regulate,
      delayedTrips: terminalDelays.filter(function (d) { return d > 0; }).length,
      totalTerminalDelaySec: sum(terminalDelays), maxDelaySec: Math.max.apply(null, terminalDelays), holdSec: Math.round(holdSec)
    };
  }

  /* Every timestamp is checked through the same service-day parser used by
   * GTFS import. The badge is recomputed from the actual active trip layers. */
  function verifyService(service) {
    var errors = [], checks = 0, roundTrips = 0;
    if (!service || !Array.isArray(service.trips) || !Array.isArray(service.stops)) return { passed: false, checks: 0, roundTrips: 0, errors: ["Missing service arrays"] };
    if (!service.trips.length || !service.stops.length) errors.push("Empty timetable");
    if (service.observedTrips != null && !Array.isArray(service.observedTrips)) errors.push("Observed trips layer is not an array");
    var index = indexStops(service.stops);
    var seenStopIds = Object.create(null), prevStopMiles = -Infinity;
    service.stops.forEach(function (s) {
      checks++;
      if (s == null || s.id == null || seenStopIds[s.id]) errors.push("Duplicate or missing station id");
      else seenStopIds[s.id] = true;
      if (!s || !isFiniteNum(s.miles) || s.miles < 0) errors.push("Invalid station milepost");
      else { if (s.miles < prevStopMiles) errors.push("Decreasing station mileposts"); prevStopMiles = s.miles; }
      if (!s || !isFiniteNum(s.lat) || !isFiniteNum(s.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) errors.push("Invalid station coordinates");
    });
    [service.trips, service.observedTrips].filter(Array.isArray).forEach(function (trips, layerIdx) {
      var tag = layerIdx ? "observed " : "";
      trips.forEach(function (trip, ti) {
        var label = tag + (trip && trip.tripId != null ? trip.tripId : "trip " + ti);
        if (!trip || !Array.isArray(trip.stopTimes)) { errors.push("Missing stop times in " + label); return; }
        if (!trip.stopTimes.length) errors.push("Missing stop times in " + label);
        var previous = -Infinity, prevMiles = -Infinity;
        trip.stopTimes.forEach(function (st) {
          if (!st) { errors.push("Missing stop time in " + label); return; }
          checks += 3;
          if (!index[st.stopId]) errors.push("Unknown station in " + label);
          if (!isFiniteNum(st.miles) || st.miles < 0) errors.push("Invalid distance in " + label);
          else {
            if (st.miles < prevMiles) errors.push("Decreasing distance in " + label);
            prevMiles = st.miles;
          }
          if (st.arrivalSec < previous || st.departureSec < st.arrivalSec) errors.push("Decreasing times in " + label);
          [st.arrivalSec, st.departureSec].forEach(function (sec) {
            checks++; roundTrips++;
            if (!isFiniteNum(sec) || sec < 0 || parseGtfsTime(formatGtfsTime(sec)) !== Math.round(sec)) errors.push("Timestamp round trip failed in " + label);
          });
          previous = st.departureSec;
        });
      });
    });
    return { passed: errors.length === 0, checks: checks, roundTrips: roundTrips, errors: errors };
  }

  /* Attach an observed layer to a service (non-mutating: returns a new one). */
  function withObserved(service, observedTrips) {
    var copy = {};
    for (var k in service) if (Object.prototype.hasOwnProperty.call(service, k)) copy[k] = service[k];
    copy.observedTrips = observedTrips;
    return copy;
  }

  /* Apply a GTFS-RT style update list to a service's trips. Each update is
   * { tripId, stopId, arrivalDelaySec, departureDelaySec, arrivalSec,
   *   departureSec }. When absolute times are given they win; otherwise the
   * schedule plus the delay is used. Returns a fresh observedTrips array. */
  function applyRealtime(service, updates) {
    updates = updates || [];
    var byTrip = Object.create(null);
    updates.forEach(function (u) {
      if (u && u.tripId) (byTrip[u.tripId] || (byTrip[u.tripId] = Object.create(null)))[u.stopId] = u;
    });
    return service.trips.map(function (trip) {
      var map = byTrip[trip.tripId] || {}, offset = 0, times = [];
      trip.stopTimes.forEach(function (st, i) {
        var u = map[st.stopId] || map[st.gtfsStopId];
        var arrival = st.arrivalSec + offset, departure = st.departureSec + offset;
        if (u) {
          arrival = isFiniteNum(u.arrivalSec) ? u.arrivalSec : st.arrivalSec + numOr(u.arrivalDelaySec, offset);
          departure = isFiniteNum(u.departureSec) ? u.departureSec : st.departureSec + numOr(u.departureDelaySec, arrival - st.arrivalSec);
        }
        arrival = Math.max(0, arrival);
        if (i) arrival = Math.max(arrival, times[i - 1].departureSec + st.arrivalSec - trip.stopTimes[i - 1].departureSec);
        departure = Math.max(arrival, departure);
        offset = departure - st.departureSec;
        times.push(Object.assign({}, st, { arrivalSec: Math.round(arrival), departureSec: Math.round(departure) }));
      });
      return Object.assign({}, trip, { stopTimes: times, startTime: times[0] ? times[0].arrivalSec : trip.startTime });
    });
  }

  /* ------------------------------------------------------------------ *
   * Shared analysis helpers
   * ------------------------------------------------------------------ */

  /* Descriptive statistics for a numeric sample. */
  function describeSample(arr) {
    var clean = (arr || []).filter(isFiniteNum);
    if (!clean.length) {
      return { count: 0, min: 0, max: 0, mean: 0, stddev: 0, cv: 0,
               p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
    }
    var s = clean.slice().sort(function (a, b) { return x_minus_y(a, b); });
    return {
      count: s.length,
      min: s[0],
      max: s[s.length - 1],
      mean: mean(s),
      stddev: stddev(s),
      cv: coefficientOfVariation(s),
      p10: percentile(s, 0.10),
      p25: percentile(s, 0.25),
      p50: percentile(s, 0.50),
      p75: percentile(s, 0.75),
      p90: percentile(s, 0.90)
    };
  }
  function x_minus_y(a, b) { return a - b; }

  /* Choose trip layers for an analysis. Returns the primary layer used plus
   * the schedule (for delay comparisons). */
  function selectTrips(service, options) {
    options = options || {};
    var observed = Array.isArray(service.observedTrips) ? service.observedTrips : null;
    var scheduled = service.trips;
    var layer = options.layer || (observed ? "observed" : "scheduled");
    if (options.trips) {
      return { primary: options.trips, scheduled: scheduled, observed: observed,
               layer: "custom", hasObserved: !!observed };
    }
    if (layer === "scheduled") {
      return { primary: scheduled, scheduled: scheduled, observed: observed,
               layer: layer, hasObserved: !!observed };
    }
    return { primary: observed || scheduled, scheduled: scheduled, observed: observed,
             layer: observed ? "observed" : "scheduled", hasObserved: !!observed };
  }

  /* Collect sorted arrival events at one stop across a trip layer. */
  function arrivalsAtStop(trips, stopId) {
    var events = [];
    for (var i = 0; i < trips.length; i++) {
      var t = trips[i];
      for (var j = 0; j < t.stopTimes.length; j++) {
        var st = t.stopTimes[j];
        if (st.stopId === stopId) {
          events.push({
            tripId: t.tripId,
            headsign: t.headsign,
            timeSec: st.arrivalSec,
            departureSec: st.departureSec,
            seq: st.seq
          });
          break; // first visit only
        }
      }
    }
    events.sort(function (a, b) { return a.timeSec - b.timeSec; });
    return events;
  }

  /* Map a time-of-day (seconds) to a labeled bucket. */
  function timeBucketLabel(sec, bucketSec) {
    var b = Math.floor(sec / bucketSec) * bucketSec;
    return formatGtfsTime(b);
  }

  /* ------------------------------------------------------------------ *
   * Headway analysis
   * ------------------------------------------------------------------ */

  /* Headways are the gaps between consecutive train arrivals at each stop.
   * Returns per-stop headway sequences plus aggregate statistics, a histogram
   * (relative to planned headway), and time-of-day averages. */
  function analyzeHeadways(service, options) {
    options = options || {};
    var sel = selectTrips(service, options);
    var planned = service.plannedHeadwaySec || 0;
    var stopIds = options.stopId ? [options.stopId] : service.stops.map(function (s) { return s.id; });
    var bucketSec = options.timeBucketSec == null ? 3600 : options.timeBucketSec;
    var perStop = [], allGaps = [], buckets = Object.create(null), histogram = {};
    var binCount = options.histogramBins == null ? 12 : options.histogramBins;
    if (!isFiniteNum(bucketSec) || bucketSec <= 0 || !Number.isInteger(binCount) || binCount < 1 || binCount > 1000) throw new Error("Invalid headway bucket size or histogram bin count");

    for (var i = 0; i < stopIds.length; i++) {
      var ev = arrivalsAtStop(sel.primary, stopIds[i]);
      var gaps = [];
      for (var j = 1; j < ev.length; j++) {
        var gap = ev[j].timeSec - ev[j - 1].timeSec;
        if (gap < 0) continue;
        gaps.push(gap);
        allGaps.push(gap);
        var bl = timeBucketLabel(ev[j].timeSec, bucketSec);
        (buckets[bl] || (buckets[bl] = [])).push(gap);
        if (planned > 0) {
          var ratio = gap / planned;
          var bin = clamp(Math.floor(ratio * binCount / 3), 0, binCount - 1);
          histogram[bin] = (histogram[bin] || 0) + 1;
        }
      }
      var stats = describeSample(gaps);
      perStop.push({
        stopId: stopIds[i],
        stopName: (service.stopIndex[stopIds[i]] || {}).name || stopIds[i],
        miles: (service.stopIndex[stopIds[i]] || {}).miles || 0,
        arrivals: ev,
        headwaySec: gaps,
        stats: stats,
        meanVsPlanned: planned ? stats.mean / planned : 0
      });
    }

    var overall = describeSample(allGaps);
    var histogramOut = [];
    for (var b = 0; b < binCount; b++) {
      var lo = (b / binCount) * 3, hi = ((b + 1) / binCount) * 3;
      histogramOut.push({
        bin: b,
        ratioLo: round(lo, 2),
        ratioHi: round(hi, 2),
        label: round(lo, 1) + "-" + round(hi, 1) + "x",
        count: histogram[b] || 0
      });
    }
    var timeOfDay = Object.keys(buckets).sort(function (a, b) { return parseGtfsTime(a) - parseGtfsTime(b); }).map(function (k) {
      var st = describeSample(buckets[k]);
      return { label: k, meanSec: st.mean, p90Sec: st.p90, count: st.count };
    });

    return {
      layer: sel.layer,
      plannedHeadwaySec: planned,
      perStop: perStop,
      overall: overall,
      excessWaitSec: overall.mean > 0 ? populationVariance(allGaps) / (2 * overall.mean) : 0,
      histogram: histogramOut,
      timeOfDay: timeOfDay
    };
  }

  /* ------------------------------------------------------------------ *
   * Bunching analysis
   * ------------------------------------------------------------------ *
   * A bunching event is a headway shorter than bunchingThreshold times the
   * planned headway (default 0.5, i.e. two trains arriving within half a
   * headway). A gap is a headway longer than gapThreshold times planned
   * (default 1.5). Both are reported per stop and as a network rate, with
   * excess wait time as the passenger-facing reliability metric. */

  function analyzeBunching(service, options) {
    options = options || {};
    var sel = selectTrips(service, options);
    var planned = service.plannedHeadwaySec || 0;
    var bunchFrac = options.bunchingThreshold == null ? 0.5 : options.bunchingThreshold;
    var gapFrac = options.gapThreshold == null ? 1.5 : options.gapThreshold;
    var bunchSec = planned ? planned * bunchFrac : (options.bunchingSec || 180);
    var gapSec = planned ? planned * gapFrac : (options.gapSec || 900);
    if (!isFiniteNum(bunchFrac) || !isFiniteNum(gapFrac) || bunchFrac < 0 || gapFrac <= bunchFrac) throw new Error("Invalid bunching or gap threshold");
    var stopIds = options.stopId ? [options.stopId] : service.stops.map(function (s) { return s.id; });

    var events = [], gaps = [], perStop = [];
    var totalGaps = 0, bunchCount = 0, gapCount = 0;

    for (var i = 0; i < stopIds.length; i++) {
      var ev = arrivalsAtStop(sel.primary, stopIds[i]);
      var localBunch = 0, localGap = 0, localTotal = 0, hw = [];
      for (var j = 1; j < ev.length; j++) {
        var gap = ev[j].timeSec - ev[j - 1].timeSec;
        if (gap < 0) continue;
        hw.push(gap);
        totalGaps++; localTotal++;
        if (gap <= bunchSec) {
          bunchCount++; localBunch++;
          events.push({
            type: "bunch",
            stopId: stopIds[i],
            stopName: (service.stopIndex[stopIds[i]] || {}).name || stopIds[i],
            timeSec: ev[j].timeSec,
            headwaySec: gap,
            leaderTrip: ev[j - 1].tripId,
            followerTrip: ev[j].tripId
          });
        } else if (gap >= gapSec) {
          gapCount++; localGap++;
          gaps.push({
            type: "gap",
            stopId: stopIds[i],
            stopName: (service.stopIndex[stopIds[i]] || {}).name || stopIds[i],
            timeSec: ev[j].timeSec,
            headwaySec: gap,
            leaderTrip: ev[j - 1].tripId,
            followerTrip: ev[j].tripId
          });
        }
      }
      perStop.push({
        stopId: stopIds[i],
        stopName: (service.stopIndex[stopIds[i]] || {}).name || stopIds[i],
        miles: (service.stopIndex[stopIds[i]] || {}).miles || 0,
        totalHeadways: localTotal,
        bunchCount: localBunch,
        gapCount: localGap,
        bunchRate: localTotal ? localBunch / localTotal : 0,
        meanHeadwaySec: mean(hw),
        headwayStddevSec: stddev(hw)
      });
    }

    events.sort(function (a, b) { return a.headwaySec - b.headwaySec; });
    gaps.sort(function (a, b) { return b.headwaySec - a.headwaySec; });

    // Excess wait time: Var(H) / (2 * E[H]) across all observed headways.
    var allHw = [];
    for (i = 0; i < perStop.length; i++) {
      var e2 = arrivalsAtStop(sel.primary, perStop[i].stopId);
      for (var q = 1; q < e2.length; q++) {
        var g2 = e2[q].timeSec - e2[q - 1].timeSec;
        if (g2 >= 0) allHw.push(g2);
      }
    }
    var m = mean(allHw);
    var ewt = m > 0 ? populationVariance(allHw) / (2 * m) : 0;

    return {
      layer: sel.layer,
      plannedHeadwaySec: planned,
      bunchThresholdSec: round(bunchSec, 0),
      gapThresholdSec: round(gapSec, 0),
      totalHeadways: totalGaps,
      bunchCount: bunchCount,
      gapCount: gapCount,
      bunchRate: totalGaps ? bunchCount / totalGaps : 0,
      gapRate: totalGaps ? gapCount / totalGaps : 0,
      excessWaitSec: ewt,
      excessWaitRatio: planned ? ewt / (planned / 2) : 0,
      perStop: perStop,
      bunchEvents: events,
      gapEvents: gaps
    };
  }

  /* ------------------------------------------------------------------ *
   * Stringline (Marey) chart data
   * ------------------------------------------------------------------ *
   * A stringline plots each train as a line through time (x) and distance
   * (y). Crossing or converging lines reveal bunching and overtakes. Returns
   * one polyline per trip with {timeSec, miles} points, plus optional
   * scheduled ghost lines for comparison. */

  function buildStringline(service, options) {
    options = options || {};
    var sel = selectTrips(service, options), range = options.timeRange;
    if (range && (!Array.isArray(range) || range.length !== 2 || !range.every(isFiniteNum) || range[1] <= range[0])) throw new Error("Invalid stringline time range");
    var candidates = sel.primary.filter(function (trip) {
      if (!range || !trip.stopTimes.length) return true;
      return trip.stopTimes[0].arrivalSec <= range[1] && trip.stopTimes[trip.stopTimes.length - 1].departureSec >= range[0];
    });
    var maxTrips = options.maxTrips == null ? 0 : options.maxTrips;
    if (!Number.isInteger(maxTrips) || maxTrips < 0) throw new Error("Invalid stringline trip limit");
    var trips = maxTrips > 0 ? candidates.slice(0, maxTrips) : candidates;
    function toLines(list, layer) {
      return list.map(function (trip) {
        var points = [];
        trip.stopTimes.forEach(function (st) {
          var stop = service.stopIndex[st.stopId] || {}, miles = isFiniteNum(st.miles) ? st.miles : stop.miles || 0;
          points.push({ timeSec: st.arrivalSec, miles: miles, stopId: st.stopId, stopName: stop.name || st.stopId, phase: "arrival" });
          if (st.departureSec > st.arrivalSec) points.push({ timeSec: st.departureSec, miles: miles, stopId: st.stopId, stopName: stop.name || st.stopId, phase: "departure" });
        });
        return { tripId: trip.tripId, headsign: trip.headsign, layer: layer, points: points,
          stopCount: trip.stopTimes.length, startTime: trip.stopTimes.length ? trip.stopTimes[0].departureSec : 0,
          endTime: trip.stopTimes.length ? trip.stopTimes[trip.stopTimes.length - 1].arrivalSec : 0 };
      });
    }
    var ids = new Set(trips.map(function (trip) { return trip.tripId; }));
    var lines = toLines(trips, sel.layer);
    var scheduledLines = options.includeScheduled && sel.layer === "observed" ? toLines(sel.scheduled.filter(function (trip) { return ids.has(trip.tripId); }), "scheduled") : null;
    var minTime = Infinity, maxTime = -Infinity, maxMiles = Math.max.apply(null, service.stops.map(function (st) { return st.miles; }).concat([1]));
    lines.concat(scheduledLines || []).forEach(function (line) {
      line.points.forEach(function (p) { minTime = Math.min(minTime, p.timeSec); maxTime = Math.max(maxTime, p.timeSec); });
    });
    if (range) { minTime = range[0]; maxTime = range[1]; }
    if (!isFiniteNum(minTime)) { minTime = 0; maxTime = 1; }
    if (maxTime <= minTime) maxTime = minTime + 1;
    return { layer: sel.layer, lines: lines, scheduledLines: scheduledLines, visibleTrips: lines.length, availableTrips: candidates.length,
      timeDomain: [minTime, maxTime], milesDomain: [0, maxMiles], stops: service.stops.map(function (st) { return { id: st.id, name: st.name, code: st.code, miles: st.miles }; }) };
  }

  /* ------------------------------------------------------------------ *
   * Dwell analysis
   * ------------------------------------------------------------------ */

  function analyzeDwell(service, options) {
    options = options || {};
    var sel = selectTrips(service, options);
    var stopIds = options.stopId ? [options.stopId] : service.stops.map(function (s) { return s.id; });
    var perStop = [], allDwell = [], scheduled = Object.create(null);
    service.trips.forEach(function (trip) {
      trip.stopTimes.forEach(function (st) { scheduled[stopTimeKey(trip.tripId, st.stopId)] = st.departureSec - st.arrivalSec; });
    });

    for (var i = 0; i < stopIds.length; i++) {
      var dwells = [], plannedDwells = [];
      for (var t = 0; t < sel.primary.length; t++) {
        var stTimes = sel.primary[t].stopTimes;
        for (var j = 0; j < stTimes.length; j++) {
          if (stTimes[j].stopId === stopIds[i]) {
            var d = stTimes[j].departureSec - stTimes[j].arrivalSec;
            if (isFiniteNum(d) && d >= 0) {
              dwells.push(d); allDwell.push(d);
              var baseline = scheduled[stopTimeKey(sel.primary[t].tripId, stopIds[i])];
              plannedDwells.push(isFiniteNum(baseline) ? baseline : (service.stopIndex[stopIds[i]] || {}).dwellSec || 0);
            }
            break;
          }
        }
      }
      var stop = service.stopIndex[stopIds[i]] || {};
      var stats = describeSample(dwells);
      var planned = plannedDwells.length ? mean(plannedDwells) : stop.dwellSec || 0;
      perStop.push({
        stopId: stopIds[i],
        stopName: stop.name || stopIds[i],
        code: stop.code || "",
        miles: stop.miles || 0,
        plannedDwellSec: planned,
        stats: stats,
        meanDeltaSec: stats.count ? stats.mean - planned : 0
      });
    }

    return {
      layer: sel.layer,
      perStop: perStop,
      overall: describeSample(allDwell)
    };
  }

  /* ------------------------------------------------------------------ *
   * Delay analysis (observed vs scheduled)
   * ------------------------------------------------------------------ */

  function analyzeDelay(service, options) {
    options = options || {};
    var observed = service.observedTrips;
    var sel = selectTrips(service, options);
    var primary = sel.primary;
    var hasBaseline = !!observed && sel.layer !== "scheduled";

    // Index scheduled times by (tripId, stopId).
    var schedIndex = Object.create(null);
    for (var i = 0; i < service.trips.length; i++) {
      var t = service.trips[i];
      for (var j = 0; j < t.stopTimes.length; j++) {
        schedIndex[stopTimeKey(t.tripId, t.stopTimes[j].stopId)] = t.stopTimes[j];
      }
    }

    var delays = [], perTrip = [], onTimeCount = 0, total = 0;
    var onTimeThresholdSec = options.onTimeThresholdSec == null ? 180 : options.onTimeThresholdSec;
    var stopDelays = Object.create(null);
    var unmatchedObservations = 0;
    var earlyThresholdSec = options.earlyThresholdSec == null ? onTimeThresholdSec : options.earlyThresholdSec;
    if (!isFiniteNum(onTimeThresholdSec) || onTimeThresholdSec < 0 || !isFiniteNum(earlyThresholdSec) || earlyThresholdSec < 0) throw new Error("Invalid delay tolerance");

    for (i = 0; i < primary.length; i++) {
      var trip = primary[i];
      var tripDelays = [];
      for (j = 0; j < trip.stopTimes.length; j++) {
        var st = trip.stopTimes[j];
        var ref = schedIndex[stopTimeKey(trip.tripId, st.stopId)];
        if (!ref || !isFiniteNum(st.arrivalSec)) { unmatchedObservations++; continue; }
        var d = st.arrivalSec - ref.arrivalSec;
        delays.push(d); tripDelays.push(d); total++;
        if (d >= -earlyThresholdSec && d <= onTimeThresholdSec) onTimeCount++;
        (stopDelays[st.stopId] || (stopDelays[st.stopId] = [])).push(d);
      }
      perTrip.push({
        tripId: trip.tripId,
        headsign: trip.headsign,
        startTime: trip.startTime,
        meanDelaySec: mean(tripDelays),
        maxDelaySec: tripDelays.length ? Math.max.apply(null, tripDelays) : 0,
        finalDelaySec: tripDelays.length ? tripDelays[tripDelays.length - 1] : 0
      });
    }

    var perStop = Object.keys(stopDelays).map(function (sid) {
      var stop = service.stopIndex[sid] || {};
      return {
        stopId: sid,
        stopName: stop.name || sid,
        miles: stop.miles || 0,
        stats: describeSample(stopDelays[sid])
      };
    }).sort(function (a, b) { return a.miles - b.miles; });

    return {
      layer: sel.layer,
      hasBaseline: hasBaseline,
      onTimeThresholdSec: onTimeThresholdSec,
      onTimeRate: total ? onTimeCount / total : 0,
      totalObservations: total,
      unmatchedObservations: unmatchedObservations,
      overall: describeSample(delays),
      perTrip: perTrip,
      perStop: perStop
    };
  }

  /* ------------------------------------------------------------------ *
   * Export helpers: formula-safe CSV and SHA-256 integrity
   * ------------------------------------------------------------------ */

  /* One RFC 4180 cell. Spreadsheet formula safety: any text cell whose first
   * non-whitespace character is = + - @ or an apostrophe gets a leading
   * apostrophe so spreadsheet apps keep it as text rather than evaluating
   * it. JavaScript \s covers tabs, LF, CR, vertical tab, form feed and the
   * Unicode space separators. Numbers stay bare - they cannot carry a
   * formula. */
  function csvCell(value) {
    var s = value == null ? "" : String(value);
    if (typeof value === "number" && !isFiniteNum(value)) return "";
    if (typeof value !== "number" && /^[\s\u0085\u180E\u200B\u200C\u200D\u2060\uFEFF]*[=+\-@'\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* Write rows to CSV text. columns: [{ key, label }] or
   * [{ label, value(row) }]. Lines join with CRLF and the text ends with a
   * final CRLF, matching RFC 4180. */
  function toCsv(columns, rows) {
    var lines = [columns.map(function (c) { return csvCell(c.label != null ? c.label : c.key); }).join(",")];
    (rows || []).forEach(function (r) {
      lines.push(columns.map(function (c) {
        return csvCell(typeof c.value === "function" ? c.value(r) : r[c.key]);
      }).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  /* Synchronous SHA-256 (FIPS 180-4) over a string or byte array, returned
   * as lowercase hex. Dependency free so exports work identically in the
   * browser, Node, and the DOM test fixture. */
  function sha256Hex(input) {
    var bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    if (!bytes || typeof bytes.length !== "number") bytes = new Uint8Array(0);
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var total = Math.ceil((bytes.length + 9) / 64) * 64;
    var msg = new Uint8Array(total);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    var dv = new DataView(msg.buffer);
    dv.setUint32(total - 8, Math.floor(bytes.length / 536870912));
    dv.setUint32(total - 4, (bytes.length * 8) >>> 0);
    var w = new Int32Array(64), i, off;
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0] | 0, b = h[1] | 0, c = h[2] | 0, d = h[3] | 0;
      var e = h[4] | 0, f = h[5] | 0, g = h[6] | 0, hh = h[7] | 0;
      for (i = 0; i < 64; i++) {
        var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = "";
    for (i = 0; i < 8; i++) out += ("00000000" + (h[i] >>> 0).toString(16)).slice(-8);
    return out;
  }

  /* Flatten a report's per-station headway, dwell and delay measurements into
   * one CSV table. Station names come from untrusted feed data, so every
   * cell passes through the formula-safe writer. */
  function reportCsv(report) {
    var delayBy = Object.create(null), dwellBy = Object.create(null), headBy = Object.create(null);
    (report.delay && report.delay.perStop || []).forEach(function (p) { delayBy[p.stopId] = p; });
    (report.dwell && report.dwell.perStop || []).forEach(function (p) { dwellBy[p.stopId] = p; });
    (report.headways && report.headways.perStop || []).forEach(function (p) { headBy[p.stopId] = p; });
    var stops = (report.stringline && report.stringline.stops) || [];
    var columns = [
      { key: "stop", label: "station" }, { key: "code", label: "code" },
      { key: "milepost_mi", label: "milepost_mi" },
      { key: "mean_headway_s", label: "mean_headway_s" },
      { key: "headway_cv", label: "headway_cv" },
      { key: "headway_samples", label: "headway_samples" },
      { key: "planned_dwell_s", label: "planned_dwell_s" },
      { key: "mean_dwell_s", label: "mean_dwell_s" },
      { key: "dwell_delta_s", label: "dwell_delta_s" },
      { key: "mean_delay_s", label: "mean_delay_s" },
      { key: "p90_delay_s", label: "p90_delay_s" },
      { key: "delay_samples", label: "delay_samples" }
    ];
    var rows = stops.map(function (s) {
      var hp = headBy[s.id] || { stats: {} }, wp = dwellBy[s.id] || { stats: {} }, dp = delayBy[s.id] || { stats: {} };
      return {
        stop: s.name, code: s.code, milepost_mi: s.miles,
        mean_headway_s: round(hp.stats.mean || 0, 1),
        headway_cv: round(hp.stats.cv || 0, 3),
        headway_samples: hp.stats.count || 0,
        planned_dwell_s: round(wp.plannedDwellSec || 0, 0),
        mean_dwell_s: round(wp.stats.mean || 0, 1),
        dwell_delta_s: round(wp.meanDeltaSec || 0, 1),
        mean_delay_s: round(dp.stats.mean || 0, 1),
        p90_delay_s: round(dp.stats.p90 || 0, 1),
        delay_samples: dp.stats.count || 0
      };
    });
    return toCsv(columns, rows);
  }

  /* ------------------------------------------------------------------ *
   * Combined report
   * ------------------------------------------------------------------ */

  function buildReport(service, options) {
    options = options || {};
    var headways = analyzeHeadways(service, options);
    var bunching = analyzeBunching(service, options);
    var dwell = analyzeDwell(service, options);
    var delay = analyzeDelay(service, options);
    var stringline = buildStringline(service, Object.assign({}, options, { includeScheduled: true, maxTrips: options.maxStringlineTrips == null ? 24 : options.maxStringlineTrips }));

    var grades = {
      headway: reliabilityGrade(1 - clamp(headways.overall.cv, 0, 1)),
      bunching: reliabilityGrade(1 - clamp(bunching.bunchRate * 2, 0, 1)),
      punctuality: reliabilityGrade(delay.onTimeRate),
      dwell: reliabilityGrade(1 - clamp(mean(dwell.perStop.map(function (p) { return Math.max(0, p.meanDeltaSec); })) / Math.max(1, mean(dwell.perStop.map(function (p) { return p.plannedDwellSec; }))), 0, 1))
    };

    return {
      service: {
        id: service.id, name: service.name, shortName: service.shortName,
        operator: service.operator, kind: service.kind,
        source: service.source, plannedHeadwaySec: service.plannedHeadwaySec,
        stopCount: service.stops.length, tripCount: service.trips.length,
        hasObserved: !!service.observedTrips
      },
      grades: grades,
      headways: headways,
      bunching: bunching,
      dwell: dwell,
      delay: delay,
      stringline: stringline,
      score: compositeScore(grades),
      verification: verifyService(service)
    };
  }

  function reliabilityGrade(fraction) {
    var f = clamp(fraction, 0, 1);
    if (f >= 0.90) return "A";
    if (f >= 0.80) return "B";
    if (f >= 0.70) return "C";
    if (f >= 0.60) return "D";
    return "F";
  }

  function compositeScore(grades) {
    var map = { A: 4, B: 3, C: 2, D: 1, F: 0 };
    var keys = Object.keys(grades), s = 0;
    for (var i = 0; i < keys.length; i++) s += map[grades[keys[i]]] || 0;
    return round(s / (keys.length * 4) * 100, 0);
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  var api = {
    // helpers
    parseGtfsTime: parseGtfsTime,
    formatGtfsTime: formatGtfsTime,
    formatDuration: formatDuration,
    mean: mean,
    stddev: stddev,
    percentile: percentile,
    median: median,
    sum: sum,
    describeSample: describeSample,
    populationVariance: populationVariance,
    verifyService: verifyService,
    geoDistanceMiles: geoDistanceMiles,
    pointAlong: pointAlong,
    interpolateStationCoordinates: interpolateStationCoordinates,
    // csv / zip
    parseCsv: parseCsv,
    splitCsvRow: splitCsvRow,
    readZip: readZip,
    readFeedFiles: readFeedFiles,
    isZipBytes: isZipBytes,
    MAX_FEED_BYTES: MAX_FEED_BYTES,
    // export
    csvCell: csvCell,
    toCsv: toCsv,
    sha256Hex: sha256Hex,
    reportCsv: reportCsv,
    // gtfs
    resolveActiveServices: resolveActiveServices,
    parseGtfs: parseGtfs,
    dominantDirection: dominantDirection,
    // synthetic
    listCorridors: listCorridors,
    buildSyntheticService: buildSyntheticService,
    buildAllSyntheticServices: buildAllSyntheticServices,
    // realtime
    simulateObserved: simulateObserved,
    simulateCascade: simulateCascade,
    withObserved: withObserved,
    applyRealtime: applyRealtime,
    // analyzers
    analyzeHeadways: analyzeHeadways,
    analyzeBunching: analyzeBunching,
    buildStringline: buildStringline,
    analyzeDwell: analyzeDwell,
    analyzeDelay: analyzeDelay,
    buildReport: buildReport,
    arrivalsAtStop: arrivalsAtStop
  };

  for (var key in api) {
    if (Object.prototype.hasOwnProperty.call(api, key)) ns[key] = api[key];
  }
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
