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
  assert.equal(E.formatGtfsTime(-90), "");
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
  const offset = E.interpolateStationCoordinates([[41.88, -87.63], [41.81, -87.62]], [["A", "A", 20], ["B", "B", 30]]);
  assert.equal(offset[0][0], 41.88); assert.equal(offset[1][0], 41.81);
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

test("readFeedFiles handles a deflate-compressed zip with the portable decoder", async () => {
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
  // A reported delay propagates until another update can safely supersede it.
  assert.equal(
    obs[0].stopTimes[1].arrivalSec,
    first.stopTimes[1].arrivalSec + 120
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
  assert.equal(sl.lines[0].points.length, 6);
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
  assert.equal(sl.scheduledLines.length, 5);
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

/* Regression cases for service-day integrity, archive validation and the
 * shared-platform cascade. All reference quantities are derived in the test. */
function singleEntryZip(text, options = {}) {
  const name = options.name || "routes.txt", nameBytes = Buffer.from(name), raw = Buffer.from(text);
  const method = options.method ?? 8;
  const compressed = method === 0 ? raw : zlib.deflateRawSync(raw, options.deflate || {});
  const local = Buffer.alloc(30), cd = Buffer.alloc(46), end = Buffer.alloc(22);
  const flags = options.descriptor ? 8 : 0, crc = crc32(raw);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(options.descriptor ? 0 : crc, 14); local.writeUInt32LE(options.descriptor ? 0 : compressed.length, 18); local.writeUInt32LE(options.descriptor ? 0 : raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const descriptor = options.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
  if (options.descriptor) { descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(raw.length, 12); }
  const body = Buffer.concat([local, nameBytes, compressed, descriptor]);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBytes.length, 28);
  const central = Buffer.concat([cd, nameBytes]);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, end]);
}
function ab(buffer) { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); }
function centralOffset(buffer) { return buffer.readUInt32LE(buffer.length - 22 + 16); }

