# RailPulse

RailPulse is a dependency free rail service reliability analyzer that runs entirely in your browser or in Node. It parses GTFS static timetables (including zipped feeds), builds a normalized service model, and measures headway regularity, train bunching, dwell times and schedule delay. The interactive dashboard draws stringline (Marey) diagrams, headway distributions and corridor maps as hand built SVG, with no framework, no build step and no network calls.

Data never leaves your device. Upload a GTFS `.zip` or loose `.txt` files and everything is parsed locally.

## Features

- GTFS static parser for the core tables: `agency.txt`, `routes.txt`, `stops.txt`, `calendar.txt`, `calendar_dates.txt`, `trips.txt`, `stop_times.txt`. Handles quoted CSV fields, CRLF, UTF-8 BOM, service-day resolution with exceptions, after-midnight times (`25:10:00`), and `route_color`.
- Dependency free ZIP reader using the platform `DecompressionStream` (store and deflate), with a central-directory fallback for data-descriptor archives.
- Seven preloaded real corridors (Amtrak Northeast Corridor, Houston METRORail Red/Green/Purple, Caltrain, CTA Blue/Red) with published station order, mileposts and approximate geography, plus synthetic regular-interval timetables so every analyzer works offline out of the box.
- A seeded, reproducible disruption simulator that injects dwell noise, departure drift and propagating delays, and a GTFS-RT style `applyRealtime` layer for measured times.
- Analyzers: headway statistics and histograms, bunching and gap detection, excess wait time, stringline data, dwell analysis, delay and on-time performance, and a combined letter-grade reliability report.
- Interactive dashboard with light and dark themes, a filtered table view twin for every chart, hover tooltips and a corridor map.

## Quick start

Open `index.html` in any modern browser. No install, no server, no build.

To run the unit tests (Node 18 or newer):

```
node --test tests/
```

## Using the dashboard

The control row at the top scopes every chart below it:

- **Corridor / route**: pick the service to analyze.
- **Data layer**: `Simulated realtime` adds reproducible noise on top of the schedule; `Scheduled only` shows the clean timetable.
- **Disruption**: how strong the simulated noise is, from none to severe.
- **GTFS static**: upload a `.zip` feed or several loose `.txt`/`.csv` files to replace demo data with real schedules.
- **Service date**: an optional `YYYYMMDD` date for calendar resolution (auto-selected when blank).

Every chart has a **Table** button that reveals its WCAG-clean data table, so no value is gated behind a tooltip. The theme toggle switches both light and dark selected palettes.

## Programmatic use (Node)

`engine.js` is a UMD module. Load the corridor bundle first, then use the CommonJS exports:

```js
require("./corridors.js");            // attaches to globalThis.RailPulse
const E = require("./engine.js");

// Built-in demo corridor
const service = E.buildSyntheticService(globalThis.RailPulse.CORRIDORS[0]);
const observed = E.simulateObserved(service, { seed: 42, intensity: 1 });
const report = E.buildReport(E.withObserved(service, observed));
console.log(report.score, report.grades, report.bunching.bunchRate);
```

Parse a GTFS feed:

```js
const fs = require("fs");
const buf = fs.readFileSync("feed.zip");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const parsed = await E.parseGtfs({ files: ab, date: "20261106" });
for (const svc of parsed.services) {
  const rep = E.buildReport(svc);
  console.log(svc.name, rep.score, rep.headways.overall.mean);
}
```

`parseGtfs` also accepts `{ "stops.txt": "...", ... }` text maps and loose `File`/`Blob` objects in the browser.

## API reference

Grouped by purpose (all live on `RailPulse` in the browser and on the CommonJS export in Node):

| Group | Functions |
|---|---|
| Time | `parseGtfsTime`, `formatGtfsTime`, `formatDuration` |
| Stats | `mean`, `stddev`, `percentile`, `median`, `describeSample` |
| Geometry | `geoDistanceMiles`, `pointAlong`, `interpolateStationCoordinates` |
| CSV / ZIP | `parseCsv`, `splitCsvRow`, `readZip`, `readFeedFiles` |
| GTFS | `resolveActiveServices`, `parseGtfs`, `dominantDirection` |
| Synthetic | `listCorridors`, `buildSyntheticService`, `buildAllSyntheticServices` |
| Realtime | `simulateObserved`, `withObserved`, `applyRealtime` |
| Analyzers | `analyzeHeadways`, `analyzeBunching`, `buildStringline`, `analyzeDwell`, `analyzeDelay`, `buildReport`, `arrivalsAtStop` |

### The Service model

Every analyzer consumes a normalized `Service` (one direction of one route):

```js
{
  id, name, shortName, operator, kind, directionLabel, colorKey,
  source: "synthetic" | "gtfs",
  plannedHeadwaySec, startSec, endSec,
  stops: [ { id, code, name, lat, lon, miles, dwellSec } ],
  trips: [ { tripId, routeId, headsign, direction, serviceId,
             stopTimes: [ { stopId, seq, arrivalSec, departureSec, miles, headsign } ] } ],
  observedTrips: [ /* same shape as trips */ ] | null,
  stopIndex: { stopId: stop }
}
```

Times are seconds from the start of the service day and may exceed `86400`.

### What the metrics mean

- **Headway**: gap between consecutive train arrivals at a stop. Regularity is the standard deviation and coefficient of variation of those gaps.
- **Bunching**: a headway shorter than half the planned headway. A **gap** is a headway longer than one and a half times planned. Thresholds are configurable.
- **Excess wait time**: `Var(H) / (2 * E[H])`, the extra average wait a passenger experiences because headways are irregular. This is the passenger-facing reliability metric.
- **Stringline**: one line per train through time (x) and route distance (y). Converging or crossing lines reveal bunching and overtakes.
- **On-time rate**: share of arrivals within a threshold (default 180 s) of the schedule.

## Data notes and provenance

Station names, order, operators, route shapes and cumulative route miles are drawn from published timetables, line maps and milepost charts. Approximate WGS84 anchor coordinates trace each real corridor; station coordinates are interpolated along those anchors by cumulative route distance, so they are approximate, not survey grade.

The preloaded headways, dwell times and service spans are illustrative regular-interval timetables, not extracted live schedules. They exist so the headway, bunching, dwell and delay models run offline with zero dependencies. Upload a real GTFS static bundle or a GTFS-RT feed to replace them with observed data.

## Repository layout

| File | Purpose |
|---|---|
| `corridors.js` | Preloaded corridor bundle (UMD data) |
| `engine.js` | GTFS parser, ZIP reader, timetable builder and analyzers (UMD) |
| `index.html` | Dashboard markup |
| `style.css` | Palette roles, themes and layout |
| `app.js` | SVG chart rendering, controls and GTFS upload |
| `tests/railpulse.test.js` | Unit tests (`node --test tests/`) |

## License

MIT. See [LICENSE](LICENSE).
