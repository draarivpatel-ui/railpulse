/* RailPulse unit tests.
 *
 * Run with:  node --test tests/
 *
 * The engine is a UMD module. corridors.js attaches its bundle to
 * globalThis.RailPulse, so we require it first and then require engine.js,
 * which reads the bundle from that shared namespace (and also exposes its own
 * CommonJS exports for direct use here).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Load the corridor bundle onto globalThis.RailPulse, then the engine.
require("../corridors.js");
const E = require("../engine.js");
const CORRIDORS = globalThis.RailPulse.CORRIDORS;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function makeCorridor(overrides) {
  return Object.assign({
    id: "test-line",
    name: "Test Line",
    shortName: "Test",
    operator: "Test Operator",
    kind: "metro",
    colorKey: 1,
    routeId: "TL",
    directionLabel: "Origin to Terminal",
    speedMph: 60,
    headwaySec: 600,
    startSec: 6 * 3600,
    endSec: 10 * 3600,
    anchors: [[41.8800, -87.6300], [41.8500, -87.6280], [41.8100, -87.6280]],
    stations: [
      ["A", "Alpha", 0.0, 30],
      ["B", "Bravo", 2.0, 30],
      ["C", "Charlie", 4.0, 60]
    ]
  }, overrides || {});
}

function makeGtfsFiles() {
  return {
    "agency.txt":
      "agency_id,agency_name,agency_url,agency_timezone\n" +
      "A1,Demo Metro,http://example.com,America/Chicago\n",
    "routes.txt":
      "route_id,agency_id,route_short_name,route_long_name,route_type,route_color\n" +
      "R1,A1,RL,Red Line,1,DA291C\n" +
      "R2,A1,BL,Blue Line,1,003DA5\n",
    "stops.txt":
      "stop_id,stop_code,stop_name,stop_lat,stop_lon\n" +
      "S1,001,Alpha,41.8800,-87.6300\n" +
      "S2,002,Bravo,41.8500,-87.6280\n" +
      "S3,003,Charlie,41.8100,-87.6280\n",
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "WK,1,1,1,1,1,0,0,20260101,20261231\n" +
      "WE,0,0,0,0,0,1,1,20260101,20261231\n",
    "calendar_dates.txt":
      "service_id,date,exception_type\n" +
      "WK,20261109,2\n" +
      "WE,20261106,1\n",
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,direction_id\n" +
      "R1,WK,T1,Charlie,0\n" +
      "R1,WK,T2,Charlie,0\n" +
      "R1,WK,T3,Charlie,0\n" +
      "R1,WK,T4,Charlie,0\n" +
      "R1,WE,TW1,Charlie,0\n" +
      "R2,WK,B1,Downtown,0\n",
    "stop_times.txt":
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
      "T1,08:00:00,08:00:30,S1,1\nT1,08:05:00,08:05:30,S2,2\nT1,08:11:00,08:11:00,S3,3\n" +
      "T2,08:10:00,08:10:30,S1,1\nT2,08:15:00,08:15:30,S2,2\nT2,08:21:00,08:21:00,S3,3\n" +
      "T3,08:20:00,08:20:30,S1,1\nT3,08:25:00,08:25:30,S2,2\nT3,08:31:00,08:31:00,S3,3\n" +
      "T4,08:30:00,08:30:30,S1,1\nT4,08:35:00,08:35:30,S2,2\nT4,08:41:00,08:41:00,S3,3\n" +
      "TW1,09:00:00,09:00:30,S1,1\nTW1,09:05:00,09:05:30,S2,2\nTW1,09:11:00,09:11:00,S3,3\n" +
      "B1,08:00:00,08:00:30,S1,1\nB1,08:06:00,08:06:30,S2,2\nB1,08:13:00,08:13:00,S3,3\n"
  };
}

/* Build a minimal ZIP (store, method 0) by hand so the test suite stays
 * dependency free while still exercising readZip with real bytes. */
function buildStoreZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const dataBytes = enc.encode(text);
    const crc = crc32(dataBytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt32LE(dataBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, Buffer.from(nameBytes), Buffer.from(dataBytes));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBytes.length, 20);
    cd.writeUInt32LE(dataBytes.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, Buffer.from(nameBytes));
    offset += 30 + nameBytes.length + dataBytes.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), cdBuf, eocd]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ------------------------------------------------------------------ *
 * Time helpers
 * ------------------------------------------------------------------ */

test("parseGtfsTime parses HH:MM:SS and after-midnight hours", () => {
  assert.equal(E.parseGtfsTime("00:00:00"), 0);
  assert.equal(E.parseGtfsTime("08:05:30"), 8 * 3600 + 5 * 60 + 30);
  assert.equal(E.parseGtfsTime("25:10:00"), 25 * 3600 + 10 * 60);
  assert.equal(E.parseGtfsTime("1:02:03"), 3600 + 2 * 60 + 3);
  assert.ok(Number.isNaN(E.parseGtfsTime("bad")));
  assert.ok(Number.isNaN(E.parseGtfsTime("08:60:00")));
});

test("formatGtfsTime round-trips and preserves hours above 24", () => {
  assert.equal(E.formatGtfsTime(0), "00:00:00");
  assert.equal(E.formatGtfsTime(90600), "25:10:00");
  assert.equal(E.formatGtfsTime(-90), "-00:01:30");
  assert.equal(E.parseGtfsTime(E.formatGtfsTime(86399)), 86399);
});

test("formatDuration produces compact human durations", () => {
  assert.equal(E.formatDuration(0), "0s");
  assert.equal(E.formatDuration(450), "7m 30s");
  assert.equal(E.formatDuration(3600), "60m");
});

/* ------------------------------------------------------------------ *
 * Stats helpers
 * ------------------------------------------------------------------ */

test("describeSample reports full descriptive statistics", () => {
  const s = E.describeSample([1, 2, 3, 4, 5]);
  assert.equal(s.count, 5);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
  assert.equal(s.p50, 3);
  assert.equal(s.stddev.toFixed(3), Math.sqrt(2.5).toFixed(3));
  const empty = E.describeSample([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.mean, 0);
});

test("mean, median, stddev, percentile behave on small samples", () => {
  assert.equal(E.mean([2, 4, 6]), 4);
  assert.equal(E.median([5, 1, 3]), 3);
  assert.equal(E.stddev([2, 2, 2]), 0);
  assert.equal(E.percentile([0, 10, 20, 30, 40], 0.5), 20);
});

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

test("geoDistanceMiles matches a known great-circle distance", () => {
  // Chicago loop to about 0.03 degrees of latitude south, roughly 2.07 miles.
  const d = E.geoDistanceMiles([41.8800, -87.6300], [41.8500, -87.6300]);
  assert.ok(d > 2.0 && d < 2.2, "expected about 2.07 miles, got " + d);
});

test("pointAlong returns endpoints and interpolates midpoints", () => {
  const anchors = [[0, 0], [0, 10], [10, 10]];
  assert.deepEqual(E.pointAlong(anchors, 0), [0, 0]);
  assert.deepEqual(E.pointAlong(anchors, 1), [10, 10]);
  const mid = E.pointAlong(anchors, 0.5);
  assert.ok(mid[0] >= 0 && mid[0] <= 10 && mid[1] >= 0 && mid[1] <= 10);
});

test("interpolateStationCoordinates returns one coordinate per station", () => {
  const coords = E.interpolateStationCoordinates(
    [[41.88, -87.63], [41.81, -87.62]],
    [["A", "A", 0], ["B", "B", 5], ["C", "C", 10]]
  );
  assert.equal(coords.length, 3);
  assert.ok(Math.abs(coords[0][0] - 41.88) < 1e-6);
  assert.ok(Math.abs(coords[2][0] - 41.81) < 1e-6);
});

/* ------------------------------------------------------------------ *
 * CSV parsing
 * ------------------------------------------------------------------ */

test("parseCsv handles quoted commas, escaped quotes, CRLF and BOM", () => {
  const csv = "﻿id,name,note\r\n" +
    '1,"Doe, Jane","said ""hi"""\r\n' +
    "2,Alpha,plain\r\n";
  const rows = E.parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "1");
  assert.equal(rows[0].name, "Doe, Jane");
  assert.equal(rows[0].note, 'said "hi"');
  assert.equal(rows[1].note, "plain");
});

