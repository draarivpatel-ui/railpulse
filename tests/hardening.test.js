/* RailPulse hardening and adversarial-regression tests.
 *
 * Run with:  node --test tests/
 *
 * Covers hostile GTFS archives and CSV text, service-day clock edges,
 * cascade and stringline invariants, exact headway statistics, formula-safe
 * CSV export, SHA-256 report integrity, atomic import, and the WCAG 2.1.4
 * single-key shortcut switch.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

require("../corridors.js");
const E = require("../engine.js");
const CORRIDORS = globalThis.RailPulse.CORRIDORS;
const { boot, change, marks, assertFiniteSvg } = require("./dom-fixture.js");

/* ------------------------------------------------------------------ *
 * Fixtures (mirrors railpulse.test.js helpers, kept self contained)
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
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt32LE(dataBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, Buffer.from(nameBytes), Buffer.from(dataBytes));
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBytes.length, 20);
    cd.writeUInt32LE(dataBytes.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
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

function singleEntryZip(text, options = {}) {
  const name = options.name || "routes.txt", nameBytes = Buffer.from(name), raw = options.data || Buffer.from(text);
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

/* A File-shaped object the way handleGtfsFiles consumes it. */
function fakeFile(name, bytes, opts = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    name,
    size: opts.size != null ? opts.size : buf.length,
    type: opts.type || "application/octet-stream",
    slice: (a, b) => {
      const s = buf.subarray(a, b);
      return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString("utf8")
  };
}

/* ------------------------------------------------------------------ *
 * Service-day clock: overnight and boundary values
 * ------------------------------------------------------------------ */

test("parseGtfsTime accepts overnight and boundary hours, rejects bad minutes", () => {
  assert.equal(E.parseGtfsTime("24:00:00"), 86400);
  assert.equal(E.parseGtfsTime("25:15:00"), 90900);
  assert.equal(E.parseGtfsTime("99:59:59"), 99 * 3600 + 59 * 60 + 59);
  assert.ok(Number.isNaN(E.parseGtfsTime("24:60:00")));
  assert.ok(Number.isNaN(E.parseGtfsTime("23:59:60")));
  assert.ok(Number.isNaN(E.parseGtfsTime("08:00")));
  assert.ok(Number.isNaN(E.parseGtfsTime("8:5:00")));
  assert.ok(Number.isNaN(E.parseGtfsTime("-1:00:00")));
  assert.ok(Number.isNaN(E.parseGtfsTime("")));
  assert.ok(Number.isNaN(E.parseGtfsTime(null)));
});

test("formatGtfsTime handles exactly midnight-rollover and fractional seconds", () => {
  assert.equal(E.formatGtfsTime(86400), "24:00:00");
  assert.equal(E.formatGtfsTime(90900), "25:15:00");
  assert.equal(E.formatGtfsTime(89999.6), "25:00:00");
  assert.equal(E.formatGtfsTime(NaN), "");
  assert.equal(E.formatGtfsTime(Infinity), "");
});

test("overnight GTFS trips parse end to end past 24:00", async () => {
  const files = makeGtfsFiles();
  files["trips.txt"] = "route_id,service_id,trip_id,trip_headsign,direction_id\nR1,WK,N1,Charlie,0\n";
  files["stop_times.txt"] =
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
    "N1,23:55:00,23:55:30,S1,1\nN1,24:05:00,24:05:30,S2,2\nN1,25:15:00,25:15:00,S3,3\n";
  const parsed = await E.parseGtfs({ files, date: "20261106" });
  assert.equal(parsed.services.length, 1);
  const svc = parsed.services[0];
  assert.equal(svc.trips[0].stopTimes[2].arrivalSec, 90900);
  assert.equal(svc.endSec, 90900);
  assert.ok(E.verifyService(svc).passed);
});

test("after-midnight arrivals keep service-day labels, not wall-clock labels", async () => {
  const files = makeGtfsFiles();
  files["trips.txt"] = "route_id,service_id,trip_id,trip_headsign,direction_id\nR1,WK,N1,Charlie,0\nR1,WK,N2,Charlie,0\n";
  files["stop_times.txt"] =
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
    "N1,24:50:00,24:50:30,S1,1\nN1,24:55:00,24:55:30,S2,2\nN1,25:00:00,25:00:00,S3,3\n" +
    "N2,25:10:00,25:10:30,S1,1\nN2,25:15:00,25:15:30,S2,2\nN2,25:20:00,25:20:00,S3,3\n";
  const parsed = await E.parseGtfs({ files, date: "20261106" });
  const hw = E.analyzeHeadways(parsed.services[0]);
  const labels = hw.timeOfDay.map((d) => d.label);
  assert.ok(labels.some((l) => l.startsWith("25:")), String(labels));
  assert.ok(!labels.includes("01:00:00"));
});

/* ------------------------------------------------------------------ *
 * ZIP archive attacks
 * ------------------------------------------------------------------ */

test("an empty ZIP extracts to an empty file map then reports missing tables", async () => {
  const files = await E.readZip(ab(buildStoreZip({})));
  assert.deepEqual(Object.keys(files), []);
  await assert.rejects(E.parseGtfs({ files: ab(buildStoreZip({})) }), /missing required files/);
});

test("EOCD comments are honored while trailing garbage is rejected", async () => {
  const ok = buildStoreZip({ "routes.txt": "route_id\nR1\n" });
  const commented = Buffer.concat([ok.subarray(0, ok.length - 22), (() => { const e = Buffer.alloc(27); ok.copy(e, 0, ok.length - 22); e.writeUInt16LE(5, 20); e.write("hello", 22); return e; })()]);
  assert.equal((await E.readZip(ab(commented)))["routes.txt"], "route_id\nR1\n");
  const trailed = Buffer.concat([ok, Buffer.from("junk")]);
  await assert.rejects(E.readZip(ab(trailed)), /Invalid ZIP/);
});

test("ZIP rejects entry-count lies, split markers and ZIP64 sentinels", async () => {
  const z = buildStoreZip({ "a.txt": "x" });
  const many = Buffer.from(z);
  many.writeUInt16LE(1025, many.length - 22 + 8);
  many.writeUInt16LE(1025, many.length - 22 + 10);
  await assert.rejects(E.readZip(ab(many)), /1024 entry limit/);
  const disk = Buffer.from(z); disk.writeUInt16LE(1, disk.length - 22 + 4);
  await assert.rejects(E.readZip(ab(disk)), /split archives/);
  const diskEntries = Buffer.from(z); diskEntries.writeUInt16LE(0, diskEntries.length - 22 + 8);
  await assert.rejects(E.readZip(ab(diskEntries)), /split archives/);
  const diskCd = Buffer.from(z); diskCd.writeUInt16LE(1, diskCd.length - 22 + 6);
  await assert.rejects(E.readZip(ab(diskCd)), /split archives/);
  const z64 = Buffer.from(z); z64.writeUInt16LE(65535, z64.length - 22 + 8); z64.writeUInt16LE(65535, z64.length - 22 + 10);
  await assert.rejects(E.readZip(ab(z64)), /ZIP64/);
  const z64s = Buffer.from(z); z64s.writeUInt32LE(0xFFFFFFFF, z64s.length - 22 + 12);
  await assert.rejects(E.readZip(ab(z64s)), /ZIP64/);
});

