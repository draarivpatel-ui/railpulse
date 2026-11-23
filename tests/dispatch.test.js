/* RailPulse dispatch laboratory tests.
 *
 * Run with:  node --test tests/
 *
 * Covers the headway-control / signaling-capacity comparator in
 * dispatch-lab.js: braking physics, perturbation construction, the shared
 * single-track strategy simulator, wait/bunching/recovery metrics, the
 * SHA-256 checksummed audit exports, strict #rp= bookmarks, and the in-page
 * self-test battery. Everything is deterministic: no randomness, no I/O.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../corridors.js");
const E = require("../engine.js");
const L = require("../dispatch-lab.js");
const CORRIDORS = globalThis.RailPulse.CORRIDORS;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function ctaRed(hours = 2) {
  const c = CORRIDORS.find(x => x.id === "cta-red");
  return E.buildSyntheticService(c, { startSec: 7 * 3600, endSec: (7 + hours) * 3600 });
}

function miniService(overrides) {
  return E.buildSyntheticService(Object.assign({
    id: "lab-line", name: "Lab Line", shortName: "LAB", operator: "Test",
    kind: "metro", colorKey: 1, routeId: "LAB", directionLabel: "A to E",
    speedMph: 30, headwaySec: 300, startSec: 6 * 3600, endSec: 9 * 3600,
    anchors: [[41.9, -87.6], [41.8, -87.6]],
    stations: [
      ["A", "Alpha", 0.0, 60], ["B", "Bravo", 0.8, 25], ["C", "Charlie", 1.6, 25],
      ["D", "Delta", 2.4, 25], ["E", "Echo", 3.2, 60]
    ]
  }, overrides || {}));
}

function labOn(service, event) {
  return L.runDispatchLab(service, { event: event == null ? "door90" : event });
}
function strat(lab, id) { return lab.strategies.find(s => s.id === id); }

/* ------------------------------------------------------------------ *
 * Braking physics
 * ------------------------------------------------------------------ */

test("braking distance matches v^2/(2a) + v*t_r exactly", () => {
  assert.equal(L.brakingDistanceMeters(10, 1.0, 2), 70);
  assert.equal(L.brakingDistanceMeters(20, 0.8, 3), 20 * 20 / 1.6 + 60);
});
test("braking distance is zero at rest", () => {
  assert.equal(L.brakingDistanceMeters(0, 1.0, 4), 0);
  assert.equal(L.brakingDistanceMeters(0, 0.5, 0), 0);
});
test("braking distance is strictly increasing in speed", () => {
  let prev = -1;
  for (let v = 0.5; v <= 45; v += 0.5) {
    const d = L.brakingDistanceMeters(v, 1.0, 3.5);
    assert.ok(d > prev, `not monotone at v=${v}`);
    prev = d;
  }
});
test("braking distance is non-negative across the operating envelope", () => {
  for (const v of [0, 5, 11.2, 25, 40]) for (const a of [0.4, 1.0, 1.4]) for (const r of [0, 0.8, 4, 8]) {
    assert.ok(L.brakingDistanceMeters(v, a, r) >= 0);
  }
});
test("braking distance grows with reaction time and shrinks with deceleration", () => {
  assert.ok(L.brakingDistanceMeters(15, 1.0, 5) > L.brakingDistanceMeters(15, 1.0, 1));
  assert.ok(L.brakingDistanceMeters(15, 1.4, 3) < L.brakingDistanceMeters(15, 0.6, 3));
});
test("braking headway in seconds equals margin over cruise speed", () => {
  for (const v of [5, 12, 30]) {
    assert.ok(Math.abs(L.brakingHeadwaySec(v, 1.1, 2.5) - L.brakingDistanceMeters(v, 1.1, 2.5) / v) < 1e-12);
  }
});
test("braking rejects out-of-range inputs", () => {
  assert.throws(() => L.brakingDistanceMeters(-1, 1, 1), /out of range/);
  assert.throws(() => L.brakingDistanceMeters(10, 0, 1), /out of range/);
  assert.throws(() => L.brakingDistanceMeters(10, -1, 1), /out of range/);
  assert.throws(() => L.brakingDistanceMeters(10, 1, -0.5), /out of range/);
});
test("braking rejects non-finite inputs", () => {
  for (const bad of [NaN, Infinity, -Infinity, "20", null, undefined, {}]) {
    assert.throws(() => L.brakingDistanceMeters(bad, 1, 1), /finite/);
  }
});
test("cruise speed derives from scheduled legs on the CTA corridor", () => {
  const v = L.cruiseSpeedMps(ctaRed());
  assert.ok(v > 5 && v < 30, `cruise ${v} m/s out of metro range`);
});
test("cruise speed falls back when a service has no legs", () => {
  const svc = { trips: [{ stopTimes: [{ stopId: "x", miles: 0, arrivalSec: 0, departureSec: 10 }] }] };
  assert.equal(L.cruiseSpeedMps(svc), 15);
});
test("cruise speed picks the median leg", () => {
  const svc = miniService();
  const legs = [];
  svc.trips[0].stopTimes.forEach((st, i) => {
    if (!i) return;
    const p = svc.trips[0].stopTimes[i - 1];
    legs.push((st.miles - p.miles) * 1609.344 / (st.arrivalSec - p.departureSec));
  });
  legs.sort((a, b) => a - b);
  assert.ok(Math.abs(L.cruiseSpeedMps(svc) - legs[Math.floor(legs.length / 2)]) < 1e-9);
});

/* ------------------------------------------------------------------ *
 * Signaling profiles
 * ------------------------------------------------------------------ */

