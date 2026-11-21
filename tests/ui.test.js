"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// The deterministic DOM fixture lives in dom-fixture.js so every test file
// can evaluate the actual browser scripts against the actual markup.
const { boot, change, marks, assertFiniteSvg } = require("./dom-fixture.js");

test("browser scripts boot from the real markup without reference errors", () => {
  const h = boot();
  assert.match(h.ids.get("verificationBadge").textContent, /timestamp round trips verified/);
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "true");
  assert.match(h.ids.get("trainReadout").textContent, /RED-CTA-05/);
  assertFiniteSvg(h);
});
test("DOMContentLoaded and immediate startup render the same scenario", () => {
  const a = boot(), b = boot(1180, true);
  assert.equal(a.ids.get("heroScore").textContent, b.ids.get("heroScore").textContent);
  assert.equal(a.ids.get("baselineWait").textContent, b.ids.get("baselineWait").textContent);
});
test("all three showcase controls execute actual event bindings", () => {
  const h = boot();
  h.ids.get("presetSmooth").click();
  assert.equal(h.ids.get("kpiEwt").textContent, "0s");
  assert.equal(h.ids.get("heroScore").textContent, "100");
  h.ids.get("presetRecovery").click();
  assert.equal(h.ids.get("presetRecovery").getAttribute("aria-pressed"), "true");
  assert.ok(parseFloat(h.ids.get("recoveryWait").textContent) < parseFloat(h.ids.get("baselineWait").textContent));
  assertFiniteSvg(h);
});
test("preset keyboard shortcuts respect input focus and modifiers", () => {
  const h = boot();
  h.doc.dispatchEvent(new h.Event("keydown", { key: "1", target: h.doc.body }));
  assert.equal(h.ids.get("presetSmooth").getAttribute("aria-pressed"), "true");
  h.doc.dispatchEvent(new h.Event("keydown", { key: "2", target: h.ids.get("dateInput") }));
  assert.equal(h.ids.get("presetSmooth").getAttribute("aria-pressed"), "true");
  h.doc.dispatchEvent(new h.Event("keydown", { key: "3", ctrlKey: true, target: h.doc.body }));
  assert.equal(h.ids.get("presetRecovery").getAttribute("aria-pressed"), "false");
});
test("train marks expose exact inspections through keyboard focus", () => {
  const h = boot();
  const hit = marks(h, "stringlineChart").find(n => n.attrs.class === "hit");
  assert.match(hit.getAttribute("aria-label"), /Inspect train/);
  hit.focus();
  assert.equal(h.ids.get("tooltip").hidden, false);
  assert.ok(!/NaN/.test(h.ids.get("tooltip").style.left));
  assert.match(h.ids.get("trainReadout").textContent, /RED-CTA-01/);
  hit.dispatchEvent(new h.Event("keydown", { key: "Escape" }));
  assert.equal(h.ids.get("tooltip").hidden, true);
});
test("train select updates the station timing ledger", () => {
  const h = boot(); change(h, "trainSelect", "RED-CTA-05");
  assert.match(h.ids.get("trainTable").textContent, /15m 25s/);
  assert.match(h.ids.get("trainReadout").textContent, /\+15m/);
});
test("scheduled layer and disruption control changes leave the presets", () => {
  const h = boot(); change(h, "layerSelect", "scheduled");
  assert.equal(h.ids.get("scenarioStrip").hidden, true);
  assert.equal(h.ids.get("heroScore").textContent, "100");
  change(h, "intensitySelect", "2.8");
  assert.equal(h.ids.get("layerSelect").value, "simulated");
  assertFiniteSvg(h);
});
test("every corridor and time window renders finite clipped vector marks", () => {
  const h = boot(320);
  for (const corridor of h.context.RailPulse.CORRIDORS) {
    change(h, "serviceSelect", corridor.id);
    for (const window of ["focus", "morning", "midday", "evening", "full"]) { change(h, "timeWindow", window); assertFiniteSvg(h); }
  }
  assert.ok(marks(h, "stringlineChart").some(n => n.getAttribute("clip-path") === "url(#mareyPlotClip)"));
});
test("table controls synchronize visibility and accessible expanded state", () => {
  const h = boot();
  for (const button of h.doc.querySelectorAll(".toggle-table")) {
    const table = h.ids.get(button.getAttribute("data-table")), before = table.hidden;
    button.click(); assert.equal(table.hidden, !before);
    assert.equal(button.getAttribute("aria-expanded"), String(!table.hidden));
    assert.equal(button.getAttribute("aria-controls"), table.id);
  }
});
test("theme toggle, reset and report export have live bindings", () => {
  const h = boot(); h.ids.get("themeToggle").click();
  assert.equal(h.doc.documentElement.getAttribute("data-theme"), "dark");
  h.ids.get("presetSmooth").click(); h.ids.get("demoReset").click();
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "true");
  h.ids.get("exportReport").click();
  assert.equal(h.downloads[0].name, "railpulse-dispatch.json");
  assert.equal(h.revoked[0], "blob:dispatch");
});
test("GTFS load errors display a recoverable status and preserve the current view", async () => {
  const h = boot(), score = h.ids.get("heroScore").textContent;
  h.ids.get("gtfsInput").files = [{ name: "trips.txt", text: async () => "route_id,trip_id\nR,T\n" }];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.ids.get("feedNotice").textContent, /missing required files/);
  assert.equal(h.ids.get("heroScore").textContent, score);
  assert.equal(h.ids.get("feedNotice").getAttribute("aria-live"), "polite");
});
test("reset discards a pending GTFS upload before it can replace the scenario", async () => {
  const h = boot(); let resolve;
  const delayed = new Promise(r => { resolve = r; });
  h.ids.get("gtfsInput").files = [{ name: "trips.txt", text: () => delayed }];
  h.ids.get("gtfsInput").dispatchEvent(new h.Event("change"));
  h.ids.get("demoReset").click(); resolve("route_id,trip_id\nR,T\n");
  await new Promise(r => setImmediate(r));
  assert.equal(h.ids.get("feedNotice").hidden, true);
  assert.equal(h.ids.get("presetIncident").getAttribute("aria-pressed"), "true");
});

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
test("valid loose CSV upload rebuilds the actual corridor and train controls", async () => {
  const h = boot(); await upload(h, feedFiles());
  assert.match(h.ids.get("feedNotice").textContent, /Loaded 1 directional service/);
  assert.match(h.ids.get("heroSub").textContent, /Local Line/);
  assert.equal(h.ids.get("trainSelect").children.length, 2);
  assert.equal(h.ids.get("scenarioStrip").hidden, true); assertFiniteSvg(h);
});
test("uploaded labels remain inert text in tables, route choices and tooltips", async () => {
  const h = boot(); await upload(h, feedFiles("<img src=x onerror=run() >"));
  assert.match(h.ids.get("heroSub").textContent, /<img/);
  for (const node of h.doc.querySelectorAll("div")) assert.ok(!node.innerHTML.includes("<img"));
  assert.equal(h.doc.querySelectorAll("img").length, 0);
});
test("invalid date reanalysis uses the cached feed and preserves its usable view", async () => {
  const h = boot(); await upload(h, feedFiles());
  h.ids.get("gtfsInput").files = []; change(h, "dateInput", "20260230");
  await new Promise(r => setImmediate(r));
  assert.match(h.ids.get("feedNotice").textContent, /Invalid service date/);
  assert.match(h.ids.get("heroSub").textContent, /Local Line/);
});
test("downloaded report contains measured verification and active scenario data", async () => {
  const h = boot(); h.ids.get("exportReport").click();
  const report = JSON.parse(await h.blobs[0].text());
  assert.equal(report.scenario, "incident"); assert.equal(report.report.verification.passed, true);
  assert.equal(report.report.verification.roundTrips, 2112); assert.equal(report.report.service.tripCount, 16);
});
test("trips named __proto__ render valid finite SVG stroke colors and aria labels", async () => {
  const h = boot();
  const files = {
    "routes.csv": "route_id,route_long_name,route_type\nR,Proto Line,1\n",
    "stops.csv": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,41.88,-87.63\nB,Bravo,41.85,-87.63\n",
    "trips.csv": "route_id,service_id,trip_id,direction_id\nR,S,__proto__,0\nR,S,T2,0\n",
    "stop_times.csv": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n__proto__,08:00:00,08:00:30,A,1\n__proto__,08:05:00,08:05:30,B,2\nT2,08:10:00,08:10:30,A,1\nT2,08:15:00,08:15:30,B,2\n"
  };
  await upload(h, files);
  assertFiniteSvg(h);
  const paths = [...h.doc.querySelectorAll("path")];
  assert.ok(paths.some(p => (p.getAttribute("aria-label") || "").includes("Inspect train __proto__")));
  for (const p of paths) {
    assert.ok(!String(p.getAttribute("stroke") || "").includes("NaN"), p.getAttribute("stroke"));
    assert.ok(!String(p.getAttribute("aria-label") || "").includes("NaN"), p.getAttribute("aria-label"));
  }
});