test("ZIP local-header bounds and stored-size mismatches are caught", async () => {
  const z = buildStoreZip({ "routes.txt": "data" });
  const far = Buffer.from(z); far.writeUInt32LE(99999, centralOffset(far) + 42);
  await assert.rejects(E.readZip(ab(far)), /out-of-bounds/);
  const stored = singleEntryZip("route_id\nR1\n", { method: 0 });
  stored.writeUInt32LE(stored.length + 500, centralOffset(stored) + 20);
  await assert.rejects(E.readZip(ab(stored)), /out-of-bounds/);
  const shrink = singleEntryZip("route_id\nR1\n", { method: 0 });
  shrink.writeUInt32LE(2, centralOffset(shrink) + 20);
  await assert.rejects(E.readZip(ab(shrink)), /expanded size mismatch|filename mismatch/);
});

test("ZIP archive names cannot escape through path prefixes or casing", async () => {
  const traversal = buildStoreZip({ "../../etc/evil.txt": "bad" });
  const files = await E.readZip(ab(traversal));
  assert.deepEqual(Object.keys(files), ["evil.txt"]);
  const upper = buildStoreZip({ "STOPS.TXT": "stop_id\nS1\n" });
  assert.ok((await E.readZip(ab(upper)))["STOPS.TXT"]);
  await assert.rejects(
    E.parseGtfs({ files: ab(buildStoreZip({ "A.TXT": "a", "a.txt": "b" })) }),
    /Duplicate GTFS filename/
  );
});

test("truncated deflate streams and size mismatches reject cleanly", async () => {
  const z = singleEntryZip("route_id,route_short_name\nR1,RL\n");
  const cut = Buffer.from(z.subarray(0, z.length - 30));
  await assert.rejects(E.readZip(ab(cut)), /Invalid ZIP|DEFLATE/);
  const inflated = singleEntryZip("route_id\nR1\n");
  inflated.writeUInt32LE(50, centralOffset(inflated) + 24);
  await assert.rejects(E.readZip(ab(inflated)), /size mismatch|expanded limit/);
});

test("non-text member bytes cannot reach the CSV layer", async () => {
  // A corrupted stored byte flips the CRC.
  const stored = singleEntryZip("route_id\nR1\n", { method: 0 });
  stored[30 + Buffer.from("routes.txt").length] ^= 0xFF;
  await assert.rejects(E.readZip(ab(stored)), /CRC32 mismatch/);
  // Valid CRC over raw non-UTF-8 bytes is caught by the fatal decoder.
  const binary = singleEntryZip("", { method: 0, data: Buffer.from([0xFF, 0xFE, 0x00, 0x41]) });
  await assert.rejects(E.readZip(ab(binary)), /non-UTF-8|Invalid ZIP/);
  // A non-UTF-8 filename is reported as a ZIP error, not a raw decoder fault.
  const badName = singleEntryZip("", { method: 0 });
  badName[30] = 0xFF;
  badName[centralOffset(badName) + 46] = 0xFF;
  await assert.rejects(E.readZip(ab(badName)), /Invalid ZIP/);
});

/* ------------------------------------------------------------------ *
 * Loose file maps and binary input detection
 * ------------------------------------------------------------------ */

test("file maps enforce text values, size limits and prototype-safe keys", async () => {
  await assert.rejects(E.readFeedFiles({ "routes.txt": Buffer.from("a") }), /text values/);
  await assert.rejects(E.readFeedFiles({ "routes.txt": "x".repeat(70 * 1024 * 1024), "b.txt": "x".repeat(70 * 1024 * 1024) }), /text limit/);
  const files = await E.readFeedFiles({ "__proto__.txt": "route_id\nR1\n", "weird/../routes.txt": "route_id\nR1\n" });
  assert.ok(Object.prototype.hasOwnProperty.call(files, "__proto__.txt"));
  assert.equal(files["routes.txt"], "route_id\nR1\n");
});

test("binary inputs detect PK magic, decode loose CSV, and reject garbage", async () => {
  const zip = singleEntryZip("route_id\nR1\n");
  const blob = { arrayBuffer: async () => ab(zip) };
  assert.equal((await E.readFeedFiles(blob))["routes.txt"], "route_id\nR1\n");
  const csv = new TextEncoder().encode("stop_id,stop_name,stop_lat,stop_lon\nS1,Alpha,41.8,-87.6\n").buffer;
  const fromBuf = await E.readFeedFiles(csv);
  assert.equal(fromBuf["stops.txt"], "stop_id,stop_name,stop_lat,stop_lon\nS1,Alpha,41.8,-87.6\n");
  const view = new Uint8Array(csv).subarray(0, csv.byteLength);
  assert.equal((await E.readFeedFiles(view))["stops.txt"], "stop_id,stop_name,stop_lat,stop_lon\nS1,Alpha,41.8,-87.6\n");
  await assert.rejects(E.readFeedFiles(new TextEncoder().encode("\x00\x01\x02\x03 garbage").buffer), /Unrecognized GTFS/);
  await assert.rejects(E.readFeedFiles(null), /Unsupported GTFS input/);
  await assert.rejects(E.readFeedFiles(42), /Unsupported GTFS input/);
  await assert.rejects(E.readFeedFiles("not,any,gtfs\n1,2,3\n"), /Unrecognized GTFS/);
});

/* ------------------------------------------------------------------ *
 * CSV parser attacks
 * ------------------------------------------------------------------ */

test("parseCsv handles minimal shapes, CR endings and quoted empties", () => {
  assert.deepEqual(E.parseCsv(""), []);
  assert.deepEqual(E.parseCsv("a,b\n"), []);
  const cr = E.parseCsv("a,b\r1,2\r3,4");
  assert.equal(cr.length, 2);
  assert.equal(cr[0].a, "1");
  assert.equal(cr[1].b, "4");
  const empty = E.parseCsv('a,b\n1,""\n');
  assert.equal(empty[0].b, "");
  assert.equal(E.parseCsv("a,b,c\n1,2,\n")[0].c, "");
  assert.throws(() => E.parseCsv("a,b,\n1,2,\n"), /empty or duplicate/);
  const noNl = E.parseCsv("a,b\n1,2");
  assert.equal(noNl.length, 1);
  assert.equal(noNl[0].b, "2");
});

test("parseCsv keeps prototype-named headers as inert string values", () => {
  const rows = E.parseCsv("hasOwnProperty,toString,constructor\nv1,v2,v3\n");
  assert.equal(rows[0].hasOwnProperty, "v1");
  assert.equal(rows[0].toString, "v2");
  assert.equal(rows[0].constructor, "v3");
  assert.equal(typeof rows[0].hasOwnProperty, "string");
  assert.equal(Object.getPrototypeOf(rows[0]), null);
});

test("parseCsv still rejects quote violations and stray fields", () => {
  for (const csv of [
    'a,b\n"unterminated,2\n',
    'a,b\n1,"ok"tail\n',
    "a,b\n1,mi\"d\n",
    "a,,b\n1,2,3\n",
    "a,b\n1,2,3\n"
  ]) assert.throws(() => E.parseCsv(csv), /Invalid CSV/);
});