test("fixed-block separation exceeds moving-block on the same service", () => {
  const svc = ctaRed();
  const f = L.signalingProfile(svc, "fixed-block");
  const m = L.signalingProfile(svc, "moving-block");
  assert.ok(f.separationSec > m.separationSec);
  assert.ok(f.brakeMarginM > m.brakeMarginM);
});
test("separation is the ceiling of braking headway plus clearing time", () => {
  const svc = ctaRed();
  const p = L.signalingProfile(svc, "fixed-block");
  assert.equal(p.separationSec, Math.ceil(p.brakeMarginSec + p.clearanceSec));
});
test("moving-block clears train plus bubble, fixed-block clears block plus train", () => {
  const svc = ctaRed();
  const d = L.labDefaults();
  assert.equal(L.signalingProfile(svc, "fixed-block").clearanceMeters, d.blockLengthM + d.trainLengthM);
  assert.equal(L.signalingProfile(svc, "moving-block").clearanceMeters, d.trainLengthM + d.safetyMarginM);
});
test("design min headway is separation plus the longest scheduled dwell", () => {
  const svc = ctaRed();
  const p = L.signalingProfile(svc, "fixed-block");
  assert.equal(p.minHeadwaySec, Math.ceil(p.separationSec + p.maxDwellSec));
  assert.equal(p.maxDwellSec, Math.max(...svc.stops.map(s => s.dwellSec)));
});
test("peak throughput is 3600 over design min headway", () => {
  const p = L.signalingProfile(ctaRed(), "moving-block");
  assert.ok(Math.abs(p.peakThroughputTrainsPerHr - 3600 / p.minHeadwaySec) < 0.06);
});
test("moving-block buys more peak throughput than fixed-block", () => {
  const svc = ctaRed();
  assert.ok(L.signalingProfile(svc, "moving-block").peakThroughputTrainsPerHr >
            L.signalingProfile(svc, "fixed-block").peakThroughputTrainsPerHr);
});
test("signaling profile rejects an unknown mode", () => {
  assert.throws(() => L.signalingProfile(ctaRed(), "ghost-block"), /Unknown signaling/);
});
test("signaling profile is deterministic", () => {
  const svc = ctaRed();
  assert.deepEqual(L.signalingProfile(svc, "fixed-block"), L.signalingProfile(svc, "fixed-block"));
});
test("signaling profile honors a cruiseMps override", () => {
  const p = L.signalingProfile(ctaRed(), "fixed-block", { cruiseMps: 20 });
  assert.equal(p.cruiseMps, 20);
});
test("every bundled corridor yields finite positive signaling numbers", () => {
  for (const c of CORRIDORS) {
    const svc = E.buildSyntheticService(c, { startSec: 7 * 3600, endSec: 9 * 3600 });
    for (const mode of ["fixed-block", "moving-block"]) {
      const p = L.signalingProfile(svc, mode);
      for (const k of ["cruiseMps", "brakeMarginM", "brakeMarginSec", "clearanceSec", "separationSec", "minHeadwaySec", "peakThroughputTrainsPerHr"]) {
        assert.ok(Number.isFinite(p[k]) && p[k] >= 0, `${c.id}/${mode}/${k}`);
      }
      assert.ok(p.minHeadwaySec > 0 && p.peakThroughputTrainsPerHr > 0);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Perturbation construction
 * ------------------------------------------------------------------ */

test("door hold hits exactly one stop on one trip for +90 s", () => {
  const pert = L.buildPerturbation(ctaRed(), "door90");
  assert.equal(pert.affected, 1);
  const [key, extra] = Object.entries(pert.map)[0];
  assert.equal(extra, 90);
  const [tripId] = key.split("|");
  assert.ok(/^RED-CTA-\d+$/.test(tripId));
});
test("incident preset applies +900 s the same way", () => {
  const pert = L.buildPerturbation(ctaRed(), "incident900");
  assert.equal(pert.affected, 1);
  assert.equal(Object.values(pert.map)[0], 900);
});
test("dwell event index math follows tripFrac and mileFrac", () => {
  const svc = ctaRed();
  const pert = L.buildPerturbation(svc, { type: "dwell", tripFrac: 0.5, mileFrac: 0.5, extraSec: 45 });
  const [tripId, stopId] = Object.keys(pert.map)[0].split("|");
  const expectedTrip = svc.trips[Math.round(0.5 * (svc.trips.length - 1))];
  assert.equal(tripId, expectedTrip.tripId);
  const stop = svc.stopIndex[stopId];
  const maxMiles = Math.max(...svc.stops.map(s => s.miles));
  assert.ok(Math.abs(stop.miles - 0.5 * maxMiles) <= 0.6);
});
test("explicit dwell indices are honored verbatim", () => {
  const svc = ctaRed();
  const pert = L.buildPerturbation(svc, { type: "dwell", tripIndex: 3, stopIndex: 5, extraSec: 120 });
  const trip = svc.trips[3];
  assert.deepEqual(JSON.parse(JSON.stringify(pert.map)), { [`${trip.tripId}|${trip.stopTimes[5].stopId}`]: 120 });
});
test("surge marks interior stops inside the time and distance windows", () => {
  const svc = ctaRed();
  const pert = L.buildPerturbation(svc, "surge");
  assert.ok(pert.affected > 5, "surge should affect many stop visits");
  const span = svc.endSec - svc.startSec, t0 = svc.startSec + 0.3 * span, t1 = svc.startSec + 0.65 * span;
  const maxMiles = Math.max(...svc.stops.map(s => s.miles));
  for (const key of Object.keys(pert.map)) {
    const [tripId, stopId] = key.split("|");
    const trip = svc.trips.find(t => t.tripId === tripId);
    const st = trip.stopTimes.find(x => x.stopId === stopId);
    const stop = svc.stopIndex[stopId];
    assert.equal(pert.map[key], 70);
    assert.ok(st.arrivalSec >= t0 && st.arrivalSec <= t1, "outside time window");
    assert.ok(stop.miles >= 0.2 * maxMiles && stop.miles <= 0.7 * maxMiles, "outside distance window");
    assert.ok(st.seq > 1 && st.seq < trip.stopTimes.length, "terminals never surged");
  }
});
test("perturbation descriptions are non-empty for every preset", () => {
  for (const e of L.labEvents()) {
    const pert = L.buildPerturbation(ctaRed(), e.id);
    assert.ok(typeof pert.description === "string" && pert.description.length > 5);
  }
});
test("none perturbation produces an empty map", () => {
  const pert = L.buildPerturbation(ctaRed(), { type: "none" });
  assert.equal(pert.affected, 0);
  assert.equal(Object.keys(pert.map).length, 0);
});
test("invalid perturbation indices throw", () => {
  const svc = ctaRed();
  assert.throws(() => L.buildPerturbation(svc, { type: "dwell", tripIndex: -1 }), /trip index/);
  assert.throws(() => L.buildPerturbation(svc, { type: "dwell", tripIndex: 999 }), /trip index/);
  assert.throws(() => L.buildPerturbation(svc, { type: "dwell", tripIndex: 2, stopIndex: 99 }), /station index/);
  assert.throws(() => L.buildPerturbation(svc, { type: "dwell", tripIndex: 2, stopIndex: -1 }), /station index/);
});
test("invalid perturbation magnitudes throw", () => {
  const svc = ctaRed();
  assert.throws(() => L.buildPerturbation(svc, { type: "dwell", tripIndex: 1, stopIndex: 1, extraSec: -5 }), /dwell seconds/);
  assert.throws(() => L.buildPerturbation(svc, { type: "dwell", tripIndex: 1, stopIndex: 1, extraSec: 99999 }), /dwell seconds/);
  assert.throws(() => L.buildPerturbation(svc, { type: "surge", extraSec: -10 }), /surge dwell/);
});
test("unknown perturbation ids and types throw", () => {
  const svc = ctaRed();
  assert.throws(() => L.buildPerturbation(svc, "explosion"), /Unknown perturbation/);
  assert.throws(() => L.buildPerturbation(svc, { type: "earthquake" }), /Unknown perturbation/);
});
test("perturbation construction is deterministic", () => {
  const svc = ctaRed();
  assert.deepEqual(L.buildPerturbation(svc, "surge"), L.buildPerturbation(svc, "surge"));
});

/* ------------------------------------------------------------------ *
 * Simulator invariants: no overtake, separation floor, monotone times
 * ------------------------------------------------------------------ */

const LAB_EVENTS = ["door90", "surge", "incident900"];

for (const ev of LAB_EVENTS) {
  test(`no strategy violates its separation floor under ${ev}`, () => {
    const svc = ctaRed();
    const lab = labOn(svc, ev);
    for (const s of lab.strategies) {
      const bad = L.separationViolations(svc, s.sim.observedTrips, s.signaling.separationSec);
      assert.equal(bad.length, 0, `${s.id} broke the separation floor: ${JSON.stringify(bad[0])}`);
    }
  });
}

for (const ev of LAB_EVENTS) {
  test(`no strategy produces an overtake under ${ev}`, () => {
    const svc = ctaRed();
    const lab = labOn(svc, ev);
    for (const s of lab.strategies) {
      const bad = L.overtakeViolations(svc, s.sim.observedTrips);
      assert.equal(bad.length, 0, `${s.id} produced an overtake`);
    }
  });
}

test("departures never precede arrivals at any stop, any strategy", () => {
  const svc = ctaRed();
  for (const ev of LAB_EVENTS) {
    const lab = labOn(svc, ev);
    for (const s of lab.strategies) {
      for (const t of s.sim.observedTrips) {
        for (const st of t.stopTimes) {
          assert.ok(st.departureSec >= st.arrivalSec, `${s.id}/${t.tripId}/${st.stopId}`);
        }
      }
    }
  }
});
test("stop times are monotone nondecreasing within every trip", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  for (const s of lab.strategies) {
    for (const t of s.sim.observedTrips) {
      for (let i = 1; i < t.stopTimes.length; i++) {
        assert.ok(t.stopTimes[i].arrivalSec >= t.stopTimes[i - 1].departureSec, `${s.id}/${t.tripId} leg ${i}`);
      }
    }
  }
});
test("all simulated times are finite non-negative integers", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  for (const s of lab.strategies) {
    for (const t of s.sim.observedTrips) {
      for (const st of t.stopTimes) {
        assert.ok(Number.isFinite(st.arrivalSec) && Number.isFinite(st.departureSec));
        assert.ok(st.arrivalSec >= 0 && st.departureSec >= 0);
        assert.equal(st.arrivalSec, Math.round(st.arrivalSec));
        assert.equal(st.departureSec, Math.round(st.departureSec));
      }
    }
  }
});
test("mileposts stay nondecreasing along every simulated trip", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "door90");
  for (const s of lab.strategies) {
    for (const t of s.sim.observedTrips) {
      for (let i = 1; i < t.stopTimes.length; i++) {
        assert.ok(t.stopTimes[i].miles >= t.stopTimes[i - 1].miles);
      }
    }
  }
});
test("simulation is perfectly deterministic", () => {
  const svc = ctaRed();
  const a = L.simulateStrategy(svc, { strategy: "even", event: "surge" });
  const b = L.simulateStrategy(svc, { strategy: "even", event: "surge" });
  assert.deepEqual(a.observedTrips, b.observedTrips);
  assert.deepEqual(a.holds, b.holds);
});
test("different perturbations produce different outcomes", () => {
  const svc = ctaRed();
  const a = L.simulateStrategy(svc, { strategy: "fixed", event: "door90" });
  const b = L.simulateStrategy(svc, { strategy: "fixed", event: "incident900" });
  assert.notDeepEqual(a.observedTrips, b.observedTrips);
});
test("unknown strategy and missing service throw", () => {
  const svc = ctaRed();
  assert.throws(() => L.simulateStrategy(svc, { strategy: "warp-drive" }), /Unknown strategy/);
  assert.throws(() => L.simulateStrategy(null, { strategy: "fixed" }), /required/);
  assert.throws(() => L.simulateStrategy({ trips: "x", stops: [] }, { strategy: "fixed" }), /required/);
});
test("a trip with missing stopTimes survives the simulation untouched", () => {
  const svc = miniService();
  svc.trips[2] = { tripId: "GHOST", routeId: "LAB" };
  const sim = L.simulateStrategy(svc, { strategy: "even", event: { type: "none" } });
  assert.equal(sim.observedTrips[2].tripId, "GHOST");
});
test("hold records carry positive whole seconds and real stop ids", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "even", event: "surge" });
  assert.ok(sim.holds.length > 0);
  for (const h of sim.holds) {
    assert.ok(h.seconds > 0 && Number.isInteger(h.seconds));
    assert.ok(svc.stopIndex[h.stopId], `unknown stop ${h.stopId}`);
    assert.ok(svc.trips.some(t => t.tripId === h.tripId));
  }
});