test("parseCsv handles quoted newlines inside fields", () => {
  const rows = E.parseCsv("id,note\n1,\"line one\nline two\"\n2,ok\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, "line one\nline two");
  assert.equal(rows[1].note, "ok");
});

test("splitCsvRow splits a single row correctly", () => {
  assert.deepEqual(E.splitCsvRow('a,"b,c",d'), ["a", "b,c", "d"]);
});

/* ------------------------------------------------------------------ *
 * GTFS calendar resolution
 * ------------------------------------------------------------------ */

test("resolveActiveServices honors weekly calendar patterns", () => {
  const files = makeGtfsFiles();
  // 2026-11-06 is a Friday: WK runs, WE does not.
  assert.deepEqual(Object.keys(E.resolveActiveServices(files, "20261106").active).sort(), ["WE", "WK"]);
});

test("resolveActiveServices honors calendar_dates removal", () => {
  const files = makeGtfsFiles();
  // 2026-11-09 is a Monday, but WK is removed by exception_type=2.
  const r = E.resolveActiveServices(files, "20261109");
  assert.ok(!r.active.WK, "WK should be removed on 20261109");
});

test("resolveActiveServices reports invalid dates", () => {
  const r = E.resolveActiveServices(makeGtfsFiles(), "not-a-date");
  assert.ok(r.error);
});

test("resolveActiveServices falls back to trips.txt with no calendar", () => {
  const files = { "trips.txt": "route_id,service_id,trip_id\nR1,SX,T1\nR1,SY,T2\n" };
  const r = E.resolveActiveServices(files, "20261106");
  assert.deepEqual(Object.keys(r.active).sort(), ["SX", "SY"]);
});

/* ------------------------------------------------------------------ *
 * GTFS static parsing
 * ------------------------------------------------------------------ */

test("parseGtfs builds normalized services per route and direction", async () => {
  const parsed = await E.parseGtfs({ files: makeGtfsFiles(), date: "20261106" });
  assert.equal(parsed.routeCount, 2);
  assert.equal(parsed.services.length, 2);
  const r1 = parsed.services.find((s) => s.routeId === "R1");
  assert.equal(r1.operator, "Demo Metro");
  assert.equal(r1.kind, "metro");
  assert.equal(r1.colorKey, "#DA291C");
  assert.equal(r1.stops.length, 3);
  assert.equal(r1.stops[0].name, "Alpha");
  assert.equal(r1.plannedHeadwaySec, 600);
});

test("parseGtfs computes cumulative miles and dwell from stop_times", async () => {
  const parsed = await E.parseGtfs({ files: makeGtfsFiles(), date: "20261106" });
  const r1 = parsed.services.find((s) => s.routeId === "R1");
  assert.equal(r1.stops[0].miles, 0);
  assert.ok(r1.stops[1].miles > 2.0 && r1.stops[1].miles < 2.2);
  assert.ok(r1.stops[2].miles > r1.stops[1].miles);
  assert.equal(r1.stops[0].dwellSec, 30);
  assert.equal(r1.stops[2].dwellSec, 0);
});

test("parseGtfs filters trips to the active service date", async () => {
  const files = makeGtfsFiles();
  // Only TW1 (service WE) runs on this Saturday 2026-11-07... but WE is a
  // weekend service; use a Monday where WK was removed to force the fallback.
  const p = await E.parseGtfs({ files, date: "20261106" });
  const r1 = p.services.find((s) => s.routeId === "R1");
  const tripIds = r1.trips.map((t) => t.tripId);
  assert.ok(tripIds.includes("T1"));
  assert.ok(tripIds.includes("TW1")); // WE added by exception on this date
  assert.ok(!tripIds.includes("B1")); // belongs to R2
});

test("parseGtfs reports missing required files", async () => {
  await assert.rejects(
    () => E.parseGtfs({ files: { "routes.txt": "route_id\nR1\n" } }),
    /missing required files/
  );
});

test("parseGtfs accepts a routeId filter and maxServices", async () => {
  const parsed = await E.parseGtfs({ files: makeGtfsFiles(), date: "20261106", routeId: "R2", maxServices: 1 });
  assert.equal(parsed.services.length, 1);
  assert.equal(parsed.services[0].routeId, "R2");
});

test("dominantDirection picks the direction with the most trips", () => {
  const trips = [
    { direction_id: "0" }, { direction_id: "1" }, { direction_id: "1" }, { direction_id: "0" }
  ];
  assert.equal(E.dominantDirection(trips), "1");
});

/* ------------------------------------------------------------------ *
 * ZIP reader
 * ------------------------------------------------------------------ */

test("readZip extracts stored (method 0) GTFS files", async () => {
  const buf = buildStoreZip({
    "routes.txt": "route_id,route_short_name\nR1,RL\n",
    "nested/stops.txt": "stop_id,stop_name\nS1,Alpha\n"
  });
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const files = await E.readZip(ab);
  assert.ok(files["routes.txt"].includes("R1,RL"));
  assert.ok(files["stops.txt"].includes("Alpha"), "folder prefix should be stripped");
});

test("readFeedFiles parses a full GTFS zip into services", async () => {
  const gtfs = makeGtfsFiles();
  const buf = buildStoreZip(gtfs);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const parsed = await E.parseGtfs({ files: ab, date: "20261106" });
  assert.equal(parsed.services.length, 2);
  assert.equal(parsed.services[0].stops.length, 3);
});

test("readFeedFiles handles a deflate-compressed zip via DecompressionStream", async () => {
  // Build a one-entry deflate (method 8) zip using Node zlib for raw deflate.
  const enc = new TextEncoder();
  const name = "routes.txt";
  const text = "route_id,route_short_name\nR1,RL\n";
  const nameBytes = enc.encode(name);
  const dataBytes = enc.encode(text);
  const comp = zlib.deflateRawSync(Buffer.from(dataBytes));
  const crc = crc32(dataBytes);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(dataBytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const body = Buffer.concat([local, Buffer.from(nameBytes), comp]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(dataBytes.length, 24);
  cd.writeUInt16LE(nameBytes.length, 28);
  cd.writeUInt32LE(0, 42);
  const central = Buffer.concat([cd, Buffer.from(nameBytes)]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(body.length, 16);

  const buf = Buffer.concat([body, central, eocd]);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const files = await E.readZip(ab);
  assert.equal(files["routes.txt"], text);
});

/* ------------------------------------------------------------------ *
 * Synthetic timetable builder
 * ------------------------------------------------------------------ */

test("listCorridors returns the seven preloaded corridors", () => {
  const list = E.listCorridors();
  assert.equal(list.length, 7);
  assert.ok(list.some((c) => c.id === "nec"));
  assert.ok(list.every((c) => c.stationCount > 0));
});

test("buildSyntheticService generates regular-interval trips", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  assert.equal(svc.stops.length, 3);
  assert.equal(svc.trips.length, Math.floor((10 * 3600 - 6 * 3600) / 600) + 1);
  assert.equal(svc.trips[1].startTime - svc.trips[0].startTime, 600);
  assert.equal(svc.plannedHeadwaySec, 600);
});

test("buildSyntheticService produces monotonically increasing times and miles", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  for (const trip of svc.trips) {
    for (let i = 1; i < trip.stopTimes.length; i++) {
      assert.ok(trip.stopTimes[i].arrivalSec >= trip.stopTimes[i - 1].departureSec);
      assert.ok(trip.stopTimes[i].miles >= trip.stopTimes[i - 1].miles);
    }
  }
});

test("buildSyntheticService assigns interpolated coordinates", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  assert.ok(svc.stops[0].lat !== svc.stops[svc.stops.length - 1].lat);
  assert.ok(E.geoDistanceMiles([svc.stops[0].lat, svc.stops[0].lon],
    [svc.stops[2].lat, svc.stops[2].lon]) > 0);
});

test("buildAllSyntheticServices builds every corridor", () => {
  const services = E.buildAllSyntheticServices();
  assert.equal(services.length, CORRIDORS.length);
  assert.ok(services.every((s) => s.trips.length > 0 && s.stops.length > 0));
});

/* ------------------------------------------------------------------ *
 * Realtime layer
 * ------------------------------------------------------------------ */

test("simulateObserved is deterministic for a fixed seed", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const a = E.simulateObserved(svc, { seed: 42 });
  const b = E.simulateObserved(svc, { seed: 42 });
  assert.deepEqual(a, b);
  const c = E.simulateObserved(svc, { seed: 7 });
  assert.notDeepEqual(a, c);
});

