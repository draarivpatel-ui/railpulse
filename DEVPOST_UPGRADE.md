# RailPulse

## Inspiration

A timetable can look regular while one platform incident turns its evenly spaced trains into a queue. We wanted a tool that makes that chain reaction visible and lets a judge inspect the same incident under two dispatch rules within seconds. Marey graphic timetables provide a compact language for connecting station distance, clock time, train spacing, and delay.

## What it does

RailPulse is a local dispatch workbench for GTFS timetables and reproducible corridor scenarios. Three one-click presets establish a smooth baseline, stop one train at a platform, and apply station holds to restore spacing. The main diagram displays scheduled and simulated journeys, including the horizontal segments where a train occupies a platform.

Every train can be inspected with a pointer or keyboard focus. Its exact station ledger lists arrival, departure, dwell, and schedule offset. Supporting views explain headway variation, bunching, service gaps, dwell overrun, and excess passenger wait. A verification badge checks the actual timing data, and a JSON download preserves the report and assumptions.

Judges can also load an agency GTFS ZIP or loose CSV files. Import, decompression, timetable normalization, calculations, and rendering run in the browser. The page makes no network request and uses no external dependency.

## How we built it

The project has three browser scripts and a direct HTML/CSS interface. A shared engine runs unchanged as a plain browser script or a Node module. SVG supplies a scalable Marey diagram and station geography without a visualization library or raster-DPI state.

The importer reads RFC-style quoted CSV, validates archive CRC32 and boundaries, and decodes raw DEFLATE using built-in stored, fixed-Huffman, and dynamic-Huffman logic. Calendars resolve service days before trip analysis. Direction and stop-pattern groups preserve coherent route sequences, including repeat visits on a loop. Interior blank timestamps interpolate between known endpoints; invalid trips are reported rather than turned into midnight departures.

The cascade model preserves scheduled running time and a 45-second shared-platform clearance. The recovery rule holds trains at stations until arrival spacing reaches 75% of planned headway. Excess wait uses population variance divided by twice mean headway, with a hand-computed regression example.

## Challenges

Static GTFS supplies planned times rather than observed reliability. We needed to keep those meanings clear while still providing an immediate offline demonstration. Imported stop coordinates also do not reveal the universal unit of `shape_dist_traveled`, so the distance axis uses an explicitly labeled haversine estimate.

Correctness required handling service days past midnight, calendar exclusions with no active trips, duplicate identifiers, loops, blank stop times, corrupt ZIPs, and asynchronous uploads that finish after a reset. The diagram needed bounded ghost paths, visible platform dwell, readable small-screen behavior, and keyboard inspections that reveal the same numbers as hover.

## Accomplishments

The strongest result is an inspectable dispatch tradeoff. A 900-second platform incident delays three trains and produces a 58.116-second wait penalty in the showcase's measured headway distribution. Station holds remove measured bunching and reduce that penalty to 46.809 seconds. The page also shows the cost: terminal train delay rises from 1,755 to 3,840 seconds. A recovery rule can help spacing while delaying additional trains; the workbench exposes both outcomes.

We also removed silent data corruption paths. Excluded service days stay excluded. Untimed stops no longer become midnight. Loop visits keep distinct cumulative mileposts. Dwell changes propagate downstream. Scheduled views consistently use their requested layer, and large early arrivals fail the same on-time tolerance as large late arrivals.

## Verification numbers

- **202 tests passed, 0 failed, 0 skipped**, verified on Node v26.8.1 with `node --test tests/`.
- **88 engine/import tests**, including archive corruption, three DEFLATE block types, service calendars, direction and pattern groups, loop trips, interpolation, station-hold dwell attribution, and manually derived wait math.
- **97 adversarial hardening tests**, attacking the ZIP reader with forged archives (entry-count lies, split and ZIP64 markers, encrypted members, CRC corruption, non-UTF-8 names), hostile CSV, overnight service-day times, prototype-pollution keys, and stale-upload races, plus direct math checks: sample-sigma headway CV, population-variance excess wait, monotone stringlines, cascade separation and dwell invariants, formula-safe CSV cells, and the SHA-256 export digest.
- **17 DOM runtime tests**, evaluating the actual scripts and markup, startup, presets, keyboard inspection, train tables, theme, upload recovery, inert feed labels, prototype-safe rendering, report download, and the WCAG 2.1.4 single-key shortcut switch.
- **Seven corridor fixtures across five time windows**, exercised in the DOM suite at a 320-pixel viewport with finite SVG-coordinate checks.
- **Seven JavaScript files passed `node --check`**.
- **16 showcase trips, 33 station visits per trip**.
- **2,112 timestamp round trips and 5,313 timetable checks** passed across the scheduled and simulated showcase layers.
- **19.5% lower empirical excess wait** with station spacing holds, with the extra terminal delay reported alongside it.
- **128 MiB compressed/expanded ZIP limit and 1,024-entry limit**, enforced by the importer.
- **Zero runtime dependencies, external assets, build steps, or automatic network requests**.

The DOM suite verifies bindings and generated geometry. It is not a browser screenshot or a substitute for visual review. Bundled corridors are simplified teaching fixtures. The queue and diagnostic grades are illustrative models, not a certified signaling or dispatch optimizer.

## What's next

Add explicit platform assignments, multiple directions, overtaking constraints, and passenger-demand weights to compare dispatch rules against an objective. Extend the structured per-stop update API with a user-configured GTFS-RT adapter. Add export and import of scenario parameters so two reviewers can reproduce the same operating assumptions, and compare real agency feed revisions without a backend.