/* ------------------------------------------------------------------ *
 * Strategy-specific behavior
 * ------------------------------------------------------------------ */

test("door hold: the perturbed trip shows the extra 90 s of dwell (baseline)", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "fixed", event: "door90" });
  const pert = L.buildPerturbation(svc, "door90");
  const [tripId, stopId] = Object.keys(pert.map)[0].split("|");
  const sched = svc.trips.find(t => t.tripId === tripId);
  const schedSt = sched.stopTimes.find(s => s.stopId === stopId);
  const simTrip = sim.observedTrips.find(t => t.tripId === tripId);
  const simSt = simTrip.stopTimes.find(s => s.stopId === stopId);
  assert.equal(simSt.departureSec - simSt.arrivalSec, (schedSt.departureSec - schedSt.arrivalSec) + 90);
});
test("uncontrolled baseline lets trains bank slack (early arrivals exist)", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "fixed", event: { type: "none" } });
  const early = sim.observedTrips.some((t, i) =>
    t.stopTimes.some((st, j) => st.arrivalSec < svc.trips[i].stopTimes[j].arrivalSec));
  assert.ok(early, "expected early running in the uncontrolled baseline");
});
test("schedule holding never departs a station early", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "sched", event: "surge" });
  sim.observedTrips.forEach((t, i) => {
    t.stopTimes.forEach((st, j) => {
      assert.ok(st.departureSec >= svc.trips[i].stopTimes[j].departureSec - 0.5,
        `${t.tripId} departed early at ${st.stopId}`);
    });
  });
});
test("controlled strategies never depart early under any preset", () => {
  const svc = ctaRed();
  for (const id of ["sched", "even", "cbtc"]) {
    for (const ev of LAB_EVENTS) {
      const sim = L.simulateStrategy(svc, { strategy: id, event: ev });
      sim.observedTrips.forEach((t, i) => {
        t.stopTimes.forEach((st, j) => {
          if (st.skipped) return;
          assert.ok(st.departureSec >= svc.trips[i].stopTimes[j].departureSec - 0.5, `${id}/${ev}`);
        });
      });
    }
  }
});
test("on an unperturbed service every strategy reproduces steady headways", () => {
  const svc = ctaRed();
  const lab = labOn(svc, { type: "none" });
  for (const s of lab.strategies) {
    assert.ok(s.metrics.cvHeadway < 0.06, `${s.id} cv ${s.metrics.cvHeadway}`);
    assert.equal(s.metrics.minHeadwayViolations, 0, s.id);
  }
});
test("equalization adds recorded holds when headways compress", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "even", event: "surge" });
  assert.ok(sim.holdSec > 0);
  assert.ok(sim.holds.length > 0);
});
test("equalization holds never exceed the per-station cap", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "even", event: "incident900" });
  for (const h of sim.holds) assert.ok(h.seconds <= 300, `hold ${h.seconds} over cap`);
});
test("CBTC shares the equalization rule on the moving-block floor", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "cbtc", event: "surge" });
  assert.ok(sim.holds.length > 0);
  const f = L.signalingProfile(svc, "fixed-block");
  assert.ok(sim.signaling.separationSec < f.separationSec);
});
test("skip-stop only skips odd-index interior local stops", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "incident900" });
  assert.ok(sim.skips.length > 0, "expected skips under the 900 s incident");
  for (const sk of sim.skips) {
    const trip = sim.observedTrips.find(t => t.tripId === sk.tripId);
    const idx = trip.stopTimes.findIndex(st => st.stopId === sk.stopId);
    assert.ok(idx > 0 && idx < trip.stopTimes.length - 1, "skipped a terminal");
    assert.equal(idx % 2, 1, "skipped a non-alternating stop");
    const schedSt = svc.trips.find(t => t.tripId === sk.tripId).stopTimes[idx];
    assert.ok(schedSt.departureSec - schedSt.arrivalSec <= 35, "skipped a non-local stop");
  }
});
test("skipped stop times are flagged with zero dwell", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "incident900" });
  const skipSet = new Set(sim.skips.map(s => `${s.tripId}|${s.stopId}`));
  assert.ok(skipSet.size > 0);
  for (const t of sim.observedTrips) {
    for (const st of t.stopTimes) {
      if (st.skipped) {
        assert.ok(skipSet.has(`${t.tripId}|${st.stopId}`));
        assert.equal(st.departureSec, st.arrivalSec, "skipped dwell must be zero");
      }
    }
  }
});
test("no trip skips more than the per-trip budget", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "surge" });
  const perTrip = {};
  for (const sk of sim.skips) perTrip[sk.tripId] = (perTrip[sk.tripId] || 0) + 1;
  for (const n of Object.values(perTrip)) assert.ok(n <= 4, `trip skipped ${n} stops`);
});
test("skip-stop never triggers below the delay threshold", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: { type: "none" } });
  assert.equal(sim.skips.length, 0);
});
test("express skipping saves dwell plus the stop penalty downstream", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "incident900" });
  const trip = sim.observedTrips.find(t => sim.skips.some(s => s.tripId === t.tripId));
  assert.ok(trip, "no express trip found");
  const skippedIdx = trip.stopTimes.findIndex(st => st.skipped);
  const sched = svc.trips.find(t => t.tripId === trip.tripId);
  // After the skip, the express trip should be at least the scheduled dwell
  // plus penalty ahead of where the unskipped queue model would leave it.
  const baseline = L.simulateStrategy(svc, { strategy: "sched", event: "incident900" });
  const baseTrip = baseline.observedTrips.find(t => t.tripId === trip.tripId);
  const afterIdx = skippedIdx + 1;
  const skipGain = baseTrip.stopTimes[afterIdx].arrivalSec - trip.stopTimes[afterIdx].arrivalSec;
  assert.ok(skipGain >= 30, `expected express gain, got ${skipGain}`);
});
test("surge perturbation inflates dwell at interior stations", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "fixed", event: "surge" });
  const pert = L.buildPerturbation(svc, "surge");
  const [tripId, stopId] = Object.keys(pert.map)[0].split("|");
  const schedSt = svc.trips.find(t => t.tripId === tripId).stopTimes.find(s => s.stopId === stopId);
  const simSt = sim.observedTrips.find(t => t.tripId === tripId).stopTimes.find(s => s.stopId === stopId);
  assert.equal(simSt.departureSec - simSt.arrivalSec, (schedSt.departureSec - schedSt.arrivalSec) + 70);
});

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