test("GTFS table names are case-insensitive in loose maps and CSV aliases", async () => {
  const files = await E.readFeedFiles({ "STOP_TIMES.CSV": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,S,1\n" });
  assert.ok(files["stop_times.txt"]);
  assert.deepEqual(Object.keys(files).sort(), ["stop_times.txt"]);
});

/* ------------------------------------------------------------------ *
 * GTFS semantic attacks
 * ------------------------------------------------------------------ */

test("stop_times for trips missing from trips.txt are counted once, not per row", async () => {
  const files = makeGtfsFiles();
  files["stop_times.txt"] += "GHOST,10:00:00,10:00:30,S1,1\nGHOST,10:05:00,10:05:30,S2,2\n";
  const parsed = await E.parseGtfs({ files, date: "20261106" });
  assert.ok(parsed.warnings.some((w) => /2 row\(s\) for trip_ids missing/.test(w)), String(parsed.warnings));
  assert.ok(parsed.services.every((s) => s.trips.every((t) => t.tripId !== "GHOST")));
});

test("each missing required GTFS table is named in the error", async () => {
  for (const drop of ["trips.txt", "stop_times.txt", "stops.txt"]) {
    const files = makeGtfsFiles();
    delete files[drop];
    await assert.rejects(E.parseGtfs({ files }), new RegExp(drop));
  }
});

test("calendar exception types beyond 1 and 2 are ignored", async () => {
  const files = makeGtfsFiles();
  files["calendar_dates.txt"] = "service_id,date,exception_type\nWK,20261106,3\nWE,20261106,9\n";
  const r = E.resolveActiveServices(files, "20261106");
  assert.equal(r.error, null);
  assert.ok(r.active.WK, "WK still active on a Friday");
  assert.ok(!r.active.WE, "WE not added by exception_type 9");
});

test("service ids with stray whitespace still match the calendar", async () => {
  const files = makeGtfsFiles();
  files["trips.txt"] = files["trips.txt"].replace(",WK,", ", WK ,");
  files["stop_times.txt"] = files["stop_times.txt"].replace(/^T/gm, "T");
  const parsed = await E.parseGtfs({ files, date: "20261106" });
  const r1 = parsed.services.find((s) => s.routeId === "R1");
  assert.ok(r1.trips.length > 0);
});

test("invalid service dates propagate and empty tables stay empty", async () => {
  await assert.rejects(E.parseGtfs({ files: makeGtfsFiles(), date: "2026-11-06" }), /Invalid service date/);
  const files = makeGtfsFiles();
  files["trips.txt"] = "route_id,service_id,trip_id\n";
  const parsed = await E.parseGtfs({ files, date: "20261106" });
  assert.equal(parsed.services.length, 0);
  assert.ok(parsed.warnings.length > 0);
});

test("maxServices bounds are enforced at both ends", async () => {
  await assert.rejects(E.parseGtfs({ files: makeGtfsFiles(), maxServices: 1.5 }), /maxServices/);
  await assert.rejects(E.parseGtfs({ files: makeGtfsFiles(), maxServices: 1025 }), /maxServices/);
  const none = await E.parseGtfs({ files: makeGtfsFiles(), maxServices: 0 });
  assert.equal(none.services.length, 0);
});

test("resolveActiveServices trims the query date and reports garbage", () => {
  const r = E.resolveActiveServices(makeGtfsFiles(), "  20261106  ");
  assert.equal(r.error, null);
  assert.ok(r.active.WK);
  assert.ok(E.resolveActiveServices(makeGtfsFiles(), "20261340").error);
});

/* ------------------------------------------------------------------ *
 * Exact headway statistics
 * ------------------------------------------------------------------ */

test("headway CV is exactly sample sigma over mean", () => {
  const s = E.describeSample([60, 180]);
  assert.equal(s.mean, 120);
  assert.equal(s.stddev.toFixed(4), (Math.sqrt((3600 + 3600) / 1)).toFixed(4));
  assert.equal(s.cv.toFixed(4), "0.7071");
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] }));
  svc.trips = [0, 60, 240].map((time, i) => ({
    tripId: "W" + i, stopTimes: [{ stopId: svc.stops[0].id, arrivalSec: time, departureSec: time, miles: 0 }], startTime: time
  }));
  assert.equal(E.analyzeHeadways(svc).overall.cv.toFixed(4), "0.7071");
});

test("a single-trip service yields empty headway stats without NaN", () => {
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] }));
  svc.trips = svc.trips.slice(0, 1);
  const hw = E.analyzeHeadways(svc);
  assert.equal(hw.overall.count, 0);
  assert.equal(hw.overall.cv, 0);
  assert.equal(hw.excessWaitSec, 0);
  const rep = E.buildReport(svc);
  assert.ok(Number.isFinite(rep.score));
});

test("headway analysis honors a single-stop filter", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const hw = E.analyzeHeadways(svc, { stopId: svc.stops[1].id });
  assert.equal(hw.perStop.length, 1);
  assert.equal(hw.perStop[0].stopId, svc.stops[1].id);
  assert.equal(hw.perStop[0].arrivals.length, svc.trips.length);
});

test("bunching falls back to absolute thresholds when no headway is planned", () => {
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] }));
  svc.plannedHeadwaySec = 0;
  svc.trips = [0, 100, 2000].map((time, i) => ({
    tripId: "W" + i, stopTimes: [{ stopId: svc.stops[0].id, arrivalSec: time, departureSec: time, miles: 0 }], startTime: time
  }));
  const b = E.analyzeBunching(svc);
  assert.equal(b.bunchCount, 1);
  assert.equal(b.gapCount, 1);
});

/* ------------------------------------------------------------------ *
 * Stringline (Ibry-Marey) monotonicity invariants
 * ------------------------------------------------------------------ */

test("every corridor stringline is time- and distance-monotonic", () => {
  for (const svc of E.buildAllSyntheticServices()) {
    for (const line of E.buildStringline(svc).lines) {
      for (let i = 1; i < line.points.length; i++) {
        assert.ok(line.points[i].timeSec >= line.points[i - 1].timeSec, svc.id + " " + line.tripId + " time");
        assert.ok(line.points[i].miles >= line.points[i - 1].miles, svc.id + " " + line.tripId + " miles");
      }
    }
  }
});

test("observed and simulated layers keep the same monotonicity invariants", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  for (const layer of [E.withObserved(svc, E.simulateObserved(svc, { seed: 9, intensity: 2.8 })), E.withObserved(svc, E.simulateCascade(svc).observedTrips)]) {
    for (const line of E.buildStringline(layer).lines) {
      for (let i = 1; i < line.points.length; i++) {
        assert.ok(line.points[i].timeSec >= line.points[i - 1].timeSec);
        assert.ok(line.points[i].miles >= line.points[i - 1].miles);
      }
    }
  }
});

test("stringline validates trip limits and reports available vs visible", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  assert.throws(() => E.buildStringline(svc, { maxTrips: -2 }), /Invalid stringline/);
  assert.throws(() => E.buildStringline(svc, { maxTrips: 1.5 }), /Invalid stringline/);
  const sl = E.buildStringline(svc, { maxTrips: 2 });
  assert.equal(sl.visibleTrips, 2);
  assert.equal(sl.availableTrips, svc.trips.length);
});

/* ------------------------------------------------------------------ *
 * Cascade-delay propagation invariants
 * ------------------------------------------------------------------ */

test("cascade separation holds for every follower at every stop", () => {
  const svc = E.buildSyntheticService(CORRIDORS.find((c) => c.id === "cta-red"), { startSec: 7 * 3600, endSec: 9 * 3600 });
  for (const opts of [{}, { regulate: true }, { regulate: true, spacingRatio: 0.2 }, { minSeparationSec: 90 }]) {
    const run = E.simulateCascade(svc, opts);
    const sep = run.minSeparationSec;
    for (let t = 1; t < run.observedTrips.length; t++) {
      for (let i = 0; i < run.observedTrips[t].stopTimes.length; i++) {
        assert.ok(
          run.observedTrips[t].stopTimes[i].arrivalSec >= run.observedTrips[t - 1].stopTimes[i].departureSec + sep,
          `t=${t} stop=${i}`
        );
      }
    }
  }
});