test("calendar rejects impossible Gregorian dates and accepts leap day", () => {
  for (const date of ["20260229", "20261301", "20260431", "20260001", "20261100"]) assert.ok(E.resolveActiveServices(makeGtfsFiles(), date).error, date);
  assert.equal(E.resolveActiveServices(makeGtfsFiles(), "20240229").error, null);
});
test("removed service days stay empty through the full GTFS parser", async () => {
  const parsed = await E.parseGtfs({ files: makeGtfsFiles(), date: "20261109" });
  assert.equal(parsed.services.length, 0); assert.equal(parsed.activeServiceCount, 0);
  assert.match(parsed.warnings.join(" "), /No usable trips/);
});
test("calendar_dates-only feeds do not reactivate service on other dates", async () => {
  const files = makeGtfsFiles(); delete files["calendar.txt"];
  files["calendar_dates.txt"] = "service_id,date,exception_type\nWK,20261106,1\n";
  assert.equal((await E.parseGtfs({ files, date: "20261107" })).services.length, 0);
});
test("invalid explicit dates and service limits reject instead of falling back", async () => {
  await assert.rejects(E.parseGtfs({ files: makeGtfsFiles(), date: "20260230" }), /Invalid service date/);
  await assert.rejects(E.parseGtfs({ files: makeGtfsFiles(), maxServices: -1 }), /maxServices/);
});
test("auto date examines a complete calendar week and weights trip counts", async () => {
  const files = makeGtfsFiles(); delete files["calendar_dates.txt"];
  files["calendar.txt"] = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,0,0,0,0,0,0,20261101,20261130\nWE,0,0,0,0,0,1,1,20261101,20261130\n";
  const parsed = await E.parseGtfs({ files }); assert.equal(parsed.date, "20261102");
  files["calendar_dates.txt"] = "service_id,date,exception_type\nWK,20261102,2\n";
  assert.equal((await E.parseGtfs({ files })).date, "20261109");
});
test("CSV rejects malformed quotes, duplicate headers and surplus fields", () => {
  for (const csv of ['id,name\n1,"missing\n', 'id,name\n1,"closed"extra\n', 'id,name\n1,un"quoted\n', 'id,id\n1,2\n', 'id,name\n1,2,3\n']) assert.throws(() => E.parseCsv(csv), /Invalid CSV/);
  assert.throws(() => E.splitCsvRow('a,"broken'), /unterminated/);
  assert.throws(() => E.splitCsvRow('a,"closed"extra'), /Invalid CSV/);
});
test("untrusted CSV and GTFS identifiers cannot overwrite object prototypes", async () => {
  const rows = E.parseCsv("__proto__,constructor\ntext,value\n");
  assert.equal(rows[0].__proto__, "text"); assert.equal(Object.getPrototypeOf(rows[0]), null);
  const files = makeGtfsFiles(); files["trips.txt"] = files["trips.txt"].replaceAll("T1", "__proto__"); files["stop_times.txt"] = files["stop_times.txt"].replaceAll("T1", "__proto__");
  const service = (await E.parseGtfs({ files, date: "20261106" })).services[0];
  assert.ok(service.trips.some(t => t.tripId === "__proto__"));
  assert.ok(E.verifyService(service).passed);
  const special = E.buildSyntheticService(makeCorridor({ stations: [["B|C", "First", 0, 30], ["C", "Last", 2, 30]] }));
  special.stops.forEach((st, i) => { st.id = i ? "C" : "B|C"; });
  special.stopIndex = Object.fromEntries(special.stops.map(st => [st.id, st]));
  special.trips = special.trips.slice(0, 2);
  special.trips.forEach((t, i) => { t.tripId = i ? "A|B" : "A"; t.stopTimes.forEach((st, j) => { st.stopId = special.stops[j].id; }); });
  assert.equal(E.analyzeDelay(special).overall.mean, 0);
});
test("duplicate GTFS entity ids reject ambiguous feeds", async () => {
  const files = makeGtfsFiles(); files["stops.txt"] += "S1,004,Duplicate,41.8,-87.6\n";
  await assert.rejects(E.parseGtfs({ files }), /duplicate stop_id/);
});
test("opposite directions and branch stop patterns get coherent services", async () => {
  const files = makeGtfsFiles();
  files["trips.txt"] += "R1,WK,IN,Alpha,1\nR1,WK,EXP,Charlie,0\n";
  files["stop_times.txt"] += "IN,08:00:00,08:00:30,S3,1\nIN,08:10:00,08:10:00,S1,2\nEXP,09:00:00,09:00:30,S1,1\nEXP,09:10:00,09:10:00,S3,2\n";
  const services = (await E.parseGtfs({ files, date: "20261106" })).services.filter(s => s.routeId === "R1");
  assert.equal(services.length, 3);
  assert.ok(services.some(s => s.directionLabel.startsWith("Direction 1")));
  assert.ok(services.every(s => s.stops.at(-1).miles > 0 && E.verifyService(s).passed));
});
test("loop trips retain each distinct visit on a cumulative distance axis", async () => {
  const files = makeGtfsFiles(); files["trips.txt"] += "R1,WK,LOOP,Alpha,0\n";
  files["stop_times.txt"] += "LOOP,10:00:00,10:00:30,S1,1\nLOOP,10:05:00,10:05:30,S2,2\nLOOP,10:10:00,10:10:00,S1,3\n";
  const service = (await E.parseGtfs({ files, date: "20261106" })).services.find(s => s.trips[0].tripId === "LOOP");
  assert.equal(service.stops.length, 3); assert.notEqual(service.stops[0].id, service.stops[2].id);
  assert.equal(service.stops[0].gtfsStopId, service.stops[2].gtfsStopId); assert.ok(service.stops[2].miles > service.stops[1].miles);
  assert.equal(E.analyzeHeadways(service).perStop.length, 3);
});
test("unitless shape distances cannot silently change miles", async () => {
  const files = makeGtfsFiles();
  files["stop_times.txt"] = files["stop_times.txt"].split("\n").map((line, i) => line ? line + (i === 0 ? ",shape_dist_traveled" : "," + ((i % 3) * 9999 + 5000)) : "").join("\n");
  const svc = (await E.parseGtfs({ files, date: "20261106" })).services[0];
  assert.equal(svc.stops[0].miles, 0); assert.ok(svc.stops[1].miles > 2 && svc.stops[1].miles < 2.2);
  assert.equal(svc.distanceSource, "cumulative haversine estimate");
});
test("blank interior times interpolate between timed endpoints, never midnight", async () => {
  const files = makeGtfsFiles(); files["stop_times.txt"] = files["stop_times.txt"].replace("T1,08:05:00,08:05:30,S2,2", "T1,,,S2,2");
  const svc = (await E.parseGtfs({ files, date: "20261106" })).services[0], st = svc.trips[0].stopTimes;
  assert.ok(st[1].arrivalSec > st[0].departureSec && st[1].arrivalSec < st[2].arrivalSec);
  assert.equal(st[1].arrivalSec, st[1].departureSec);
});
test("invalid or untimed endpoint trips produce warnings and are skipped", async () => {
  const files = makeGtfsFiles(); files["stop_times.txt"] = files["stop_times.txt"].replace("T1,08:00:00,08:00:30", "T1,,").replace("T2,08:15:00,08:15:30", "T2,08:99:00,08:15:30");
  const p = await E.parseGtfs({ files, date: "20261106" });
  assert.ok(!p.services[0].trips.some(t => ["T1", "T2"].includes(t.tripId))); assert.equal(p.warnings.filter(w => w.startsWith("Skipping trip")).length, 2);
});
test("reverse times, unknown stops and duplicate sequence values are diagnosed", async () => {
  for (const replacement of ["T1,08:05:00,08:04:00,S2,2", "T1,08:05:00,08:05:30,UNKNOWN,2", "T1,08:05:00,08:05:30,S2,1"]) {
    const files = makeGtfsFiles(); files["stop_times.txt"] = files["stop_times.txt"].replace("T1,08:05:00,08:05:30,S2,2", replacement);
    const p = await E.parseGtfs({ files, date: "20261106" }); assert.ok(p.warnings.some(w => w.startsWith("Skipping trip T1:")));
  }
});
test("ZIP extracts empty stored files and data descriptor archives", async () => {
  assert.equal((await E.readZip(ab(singleEntryZip("", { method: 0 }))))["routes.txt"], "");
  assert.equal((await E.readZip(ab(singleEntryZip("route_id\nR1\n", { descriptor: true }))))["routes.txt"], "route_id\nR1\n");
});
test("portable DEFLATE handles stored, fixed and dynamic blocks with Unicode", async () => {
  const text = Array.from({ length: 10000 }, (_, i) => "station," + (i % 29) + ",\u00e9\u8eca\n").join("");
  for (const options of [{ level: 0 }, { strategy: zlib.constants.Z_FIXED }, { level: 9 }]) assert.equal((await E.readZip(ab(singleEntryZip(text, { deflate: options }))))["routes.txt"], text);
});
test("ZIP corruption is detected with CRC32 before text reaches the parser", async () => {
  const zip = singleEntryZip("route_id\nR1\n", { method: 0 }); zip[40] ^= 1;
  await assert.rejects(E.readZip(ab(zip)), /CRC32 mismatch/);
});
test("ZIP rejects missing central directories, bad offsets and truncation", async () => {
  await assert.rejects(E.readZip(new ArrayBuffer(0)), /Invalid ZIP/);
  const zip = singleEntryZip("route_id\nR1\n", { method: 0 }); zip.writeUInt32LE(999999, zip.length - 6);
  await assert.rejects(E.readZip(ab(zip)), /out-of-bounds/);
  const short = singleEntryZip("route_id\nR1\n").subarray(0, 20);
  await assert.rejects(E.readZip(ab(short)), /Invalid ZIP/);
});
test("ZIP refuses duplicate basenames, encryption and unsupported compression", async () => {
  await assert.rejects(E.readZip(ab(buildStoreZip({ "a/routes.txt": "a", "b/routes.txt": "b" }))), /duplicate filename/);
  const encrypted = singleEntryZip("data", { method: 0 }); encrypted.writeUInt16LE(1, centralOffset(encrypted) + 8);
  await assert.rejects(E.readZip(ab(encrypted)), /encrypted/);
  const unsupported = singleEntryZip("data", { method: 0 }); unsupported.writeUInt16LE(99, centralOffset(unsupported) + 10);
  await assert.rejects(E.readZip(ab(unsupported)), /compression method 99/);
});
test("ZIP rejects expansion limits and local filename mismatches", async () => {
  const huge = singleEntryZip("data"); huge.writeUInt32LE(128 * 1024 * 1024 + 1, centralOffset(huge) + 24);
  await assert.rejects(E.readZip(ab(huge)), /expanded limit/);
  const name = singleEntryZip("data", { method: 0 }); name[30] = 120;
  await assert.rejects(E.readZip(ab(name)), /filename mismatch/);
});
test("readFeedFiles respects a typed array's actual byte offset and length", async () => {
  const zip = singleEntryZip("route_id\nR1\n", { descriptor: true }), padded = Buffer.concat([Buffer.from("prefix"), zip, Buffer.from("suffix")]);
  const view = padded.subarray(6, 6 + zip.length);
  assert.equal((await E.readFeedFiles(view))["routes.txt"], "route_id\nR1\n");
});
test("synthetic builders reject invalid numeric inputs and bound trip allocation", () => {
  for (const options of [{ headwaySec: 0 }, { headwaySec: -1 }, { startSec: 10, endSec: 9 }, { headwaySec: 0.01 }]) assert.throws(() => E.buildSyntheticService(makeCorridor(), options), /Invalid synthetic|trip limit/);
  assert.throws(() => E.buildSyntheticService(makeCorridor({ stations: [] })), /at least one station/);
  assert.throws(() => E.buildSyntheticService(makeCorridor({ speedMph: -1 })), /Invalid synthetic/);
});
test("zero disruption is exact and nonzero simulation preserves scheduled run minima", () => {
  const svc = E.buildSyntheticService(makeCorridor({ startSec: 0, endSec: 3600 }));
  assert.deepEqual(E.simulateObserved(svc, { intensity: 0 }), svc.trips);
  for (const t of E.simulateObserved(svc, { seed: 42, intensity: 2.8 })) for (let i = 1; i < t.stopTimes.length; i++) assert.ok(t.stopTimes[i].arrivalSec >= t.stopTimes[i - 1].departureSec);
  assert.throws(() => E.simulateObserved(svc, { intensity: NaN }), /intensity/);
});
test("realtime absolute times win while impossible departures stay monotone", () => {
  const svc = E.buildSyntheticService(makeCorridor()), first = svc.trips[0].stopTimes[0];
  const obs = E.applyRealtime(svc, [{ tripId: svc.trips[0].tripId, stopId: first.stopId, arrivalSec: first.arrivalSec + 100, arrivalDelaySec: 9999, departureSec: first.arrivalSec - 10 }]);
  assert.equal(obs[0].stopTimes[0].arrivalSec, first.arrivalSec + 100);
  assert.equal(obs[0].stopTimes[0].departureSec, first.arrivalSec + 100);
  assert.ok(E.verifyService(E.withObserved(svc, obs)).passed);
});
test("excess wait uses the population variance of the measured finite headways", () => {
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] }));
  svc.trips = [0, 60, 240].map((time, i) => ({ tripId: "W" + i, stopTimes: [{ stopId: svc.stops[0].id, arrivalSec: time, departureSec: time, miles: 0 }], startTime: time }));
  svc.plannedHeadwaySec = 120;
  assert.equal(E.populationVariance([60, 180]), 3600);
  assert.equal(E.analyzeHeadways(svc).excessWaitSec, 15);
  assert.equal(E.analyzeBunching(svc).excessWaitSec, 15);
});
test("after-midnight headway buckets retain their service-day hours", () => {
  const svc = E.buildSyntheticService(makeCorridor({ startSec: 24 * 3600, endSec: 26 * 3600 }));
  const labels = E.analyzeHeadways(svc).timeOfDay.map(d => d.label);
  assert.ok(labels.includes("25:00:00")); assert.ok(!labels.includes("01:00:00"));
});
test("headway and stringline option validation rejects invalid dimensions", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  assert.throws(() => E.analyzeHeadways(svc, { histogramBins: 0 }), /Invalid headway/);
  assert.throws(() => E.analyzeHeadways(svc, { timeBucketSec: 0 }), /Invalid headway/);
  assert.throws(() => E.analyzeBunching(svc, { bunchingThreshold: -1 }), /Invalid bunching/);
  assert.throws(() => E.buildStringline(svc, { timeRange: [10, 9] }), /Invalid stringline/);
});
test("scheduled report options consistently choose the scheduled layer", () => {
  const svc = E.buildSyntheticService(makeCorridor()), observed = E.withObserved(svc, E.simulateObserved(svc, { seed: 3, intensity: 2.8 }));
  const report = E.buildReport(observed, { layer: "scheduled" });
  assert.equal(report.delay.overall.mean, 0); assert.equal(report.headways.overall.cv, 0);
  assert.equal(report.stringline.layer, "scheduled"); assert.equal(report.stringline.scheduledLines, null);
  assert.equal(report.score, 100);
});
test("large early departures fail a symmetric on-time tolerance", () => {
  const svc = E.buildSyntheticService(makeCorridor()), obs = svc.trips.map(t => ({ ...t, stopTimes: t.stopTimes.map(st => ({ ...st, arrivalSec: st.arrivalSec - 300, departureSec: st.departureSec - 300 })) }));
  assert.equal(E.analyzeDelay(E.withObserved(svc, obs)).onTimeRate, 0);
});
test("unknown realtime trips are excluded from matched delay denominators", () => {
  const svc = E.buildSyntheticService(makeCorridor()), extra = { ...svc.trips[0], tripId: "UNKNOWN" };
  const delay = E.analyzeDelay(E.withObserved(svc, [...svc.trips, extra]));
  assert.equal(delay.unmatchedObservations, 3); assert.equal(delay.totalObservations, svc.trips.length * 3); assert.equal(delay.onTimeRate, 1);
});
test("Marey points show dwell and ghost limits match the selected train ids", () => {
  const svc = E.buildSyntheticService(makeCorridor()), obs = E.withObserved(svc, E.simulateObserved(svc));
  const sl = E.buildStringline(obs, { includeScheduled: true, maxTrips: 3 });
  assert.equal(sl.lines[0].points[0].miles, sl.lines[0].points[1].miles);
  assert.equal(sl.lines[0].points[1].timeSec - sl.lines[0].points[0].timeSec, obs.observedTrips[0].stopTimes[0].departureSec - obs.observedTrips[0].stopTimes[0].arrivalSec);
  assert.deepEqual(sl.lines.map(l => l.tripId), sl.scheduledLines.map(l => l.tripId));
  for (const line of [...sl.lines, ...sl.scheduledLines]) for (const p of line.points) assert.ok(p.timeSec >= sl.timeDomain[0] && p.timeSec <= sl.timeDomain[1]);
});
test("Marey window filtering and empty service domains stay finite", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const sl = E.buildStringline(svc, { timeRange: [7 * 3600, 7.5 * 3600] });
  assert.deepEqual(sl.timeDomain, [7 * 3600, 7.5 * 3600]);
  assert.ok(sl.lines.every(l => l.points.at(-1).timeSec >= 7 * 3600 && l.points[0].timeSec <= 7.5 * 3600));
  const empty = E.buildStringline({ ...svc, trips: [] }); assert.deepEqual(empty.timeDomain, [0, 1]);
});
test("clean schedules score consistently even when station dwell baselines vary", () => {
  for (const svc of E.buildAllSyntheticServices()) assert.equal(E.buildReport(svc).score, 100, svc.id);
});
test("unplanned dwell is measured when the scheduled baseline is zero", () => {
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] })), obs = svc.trips.map(t => ({ ...t, stopTimes: t.stopTimes.map(st => ({ ...st, departureSec: st.arrivalSec + 30 })) }));
  assert.equal(E.analyzeDwell(E.withObserved(svc, obs)).perStop[0].meanDeltaSec, 30);
  svc.trips[0].stopTimes[0].departureSec += 50;
  const subset = E.withObserved(svc, [svc.trips[0]]);
  assert.equal(E.analyzeDwell(subset).perStop[0].meanDeltaSec, 0);
});
test("incident cascade preserves shared-platform clearance and all journey order", () => {
  const svc = E.buildSyntheticService(CORRIDORS.find(c => c.id === "cta-red"), { startSec: 7 * 3600, endSec: 9 * 3600 });
  const original = JSON.stringify(svc), run = E.simulateCascade(svc, { incidentSec: 900 });
  assert.equal(JSON.stringify(svc), original); assert.ok(run.delayedTrips > 1);
  assert.equal(run.maxDelaySec, 900);
  for (let t = 1; t < run.observedTrips.length; t++) for (let i = 0; i < svc.stops.length; i++) assert.ok(run.observedTrips[t].stopTimes[i].arrivalSec >= run.observedTrips[t - 1].stopTimes[i].departureSec + 45);
  assert.ok(E.verifyService(E.withObserved(svc, run.observedTrips)).passed);
});
test("station holds reduce wait variance with an explicit added delay cost", () => {
  const svc = E.buildSyntheticService(CORRIDORS.find(c => c.id === "cta-red"), { startSec: 7 * 3600, endSec: 9 * 3600 });
  const unregulated = E.simulateCascade(svc), regulated = E.simulateCascade(svc, { regulate: true });
  const a = E.buildReport(E.withObserved(svc, unregulated.observedTrips)), b = E.buildReport(E.withObserved(svc, regulated.observedTrips));
  assert.ok(b.headways.excessWaitSec < a.headways.excessWaitSec);
  assert.ok(b.bunching.bunchRate < a.bunching.bunchRate); assert.ok(regulated.holdSec > 0);
  assert.ok(regulated.totalTerminalDelaySec > unregulated.totalTerminalDelaySec);
  assert.ok(b.verification.passed);
});
test("cascade is deterministic, validates options and recovers a zero-incident baseline", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  assert.deepEqual(E.simulateCascade(svc), E.simulateCascade(svc));
  assert.deepEqual(E.simulateCascade(svc, { incidentSec: 0 }).observedTrips, svc.trips);
  assert.throws(() => E.simulateCascade(svc, { incidentTripIndex: -1 }), /Invalid incident/);
  assert.throws(() => E.simulateCascade(svc, { incidentSec: Infinity }), /Invalid incident/);
});
test("verification counts actual timestamps and reports invalid journeys", () => {
  const svc = E.buildSyntheticService(makeCorridor()), check = E.verifyService(svc);
  assert.ok(check.passed); assert.equal(check.roundTrips, svc.trips.length * svc.stops.length * 2);
  const invalid = { ...svc, trips: [{ tripId: "BAD", stopTimes: [{ stopId: "missing", arrivalSec: NaN, departureSec: -1, miles: -2 }] }] };
  assert.equal(E.verifyService(invalid).passed, false); assert.equal(E.verifyService({ ...svc, trips: [] }).passed, false);
});