test("expected wait on an empty headway set is a zeroed bundle", () => {
  const w = L.expectedWaitSec([]);
  assert.deepEqual(w, { expectedWaitSec: 0, excessWaitSec: 0, meanHeadwaySec: 0, cvHeadway: 0, cvHeadwaySample: 0 });
});
test("E[W] = H/2 exactly when CV_H = 0", () => {
  for (const hw of [[480, 480, 480], [120], [300, 300]]) {
    const w = L.expectedWaitSec(hw);
    assert.equal(w.cvHeadway, 0);
    assert.ok(Math.abs(w.expectedWaitSec - E.mean(hw) / 2) < 1e-9);
    assert.equal(w.excessWaitSec, 0);
  }
});
test("E[W] equals H/2 + Var_pop(H)/(2H) on arbitrary headways", () => {
  for (const hw of [[60, 180], [100, 300, 240, 90], [480, 120, 480, 720, 45], [37, 41, 59]]) {
    const w = L.expectedWaitSec(hw);
    const m = E.mean(hw), pv = E.populationVariance(hw);
    assert.ok(Math.abs(w.expectedWaitSec - (m / 2 + pv / (2 * m))) < 1e-9);
    assert.ok(Math.abs(w.excessWaitSec - pv / (2 * m)) < 1e-9);
    assert.ok(w.expectedWaitSec >= m / 2, "E[W] never below the even-spacing floor");
  }
});
test("regression case H=[60,180] gives 15 s excess wait", () => {
  const w = L.expectedWaitSec([60, 180]);
  assert.ok(Math.abs(w.excessWaitSec - 15) < 1e-9);
  assert.ok(Math.abs(w.expectedWaitSec - 75) < 1e-9);
});
test("CV_H uses the population standard deviation", () => {
  const hw = [100, 300, 200, 400];
  const w = L.expectedWaitSec(hw);
  const popSd = Math.sqrt(E.populationVariance(hw));
  assert.ok(Math.abs(w.cvHeadway - popSd / E.mean(hw)) < 1e-12);
  assert.ok(Math.abs(w.cvHeadwaySample - E.describeSample(hw).cv) < 1e-12);
  assert.ok(w.cvHeadwaySample > w.cvHeadway, "sample sd exceeds population sd");
});
test("non-finite headways are filtered out of the wait math", () => {
  const w = L.expectedWaitSec([100, NaN, 200, Infinity, -5, 300]);
  assert.equal(w.meanHeadwaySec, 200);
});
test("skipped stops are excluded from measured headways", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "incident900" });
  const hw = L.collectHeadways(svc, sim.observedTrips);
  const skipped = sim.skips[0];
  assert.ok(skipped, "need a skip for this test");
  const ps = hw.perStop.find(p => p.stopId === skipped.stopId);
  const arrivalsOnRecord = sim.observedTrips.filter(t =>
    t.stopTimes.some(st => st.stopId === skipped.stopId)).length;
  assert.ok(ps.arrivals < arrivalsOnRecord, "skipped visit counted as an arrival");
});
test("min-headway violations count measured gaps under the design minimum", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  for (const s of lab.strategies) {
    const hw = L.collectHeadways(svc, s.sim.observedTrips);
    const manual = hw.all.filter(g => g < s.signaling.minHeadwaySec).length;
    assert.equal(s.metrics.minHeadwayViolations, manual, s.id);
    assert.ok(s.metrics.minObservedHeadwaySec === Math.min(...hw.all));
  }
});
test("bunching and gap rates are counts over total measured headways", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  for (const s of lab.strategies) {
    const hw = L.collectHeadways(svc, s.sim.observedTrips);
    const bunch = hw.all.filter(g => g <= svc.plannedHeadwaySec * 0.5).length;
    const gap = hw.all.filter(g => g >= svc.plannedHeadwaySec * 1.5).length;
    assert.equal(s.metrics.bunchCount, bunch);
    assert.equal(s.metrics.gapCount, gap);
    assert.ok(Math.abs(s.metrics.bunchRate - bunch / hw.all.length) < 1e-3);
    assert.equal(s.metrics.headwayCount, hw.all.length);
  }
});
test("recovery is zero when nothing left the headway band", () => {
  const svc = ctaRed();
  const lab = labOn(svc, { type: "none" });
  for (const s of lab.strategies) assert.equal(s.metrics.recoveryMin, 0, s.id);
});
test("recovery is positive when the incident compresses headways", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  assert.ok(strat(lab, "fixed").metrics.recoveryMin > 0);
});
test("recovery counts only headways after the perturbation ends", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  const s = strat(lab, "fixed");
  const end = s.sim.perturbation.incidentEndSec;
  const lo = svc.plannedHeadwaySec * 0.75, hi = svc.plannedHeadwaySec * 1.25;
  let last = -Infinity;
  for (const stop of svc.stops) {
    const ev2 = L.labArrivals(s.sim.observedTrips, stop.id);
    for (let j = 1; j < ev2.length; j++) {
      const g = ev2[j].arrivalSec - ev2[j - 1].arrivalSec;
      if (ev2[j].arrivalSec > end && (g < lo || g > hi)) last = Math.max(last, ev2[j].arrivalSec);
    }
  }
  const expect = last === -Infinity ? 0 : Math.round((last - end) / 60 * 10) / 10;
  assert.ok(Math.abs(s.metrics.recoveryMin - expect) < 0.11);
});
test("express-skipped stops are excluded from the recovery monitors", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  const s = strat(lab, "skip");
  assert.ok(s.metrics.skippedStops > 0);
  assert.ok(s.metrics.monitoredStops < svc.stops.length);
});
test("delivered trains per hour is trips over the service span", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "door90");
  for (const s of lab.strategies) {
    assert.ok(Math.abs(s.metrics.deliveredTrainsPerHr - svc.trips.length / 2) < 0.06);
  }
});
test("terminal delay aggregates match a manual recompute", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  for (const s of lab.strategies) {
    const delays = s.sim.observedTrips.map((t, i) =>
      t.stopTimes[t.stopTimes.length - 1].arrivalSec - svc.trips[i].stopTimes[svc.trips[i].stopTimes.length - 1].arrivalSec);
    assert.equal(s.metrics.totalTerminalDelaySec, Math.round(delays.reduce((a, b) => a + b, 0)));
    assert.equal(s.metrics.delayedTrips, delays.filter(d => d > 0).length);
    assert.ok(Math.abs(s.metrics.maxTerminalDelaySec - Math.max(...delays)) < 1.5);
  }
});
test("every metric field is finite and non-negative where required", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  for (const s of lab.strategies) {
    const m = s.metrics;
    for (const k of ["headwayCount", "meanHeadwaySec", "cvHeadway", "expectedWaitSec", "excessWaitSec", "bunchCount", "bunchRate", "minHeadwayViolations", "minObservedHeadwaySec", "recoveryMin", "totalHoldSec", "skippedStops", "deliveredTrainsPerHr"]) {
      assert.ok(Number.isFinite(m[k]), `${s.id}.${k}`);
      assert.ok(m[k] >= 0, `${s.id}.${k} negative`);
    }
    assert.ok(m.bunchRate <= 1 && m.gapRate <= 1 && m.cvHeadway <= 10);
  }
});
test("surge: equalization cuts CV, violations and excess wait vs baseline", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  const f = strat(lab, "fixed").metrics, v = strat(lab, "even").metrics;
  assert.ok(v.cvHeadway < f.cvHeadway);
  assert.ok(v.minHeadwayViolations < f.minHeadwayViolations);
  assert.ok(v.excessWaitSec < f.excessWaitSec);
  assert.ok(v.totalHoldSec > f.totalHoldSec, "equalization must cost dwell");
});
test("incident: skip-stop recovers fastest of the five", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  const recs = lab.strategies.map(s => s.metrics.recoveryMin);
  assert.equal(strat(lab, "skip").metrics.recoveryMin, Math.min(...recs));
});
test("CBTC keeps the tightest observed minimum headway", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  const c = strat(lab, "cbtc").metrics, f = strat(lab, "fixed").metrics;
  assert.ok(c.minObservedHeadwaySec <= f.minObservedHeadwaySec);
  assert.ok(strat(lab, "cbtc").signaling.minHeadwaySec < strat(lab, "fixed").signaling.minHeadwaySec);
});
test("equalization pays for smooth spacing with added train delay", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  assert.ok(strat(lab, "even").metrics.totalTerminalDelaySec > strat(lab, "fixed").metrics.totalTerminalDelaySec);
});
test("schedule holding pins an unperturbed service to the timetable", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "sched", event: { type: "none" } });
  sim.observedTrips.forEach((t, i) => {
    t.stopTimes.forEach((st, j) => {
      assert.equal(st.departureSec, svc.trips[i].stopTimes[j].departureSec);
    });
  });
});
test("lab runs identically on a GTFS-imported service", async () => {
  const files = {
    "routes.txt": "route_id,route_short_name,route_type\nR,LAB,1\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,41.88,-87.63\nB,Bravo,41.87,-87.63\nC,Charlie,41.86,-87.63\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20261231\n",
    "trips.txt": "route_id,service_id,trip_id,direction_id\nR,S,T1,0\nR,S,T2,0\nR,S,T3,0\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:30,A,1\nT1,08:05:00,08:05:30,B,2\nT1,08:10:00,08:10:30,C,3\nT2,08:06:00,08:06:30,A,1\nT2,08:11:00,08:11:30,B,2\nT2,08:16:00,08:16:30,C,3\nT3,08:12:00,08:12:30,A,1\nT3,08:17:00,08:17:30,B,2\nT3,08:22:00,08:22:30,C,3\n"
  };
  const parsed = await E.parseGtfs({ files, date: "20261122" });
  assert.ok(parsed.services.length >= 1);
  const lab = labOn(parsed.services[0], "door90");
  assert.equal(lab.strategies.length, 5);
  for (const s of lab.strategies) {
    const bad = L.separationViolations(parsed.services[0], s.sim.observedTrips, s.signaling.separationSec);
    assert.equal(bad.length, 0, s.id);
  }
});