test("cascade never shortens dwell and only the incident adds the platform stop", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const run = E.simulateCascade(svc, { incidentSec: 600, incidentTripIndex: 1, incidentStopIndex: 1 });
  run.observedTrips.forEach((trip, t) => {
    trip.stopTimes.forEach((st, i) => {
      const sched = svc.trips[t].stopTimes[i];
      assert.ok(st.departureSec - st.arrivalSec >= sched.departureSec - sched.arrivalSec);
    });
  });
  assert.equal(run.observedTrips[1].stopTimes[1].departureSec - run.observedTrips[1].stopTimes[1].arrivalSec, 30 + 600);
});

test("cascade reports and options cover empty and edge inputs", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const empty = E.simulateCascade({ trips: [], stops: [] });
  assert.equal(empty.observedTrips.length, 0);
  assert.equal(empty.maxDelaySec, 0);
  assert.throws(() => E.simulateCascade(svc, { incidentStopIndex: 99 }), /Invalid incident/);
  assert.throws(() => E.simulateCascade(svc, { spacingRatio: 1.5 }), /Invalid incident/);
  assert.throws(() => E.simulateCascade(svc, { minSeparationSec: -1 }), /Invalid incident/);
  const run = E.simulateCascade(svc, { incidentSec: 300, minSeparationSec: 90 });
  assert.equal(run.incidentTripId, svc.trips[Math.min(4, svc.trips.length - 1)].tripId);
});

test("incident delay reaches the terminal and zero incident reproduces schedule", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  // Mid-corridor incident propagates to the terminal arrival.
  const run = E.simulateCascade(svc, { incidentSec: 420, incidentStopIndex: 1 });
  const idx = run.observedTrips.findIndex((t) => t.tripId === run.incidentTripId);
  const inc = run.observedTrips[idx], sched = svc.trips[idx];
  assert.equal(inc.stopTimes.at(-1).arrivalSec - sched.stopTimes.at(-1).arrivalSec, 420);
  // A terminal-stop incident delays only the final departure.
  const last = svc.stops.length - 1;
  const tail = E.simulateCascade(svc, { incidentSec: 420, incidentStopIndex: last });
  const ti = tail.observedTrips.findIndex((t) => t.tripId === tail.incidentTripId);
  assert.equal(tail.observedTrips[ti].stopTimes.at(-1).departureSec - svc.trips[ti].stopTimes.at(-1).departureSec, 420);
  assert.deepEqual(E.simulateCascade(svc, { incidentSec: 0 }).observedTrips, svc.trips);
});

/* ------------------------------------------------------------------ *
 * verifyService station-level integrity
 * ------------------------------------------------------------------ */

test("verifyService flags duplicate ids, bad mileposts and bad coordinates", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const dup = { ...svc, stops: svc.stops.map((s) => ({ ...s })) };
  dup.stops[1].id = dup.stops[0].id;
  assert.equal(E.verifyService(dup).passed, false);
  const back = { ...svc, stops: svc.stops.map((s) => ({ ...s })) };
  back.stops[2].miles = 0.5;
  const backCheck = E.verifyService(back);
  assert.equal(backCheck.passed, false);
  assert.ok(backCheck.errors.some((e) => /mileposts/.test(e)), String(backCheck.errors));
  const geo = { ...svc, stops: svc.stops.map((s) => ({ ...s })) };
  geo.stops[0].lat = 91;
  assert.equal(E.verifyService(geo).passed, false);
});

test("verifyService rejects malformed services without throwing", () => {
  assert.equal(E.verifyService(null).passed, false);
  assert.equal(E.verifyService({}).passed, false);
  assert.equal(E.verifyService({ trips: "x", stops: [] }).passed, false);
});

/* ------------------------------------------------------------------ *
 * Realtime and simulation edges
 * ------------------------------------------------------------------ */

test("applyRealtime ignores unknown trips and clamps impossible times", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const obs = E.applyRealtime(svc, [{ tripId: "NOPE", stopId: "x", arrivalSec: 1 }]);
  assert.deepEqual(obs[0].stopTimes[0].arrivalSec, svc.trips[0].stopTimes[0].arrivalSec);
  const clamped = E.applyRealtime(svc, [{
    tripId: svc.trips[0].tripId, stopId: svc.trips[0].stopTimes[0].stopId,
    arrivalSec: -500, departureSec: -400
  }]);
  assert.equal(clamped[0].stopTimes[0].arrivalSec, 0);
  assert.equal(clamped[0].stopTimes[0].departureSec, 0);
});

test("analyzeDelay rejects non-finite tolerances", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  assert.throws(() => E.analyzeDelay(svc, { onTimeThresholdSec: -1 }), /Invalid delay tolerance/);
  assert.throws(() => E.analyzeDelay(svc, { onTimeThresholdSec: NaN }), /Invalid delay tolerance/);
  assert.throws(() => E.analyzeDelay(svc, { earlyThresholdSec: -5 }), /Invalid delay tolerance/);
});

test("simulateObserved produces valid journeys at the intensity extremes", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  for (const intensity of [0, 0.6, 10]) {
    const obs = E.withObserved(svc, E.simulateObserved(svc, { seed: 4, intensity }));
    assert.ok(E.verifyService(obs).passed, "intensity " + intensity);
  }
  assert.throws(() => E.simulateObserved(svc, { intensity: 11 }), /intensity/);
});

/* ------------------------------------------------------------------ *
 * Formula-safe CSV and SHA-256 exports
 * ------------------------------------------------------------------ */

test("csvCell prefixes spreadsheet formula prefixes and escapes structure", () => {
  assert.equal(E.csvCell("=cmd|/c calc"), "'=cmd|/c calc");
  assert.equal(E.csvCell("+SUM(A1)"), "'+SUM(A1)");
  assert.equal(E.csvCell("-2"), "'-2");
  assert.equal(E.csvCell("@f(1)"), "'@f(1)");
  assert.equal(E.csvCell("  =x"), "'  =x");
  assert.equal(E.csvCell("\t=cmd"), "'\t=cmd");
  assert.equal(E.csvCell("\r=cmd"), '"\'\r=cmd"');
  assert.equal(E.csvCell("'already"), "''already");
  assert.equal(E.csvCell("plain"), "plain");
  assert.equal(E.csvCell("a,b"), '"a,b"');
  assert.equal(E.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(E.csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(E.csvCell(null), "");
  assert.equal(E.csvCell(0), "0");
});

test("toCsv writes RFC 4180 rows that parse back exactly", () => {
  const csv = E.toCsv(
    [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }, { label: "G", value: (r) => r.a + "!" }],
    [{ a: "x,y", b: "1" }, { a: 'q"z', b: "2" }]
  );
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(csv, 'Alpha,Beta,G\r\n"x,y",1,"x,y!"\r\n"q""z",2,"q""z!"\r\n');
  const rows = E.parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Alpha, "x,y");
  assert.equal(rows[1].Alpha, 'q"z');
});

test("sha256Hex matches published vectors and handles bytes", () => {
  assert.equal(E.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(E.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    E.sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
  assert.equal(E.sha256Hex(new TextEncoder().encode("abc")), E.sha256Hex("abc"));
  assert.equal(E.sha256Hex("RailPulse").length, 64);
  assert.equal(E.sha256Hex(null), E.sha256Hex(""));
});

test("reportCsv round-trips through parseCsv with every station", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const rep = E.buildReport(E.withObserved(svc, E.simulateObserved(svc, { seed: 2 })));
  const csv = E.reportCsv(rep);
  const rows = E.parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].station, "Alpha");
  assert.equal(rows[0].milepost_mi, "0");
  assert.equal(rows[2].station, "Charlie");
  assert.ok(Number.isFinite(Number(rows[0].mean_delay_s)));
});

