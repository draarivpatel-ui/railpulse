# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/railpulse/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## What to include

- A description of the vulnerability and its impact.
- The affected file, function or component.
- Steps to reproduce, including the smallest synthetic GTFS archive or CSV excerpt.
- The version or commit tested.
- Any suggested remediation.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static RailPulse browser timetable parser and dispatch workbench, including GTFS archive handling, CSV parsing, corridor and dispatch state, rendered workbench output and generated artifacts.

In scope:

- Malformed ZIP entries that evade archive bounds, expansion limits, duplicate-entry checks or traversal protections.
- GTFS CSV parsing or identifier handling defects with a security impact.
- Cross-site scripting or HTML injection through timetable text, stop names, route labels, dispatch output or rendered workbench content.
- A generated CSV, JSON or report export flaw that makes generated output execute a formula or script when opened.
- A validation bypass that corrupts shared state or causes untrusted feed text to influence the DOM as code.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Transit schedule accuracy or operational decisions without a security impact.
- Denial of service from an intentionally malformed feed that only affects the attacker's own browser tab.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.

## Safe harbour

We support good-faith security research. If you follow this policy, we will not pursue legal action against you and we will credit your report if you would like.