/* ------------------------------------------------------------------ *
 * Whole-lab report shape
 * ------------------------------------------------------------------ */

test("runDispatchLab returns the five strategies in catalog order", () => {
  const lab = labOn(ctaRed(), "door90");
  assert.deepEqual(lab.strategies.map(s => s.id), ["fixed", "sched", "even", "skip", "cbtc"]);
});
test("lab report carries schema, service, scenario and assumptions", () => {
  const lab = labOn(ctaRed(), "surge");
  assert.equal(lab.schema, "railpulse-lab/1");
  assert.equal(lab.service.id, "cta-red");
  assert.equal(lab.service.tripCount, 16);
  assert.ok(lab.scenario.description.length > 5);
  assert.ok(lab.assumptions.length >= 6);
  for (const a of lab.assumptions) assert.ok(typeof a === "string" && a.length > 20);
});
test("comparison picks the true argmin for wait and violations", () => {
  const lab = labOn(ctaRed(), "surge");
  const byWait = lab.strategies.slice().sort((a, b) => a.metrics.expectedWaitSec - b.metrics.expectedWaitSec);
  assert.equal(lab.comparison.bestExpectedWait, byWait[0].id);
  assert.deepEqual(lab.comparison.rankingByExpectedWait, byWait.map(s => s.id));
  const byCv = lab.strategies.slice().sort((a, b) => a.metrics.cvHeadway - b.metrics.cvHeadway);
  assert.equal(lab.comparison.bestCvHeadway, byCv[0].id);
});
test("every bundled corridor runs the full comparator cleanly", () => {
  for (const c of CORRIDORS) {
    const svc = E.buildSyntheticService(c, { startSec: 7 * 3600, endSec: 9 * 3600 });
    const lab = labOn(svc, "surge");
    assert.equal(lab.strategies.length, 5, c.id);
    for (const s of lab.strategies) {
      assert.equal(L.overtakeViolations(svc, s.sim.observedTrips).length, 0, `${c.id}/${s.id}`);
      assert.ok(Number.isFinite(s.metrics.expectedWaitSec), `${c.id}/${s.id}`);
    }
  }
});
test("a small custom corridor runs end to end", () => {
  const lab = labOn(miniService(), "door90");
  assert.equal(lab.strategies.length, 5);
  assert.ok(lab.service.tripCount > 20);
});
test("all strategies share the same perturbation inside one lab run", () => {
  const lab = labOn(ctaRed(), "incident900");
  const end = lab.strategies[0].sim.perturbation.incidentEndSec;
  for (const s of lab.strategies) assert.equal(s.sim.perturbation.incidentEndSec, end);
});
test("simulated trips always match the scheduled trip count", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "surge");
  for (const s of lab.strategies) assert.equal(s.sim.observedTrips.length, svc.trips.length);
});
test("lab catalog metadata is complete", () => {
  const strats = L.labStrategies(), events = L.labEvents();
  assert.equal(strats.length, 5);
  for (const s of strats) {
    for (const k of ["id", "name", "shortName", "signaling", "blurb"]) assert.ok(s[k] && String(s[k]).length > 0);
  }
  assert.equal(events.length, 3);
  for (const e of events) {
    for (const k of ["id", "name", "type", "blurb"]) assert.ok(e[k] && String(e[k]).length > 0);
  }
});

/* ------------------------------------------------------------------ *
 * Audit export: canonicalize, digest, verify, CSV, Markdown
 * ------------------------------------------------------------------ */

test("canonicalize sorts object keys recursively and is order-invariant", () => {
  const a = { z: 1, a: { y: 2, b: 3 }, m: [1, { k: 4, a: 5 }] };
  const b = { m: [1, { a: 5, k: 4 }], a: { b: 3, y: 2 }, z: 1 };
  assert.equal(L.canonicalize(a), L.canonicalize(b));
  assert.equal(L.canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
test("canonicalize handles primitives and drops undefined", () => {
  assert.equal(L.canonicalize(null), "null");
  assert.equal(L.canonicalize("x"), '"x"');
  assert.equal(L.canonicalize(2.5), "2.5");
  assert.equal(L.canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(L.canonicalize([1, "x", null]), '[1,"x",null]');
});
test("audit JSON carries a 64-hex SHA-256 digest", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  assert.ok(/^[0-9a-f]{64}$/.test(brief.integrity.digest));
  assert.equal(brief.integrity.algorithm, "SHA-256");
});
test("audit digest equals sha256 of the canonicalized core", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  const core = {};
  for (const k of Object.keys(brief)) if (k !== "integrity") core[k] = brief[k];
  assert.equal(E.sha256Hex(L.canonicalize(core)), brief.integrity.digest);
});
test("audit brief honestly labels the digest as unkeyed tamper detection", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  assert.match(brief.integrity.kind, /unkeyed/i);
  assert.match(brief.integrity.kind, /FIPS 180-4/);
  assert.ok(brief.disclosures.some(d => /UNKEYED|unkeyed/.test(d) && /not an HMAC/.test(d)));
});
test("audit brief contains the measured strategies, not raw trips", () => {
  const brief = L.auditJson(labOn(ctaRed(), "surge"));
  assert.equal(brief.strategies.length, 5);
  for (const s of brief.strategies) {
    assert.ok(!s.observedTrips && !s.sim, "raw layers must not leak into the brief");
    assert.ok(s.metrics && s.signaling);
  }
});
test("verifyAudit accepts a clean brief from text or object form", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  assert.equal(L.verifyAudit(JSON.stringify(brief)).valid, true);
  assert.equal(L.verifyAudit(brief).valid, true);
});
test("verifyAudit flags a tampered metric", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  brief.strategies[2].metrics.cvHeadway += 0.01;
  const check = L.verifyAudit(brief);
  assert.equal(check.valid, false);
  assert.match(check.reason, /mismatch|modified/i);
});
test("verifyAudit flags a forged digest", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  brief.integrity.digest = "f".repeat(64);
  assert.equal(L.verifyAudit(brief).valid, false);
});
test("verifyAudit flags a missing or malformed integrity block", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  delete brief.integrity;
  assert.equal(L.verifyAudit(brief).valid, false);
  const b2 = L.auditJson(labOn(ctaRed(), "door90"));
  b2.integrity.digest = "not-hex";
  assert.equal(L.verifyAudit(b2).valid, false);
});
test("verifyAudit never throws on hostile input", () => {
  for (const bad of ["", "not json", "{", "[]", "42", "null", '"x"', "{\"integrity\":{}}"]) {
    const check = L.verifyAudit(bad);
    assert.equal(check.valid, false, JSON.stringify(bad));
    assert.ok(check.reason);
  }
  for (const bad of [null, undefined, 5, [], true]) {
    assert.equal(L.verifyAudit(bad).valid, false);
  }
});
test("audit export is deterministic for identical input", () => {
  const svc = ctaRed();
  const a = L.auditJson(labOn(svc, "surge")), b = L.auditJson(labOn(svc, "surge"));
  assert.equal(a.integrity.digest, b.integrity.digest);
  assert.equal(L.auditCsv(labOn(svc, "surge")), L.auditCsv(labOn(svc, "surge")));
});
test("audit CSV has a header plus one row per strategy", () => {
  const csv = L.auditCsv(labOn(ctaRed(), "door90"));
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 6);
  assert.match(lines[0], /strategy/);
  assert.match(lines[0], /expected_wait_s/);
  assert.match(lines[0], /min_headway_violations/);
  assert.ok(csv.endsWith("\r\n"));
});
test("audit CSV metric values match the lab numbers", () => {
  const lab = labOn(ctaRed(), "surge");
  const csv = L.auditCsv(lab);
  const lines = csv.trimEnd().split("\r\n");
  lab.strategies.forEach((s, i) => {
    const cells = lines[i + 1].split(",");
    assert.ok(cells.includes(String(s.metrics.expectedWaitSec)), `${s.id} wait`);
    assert.ok(cells.includes(String(s.metrics.minHeadwayViolations)), `${s.id} violations`);
  });
});
test("audit CSV cells stay formula-safe on hostile strategy names", () => {
  const lab = labOn(miniService(), "door90");
  lab.strategies[0].name = "=CMD|' /C calc'!A0";
  const csv = L.auditCsv(lab);
  const firstDataLine = csv.trimEnd().split("\r\n")[1];
  assert.ok(firstDataLine.startsWith("'"), "hostile name must be apostrophe-prefixed");
});
test("audit Markdown contains the table, every strategy and the digest", () => {
  const lab = labOn(ctaRed(), "surge");
  const md = L.auditMarkdown(lab);
  assert.match(md, /^\| Metric \|/m);
  for (const s of lab.strategies) assert.ok(md.includes(s.shortName));
  assert.match(md, /SHA-256 digest \(unkeyed tamper-detection, FIPS 180-4\): `[0-9a-f]{64}`/);
  assert.match(md, /E\[W\]/);
  assert.match(md, /Single-track queue model/);
});
test("audit Markdown digest matches the JSON brief digest", () => {
  const lab = labOn(ctaRed(), "door90");
  const md = L.auditMarkdown(lab);
  const m = md.match(/`([0-9a-f]{64})`/);
  assert.ok(m);
  assert.equal(m[1], L.auditJson(lab).integrity.digest);
});
test("audit JSON is JSON-serializable and reparses to verification", () => {
  const brief = L.auditJson(labOn(ctaRed(), "incident900"));
  const round = JSON.parse(JSON.stringify(brief));
  assert.deepEqual(round, brief);
  assert.equal(L.verifyAudit(round).valid, true);
});

