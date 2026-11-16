"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// A deterministic DOM fixture evaluates the actual browser scripts and binds
// controls from the actual markup. No third-party DOM package is required.
function boot(width = 1180, loading = false) {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const ids = new Map(), downloads = [], revoked = [], blobs = [];
  let doc;
  class FixtureEvent {
    constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); }
    preventDefault() { this.defaultPrevented = true; }
  }
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this._text = ""; this._value = ""; this.hidden = false; this.parentNode = null; this.offsetWidth = 220; this.offsetHeight = 100; this.files = []; }
    get id() { return this.attrs.id || ""; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
    get firstChild() { return this.children[0] || null; }
    get className() { return this.attrs.class || ""; }
    set className(value) { this.attrs.class = value; }
    set textContent(value) { this._text = String(value); this.children.forEach(n => { n.parentNode = null; }); this.children = []; }
    get textContent() { return this._text + this.children.map(n => n.textContent).join(""); }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html || ""; }
    set value(value) { this._value = String(value); }
    get value() { return this._value; }
    setAttribute(name, value) { this.attrs[name] = String(value); if (name === "id") { assert.ok(!ids.has(value) || !ids.get(value).isConnected, "duplicate live id " + value); ids.set(value, this); } if (name === "hidden") this.hidden = true; if (name === "value") this._value = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    appendChild(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.children.push(node); if (this.tagName === "SELECT" && node.tagName === "OPTION" && (!this._value || node.attrs.selected !== undefined)) this._value = node.value; return node; }
    removeChild(node) { const i = this.children.indexOf(node); if (i < 0) throw new Error("Removing absent child"); this.children.splice(i, 1); node.parentNode = null; if (node.id && ids.get(node.id) === node) ids.delete(node.id); return node; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatchEvent(event) { event.target ||= this; (this.listeners[event.type] || []).forEach(fn => fn(event)); return !event.defaultPrevented; }
    focus() { doc.activeElement = this; this.dispatchEvent(new FixtureEvent("focus")); }
    click() { if (this.tagName === "A" && this.download) downloads.push({ name: this.download, href: this.href }); this.dispatchEvent(new FixtureEvent("click")); }
    getBoundingClientRect() { return { left: 10, top: 30, width: Math.min(width, 980), height: 200, right: width, bottom: 230 }; }
  }
  const root = new Element("html"), body = new Element("body");
  doc = {
    documentElement: root, body, activeElement: body, readyState: loading ? "loading" : "complete", listeners: {},
    createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
    getElementById: id => ids.get(id) || null,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { event.target ||= body; (this.listeners[event.type] || []).forEach(fn => fn(event)); },
    querySelectorAll(selector) { const all = []; const walk = n => { all.push(n); n.children.forEach(walk); }; walk(root); return all.filter(n => selector[0] === "." ? n.className.split(/\s+/).includes(selector.slice(1)) : /^\[.+\]$/.test(selector) ? n.getAttribute(selector.slice(1, -1)) !== null : n.tagName.toLowerCase() === selector); }
  };
  const stack = [];
  const voidTags = new Set(["meta", "link", "input", "br", "hr"]);
  for (const token of html.matchAll(/<!--[^]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g)) {
    const text = token[0];
    if (text.startsWith("<!")) continue;
    if (text.startsWith("</")) { stack.pop(); continue; }
    if (!text.startsWith("<")) { if (stack.length) stack[stack.length - 1]._text += text; continue; }
    const tag = /^<([\w-]+)/.exec(text)?.[1];
    if (!tag) continue;
    const node = tag === "html" ? root : tag === "body" ? body : new Element(tag);
    const attrs = text.slice(tag.length + 1, -1);
    for (const attr of attrs.matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)')?/g)) node.setAttribute(attr[1], attr[2] ?? attr[3] ?? "");
    if (stack.length) stack[stack.length - 1].appendChild(node);
    if (!voidTags.has(tag) && !text.endsWith("/>")) stack.push(node);
  }
  const colors = { "--div-mid": "#7d7970", "--div-cool": "#1b4d89", "--div-warm": "#c8102e", "--series-1": "#1b4d89", "--series-2": "#c8102e", "--series-3": "#1e6b47", "--axis": "#8c887e", "--warning": "#965407", "--rule-heavy": "#141413" };
  const context = { document: doc, Event: FixtureEvent, Blob, TextDecoder, TextEncoder, ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, DataView, setTimeout: fn => { fn(); return 1; }, URL: { createObjectURL: blob => { blobs.push(blob); return "blob:dispatch"; }, revokeObjectURL: url => revoked.push(url) }, getComputedStyle: () => ({ getPropertyValue: name => colors[name] || "#141413" }), innerWidth: width, innerHeight: 800, console };
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  for (const script of ["corridors.js", "engine.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", script), "utf8"), context, { filename: script });
  if (loading) doc.dispatchEvent(new FixtureEvent("DOMContentLoaded"));
  return { context, doc, ids, Event: FixtureEvent, downloads, revoked, blobs };
}
function change(h, id, value) { const node = h.ids.get(id); node.value = value; node.dispatchEvent(new h.Event("change")); }
function marks(h, id) { const out = []; const walk = n => { out.push(n); n.children.forEach(walk); }; walk(h.ids.get(id)); return out; }
function assertFiniteSvg(h) {
  for (const id of ["stringlineChart", "corridorMap", "headwayChart", "todChart", "delayChart"]) for (const n of marks(h, id)) {
    for (const [key, value] of Object.entries(n.attrs)) if (["d", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "cx", "cy", "r", "points"].includes(key)) assert.ok(!/NaN|Infinity|undefined/.test(value), id + " " + key + "=" + value);
    if (n.attrs.width) assert.ok(Number(n.attrs.width) >= 0, "nonnegative width");
  }
}

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