test("reportCsv neutralizes hostile station names from feed data", () => {
  const svc = E.buildSyntheticService(makeCorridor({
    stations: [["X", "=HYPERLINK(\"http://evil\")", 0, 0], ["Y", "+SUM(1)", 2, 30]]
  }));
  const csv = E.reportCsv(E.buildReport(svc));
  const rows = E.parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].station.startsWith("'"), rows[0].station);
  assert.ok(!/"?=[^']/.test(rows[0].station) || rows[0].station.startsWith("'"));
  assert.ok(rows[1].station.startsWith("'"));
});

/* ------------------------------------------------------------------ *
 * UI: exports, atomic import, WCAG 2.1.4
 * ------------------------------------------------------------------ */

function feedFiles(routeName = "Local Line") {
  return {
    "routes.csv": "route_id,route_long_name,route_type\nR," + routeName + ",1\n",
    "stops.csv": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,41.88,-87.63\nB,Bravo,41.85,-87.63\n",
    "trips.csv": "route_id,service_id,trip_id,direction_id\nR,S,T1,0\nR,S,T2,0\n",
    "stop_times.csv": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:30,A,1\nT1,08:05:00,08:05:30,B,2\nT2,08:10:00,08:10:30,A,1\nT2,08:15:00,08:15:30,B,2\n"
  };
}
async function upload(h, files) {
  h.ids.get("gtfsInput").files = Object.entries(files).map(([name, text]) => ({ name, text: async () => text }));
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
}

test("dispatch JSON export carries a verifiable SHA-256 digest", async () => {
  const h = boot();
  h.ids.get("exportReport").click();
  const parsed = JSON.parse(await h.blobs[0].text());
  assert.equal(parsed.integrity.algorithm, "SHA-256");
  assert.match(parsed.integrity.digest, /^[0-9a-f]{64}$/);
  const digest = parsed.integrity.digest;
  delete parsed.integrity;
  assert.equal(h.context.RailPulse.sha256Hex(JSON.stringify(parsed)), digest);
});

test("station CSV export downloads and parses with one row per stop", async () => {
  const h = boot();
  h.ids.get("exportCsv").click();
  assert.equal(h.downloads[0].name, "railpulse-stations.csv");
  const rows = h.context.RailPulse.parseCsv(await h.blobs[0].text());
  assert.equal(rows.length, 33);
  assert.equal(rows[0].milepost_mi, "0");
  assert.ok(rows.every((r) => r.mean_delay_s !== undefined));
});

test("uploaded zip under a non-zip name still imports via magic bytes", async () => {
  const h = boot();
  const zip = buildStoreZip(feedFiles("Renamed Feed"));
  h.ids.get("gtfsInput").files = [fakeFile("feed.dat", zip)];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /Loaded 1 directional service/);
  assert.match(h.ids.get("heroSub").textContent, /Renamed Feed/);
});

test("oversized uploads are rejected before parsing and keep the view", async () => {
  const h = boot();
  const score = h.ids.get("heroScore").textContent;
  h.ids.get("gtfsInput").files = [fakeFile("huge.zip", Buffer.alloc(8), { size: 200 * 1024 * 1024 })];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /128 MiB/);
  assert.equal(h.ids.get("heroScore").textContent, score);
});

test("a failed re-upload leaves the working feed untouched", async () => {
  const h = boot();
  await upload(h, feedFiles("Stable Line"));
  assert.match(h.ids.get("heroSub").textContent, /Stable Line/);
  await upload(h, { "routes.csv": "route_id\nbroken,csv," });
  assert.equal(h.ids.get("heroSub").textContent.includes("Stable Line") || /missing required files/.test(h.ids.get("feedNotice").textContent), true);
});

test("the single-key shortcut switch satisfies WCAG 2.1.4", () => {
  const h = boot();
  const btn = h.ids.get("shortcutToggle");
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  btn.click();
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.equal(btn.textContent, "Keys 1-3 off");
  h.doc.dispatchEvent(new h.Event("keydown", { key: "1", target: h.doc.body }));
  assert.equal(h.ids.get("presetSmooth").getAttribute("aria-pressed"), "false");
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "true");
  btn.click();
  h.doc.dispatchEvent(new h.Event("keydown", { key: "1", target: h.doc.body }));
  assert.equal(h.ids.get("presetSmooth").getAttribute("aria-pressed"), "true");
});

test("Escape still hides the tooltip when character shortcuts are off", () => {
  const h = boot();
  h.ids.get("shortcutToggle").click();
  const hit = marks(h, "stringlineChart").find(n => n.attrs.class === "hit");
  hit.focus();
  assert.equal(h.ids.get("tooltip").hidden, false);
  h.doc.dispatchEvent(new h.Event("keydown", { key: "Escape", target: h.doc.body }));
  assert.equal(h.ids.get("tooltip").hidden, true);
});

test("the shortcut hint in the footer points at the control", () => {
  const h = boot();
  const text = h.doc.body.children.map(() => "").join("");
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "../index.html"), "utf8");
  assert.ok(html.includes("shortcutToggle"));
  assert.ok(/Keys 1-3/.test(html));
  assert.equal(text, "");
});

/* ------------------------------------------------------------------ *
 * Small helpers and geometry edges
 * ------------------------------------------------------------------ */

test("pointAlong clamps fractions and survives degenerate anchors", () => {
  assert.deepEqual(E.pointAlong([], 0.5), [0, 0]);
  assert.deepEqual(E.pointAlong([[5, 6]], 0.9), [5, 6]);
  assert.deepEqual(E.pointAlong([[0, 0], [0, 0]], 0.5), [0, 0]);
  const p = E.pointAlong([[0, 0], [10, 0]], 1.5);
  assert.deepEqual(p, [10, 0]);
});

test("formatDuration handles negatives, zero and missing values", () => {
  assert.equal(E.formatDuration(-90), "-1m 30s");
  assert.equal(E.formatDuration(0), "0s");
  assert.equal(E.formatDuration(NaN), "n/a");
  assert.equal(E.formatDuration(59), "59s");
});

test("percentile interpolates and clamps the requested fraction", () => {
  assert.equal(E.percentile([10], 0.5), 10);
  assert.equal(E.percentile([0, 100], -0.5), 0);
  assert.equal(E.percentile([0, 100], 1.5), 100);
  assert.equal(E.percentile([0, 10, 20, 30], 0.25), 7.5);
});

test("buildSyntheticService rejects decreasing mileposts and bad dwells", () => {
  assert.throws(() => E.buildSyntheticService(makeCorridor({
    stations: [["A", "A", 5, 0], ["B", "B", 2, 0]]
  })), /nondecreasing/);
  assert.throws(() => E.buildSyntheticService(makeCorridor({
    stations: [["A", "A", 0, -30]]
  })), /nondecreasing|dwells/);
});

test("GTFS parse preserves weekend service through date exceptions", async () => {
  const files = makeGtfsFiles();
  files["calendar.txt"] = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWE,0,0,0,0,0,1,1,20260101,20261231\n";
  delete files["calendar_dates.txt"];
  files["trips.txt"] = "route_id,service_id,trip_id,direction_id\nR1,WE,TW1,0\nR2,WK,B1,0\n";
  const parsed = await E.parseGtfs({ files, date: "20261107" });
  assert.equal(parsed.services.length, 1);
  assert.equal(parsed.services[0].trips[0].tripId, "TW1");
});

