# RailPulse

**A stopped train is a network event. RailPulse makes the consequences inspectable.**

[Open the dispatch workbench](https://aariv.me/railpulse/). Choose **Platform incident**, then **Recover spacing**. The same timetable runs through both strategies, and the interface shows the passenger wait benefit alongside the extra train delay.

RailPulse runs directly from `index.html` with no install, build step, external asset, or network request. GitHub Pages serves the same three browser scripts used by the tests.

## The five-second demonstration

| Preset | What to inspect |
| --- | --- |
| **1. Smooth rush** | A regular eight-minute timetable: zero excess wait and a diagnostic score of 100 |
| **2. Platform incident** | A 900-second platform stop on train `RED-CTA-05`, with delay propagating to three trains |
| **3. Recover spacing** | Station holds preserve 75% of planned arrival spacing, remove measured bunching, and show the added delay cost |

The showcase uses 16 trips and 33 station visits on a simplified CTA Red corridor fixture. Its verified measurements are:

| Measurement | Incident | Spacing holds |
| --- | ---: | ---: |
| Excess wait per measured headway distribution | 58.116 s | 46.809 s |
| Bunching rate | 10.101% | 0% |
| Trips with positive terminal delay | 3 | 8 |
| Sum of terminal train delay | 1,755 s | 3,840 s |
| Additional station holds | 0 s | 1,685 s |

The wait penalty falls by 19.5%, while the sum of terminal delays increases. The interface presents this tradeoff directly; the spacing strategy is an illustrative dispatch rule rather than a validated optimum.

## What the workbench does

- Draws a Marey time-distance timetable with horizontal dwell segments, matching scheduled ghost paths, a selectable time window, and a clipped plot boundary.
- Provides exact train and station inspection through pointer hover or keyboard focus. A selected train has an arrival, departure, dwell, and schedule-offset ledger.
- Computes headway distribution, coefficient of variation, bunching, service gaps, finite-distribution excess wait, station dwell overrun, and matched arrival delay.
- Imports a GTFS ZIP or a group of CSV files locally. Supports after-midnight service clocks, weekly calendars and date exceptions, direction and stop-pattern grouping, loop visits, and interpolation of untimed interior stops.
- Verifies timestamps by formatting and parsing them back through the GTFS service-day clock. Both showcase layers pass **2,112 timestamp round trips and 5,313 timetable checks**.
- Downloads a JSON dispatch report containing the measured results, active scenario, validation counts, and modeling assumptions.

Seven bundled examples cover named NEC, Houston METRORail, Caltrain, and CTA corridors. Their station sequences, mileposts, and coordinates are simplified teaching fixtures. They are not agency schedules, surveyed rail geometry, or live observations. Uploaded GTFS supplies the agency's planned stop times. Imported distance axes use cumulative haversine estimates between stops because GTFS `shape_dist_traveled` has no universal unit.

## Mathematical choices

For the finite set of measured headways `H`, the wait penalty is:

```text
excess_wait = population_variance(H) / (2 * mean(H))
```

This follows from length-weighted waiting with uniformly arriving passengers. The regression case `H = [60, 180]` has mean 120 s, population variance 3,600 s^2, and excess wait 15 s. Descriptive standard deviation and coefficient of variation use sample variance; the wait estimator uses the finite empirical distribution.

The incident simulator uses scheduled interstation running times; followers enter a shared platform only after the leader's departure plus a 45-second clearance. When spacing recovery is enabled, trains hold at the preceding station platform (extending dwell there) until downstream arrival spacing reaches 75% of scheduled headway. This models a queue in one direction, with no overtaking, passenger-demand model, platform allocation, or signaling optimization.

The diagnostic score is an explicit four-grade rubric: headway variation, bunching, matched punctuality, and positive dwell overrun. It is a teaching aid, not an agency-certified performance measure. Scheduled-only views do not represent observed reliability.

## Archive and timetable integrity

The dependency-free ZIP reader supports stored and raw DEFLATE entries, including streaming data descriptors. Its built-in decoder handles stored, fixed-Huffman, and dynamic-Huffman DEFLATE blocks without relying on `DecompressionStream`. It validates central and local header bounds, filenames, output lengths, CRC32, and text decoding. It rejects encrypted entries, unsupported codecs, split archives, ZIP64, duplicate feed basenames, archives above 128 MiB compressed or expanded, and archives above 1,024 entries.

Malformed CSV quotes, duplicate headers, duplicate GTFS entity ids, unknown stops, invalid coordinates, decreasing times, and missing endpoint timestamps are diagnosed. Unusable trips produce warnings. Calendar exclusions remain excluded, even when a date has no usable service.

## Run and verify

Open `index.html` directly, or publish this directory on GitHub Pages. All application assets use relative paths, so `https://aariv.me/railpulse/` needs no routing configuration.

On Node 22 or newer:

```sh
node --test tests/
```

Verified locally on Node v26.8.1:

```text
 tests 202
 suites 0
 pass 202
 fail 0
 cancelled 0
 skipped 0
 todo 0
```

There are **88 engine and import tests**, **97 adversarial hardening tests**, and **17 DOM runtime tests**. The hardening suite attacks the GTFS reader with forged ZIP structures (split markers, ZIP64 sentinels, entry-count lies, encrypted members, CRC corruption, non-UTF-8 names), hostile CSV text, overnight service-day times past `25:00:00`, prototype-pollution keys, and stale-upload races. It also asserts the transit math directly: sample-sigma headway CV, population-variance excess wait, monotone stringlines on every corridor, follower separation and dwell invariants under the cascade model, formula-safe CSV export cells, and the exported SHA-256 report digest. The DOM fixture evaluates the actual browser scripts against the actual markup, drives control events, checks startup timing, validates inert imported labels and upload cancellation, and exercises all seven corridors across five time windows at a 320-pixel viewport. It checks finite SVG coordinates and accessibility bindings. It does not replace visual inspection in a browser.

Syntax checks:

```sh
for file in app.js engine.js corridors.js tests/*.js; do node --check "$file" || exit 1; done
```

All seven JavaScript files passed. Tests generate ZIP bytes and feed fixtures in memory; no downloaded feed, runtime dependency, cache, or temporary artifact is required.

## Engine API

```js
const corridors = require("./corridors.js");
const E = require("./engine.js");
const corridor = corridors.find(c => c.id === "cta-red");
const service = E.buildSyntheticService(corridor, {
  startSec: 7 * 3600,
  endSec: 9 * 3600
});
const run = E.simulateCascade(service, { regulate: true });
const report = E.buildReport(E.withObserved(service, run.observedTrips));
console.log(report.headways.excessWaitSec, run.totalTerminalDelaySec);
```

`parseGtfs({ files, date: "YYYYMMDD" })` returns a promise of directional services and import warnings. `applyRealtime(service, updates)` accepts per-stop absolute times or delay seconds and propagates delay consistently into later stops. This is a structured update API; the page does not fetch a realtime endpoint or decode GTFS-RT protobuf.

## Keyboard and layout

- **1**, **2**, **3** select showcase scenarios when a text field or selector is not focused.
- **Tab** reaches controls, chart inspections, table toggles, and the train ledger.
- **Escape** closes the current tooltip.
- The timetable keeps legible vector coordinates and scrolls horizontally on small screens. Supporting analytics are collected behind a disclosure, with table alternatives and a dark-desk theme.

## Files

| File | Purpose |
| --- | --- |
| `engine.js` | GTFS CSV/ZIP parsing, clocks, simulation, reports, and validation |
| `corridors.js` | Seven simplified synthetic corridor fixtures |
| `app.js` | SVG rendering, inspections, presets, import handling, and report download |
| `index.html`, `style.css` | Accessible dispatch workspace and responsive palettes |
| `tests/railpulse.test.js` | 88 numerical, parser, archive, and integration tests |
| `tests/hardening.test.js` | 78 adversarial parser, math-invariant, export, and race tests |
| `tests/dom-fixture.js` | shared deterministic DOM harness (not a test file) |
| `tests/ui.test.js` | 17 DOM runtime and interaction tests |
| `DEVPOST_UPGRADE.md` | Submission copy with measured evidence |

MIT. See [LICENSE](LICENSE).
