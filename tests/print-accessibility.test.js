"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

test("print stylesheet declares page margins and strips interactive workbench controls", () => {
  assert.match(css, /@media print\s*\{[\s\S]*@page\s*\{\s*margin:\s*12mm;/);
  assert.match(css, /\.skip-link, \.topbar-actions, \.presets, \.controls, button, input, select, textarea, summary, a\[href\]/);
  assert.match(css, /#dispatchLab/);
});

test("print stylesheet keeps summary cards together across page breaks", () => {
  assert.match(css, /\.scenario-strip, \.card\s*\{[\s\S]*break-inside:\s*avoid;/);
  assert.match(css, /page-break-inside:\s*avoid;/);
});

test("primary controls keep a 44 pixel touch target", () => {
  assert.match(css, /\.btn\s*\{[\s\S]*min-height:\s*44px;/);
  assert.match(css, /\.control select, \.control input\[type="text"\], \.control input\[type="file"\],[\s\S]*min-height:\s*44px;/);
  assert.match(css, /summary\s*\{\s*min-height:\s*44px;[\s\S]*border:\s*1px solid var\(--border\);/);
  assert.match(css, /\.bar-row\s*\{[\s\S]*min-height:\s*44px;[\s\S]*border:\s*1px solid var\(--border\);/);
});

test("placeholder text uses the high contrast secondary ink", () => {
  assert.match(css, /input::placeholder\s*\{\s*color:\s*var\(--text-secondary\);\s*opacity:\s*1;/);
});

test("dispatch laboratory charts reserve enough right padding for terminal time labels", () => {
  assert.match(app, /var W = 470, H = 300, padL = 66, padR = 36, padT = 24, padB = 30;/);
});

test("control borders use the AA non-text contrast ink", () => {
  assert.match(css, /:root \{ --border: #6e6c65; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ --border: #858278; \}/);
});