test("withObserved returns a new service with the observed layer", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const obs = E.simulateObserved(svc);
  const svc2 = E.withObserved(svc, obs);
  assert.equal(svc.observedTrips, null);
  assert.equal(svc2.observedTrips.length, obs.length);
});

test("applyRealtime applies per-stop delays to scheduled trips", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const first = svc.trips[0];
  const updates = [{
    tripId: first.tripId,
    stopId: first.stopTimes[0].stopId,
    arrivalDelaySec: 120,
    departureDelaySec: 120
  }];
  const obs = E.applyRealtime(svc, updates);
  assert.equal(
    obs[0].stopTimes[0].arrivalSec - first.stopTimes[0].arrivalSec,
    120
  );
  // Untouched stops remain on schedule.
  assert.equal(
    obs[0].stopTimes[1].arrivalSec,
    first.stopTimes[1].arrivalSec
  );
});

/* ------------------------------------------------------------------ *
 * Headway analysis
 * ------------------------------------------------------------------ */

test("analyzeHeadways recovers the planned headway of a regular timetable", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const hw = E.analyzeHeadways(svc);
  assert.equal(hw.layer, "scheduled");
  assert.ok(Math.abs(hw.overall.mean - 600) < 1);
  assert.ok(hw.overall.stddev < 1);
  assert.equal(hw.perStop.length, 3);
  assert.ok(hw.timeOfDay.length > 0);
  assert.equal(hw.histogram.length, 12);
});

