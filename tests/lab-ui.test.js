/* RailPulse dispatch-lab DOM tests.
 *
 * Drives the real page scripts through the deterministic DOM fixture and
 * checks the laboratory controls, stringline charts, audit exports,
 * verification, bookmarking and the in-page self-test panel.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../corridors.js");
const E = require("../engine.js");
const L = require("../dispatch-lab.js");
const { boot, change, marks, assertFiniteSvg } = require("./dom-fixture.js");

function tableRows(h) {
  const table = h.ids.get("labTable").children.find(n => n.tagName === "TABLE");
  const tbody = table.children.find(n => n.tagName === "TBODY");
  return tbody ? tbody.children : [];
}
function tableHeader(h) {
  const table = h.ids.get("labTable").children.find(n => n.tagName === "TABLE");
  const thead = table.children.find(n => n.tagName === "THEAD");
  return thead ? thead.children[0].children.map(c => c.textContent) : [];
}
function rowCells(row) { return row.children.map(c => c.textContent); }

test("lab controls are populated: 5 strategies, 3 perturbations", () => {
  const h = boot();
  const st = h.ids.get("labStrategy"), ev = h.ids.get("labEvent");
  assert.equal(st.children.length, 5);
  assert.equal(ev.children.length, 3);
  assert.deepEqual(st.children.map(o => o.value), ["fixed", "sched", "even", "skip", "cbtc"]);
  assert.equal(st.value, "even");
  assert.equal(ev.value, "surge");
});

test("metrics table renders one row per strategy with real numbers", () => {
  const h = boot();
  const rows = tableRows(h);
  assert.equal(rows.length, 5);
  const header = tableHeader(h);
  for (const col of ["strategy", "cv", "e[w]", "viol", "bunch", "recovery"]) {
    const needle = col.toLowerCase();
    assert.ok(header.some(c => c.toLowerCase().includes(needle)), `missing column ${col}`);
  }
  rows.forEach(r => {
    const cells = rowCells(r);
    assert.ok(cells.length >= 8);
    assert.match(cells[1], /^\d+\.\d+$/, `CV cell ${cells[1]}`);
  });
});

test("scenario line names the perturbation and active strategy", () => {
  const h = boot();
  assert.match(h.ids.get("labScenario").textContent, /Perturbation:/);
  assert.match(h.ids.get("labScenario").textContent, /headway-equalization/i);
});

test("both stringlines draw clipped train paths with finite coordinates", () => {
  const h = boot();
  for (const id of ["labBaselineChart", "labStrategyChart"]) {
    const paths = marks(h, id).filter(n => n.tagName === "PATH");
    assert.ok(paths.length >= 10, `${id} only drew ${paths.length} paths`);
    assert.ok(marks(h, id).some(n => n.getAttribute("clip-path")), `${id} has no plot clip`);
  }
  assertFiniteSvg(h);
});

test("CV chart draws a pair of bars per strategy with labels", () => {
  const h = boot();
  const m = marks(h, "labCvChart");
  const rects = m.filter(n => n.tagName === "RECT");
  const texts = m.filter(n => n.tagName === "TEXT");
  assert.ok(rects.length >= 10, `expected >= 10 bars, got ${rects.length}`);
  assert.ok(texts.length >= 10, "strategy labels missing");
  assertFiniteSvg(h);
});

test("switching strategy re-renders the selected chart and hash", () => {
  const h = boot();
  change(h, "labStrategy", "cbtc");
  assert.match(h.ids.get("labStrategyTitle").textContent, /moving-block|CBTC/i);
  const rows = tableRows(h);
  const selected = rows.filter(r => (r.attrs.class || "").includes("lab-active"));
  assert.equal(selected.length, 1);
  assert.match(rowCells(selected[0])[0], /CBTC|moving/i);
  assert.equal(L.decodeRpHash(h.location.hash).lab.strategy, "cbtc");
});

test("switching perturbation changes the scenario text and table", () => {
  const h = boot();
  const before = rowCells(tableRows(h)[0]).join("|");
  change(h, "labEvent", "incident900");
  assert.match(h.ids.get("labScenario").textContent, /900/);
  const after = rowCells(tableRows(h)[0]).join("|");
  assert.notEqual(before, after);
});

test("self-test panel reports every check passing", () => {
  const h = boot();
  h.ids.get("labSelfTests").click();
  const results = L.runSelfTests();
  assert.match(h.ids.get("selfTestSummary").textContent, new RegExp(results.length + " / " + results.length + " self-tests pass"));
  const rows = h.ids.get("selfTestList").children;
  assert.equal(rows.length, results.length);
  assert.ok(rows.every(r => (r.getAttribute("class") || "").includes("pass")));
});

test("JSON audit download is a digest-verifiable brief", async () => {
  const h = boot();
  h.ids.get("labExportJson").click();
  assert.equal(h.downloads[0].name, "railpulse-audit.json");
  const text = await h.blobs[h.blobs.length - 1].text();
  const brief = JSON.parse(text);
  assert.ok(/^[0-9a-f]{64}$/.test(brief.integrity.digest));
  assert.equal(L.verifyAudit(text).valid, true);
  assert.match(h.ids.get("labStatus").textContent, /SHA-256/);
});

test("CSV and Markdown exports download with safe names", () => {
  const h = boot();
  h.ids.get("labExportCsv").click();
  h.ids.get("labExportMd").click();
  assert.equal(h.downloads[0].name, "railpulse-audit.csv");
  assert.equal(h.downloads[1].name, "railpulse-audit.md");
});

test("verify button approves a fresh brief and flags a tampered one", async () => {
  const h = boot();
  h.ids.get("labVerifyBtn").click();
  assert.equal(h.ids.get("labVerifyStatus").getAttribute("class"), "lab-status ok");
  assert.match(h.ids.get("labVerifyStatus").textContent, /verified|unmodified/i);

  h.ids.get("labExportJson").click();
  const tampered = JSON.parse(await h.blobs[h.blobs.length - 1].text());
  tampered.strategies[0].metrics.expectedWaitSec += 5;
  h.ids.get("labVerifyInput").value = JSON.stringify(tampered);
  h.ids.get("labVerifyBtn").click();
  assert.equal(h.ids.get("labVerifyStatus").getAttribute("class"), "lab-status bad");
  assert.match(h.ids.get("labVerifyStatus").textContent, /Not verified/);
});

test("verify button rejects garbage input without throwing", () => {
  const h = boot();
  h.ids.get("labVerifyInput").value = "totally not an audit brief";
  h.ids.get("labVerifyBtn").click();
  assert.equal(h.ids.get("labVerifyStatus").getAttribute("class"), "lab-status bad");
  assert.match(h.ids.get("labVerifyStatus").textContent, /Not verified/);
});

test("bookmark button writes a strict #rp= hash", () => {
  const h = boot();
  h.ids.get("labBookmark").click();
  assert.match(h.location.hash, /^#rp=[A-Za-z0-9\-_]+$/);
  const decoded = L.decodeRpHash(h.location.hash);
  assert.equal(decoded.svc, "cta-red");
  assert.deepEqual(decoded.lab, { strategy: "even", event: "surge" });
  assert.match(h.ids.get("labStatus").textContent, /address bar|clipboard/i);
});

test("booting with a bookmark applies corridor, strategy and perturbation", () => {
  const hash = L.encodeRpHash({ svc: "cta-red", sc: "smooth", layer: "scheduled", lab: { strategy: "skip", event: "incident900" } });
  const h = boot(1180, false, hash);
  assert.equal(h.ids.get("labStrategy").value, "skip");
  assert.equal(h.ids.get("labEvent").value, "incident900");
  assert.match(h.ids.get("labScenario").textContent, /900/);
  assert.match(h.ids.get("labStrategyTitle").textContent, /skip-stop/i);
});

test("a corrupt bookmark is ignored and the app still boots", () => {
  const h = boot(1180, false, "#rp=%%%%corrupt%%%%");
  assert.equal(h.ids.get("labStrategy").value, "even");
  assert.equal(tableRows(h).length, 5);
});

test("lab renders on every bundled corridor with finite SVG", () => {
  const h = boot(320);
  for (const corridor of globalThis.RailPulse.CORRIDORS) {
    change(h, "serviceSelect", corridor.id);
    assert.equal(tableRows(h).length, 5, corridor.id);
    assert.ok(marks(h, "labStrategyChart").filter(n => n.tagName === "PATH").length >= 4, corridor.id);
    assertFiniteSvg(h);
  }
});

test("lab charts survive a theme flip", () => {
  const h = boot();
  h.ids.get("themeToggle").click();
  assert.equal(tableRows(h).length, 5);
  assert.ok(marks(h, "labCvChart").filter(n => n.tagName === "RECT").length >= 10);
});

test("lab renders after a GTFS upload", async () => {
  const files = {
    "routes.csv": "route_id,route_short_name,route_type\nR,MINI,1\n",
    "stops.csv": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,41.88,-87.63\nB,Bravo,41.87,-87.63\nC,Charlie,41.86,-87.63\n",
    "calendar.csv": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20261231\n",
    "trips.csv": "route_id,service_id,trip_id,direction_id\nR,S,T1,0\nR,S,T2,0\nR,S,T3,0\nR,S,T4,0\n",
    "stop_times.csv": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:30,A,1\nT1,08:05:00,08:05:30,B,2\nT1,08:10:00,08:10:30,C,3\nT2,08:05:00,08:05:30,A,1\nT2,08:10:00,08:10:30,B,2\nT2,08:15:00,08:15:30,C,3\nT3,08:10:00,08:10:30,A,1\nT3,08:15:00,08:15:30,B,2\nT3,08:20:00,08:20:30,C,3\nT4,08:15:00,08:15:30,A,1\nT4,08:20:00,08:20:30,B,2\nT4,08:25:00,08:25:30,C,3\n"
  };
  const h = boot();
  h.ids.get("gtfsInput").files = Object.entries(files).map(([name, text]) => ({ name, text: async () => text }));
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /Loaded/);
  assert.equal(tableRows(h).length, 5);
  assert.ok(marks(h, "labBaselineChart").filter(n => n.tagName === "PATH").length >= 2);
  assertFiniteSvg(h);
});

test("assumption note discloses the unkeyed digest and queue model", () => {
  const h = boot();
  const t = h.ids.get("labAssumptionNote").textContent;
  assert.match(t, /unkeyed|tamper/i);
  assert.match(t, /single-track|queue/i);
});
