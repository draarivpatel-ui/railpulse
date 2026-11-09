/* RailPulse web app.
 * Wires the analysis engine to an offline, dependency-free SBB / Tufte style
 * graphic timetable dispatch desk. SVG charts are drawn directly so the page
 * works from a static file with no build step and no external libraries. */
(function () {
  "use strict";
  var E = window.RailPulse;
  var SVGNS = "http://www.w3.org/2000/svg";

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */
  var state = {
    baseServices: [],        // normalized Services (synthetic or GTFS)
    source: "demo",          // "demo" | "gtfs"
    serviceId: null,
    layer: "simulated",
    intensity: 1,
    date: null,
    gtfsWarnings: [],
    report: null,
    workingService: null
  };

  /* ---------------------------------------------------------------- *
   * Small DOM and color helpers
   * ---------------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function el(tag, attrs, parent) {
    var node = document.createElementNS(SVGNS, tag);
    setAttrs(node, attrs);
    if (parent) parent.appendChild(node);
    return node;
  }
  function setAttrs(node, attrs) {
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        node.setAttribute(k, attrs[k]);
      }
    }
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function hexToRgb(hex) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function lerpColor(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b), out = [];
    for (var i = 0; i < 3; i++) out.push(Math.round(ca[i] + (cb[i] - ca[i]) * t));
    return "rgb(" + out[0] + "," + out[1] + "," + out[2] + ")";
  }
  /* Diverging color for a signed value t clamped to [-1, 1]:
   * negative (early) -> cool dispatch blue, positive (late) -> signal red. */
  function diverging(t) {
    t = Math.max(-1, Math.min(1, t));
    var mid = cssVar("--div-mid"), cool = cssVar("--div-cool"), warm = cssVar("--div-warm");
    if (t >= 0) return lerpColor(mid, warm, t);
    return lerpColor(mid, cool, -t);
  }
  function scale(d0, d1, r0, r1) {
    var span = (d1 - d0) || 1;
    return function (v) { return r0 + (v - d0) / span * (r1 - r0); };
  }
  function fmtClock(sec) {
    if (!isFinite(sec)) return "n/a";
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  function fmtPct(x) { return (x * 100).toFixed(1) + "%"; }
  function fmtNum(x, dp) { return Number(x).toFixed(dp == null ? 0 : dp); }

  /* ---------------------------------------------------------------- *
   * Tooltip (labels are untrusted data: textContent only)
   * ---------------------------------------------------------------- */
  var tip = null;
  function showTip(x, y, value, label, rows) {
    tip = tip || $("tooltip");
    clear(tip);
    tip.hidden = false;
    var v = document.createElement("div");
    v.className = "tt-value"; v.textContent = value;
    tip.appendChild(v);
    if (label) {
      var l = document.createElement("div");
      l.className = "tt-label"; l.textContent = label;
      tip.appendChild(l);
    }
    (rows || []).forEach(function (r) {
      var row = document.createElement("div");
      row.className = "tt-row";
      var left = document.createElement("span");
      if (r.color) {
        var key = document.createElement("span");
        key.className = "tt-key";
        key.style.borderTopColor = r.color;
        left.appendChild(key);
      }
      var name = document.createElement("span");
      name.textContent = r.name;
      left.appendChild(name);
      var right = document.createElement("span");
      right.textContent = r.value;
      row.appendChild(left); row.appendChild(right);
      tip.appendChild(row);
    });
    var pad = 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var px = x + pad, py = y + pad;
    if (px + w > window.innerWidth - 8) px = x - w - pad;
    if (py + h > window.innerHeight - 8) py = y - h - pad;
    tip.style.left = Math.max(4, px) + "px";
    tip.style.top = Math.max(4, py) + "px";
  }
  function hideTip() { if (!tip) tip = $("tooltip"); tip.hidden = true; }

  /* ---------------------------------------------------------------- *
   * Legend helper
   * ---------------------------------------------------------------- */
  function renderLegend(node, items) {
    clear(node);
    items.forEach(function (it) {
      var wrap = document.createElement("span");
      wrap.className = "legend-item";
      var sw = document.createElement("span");
      if (it.type === "line") {
        sw.className = "legend-line";
        sw.style.borderTopColor = it.color;
        if (it.dashed) sw.style.borderTopStyle = "dashed";
      } else {
        sw.className = "legend-swatch";
        sw.style.background = it.color;
      }
      var label = document.createElement("span");
      label.textContent = it.label;
      wrap.appendChild(sw); wrap.appendChild(label);
      node.appendChild(wrap);
    });
  }

  /* Build a table twin from { columns: [{key,label,num}], rows: [obj] }. */
  function renderTable(node, spec) {
    clear(node);
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    spec.columns.forEach(function (c) {
      var th = document.createElement("th");
      th.textContent = c.label;
      if (c.num) th.style.textAlign = "right";
      htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = document.createElement("tbody");
    spec.rows.forEach(function (r) {
      var tr = document.createElement("tr");
      spec.columns.forEach(function (c) {
        var td = document.createElement("td");
        td.textContent = r[c.key] == null ? "" : String(r[c.key]);
        if (c.num) td.className = "num";
        if (c.html) td.innerHTML = r[c.key];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    node.appendChild(table);
  }

  /* ---------------------------------------------------------------- *
   * Chart 1: Marey graphic timetable (time-distance stringline)
   * Direct station horizontal rules + mileposts + inline train IDs.
   * ---------------------------------------------------------------- */
  function drawStringline(report) {
    var svg = $("stringlineChart");
    clear(svg);
    var sl = report.stringline;
    var stops = sl.stops || state.workingService.stops || [];
    var W = 980, H = 480, padL = 138, padR = 76, padT = 26, padB = 42;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var t0 = sl.timeDomain[0], t1 = sl.timeDomain[1];
    var mMax = sl.milesDomain[1] || 1;
    var x = scale(t0, t1, padL, W - padR);
    var y = scale(0, mMax, padT + plotH, padT);

    // Select a legible subset of stations for direct horizontal rules and labels
    // so dense corridors (33 stops) never collide vertically.
    var lastLabelY = Infinity;
    stops.forEach(function (s, idx) {
      var gy = y(s.miles);
      var isTerminal = (idx === 0 || idx === stops.length - 1);
      el("line", {
        x1: padL, x2: W - padR, y1: gy.toFixed(1), y2: gy.toFixed(1),
        class: isTerminal ? "axis-line" : "station-rule"
      }, svg);

      if (isTerminal || Math.abs(gy - lastLabelY) >= 18) {
        lastLabelY = gy;
        var leftLbl = el("text", {
          x: padL - 8, y: (gy + 3.5).toFixed(1),
          "text-anchor": "end", class: "axis-text"
        }, svg);
        var shortStop = s.name.length > 17 ? s.name.slice(0, 16) + "." : s.name;
        leftLbl.textContent = s.code + " " + shortStop;

        var rightLbl = el("text", {
          x: W - padR + 8, y: (gy + 3.5).toFixed(1),
          "text-anchor": "start", class: "axis-text tabular"
        }, svg);
        rightLbl.textContent = fmtNum(s.miles, 1) + " mi";
      }
    });

    // Vertical time gridlines and clock ticks along both top and bottom rules.
    var timeTicks = 8;
    for (var i = 0; i <= timeTicks; i++) {
      var tv = t0 + (t1 - t0) * i / timeTicks;
      var gx = x(tv);
      el("line", { x1: gx.toFixed(1), x2: gx.toFixed(1), y1: padT, y2: padT + plotH, class: "grid-line" }, svg);
      var xtBot = el("text", { x: gx.toFixed(1), y: padT + plotH + 16, "text-anchor": "middle", class: "axis-text tabular" }, svg);
      xtBot.textContent = fmtClock(tv);
      if (i % 2 === 0) {
        var xtTop = el("text", { x: gx.toFixed(1), y: padT - 8, "text-anchor": "middle", class: "axis-text tabular" }, svg);
        xtTop.textContent = fmtClock(tv);
      }
    }
    var xl = el("text", { x: padL + plotW / 2, y: H - 6, "text-anchor": "middle", class: "axis-text" }, svg);
    xl.textContent = "Service clock (HH:MM) across cumulative route distance";

    function pathFor(line) {
      return line.points.map(function (p, k) {
        return (k === 0 ? "M" : "L") + x(p.timeSec).toFixed(1) + "," + y(p.miles).toFixed(1);
      }).join(" ");
    }

    // Scheduled ghost paths underneath observed trajectories.
    if (sl.scheduledLines) {
      sl.scheduledLines.forEach(function (line) {
        el("path", { d: pathFor(line), class: "ghost-line" }, svg);
      });
    }

    var delayByTrip = {};
    report.delay.perTrip.forEach(function (p) { delayByTrip[p.tripId] = p.finalDelaySec; });
    var maxDelay = 60;
    Object.keys(delayByTrip).forEach(function (k) { maxDelay = Math.max(maxDelay, Math.abs(delayByTrip[k])); });

    var lastTrainLabelX = -Infinity;
    sl.lines.forEach(function (line, idx) {
      var d = delayByTrip[line.tripId] || 0;
      var color = diverging(d / maxDelay);
      var path = el("path", { d: pathFor(line), class: "line-path", stroke: color }, svg);

      // Direct inline train number callouts at the origin/terminal along the sheet
      if (line.points.length > 0) {
        var pStart = line.points[0];
        var sx = x(pStart.timeSec), sy = y(pStart.miles);
        if (sx - lastTrainLabelX >= 46 && sx >= padL + 10 && sx <= W - padR - 20) {
          lastTrainLabelX = sx;
          var tl = el("text", {
            x: sx.toFixed(1), y: (sy + 11).toFixed(1),
            "text-anchor": "start", class: "train-label"
          }, svg);
          tl.textContent = line.tripId;
        }
      }

      var hit = el("path", {
        d: pathFor(line), fill: "none", stroke: "transparent",
        "stroke-width": 10, class: "hit"
      }, svg);
      hit.addEventListener("pointermove", function (ev) {
        showTip(ev.clientX, ev.clientY, "Train " + line.tripId, line.headsign || state.workingService.directionLabel, [
          { name: "Origin dep", value: fmtClock(line.startTime), color: color },
          { name: "Terminal arr", value: fmtClock(line.endTime) },
          { name: "Terminal offset", value: (d >= 0 ? "+" : "") + fmtNum(d, 0) + " s" },
          { name: "Station stops", value: line.points.length }
        ]);
        path.setAttribute("stroke-width", "3.2");
      });
      hit.addEventListener("pointerleave", function () {
        hideTip(); path.setAttribute("stroke-width", "1.85");
      });
    });

    // Highlight top bunching events directly on the Marey diagram as small callout rings.
    var stopMiles = {};
    stops.forEach(function (s) { stopMiles[s.id] = s.miles; });
    (report.bunching.bunchEvents || []).slice(0, 6).forEach(function (ev) {
      var m = stopMiles[ev.stopId];
      if (m == null) return;
      var bx = x(ev.timeSec), by = y(m);
      if (bx >= padL && bx <= W - padR) {
        el("circle", {
          cx: bx.toFixed(1), cy: by.toFixed(1), r: 4.5,
          fill: "none", stroke: cssVar("--series-2"), "stroke-width": 1.6
        }, svg);
      }
    });

    var legendItems = [
      { label: "On schedule / early", color: cssVar("--div-cool"), type: "line" },
      { label: "Delayed train", color: cssVar("--div-warm"), type: "line" }
    ];
    if (sl.scheduledLines) {
      legendItems.push({ label: "Scheduled path", color: cssVar("--axis"), type: "line", dashed: true });
    }
    renderLegend($("slLegend"), legendItems);
  }

  /* ---------------------------------------------------------------- *
   * Chart 2: corridor alignment map
   * ---------------------------------------------------------------- */
  function drawMap(report) {
    var svg = $("corridorMap");
    clear(svg);
    var svc = state.workingService;
    var stops = svc.stops;
    var W = 980, H = 240, padX = 52, padY = 34;
    var lats = stops.map(function (s) { return s.lat; });
    var lons = stops.map(function (s) { return s.lon; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);

    var midLat = (minLat + maxLat) / 2;
    var kx = Math.cos(midLat * Math.PI / 180);
    var rawX = function (s) { return (s.lon - minLon) * kx; };
    var rawY = function (s) { return (s.lat - minLat); };
    var xs = stops.map(rawX), ys = stops.map(rawY);
    var spanX = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) || 1;
    var spanY = (Math.max.apply(null, ys) - Math.min.apply(null, ys)) || 1;
    var availW = W - 2 * padX, availH = H - 2 * padY;
    var scaleF = Math.min(availW / spanX, availH / spanY);
    var usedW = spanX * scaleF, usedH = spanY * scaleF;
    var offX = padX + (availW - usedW) / 2;
    var offY = padY + (availH - usedH) / 2;
    var px = function (s) { return offX + (rawX(s) - Math.min.apply(null, xs)) * scaleF; };
    var py = function (s) { return offY + (spanY - (rawY(s) - Math.min.apply(null, ys))) * scaleF; };

    var delayByStop = {};
    report.delay.perStop.forEach(function (p) { delayByStop[p.stopId] = p.stats.mean; });
    var maxAbsDelay = 30;
    Object.keys(delayByStop).forEach(function (k) {
      maxAbsDelay = Math.max(maxAbsDelay, Math.abs(delayByStop[k]));
    });

    el("polyline", {
      points: stops.map(function (s) { return px(s).toFixed(1) + "," + py(s).toFixed(1); }).join(" "),
      fill: "none", stroke: cssVar("--rule-heavy"), "stroke-width": 2.5,
      "stroke-linejoin": "round", "stroke-linecap": "round"
    }, svg);

    var maxDwell = Math.max.apply(null, stops.map(function (s) { return s.dwellSec || 1; }));

    stops.forEach(function (s, i) {
      var cx = px(s), cy = py(s);
      var d = delayByStop[s.id] || 0;
      var color = diverging(d / maxAbsDelay);
      var r = 3.8 + 4.5 * Math.sqrt((s.dwellSec || 0) / maxDwell);
      var dot = el("circle", {
        cx: cx.toFixed(1), cy: cy.toFixed(1), r: r.toFixed(1),
        fill: color, class: "stat-dot"
      }, svg);
      var hit = el("circle", {
        cx: cx.toFixed(1), cy: cy.toFixed(1), r: Math.max(12, r + 6),
        class: "hit"
      }, svg);
      hit.addEventListener("pointermove", function (ev) {
        showTip(ev.clientX, ev.clientY, s.name, s.code + " | milepost " + fmtNum(s.miles, 1), [
          { name: "Mean delay", value: (d >= 0 ? "+" : "") + fmtNum(d, 0) + " s", color: color },
          { name: "Planned dwell", value: fmtNum(s.dwellSec, 0) + " s" },
          { name: "Coordinates", value: fmtNum(s.lat, 3) + ", " + fmtNum(s.lon, 3) }
        ]);
        dot.setAttribute("r", (r + 2).toFixed(1));
      });
      hit.addEventListener("pointerleave", function () {
        hideTip(); dot.setAttribute("r", r.toFixed(1));
      });
      var step = Math.max(2, Math.round(stops.length / 7));
      if (i === 0 || i === stops.length - 1 || i % step === 0) {
        var anchor = i === 0 ? "start" : (i === stops.length - 1 ? "end" : "middle");
        var dy = (i % 2 === 0) ? (-r - 6) : (r + 13);
        var t = el("text", {
          x: cx.toFixed(1),
          y: (cy + dy).toFixed(1),
          "text-anchor": anchor, class: "station-label"
        }, svg);
        t.textContent = s.code + " (" + fmtNum(s.miles, 0) + "m)";
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Chart 3: headway histogram
   * ---------------------------------------------------------------- */
  function drawHeadwayHistogram(report) {
    var svg = $("headwayChart");
    clear(svg);
    var data = report.headways.histogram;
    var W = 480, H = 280, padL = 42, padR = 14, padT = 16, padB = 38;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxC = Math.max.apply(null, data.map(function (d) { return d.count; }).concat([1]));
    var y = scale(0, maxC, padT + plotH, padT);
    var bandW = plotW / data.length;
    var barW = Math.min(24, bandW - 5);

    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var val = maxC * i / ticks;
      var gy = y(val);
      el("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, class: "grid-line" }, svg);
      var t = el("text", { x: padL - 7, y: gy + 4, "text-anchor": "end", class: "axis-text tabular" }, svg);
      t.textContent = fmtNum(val, 0);
    }
    el("line", { x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH, class: "axis-line" }, svg);

    var planBin = data.findIndex(function (d) { return d.ratioLo <= 1 && d.ratioHi >= 1; });
    var planX = padL + (planBin + 0.5) * bandW;
    el("line", {
      x1: planX, x2: planX, y1: padT, y2: padT + plotH,
      stroke: cssVar("--series-2"), "stroke-width": 1.5, "stroke-dasharray": "3 3"
    }, svg);
    var pl = el("text", { x: planX + 5, y: padT + 11, class: "axis-text" }, svg);
    pl.textContent = "scheduled 1.0x";

    data.forEach(function (d, i) {
      var cx = padL + (i + 0.5) * bandW;
      var bh = (padT + plotH) - y(d.count);
      var barColor = d.ratioHi <= 0.5 ? cssVar("--series-2") : (d.ratioLo >= 1.5 ? cssVar("--warning") : cssVar("--series-1"));
      var rect = el("rect", {
        x: (cx - barW / 2).toFixed(1), y: y(d.count).toFixed(1),
        width: barW, height: Math.max(0, bh).toFixed(1),
        fill: barColor, class: "bar"
      }, svg);
      var hit = el("rect", {
        x: (cx - bandW / 2).toFixed(1), y: padT,
        width: bandW, height: plotH, class: "hit"
      }, svg);
      hit.addEventListener("pointermove", function (ev) {
        showTip(ev.clientX, ev.clientY, fmtNum(d.count, 0) + " arrivals",
          d.label + " scheduled headway", [
            { name: "Interval", value: fmtNum(d.ratioLo * report.headways.plannedHeadwaySec / 60, 1) + " to " +
              fmtNum(d.ratioHi * report.headways.plannedHeadwaySec / 60, 1) + " min", color: barColor }
          ]);
        rect.setAttribute("opacity", "0.78");
      });
      hit.addEventListener("pointerleave", function () { hideTip(); rect.removeAttribute("opacity"); });
      if (i % 2 === 0) {
        var xt = el("text", { x: cx, y: padT + plotH + 15, "text-anchor": "middle", class: "axis-text tabular" }, svg);
        xt.textContent = fmtNum(d.ratioLo, 1) + "x";
      }
    });
    var xl = el("text", { x: padL + plotW / 2, y: H - 5, "text-anchor": "middle", class: "axis-text" }, svg);
    xl.textContent = "Observed headway multiple (H / H_scheduled)";

    renderLegend($("hwLegend"), [
      { label: "Bunch (<=0.5x)", color: cssVar("--series-2"), type: "bar" },
      { label: "Regular", color: cssVar("--series-1"), type: "bar" },
      { label: "Gap (>=1.5x)", color: cssVar("--warning"), type: "bar" }
    ]);
    renderTable($("hwTable"), {
      columns: [
        { key: "label", label: "Headway ratio" },
        { key: "from", label: "From (min)", num: true },
        { key: "to", label: "To (min)", num: true },
        { key: "count", label: "Arrivals", num: true }
      ],
      rows: data.map(function (d) {
        return {
          label: d.label,
          from: fmtNum(d.ratioLo * report.headways.plannedHeadwaySec / 60, 1),
          to: fmtNum(d.ratioHi * report.headways.plannedHeadwaySec / 60, 1),
          count: d.count
        };
      })
    });
  }

  /* ---------------------------------------------------------------- *
   * Chart 4: headway by time of day (mean + p90 lines)
   * ---------------------------------------------------------------- */
  function drawTimeOfDay(report) {
    var svg = $("todChart");
    clear(svg);
    var data = report.headways.timeOfDay;
    var W = 480, H = 280, padL = 44, padR = 14, padT = 16, padB = 38;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var planned = report.headways.plannedHeadwaySec;
    var maxV = Math.max(planned * 1.5, Math.max.apply(null, data.map(function (d) { return d.p90Sec; }).concat([1]))) * 1.08;
    var y = scale(0, maxV, padT + plotH, padT);
    var x = scale(0, Math.max(1, data.length - 1), padL, W - padR);

    var ticks = 4;
    for (var i = 0; i <= ticks; i++) {
      var val = maxV * i / ticks;
      var gy = y(val);
      el("line", { x1: padL, x2: W - padR, y1: gy, y2: gy, class: "grid-line" }, svg);
      var t = el("text", { x: padL - 7, y: gy + 4, "text-anchor": "end", class: "axis-text tabular" }, svg);
      t.textContent = fmtNum(val / 60, 0) + "m";
    }
    el("line", { x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH, class: "axis-line" }, svg);

    var py = y(planned);
    el("line", {
      x1: padL, x2: W - padR, y1: py, y2: py,
      stroke: cssVar("--series-3"), "stroke-width": 1.5, "stroke-dasharray": "3 3"
    }, svg);
    var pref = el("text", { x: W - padR, y: py - 5, "text-anchor": "end", class: "axis-text" }, svg);
    pref.textContent = "sched " + fmtNum(planned / 60, 0) + "m";

    function seriesPath(key) {
      return data.map(function (d, i) {
        return (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(d[key]).toFixed(1);
      }).join(" ");
    }
    el("path", { d: seriesPath("p90Sec"), class: "line-path", stroke: cssVar("--series-2") }, svg);
    el("path", { d: seriesPath("meanSec"), class: "line-path", stroke: cssVar("--series-1") }, svg);

    data.forEach(function (d, i) {
      el("circle", { cx: x(i), cy: y(d.meanSec), r: 3.2, fill: cssVar("--series-1"), class: "stat-dot" }, svg);
      el("circle", { cx: x(i), cy: y(d.p90Sec), r: 3.2, fill: cssVar("--series-2"), class: "stat-dot" }, svg);
      var step = data.length > 10 ? 3 : 2;
      if (i % step === 0) {
        var xt = el("text", { x: x(i), y: padT + plotH + 15, "text-anchor": "middle", class: "axis-text tabular" }, svg);
        xt.textContent = d.label.slice(0, 5);
      }
      var bandL = i === 0 ? padL : (x(i - 1) + x(i)) / 2;
      var bandR = i === data.length - 1 ? W - padR : (x(i) + x(i + 1)) / 2;
      var hit = el("rect", { x: bandL, y: padT, width: Math.max(1, bandR - bandL), height: plotH, class: "hit" }, svg);
      var cross = el("line", { x1: x(i), x2: x(i), y1: padT, y2: padT + plotH, class: "crosshair", visibility: "hidden" }, svg);
      hit.addEventListener("pointermove", function (ev) {
        cross.setAttribute("visibility", "visible");
        showTip(ev.clientX, ev.clientY, d.label.slice(0, 5), "Hourly headway summary", [
          { name: "Mean", value: fmtNum(d.meanSec / 60, 1) + " min", color: cssVar("--series-1") },
          { name: "90th pct", value: fmtNum(d.p90Sec / 60, 1) + " min", color: cssVar("--series-2") },
          { name: "Sample size", value: d.count }
        ]);
      });
      hit.addEventListener("pointerleave", function () {
        cross.setAttribute("visibility", "hidden"); hideTip();
      });
    });

    var xl = el("text", { x: padL + plotW / 2, y: H - 5, "text-anchor": "middle", class: "axis-text" }, svg);
    xl.textContent = "Service hour";

    renderLegend($("todLegend"), [
      { label: "Mean", color: cssVar("--series-1"), type: "line" },
      { label: "90th pct", color: cssVar("--series-2"), type: "line" },
      { label: "Scheduled", color: cssVar("--series-3"), type: "line", dashed: true }
    ]);
    renderTable($("todTable"), {
      columns: [
        { key: "label", label: "Hour" },
        { key: "mean", label: "Mean (min)", num: true },
        { key: "p90", label: "90th pct (min)", num: true },
        { key: "count", label: "Observations", num: true }
      ],
      rows: data.map(function (d) {
        return {
          label: d.label.slice(0, 5),
          mean: fmtNum(d.meanSec / 60, 1),
          p90: fmtNum(d.p90Sec / 60, 1),
          count: d.count
        };
      })
    });
  }

  /* ---------------------------------------------------------------- *
   * Chart 5: dwell by station (ranked horizontal bars)
   * ---------------------------------------------------------------- */
  function drawDwell(report) {
    var node = $("dwellChart");
    clear(node);
    var data = report.dwell.perStop.slice().sort(function (a, b) {
      return (b.stats.mean - b.plannedDwellSec) - (a.stats.mean - a.plannedDwellSec);
    }).slice(0, 12);
    var maxV = Math.max.apply(null, data.map(function (d) {
      return Math.max(d.stats.mean, d.plannedDwellSec);
    }).concat([1]));

    data.forEach(function (d) {
      var row = document.createElement("div");
      row.className = "bar-row";
      var name = document.createElement("div");
      name.className = "name"; name.textContent = d.stopName;
      var track = document.createElement("div");
      track.className = "bar-track";
      var fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = (Math.min(100, d.stats.mean / maxV * 100)) + "%";
      fill.style.background = d.meanDeltaSec > 4 ? cssVar("--series-2") : cssVar("--series-1");
      var tick = document.createElement("div");
      tick.className = "planned-tick";
      tick.style.left = (Math.min(100, d.plannedDwellSec / maxV * 100)) + "%";
      track.appendChild(fill); track.appendChild(tick);
      var value = document.createElement("div");
      value.className = "value"; value.textContent = fmtNum(d.stats.mean, 0) + "s";
      row.appendChild(name); row.appendChild(track); row.appendChild(value);
      row.addEventListener("pointermove", function (ev) {
        showTip(ev.clientX, ev.clientY, fmtNum(d.stats.mean, 0) + " s",
          d.stopName, [
            { name: "Scheduled dwell", value: fmtNum(d.plannedDwellSec, 0) + " s" },
            { name: "Mean overrun", value: (d.meanDeltaSec >= 0 ? "+" : "") + fmtNum(d.meanDeltaSec, 0) + " s", color: cssVar("--series-2") },
            { name: "Std deviation", value: fmtNum(d.stats.stddev, 0) + " s" }
          ]);
      });
      row.addEventListener("pointerleave", hideTip);
      node.appendChild(row);
    });

    renderLegend($("dwellLegend"), [
      { label: "Observed dwell", color: cssVar("--series-1"), type: "bar" },
      { label: "Scheduled tick", color: cssVar("--rule-heavy"), type: "line" }
    ]);
    renderTable($("dwellTable"), {
      columns: [
        { key: "name", label: "Station" },
        { key: "mean", label: "Mean dwell (s)", num: true },
        { key: "planned", label: "Scheduled (s)", num: true },
        { key: "delta", label: "Delta (s)", num: true },
        { key: "p90", label: "90th pct (s)", num: true }
      ],
      rows: report.dwell.perStop.map(function (d) {
        return {
          name: d.stopName,
          mean: fmtNum(d.stats.mean, 0),
          planned: fmtNum(d.plannedDwellSec, 0),
          delta: (d.meanDeltaSec >= 0 ? "+" : "") + fmtNum(d.meanDeltaSec, 0),
          p90: fmtNum(d.stats.p90, 0)
        };
      })
    });
  }

  /* ---------------------------------------------------------------- *
   * Chart 6: delay along the line (diverging bars + zero baseline)
   * ---------------------------------------------------------------- */
  function drawDelay(report) {
    var svg = $("delayChart");
    clear(svg);
    var data = report.delay.perStop;
    var W = 480, H = 280, padL = 44, padR = 14, padT = 14, padB = 34;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var maxAbs = Math.max.apply(null, data.map(function (d) { return Math.abs(d.stats.mean); }).concat([30]));
    var y = scale(-maxAbs, maxAbs, padT + plotH, padT);
    var zero = y(0);
    var bandW = plotW / Math.max(1, data.length);
    var barW = Math.min(20, bandW - 3);

    [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs].forEach(function (v) {
      var gy = y(v);
      el("line", {
        x1: padL, x2: W - padR, y1: gy, y2: gy,
        class: v === 0 ? "axis-line" : "grid-line"
      }, svg);
      var t = el("text", { x: padL - 6, y: gy + 4, "text-anchor": "end", class: "axis-text tabular" }, svg);
      t.textContent = (v > 0 ? "+" : "") + fmtNum(v, 0) + "s";
    });

    data.forEach(function (d, i) {
      var cx = padL + (i + 0.5) * bandW;
      var v = d.stats.mean;
      var yv = y(v);
      var top = Math.min(yv, zero), height = Math.max(2, Math.abs(yv - zero));
      var color = diverging(v / maxAbs);
      var rect = el("rect", {
        x: (cx - barW / 2).toFixed(1), y: top.toFixed(1),
        width: barW, height: height.toFixed(1), fill: color, class: "bar"
      }, svg);
      var hit = el("rect", {
        x: (cx - bandW / 2).toFixed(1), y: padT,
        width: bandW, height: plotH, class: "hit"
      }, svg);
      hit.addEventListener("pointermove", function (ev) {
        showTip(ev.clientX, ev.clientY, (v >= 0 ? "+" : "") + fmtNum(v, 0) + " s",
          d.stopName + " | milepost " + fmtNum(d.miles, 1), [
            { name: "Mean offset", value: (v >= 0 ? "+" : "") + fmtNum(v, 0) + " s", color: color },
            { name: "90th pct", value: (d.stats.p90 >= 0 ? "+" : "") + fmtNum(d.stats.p90, 0) + " s" },
            { name: "Arrivals", value: d.stats.count }
          ]);
        rect.setAttribute("opacity", "0.78");
      });
      hit.addEventListener("pointerleave", function () { hideTip(); rect.removeAttribute("opacity"); });
      if (i % Math.max(1, Math.round(data.length / 6)) === 0) {
        var t = el("text", { x: cx, y: padT + plotH + 15, "text-anchor": "middle", class: "axis-text tabular" }, svg);
        t.textContent = fmtNum(d.miles, 0) + "m";
      }
    });
    var xl = el("text", { x: padL + plotW / 2, y: H - 4, "text-anchor": "middle", class: "axis-text" }, svg);
    xl.textContent = "Cumulative route miles from origin";

    renderLegend($("delayLegend"), [
      { label: "Early / on schedule", color: cssVar("--div-cool"), type: "bar" },
      { label: "Delayed", color: cssVar("--div-warm"), type: "bar" }
    ]);
    renderTable($("delayTable"), {
      columns: [
        { key: "name", label: "Station" },
        { key: "mile", label: "Milepost", num: true },
        { key: "mean", label: "Mean offset (s)", num: true },
        { key: "p90", label: "90th pct (s)", num: true }
      ],
      rows: data.map(function (d) {
        return {
          name: d.stopName,
          mile: fmtNum(d.miles, 1),
          mean: (d.stats.mean >= 0 ? "+" : "") + fmtNum(d.stats.mean, 0),
          p90: (d.stats.p90 >= 0 ? "+" : "") + fmtNum(d.stats.p90, 0)
        };
      })
    });
  }

  /* ---------------------------------------------------------------- *
   * Bunching / gap events table
   * ---------------------------------------------------------------- */
  function drawEvents(report) {
    var bunches = report.bunching.bunchEvents.slice(0, 8).map(function (e) {
      return {
        type: "bunch", tag: "Bunch", stop: e.stopName, time: fmtClock(e.timeSec),
        headway: fmtNum(e.headwaySec, 0) + " s", trips: e.leaderTrip + " -> " + e.followerTrip
      };
    });
    var gaps = report.bunching.gapEvents.slice(0, 8).map(function (e) {
      return {
        type: "gap", tag: "Gap", stop: e.stopName, time: fmtClock(e.timeSec),
        headway: fmtNum(e.headwaySec, 0) + " s", trips: e.leaderTrip + " -> " + e.followerTrip
      };
    });
    var rows = bunches.concat(gaps);
    if (!rows.length) {
      rows = [{
        type: "gap", tag: "Nominal", stop: "All stations", time: "--:--",
        headway: fmtNum(report.headways.plannedHeadwaySec, 0) + " s",
        trips: "Zero bunch or service gap thresholds exceeded"
      }];
    }
    renderTable($("eventTable"), {
      columns: [
        { key: "tagHtml", label: "Classification", html: true },
        { key: "stop", label: "Station" },
        { key: "time", label: "Clock time", num: true },
        { key: "headway", label: "Observed headway", num: true },
        { key: "trips", label: "Train pair (leader -> follower)" }
      ],
      rows: rows.map(function (r) {
        return {
          tagHtml: '<span class="tag ' + r.type + '">' + r.tag + "</span>",
          stop: r.stop, time: r.time, headway: r.headway, trips: r.trips
        };
      })
    });
  }

  /* ---------------------------------------------------------------- *
   * Hero + KPIs
   * ---------------------------------------------------------------- */
  function drawOverview(report) {
    $("heroScore").textContent = fmtNum(report.score, 0);
    var s = report.service;
    $("heroSub").textContent = s.name + " | " + fmtNum(s.tripCount, 0) + " trips, " +
      fmtNum(s.stopCount, 0) + " stations, " +
      (report.headways.plannedHeadwaySec ? fmtNum(report.headways.plannedHeadwaySec / 60, 0) + " min scheduled headway" : "GTFS schedule");

    var labels = { headway: "Regularity", bunching: "Bunching", punctuality: "Punctuality", dwell: "Dwell" };
    var row = $("gradeRow"); clear(row);
    Object.keys(labels).forEach(function (k) {
      var chip = document.createElement("span");
      chip.className = "grade-chip";
      var name = document.createElement("span"); name.textContent = labels[k];
      var b = document.createElement("b"); b.textContent = report.grades[k];
      chip.appendChild(name); chip.appendChild(b); row.appendChild(chip);
    });

    $("kpiHeadway").textContent = fmtNum(report.headways.overall.mean / 60, 1) + "m";
    $("kpiHeadwayFoot").textContent = "sched " + fmtNum(report.headways.plannedHeadwaySec / 60, 1) +
      "m | CV " + fmtNum(report.headways.overall.cv, 2);
    $("kpiBunch").textContent = fmtPct(report.bunching.bunchRate);
    $("kpiBunchFoot").textContent = fmtNum(report.bunching.bunchCount, 0) + " of " +
      fmtNum(report.bunching.totalHeadways, 0) + " intervals <= 0.5x";
    $("kpiEwt").textContent = fmtNum(report.bunching.excessWaitSec, 0) + "s";
    $("kpiEwtFoot").textContent = "Var(H) / 2E[H] rider wait penalty";
    $("kpiOntime").textContent = fmtPct(report.delay.onTimeRate);
    $("kpiOntimeFoot").textContent = "within " + fmtNum(report.delay.onTimeThresholdSec, 0) + "s of timetable";
  }

  /* ---------------------------------------------------------------- *
   * Orchestrator
   * ---------------------------------------------------------------- */
  function render() {
    if (!state.baseServices.length) return;
    var base = state.baseServices.find(function (s) { return s.id === state.serviceId; }) || state.baseServices[0];
    state.serviceId = base.id;

    var working = base;
    if (state.layer === "simulated" && state.intensity > 0) {
      var observed = E.simulateObserved(base, { intensity: state.intensity, seed: 20261108 });
      working = E.withObserved(base, observed);
    } else {
      working = E.withObserved(base, null);
    }
    state.workingService = working;

    var report = E.buildReport(working, { maxStringlineTrips: 26 });
    state.report = report;

    $("mapSub").textContent = base.directionLabel + " | " + base.operator + " | " +
      base.name + " (" + base.stops.length + " stations)";
    $("dataDisclosure").textContent = state.source === "gtfs"
      ? "Loaded from uploaded GTFS static tables. Observed trajectories are simulated around the real schedule; apply GTFS-RT stop_time_update records for live telemetry."
      : "Preloaded corridors use regular-interval synthetic timetables over published station mileposts for offline inspection. Upload any GTFS static archive (.zip or CSV) to compute schedules and reliability metrics from agency feed files.";

    drawOverview(report);
    drawStringline(report);
    drawMap(report);
    drawHeadwayHistogram(report);
    drawTimeOfDay(report);
    drawDwell(report);
    drawDelay(report);
    drawEvents(report);
  }

  function populateServiceSelect() {
    var sel = $("serviceSelect");
    clear(sel);
    state.baseServices.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.shortName + " | " + s.operator + " (" + s.stops.length + " stops)";
      sel.appendChild(opt);
    });
    if (state.serviceId) sel.value = state.serviceId;
  }

  function setTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("themeToggle").textContent = dark ? "Light paper" : "Dark desk";
    if (state.report) render();
  }

  function initTheme() {
    setTheme(false);
  }

  /* ---------------------------------------------------------------- *
   * GTFS upload
   * ---------------------------------------------------------------- */
  async function handleGtfsFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var notice = $("feedNotice");
    notice.hidden = false;
    notice.className = "feed-notice";
    notice.textContent = "Reading GTFS feed tables and building normalized services...";

    try {
      var fileMap = {};
      var zipFile = files.find(function (f) { return /\.zip$/i.test(f.name); });
      if (zipFile) {
        var buf = await zipFile.arrayBuffer();
        fileMap = await E.readFeedFiles(buf);
      } else {
        for (var i = 0; i < files.length; i++) {
          var text = await files[i].text();
          fileMap[files[i].name] = text;
        }
      }
      var options = { files: fileMap, maxServices: 24 };
      var dateVal = $("dateInput").value.trim();
      if (/^\d{8}$/.test(dateVal)) options.date = dateVal;

      var parsed = await E.parseGtfs(options);
      if (!parsed.services.length) {
        throw new Error("No usable routes found in this feed (need trips.txt and stop_times.txt).");
      }
      state.baseServices = parsed.services;
      state.source = "gtfs";
      state.serviceId = parsed.services[0].id;
      state.date = parsed.date;
      state.gtfsWarnings = parsed.warnings;
      $("sourceBadge").textContent = "GTFS feed | " + parsed.date;
      if (!/^\d{8}$/.test(dateVal)) $("dateInput").value = parsed.date;
      populateServiceSelect();

      notice.className = "feed-notice";
      notice.textContent = "Loaded " + parsed.services.length + " directional service(s) for date " +
        parsed.date + " (" + parsed.routeCount + " routes in feed)." +
        (parsed.warnings.length ? " Notes: " + parsed.warnings.join(" ") : "");
      render();
    } catch (err) {
      notice.className = "feed-notice error";
      notice.textContent = "Could not parse GTFS feed: " + (err && err.message ? err.message : err);
    }
  }

  function resetToDemo() {
    state.baseServices = E.buildAllSyntheticServices();
    state.source = "demo";
    state.serviceId = state.baseServices[0].id;
    state.date = null;
    $("sourceBadge").textContent = "Preloaded corridor timetable";
    $("gtfsInput").value = "";
    $("dateInput").value = "";
    var notice = $("feedNotice"); notice.hidden = true;
    populateServiceSelect();
    render();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  function wire() {
    $("serviceSelect").addEventListener("change", function (e) {
      state.serviceId = e.target.value; render();
    });
    $("layerSelect").addEventListener("change", function (e) {
      state.layer = e.target.value; render();
    });
    $("intensitySelect").addEventListener("change", function (e) {
      state.intensity = parseFloat(e.target.value); render();
    });
    $("gtfsInput").addEventListener("change", function (e) { handleGtfsFiles(e.target.files); });
    $("dateInput").addEventListener("change", function () {
      if (state.source === "gtfs") handleGtfsFiles($("gtfsInput").files);
    });
    $("demoReset").addEventListener("click", resetToDemo);
    $("themeToggle").addEventListener("click", function () {
      setTheme(document.documentElement.getAttribute("data-theme") !== "dark");
    });
    document.querySelectorAll(".toggle-table").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var table = $(btn.getAttribute("data-table"));
        table.hidden = !table.hidden;
        btn.textContent = table.hidden ? "Table" : "Hide table";
      });
    });
  }

  function init() {
    wire();
    initTheme();
    state.baseServices = E.buildAllSyntheticServices();
    state.serviceId = state.baseServices[0].id;
    populateServiceSelect();
    var prov = (window.RailPulse && window.RailPulse.CORRIDOR_PROVENANCE) || [];
    $("provenance").textContent = "Timetable provenance: " + prov.join(" ");
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