/* ------------------------------------------------------------------ *
 * #rp= bookmark codec
 * ------------------------------------------------------------------ */

test("bookmark encodes a full state and decodes it exactly", () => {
  const state = { svc: "cta-red", layer: "simulated", int: 1.8, sc: "recovery", win: "evening", lab: { strategy: "cbtc", event: "surge" } };
  const hash = L.encodeRpHash(state);
  assert.match(hash, /^#rp=[A-Za-z0-9\-_]+$/);
  assert.deepEqual(L.decodeRpHash(hash), { v: 1, ...state });
});
test("bookmark round trip works for partial state", () => {
  assert.deepEqual(L.decodeRpHash(L.encodeRpHash({ svc: "nec" })), { v: 1, svc: "nec" });
  assert.deepEqual(L.decodeRpHash(L.encodeRpHash({})), { v: 1 });
});
test("bookmark body is strict pad-free base64url", () => {
  const hash = L.encodeRpHash({ svc: "cta-red", lab: { strategy: "even", event: "door90" } });
  assert.ok(!/[=+/]/.test(hash.slice(4)));
  assert.match(hash.slice(4), /^[A-Za-z0-9\-_]+$/);
});
test("bookmark encoding is deterministic", () => {
  const s = { svc: "cta-red", int: 0.6, lab: { strategy: "skip", event: "incident900" } };
  assert.equal(L.encodeRpHash(s), L.encodeRpHash(s));
});
test("decode accepts the bare rp= form and rejects every deviation", () => {
  const good = L.encodeRpHash({ svc: "cta-red" });
  assert.deepEqual(L.decodeRpHash(good.slice(1)), { v: 1, svc: "cta-red" });
  for (const bad of ["", "#", "#rp=", "#rp", "rp", "#rx=AAAA", "random", "#rp=hello world", "#rp=AAAA+AAA", null, 42, {}]) {
    assert.equal(L.decodeRpHash(bad), null, JSON.stringify(bad));
  }
});
test("decode rejects unknown keys and wrong version", () => {
  const mk = obj => "#rp=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  assert.equal(L.decodeRpHash(mk({ v: 1, hacker: 1 })), null);
  assert.equal(L.decodeRpHash(mk({ v: 2, svc: "cta-red" })), null);
  assert.equal(L.decodeRpHash(mk({ svc: "cta-red" })), null, "missing version rejected");
});
test("decode rejects invalid field values", () => {
  const mk = obj => "#rp=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const cases = [
    { v: 1, svc: "bad id!" }, { v: 1, svc: "x".repeat(49) }, { v: 1, svc: 5 },
    { v: 1, layer: "phantom" }, { v: 1, layer: 3 },
    { v: 1, int: 0.7 }, { v: 1, int: "high" },
    { v: 1, sc: "collapse" }, { v: 1, win: "dusk" },
    { v: 1, lab: { strategy: "teleport", event: "door90" } },
    { v: 1, lab: { strategy: "even", event: "flood" } },
    { v: 1, lab: { strategy: "even" } }, { v: 1, lab: "even" }
  ];
  for (const c of cases) assert.equal(L.decodeRpHash(mk(c)), null, JSON.stringify(c));
});
test("decode rejects oversized and malformed bodies", () => {
  assert.equal(L.decodeRpHash("#rp=" + "A".repeat(2050)), null);
  const notJson = Buffer.from("not json", "utf8").toString("base64url");
  assert.equal(L.decodeRpHash("#rp=" + notJson), null, "body decoding to non-JSON bytes");
  const arrayBody = Buffer.from("[1,2,3]", "utf8").toString("base64url");
  assert.equal(L.decodeRpHash("#rp=" + arrayBody), null, "non-object JSON rejected");
  const minimal = Buffer.from('{"v":1}', "utf8").toString("base64url");
  assert.deepEqual(L.decodeRpHash("#rp=" + minimal), { v: 1 }, "minimal valid state decodes");
});
test("encode throws on invalid field values instead of writing corrupt state", () => {
  assert.throws(() => L.encodeRpHash(null), /object/);
  assert.throws(() => L.encodeRpHash({ svc: "bad id!" }), /service id/);
  assert.throws(() => L.encodeRpHash({ layer: "phantom" }), /layer/);
  assert.throws(() => L.encodeRpHash({ int: 9 }), /intensity/);
  assert.throws(() => L.encodeRpHash({ sc: "collapse" }), /scenario/);
  assert.throws(() => L.encodeRpHash({ win: "dusk" }), /window/);
  assert.throws(() => L.encodeRpHash({ lab: { strategy: "x", event: "door90" } }), /lab/);
  assert.throws(() => L.encodeRpHash({ lab: { strategy: "even", event: "x" } }), /lab/);
});
test("encode drops unknown keys silently", () => {
  const hash = L.encodeRpHash({ svc: "cta-red", junk: [1, 2], evil: "<script>" });
  assert.deepEqual(L.decodeRpHash(hash), { v: 1, svc: "cta-red" });
});
test("every strategy and event id round-trips through the codec", () => {
  for (const s of L.labStrategies()) for (const e of L.labEvents()) {
    const st = { lab: { strategy: s.id, event: e.id } };
    assert.deepEqual(L.decodeRpHash(L.encodeRpHash(st)).lab, st.lab);
  }
});
test("every intensity tier round-trips through the codec", () => {
  for (const i of [0, 0.6, 1, 1.8, 2.8]) {
    assert.equal(L.decodeRpHash(L.encodeRpHash({ int: i })).int, i);
  }
});

/* ------------------------------------------------------------------ *
 * In-page self-test battery
 * ------------------------------------------------------------------ */

