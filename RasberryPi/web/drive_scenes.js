/* RetroVision — generated driving scenes.
 *
 * A "less realtime, more visual" alternative to the perception HUD: instead of
 * tracking every car frame-by-frame, we infer the *kind* of driving happening
 * (parked / city / traffic / suburban / highway / canyon) from telemetry +
 * coarse vision cues, then paint a stylised retro synthwave scene that matches
 * it. The scene scrolls in parallax at a rate tied to road speed, so it feels
 * alive without needing pixel-accurate tracking.
 *
 * Public API (window.DriveScene):
 *   update(input, now)  -> {mode, label, confidence, theme, night}
 *   render(ctx, w, h, now)
 *   modeInfo()          -> last classification result
 *
 * Nothing here runs ML; it's all cheap canvas drawing tuned to survive the
 * Raspberry Pi 3B+ (LITE) at 20fps.
 */
'use strict';

(function () {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  /* trapezoidal membership: 0 below a, ramps a→b, 1 on b→c, ramps down c→d, 0 above d */
  function band(x, a, b, c, d) {
    if (x <= a || x >= d) return 0;
    if (x < b) return (x - a) / (b - a);
    if (x > c) return (d - x) / (d - c);
    return 1;
  }

  /* deterministic RNG so skylines / mountains / stars don't shimmer each frame */
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SCFG = (window.CLUSTER_CONFIG && window.CLUSTER_CONFIG.SCENE) || {};
  const SPEED_REF = SCFG.SCROLL_SPEED_REF || 60;   // mph that maps to "full" parallax flow
  const SWITCH_HOLD_MS = SCFG.SWITCH_HOLD_MS ?? 2600;  // a new mode must lead this long to win
  const STAT_WINDOW_MS = SCFG.STAT_WINDOW_MS ?? 12000;

  /* ---- per-mode retro palettes (dusk default, plus a night variant) ---- */
  const THEMES = {
    PARKED: {
      label: 'PARKED', accent: '#7c8aa0',
      sky: ['#0a0e16', '#11161f', '#1a2230'], sunWarm: false,
      grid: 'rgba(90,110,140,0.30)', ground: '#0c1119',
      ridge: ['#141b27', '#0e141d'], skyline: '#10151f', flow: 0.0,
    },
    TRAFFIC: {
      label: 'TRAFFIC', accent: '#ff5d73',
      sky: ['#1a0a14', '#2a0f1c', '#3a1322'], sunWarm: true,
      grid: 'rgba(255,93,115,0.28)', ground: '#160a10',
      ridge: ['#2a1018', '#1c0a11'], skyline: '#241019', flow: 0.25,
    },
    CITY: {
      label: 'CITY', accent: '#ff4fd8',
      sky: ['#15022b', '#3a0a52', '#7a1466'], sunWarm: false,
      grid: 'rgba(0,230,255,0.34)', ground: '#0c0118',
      ridge: ['#28063f', '#190229'], skyline: '#1d0633', flow: 0.55,
    },
    SUBURBAN: {
      label: 'SUBURBAN', accent: '#3ad6c0',
      sky: ['#0a1f2b', '#103a44', '#1f6e6a'], sunWarm: false,
      grid: 'rgba(58,214,192,0.30)', ground: '#08161a',
      ridge: ['#10322f', '#0a2421'], skyline: '#0e2a2a', flow: 0.7,
    },
    HIGHWAY: {
      label: 'HIGHWAY', accent: '#22d3ee', longRoad: true,
      sky: ['#06121f', '#0c2740', '#16486b'], sunWarm: false,
      grid: 'rgba(34,211,238,0.32)', ground: '#05101a',
      ridge: ['#0c2233', '#071622'], skyline: '#0a1c2b', flow: 1.0,
    },
    CANYON: {
      label: 'CANYON', accent: '#ff8a3d', mountains: true,
      sky: ['#2a0a05', '#5a1606', '#b8470f'], sunWarm: true,
      grid: 'rgba(255,138,61,0.30)', ground: '#170703',
      ridge: ['#3a1206', '#260b04'], skyline: '#2c0e05', flow: 0.85,
    },
  };
  // night variants: deepen the sky, keep the neon accents
  const NIGHT_SKY = ['#03040a', '#080a14', '#10131f'];

  /* ===================== driving-type classifier ===================== */
  const state = {
    samples: [],            // {t, mph} ring buffer for speed stats
    sigP: 0, pedP: 0, vehP: 0,   // EMA presence of signals / pedestrians / vehicles
    redP: 0,                // EMA presence of a red light ahead (helps TRAFFIC/CITY)
    mode: 'PARKED', label: 'PARKED', confidence: 0.4,
    candidate: 'PARKED', candidateSince: 0,
    scores: {}, lastUpdate: 0,
  };

  function pushSpeed(now, mph) {
    const s = state.samples;
    s.push({ t: now, mph });
    const cutoff = now - STAT_WINDOW_MS;
    while (s.length && s[0].t < cutoff) s.shift();
  }
  function speedStats() {
    const s = state.samples;
    if (!s.length) return { avg: 0, std: 0, stopFrac: 1, max: 0 };
    let sum = 0, max = 0, stopped = 0;
    for (const p of s) { sum += p.mph; if (p.mph > max) max = p.mph; if (p.mph < 2) stopped++; }
    const avg = sum / s.length;
    let v = 0;
    for (const p of s) v += (p.mph - avg) * (p.mph - avg);
    return { avg, std: Math.sqrt(v / s.length), stopFrac: stopped / s.length, max };
  }

  function classify(input, now) {
    const dt = state.lastUpdate ? clamp((now - state.lastUpdate) / 1000, 0, 0.5) : 0;
    state.lastUpdate = now;
    const mph = input.mph || 0;
    const rpm = input.rpm || 0;
    pushSpeed(now, mph);

    // coarse vision cues → smoothed presence values (0..1)
    let hasSignal = false, hasPed = false, hasVeh = false, hasRed = false;
    for (const d of input.dets || []) {
      const cls = d.cls;
      if (cls === 'TRAFFIC_LIGHT' || cls === 'STOP_SIGN') {
        hasSignal = true;
        if (cls === 'TRAFFIC_LIGHT' && d.state === 'RED') hasRed = true;
      } else if (cls === 'PEDESTRIAN' || cls === 'BICYCLE') {
        hasPed = true;
      } else if (cls === 'CAR' || cls === 'TRUCK' || cls === 'BUS' || cls === 'MOTORCYCLE') {
        if ((d.distM ?? 999) < 120) hasVeh = true;
      }
    }
    const ema = (cur, tgt, tau) => lerp(cur, tgt ? 1 : 0, 1 - Math.exp(-(dt || 0.05) / tau));
    state.sigP = ema(state.sigP, hasSignal, 3.0);
    state.pedP = ema(state.pedP, hasPed, 2.5);
    state.vehP = ema(state.vehP, hasVeh, 2.0);
    state.redP = ema(state.redP, hasRed, 2.0);

    const { avg, std, stopFrac } = speedStats();
    const sig = state.sigP, ped = state.pedP, veh = state.vehP;
    const lowSig = 1 - 0.7 * sig;            // de-weight fast/open modes when signals are around
    const rpmHot = clamp((rpm - 3200) / 2200, 0, 1);

    // each mode: a speed-shape × context weighting → a raw score
    const sc = {};
    sc.PARKED   = (avg < 2 && stopFrac > 0.85) ? 1 : band(avg, 0, 0, 1.5, 4) * (0.5 + 0.5 * stopFrac);
    sc.TRAFFIC  = band(avg, 1, 4, 16, 26) * clamp(stopFrac * 1.6, 0, 1) * (0.45 + 0.55 * Math.max(veh, state.redP));
    sc.CITY     = band(avg, 4, 9, 30, 42) * (0.30 + 0.70 * Math.max(sig, ped)) * (1 - 0.4 * clamp(stopFrac - 0.5, 0, 1));
    sc.SUBURBAN = band(avg, 16, 24, 40, 50) * lowSig * (1 - clamp(std / 22, 0, 0.6));
    sc.HIGHWAY  = band(avg, 44, 56, 200, 999) * lowSig * (1 - clamp(stopFrac * 3, 0, 0.7));
    sc.CANYON   = band(avg, 22, 34, 72, 92) * (0.4 + 0.6 * clamp(std / 16, 0, 1)) * (0.5 + 0.5 * rpmHot) * lowSig;
    state.scores = sc;

    // argmax candidate
    let best = 'PARKED', bestVal = -1;
    for (const k in sc) if (sc[k] > bestVal) { bestVal = sc[k]; best = k; }

    // hysteresis: a challenger must stay on top for SWITCH_HOLD_MS, and beat the
    // incumbent by a margin, before we actually switch — keeps the scene stable.
    if (best !== state.candidate) { state.candidate = best; state.candidateSince = now; }
    const held = now - state.candidateSince;
    const incumbent = sc[state.mode] ?? 0;
    if (best !== state.mode && held >= SWITCH_HOLD_MS && bestVal >= incumbent + 0.06) {
      state.mode = best;
    }
    state.label = (THEMES[state.mode] || THEMES.PARKED).label;
    // confidence = how dominant the winner is over the runner-up
    const vals = Object.values(sc).sort((a, b) => b - a);
    state.confidence = clamp((vals[0] - (vals[1] || 0)) + 0.25, 0, 1);
    return state;
  }

  /* ===================== scene renderer ===================== */
  const scene = {
    scroll: 0,          // parallax distance accumulator (advanced by speed)
    flicker: 0,         // window/neon shimmer phase
    night: false,
    lastNow: 0,
    mphShown: 0,
  };

  function themeFor(mode) { return THEMES[mode] || THEMES.PARKED; }

  function skyGradient(ctx, h, theme, night) {
    const stops = night ? NIGHT_SKY : theme.sky;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, stops[0]);
    g.addColorStop(0.55, stops[1]);
    g.addColorStop(1, stops[2]);
    return g;
  }

  function drawSun(ctx, cx, cy, r, theme, night, lite) {
    // banded synthwave sun (warm) or a cool moon at night
    const col = night ? '#cfd6e6' : (theme.sunWarm ? '#ffd23f' : '#ff5fb0');
    const col2 = night ? '#8893ab' : (theme.sunWarm ? '#ff6a3d' : '#ff2a8d');
    const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    g.addColorStop(0, col); g.addColorStop(1, col2);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    if (!night) {
      // horizontal cut-out bands across the lower half of the sun
      ctx.fillStyle = night ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.55)';
      const ground = themeFor(state.mode).sky[2];
      ctx.fillStyle = ground;
      for (let i = 0; i < 5; i++) {
        const by = cy + r * (0.18 + i * 0.16);
        ctx.fillRect(cx - r, by, r * 2, r * (0.05 + i * 0.012));
      }
    }
    ctx.restore();
    if (!lite) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  function drawStars(ctx, w, hY, night, lite) {
    if (!night) return;
    const rand = mulberry32(1337);
    const n = lite ? 36 : 80;
    ctx.save();
    for (let i = 0; i < n; i++) {
      const x = rand() * w, y = rand() * hY * 0.9;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(scene.flicker * 0.6 + i));
      ctx.globalAlpha = 0.5 * tw;
      ctx.fillStyle = '#dfe6ff';
      ctx.fillRect(x, y, 1.6, 1.6);
    }
    ctx.restore();
  }

  /* perspective floor grid that flows toward the viewer with road speed */
  function drawGrid(ctx, w, h, hY, theme, lite) {
    const cx = w / 2;
    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1.2;
    // converging verticals
    const lanes = lite ? 9 : 15;
    const spread = w * 0.9;
    for (let i = -lanes; i <= lanes; i++) {
      const bx = cx + (i / lanes) * spread;
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(cx, hY); ctx.lineTo(bx, h); ctx.stroke();
    }
    // horizontals bunched near the horizon, scrolling
    const rows = lite ? 9 : 14;
    const phase = (scene.scroll * 0.06) % 1;
    for (let k = 0; k <= rows; k++) {
      let t = (k + phase) / rows;
      if (t > 1) t -= 1;
      const ease = Math.pow(t, 2.2);              // bunch lines near horizon
      const y = hY + (h - hY) * ease;
      ctx.globalAlpha = 0.18 + 0.55 * ease;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.restore();
  }

  /* layered mountain ridges (canyon) */
  function drawMountains(ctx, w, hY, theme, lite) {
    const layers = lite ? 2 : 3;
    for (let L = 0; L < layers; L++) {
      const rand = mulberry32(7 + L * 53);
      const baseY = hY - (layers - L) * 6;
      const amp = 60 - L * 14;
      const off = -(scene.scroll * (0.05 + L * 0.04)) % w;
      ctx.fillStyle = theme.ridge[Math.min(L, theme.ridge.length - 1)] || theme.ridge[0];
      ctx.beginPath();
      ctx.moveTo(off - w, hY);
      const step = lite ? 64 : 40;
      for (let x = off - w; x <= w + step; x += step) {
        const n = rand();
        const peak = baseY - amp * (0.4 + 0.6 * n) - Math.sin(x * 0.01) * 8;
        ctx.lineTo(x, peak);
      }
      ctx.lineTo(w + step, hY); ctx.closePath(); ctx.fill();
    }
  }

  /* parallax city skyline with lit windows */
  function drawSkyline(ctx, w, hY, theme, night, lite) {
    const layers = lite ? 1 : 2;
    for (let L = layers - 1; L >= 0; L--) {
      const rand = mulberry32(91 + L * 17);
      const speed = 0.05 + L * 0.07;
      const off = -(scene.scroll * speed) % (w + 400);
      const bw = 46 + L * 18;
      const maxH = (hY * (0.42 + L * 0.22));
      ctx.fillStyle = theme.ridge[Math.min(L, theme.ridge.length - 1)];
      let bx = off - bw;
      while (bx < w + bw) {
        const bh = maxH * (0.35 + 0.65 * rand());
        const top = hY - bh;
        ctx.fillRect(bx, top, bw - 6, bh);
        // lit windows on the nearest layer only (cheap on Pi)
        if (L === 0 && !lite) {
          ctx.fillStyle = night ? 'rgba(255,214,120,0.85)' : 'rgba(150,225,255,0.5)';
          const cols = 3, rows = Math.max(2, Math.floor(bh / 22));
          for (let cI = 0; cI < cols; cI++) {
            for (let rI = 0; rI < rows; rI++) {
              if (rand() < 0.45) continue;
              const lx = bx + 7 + cI * ((bw - 14) / cols);
              const ly = top + 8 + rI * 20;
              if (ly > hY - 6) continue;
              ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(scene.flicker + cI + rI + bx));
              ctx.fillRect(lx, ly, 6, 9);
            }
          }
          ctx.globalAlpha = 1;
          ctx.fillStyle = theme.ridge[0];
        }
        bx += bw;
      }
    }
  }

  /* the road: dark ground, center dashes streaming toward the viewer, side glow */
  function drawRoad(ctx, w, h, hY, theme, lite) {
    const cx = w / 2;
    ctx.fillStyle = theme.ground;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.04, hY); ctx.lineTo(cx + w * 0.04, hY);
    ctx.lineTo(w * 1.4, h); ctx.lineTo(-w * 0.4, h); ctx.closePath(); ctx.fill();

    // glowing edges
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.85; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.04, hY); ctx.lineTo(-w * 0.4, h);
    ctx.moveTo(cx + w * 0.04, hY); ctx.lineTo(w * 1.4, h);
    ctx.stroke();
    if (!lite) {
      ctx.globalAlpha = 0.18; ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.04, hY); ctx.lineTo(-w * 0.4, h);
      ctx.moveTo(cx + w * 0.04, hY); ctx.lineTo(w * 1.4, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // center dashes — perspective stripes scrolling forward
    const rows = lite ? 7 : 11;
    const phase = (scene.scroll * 0.08) % 1;
    ctx.fillStyle = 'rgba(245,250,255,0.9)';
    for (let k = 0; k <= rows; k++) {
      let t = (k + phase) / rows;
      if (t > 1) t -= 1;
      const ease = Math.pow(t, 2.0);
      const y = hY + (h - hY) * ease;
      const yw = (h - hY) * 0.05 * ease + 2;
      const halfw = (2 + 22 * ease);
      ctx.globalAlpha = 0.25 + 0.6 * ease;
      ctx.fillRect(cx - halfw / 2, y, halfw, yw);
    }
    ctx.globalAlpha = 1;
  }

  /* big mode word, lower-left, retro outline */
  function drawModeBadge(ctx, w, h, theme, label, conf) {
    ctx.save();
    ctx.font = '800 30px "SF Pro Rounded", system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const x = 22, y = h - 26;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(label, x + 1.5, y + 1.5);
    ctx.fillStyle = theme.accent; ctx.fillText(label, x, y);
    // confidence pips
    const pips = Math.round(conf * 5);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < pips ? theme.accent : 'rgba(255,255,255,0.14)';
      ctx.fillRect(x + i * 11, y + 8, 8, 4);
    }
    ctx.font = '600 10px "SF Pro Rounded", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText('SCENE', x, y - 30);
    ctx.restore();
  }

  function update(input, now) {
    const dt = scene.lastNow ? clamp((now - scene.lastNow) / 1000, 0, 0.3) : 0;
    scene.lastNow = now;
    const cls = classify(input, now);
    const theme = themeFor(cls.mode);
    // night when headlights are on (or forced)
    scene.night = !!(input.lights && (input.lights.head || input.lights.hi));
    // smooth speed, advance parallax: faster road => faster flow. Idle modes drift.
    scene.mphShown = lerp(scene.mphShown, input.mph || 0, 1 - Math.exp(-(dt || 0.05) / 0.6));
    const flow = theme.flow * (0.25 + scene.mphShown / SPEED_REF);
    scene.scroll += flow * dt * 60;
    scene.flicker += dt * 1.4;
    return { mode: cls.mode, label: cls.label, confidence: cls.confidence, theme, night: scene.night };
  }

  function render(ctx, w, h, now) {
    const theme = themeFor(state.mode);
    const lite = document.body.classList.contains('lite');
    const night = scene.night;
    const hY = h * (SCFG.HORIZON_FRAC ?? 0.52);

    // sky
    ctx.fillStyle = skyGradient(ctx, h, theme, night);
    ctx.fillRect(0, 0, w, h);

    drawStars(ctx, w, hY, night, lite);

    // celestial body sits just above the horizon, drifts slowly opposite traffic
    const sunX = w * 0.5 + Math.sin(scene.scroll * 0.0008) * w * 0.06;
    drawSun(ctx, sunX, hY - 18, h * 0.20, theme, night, lite);

    // midground per mode
    if (theme.mountains) drawMountains(ctx, w, hY, theme, lite);
    else if (theme.label === 'CITY' || theme.label === 'TRAFFIC') drawSkyline(ctx, w, hY, theme, night, lite);
    else drawMountains(ctx, w, hY, theme, lite);   // gentle ridges for highway/suburban/parked

    // horizon line
    ctx.strokeStyle = theme.accent; ctx.globalAlpha = night ? 0.5 : 0.7; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, hY); ctx.lineTo(w, hY); ctx.stroke(); ctx.globalAlpha = 1;

    // ground grid + road
    drawGrid(ctx, w, h, hY, theme, lite);
    drawRoad(ctx, w, h, hY, theme, lite);

    drawModeBadge(ctx, w, h, theme, state.label, state.confidence);
  }

  window.DriveScene = {
    update, render,
    modeInfo: () => ({ mode: state.mode, label: state.label, confidence: state.confidence, scores: state.scores }),
    themes: THEMES,
  };
})();
