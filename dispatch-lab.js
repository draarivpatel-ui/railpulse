/* RailPulse dispatch laboratory.
 *
 * A dependency free headway-control and signaling-capacity comparator. The
 * same file runs as a plain browser script (attaches to window.RailPulse) and
 * as a CommonJS module (module.exports). No build step, no network calls, no
 * external packages.
 *
 * Five deterministic operating strategies are replayed over one service and
 * one perturbation, on a shared single-track queue model with NO overtaking:
 *
 *   fixed   Uncontrolled fixed-block baseline - trains bank schedule slack
 *           AND may depart early, so a compressed platoon stays compressed.
 *   sched   Schedule-based holding - no station departure earlier than the
 *           booked departure; early running is absorbed as platform dwell.
 *   even    Dynamic headway-equalization holding - each train is held until
 *           its arrival gap to its leader reaches the planned headway (with a
 *           per-station hold cap).
 *   skip    Express skip-stop recovery - a train that accumulates more delay
 *           than the express threshold skips alternating local stations,
 *           saving dwell plus a fixed stop penalty each time.
 *   cbtc    CBTC moving-block + dynamic holding - the equalization rule on a
 *           moving-block separation floor instead of a fixed-block one.
 *
 * Every number the lab reports is recomputed from the produced stop times;
 * nothing is asserted about the strategies that the simulation did not
 * produce. This is an illustrative dispatch teaching model: one direction,
 * one track, no demand model, no platform allocation, no crew rostering.
 */
