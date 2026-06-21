/* RetroVision — intersection timer (Lamborghini-Urus-style countdown).
 *
 * Watches the perception stream + telemetry for intersections (traffic lights,
 * stop signs) and the car's own motion, then shows a big circular countdown.
 *
 * ── Intelligence ────────────────────────────────────────────────────────────
 * Raw vision labels flicker and drop out, so we don't trust a single frame.
 * Instead we fuse cues into two debounced beliefs:
 *
 *   1. "Is an intersection PRESENT?"  — a confidence value (0..1) that builds
 *      when a light/stop sign is detected and is *corroborated* by motion:
 *      hard braking or coming to a stop shortly after seeing a signal sustains
 *      the belief even while the detection blinks in and out. It decays slowly
 *      while we're waiting at the light and quickly once we're clearly past it.
 *
 *   2. "Has it gone GREEN?"  — declared from any of three signals, so we know
 *      it's green even when the light head itself isn't cleanly visible:
 *        • the light is confirmed GREEN across several frames, OR
 *        • the lead vehicle ahead pulls away (its range opens up), OR
 *        • our own car starts rolling again after the wait.
 *      Whichever fires first ends the red, flashes GO, and feeds the measured
 *      red duration into a learned model (running mean + variance, persisted),
 *      so the predicted "time to green" sharpens — and shows a ± confidence.
 *
 * Phases: APPROACH (ETA to a detected intersection) · STOP HOLD (stop-sign
 * dwell) · RED WAIT (predicted time-to-green) · GO (confirmation flash).
 * Owns its own DOM widget; dashboard.js just calls update() each frame.
 */
'use strict';

