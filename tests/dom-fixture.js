"use strict";
/* Shared deterministic DOM fixture: evaluates the actual browser scripts and
 * binds controls from the actual markup. No third-party DOM package needed.
 * Require this from test files; it is not a test file itself. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function boot(width = 1180, loading = false, initialHash = "") {
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
  const colors = { "--div-mid": "#7d7970", "--div-cool": "#1b4d89", "--div-warm": "#c8102e", "--series-1": "#1b4d89", "--series-2": "#c8102e", "--series-3": "#1e6b47", "--axis": "#8c887e", "--warning": "#965407", "--rule-heavy": "#141413", "--good": "#1e6b47" };
  const location = { hash: initialHash || "", href: "http://localhost/index.html" + (initialHash || ""), origin: "http://localhost", pathname: "/index.html" };
  const history = { replaceState: (_s, _t, url) => { if (typeof url === "string") { const i = url.indexOf("#"); location.hash = i >= 0 ? url.slice(i) : ""; } } };
  const context = { document: doc, Event: FixtureEvent, Blob, TextDecoder, TextEncoder, ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int32Array, DataView, setTimeout: fn => { fn(); return 1; }, URL: { createObjectURL: blob => { blobs.push(blob); return "blob:dispatch"; }, revokeObjectURL: url => revoked.push(url) }, getComputedStyle: () => ({ getPropertyValue: name => colors[name] || "#141413" }), innerWidth: width, innerHeight: 800, console, location, history };
  context.window = context; context.globalThis = context;
  vm.createContext(context);
  for (const script of ["corridors.js", "engine.js", "dispatch-lab.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", script), "utf8"), context, { filename: script });
  if (loading) doc.dispatchEvent(new FixtureEvent("DOMContentLoaded"));
  return { context, doc, ids, Event: FixtureEvent, downloads, revoked, blobs, location, history };
}
function change(h, id, value) { const node = h.ids.get(id); node.value = value; node.dispatchEvent(new h.Event("change")); }
function marks(h, id) { const out = []; const walk = n => { out.push(n); n.children.forEach(walk); }; walk(h.ids.get(id)); return out; }
function assertFiniteSvg(h) {
  for (const id of ["stringlineChart", "corridorMap", "headwayChart", "todChart", "delayChart", "labBaselineChart", "labStrategyChart", "labCvChart"]) for (const n of marks(h, id)) {
    for (const [key, value] of Object.entries(n.attrs)) if (["d", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "cx", "cy", "r", "points"].includes(key)) assert.ok(!/NaN|Infinity|undefined/.test(value), id + " " + key + "=" + value);
    if (n.attrs.width) assert.ok(Number(n.attrs.width) >= 0, "nonnegative width");
  }
}

module.exports = { boot, change, marks, assertFiniteSvg };
