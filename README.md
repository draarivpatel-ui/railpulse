# RailPulse

RailPulse is a zero-dependency rail service reliability and graphic timetable workbench that runs locally in your browser or in Node.js. Inspired by Swiss Federal Railways (SBB) operational dispatch sheets and Edward Tufte's graphic timetables, it parses GTFS static archives (`.zip` or loose CSV files), constructs a normalized directional service model, and computes Marey time-distance stringlines, headway coefficient of variation, vehicle bunching rates, excess passenger wait time, and downstream delay propagation.

All feed parsing and statistical analysis run locally on your machine with zero network requests.

## Capabilities

- **GTFS Static Parser**: Consumes `agency.txt`, `routes.txt`, `stops.txt`, `calendar.txt`, `calendar_dates.txt`, `trips.txt`, and `stop_times.txt`. Handles RFC 4180 quoted CSV fields, CRLF line endings, UTF-8 byte-order marks, service-day exception resolution, after-midnight service timestamps (`25:10:00`), and `route_color`.
- **Zero-Dependency ZIP Reader**: Extracts stored (`method 0`) and deflate-compressed (`method 8`) entries in the browser via `DecompressionStream`, including a central-directory fallback for streaming ZIP archives that set bit 3 data descriptors (`compressedSize = 0` in the local header).
- **Marey Graphic Timetable**: Plots scheduled ghost paths alongside delay-encoded train trajectories with direct station codes, cumulative milepost rules, inline train identifiers, and bunching callout rings.
- **Seven Preloaded Rail Corridors**: Ships with station sequences, mileposts, and route geometry for the Amtrak Northeast Corridor, Houston METRORail Red/Green/Purple Lines, Caltrain, and CTA Blue/Red Lines.
- **Seeded Cascade Disruption Simulator**: Uses a deterministic `mulberry32` PRNG to inject dwell noise, departure drift, and single-train delays that carry into following runs, alongside `applyRealtime` for GTFS-RT style per-stop updates.

## Quick Start

Open `index.html` directly in any modern browser. No bundler, server, or install step is required.

To run the automated test suite (45 tests in Node 18+):

```bash
node --test tests/
```

## Programmatic Usage (Node.js)

`corridors.js` and `engine.js` are UMD modules that work identically in Node and the browser:

```js
require("./corridors.js");
const E = require("./engine.js");

const service = E.buildSyntheticService(globalThis.RailPulse.CORRIDORS[1]); // METRORail Red
const observed = E.simulateObserved(service, { seed: 20261108, intensity: 1.5 });
const report = E.buildReport(E.withObserved(service, observed));
console.log(report.score, report.grades, report.bunching.bunchRate);
```

## Repository Structure

| File | Role |
|---|---|
| `corridors.js` | Preloaded corridor station lists, mileposts, and route geometry (UMD) |
| `engine.js` | GTFS CSV/ZIP parser, calendar resolver, disruption simulator, and analyzers (UMD) |
| `index.html` | SBB / Tufte graphic timetable dispatch desk markup |
| `style.css` | High-contrast paper and dark-desk palettes, Swiss ledger rules, tabular typography |
| `app.js` | SVG Marey stringline, corridor alignment, headway histograms, and GTFS file wiring |
| `tests/railpulse.test.js` | 45 automated unit tests (`node --test tests/`) |

## License

MIT. See [LICENSE](LICENSE).