(function () {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ICFG = (window.CLUSTER_CONFIG && window.CLUSTER_CONFIG.INTERSECTION) || {};

  const STORE_KEY = 'rv_intersection_model';
  const DEFAULT_RED_MS = ICFG.DEFAULT_RED_MS ?? 28000;   // typical red phase before any learning
  const STOP_HOLD_MS = ICFG.STOP_HOLD_MS ?? 3000;        // required full-stop dwell at a stop sign
  const NEAR_FT = ICFG.NEAR_FT ?? 130;                   // an intersection object within this is "ahead"
  const LATERAL_FT = ICFG.LATERAL_FT ?? 16;              // |x| within this counts as in our path
  const STOPPED_MPH = ICFG.STOPPED_MPH ?? 2;
  const GO_MPH = ICFG.GO_MPH ?? 4;                       // rolling again => treat as moving off
  const LEARN_ALPHA = ICFG.LEARN_ALPHA ?? 0.3;           // EMA weight for newly observed red durations
  const FRESH_MS = ICFG.FRESH_MS ?? 900;                 // how long a detection stays "seen"
  const CONF_SHOW = ICFG.CONF_SHOW ?? 0.45;              // present-confidence needed to surface the widget
  const GREEN_CONFIRM = ICFG.GREEN_CONFIRM_FRAMES ?? 2;  // frames of GREEN before we trust it
  const RED_CONFIRM = ICFG.RED_CONFIRM_FRAMES ?? 2;
  const LEAD_MOVE_FT = ICFG.LEAD_MOVE_FT ?? 8;           // lead vehicle range opening => traffic moving
  const BRAKE_DECEL = ICFG.BRAKE_DECEL_MPHS ?? 3;        // mph/s slow-down that corroborates an intersection

  /* ---- learned model (running mean + variance of observed red phases) ---- */
  const model = loadModel();
  function loadModel() {
    try {
      const m = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (m && typeof m.redAvgMs === 'number') { if (typeof m.redVarMs !== 'number') m.redVarMs = 0; return m; }
    } catch {}
    return { redAvgMs: DEFAULT_RED_MS, redVarMs: 0, redCount: 0 };
  }
  function saveModel() { try { localStorage.setItem(STORE_KEY, JSON.stringify(model)); } catch {} }
  function learnRed(durMs) {
    if (durMs < 4000 || durMs > 180000) return;          // ignore garbage / very long stops
    if (!model.redCount) { model.redAvgMs = durMs; model.redVarMs = 0; }
    else {
      model.redAvgMs += (durMs - model.redAvgMs) * LEARN_ALPHA;
      const dev = durMs - model.redAvgMs;
      model.redVarMs += (dev * dev - model.redVarMs) * LEARN_ALPHA;
    }
    model.redCount++;
    saveModel();
  }

  /* ---- running state ---- */
  const S = {
    phase: 'IDLE',
    ixConf: 0,             // belief that an intersection is present (0..1)
    ixKind: null,          // TRAFFIC_LIGHT | STOP_SIGN (last corroborated)
    ixDist: 999,
    lightState: null,      // confirmed light colour (debounced)
    greenStreak: 0, redStreak: 0,
    redStart: 0,           // when the confirmed red began
    stopStart: 0,          // when the car came to a stop
    leadBase: null,        // lead-vehicle range captured at the stop line
    goUntil: 0, goReason: '',
    prevMph: 0, lastT: 0,
    lastSeen: 0,
  };

  /* nearest intersection object (light/stop) roughly in our path */
  function pickIntersection(dets) {
    let best = null;
    for (const d of dets || []) {
      if (d.cls !== 'TRAFFIC_LIGHT' && d.cls !== 'STOP_SIGN') continue;
      const dist = d.distM ?? 999, lat = Math.abs(d.xRelM ?? 99);
      if (dist > NEAR_FT || lat > LATERAL_FT) continue;
      if (!best || dist < best.dist) best = { cls: d.cls, dist, state: d.state || null };
    }
    return best;
  }
  /* nearest in-path vehicle (the car we're sitting behind at the light) */
  function pickLead(dets) {
    let best = null;
    for (const d of dets || []) {
      if (d.cls !== 'CAR' && d.cls !== 'TRUCK' && d.cls !== 'BUS' && d.cls !== 'MOTORCYCLE') continue;
      const dist = d.distM ?? 999, lat = Math.abs(d.xRelM ?? 99);
      if (lat > LATERAL_FT || dist > NEAR_FT) continue;
      if (!best || dist < best.dist) best = { dist };
    }
    return best;
  }

  /* ---- DOM widget (owned here) ---- */
  let root, mainEl, labelEl, subEl, hintEl, built = false;
  function build() {
    if (built) return;
    root = document.getElementById('xtimer');
    if (!root) return;
    mainEl = root.querySelector('.xt-main');
    labelEl = root.querySelector('.xt-label');
    subEl = root.querySelector('.xt-sub');
    hintEl = root.querySelector('.xt-hint');
    built = true;
  }
  const fmtClock = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function paint(view) {
    build();
    if (!root) return;
    const on = view.phase !== 'IDLE';
    root.classList.toggle('on', on);
    if (!on) return;
    root.dataset.phase = view.phase;
    root.style.setProperty('--xt-accent', view.color);
    root.style.setProperty('--xt-frac', clamp(view.frac, 0, 1));
    if (labelEl.textContent !== view.label) labelEl.textContent = view.label;
    if (mainEl.textContent !== view.main) mainEl.textContent = view.main;
    subEl.textContent = view.sub || '';
    hintEl.textContent = view.hint || '';
    root.classList.toggle('pulse', !!view.pulse);
  }

  function learnedHint() {
    if (!model.redCount) return 'learning lights…';
    const sd = Math.round(Math.sqrt(model.redVarMs || 0) / 1000);
    return `model ${Math.round(model.redAvgMs / 1000)}s ±${sd}s · ${model.redCount} seen`;
  }

  function update(input, now) {
    const mph = input.mph || 0;
    const dt = S.lastT ? clamp((now - S.lastT) / 1000, 0, 0.5) : 0;
    const decel = dt > 0 ? (S.prevMph - mph) / dt : 0;   // mph/s, positive = slowing
    S.lastT = now; S.prevMph = mph;
    const stopped = mph <= STOPPED_MPH;

    const ix = pickIntersection(input.dets);
    const lead = pickLead(input.dets);
    if (ix) { S.lastSeen = now; S.ixKind = ix.cls; S.ixDist = ix.dist; }
    const seenRecently = now - S.lastSeen < FRESH_MS;

    // ── belief 1: intersection presence (debounced + motion-corroborated) ──
    if (ix) {
      S.ixConf = lerp(S.ixConf, 1, 1 - Math.exp(-dt / 0.4));            // build fast on detection
    } else {
      const holdTau = (S.phase === 'RED' || S.phase === 'STOP') ? 6.0 : 1.6;
      S.ixConf = lerp(S.ixConf, 0, 1 - Math.exp(-dt / holdTau));        // decay (slow while waiting)
    }
    // braking hard or stopping shortly after a signal sustains the belief
    if ((decel > BRAKE_DECEL || stopped) && now - S.lastSeen < 4000) S.ixConf = Math.max(S.ixConf, 0.6);
    S.ixConf = clamp(S.ixConf, 0, 1);
    const present = S.ixConf > CONF_SHOW;

    // track stop onset + lead baseline
    if (stopped) { if (!S.stopStart) S.stopStart = now; }
    else { S.stopStart = 0; S.leadBase = null; }

    // ── belief 2: confirmed light colour (debounce single-frame flips) ──
    const raw = ix && ix.cls === 'TRAFFIC_LIGHT' ? ix.state : null;
    S.greenStreak = raw === 'GREEN' ? S.greenStreak + 1 : 0;
    S.redStreak = raw === 'RED' ? S.redStreak + 1 : 0;
    if (S.greenStreak >= GREEN_CONFIRM) S.lightState = 'GREEN';
    else if (S.redStreak >= RED_CONFIRM) S.lightState = 'RED';
    // a red WAIT begins only once we're stopped at a confirmed red (not on approach)
    if (stopped && S.lightState === 'RED' && !S.redStart) S.redStart = now;
    const waiting = !!S.redStart;
    if (waiting && stopped && lead && S.leadBase == null) S.leadBase = lead.dist;

    // ── declare GREEN from whichever intelligence signal fires first ──
    // Only while we're actually waiting at the red, so a green light we're merely
    // approaching doesn't trigger a phantom GO.
    let greenReason = '';
    if (waiting) {
      if (S.greenStreak >= GREEN_CONFIRM) greenReason = 'light is green';
      else if (S.leadBase != null && lead && lead.dist - S.leadBase > LEAD_MOVE_FT) greenReason = 'traffic moving';
      else if (mph > GO_MPH) greenReason = 'rolling off';
    }
    if (greenReason) {
      learnRed(now - S.redStart);
      S.redStart = 0; S.lightState = 'GREEN'; S.leadBase = null;
      S.goUntil = now + 2500; S.goReason = greenReason;
    }

    // ── phase selection ──
    let view = { phase: 'IDLE' };
    if (now < S.goUntil) {
      view = { phase: 'GO', label: 'SIGNAL', main: 'GO', sub: S.goReason || 'proceed',
               color: '#34d058', frac: 1, pulse: true, hint: learnedHint() };
    } else if (present && stopped && S.lightState === 'RED') {
      const elapsed = S.redStart ? now - S.redStart : (now - (S.stopStart || now));
      const remain = model.redAvgMs - elapsed;
      view = {
        phase: 'RED', label: 'RED LIGHT', color: '#ff3b30',
        frac: clamp(1 - elapsed / Math.max(model.redAvgMs, 1), 0, 1),
        main: remain > 0 ? `${Math.ceil(remain / 1000)}s` : 'ANY SEC',
        sub: `predicted green · waited ${fmtClock(elapsed)}`,
        hint: learnedHint(), pulse: remain <= 0,
      };
    } else if (present && stopped && S.ixKind === 'STOP_SIGN') {
      const held = now - (S.stopStart || now);
      const remain = STOP_HOLD_MS - held;
      if (remain <= 0) {
        S.goUntil = now + 1800; S.goReason = 'clear to proceed';
        view = { phase: 'GO', label: 'STOP SIGN', main: 'GO', sub: 'clear to proceed',
                 color: '#34d058', frac: 1, pulse: true };
      } else {
        view = { phase: 'STOP', label: 'STOP SIGN', color: '#f43f5e',
                 main: `${(remain / 1000).toFixed(1)}s`, sub: 'hold full stop',
                 frac: clamp(held / STOP_HOLD_MS, 0, 1) };
      }
    } else if (present && !stopped && seenRecently) {
      const ftps = mph * 1.4667;
      const eta = ftps > 1 ? S.ixDist / ftps : Infinity;
      const isStop = S.ixKind === 'STOP_SIGN';
      const label = isStop ? 'STOP AHEAD'
        : S.lightState === 'RED' ? 'RED AHEAD'
        : S.lightState === 'GREEN' ? 'GREEN AHEAD' : 'SIGNAL AHEAD';
      const color = isStop ? '#f43f5e'
        : S.lightState === 'GREEN' ? '#34d058'
        : S.lightState === 'RED' ? '#ff3b30' : '#facc15';
      view = {
        phase: 'APPROACH', label, color,
        main: isFinite(eta) ? `${eta.toFixed(1)}s` : '—',
        sub: `${Math.round(S.ixDist)} ft ahead · ${Math.round(S.ixConf * 100)}% sure`,
        frac: clamp(1 - S.ixDist / NEAR_FT, 0, 1),
        pulse: isFinite(eta) && eta < 2.5,
      };
    }

    paint(view);
    S.phase = view.phase;
    return view;
  }

  window.IntersectionTimer = {
    update,
    model: () => ({ ...model }),
    state: () => ({ phase: S.phase, ixConf: S.ixConf, lightState: S.lightState }),
    reset() { model.redAvgMs = DEFAULT_RED_MS; model.redVarMs = 0; model.redCount = 0; saveModel(); },
  };
})();