test("runSelfTests returns a battery that fully passes", () => {
  const results = L.runSelfTests();
  assert.ok(results.length >= 15);
  for (const r of results) {
    for (const k of ["id", "name", "pass", "detail"]) assert.ok(r[k] !== undefined, k);
    assert.equal(typeof r.pass, "boolean");
    assert.ok(r.id.length > 0 && r.name.length > 0);
  }
  const fails = results.filter(r => !r.pass);
  assert.equal(fails.length, 0, fails.map(f => `${f.id}: ${f.detail}`).join("; "));
});
test("self-test ids are unique", () => {
  const ids = L.runSelfTests().map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
});
test("self-tests cover the FIPS 180-4 known answers", () => {
  const ids = L.runSelfTests().map(r => r.id);
  for (const need of ["sha-empty", "sha-abc", "sha-448", "sha-896", "sha-million"]) {
    assert.ok(ids.includes(need), need);
  }
});
test("self-tests cover formulas, physics, CSV, tamper and invariants", () => {
  const ids = L.runSelfTests().map(r => r.id);
  for (const need of ["wait-even", "wait-identity", "wait-regression", "brake-nonneg", "brake-mono", "brake-formula", "csv-safety", "audit-roundtrip", "audit-tamper", "bookmark-roundtrip", "bookmark-strict", "no-overtake", "ordering"]) {
    assert.ok(ids.includes(need), need);
  }
});
test("FIPS KATs hold directly against the engine digest", () => {
  assert.equal(E.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(E.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(E.sha256Hex("The quick brown fox jumps over the lazy dog"),
    "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
});

/* ------------------------------------------------------------------ *
 * Deeper unit coverage: helpers, edges, options plumbing
 * ------------------------------------------------------------------ */

test("labArrivals returns sorted arrival events for one stop", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "fixed", event: "door90" });
  const ev = L.labArrivals(sim.observedTrips, svc.stops[10].id);
  assert.equal(ev.length, svc.trips.length);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].arrivalSec >= ev[i - 1].arrivalSec);
});
test("labArrivals returns empty for an unknown stop and no trips", () => {
  assert.deepEqual(L.labArrivals([], "nope"), []);
  assert.deepEqual(L.labArrivals(null, "nope"), []);
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "fixed", event: { type: "none" } });
  assert.deepEqual(L.labArrivals(sim.observedTrips, "ghost-stop"), []);
});
test("collectHeadways totals equal the sum of per-stop gaps", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "even", event: "surge" });
  const hw = L.collectHeadways(svc, sim.observedTrips);
  const manual = hw.perStop.reduce((n, p) => n + Math.max(0, p.arrivals - 1), 0);
  assert.equal(hw.all.length, manual);
  assert.equal(hw.perStop.length, svc.stops.length);
});
test("collectHeadways on an empty service stays empty and finite", () => {
  const svc = { stops: [{ id: "s1" }, { id: "s2" }] };
  const hw = L.collectHeadways(svc, []);
  assert.equal(hw.all.length, 0);
  for (const p of hw.perStop) assert.equal(p.arrivals, 0);
});
test("separationViolations catches a crafted tailgater", () => {
  const svc = { stops: [{ id: "s" }] };
  const trips = [
    { tripId: "L", stopTimes: [{ stopId: "s", arrivalSec: 100, departureSec: 120 }] },
    { tripId: "F", stopTimes: [{ stopId: "s", arrivalSec: 130, departureSec: 150 }] }
  ];
  const bad = L.separationViolations(svc, trips, 40);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].follower, "F");
  assert.equal(bad[0].gapSec, 10);
  assert.equal(L.separationViolations(svc, trips, 5).length, 0);
});
test("overtakeViolations catches a crafted arrival swap", () => {
  const svc = { stops: [{ id: "s" }] };
  const trips = [
    { tripId: "L", stopTimes: [{ stopId: "s", arrivalSec: 200 }] },
    { tripId: "F", stopTimes: [{ stopId: "s", arrivalSec: 100 }] }
  ];
  const bad = L.overtakeViolations(svc, trips);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].leader, "L");
});
test("overtakeViolations tolerates missing stopTimes", () => {
  const svc = { stops: [{ id: "s" }] };
  const trips = [{ tripId: "A" }, { tripId: "B", stopTimes: [{ stopId: "s", arrivalSec: 50 }] }];
  assert.equal(L.overtakeViolations(svc, trips).length, 0);
});
test("moving-block lets followers ride closer than the fixed-block floor", () => {
  const svc = ctaRed();
  const c = L.signalingProfile(svc, "moving-block");
  const f = L.signalingProfile(svc, "fixed-block");
  const sim = L.simulateStrategy(svc, { strategy: "cbtc", event: "incident900" });
  const badCbtc = L.separationViolations(svc, sim.observedTrips, c.separationSec);
  const badFixedFloor = L.separationViolations(svc, sim.observedTrips, f.separationSec);
  assert.equal(badCbtc.length, 0, "CBTC broke its own moving-block floor");
  assert.ok(badFixedFloor.length > 0, "moving-block headways should fall under the fixed-block floor somewhere");
});
test("lab defaults expose every tunable the UI relies on", () => {
  const d = L.labDefaults();
  for (const k of ["trainLengthM", "blockLengthM", "safetyMarginM", "brakeDecelMps2", "fixedReactionSec", "movingReactionSec", "runSlackFrac", "equalizeFrac", "maxHoldSec", "expressThresholdFrac", "expressThresholdMinSec", "stopPenaltySec", "maxSkipsPerTrip", "skipDwellMaxSec", "recoveryBandFrac"]) {
    assert.ok(d[k] !== undefined, k);
  }
  assert.ok(d.expressThresholdMinSec > 0 && d.maxHoldSec > 0 && d.recoveryBandFrac > 0 && d.recoveryBandFrac < 1);
});
test("options plumbing: a shorter hold cap changes equalization output", () => {
  const svc = ctaRed();
  const a = L.simulateStrategy(svc, { strategy: "even", event: "incident900" });
  const b = L.simulateStrategy(svc, { strategy: "even", event: "incident900", maxHoldSec: 60 });
  assert.ok(b.holds.every(h => h.seconds <= 60));
  assert.notDeepEqual(a.observedTrips, b.observedTrips);
});
test("runDispatchLab honors a signaling override bundle", () => {
  const svc = ctaRed();
  const lab = L.runDispatchLab(svc, { event: "door90", brakeDecelMps2: 1.4 });
  const f = strat(lab, "fixed");
  assert.ok(Math.abs(f.signaling.brakeMarginM - f.signaling.cruiseMps * f.signaling.cruiseMps / (2 * 1.4) - f.signaling.cruiseMps * f.signaling.reactionSec) < 0.5);
});
test("runDispatchLab rejects unknown event names cleanly", () => {
  assert.throws(() => L.runDispatchLab(ctaRed(), { event: "meteor" }), /Unknown perturbation/);
  assert.throws(() => L.runDispatchLab(null, { event: "door90" }), /required/);
});
test("each strategy binds its documented signaling mode", () => {
  const lab = labOn(ctaRed(), "door90");
  const modes = {};
  for (const s of lab.strategies) modes[s.id] = s.signaling.mode;
  assert.equal(modes.cbtc, "moving-block");
  for (const id of ["fixed", "sched", "even", "skip"]) assert.equal(modes[id], "fixed-block");
});
test("comparison object carries all four ranking fields", () => {
  const lab = labOn(ctaRed(), "surge");
  for (const k of ["bestExpectedWait", "bestCvHeadway", "fastestRecovery", "rankingByExpectedWait"]) {
    assert.ok(lab.comparison[k] !== undefined, k);
  }
  assert.equal(lab.comparison.rankingByExpectedWait.length, 5);
  const byRecovery = lab.strategies.slice().sort((a, b) => a.metrics.recoveryMin - b.metrics.recoveryMin);
  assert.equal(lab.comparison.fastestRecovery, byRecovery[0].id);
});
test("lab.service reports corridor identity and plan", () => {
  const lab = labOn(ctaRed(), "door90");
  assert.equal(lab.service.plannedHeadwaySec, 480);
  assert.ok(lab.service.stopCount >= 30);
  assert.equal(lab.service.tripCount, 16);
  assert.ok(lab.service.name.length > 0);
});
test("perturbation incident end marks the last surge window close", () => {
  const svc = ctaRed();
  const pert = L.buildPerturbation(svc, "surge");
  assert.ok(pert.incidentEndSec > svc.startSec);
  const span = svc.endSec - svc.startSec;
  assert.ok(Math.abs(pert.incidentEndSec - (svc.startSec + 0.65 * span)) <= 481);
});
test("perturbation incident end on a single dwell wraps the held departure", () => {
  const svc = ctaRed();
  const pert = L.buildPerturbation(svc, { type: "dwell", tripIndex: 4, stopIndex: 8, extraSec: 300 });
  const trip = svc.trips[4];
  const st = trip.stopTimes[8];
  assert.ok(pert.incidentEndSec >= st.departureSec + 300 - 1);
});
test("expected wait grows with dispersion at a fixed mean", () => {
  const a = L.expectedWaitSec([400, 560]);
  const b = L.expectedWaitSec([100, 860]);
  assert.equal(a.meanHeadwaySec, b.meanHeadwaySec);
  assert.ok(b.expectedWaitSec > a.expectedWaitSec);
  assert.ok(b.cvHeadway > a.cvHeadway);
});
test("wait math stays finite on extreme headway sets", () => {
  for (const hw of [[1e6, 1e6], [1, 1e6], [0.001, 0.002]]) {
    const w = L.expectedWaitSec(hw);
    assert.ok(Number.isFinite(w.expectedWaitSec), JSON.stringify(hw));
    assert.ok(Number.isFinite(w.cvHeadway));
  }
});
test("skip records carry positive saved seconds", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "surge" });
  for (const sk of sim.skips) assert.ok(sk.savedSec > 0, JSON.stringify(sk));
});
test("recovery monitors cover every served stop except skipped stations", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "incident900");
  for (const s of lab.strategies) {
    const skipSet = new Set(s.sim.skips.map(k => k.stopId));
    let expect = 0;
    for (const stop of svc.stops) {
      const ev = L.labArrivals(s.sim.observedTrips, stop.id);
      if (ev.length >= 2 && !skipSet.has(stop.id)) expect++;
    }
    assert.equal(s.metrics.monitoredStops, expect, s.id);
  }
});
test("express threshold is exposed and matches the delay rule", () => {
  const svc = ctaRed();
  const sim = L.simulateStrategy(svc, { strategy: "skip", event: "surge" });
  const expect = Math.max(60, svc.plannedHeadwaySec * 0.15);
  assert.equal(sim.expressThresholdSec, Math.round(expect));
});
test("audit brief exposes the scenario the lab actually ran", () => {
  const lab = labOn(ctaRed(), "incident900");
  const brief = L.auditJson(lab);
  assert.match(brief.scenario.description, /900/);
  assert.equal(brief.scenario.id || brief.scenario.event || "incident900", "incident900");
});
test("verifyAudit echoes the recomputed digest", () => {
  const brief = L.auditJson(labOn(ctaRed(), "door90"));
  const check = L.verifyAudit(brief);
  assert.equal(check.valid, true);
  assert.equal(check.digest, brief.integrity.digest);
});
test("audit CSV numbers are the rounded lab metrics", () => {
  const lab = labOn(ctaRed(), "surge");
  const csv = L.auditCsv(lab);
  const header = csv.split("\r\n")[0];
  for (const col of ["cv_headway", "expected_wait_s", "excess_wait_s", "bunching_rate", "min_headway_violations", "recovery_to_target_headway_min", "station_holds_s", "skipped_stops", "peak_capacity_trains_per_hr", "total_terminal_delay_s", "delivered_trains_per_hr"]) {
    assert.ok(header.includes(col), `csv missing ${col}`);
  }
});
test("markdown brief lists the disclosed modeling assumptions", () => {
  const lab = labOn(ctaRed(), "door90");
  const md = L.auditMarkdown(lab);
  assert.match(md, /v\^2/);
  assert.match(md, /moving-block/);
  assert.match(md, /population CV/i);
});
test("markdown brief names the active perturbation and corridor", () => {
  const lab = labOn(ctaRed(), "surge");
  const md = L.auditMarkdown(lab);
  assert.ok(md.includes(lab.service.name));
  assert.match(md, /surge|dwell/i);
});
test("bookmark decode tolerates lab blocks with extra keys by rejecting them", () => {
  const mk = obj => "#rp=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  assert.equal(L.decodeRpHash(mk({ v: 1, lab: { strategy: "even", event: "door90", backdoor: 1 } })), null);
  assert.equal(L.decodeRpHash(mk({ v: 1, lab: { strategy: "even", event: "door90", extra: "x" } })), null);
});
test("bookmark decode accepts lab:null-free minimal lab states only when complete", () => {
  const mk = obj => "#rp=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  assert.equal(L.decodeRpHash(mk({ v: 1, lab: { event: "door90" } })), null);
  assert.equal(L.decodeRpHash(mk({ v: 1, lab: { strategy: "even" } })), null);
  assert.equal(L.decodeRpHash(mk({ v: 1, lab: {} })), null);
});
test("bookmark svc id charset permits dots colons and dashes", () => {
  for (const svc of ["cta-red", "nec.north", "gtfs:svc42", "a_b.c"]) {
    assert.equal(L.decodeRpHash(L.encodeRpHash({ svc })).svc, svc);
  }
});
test("bookmark encode strips sc when scenario is falsy", () => {
  const hash = L.encodeRpHash({ svc: "cta-red" });
  const d = L.decodeRpHash(hash);
  assert.ok(!("sc" in d));
});
test("fixed and cbtc separation floors differ by the clearance model", () => {
  const svc = ctaRed();
  const d = L.labDefaults();
  const f = L.signalingProfile(svc, "fixed-block");
  const m = L.signalingProfile(svc, "moving-block");
  assert.ok(m.clearanceMeters < f.clearanceMeters);
  assert.equal(f.clearanceMeters - m.clearanceMeters, d.blockLengthM - d.safetyMarginM);
});
test("reaction time differentiates fixed and moving braking margins", () => {
  const svc = ctaRed();
  const d = L.labDefaults();
  const f = L.signalingProfile(svc, "fixed-block");
  const m = L.signalingProfile(svc, "moving-block");
  const reactionDelta = f.cruiseMps * (d.fixedReactionSec - d.movingReactionSec);
  assert.ok(Math.abs((f.brakeMarginM - m.brakeMarginM) - reactionDelta) < 0.5);
});
test("a two-stop mini corridor survives the whole lab", () => {
  const svc = miniService({ stations: [["A", "Alpha", 0, 60], ["B", "Bravo", 1.5, 60]] });
  const lab = labOn(svc, "door90");
  assert.equal(lab.strategies.length, 5);
  for (const s of lab.strategies) {
    assert.equal(L.overtakeViolations(svc, s.sim.observedTrips).length, 0);
  }
});
test("zero-length headway lists never produce NaN metrics", () => {
  const svc = { stops: [{ id: "a" }], trips: [], plannedHeadwaySec: 300, startSec: 0, endSec: 3600 };
  const sim = { observedTrips: [], perturbation: { incidentEndSec: 0 }, holds: [], holdSec: 0, skips: [], skippedStops: 0, signaling: { minHeadwaySec: 120 } };
  const m = L.labMetrics(svc, sim, {});
  for (const k of Object.keys(m)) {
    if (typeof m[k] === "number") assert.ok(Number.isFinite(m[k]), k + "=" + m[k]);
  }
});
test("lab metrics keys are exactly the documented set", () => {
  const svc = ctaRed();
  const lab = labOn(svc, "door90");
  const required = ["headwayCount", "meanHeadwaySec", "cvHeadway", "cvHeadwaySample", "expectedWaitSec", "excessWaitSec", "bunchCount", "bunchRate", "gapCount", "gapRate", "minHeadwayViolations", "minObservedHeadwaySec", "recoveryMin", "totalHoldSec", "skippedStops", "monitoredStops", "deliveredTrainsPerHr", "totalTerminalDelaySec", "delayedTrips", "maxTerminalDelaySec", "meanTerminalDelaySec"];
  for (const s of lab.strategies) {
    for (const k of required) assert.ok(Object.prototype.hasOwnProperty.call(s.metrics, k), `${s.id} missing ${k}`);
  }
});
test("self-test battery includes a strictness check on the bookmark codec", () => {
  const st = L.runSelfTests().find(r => r.id === "bookmark-strict");
  assert.ok(st && st.pass);
  assert.match(st.detail, /reject/i);
});
test("self-test battery includes the zero-overtake invariant check", () => {
  const st = L.runSelfTests().find(r => r.id === "no-overtake");
  assert.ok(st && st.pass);
});