(function (root) {
  "use strict";
  var ns = root.RailPulse || (root.RailPulse = {});
  var E = ns; // engine.js loads first and attaches its API to this namespace

  var LAB_SCHEMA = "railpulse-lab/1";
  var METERS_PER_MILE = 1609.344;
  var MPH_TO_MPS = 0.44704;

  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function round(x, dp) { var f = Math.pow(10, dp || 0); return Math.round(x * f) / f; }

  /* ------------------------------------------------------------------ *
   * Physics
   * ------------------------------------------------------------------ */

  /* Safe braking-distance margin, the standard brick-wall allowance:
   * d = v^2 / (2 * a_b) + v * t_r, meters. */
  function brakingDistanceMeters(speedMps, decelMps2, reactionSec) {
    if (!isNum(speedMps) || !isNum(decelMps2) || !isNum(reactionSec)) throw new Error("Braking inputs must be finite numbers");
    if (speedMps < 0 || decelMps2 <= 0 || reactionSec < 0) throw new Error("Braking inputs out of range");
    return speedMps * speedMps / (2 * decelMps2) + speedMps * reactionSec;
  }

  /* The same margin expressed as a time headway at cruise speed:
   * h = v / (2 * a_b) + t_r, seconds. */
  function brakingHeadwaySec(speedMps, decelMps2, reactionSec) {
    return brakingDistanceMeters(speedMps, decelMps2, reactionSec) / speedMps;
  }

  /* Median effective interstation cruise speed of a service (m/s), computed
   * from scheduled leg distances over scheduled running times. This is an
   * effective station-to-station speed including acceleration, not a top
   * speed. */
  function cruiseSpeedMps(service) {
    var legs = [];
    var seen = Object.create(null);
    (service.trips || []).forEach(function (trip) {
      (trip.stopTimes || []).forEach(function (st, i) {
        if (!i) return;
        var prev = trip.stopTimes[i - 1];
        var key = prev.stopId + ">" + st.stopId;
        if (seen[key]) return;
        seen[key] = true;
        var dm = (st.miles - prev.miles) * METERS_PER_MILE;
        var dt = st.arrivalSec - prev.departureSec;
        if (dm > 0 && dt > 0) legs.push(dm / dt);
      });
    });
    if (!legs.length) return 15;
    legs.sort(function (a, b) { return a - b; });
    return legs[Math.floor(legs.length / 2)];
  }

  /* ------------------------------------------------------------------ *
   * Lab defaults. Every constant is disclosed in the report assumptions.
   * ------------------------------------------------------------------ */

  var LAB_DEFAULTS = {
    brakeDecelMps2: 1.0,        // comfortable service braking rate
    blockLengthM: 180,          // fixed-block section length beyond the platform
    trainLengthM: 150,          // 8-car heavy-metro consist
    safetyMarginM: 30,          // moving-block separation bubble beyond the tail
    fixedReactionSec: 4.0,      // lineside signal sighting + driver reaction
    movingReactionSec: 0.8,     // cab-signaled ATO supervision latency
    runSlackFrac: 0.06,         // timetable run-time padding trains may bank
    equalizeFrac: 1.0,          // equalization target, fraction of planned headway
    maxHoldSec: 300,            // per-station hold cap for spacing controls
    expressThresholdFrac: 0.15, // express trigger: delay > frac * planned headway
    expressThresholdMinSec: 60, // ...and never below this absolute floor
    stopPenaltySec: 40,         // deceleration + approach saved per skipped stop
    maxSkipsPerTrip: 4,         // express skip budget per trip
    skipDwellMaxSec: 35,        // stations with dwell <= this count as local
    recoveryBandFrac: 0.25      // headways within +-25% of planned = recovered
  };

  function labDefaults() {
    var out = {};
    for (var k in LAB_DEFAULTS) if (Object.prototype.hasOwnProperty.call(LAB_DEFAULTS, k)) out[k] = LAB_DEFAULTS[k];
    return out;
  }

  function resolveOpts(opts) {
    var o = labDefaults();
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k) && opts[k] !== undefined) o[k] = opts[k];
    return o;
  }

  /* ------------------------------------------------------------------ *
   * Strategy and perturbation catalogs
   * ------------------------------------------------------------------ */

  var STRATEGIES = [
    {
      id: "fixed",
      name: "Uncontrolled fixed-block baseline",
      shortName: "Fixed-block",
      signaling: "fixed-block",
      blurb: "Trains run as soon as the block ahead clears and bank timetable slack. No spacing control; a compressed platoon stays compressed."
    },
    {
      id: "sched",
      name: "Schedule-based holding",
      shortName: "Schedule hold",
      signaling: "fixed-block",
      blurb: "No train may leave a station ahead of its booked departure. Early running is absorbed as platform dwell, pinning recovery to the timetable."
    },
    {
      id: "even",
      name: "Dynamic headway-equalization holding",
      shortName: "Headway equalize",
      signaling: "fixed-block",
      blurb: "Each train is held until its arrival gap to the leader reaches the planned headway, restoring even spacing at the cost of added dwell."
    },
    {
      id: "skip",
      name: "Express skip-stop recovery",
      shortName: "Skip-stop",
      signaling: "fixed-block",
      blurb: "A train that runs more than the express threshold late skips alternating local stations, saving dwell plus the stop penalty each time."
    },
    {
      id: "cbtc",
      name: "CBTC moving-block + dynamic holding",
      shortName: "CBTC moving-block",
      signaling: "moving-block",
      blurb: "The equalization rule on a moving-block separation floor: shorter safe follow distance and faster platform clearance."
    }
  ];

  function labStrategies() {
    return STRATEGIES.map(function (s) {
      return { id: s.id, name: s.name, shortName: s.shortName, signaling: s.signaling, blurb: s.blurb };
    });
  }

  var EVENT_PRESETS = [
    { id: "door90", name: "90-second door hold", type: "dwell",
      tripFrac: 0.4, mileFrac: 0.45, extraSec: 90,
      blurb: "One train is held an extra 90 s at a mid-route station - a stuck door, a wheelchair boarding, a police check." },
    { id: "surge", name: "Passenger surge", type: "surge",
      windowFrac: [0.30, 0.65], milesFrac: [0.20, 0.70], extraSec: 70,
      blurb: "Crowded platforms lengthen every scheduled dwell inside the core of the route during the middle of the service span." },
    { id: "incident900", name: "15-minute platform incident", type: "dwell",
      tripFrac: 0.4, mileFrac: 0.45, extraSec: 900,
      blurb: "One train dwells an extra 900 s - the showcase platform incident replayed through every strategy." }
  ];

  function labEvents() {
    return EVENT_PRESETS.map(function (e) {
      var out = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) out[k] = e[k];
      return out;
    });
  }

  /* ------------------------------------------------------------------ *
   * Signaling profile
   * ------------------------------------------------------------------ */

  /* The dep->arr separation floor at a station. A follower may arrive no
   * sooner than this many seconds after its leader's departure:
   *   fixed-block  : brake margin + (block length + train length) / v
   *   moving-block : brake margin + (train length + safety bubble) / v
   * The design minimum station headway adds the longest scheduled dwell:
   * a following train cannot be berthed before the leader's dwell ends and
   * the separation is respected. Peak line throughput = 3600 / H_min. */
  function signalingProfile(service, mode, opts) {
    opts = resolveOpts(opts);
    if (mode !== "fixed-block" && mode !== "moving-block") throw new Error("Unknown signaling mode " + mode);
    var v = isNum(opts.cruiseMps) && opts.cruiseMps > 0 ? opts.cruiseMps : cruiseSpeedMps(service);
    var reaction = mode === "moving-block" ? opts.movingReactionSec : opts.fixedReactionSec;
    var brakeM = brakingDistanceMeters(v, opts.brakeDecelMps2, reaction);
    var brakeSec = brakingHeadwaySec(v, opts.brakeDecelMps2, reaction);
    var clearMeters = mode === "moving-block" ? opts.trainLengthM + opts.safetyMarginM : opts.blockLengthM + opts.trainLengthM;
    var clearSec = clearMeters / v;
    var separationSec = Math.ceil(brakeSec + clearSec);
    var maxDwell = 0;
    (service.stops || []).forEach(function (s) { if (isNum(s.dwellSec) && s.dwellSec > maxDwell) maxDwell = s.dwellSec; });
    var minHeadwaySec = Math.ceil(separationSec + maxDwell);
    return {
      mode: mode,
      cruiseMps: round(v, 2),
      brakeDecelMps2: opts.brakeDecelMps2,
      reactionSec: reaction,
      brakeMarginM: round(brakeM, 1),
      brakeMarginSec: round(brakeSec, 1),
      clearanceMeters: clearMeters,
      clearanceSec: round(clearSec, 1),
      separationSec: separationSec,
      maxDwellSec: maxDwell,
      minHeadwaySec: minHeadwaySec,
      peakThroughputTrainsPerHr: round(3600 / minHeadwaySec, 1)
    };
  }

  /* ------------------------------------------------------------------ *
   * Perturbation construction
   * ------------------------------------------------------------------ */

  function stopIndexAtMileFrac(service, frac) {
    var stops = service.stops;
    var maxMiles = Math.max.apply(null, stops.map(function (s) { return s.miles; }).concat([1]));
    var best = 0, bestD = Infinity;
    stops.forEach(function (s, i) {
      var d = Math.abs(s.miles - frac * maxMiles);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /* Expand an event spec into a per-(trip,stop) extra-dwell map plus the
   * metadata the metrics need. Deterministic: same inputs, same event. */
  function buildPerturbation(service, event, opts) {
    opts = resolveOpts(opts);
    var spec = {};
    if (typeof event === "string") {
      var preset = null;
      EVENT_PRESETS.forEach(function (p) { if (p.id === event) preset = p; });
      if (!preset) throw new Error("Unknown perturbation " + event);
      spec = preset;
    } else if (event && typeof event === "object") {
      spec = event;
    }
    var n = service.trips.length;
    var map = Object.create(null);
    var affected = 0;
    var incidentEndSec = service.startSec || 0;
    var description = "No perturbation";

    if (spec.type === "dwell") {
      var tripIndex = spec.tripIndex != null ? spec.tripIndex
        : spec.tripFrac != null ? Math.round(clamp(spec.tripFrac, 0, 1) * (n - 1)) : Math.min(4, n - 1);
      var stopIndex = spec.stopIndex != null ? spec.stopIndex
        : spec.mileFrac != null ? stopIndexAtMileFrac(service, spec.mileFrac) : Math.min(1, service.stops.length - 1);
      if (!Number.isInteger(tripIndex) || tripIndex < 0 || tripIndex >= n) throw new Error("Invalid perturbation trip index");
      if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= service.stops.length) throw new Error("Invalid perturbation station index");
      var extra = spec.extraSec != null ? spec.extraSec : 90;
      if (!isNum(extra) || extra < 0 || extra > 86400) throw new Error("Invalid perturbation dwell seconds");
      var trip = service.trips[tripIndex];
      var st = trip.stopTimes[stopIndex];
      map[trip.tripId + "|" + st.stopId] = extra;
      affected = 1;
      incidentEndSec = st.departureSec + extra;
      description = "+" + extra + " s dwell on " + trip.tripId + " at " + (service.stopIndex[st.stopId] || {}).name;
    } else if (spec.type === "surge") {
      var wf = Array.isArray(spec.windowFrac) ? spec.windowFrac : [0.3, 0.65];
      var mf = Array.isArray(spec.milesFrac) ? spec.milesFrac : [0.2, 0.7];
      var extraS = spec.extraSec != null ? spec.extraSec : 70;
      if (!isNum(extraS) || extraS < 0 || extraS > 3600) throw new Error("Invalid surge dwell seconds");
      var span = (service.endSec != null ? service.endSec : 24 * 3600) - (service.startSec || 0);
      var t0 = (service.startSec || 0) + clamp(wf[0], 0, 1) * span;
      var t1 = (service.startSec || 0) + clamp(wf[1], 0, 1) * span;
      var maxMiles = Math.max.apply(null, service.stops.map(function (s) { return s.miles; }).concat([1]));
      var m0 = clamp(mf[0], 0, 1) * maxMiles, m1 = clamp(mf[1], 0, 1) * maxMiles;
      service.trips.forEach(function (trip) {
        trip.stopTimes.forEach(function (st, i) {
          if (!i || i === trip.stopTimes.length - 1) return; // surge hits interior platforms
          var stop = service.stopIndex[st.stopId] || {};
          if (st.arrivalSec >= t0 && st.arrivalSec <= t1 && isNum(stop.miles) && stop.miles >= m0 && stop.miles <= m1) {
            map[trip.tripId + "|" + st.stopId] = extraS;
            affected++;
          }
        });
      });
      incidentEndSec = t1;
      description = "+" + extraS + " s dwell at interior stations " + E.formatGtfsTime(Math.round(t0)) + " to " + E.formatGtfsTime(Math.round(t1));
    } else if (spec.type && spec.type !== "none") {
      throw new Error("Unknown perturbation type " + spec.type);
    }
    return { map: map, affected: affected, incidentEndSec: incidentEndSec, description: description, spec: spec };
  }

  /* ------------------------------------------------------------------ *
   * Shared single-track strategy simulator
   * ------------------------------------------------------------------ */

  /* Replays the service under one strategy and one perturbation. Trains are
   * processed in dispatch order; a follower's arrival at each station is
   * floored at leader.departure + separationSec (the signaling floor), so the
   * model can never produce an overtake or a platform collision. Runs are
   * fully deterministic - no randomness anywhere. */
  function simulateStrategy(service, options) {
    options = options || {};
    if (!service || !Array.isArray(service.trips) || !Array.isArray(service.stops)) throw new Error("A service with trips and stops is required");
    var strategyId = options.strategy || "fixed";
    var meta = null;
    STRATEGIES.forEach(function (s) { if (s.id === strategyId) meta = s; });
    if (!meta) throw new Error("Unknown strategy " + strategyId);
    var opts = resolveOpts(options);
    var prof = signalingProfile(service, meta.signaling, opts);
    var sep = prof.separationSec;
    var pert = buildPerturbation(service, options.event || { type: "none" }, opts);
    var planned = service.plannedHeadwaySec || 0;
    var expressThreshold = Math.max(opts.expressThresholdMinSec, planned * opts.expressThresholdFrac);
    var target = planned * opts.equalizeFrac;
    var lastStop = service.stops.length - 1;

    var observed = [], holds = [], skips = [];
    var holdSec = 0;
    service.trips.forEach(function (trip, t) {
      if (!trip || !Array.isArray(trip.stopTimes)) { observed.push(trip); return; }
      var leader = t ? observed[t - 1] : null;
      var times = [];
      var skipCredit = 0, skipsDone = 0;
      trip.stopTimes.forEach(function (st, i) {
        var leaderSt = leader && leader.stopTimes ? leader.stopTimes[i] : null;
        var natural;
        if (!i) {
          natural = st.arrivalSec;
        } else {
          var prevSt = trip.stopTimes[i - 1];
          var runSched = st.arrivalSec - prevSt.departureSec;
          var runActual = runSched * (1 - opts.runSlackFrac) - skipCredit;
          skipCredit = 0;
          if (runActual < runSched * 0.5) runActual = runSched * 0.5; // sanity floor
          natural = times[i - 1].departureSec + runActual;
        }
        var arr = natural;
        if (leaderSt) arr = Math.max(arr, leaderSt.departureSec + sep);
        var key = trip.tripId + "|" + st.stopId;
        var extra = pert.map[key] || 0;
        var baseDwell = Math.max(0, st.departureSec - st.arrivalSec);
        var delayHere = arr - st.arrivalSec;
        var skippable = i > 0 && i < lastStop && baseDwell <= opts.skipDwellMaxSec && i % 2 === 1;
        var doSkip = strategyId === "skip" && skippable &&
          delayHere > expressThreshold && skipsDone < opts.maxSkipsPerTrip;

        var dwell = baseDwell + extra;
        var dep;
        if (doSkip) {
          dep = arr; // pass-through: no dwell, no hold
        } else {
          dep = arr + dwell;
          if (strategyId === "even" || strategyId === "cbtc") {
            if (leaderSt) {
              var gap = arr - leaderSt.arrivalSec;
              dep += clamp(target - gap, 0, opts.maxHoldSec);
            }
            dep = Math.max(dep, st.departureSec); // controlled trains never depart early
          } else if (strategyId === "sched" || strategyId === "skip") {
            dep = Math.max(dep, st.departureSec);
          }
          // "fixed" is unregulated: early departures are permitted, so trains
          // bank timetable slack and run hot - why platoons stay bunched.
        }
        var hold = doSkip ? 0 : Math.round(Math.max(0, dep - (arr + dwell)));
        var rec = {
          stopId: st.stopId, seq: st.seq,
          arrivalSec: Math.round(arr),
          departureSec: Math.round(dep),
          miles: st.miles, headsign: st.headsign
        };
        if (doSkip) {
          rec.skipped = true;
          skipsDone++;
          skipCredit = opts.stopPenaltySec;
          skips.push({ tripId: trip.tripId, stopId: st.stopId, savedSec: Math.round(baseDwell + opts.stopPenaltySec) });
        }
        if (hold > 0) {
          holdSec += hold;
          holds.push({ tripId: trip.tripId, stopId: st.stopId, seconds: hold });
        }
        times.push(rec);
      });
      observed.push(Object.assign({}, trip, { stopTimes: times, startTime: times.length ? times[0].departureSec : trip.startTime }));
    });

    return {
      strategy: meta,
      signaling: prof,
      perturbation: { description: pert.description, affected: pert.affected, incidentEndSec: pert.incidentEndSec, spec: pert.spec },
      observedTrips: observed,
      holds: holds,
      holdSec: Math.round(holdSec),
      skips: skips,
      skippedStops: skips.length,
      separationSec: sep,
      expressThresholdSec: round(expressThreshold, 0)
    };
  }

  /* ------------------------------------------------------------------ *
   * Headway collection and metrics
   * ------------------------------------------------------------------ */

  /* Arrival events at one stop from a simulated trip layer. Skipped stop
   * times (express trains running through) do not count as arrivals. */
  function labArrivals(trips, stopId) {
    var events = [];
    (trips || []).forEach(function (t) {
      (t.stopTimes || []).forEach(function (st) {
        if (st.stopId === stopId && !st.skipped) {
          events.push({ tripId: t.tripId, arrivalSec: st.arrivalSec, departureSec: st.departureSec });
        }
      });
    });
    events.sort(function (a, b) { return a.arrivalSec - b.arrivalSec; });
    return events;
  }

  /* Measured arrival headways per stop and in aggregate. Returns the list
   * plus per-stop stats so violation floors can be checked per station. */
  function collectHeadways(service, trips) {
    var perStop = [], all = [];
    service.stops.forEach(function (stop) {
      var ev = labArrivals(trips, stop.id), gaps = [];
      for (var j = 1; j < ev.length; j++) {
        var g = ev[j].arrivalSec - ev[j - 1].arrivalSec;
        if (g >= 0) { gaps.push(g); all.push(g); }
      }
      perStop.push({ stopId: stop.id, stopName: stop.name, miles: stop.miles, arrivals: ev.length, headways: gaps });
    });
    return { perStop: perStop, all: all };
  }

  /* Mean passenger wait under the finite headway distribution, in the exact
   * form E[W] = (H/2) * (1 + CV_H^2) with CV_H the population coefficient of
   * variation of measured headways. Algebraically identical to
   * H/2 + Var(H)/(2*H); reported both as expectedWaitSec and as
   * excessWaitSec = E[W] - H/2 (the penalty above even spacing). */
  function expectedWaitSec(headways) {
    var clean = (headways || []).filter(function (h) { return isNum(h) && h > 0; });
    if (!clean.length) return { expectedWaitSec: 0, excessWaitSec: 0, meanHeadwaySec: 0, cvHeadway: 0, cvHeadwaySample: 0 };
    var m = E.mean(clean);
    var popVar = E.populationVariance(clean);
    var cvPop = m > 0 ? Math.sqrt(popVar) / m : 0;
    var ew = m / 2 * (1 + cvPop * cvPop);
    return {
      expectedWaitSec: ew,
      excessWaitSec: ew - m / 2,
      meanHeadwaySec: m,
      cvHeadway: cvPop,
      cvHeadwaySample: E.describeSample(clean).cv
    };
  }

  /* Full metric bundle for one strategy result. */
  function labMetrics(service, sim, options) {
    options = options || {};
    var opts = resolveOpts(options);
    var trips = sim.observedTrips;
    var hw = collectHeadways(service, trips);
    var wait = expectedWaitSec(hw.all);
    var planned = service.plannedHeadwaySec || 0;
    var bunchSec = options.bunchingSec != null ? options.bunchingSec : planned * 0.5;
    var gapSec = options.gapSec != null ? options.gapSec : planned * 1.5;
    var prof = sim.signaling;
    var minHw = prof.minHeadwaySec;
    var bunch = 0, gaps = 0, violations = 0, minObs = Infinity, maxObs = 0;
    hw.all.forEach(function (g) {
      if (g <= bunchSec) bunch++;
      if (g >= gapSec) gaps++;
      if (g < minHw) violations++;
      if (g < minObs) minObs = g;
      if (g > maxObs) maxObs = g;
    });

    /* Recovery: last out-of-band headway after the perturbation ends, taken
     * across stops every train still calls at. */
    var lo = planned * (1 - opts.recoveryBandFrac), hi = planned * (1 + opts.recoveryBandFrac);
    var last = -Infinity, monitored = 0;
    hw.perStop.forEach(function (ps) {
      if (ps.arrivals < 2) return;
      var skippedHere = trips.some(function (t) {
        return t.stopTimes.some(function (st) { return st.stopId === ps.stopId && st.skipped; });
      });
      if (skippedHere) return;
      monitored++;
      var ev = labArrivals(trips, ps.stopId);
      for (var j = 1; j < ev.length; j++) {
        var g = ev[j].arrivalSec - ev[j - 1].arrivalSec;
        if (ev[j].arrivalSec > sim.perturbation.incidentEndSec && (g < lo || g > hi)) {
          if (ev[j].arrivalSec > last) last = ev[j].arrivalSec;
        }
      }
    });
    var recoverySec = last === -Infinity ? 0 : Math.max(0, last - sim.perturbation.incidentEndSec);

    var terminalDelays = trips.map(function (t, i) {
      var schedTimes = service.trips[i] && Array.isArray(service.trips[i].stopTimes) ? service.trips[i].stopTimes : [];
      var schedLast = schedTimes[schedTimes.length - 1];
      var obsLast = t.stopTimes[t.stopTimes.length - 1];
      return obsLast && schedLast ? obsLast.arrivalSec - schedLast.arrivalSec : 0;
    });
    var span = Math.max(1, (service.endSec != null ? service.endSec : 0) - (service.startSec || 0));

    return {
      headwayCount: hw.all.length,
      meanHeadwaySec: round(wait.meanHeadwaySec, 1),
      cvHeadway: round(wait.cvHeadway, 4),
      cvHeadwaySample: round(wait.cvHeadwaySample, 4),
      expectedWaitSec: round(wait.expectedWaitSec, 1),
      excessWaitSec: round(wait.excessWaitSec, 1),
      bunchCount: bunch,
      bunchRate: hw.all.length ? round(bunch / hw.all.length, 4) : 0,
      gapCount: gaps,
      gapRate: hw.all.length ? round(gaps / hw.all.length, 4) : 0,
      minHeadwayViolations: violations,
      minHeadwaySec: minHw,
      minObservedHeadwaySec: minObs === Infinity ? 0 : round(minObs, 0),
      maxObservedHeadwaySec: round(maxObs, 0),
      recoveryMin: round(recoverySec / 60, 1),
      monitoredStops: monitored,
      totalHoldSec: sim.holdSec,
      holdCount: sim.holds.length,
      skippedStops: sim.skippedStops,
      delayedTrips: terminalDelays.filter(function (d) { return d > 0; }).length,
      totalTerminalDelaySec: Math.round(E.sum(terminalDelays)),
      meanTerminalDelaySec: round(E.mean(terminalDelays), 1),
      maxTerminalDelaySec: Math.round(Math.max.apply(null, terminalDelays.concat([0]))),
      deliveredTrainsPerHr: round(service.trips.length / (span / 3600), 1)
    };
  }

  /* ------------------------------------------------------------------ *
   * Whole-lab comparison
   * ------------------------------------------------------------------ */

  function runDispatchLab(service, options) {
    options = options || {};
    var event = options.event != null ? options.event : "door90";
    var strategies = STRATEGIES.map(function (s) {
      var sim = simulateStrategy(service, Object.assign({}, options, { strategy: s.id, event: event }));
      return {
        id: s.id, name: s.name, shortName: s.shortName, blurb: s.blurb,
        signaling: sim.signaling,
        metrics: labMetrics(service, sim, options),
        sim: sim
      };
    });
    var byWait = strategies.slice().sort(function (a, b) { return a.metrics.expectedWaitSec - b.metrics.expectedWaitSec; });
    var byCv = strategies.slice().sort(function (a, b) { return a.metrics.cvHeadway - b.metrics.cvHeadway; });
    var byRecovery = strategies.slice().sort(function (a, b) { return a.metrics.recoveryMin - b.metrics.recoveryMin; });
    var first = strategies[0];
    return {
      schema: LAB_SCHEMA,
      service: {
        id: service.id, name: service.name, operator: service.operator,
        plannedHeadwaySec: service.plannedHeadwaySec,
        stopCount: service.stops.length, tripCount: service.trips.length,
        source: service.source || "synthetic"
      },
      scenario: {
        event: typeof event === "string" ? event : (event && event.id) || "custom",
        description: first.sim.perturbation.description,
        affected: first.sim.perturbation.affected,
        incidentEndSec: first.sim.perturbation.incidentEndSec
      },
      strategies: strategies,
      comparison: {
        bestExpectedWait: byWait[0].id,
        bestCvHeadway: byCv[0].id,
        fastestRecovery: byRecovery[0].id,
        rankingByExpectedWait: byWait.map(function (s) { return s.id; })
      },
      assumptions: labAssumptions(resolveOpts(options))
    };
  }

  function labAssumptions(o) {
    return [
      "Single-track queue model in one direction: a follower may arrive no sooner than leader.departure + separationSec at every station. No overtaking and no platform collisions can occur.",
      "Braking margin d = v^2/(2*a_b) + v*t_r with a_b = " + o.brakeDecelMps2 + " m/s^2, t_r = " + o.fixedReactionSec + " s (fixed-block) or " + o.movingReactionSec + " s (moving-block).",
      "Separation floor adds clearing distance: fixed-block clears block " + o.blockLengthM + " m + train " + o.trainLengthM + " m; moving-block clears train " + o.trainLengthM + " m + bubble " + o.safetyMarginM + " m.",
      "Design minimum station headway = separation + longest scheduled dwell; peak throughput = 3600 / H_min at the bottleneck platform.",
      "Expected wait E[W] = (H/2)(1 + CV_H^2) uses the population CV of measured headways; it is E[W] above even spacing that the excess figure reports.",
      "All trains may physically bank " + Math.round(o.runSlackFrac * 100) + "% of scheduled run time. Only the unregulated baseline may also depart early; controlled strategies pin departures to the booked time (early arrival extends platform dwell).",
      "Equalization holds are capped at " + o.maxHoldSec + " s per station. Skip-stop saves dwell + " + o.stopPenaltySec + " s stop penalty per skip and never reorders trains.",
      "Deterministic replay: identical inputs always produce identical stop times. This is a teaching model, not agency-certified ops research."
    ];
  }

  /* ------------------------------------------------------------------ *
   * Separation / overtake invariants (used by tests and the self-test panel)
   * ------------------------------------------------------------------ */

  /* Every follower arrival at every station must respect the signaling
   * floor: arrival >= leader.departure + separationSec - epsilon. Returns
   * the list of violations; an empty list proves the invariant. */
  function separationViolations(service, trips, separationSec) {
    var eps = 0.51; // stop times are integer-rounded
    var bad = [];
    service.stops.forEach(function (stop, i) {
      for (var t = 1; t < trips.length; t++) {
        var lt = (trips[t - 1].stopTimes || [])[i], ft = (trips[t].stopTimes || [])[i];
        if (!lt || !ft || lt.stopId !== stop.id || ft.stopId !== stop.id) continue;
        if (ft.arrivalSec < lt.departureSec + separationSec - eps) {
          bad.push({ stopId: stop.id, leader: trips[t - 1].tripId, follower: trips[t].tripId, gapSec: ft.arrivalSec - lt.departureSec });
        }
      }
    });
    return bad;
  }

  /* Dispatch order must equal arrival order at every station: if trip t
   * arrives after trip t-1 at any station, the model produced an overtake. */
  function overtakeViolations(service, trips) {
    var bad = [];
    service.stops.forEach(function (stop, i) {
      for (var t = 1; t < trips.length; t++) {
        var lt = (trips[t - 1].stopTimes || [])[i], ft = (trips[t].stopTimes || [])[i];
        if (!lt || !ft) continue;
        if (ft.arrivalSec < lt.arrivalSec) {
          bad.push({ stopId: stop.id, leader: trips[t - 1].tripId, follower: trips[t].tripId });
        }
      }
    });
    return bad;
  }

  /* ------------------------------------------------------------------ *
   * Audit export: checksummed JSON / CSV / Markdown + verification
   * ------------------------------------------------------------------ */

  /* Deterministic JSON: object keys sorted recursively so the digest never
   * depends on property insertion order. */
  function canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
    var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort();
    var parts = keys.map(function (k) { return JSON.stringify(k) + ":" + canonicalize(value[k]); });
    return "{" + parts.join(",") + "}";
  }

  /* The audit brief carries only the measured summary - never the raw trip
   * layer - so it stays small enough to paste into a report appendix. */
  function auditCore(lab) {
    var strategies = lab.strategies.map(function (s) {
      return {
        id: s.id, name: s.name, signalingMode: s.signaling.mode,
        signaling: {
          cruiseMps: s.signaling.cruiseMps,
          brakeMarginM: s.signaling.brakeMarginM,
          brakeMarginSec: s.signaling.brakeMarginSec,
          clearanceMeters: s.signaling.clearanceMeters,
          clearanceSec: s.signaling.clearanceSec,
          separationSec: s.signaling.separationSec,
          minHeadwaySec: s.signaling.minHeadwaySec,
          peakThroughputTrainsPerHr: s.signaling.peakThroughputTrainsPerHr
        },
        metrics: s.metrics
      };
    });
    return {
      generatedBy: "RailPulse dispatch laboratory",
      schema: lab.schema,
      service: lab.service,
      scenario: lab.scenario,
      strategies: strategies,
      comparison: lab.comparison,
      assumptions: lab.assumptions,
      disclosures: [
        "Integrity field is an UNKEYED SHA-256 tamper-detection digest (FIPS 180-4). It detects accidental or casual edits of the file; it is not an HMAC and provides no authentication against a determined forger.",
        "Metrics are recomputed from simulated stop times under a single-track no-overtaking queue model. They are illustrative teaching results, not agency-certified operations research.",
        "CSV cells pass through the formula-safe writer used by the station export: leading = + - @ and apostrophes are neutralized so spreadsheet tools cannot evaluate hostile cell text."
      ]
    };
  }

  function auditJson(lab) {
    var core = auditCore(lab);
    var digest = E.sha256Hex(canonicalize(core));
    var out = {};
    for (var k in core) if (Object.prototype.hasOwnProperty.call(core, k)) out[k] = core[k];
    out.integrity = {
      algorithm: "SHA-256",
      kind: "unkeyed tamper-detection digest (FIPS 180-4); not an HMAC",
      canonicalization: "JSON with recursively sorted object keys",
      digest: digest
    };
    return out;
  }

  /* Verify a previously exported audit brief. Accepts the JSON text or the
   * parsed object. Never throws on malformed input. */
  function verifyAudit(input) {
    var obj = input;
    if (typeof input === "string") {
      try { obj = JSON.parse(input); } catch (err) { return { valid: false, reason: "Input is not valid JSON" }; }
    }
    if (!obj || typeof obj !== "object") return { valid: false, reason: "Input is not an audit object" };
    var integrity = obj.integrity;
    if (!integrity || typeof integrity.digest !== "string" || !/^[0-9a-f]{64}$/.test(integrity.digest)) {
      return { valid: false, reason: "Missing or malformed integrity digest" };
    }
    var core = {};
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && k !== "integrity") core[k] = obj[k];
    var recomputed;
    try { recomputed = E.sha256Hex(canonicalize(core)); } catch (err2) { return { valid: false, reason: "Could not recompute digest" }; }
    return {
      valid: recomputed === integrity.digest,
      digest: integrity.digest,
      recomputed: recomputed,
      reason: recomputed === integrity.digest ? "Digest matches" : "Digest mismatch - the brief was modified after export"
    };
  }

  var AUDIT_COLUMNS = [
    { key: "strategy", label: "strategy" },
    { key: "signaling", label: "signaling" },
    { key: "separation_s", label: "separation_s" },
    { key: "brake_margin_m", label: "brake_margin_m" },
    { key: "min_headway_s", label: "design_min_headway_s" },
    { key: "capacity_tph", label: "peak_capacity_trains_per_hr" },
    { key: "mean_headway_s", label: "mean_headway_s" },
    { key: "cv_headway", label: "cv_headway" },
    { key: "expected_wait_s", label: "expected_wait_s" },
    { key: "excess_wait_s", label: "excess_wait_s" },
    { key: "bunch_rate", label: "bunching_rate" },
    { key: "min_headway_violations", label: "min_headway_violations" },
    { key: "min_observed_headway_s", label: "min_observed_headway_s" },
    { key: "recovery_min", label: "recovery_to_target_headway_min" },
    { key: "hold_s", label: "station_holds_s" },
    { key: "skipped_stops", label: "skipped_stops" },
    { key: "terminal_delay_s", label: "total_terminal_delay_s" },
    { key: "delivered_tph", label: "delivered_trains_per_hr" }
  ];

  function auditCsv(lab) {
    var rows = lab.strategies.map(function (s) {
      var m = s.metrics;
      return {
        strategy: s.name, signaling: s.signaling.mode,
        separation_s: s.signaling.separationSec,
        brake_margin_m: s.signaling.brakeMarginM,
        min_headway_s: s.signaling.minHeadwaySec,
        capacity_tph: s.signaling.peakThroughputTrainsPerHr,
        mean_headway_s: m.meanHeadwaySec, cv_headway: m.cvHeadway,
        expected_wait_s: m.expectedWaitSec, excess_wait_s: m.excessWaitSec,
        bunch_rate: m.bunchRate, min_headway_violations: m.minHeadwayViolations,
        min_observed_headway_s: m.minObservedHeadwaySec,
        recovery_min: m.recoveryMin, hold_s: m.totalHoldSec,
        skipped_stops: m.skippedStops, terminal_delay_s: m.totalTerminalDelaySec,
        delivered_tph: m.deliveredTrainsPerHr
      };
    });
    return E.toCsv(AUDIT_COLUMNS, rows);
  }

  function auditMarkdown(lab) {
    var json = auditJson(lab);
    var lines = [];
    lines.push("# RailPulse dispatch audit brief");
    lines.push("");
    lines.push("Service: " + lab.service.name + " | " + lab.service.tripCount + " trips | " + lab.service.stopCount + " stations | planned headway " + lab.service.plannedHeadwaySec + " s");
    lines.push("Scenario: " + lab.scenario.description);
    lines.push("");
    lines.push("| Metric | " + lab.strategies.map(function (s) { return s.shortName; }).join(" | ") + " |");
    lines.push("|---|" + lab.strategies.map(function () { return "---:"; }).join("|") + "|");
    function row(label, fn) {
      lines.push("| " + label + " | " + lab.strategies.map(function (s) { return String(fn(s)); }).join(" | ") + " |");
    }
    row("Signaling mode", function (s) { return s.signaling.mode; });
    row("Separation floor (s)", function (s) { return s.signaling.separationSec; });
    row("Braking margin (m)", function (s) { return s.signaling.brakeMarginM; });
    row("Design min headway (s)", function (s) { return s.signaling.minHeadwaySec; });
    row("Peak capacity (trains/hr)", function (s) { return s.signaling.peakThroughputTrainsPerHr; });
    row("Mean headway (s)", function (s) { return s.metrics.meanHeadwaySec; });
    row("Headway CV", function (s) { return s.metrics.cvHeadway; });
    row("Expected wait E[W] (s)", function (s) { return s.metrics.expectedWaitSec; });
    row("Excess wait (s)", function (s) { return s.metrics.excessWaitSec; });
    row("Bunching rate", function (s) { return s.metrics.bunchRate; });
    row("Min-headway violations", function (s) { return s.metrics.minHeadwayViolations; });
    row("Min observed headway (s)", function (s) { return s.metrics.minObservedHeadwaySec; });
    row("Recovery to target headway (min)", function (s) { return s.metrics.recoveryMin; });
    row("Station holds (s)", function (s) { return s.metrics.totalHoldSec; });
    row("Skipped stops", function (s) { return s.metrics.skippedStops; });
    row("Terminal delay (s)", function (s) { return s.metrics.totalTerminalDelaySec; });
    row("Delivered (trains/hr)", function (s) { return s.metrics.deliveredTrainsPerHr; });
    lines.push("");
    lines.push("SHA-256 digest (unkeyed tamper-detection, FIPS 180-4): `" + json.integrity.digest + "`");
    lines.push("");
    lab.assumptions.forEach(function (a) { lines.push("- " + a); });
    lines.push("");
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ *
   * #rp= bookmark codec
   * ------------------------------------------------------------------ */

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var out = "", i;
    for (i = 0; i + 3 <= bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i + 1 === bytes.length) {
      var m1 = bytes[i] << 16; // 1 remaining byte -> 2 base64 chars
      out += B64[(m1 >> 18) & 63] + B64[(m1 >> 12) & 63];
    } else if (i + 2 === bytes.length) {
      var m2 = (bytes[i] << 16) | (bytes[i + 1] << 8); // 2 bytes -> 3 chars
      out += B64[(m2 >> 18) & 63] + B64[(m2 >> 12) & 63] + B64[(m2 >> 6) & 63];
    }
    return out;
  }
  function b64decode(str) {
    var bytes = [], i;
    for (i = 0; i + 4 <= str.length; i += 4) {
      var n = (B64.indexOf(str[i]) << 18) | (B64.indexOf(str[i + 1]) << 12) | (B64.indexOf(str[i + 2]) << 6) | B64.indexOf(str[i + 3]);
      bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    var rem = str.length - i;
    if (rem === 1) {
      // an impossible tail: a lone base64 char carries under one byte
      bytes.push(0);
    } else if (rem === 2) {
      var m2 = (B64.indexOf(str[i]) << 18) | (B64.indexOf(str[i + 1]) << 12);
      bytes.push((m2 >> 16) & 255);
    } else if (rem === 3) {
      var m3 = (B64.indexOf(str[i]) << 18) | (B64.indexOf(str[i + 1]) << 12) | (B64.indexOf(str[i + 2]) << 6);
      bytes.push((m3 >> 16) & 255, (m3 >> 8) & 255);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  var RP_KEYS = { v: true, svc: true, layer: true, int: true, sc: true, win: true, lab: true };
  var RP_LAYER = { simulated: true, scheduled: true };
  var RP_SCENARIO = { smooth: true, incident: true, recovery: true };
  var RP_WINDOW = { focus: true, morning: true, midday: true, evening: true, full: true };
  var RP_STRATEGY = {}; STRATEGIES.forEach(function (s) { RP_STRATEGY[s.id] = true; });
  var RP_EVENT = {}; EVENT_PRESETS.forEach(function (e) { RP_EVENT[e.id] = true; });
  var RP_INTENSITY = { "0": true, "0.6": true, "1": true, "1.8": true, "2.8": true };

  /* Encode a bookmark state. Unknown keys are dropped; invalid values throw
   * so callers cannot persist corrupt state. */
  function encodeRpHash(state) {
    if (!state || typeof state !== "object") throw new Error("Bookmark state must be an object");
    var clean = { v: 1 };
    if (state.svc != null) {
      if (typeof state.svc !== "string" || !/^[\w:.-]{1,48}$/.test(state.svc)) throw new Error("Invalid bookmark service id");
      clean.svc = state.svc;
    }
    if (state.layer != null) {
      if (!RP_LAYER[state.layer]) throw new Error("Invalid bookmark layer");
      clean.layer = state.layer;
    }
    if (state.int != null) {
      if (!RP_INTENSITY[String(state.int)]) throw new Error("Invalid bookmark intensity");
      clean.int = Number(state.int);
    }
    if (state.sc != null) {
      if (!RP_SCENARIO[state.sc]) throw new Error("Invalid bookmark scenario");
      clean.sc = state.sc;
    }
    if (state.win != null) {
      if (!RP_WINDOW[state.win]) throw new Error("Invalid bookmark window");
      clean.win = state.win;
    }
    if (state.lab != null) {
      if (typeof state.lab !== "object" || !RP_STRATEGY[state.lab.strategy] || !RP_EVENT[state.lab.event]) throw new Error("Invalid bookmark lab state");
      clean.lab = { strategy: state.lab.strategy, event: state.lab.event };
    }
    return "#rp=" + b64encode(JSON.stringify(clean));
  }

  /* Strict decode: returns a sanitized bookmark object or null on ANY
   * deviation - wrong prefix, bad base64, bad JSON, unknown key, invalid
   * value. Never throws. */
  function decodeRpHash(hash) {
    try {
      if (typeof hash !== "string" || hash.length > 2048) return null;
      var body = hash.indexOf("#rp=") === 0 ? hash.slice(4) : hash.indexOf("rp=") === 0 ? hash.slice(3) : null;
      if (body == null || !body.length) return null;
      if (!/^[A-Za-z0-9\-_]+$/.test(body)) return null;
      var obj = JSON.parse(b64decode(body));
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        if (!RP_KEYS[k]) return null;
      }
      if (obj.v !== 1) return null;
      if (obj.svc != null && (typeof obj.svc !== "string" || !/^[\w:.-]{1,48}$/.test(obj.svc))) return null;
      if (obj.layer != null && !RP_LAYER[obj.layer]) return null;
      if (obj.int != null && !RP_INTENSITY[String(obj.int)]) return null;
      if (obj.sc != null && !RP_SCENARIO[obj.sc]) return null;
      if (obj.win != null && !RP_WINDOW[obj.win]) return null;
      if (obj.lab != null) {
        if (typeof obj.lab !== "object" || Array.isArray(obj.lab)) return null;
        var lk = Object.keys(obj.lab);
        if (lk.length !== 2 || !RP_STRATEGY[obj.lab.strategy] || !RP_EVENT[obj.lab.event]) return null;
      }
      var out = { v: 1 };
      if (obj.svc != null) out.svc = obj.svc;
      if (obj.layer != null) out.layer = obj.layer;
      if (obj.int != null) out.int = Number(obj.int);
      if (obj.sc != null) out.sc = obj.sc;
      if (obj.win != null) out.win = obj.win;
      if (obj.lab != null) out.lab = { strategy: obj.lab.strategy, event: obj.lab.event };
      return out;
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * In-page self-tests (also run under node --test)
   * ------------------------------------------------------------------ */

  function runSelfTests() {
    var results = [];
    function record(id, name, fn) {
      try {
        var detail = fn();
        results.push({ id: id, name: name, pass: true, detail: detail || "ok" });
      } catch (err) {
        results.push({ id: id, name: name, pass: false, detail: String(err && err.message ? err.message : err) });
      }
    }
    function eq(actual, expected, msg) {
      if (actual !== expected) throw new Error((msg || "mismatch") + " (expected " + expected + ", got " + actual + ")");
    }
    function near(actual, expected, tol, msg) {
      if (!isNum(actual) || Math.abs(actual - expected) > tol) throw new Error((msg || "out of tolerance") + " (expected " + expected + "+/-" + tol + ", got " + actual + ")");
    }

    /* FIPS 180-4 known-answer tests. */
    record("sha-empty", "SHA-256 KAT: empty message", function () {
      eq(E.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      return "e3b0c442... matches FIPS 180-4";
    });
    record("sha-abc", "SHA-256 KAT: \"abc\"", function () {
      eq(E.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      return "ba7816bf... matches FIPS 180-4";
    });
    record("sha-448", "SHA-256 KAT: 448-bit message", function () {
      eq(E.sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
         "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
      return "two-block message matches FIPS 180-4";
    });
    record("sha-896", "SHA-256 KAT: 896-bit message", function () {
      eq(E.sha256Hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
         "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
      return "896-bit message matches FIPS 180-4";
    });
    record("sha-million", "SHA-256 KAT: 1,000,000 x 'a'", function () {
      eq(E.sha256Hex(new Array(1000001).join("a")), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
      return "million-character message matches FIPS 180-4";
    });

    /* Excess-wait formula. */
    record("wait-even", "E[W] = H/2 when CV_H = 0", function () {
      var r = expectedWaitSec([480, 480, 480, 480]);
      eq(r.cvHeadway, 0, "CV must be zero for constant headways");
      eq(r.expectedWaitSec, 240, "E[W] must equal H/2 for constant headways");
      eq(r.excessWaitSec, 0, "excess wait vanishes on even spacing");
      return "E[W] = 240 s = 480/2 exactly";
    });
    record("wait-identity", "E[W] equals H/2 + Var(H)/(2*H)", function () {
      var hw = [60, 180, 300, 240, 120];
      var r = expectedWaitSec(hw);
      var m = E.mean(hw), pv = E.populationVariance(hw);
      near(r.expectedWaitSec, m / 2 + pv / (2 * m), 1e-9);
      near(r.excessWaitSec, pv / (2 * m), 1e-9);
      if (r.expectedWaitSec < r.meanHeadwaySec / 2) throw new Error("E[W] below even-spacing floor");
      return "identity holds to 1e-9 s";
    });
    record("wait-regression", "Regression case H=[60,180] gives 15 s excess", function () {
      var r = expectedWaitSec([60, 180]);
      near(r.excessWaitSec, 15, 1e-9);
      near(r.expectedWaitSec, 75, 1e-9);
      return "matches the documented finite-distribution case";
    });

    /* Braking physics. */
    record("brake-nonneg", "Braking margin is non-negative and zero at rest", function () {
      eq(brakingDistanceMeters(0, 1.0, 4), 0);
      if (brakingDistanceMeters(20, 1.0, 4) <= 0) throw new Error("margin must be positive at cruise");
      return "d(0)=0, d(20 m/s)>0";
    });
    record("brake-mono", "Braking margin grows monotonically in v", function () {
      var prev = -1;
      for (var v = 1; v <= 40; v += 1) {
        var d = brakingDistanceMeters(v, 1.0, 4);
        if (d <= prev) throw new Error("not monotone at v=" + v);
        prev = d;
      }
      return "strictly increasing over 1..40 m/s";
    });
    record("brake-formula", "Braking margin matches v^2/(2a) + v*t_r", function () {
      var d = brakingDistanceMeters(10, 1.0, 2);
      near(d, 100 / 2 + 20, 1e-9);
      near(brakingHeadwaySec(10, 1.0, 2), d / 10, 1e-9);
      return "70 m at 10 m/s, a=1.0, t_r=2 s";
    });

    /* CSV formula safety. */
    record("csv-safety", "CSV cells neutralize spreadsheet formulas", function () {
      ["=", "+", "-", "@"].forEach(function (p) {
        var cell = E.csvCell(p + "cmd");
        if (cell.charAt(0) !== "'") throw new Error("formula cell not prefixed: " + p);
      });
      eq(E.csvCell('a"b'), '"a""b"', "quotes must double and wrap");
      eq(E.csvCell("x,y"), '"x,y"', "commas must wrap");
      return "=,+,-,@ prefixed; quotes and commas wrapped";
    });

    /* Tamper detection round trip. */
    record("audit-roundtrip", "Audit digest verifies a clean brief", function () {
      var corridor = (ns.CORRIDORS || []).find(function (c) { return c.id === "cta-red"; }) || (ns.CORRIDORS || [])[0];
      var service = E.buildSyntheticService(corridor, { startSec: 7 * 3600, endSec: 8 * 3600 });
      var lab = runDispatchLab(service, { event: "door90" });
      var brief = auditJson(lab);
      var check = verifyAudit(JSON.stringify(brief));
      if (!check.valid) throw new Error("clean brief failed verification");
      return "digest " + brief.integrity.digest.slice(0, 12) + "... verifies";
    });
    record("audit-tamper", "Tampered audit brief fails verification", function () {
      var corridor = (ns.CORRIDORS || [])[0];
      var service = E.buildSyntheticService(corridor, { startSec: 7 * 3600, endSec: 8 * 3600 });
      var lab = runDispatchLab(service, { event: "door90" });
      var brief = auditJson(lab);
      brief.strategies[0].metrics.expectedWaitSec += 1;
      var check = verifyAudit(JSON.stringify(brief));
      if (check.valid) throw new Error("tampered brief still verifies");
      brief = auditJson(lab);
      var first = brief.integrity.digest.charAt(0);
      brief.integrity.digest = (first === "a" ? "b" : "a") + brief.integrity.digest.slice(1);
      var check2 = verifyAudit(JSON.stringify(brief));
      if (check2.valid) throw new Error("forged digest still verifies");
      return "payload edit and digest forgery both detected";
    });

    /* Bookmark codec round trip. */
    record("bookmark-roundtrip", "#rp= bookmark encodes and decodes exactly", function () {
      var state = { svc: "cta-red", layer: "simulated", int: 1.8, sc: "recovery", win: "evening", lab: { strategy: "cbtc", event: "surge" } };
      var hash = encodeRpHash(state);
      var back = decodeRpHash(hash);
      eq(back.svc, "cta-red"); eq(back.layer, "simulated"); eq(back.int, 1.8);
      eq(back.sc, "recovery"); eq(back.win, "evening");
      eq(back.lab.strategy, "cbtc"); eq(back.lab.event, "surge");
      return hash.slice(0, 24) + "...";
    });
    record("bookmark-strict", "Corrupted bookmarks decode to null", function () {
      ["", "#", "#rp=", "#rp=!!!", "#rp=AAAA", "#rx=AAAA", "random", "#rp=" + encodeRpHash({}).slice(4) + "@"].forEach(function (h) {
        if (decodeRpHash(h) !== null) throw new Error("accepted corrupt hash " + JSON.stringify(h));
      });
      return "strict rejection";
    });

    /* Safety invariant across strategies. */
    record("no-overtake", "No strategy permits an overtake or platform collision", function () {
      var corridor = (ns.CORRIDORS || []).find(function (c) { return c.id === "cta-red"; }) || (ns.CORRIDORS || [])[0];
      var service = E.buildSyntheticService(corridor, { startSec: 7 * 3600, endSec: 9 * 3600 });
      var lab = runDispatchLab(service, { event: "door90" });
      lab.strategies.forEach(function (s) {
        var trips = s.sim.observedTrips;
        var over = overtakeViolations(service, trips);
        if (over.length) throw new Error(s.id + " produced an overtake");
        var sep = separationViolations(service, trips, s.signaling.separationSec);
        if (sep.length) throw new Error(s.id + " violated the separation floor");
      });
      return "0 overtakes, 0 separation violations across " + lab.strategies.length + " strategies";
    });

    /* Ordering sanity between strategies under a real bunching driver. */
    record("ordering", "Spacing control beats the uncontrolled baseline under surge", function () {
      var corridor = (ns.CORRIDORS || []).find(function (c) { return c.id === "cta-red"; }) || (ns.CORRIDORS || [])[0];
      var service = E.buildSyntheticService(corridor, { startSec: 7 * 3600, endSec: 9 * 3600 });
      var lab = runDispatchLab(service, { event: "surge" });
      function m(id) { return lab.strategies.find(function (s) { return s.id === id; }).metrics; }
      if (!(m("even").cvHeadway < m("fixed").cvHeadway)) throw new Error("equalization did not reduce CV");
      if (!(m("even").excessWaitSec < m("fixed").excessWaitSec)) throw new Error("equalization did not cut excess wait");
      if (!(m("even").minHeadwayViolations <= m("fixed").minHeadwayViolations)) throw new Error("equalization did not cut violations");
      return "equalized excess " + m("even").excessWaitSec + " s vs baseline " + m("fixed").excessWaitSec + " s";
    });

    return results;
  }

  /* ------------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------------ */

  var api = {
    LAB_SCHEMA: LAB_SCHEMA,
    LAB_DEFAULTS: LAB_DEFAULTS,
    labDefaults: labDefaults,
    labStrategies: labStrategies,
    labEvents: labEvents,
    brakingDistanceMeters: brakingDistanceMeters,
    brakingHeadwaySec: brakingHeadwaySec,
    cruiseSpeedMps: cruiseSpeedMps,
    signalingProfile: signalingProfile,
    buildPerturbation: buildPerturbation,
    simulateStrategy: simulateStrategy,
    labArrivals: labArrivals,
    collectHeadways: collectHeadways,
    expectedWaitSec: expectedWaitSec,
    labMetrics: labMetrics,
    runDispatchLab: runDispatchLab,
    labAssumptions: labAssumptions,
    separationViolations: separationViolations,
    overtakeViolations: overtakeViolations,
    canonicalize: canonicalize,
    auditCore: auditCore,
    auditJson: auditJson,
    auditCsv: auditCsv,
    auditMarkdown: auditMarkdown,
    verifyAudit: verifyAudit,
    encodeRpHash: encodeRpHash,
    decodeRpHash: decodeRpHash,
    runSelfTests: runSelfTests
  };

  for (var key in api) {
    if (Object.prototype.hasOwnProperty.call(api, key)) ns[key] = api[key];
  }
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