test("analyzeHeadways measures inflated variance for a disrupted layer", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const observed = E.withObserved(svc, E.simulateObserved(svc, { seed: 5, intensity: 1.5 }));
  const clean = E.analyzeHeadways(svc);
  const disrupted = E.analyzeHeadways(observed);
  assert.ok(disrupted.overall.stddev > clean.overall.stddev);
});

/* ------------------------------------------------------------------ *
 * Bunching analysis
 * ------------------------------------------------------------------ */

test("analyzeBunching finds no bunching in a perfectly regular timetable", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const b = E.analyzeBunching(svc);
  assert.equal(b.bunchCount, 0);
  assert.equal(b.bunchRate, 0);
  assert.equal(b.gapCount, 0);
});

test("analyzeBunching detects a deliberately bunched pair", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  // Force one trip to arrive right after its leader at every stop.
  const obs = svc.trips.map((t) => ({
    tripId: t.tripId, routeId: t.routeId, headsign: t.headsign,
    direction: t.direction, serviceId: t.serviceId,
    startTime: t.startTime,
    stopTimes: t.stopTimes.map((st) => Object.assign({}, st))
  }));
  const prev = obs[1].stopTimes.map((st) => st.arrivalSec);
  obs[1].stopTimes.forEach((st, i) => {
    st.arrivalSec = prev[i] ? prev[i] - 600 + 30 : st.arrivalSec;
  });
  // Rebuild by shifting whole trip 2 to 30s after trip 1.
  obs[1].stopTimes.forEach((st, i) => {
    const base = svc.trips[0].stopTimes[i];
    st.arrivalSec = base.arrivalSec + 30;
    st.departureSec = base.departureSec + 30;
  });
  const observed = E.withObserved(svc, obs);
  const b = E.analyzeBunching(observed);
  assert.ok(b.bunchCount > 0, "expected a bunching event");
  assert.ok(b.bunchEvents.some((e) => e.type === "bunch"));
});

test("analyzeBunching reports excess wait time and per-stop rates", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const observed = E.withObserved(svc, E.simulateObserved(svc, { seed: 3 }));
  const b = E.analyzeBunching(observed);
  assert.ok(b.excessWaitSec >= 0);
  assert.equal(b.perStop.length, 3);
  assert.ok(b.perStop.every((p) => p.bunchRate >= 0 && p.bunchRate <= 1));
});

