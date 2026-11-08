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
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  function stddev(a) {
    if (!a || a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; }
    return Math.sqrt(s / (a.length - 1));
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
  function sum(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t; }

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
    var maxMile = 0, i;
    for (i = 0; i < stations.length; i++) {
      if (stations[i][2] > maxMile) maxMile = stations[i][2];
    }
    if (maxMile <= 0) maxMile = 1;
    var out = [];
    for (i = 0; i < stations.length; i++) {
      var p = pointAlong(anchors, stations[i][2] / maxMile);
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
    if (!isFiniteNum(sec)) return "";
    var neg = sec < 0;
    var t = Math.round(Math.abs(sec));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    return (neg ? "-" : "") + pad2(h) + ":" + pad2(m) + ":" + pad2(s);
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
    var fields = [], cur = "", i = 0, inQuotes = false;
    while (i < row.length) {
      var c = row.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (row.charAt(i + 1) === '"') { cur += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        cur += c; i++; continue;
      }
      if (c === '"' && cur === "") { inQuotes = true; i++; continue; }
      if (c === ",") { fields.push(cur); cur = ""; i++; continue; }
      cur += c; i++;
    }
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
    var rows = [];
    var field = "", record = [], inQuotes = false, i = 0;
    while (i < text.length) {
      var c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { inQuotes = true; i++; continue; }
      if (c === ",") { record.push(field); field = ""; i++; continue; }
      if (c === "\r" || c === "\n") {
        if (c === "\r" && text.charAt(i + 1) === "\n") i++;
        record.push(field);
        rows.push(record);
        record = []; field = ""; i++; continue;
      }
      field += c; i++;
    }
    if (field !== "" || record.length) { record.push(field); rows.push(record); }

    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var raw = rows[r];
      if (raw.length === 1 && raw[0].trim() === "") continue;
      var obj = {};
      for (var k = 0; k < header.length; k++) {
        if (header[k] === "") continue;
        obj[header[k]] = raw[k] === undefined ? "" : raw[k];
      }
      out.push(obj);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * ZIP reader (store + deflate, local-file scan)
   * ------------------------------------------------------------------ *
   * A GTFS static feed is a ZIP archive of CSV text files. This reader walks
   * the local file headers directly, so it does not need the central directory
   * and tolerates data descriptors. Entries compressed with method 0 (store)
   * or 8 (deflate-raw) are inflated with the platform DecompressionStream,
   * available in modern browsers and Node 18+. Returns a Promise resolving to
   * { "filename.txt": "text..." } keyed by basename (folder prefixes ignored).
   */

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("DecompressionStream unavailable: cannot read compressed GTFS .zip"));
    }
    var ds = new DecompressionStream("deflate-raw");
    var blob = new Blob([bytes]);
    var stream = blob.stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function readZip(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    var u8 = new Uint8Array(arrayBuffer);
    var files = {};
    var tasks = [];
    var i = 0, n = u8.length;
    var decoder = new TextDecoder("utf-8");

    while (i + 30 <= n) {
      if (dv.getUint32(i, true) !== 0x04034b50) break; // not a local file header
      var flags = dv.getUint16(i + 6, true);
      var method = dv.getUint16(i + 8, true);
      var compSize = dv.getUint32(i + 18, true);
      var nameLen = dv.getUint16(i + 26, true);
      var extraLen = dv.getUint16(i + 28, true);
      var nameBytes = u8.subarray(i + 30, i + 30 + nameLen);
      var fullName = decoder.decode(nameBytes);
      var base = fullName.split("/").pop();
      var dataStart = i + 30 + nameLen + extraLen;
      var compBytes = u8.subarray(dataStart, dataStart + compSize);

      // Bit 3 means sizes live in a data descriptor after the data, so the
      // header compSize is zero. Fall back to the central directory scan.
      var hasDescriptor = (flags & 0x08) !== 0;

      if (hasDescriptor || compSize === 0 || dataStart + compSize > n) {
        return readZipViaCentralDirectory(arrayBuffer);
      }

      if (base && method === 0) {
        files[base] = decoder.decode(compBytes);
      } else if (base && method === 8) {
        (function (bn, cb) {
          var task = inflateRaw(cb).then(function (outBytes) {
            files[bn] = decoder.decode(outBytes);
          });
          tasks.push(task);
        })(base, compBytes.slice());
      }
      i = dataStart + compSize;
    }

    return Promise.all(tasks).then(function () { return files; });
  }

  /* Fallback for archives whose local headers use a data descriptor: parse the
   * end-of-central-directory record and walk the central directory, which
   * always carries the real compressed sizes. */
  function readZipViaCentralDirectory(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    var u8 = new Uint8Array(arrayBuffer);
    var n = u8.length;
    var decoder = new TextDecoder("utf-8");
    var eocd = -1;
    for (var p = n - 22; p >= 0 && p >= n - 65558; p--) {
      if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) return Promise.reject(new Error("Invalid ZIP: end of central directory not found"));
    var entries = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    var files = {}, tasks = [], cur = cdOffset;
    for (var e = 0; e < entries && cur + 46 <= n; e++) {
      if (dv.getUint32(cur, true) !== 0x02014b50) break;
      var method = dv.getUint16(cur + 10, true);
      var compSize = dv.getUint32(cur + 20, true);
      var nameLen = dv.getUint16(cur + 28, true);
      var extraLen = dv.getUint16(cur + 30, true);
      var commentLen = dv.getUint16(cur + 32, true);
      var localOffset = dv.getUint32(cur + 42, true);
      var fullName = decoder.decode(u8.subarray(cur + 46, cur + 46 + nameLen));
      var base = fullName.split("/").pop();

      var lNameLen = dv.getUint16(localOffset + 26, true);
      var lExtraLen = dv.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;
      var compBytes = u8.subarray(dataStart, dataStart + compSize);

      if (base && method === 0) {
        files[base] = decoder.decode(compBytes);
      } else if (base && method === 8) {
        (function (bn, cb) {
          var task = inflateRaw(cb).then(function (outBytes) {
            files[bn] = decoder.decode(outBytes);
          });
          tasks.push(task);
        })(base, compBytes.slice());
      }
      cur += 46 + nameLen + extraLen + commentLen;
    }
    return Promise.all(tasks).then(function () { return files; });
  }

  /* Read a GTFS feed from a File, Blob, ArrayBuffer, or a plain object of
   * { filename: text } (loose CSV files pasted into the page). Always returns
   * a Promise of { filename: text }. ZIP detection uses the PK magic bytes;
   * otherwise the input is treated as either loose CSV text or a file map. */
  function readFeedFiles(input) {
    if (input && typeof input === "object" && !Array.isArray(input)) {
      if (input instanceof ArrayBuffer) return readZip(input);
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        return readZip(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
      }
      // A map of filename -> text (loose CSV files, or already-extracted ZIP).
      var keys = Object.keys(input);
      if (keys.length && typeof input[keys[0]] === "string") {
        return Promise.resolve(input);
      }
      if (typeof input.arrayBuffer === "function") {
        return input.arrayBuffer().then(readZip);
      }
    }
    if (typeof input === "string") {
      // A single CSV pasted as text: name it by its header signature.
      var firstLine = input.slice(0, 200).split(/\r?\n/)[0].toLowerCase();
      var name = firstLine.indexOf("stop_time") >= 0 ? "stop_times.txt" :
                 firstLine.indexOf("trip_id") >= 0 ? "trips.txt" : "unknown.txt";
      var map = {}; map[name] = input;
      return Promise.resolve(map);
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
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
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
   * no calendar.txt at all, service ids are taken from calendar_dates adds
   * and from trips.txt as a permissive fallback. */
  function resolveActiveServices(files, dateStrValue) {
    var target = parseYmd(dateStrValue);
    if (target === null) {
      return { active: null, error: "Invalid service date (expected YYYYMMDD)" };
    }
    var calendar = files["calendar.txt"] ? parseCsv(files["calendar.txt"]) : [];
    var calDates = files["calendar_dates.txt"] ? parseCsv(files["calendar_dates.txt"]) : [];
    var trips = files["trips.txt"] ? parseCsv(files["trips.txt"]) : [];
    var active = {}, i, row;

    for (i = 0; i < calendar.length; i++) {
      row = calendar[i];
      var sid = row.service_id;
      if (!sid) continue;
      var start = parseYmd(row.start_date), end = parseYmd(row.end_date);
      if (start === null || end === null) continue;
      if (target < start || target > end) continue;
      if (row[DOW_KEYS[gtfsDowIndex(target)]] === "1") active[sid] = true;
    }

    for (i = 0; i < calDates.length; i++) {
      row = calDates[i];
      if (!row.service_id || dateStr(row.date) !== dateStrValue) continue;
      if (row.exception_type === "1") active[row.service_id] = true;
      else if (row.exception_type === "2") delete active[row.service_id];
    }

    // Feeds that use only calendar_dates.txt (no weekly calendar).
    if (!calendar.length) {
      var hasAdds = calDates.some(function (r) { return r.exception_type === "1"; });
      if (!hasAdds) {
        for (i = 0; i < trips.length; i++) {
          if (trips[i].service_id) active[trips[i].service_id] = true;
        }
      }
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

  /* Pick the direction of a route with the most trips, so a single Service
   * represents one coherent travel direction. Other directions are exposed
   * by listServices but analysis focuses on the busiest one per route. */
  function dominantDirection(trips) {
    var counts = {}, best = "0", bestN = -1;
    for (var i = 0; i < trips.length; i++) {
      var d = trips[i].direction_id || "0";
      counts[d] = (counts[d] || 0) + 1;
      if (counts[d] > bestN) { bestN = counts[d]; best = d; }
    }
    return best;
  }

  /* Build a normalized Service from the GTFS tables for one route+direction.
   * Station miles are computed as cumulative haversine distance along the
   * representative stop sequence, so stringlines have a distance axis even
   * when the feed lacks shape_dist_traveled. */
  function buildServiceFromGtfs(routeId, directionId, ctx) {
    var route = ctx.routeById[routeId] || {};
    var agency = ctx.agencyById[route.agency_id] || ctx.firstAgency || {};
    var routeTrips = ctx.trips.filter(function (t) {
      return t.route_id === routeId && (t.direction_id || "0") === directionId;
    });
    if (!routeTrips.length) return null;

    var stopRowsById = {}, i, j;
    for (var sid in ctx.stopById) stopRowsById[sid] = ctx.stopById[sid];

    // Representative stop sequence from the trip with the most stop_times.
    var repTrip = null, repTimes = null;
    for (i = 0; i < routeTrips.length; i++) {
      var times = ctx.timesByTrip[routeTrips[i].trip_id];
      if (!times || !times.length) continue;
      if (!repTimes || times.length > repTimes.length) { repTimes = times; repTrip = routeTrips[i]; }
    }
    if (!repTimes) return null;

    // Order stop_times by stop_sequence; keep the first visit to each stop.
    repTimes = repTimes.slice().sort(function (a, b) {
      return numOr(a.stop_sequence, 0) - numOr(b.stop_sequence, 0);
    });
    var seen = {}, orderedTimes = [];
    for (i = 0; i < repTimes.length; i++) {
      var key = repTimes[i].stop_id;
      if (seen[key]) continue;
      seen[key] = true;
      orderedTimes.push(repTimes[i]);
    }

    // Cumulative miles along the representative sequence.
    var milesByStop = {}, cum = 0, prev = null;
    for (i = 0; i < orderedTimes.length; i++) {
      var srow = stopRowsById[orderedTimes[i].stop_id];
      var ll = srow ? [numOr(srow.stop_lat, NaN), numOr(srow.stop_lon, NaN)] : null;
      if (prev && ll && isFiniteNum(ll[0]) && isFiniteNum(ll[1]) &&
          isFiniteNum(prev[0]) && isFiniteNum(prev[1])) {
        cum += geoDistanceMiles(prev, ll);
      }
      milesByStop[orderedTimes[i].stop_id] = cum;
      if (ll && isFiniteNum(ll[0])) prev = ll;
    }
    // If shape_dist_traveled is present on stop_times, prefer it.
    var hasShapeDist = repTimes.some(function (t) { return t.shape_dist_traveled !== "" && t.shape_dist_traveled != null; });
    if (hasShapeDist) {
      var scaleToMiles = 1;
      // Heuristic: values above ~200 are meters, otherwise already miles.
      var maxShape = 0;
      for (i = 0; i < repTimes.length; i++) maxShape = Math.max(maxShape, numOr(repTimes[i].shape_dist_traveled, 0));
      if (maxShape > 200) scaleToMiles = 0.000621371;
      for (i = 0; i < repTimes.length; i++) {
        milesByStop[repTimes[i].stop_id] = numOr(repTimes[i].shape_dist_traveled, milesByStop[repTimes[i].stop_id]) * scaleToMiles;
      }
    }

    var stops = [];
    for (i = 0; i < orderedTimes.length; i++) {
      var stId = orderedTimes[i].stop_id;
      var s = stopRowsById[stId] || {};
      var arr = parseGtfsTime(orderedTimes[i].arrival_time);
      var dep = parseGtfsTime(orderedTimes[i].departure_time);
      var dwell = (isFiniteNum(arr) && isFiniteNum(dep)) ? Math.max(0, dep - arr) : 0;
      stops.push({
        id: stId,
        code: (s.stop_code || stId),
        name: (s.stop_name || stId),
        lat: numOr(s.stop_lat, 0),
        lon: numOr(s.stop_lon, 0),
        miles: round(milesByStop[stId] || 0, 3),
        dwellSec: dwell
      });
    }

    var tripsOut = [];
    for (i = 0; i < routeTrips.length; i++) {
      var trip = routeTrips[i];
      var tt = ctx.timesByTrip[trip.trip_id];
      if (!tt || !tt.length) continue;
      tt = tt.slice().sort(function (a, b) {
        return numOr(a.stop_sequence, 0) - numOr(b.stop_sequence, 0);
      });
      var stopTimes = [];
      for (j = 0; j < tt.length; j++) {
        var a = parseGtfsTime(tt[j].arrival_time);
        var d = parseGtfsTime(tt[j].departure_time);
        if (!isFiniteNum(a)) a = isFiniteNum(d) ? d : 0;
        if (!isFiniteNum(d)) d = a;
        stopTimes.push({
          stopId: tt[j].stop_id,
          seq: numOr(tt[j].stop_sequence, j + 1),
          arrivalSec: a,
          departureSec: d,
          miles: milesByStop[tt[j].stop_id] != null ? round(milesByStop[tt[j].stop_id], 3) : 0,
          headsign: trip.trip_headsign || route.route_long_name || route.route_short_name || ""
        });
      }
      // Keep only trips that actually follow the representative sequence.
      var firstArr = stopTimes.length ? stopTimes[0].arrivalSec : 0;
      tripsOut.push({
        tripId: trip.trip_id,
        routeId: routeId,
        headsign: trip.trip_headsign || route.route_long_name || "",
        direction: directionId,
        serviceId: trip.service_id || "",
        stopTimes: stopTimes,
        startTime: firstArr
      });
    }
    if (!tripsOut.length) return null;
    tripsOut.sort(function (a, b) { return a.startTime - b.startTime; });

    // Infer planned headway as the median gap between trip start times, and
    // service span from earliest arrival to latest departure.
    var starts = tripsOut.map(function (t) { return t.startTime; });
    var gaps = [];
    for (i = 1; i < starts.length; i++) {
      var g = starts[i] - starts[i - 1];
      if (g > 0) gaps.push(g);
    }
    var plannedHeadwaySec = gaps.length ? Math.round(median(gaps)) : 0;
    var startSec = Math.min.apply(null, starts);
    var endSec = startSec;
    for (i = 0; i < tripsOut.length; i++) {
      var last = tripsOut[i].stopTimes[tripsOut[i].stopTimes.length - 1];
      if (last) endSec = Math.max(endSec, last.departureSec);
    }

    var routeName = route.route_long_name || route.route_short_name || routeId;
    var shortName = route.route_short_name || routeName;
    return {
      id: "gtfs-" + routeId + "-d" + directionId,
      name: routeName,
      shortName: shortName,
      operator: agency.agency_name || "GTFS feed",
      kind: gtfsRouteKind(route.route_type),
      directionLabel: directionId === "1" ? "Direction 1 (inbound)" : "Direction 0 (outbound)",
      colorKey: gtfsColorKey(route),
      source: "gtfs",
      routeId: routeId,
      plannedHeadwaySec: plannedHeadwaySec,
      startSec: startSec,
      endSec: endSec,
      stops: stops,
      trips: tripsOut,
      observedTrips: null,
      stopIndex: indexStops(stops)
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

  function indexStops(stops) {
    var idx = {};
    for (var i = 0; i < stops.length; i++) idx[stops[i].id] = stops[i];
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

      var routeById = {}, i;
      for (i = 0; i < routes.length; i++) routeById[routes[i].route_id] = routes[i];
      var agencyById = {};
      for (i = 0; i < agencies.length; i++) agencyById[agencies[i].agency_id] = agencies[i];

      var stopById = {};
      for (i = 0; i < stopsRows.length; i++) stopById[stopsRows[i].stop_id] = stopsRows[i];

      var timesByTrip = {};
      for (i = 0; i < stopTimes.length; i++) {
        var tid = stopTimes[i].trip_id;
        (timesByTrip[tid] || (timesByTrip[tid] = [])).push(stopTimes[i]);
      }

      // Choose a service date with the most active services when unspecified.
      var date = options.date || guessBusiestDate(files);
      var resolved = resolveActiveServices(files, date);
      var active = resolved.active || {};

      // Restrict trips to active services if calendar data is meaningful.
      var calDates = files["calendar_dates.txt"] ? parseCsv(files["calendar_dates.txt"]) : [];
      var calendar = files["calendar.txt"] ? parseCsv(files["calendar.txt"]) : [];
      var hasCalendarData = calendar.length || calDates.length;
      var activeTrips = trips.filter(function (t) {
        return !hasCalendarData || active[t.service_id];
      });
      if (!activeTrips.length) activeTrips = trips; // permissive fallback

      // Group by route, then keep dominant direction per route.
      var byRoute = {};
      for (i = 0; i < activeTrips.length; i++) {
        var rid = activeTrips[i].route_id;
        (byRoute[rid] || (byRoute[rid] = [])).push(activeTrips[i]);
      }

      var ctx = {
        routeById: routeById, agencyById: agencyById,
        firstAgency: agencies[0] || {},
        stopById: stopById, timesByTrip: timesByTrip, trips: activeTrips
      };

      var warnings = [];
      if (!routes.length) warnings.push("No routes.txt: using route ids from trips.txt.");
      if (!hasCalendarData) warnings.push("No calendar data: all trips treated as active for the selected date.");

      var routeIds = Object.keys(byRoute).sort();
      if (options.routeId) routeIds = routeIds.filter(function (r) { return r === options.routeId; });

      var services = [];
      var maxServices = options.maxServices == null ? 12 : options.maxServices;
      for (i = 0; i < routeIds.length && services.length < maxServices; i++) {
        var dir = dominantDirection(byRoute[routeIds[i]]);
        var svc = buildServiceFromGtfs(routeIds[i], dir, ctx);
        if (svc) services.push(svc);
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
    var calDates = files["calendar_dates.txt"] ? parseCsv(files["calendar_dates.txt"]) : [];
    var candidates = {}, i;
    for (i = 0; i < calDates.length; i++) {
      if (calDates[i].date) candidates[dateStr(calDates[i].date)] = true;
    }
    for (i = 0; i < calendar.length; i++) {
      var s = parseYmd(calendar[i].start_date);
      if (s !== null) candidates[String(calendar[i].start_date).trim()] = true;
    }
    var best = null, bestN = -1, keys = Object.keys(candidates);
    for (i = 0; i < keys.length; i++) {
      var res = resolveActiveServices(files, keys[i]);
      var n = res.active ? Object.keys(res.active).length : 0;
      if (n > bestN) { bestN = n; best = keys[i]; }
    }
    if (best) return best;
    var d = new Date();
    return "" + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
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

    var speedMph = corridor.speedMph || 40;
    var secPerMile = 3600 / speedMph;
    var headway = options.headwaySec || corridor.headwaySec || 600;
    var startSec = options.startSec != null ? options.startSec : (corridor.startSec || 5 * 3600);
    var endSec = options.endSec != null ? options.endSec : (corridor.endSec || 24 * 3600);

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
        var arr = st.arrivalSec + acc;
        var dwell = Math.max(0, st.departureSec - st.arrivalSec + (rng() - 0.5) * 20 * intensity);
        var dep = arr + dwell;
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
    var byTrip = {};
    for (var i = 0; i < updates.length; i++) {
      var u = updates[i];
      if (!u || !u.tripId) continue;
      (byTrip[u.tripId] || (byTrip[u.tripId] = {}))[u.stopId] = u;
    }
    var out = [];
    for (i = 0; i < service.trips.length; i++) {
      var trip = service.trips[i];
      var map = byTrip[trip.tripId] || {};
      var stTimes = trip.stopTimes.map(function (st) {
        var u = map[st.stopId];
        if (!u) return { stopId: st.stopId, seq: st.seq, arrivalSec: st.arrivalSec,
                         departureSec: st.departureSec, miles: st.miles, headsign: st.headsign };
        var a = isFiniteNum(u.arrivalSec) ? u.arrivalSec : st.arrivalSec + (numOr(u.arrivalDelaySec, 0));
        var d = isFiniteNum(u.departureSec) ? u.departureSec : st.departureSec + (numOr(u.departureDelaySec, numOr(u.arrivalDelaySec, 0)));
        return { stopId: st.stopId, seq: st.seq, arrivalSec: Math.round(a),
                 departureSec: Math.round(d), miles: st.miles, headsign: st.headsign };
      });
      out.push({
        tripId: trip.tripId, routeId: trip.routeId, headsign: trip.headsign,
        direction: trip.direction, serviceId: trip.serviceId,
        stopTimes: stTimes, startTime: stTimes[0] ? stTimes[0].arrivalSec : trip.startTime
      });
    }
    return out;
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
    var observed = service.observedTrips;
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
    var b = Math.floor((sec % 86400) / bucketSec) * bucketSec;
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
    var bucketSec = options.timeBucketSec || 3600;
    var perStop = [], allGaps = [], buckets = {}, histogram = {};
    var binCount = options.histogramBins || 12;

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
    var timeOfDay = Object.keys(buckets).sort().map(function (k) {
      var st = describeSample(buckets[k]);
      return { label: k, meanSec: st.mean, p90Sec: st.p90, count: st.count };
    });

    return {
      layer: sel.layer,
      plannedHeadwaySec: planned,
      perStop: perStop,
      overall: overall,
      excessWaitSec: overall.mean > 0 ? (overall.stddev * overall.stddev) / (2 * overall.mean) : 0,
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
    var ewt = m > 0 ? (stddev(allHw) * stddev(allHw)) / (2 * m) : 0;

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
    var sel = selectTrips(service, options);
    var maxTrips = options.maxTrips || 0;
    var trips = maxTrips ? sel.primary.slice(0, maxTrips) : sel.primary;

    function toLines(list, layerName) {
      return list.map(function (t) {
        var pts = t.stopTimes.map(function (st) {
          var mi = st.miles;
          if (!isFiniteNum(mi)) {
            var s = service.stopIndex[st.stopId];
            mi = s ? s.miles : 0;
          }
          return { timeSec: st.arrivalSec, miles: mi, stopId: st.stopId,
                   stopName: (service.stopIndex[st.stopId] || {}).name || st.stopId };
        });
        return {
          tripId: t.tripId,
          headsign: t.headsign,
          layer: layerName,
          points: pts,
          startTime: pts.length ? pts[0].timeSec : 0,
          endTime: pts.length ? pts[pts.length - 1].timeSec : 0
        };
      });
    }

    var lines = toLines(trips, sel.layer);
    var scheduledLines = (options.includeScheduled && sel.layer === "observed")
      ? toLines(sel.scheduled, "scheduled") : null;

    var minTime = Infinity, maxTime = -Infinity, maxMiles = 0;
    for (var i = 0; i < lines.length; i++) {
      for (var j = 0; j < lines[i].points.length; j++) {
        var p = lines[i].points[j];
        if (p.timeSec < minTime) minTime = p.timeSec;
        if (p.timeSec > maxTime) maxTime = p.timeSec;
        if (p.miles > maxMiles) maxMiles = p.miles;
      }
    }
    if (!isFinite(minTime)) { minTime = 0; maxTime = 1; }
    return {
      layer: sel.layer,
      lines: lines,
      scheduledLines: scheduledLines,
      timeDomain: [minTime, maxTime],
      milesDomain: [0, maxMiles],
      stops: service.stops.map(function (s) {
        return { id: s.id, name: s.name, code: s.code, miles: s.miles };
      })
    };
  }

  /* ------------------------------------------------------------------ *
   * Dwell analysis
   * ------------------------------------------------------------------ */

  function analyzeDwell(service, options) {
    options = options || {};
    var sel = selectTrips(service, options);
    var stopIds = options.stopId ? [options.stopId] : service.stops.map(function (s) { return s.id; });
    var perStop = [], allDwell = [];

    for (var i = 0; i < stopIds.length; i++) {
      var dwells = [];
      for (var t = 0; t < sel.primary.length; t++) {
        var stTimes = sel.primary[t].stopTimes;
        for (var j = 0; j < stTimes.length; j++) {
          if (stTimes[j].stopId === stopIds[i]) {
            var d = stTimes[j].departureSec - stTimes[j].arrivalSec;
            if (isFiniteNum(d) && d >= 0) { dwells.push(d); allDwell.push(d); }
            break;
          }
        }
      }
      var stop = service.stopIndex[stopIds[i]] || {};
      var stats = describeSample(dwells);
      var planned = stop.dwellSec || 0;
      perStop.push({
        stopId: stopIds[i],
        stopName: stop.name || stopIds[i],
        code: stop.code || "",
        miles: stop.miles || 0,
        plannedDwellSec: planned,
        stats: stats,
        meanDeltaSec: planned ? stats.mean - planned : 0
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
    var primary = observed || sel.primary;
    var hasBaseline = !!observed;

    // Index scheduled times by (tripId, stopId).
    var schedIndex = {};
    for (var i = 0; i < service.trips.length; i++) {
      var t = service.trips[i];
      for (var j = 0; j < t.stopTimes.length; j++) {
        schedIndex[t.tripId + "|" + t.stopTimes[j].stopId] = t.stopTimes[j];
      }
    }

    var delays = [], perTrip = [], onTimeCount = 0, total = 0;
    var onTimeThresholdSec = options.onTimeThresholdSec == null ? 180 : options.onTimeThresholdSec;
    var stopDelays = {};

    for (i = 0; i < primary.length; i++) {
      var trip = primary[i];
      var tripDelays = [];
      for (j = 0; j < trip.stopTimes.length; j++) {
        var st = trip.stopTimes[j];
        var ref = schedIndex[trip.tripId + "|" + st.stopId];
        var d = ref ? st.arrivalSec - ref.arrivalSec : 0;
        delays.push(d); tripDelays.push(d); total++;
        if (d <= onTimeThresholdSec) onTimeCount++;
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
      overall: describeSample(delays),
      perTrip: perTrip,
      perStop: perStop
    };
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
    var stringline = buildStringline(service, { includeScheduled: true, maxTrips: options.maxStringlineTrips || 24 });

    var grades = {
      headway: reliabilityGrade(1 - clamp(bunching.bunchRate, 0, 1)),
      bunching: reliabilityGrade(1 - clamp(bunching.bunchRate * 2, 0, 1)),
      punctuality: reliabilityGrade(delay.onTimeRate),
      dwell: reliabilityGrade(1 - clamp(dwell.overall.cv, 0, 1))
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
      score: compositeScore(grades)
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
    describeSample: describeSample,
    geoDistanceMiles: geoDistanceMiles,
    pointAlong: pointAlong,
    interpolateStationCoordinates: interpolateStationCoordinates,
    // csv / zip
    parseCsv: parseCsv,
    splitCsvRow: splitCsvRow,
    readZip: readZip,
    readFeedFiles: readFeedFiles,
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
