# Contributing to RailPulse

Thanks for your interest in RailPulse. This project is a zero-dependency rail
service reliability and graphic timetable workbench that parses GTFS static
archives locally and computes Marey stringlines, headway stability, bunching
rates, and delay propagation. Bug reports, statistical method corrections, and
transport-domain expertise are all welcome.

## Ground rules

- Be respectful and constructive. This project follows the Contributor
  Covenant, found in `CODE_OF_CONDUCT.md`.
- Keep the project dependency free. No `node_modules`, build steps, or runtime
  libraries. Node builtins and the `node:test` runner are fine.
- Keep analysis offline. GTFS archives are opened in the browser and never
  uploaded. Do not add network requests, CDN assets, or analytics.
- Statistical claims need a source. If you change a metric's definition, cite
  the operational standard, paper, or agency methodology you followed.

## Development setup

Requirements:

- Node.js 22 or newer (the test runner is `node --test`)
- A modern browser for manual verification

```sh
git clone https://github.com/draarivpatel-ui/railpulse.git
cd railpulse
node --test
```

To exercise the dispatch desk locally:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## How the code is organised

| File | Role |
| --- | --- |
| `engine.js` | GTFS parsing, the normalised service model, and all statistics (UMD) |
| `corridors.js` | The bundled reference feeds attached to `globalThis.RailPulse` |
| `app.js` | UI wiring: feed loading, stringline rendering, and figure export |
| `index.html`, `style.css` | The workbench shell and its styling |
| `tests/railpulse.test.js` | The test suite |

`corridors.js` attaches its bundle to `globalThis.RailPulse`, so the test suite
loads it before `engine.js`. Preserve that load order if you add fixtures.

## Coding standards

- Use 2-space indentation and double quotes, matching the surrounding file.
- Prefer `const`, and use `let` only when reassignment is required.
- Keep functions small and single purpose. Name them after what they do.
- No comments that restate the code. Comment the reason, the statistic's
  definition, or the trade-off.
- Treat em-dashes and en-dashes as a defect in prose and identifiers. Use
  commas, parentheses, or a plain hyphen instead.
- Never swallow parse errors silently. Fail loudly with the offending file and
  line so a malformed GTFS archive is diagnosable.
- Keep each metric in its own function with a documented formula, and reuse it
  rather than recomputing an inline version.

## Adding a metric or a reference feed

When adding a statistic, include a test against a known answer derived by hand
or from the published definition. When adding a corridor, add the feed to
`corridors.js` and assert at least one characteristic value for it.

## Opening a pull request

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. Every bug fix should include a regression test
  that fails before your fix, and every new metric needs a worked example.
3. Run the full suite locally: `node --test`.
4. Update documentation where behaviour or a formula changed.
5. Open the PR against `main` with:
   - a short summary of what changed and why,
   - the commands you ran and their result,
   - screenshots for UI changes,
   - the citation for any statistical method you changed.
6. Keep the PR small enough to review in one sitting, and respond to review
   promptly.

Commit messages: use a short imperative subject line under 72 characters. Put
the reasoning in the body, not the subject.

## Reporting bugs

Open an issue with the smallest reproduction you can manage: the feed or a
minimal excerpt, the steps you ran, what you expected, and what happened
instead. Security issues follow `SECURITY.md` instead.