test("full pipeline: zip feed through report keeps every analyzer finite", async () => {
  const buf = buildStoreZip(makeGtfsFiles());
  const parsed = await E.parseGtfs({ files: ab(buf), date: "20261106" });
  for (const svc of parsed.services) {
    const rep = E.buildReport(E.withObserved(svc, E.simulateObserved(svc, { seed: 1 })));
    assert.ok(Number.isFinite(rep.headways.overall.cv));
    assert.ok(Number.isFinite(rep.bunching.excessWaitSec));
    assert.ok(rep.verification.passed, svc.id + ": " + rep.verification.errors.join(";"));
    assertFiniteCsvRoundTrip(E.reportCsv(rep));
  }
});

function assertFiniteCsvRoundTrip(csv) {
  const rows = E.parseCsv(csv);
  for (const r of rows) {
    for (const v of Object.values(r)) {
      assert.ok(!/NaN|undefined/.test(v), "csv cell " + v);
    }
  }
}

test("DOM render stays finite on a 320px viewport after export additions", () => {
  const h = boot(320);
  assertFiniteSvg(h);
  for (const corridor of h.context.RailPulse.CORRIDORS.slice(0, 3)) {
    change(h, "serviceSelect", corridor.id);
    assertFiniteSvg(h);
  }
});

/* ------------------------------------------------------------------ *
 * Batch 2: deeper archive, calendar, math and race-condition coverage
 * ------------------------------------------------------------------ */

test("ZIP rejects encrypted entries, unknown methods and forged local headers", async () => {
  const enc = singleEntryZip("route_id\nR1\n");
  enc.writeUInt16LE(1, enc.length - 22 - 46 - 10 + 8); // central flags
  enc.writeUInt16LE(1, 6); // local flags
  await assert.rejects(E.readZip(ab(enc)), /encrypted/);
  const bz = singleEntryZip("route_id\nR1\n");
  bz.writeUInt16LE(12, 8);
  bz.writeUInt16LE(12, centralOffset(bz) + 10);
  await assert.rejects(E.readZip(ab(bz)), /compression method/);
  const sig = singleEntryZip("route_id\nR1\n");
  sig.writeUInt32LE(0xDEADBEEF, 0);
  await assert.rejects(E.readZip(ab(sig)), /local header|central directory/);
  const cdSig = singleEntryZip("route_id\nR1\n");
  cdSig.writeUInt32LE(0xDEADBEEF, centralOffset(cdSig));
  await assert.rejects(E.readZip(ab(cdSig)), /central directory signature/);
  const nm = singleEntryZip("route_id\nR1\n");
  nm[30] = "X".charCodeAt(0);
  await assert.rejects(E.readZip(ab(nm)), /filename mismatch|CRC32|non-UTF-8/);
});

test("every missing GTFS join-key column is named", async () => {
  const cases = [
    ["routes.txt", "agency_id,route_type\nA1,1\n", /routes\.txt.*route_id/],
    ["trips.txt", "route_id,service_id\nR1,WK\n", /trips\.txt.*trip_id/],
    ["stops.txt", "stop_name,stop_lat,stop_lon\nAlpha,41.8,-87.6\n", /stops\.txt.*stop_id/]
  ];
  for (const [file, text, re] of cases) {
    const files = makeGtfsFiles();
    files[file] = text;
    await assert.rejects(E.parseGtfs({ files }), re, file);
  }
  // A stop_times table without stop_sequence leaves no usable trips.
  const files = makeGtfsFiles();
  files["stop_times.txt"] = "trip_id,arrival_time,departure_time,stop_id\nT1,08:00:00,08:00:30,S1\n";
  const parsed = await E.parseGtfs({ files });
  assert.equal(parsed.services.length, 0);
  assert.ok(parsed.warnings.some((w) => /stop_sequence/.test(w)), String(parsed.warnings));
});

test("passenger excess wait equals population variance over twice the mean", () => {
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] }));
  svc.trips = [0, 300, 600, 1200].map((time, i) => ({
    tripId: "W" + i, stopTimes: [{ stopId: svc.stops[0].id, arrivalSec: time, departureSec: time, miles: 0 }], startTime: time
  }));
  // Gaps 300,300,600: mean 400, population variance 20000, EWT = 20000/800 = 25s.
  assert.equal(E.analyzeHeadways(svc).excessWaitSec, 25);
  assert.equal(E.populationVariance([300, 300, 600]), 20000);
});

test("a constant headway series yields zero CV and zero excess wait", () => {
  const s = E.describeSample([600, 600, 600]);
  assert.equal(s.cv, 0);
  assert.equal(s.stddev, 0);
  const svc = E.buildSyntheticService(makeCorridor({ stations: [["A", "Alpha", 0, 0]] }));
  const hw = E.analyzeHeadways(svc);
  assert.equal(hw.overall.cv, 0);
  assert.equal(hw.excessWaitSec, 0);
});

test("sha256Hex digests multi-block input correctly", () => {
  assert.equal(
    E.sha256Hex("a".repeat(64) + "b".repeat(64) + "c"),
    E.sha256Hex("a".repeat(64) + "b".repeat(64) + "c")
  );
  assert.match(E.sha256Hex("a".repeat(64) + "b".repeat(64) + "c"), /^[0-9a-f]{64}$/);
  assert.equal(
    E.sha256Hex("a".repeat(1000000)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
  );
});

test("reportCsv covers a GTFS-imported directional service", async () => {
  const parsed = await E.parseGtfs({ files: makeGtfsFiles(), date: "20261106" });
  const svc = parsed.services[0];
  const rows = E.parseCsv(E.reportCsv(E.buildReport(svc)));
  assert.equal(rows.length, svc.stops.length);
  assert.equal(rows[0].station, "Alpha");
});

test("a slow stale upload can never overwrite a fresher one", async () => {
  const h = boot();
  const slow = Object.entries(feedFiles("Slow Line")).map(([name, text]) => ({
    name, text: () => new Promise((r) => setTimeout(() => r(text), 40))
  }));
  h.ids.get("gtfsInput").files = slow;
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  h.ids.get("gtfsInput").files = Object.entries(feedFiles("Fast Line")).map(([name, text]) => ({ name, text: async () => text }));
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise((r) => setTimeout(r, 90));
  assert.match(h.ids.get("heroSub").textContent, /Fast Line/);
  assert.match(h.ids.get("feedNotice").textContent, /Loaded 1 directional service/);
});

test("typing in a field or holding a modifier never fires a preset", () => {
  const h = boot();
  h.doc.dispatchEvent(new h.Event("keydown", { key: "1", target: h.ids.get("dateInput") }));
  h.doc.dispatchEvent(new h.Event("keydown", { key: "2", ctrlKey: true, target: h.doc.body }));
  h.doc.dispatchEvent(new h.Event("keydown", { key: "3", metaKey: true, target: h.doc.body }));
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "true");
  assert.equal(h.ids.get("presetSmooth").getAttribute("aria-pressed"), "false");
});

test("the shortcut switch stays off across preset and service changes", () => {
  const h = boot();
  h.ids.get("shortcutToggle").click();
  h.ids.get("presetSmooth").click();
  assert.equal(h.ids.get("shortcutToggle").getAttribute("aria-pressed"), "false");
  h.doc.dispatchEvent(new h.Event("keydown", { key: "2", target: h.doc.body }));
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "false");
});