/* ------------------------------------------------------------------ *
 * Stringline
 * ------------------------------------------------------------------ */

test("buildStringline produces one polyline per trip with a distance axis", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const sl = E.buildStringline(svc);
  assert.equal(sl.lines.length, svc.trips.length);
  assert.equal(sl.lines[0].points.length, 3);
  assert.equal(sl.milesDomain[0], 0);
  assert.ok(sl.milesDomain[1] > 0);
  assert.ok(sl.timeDomain[1] > sl.timeDomain[0]);
  assert.equal(sl.stops.length, 3);
});

test("buildStringline includes scheduled ghost lines for observed layers", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const observed = E.withObserved(svc, E.simulateObserved(svc));
  const sl = E.buildStringline(observed, { includeScheduled: true, maxTrips: 5 });
  assert.equal(sl.lines.length, 5);
  assert.ok(sl.scheduledLines);
  assert.equal(sl.scheduledLines.length, svc.trips.length);
});

/* ------------------------------------------------------------------ *
 * Dwell analysis
 * ------------------------------------------------------------------ */

test("analyzeDwell recovers planned dwell times from a clean timetable", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const d = E.analyzeDwell(svc);
  assert.equal(d.perStop[0].stats.mean, 30);
  assert.equal(d.perStop[2].stats.mean, 60);
  assert.equal(d.perStop[0].plannedDwellSec, 30);
  assert.ok(Math.abs(d.perStop[0].meanDeltaSec) < 1);
});

/* ------------------------------------------------------------------ *
 * Delay analysis
 * ------------------------------------------------------------------ */

test("analyzeDelay reports near-perfect on-time performance with no disruption", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const d = E.analyzeDelay(svc);
  assert.equal(d.onTimeRate, 1);
  assert.ok(Math.abs(d.overall.mean) < 1);
});

test("analyzeDelay detects injected delay", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const observed = svc.trips.map((t) => ({
    tripId: t.tripId, routeId: t.routeId, headsign: t.headsign,
    direction: t.direction, serviceId: t.serviceId, startTime: t.startTime,
    stopTimes: t.stopTimes.map((st) => Object.assign({}, st, {
      arrivalSec: st.arrivalSec + 300,
      departureSec: st.departureSec + 300
    }))
  }));
  const d = E.analyzeDelay(E.withObserved(svc, observed), { onTimeThresholdSec: 180 });
  assert.equal(d.overall.mean, 300);
  assert.equal(d.onTimeRate, 0);
  assert.ok(d.hasBaseline);
});

/* ------------------------------------------------------------------ *
 * Combined report
 * ------------------------------------------------------------------ */

test("buildReport returns grades, score and every analyzer section", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const rep = E.buildReport(svc);
  assert.ok(rep.grades.headway && rep.grades.bunching && rep.grades.punctuality && rep.grades.dwell);
  assert.ok(rep.score >= 0 && rep.score <= 100);
  assert.ok(rep.headways && rep.bunching && rep.dwell && rep.delay && rep.stringline);
  assert.equal(rep.service.stopCount, 3);
  assert.equal(rep.service.tripCount, svc.trips.length);
});

test("buildReport reflects observed data when present", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const observed = E.withObserved(svc, E.simulateObserved(svc, { seed: 11 }));
  const rep = E.buildReport(observed);
  assert.equal(rep.service.hasObserved, true);
  assert.ok(rep.stringline.scheduledLines !== null);
});

/* ------------------------------------------------------------------ *
 * Real corridor integration
 * ------------------------------------------------------------------ */

test("every preloaded corridor produces a finite, well-formed report", () => {
  const services = E.buildAllSyntheticServices();
  for (const svc of services) {
    const rep = E.buildReport(svc);
    assert.ok(Number.isFinite(rep.headways.overall.mean), svc.id + " headway mean");
    assert.ok(Number.isFinite(rep.bunching.excessWaitSec), svc.id + " EWT");
    assert.ok(rep.stringline.lines.length > 0, svc.id + " stringline");
    assert.ok(svc.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), svc.id + " coords");
  }
});
