/* RetroVision — intersection timer (Lamborghini-Urus-style countdown).
 *
 * Watches the perception stream + telemetry for intersections (traffic lights,
 * stop signs) and the car's own motion, then shows a big circular countdown:
 *
 *   APPROACH    car moving, an intersection is ahead → time-to-arrival counts
 *               down (distance / speed), ring drains as you close in.
 *   STOP HOLD   stopped at a stop sign → 3s "complete stop" hold, then GO.
 *   RED WAIT    stopped at a red light → predicted "time to green" countdown.
 *               The prediction is *learned*: we record how long observed reds
 *               actually last and keep an EMA per the running average, so the
 *               estimate sharpens the more lights you sit through. Elapsed wait
 *               is always shown as ground truth beneath the prediction.
 *   GO          brief confirmation flash when the light turns green / you clear.
 *
 * Persists its learned model in localStorage so it survives reloads. Owns its
 * own DOM widget; dashboard.js just calls update() each frame.
 */
'use strict';

(function () {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const ICFG = (window.CLUSTER_CONFIG && window.CLUSTER_CONFIG.INTERSECTION) || {};

  const STORE_KEY = 'rv_intersection_model';
  const DEFAULT_RED_MS = ICFG.DEFAULT_RED_MS ?? 28000;   // typical red phase before any learning
  const STOP_HOLD_MS = ICFG.STOP_HOLD_MS ?? 3000;        // required full-stop dwell at a stop sign
  const NEAR_FT = ICFG.NEAR_FT ?? 130;                   // an intersection object within this is "ahead"
  const LATERAL_FT = ICFG.LATERAL_FT ?? 16;              // |x| within this counts as in our path
  const STOPPED_MPH = ICFG.STOPPED_MPH ?? 2;
  const LEARN_ALPHA = ICFG.LEARN_ALPHA ?? 0.3;           // EMA weight for newly observed red durations
  const FRESH_MS = ICFG.FRESH_MS ?? 900;                 // how long a detection stays "seen"

  /* ---- learned model ---- */
  const model = loadModel();
  function loadModel() {
    try {
      const m = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (m && typeof m.redAvgMs === 'number') return m;
    } catch {}
    return { redAvgMs: DEFAULT_RED_MS, redCount: 0 };
  }
  function saveModel() { try { localStorage.setItem(STORE_KEY, JSON.stringify(model)); } catch {} }
  function learnRed(durMs) {
    if (durMs < 4000 || durMs > 180000) return;          // ignore garbage / very long stops
    model.redAvgMs = model.redCount ? model.redAvgMs + (durMs - model.redAvgMs) * LEARN_ALPHA : durMs;
    model.redCount++;
    saveModel();
  }

  /* ---- running state ---- */
  const S = {
    phase: 'IDLE',
    redStart: 0,           // when the current red light first observed
    stopStart: 0,          // when the car first came to a stop
    lastLightState: null,  // RED / YELLOW / GREEN of the nearest light
    goUntil: 0,            // show the GO flash until this time
    lastSeen: 0,
  };

  /* pick the most relevant intersection object ahead (nearest, roughly in-path) */
  function pickIntersection(dets) {
    let best = null;
    for (const d of dets || []) {
      if (d.cls !== 'TRAFFIC_LIGHT' && d.cls !== 'STOP_SIGN') continue;
      const dist = d.distM ?? 999;
      const lat = Math.abs(d.xRelM ?? 99);
      if (dist > NEAR_FT || lat > LATERAL_FT) continue;
      if (!best || dist < best.dist) best = { cls: d.cls, dist, state: d.state || null };
    }
    return best;
  }

  /* ---- DOM widget (owned here) ---- */
  let root, ringEl, mainEl, labelEl, subEl, hintEl, built = false;
  function build() {
    if (built) return;
    root = document.getElementById('xtimer');
    if (!root) return;                 // index.html didn't include the widget
    ringEl = root.querySelector('.xt-ring');
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

  function update(input, now) {
    const mph = input.mph || 0;
    const stopped = mph <= STOPPED_MPH;
    const ix = pickIntersection(input.dets);
    if (ix) S.lastSeen = now;
    const fresh = now - S.lastSeen < FRESH_MS;

    // track stop onset
    if (stopped) { if (!S.stopStart) S.stopStart = now; }
    else S.stopStart = 0;

    // track the nearest light's color + learn red durations on RED→GREEN
    const lightState = ix && ix.cls === 'TRAFFIC_LIGHT' ? ix.state : null;
    if (lightState === 'RED' && S.lastLightState !== 'RED') S.redStart = now;
    if (lightState === 'GREEN' && S.lastLightState === 'RED' && S.redStart) {
      learnRed(now - S.redStart);
      S.goUntil = now + 2500;
      S.redStart = 0;
    }
    if (lightState) S.lastLightState = lightState;

    let view = { phase: 'IDLE' };

    if (now < S.goUntil) {
      view = { phase: 'GO', label: 'SIGNAL', main: 'GO', sub: 'green — proceed',
               color: '#34d058', frac: 1, pulse: true, hint: learnedHint() };
    } else if (fresh && stopped && S.lastLightState === 'RED') {
      // RED WAIT — predicted time-to-green from the learned average
      const elapsed = S.redStart ? now - S.redStart : (now - (S.stopStart || now));
      const remain = model.redAvgMs - elapsed;
      const frac = clamp(1 - elapsed / Math.max(model.redAvgMs, 1), 0, 1);
      view = {
        phase: 'RED', label: 'RED LIGHT', color: '#ff3b30', frac,
        main: remain > 0 ? `${Math.ceil(remain / 1000)}s` : 'ANY SEC',
        sub: `green in ~ · waited ${fmtClock(elapsed)}`,
        hint: learnedHint(), pulse: remain <= 0,
      };
    } else if (fresh && stopped && ix && ix.cls === 'STOP_SIGN') {
      // STOP HOLD — count the required full stop, then clear to GO
      const held = now - (S.stopStart || now);
      const remain = STOP_HOLD_MS - held;
      if (remain <= 0) {
        S.goUntil = now + 1800;
        view = { phase: 'GO', label: 'STOP SIGN', main: 'GO', sub: 'clear to proceed',
                 color: '#34d058', frac: 1, pulse: true };
      } else {
        view = { phase: 'STOP', label: 'STOP SIGN', color: '#f43f5e',
                 main: `${(remain / 1000).toFixed(1)}s`, sub: 'hold full stop',
                 frac: clamp(held / STOP_HOLD_MS, 0, 1) };
      }
    } else if (fresh && ix && !stopped) {
      // APPROACH — time-to-arrival = distance / speed
      const ftps = mph * 1.4667;
      const eta = ftps > 1 ? ix.dist / ftps : Infinity;
      const label = ix.cls === 'STOP_SIGN' ? 'STOP AHEAD'
        : ix.state === 'RED' ? 'RED AHEAD'
        : ix.state === 'GREEN' ? 'GREEN AHEAD' : 'SIGNAL AHEAD';
      const color = ix.cls === 'STOP_SIGN' ? '#f43f5e'
        : ix.state === 'GREEN' ? '#34d058'
        : ix.state === 'RED' ? '#ff3b30' : '#facc15';
      view = {
        phase: 'APPROACH', label, color,
        main: isFinite(eta) ? `${eta.toFixed(1)}s` : '—',
        sub: `${Math.round(ix.dist)} ft ahead`,
        frac: clamp(1 - ix.dist / NEAR_FT, 0, 1),
        pulse: isFinite(eta) && eta < 2.5,
      };
    }

    paint(view);
    return view;
  }

  function learnedHint() {
    if (!model.redCount) return 'learning lights…';
    return `model: ${Math.round(model.redAvgMs / 1000)}s avg · ${model.redCount} seen`;
  }

  window.IntersectionTimer = {
    update,
    model: () => ({ ...model }),
    reset() { model.redAvgMs = DEFAULT_RED_MS; model.redCount = 0; saveModel(); },
  };
})();