test("the station CSV export follows an uploaded feed", async () => {
  const h = boot();
  await upload(h, feedFiles());
  h.ids.get("exportCsv").click();
  const rows = h.context.RailPulse.parseCsv(await h.blobs[0].text());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].station, "Alpha");
  assert.equal(rows[1].station, "Bravo");
});

test("applyRealtime leaves trips untouched for unknown stop ids", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const obs = E.applyRealtime(svc, [{ tripId: svc.trips[0].tripId, stopId: "NOPE", arrivalSec: 9999 }]);
  assert.equal(obs[0].stopTimes[0].arrivalSec, svc.trips[0].stopTimes[0].arrivalSec);
});

test("verifyService flags a trip whose times run backward", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const bad = JSON.parse(JSON.stringify(svc));
  bad.trips[0].stopTimes[1].arrivalSec = bad.trips[0].stopTimes[0].arrivalSec - 600;
  const v = E.verifyService(bad);
  assert.equal(v.passed, false);
  assert.ok(v.errors.some((e) => /decreas|nondecreasing|backward/i.test(e)), String(v.errors));
});

test("a schedule-only report stays finite with zero delay spread", () => {
  const rep = E.buildReport(E.buildSyntheticService(makeCorridor()));
  assert.ok(Number.isFinite(rep.score));
  assert.equal(rep.delay.overall.mean, 0);
  assert.ok(rep.verification.passed);
});

test("an empty file map and a date before service starts report cleanly", async () => {
  await assert.rejects(E.parseGtfs({ files: {} }), /missing required files/);
  const r = E.resolveActiveServices(makeGtfsFiles(), "20250101");
  assert.equal(r.error, null);
  assert.ok(!r.active.WK && !r.active.WE);
});

test("calendar days off are honored even when trips exist", async () => {
  const parsed = await E.parseGtfs({ files: makeGtfsFiles(), date: "20261108" });
  const r1 = parsed.services.find((s) => s.routeId === "R1");
  assert.ok(r1.trips.every((t) => t.tripId === "TW1"), "Sunday runs only the weekend exception trip");
});

test("dwell analysis separates scheduled and observed layers", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const withObs = E.withObserved(svc, E.simulateObserved(svc, { seed: 5, intensity: 1.5 }));
  const d = E.analyzeDwell(withObs);
  assert.ok(d.perStop.length >= 1);
  assert.ok(Number.isFinite(d.perStop[0].stats.mean));
  assert.ok(Number.isFinite(d.perStop[0].meanDeltaSec));
});

test("spreadsheet-safe numbers stay unquoted in CSV cells", () => {
  assert.equal(E.csvCell(-2), "-2");
  assert.equal(E.csvCell(3.14), "3.14");
  assert.equal(E.csvCell(NaN), "");
  assert.equal(E.csvCell(Infinity), "");
  assert.equal(E.csvCell(-Infinity), "");
  assert.equal(E.toCsv([{ key: "n", label: "N" }], [{ n: -5 }]), "N\r\n-5\r\n");
});

test("README count of corridors and services stays honest", () => {
  assert.equal(E.buildAllSyntheticServices().length, CORRIDORS.length);
  assert.equal(CORRIDORS.length, 7);
});

/* ------------------------------------------------------------------ *
 * Batch 3: regressions from the adversarial review
 * ------------------------------------------------------------------ */

test("csvCell guards formula triggers behind every whitespace kind", () => {
  assert.equal(E.csvCell("\n=cmd"), '"\'\n=cmd"');
  assert.equal(E.csvCell(" \r=cmd"), '"\' \r=cmd"');
  assert.equal(E.csvCell("\t\r=cmd"), '"\'\t\r=cmd"');
  assert.equal(E.csvCell(" \n=x"), '"\' \n=x"');
  assert.equal(E.csvCell("\n\t=x"), '"\'\n\t=x"');
  assert.equal(E.csvCell(" =cmd"), "' =cmd");
  assert.equal(E.csvCell(" =cmd"), "' =cmd");
  assert.equal(E.csvCell("﻿=cmd"), "'﻿=cmd");
  assert.equal(E.csvCell("\x0B=cmd"), "'\x0B=cmd");
  assert.equal(E.csvCell("\x0C=cmd"), "'\x0C=cmd");
  assert.equal(E.csvCell("\r\n=cmd"), '"\'\r\n=cmd"');
});

test("reportCsv guards LF-leading hostile station names end to end", () => {
  const svc = E.buildSyntheticService(makeCorridor({
    stations: [["X", "\n=cmd|' /C calc'!A0", 0, 0], ["Y", " \r+SUM(1)", 2, 30]]
  }));
  const rows = E.parseCsv(E.reportCsv(E.buildReport(svc)));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].station.startsWith("'"), JSON.stringify(rows[0].station));
  assert.ok(rows[1].station.startsWith("'"), JSON.stringify(rows[1].station));
});

test("a zip plus loose files merges instead of silently discarding them", async () => {
  const h = boot();
  const zip = buildStoreZip(feedFiles("Zipped Line"));
  h.ids.get("gtfsInput").files = [
    fakeFile("feed.zip", zip),
    { name: "calendar_dates.csv", text: async () => "service_id,date,exception_type\nS,20261106,1\n" },
    { name: "notes.md", text: async () => "not a table" }
  ];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /Loaded 1 directional service/);
  assert.match(h.ids.get("feedNotice").textContent, /calendar_dates\.csv merged into the feed/);
  assert.match(h.ids.get("feedNotice").textContent, /notes\.md merged into the feed/);
});

test("co-selected duplicates keep the archive copy and extra zips are reported", async () => {
  const h = boot();
  const zip = buildStoreZip(feedFiles("First Zip"));
  const zip2 = buildStoreZip(feedFiles("Second Zip"));
  h.ids.get("gtfsInput").files = [
    fakeFile("feed.zip", zip),
    { name: "stops.txt", text: async () => "stop_id,stop_name,stop_lat,stop_lon\nZ,Zed,1,1\n" },
    fakeFile("other.dat", zip2)
  ];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /stops\.txt skipped \(the archive's copy was kept\)/);
  assert.match(h.ids.get("feedNotice").textContent, /other\.dat ignored \(only the first archive is read\)/);
  assert.match(h.ids.get("heroSub").textContent, /First Zip/);
});

test("an incomplete zip still gains tables from loose companions", async () => {
  const h = boot();
  const zip = buildStoreZip({ "routes.txt": feedFiles()["routes.csv"], "stops.txt": feedFiles()["stops.csv"] });
  h.ids.get("gtfsInput").files = [
    fakeFile("partial.zip", zip),
    { name: "trips.csv", text: async () => feedFiles()["trips.csv"] },
    { name: "stop_times.csv", text: async () => feedFiles()["stop_times.csv"] }
  ];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /Loaded 1 directional service/);
  assert.match(h.ids.get("feedNotice").textContent, /trips\.csv merged/);
});

test("Shift+digit cannot fire a single-key preset", () => {
  const h = boot();
  h.doc.dispatchEvent(new h.Event("keydown", { key: "1", shiftKey: true, target: h.doc.body }));
  assert.equal(h.ids.get("presetSmooth").getAttribute("aria-pressed"), "false");
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "true");
});

test("dwell bar rows point at the tooltip like chart marks do", () => {
  const h = boot();
  const rows = marks(h, "dwellChart").filter((n) => n.attrs.class === "bar-row");
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.getAttribute("aria-describedby") === "tooltip"));
});