test("loose CSV aliases and nested feed maps normalize to GTFS filenames", async () => {
  const files = makeGtfsFiles(), aliases = Object.fromEntries(Object.entries(files).map(([name, text]) => ["bundle/" + name.replace(".txt", ".csv").toUpperCase(), text]));
  assert.equal((await E.parseGtfs({ files: aliases, date: "20261106" })).services.length, 2);
  assert.ok((await E.readFeedFiles(files["stop_times.txt"]))["stop_times.txt"]);
  await assert.rejects(E.readFeedFiles({ "routes.txt": "a", "ROUTES.csv": "b" }), /Duplicate GTFS filename/);
});
test("regulated station holds extend preceding station departure and dwell without inflating hold running time", () => {
  const svc = E.buildSyntheticService(CORRIDORS.find(c => c.id === "cta-red"), { startSec: 7 * 3600, endSec: 9 * 3600 });
  const reg = E.simulateCascade(svc, { incidentSec: 900, regulate: true });
  let dwellAdded = 0;
  reg.observedTrips.forEach((trip, tIdx) => {
    const sched = svc.trips[tIdx];
    trip.stopTimes.forEach((st, i) => {
      dwellAdded += (st.departureSec - st.arrivalSec) - (sched.stopTimes[i].departureSec - sched.stopTimes[i].arrivalSec);
    });
  });
  assert.equal(reg.holdSec, 1685);
  assert.equal(dwellAdded, 900 + reg.holdSec);
});
test("blank stop_sequence is rejected rather than coerced to zero", async () => {
  const files = makeGtfsFiles();
  files["stop_times.txt"] = files["stop_times.txt"].replace(",1\n", ",\n");
  const parsed = await E.parseGtfs({ files, date: "20261106" });
  assert.ok(parsed.warnings.some(w => /invalid stop_sequence/.test(w)), String(parsed.warnings));
  const allBlank = makeGtfsFiles();
  allBlank["stop_times.txt"] = allBlank["stop_times.txt"].replace(/,1\n/g, ",\n");
  const none = await E.parseGtfs({ files: allBlank, date: "20261106" });
  assert.equal(none.services.length, 0);
  assert.ok(none.warnings.some(w => /invalid stop_sequence/.test(w)), String(none.warnings));
});


test("populationVariance and mean tolerate empty or non-finite input", () => {
  assert.equal(E.populationVariance(null), 0);
  assert.equal(E.populationVariance([]), 0);
  assert.equal(E.populationVariance([NaN, Infinity]), 0);
  assert.equal(E.populationVariance([60, 180]), 3600);
  assert.equal(E.mean(null), 0);
  assert.equal(E.stddev(null), 0);
});

test("verifyService flags journeys whose route miles run backwards", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const reversed = { ...svc, trips: svc.trips.map(t => ({ ...t, stopTimes: t.stopTimes.map((st, i) => ({ ...st, miles: i === 0 ? 9 : st.miles })) })) };
  const check = E.verifyService(reversed);
  assert.equal(check.passed, false);
  assert.ok(check.errors.some(e => /Decreasing distance/.test(e)), String(check.errors));
});