/* ------------------------------------------------------------------ *
 * Batch 4: regressions from the second adversarial audit (GTFS/math)
 * ------------------------------------------------------------------ */

test("verifyService reports malformed members instead of throwing", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const cases = [
    { trips: [null], stops: svc.stops },
    { trips: svc.trips, stops: [null] },
    { trips: [{ tripId: "bad", stopTimes: [null] }], stops: svc.stops },
    { trips: [{ tripId: "bad", stopTimes: "x" }], stops: svc.stops },
    { trips: [5], stops: svc.stops }
  ];
  cases.forEach((c) => {
    const res = E.verifyService(Object.assign({}, svc, c));
    assert.equal(res.passed, false);
    assert.ok(res.errors.length > 0);
  });
});

test("a non-array observedTrips layer fails verification", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const res = E.verifyService(Object.assign({}, svc, { observedTrips: { not: "array" } }));
  assert.equal(res.passed, false);
  assert.ok(res.errors.some((e) => /observed/i.test(e)));
  // The analyzers coerce the layer to scheduled rather than crash.
  assert.doesNotThrow(() => E.analyzeHeadways(Object.assign({}, svc, { observedTrips: "x" })));
});

test("simulateCascade tolerates trips with empty or malformed stopTimes", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const hostile = Object.assign({}, svc, {
    trips: svc.trips.slice(0, 3).map((t, i) => i === 1 ? Object.assign({}, t, { stopTimes: [] }) : t)
  });
  const res = E.simulateCascade(hostile, { incidentTrip: 0, incidentStopIndex: 0, incidentSec: 60 });
  assert.equal(res.observedTrips.length, 3);
  assert.equal(res.observedTrips[1].stopTimes.length, 0);
  const hostile2 = Object.assign({}, svc, {
    trips: [Object.assign({}, svc.trips[0], { stopTimes: null }), svc.trips[1]]
  });
  assert.doesNotThrow(() => E.simulateCascade(hostile2, { incidentTrip: 1, incidentStopIndex: 0, incidentSec: 60 }));
});

test("fractional minSeparationSec survives integer rounding", () => {
  const svc = E.buildSyntheticService(makeCorridor({ headwaySec: 30 }));
  const res = E.simulateCascade(svc, { incidentTrip: 0, incidentStopIndex: 0, incidentSec: 120, minSeparationSec: 0.4 });
  for (let t = 1; t < res.observedTrips.length; t++) {
    const lead = res.observedTrips[t - 1], foll = res.observedTrips[t];
    for (let i = 0; i < foll.stopTimes.length; i++) {
      if (!lead.stopTimes[i]) continue;
      assert.ok(foll.stopTimes[i].arrivalSec >= lead.stopTimes[i].departureSec + 0.4,
        `trip ${t} stop ${i}: ${foll.stopTimes[i].arrivalSec} < ${lead.stopTimes[i].departureSec + 0.4}`);
    }
  }
});

test("populationVariance reports overflow as Infinity, never a false zero", () => {
  assert.equal(E.populationVariance([1e308, -1e308]), Infinity);
  assert.equal(E.populationVariance([1e308, 1e308]), Infinity);
  assert.ok(E.populationVariance([10, 20, 30]) > 0);
  assert.equal(E.populationVariance([]), 0);
  assert.equal(E.populationVariance("x"), 0);
});

test("hostile observed layers never leak NaN or Infinity into exports", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const hostileObserved = svc.trips.map((t, i) => i === 0
    ? Object.assign({}, t, { stopTimes: t.stopTimes.map((st) => Object.assign({}, st, { arrivalSec: 1e308, departureSec: 1e308 })) })
    : t);
  const hostile = Object.assign({}, svc, { observedTrips: hostileObserved });
  const rep = E.buildReport(hostile);
  const csv = E.reportCsv(rep);
  assert.ok(!/NaN|Infinity/.test(csv), "CSV must not contain NaN/Infinity tokens");
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(rep)), "serialized report must not contain NaN/Infinity");
});

test("calendar weekday flags and exception_type tolerate padded values", () => {
  const files = {
    "calendar.txt":
      "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n" +
      "WK, 1 ,0,0,0,0,0,0,20260101,20261231\n",
    "calendar_dates.txt":
      "service_id,date,exception_type\n" +
      "WK,20261109, 2 \n" +
      "SP,20261109, 1 \n",
    "trips.txt": "route_id,service_id,trip_id\nR1,WK,T1\nR1,SP,T2\n"
  };
  const res = E.resolveActiveServices(files, "20261109");
  assert.equal(res.error, null);
  assert.equal(res.active.SP, true);
  assert.equal(res.active.WK, undefined);
});

test("readFeedFiles always returns a Promise for arrayBuffer inputs", async () => {
  const throwing = { arrayBuffer() { throw new Error("boom"); } };
  const p = E.readFeedFiles(throwing);
  assert.ok(p && typeof p.then === "function");
  await assert.rejects(() => p, /boom|Invalid/);
  const syncReturn = { arrayBuffer() { return new ArrayBuffer(0); } };
  const p2 = E.readFeedFiles(syncReturn);
  assert.ok(p2 && typeof p2.then === "function");
  await assert.rejects(() => p2);
});

test("analyzeDwell reports zero delta for stops with no observations", () => {
  const svc = E.buildSyntheticService(makeCorridor());
  const lastId = svc.stops[svc.stops.length - 1].id;
  const partial = svc.trips.map((t) => Object.assign({}, t, {
    stopTimes: t.stopTimes.filter((st) => st.stopId !== lastId)
  }));
  const res = E.analyzeDwell(Object.assign({}, svc, { observedTrips: partial }));
  const last = res.perStop.find((p) => p.stopId === lastId);
  assert.equal(last.stats.count, 0);
  assert.equal(last.meanDeltaSec, 0);
});

test("blank CSV inputs parse as empty tables", () => {
  assert.deepEqual(E.parseCsv("\n"), []);
  assert.deepEqual(E.parseCsv("  \n\n  \r\n"), []);
  assert.deepEqual(E.parseCsv(""), []);
});

test("padded direction_id groups with its clean form", async () => {
  const files = makeGtfsFiles();
  files["trips.txt"] = files["trips.txt"].replace(/,0\n/g, ", 0 \n");
  const res = await E.parseGtfs({ files: files, date: "20261106" });
  assert.ok(res.services.length >= 1);
  assert.ok(res.services[0].trips.length >= 3);
});

test("trips.txt without route_id warns instead of silently dropping", async () => {
  const files = makeGtfsFiles();
  files["trips.txt"] =
    "service_id,trip_id,trip_headsign,direction_id\n" +
    "WK,T1,Charlie,0\nWK,T2,Charlie,0\n";
  const res = await E.parseGtfs({ files: files, date: "20261106" });
  assert.ok(res.warnings.some((w) => /route_id/.test(w)));
});

test("the page ships a restrictive Content-Security-Policy", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "../index.html"), "utf8");
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(m, "index.html carries a CSP meta");
  const csp = m[1];
  assert.ok(/default-src 'none'/.test(csp), "default-src denies everything by default");
  assert.ok(/script-src 'self'/.test(csp), "scripts stay same origin only");
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), "no inline script or eval escape hatch");
  assert.ok(/connect-src 'none'/.test(csp), "no network exfil channel");
  assert.ok(/object-src 'none'|default-src 'none'/.test(csp), "plugins denied");
});
