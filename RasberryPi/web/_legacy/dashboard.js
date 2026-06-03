/* Car cluster UI — HTML/CSS layout matching the Figma "Dashboard".
 * Left: speed. Right: gear + rpm. Center: glass road panel.
 * Six 270-degree ring gauges. Live telemetry from serial_bridge /ws.
 */
'use strict';

const TACH_REDLINE = 6500;
const SPEED_MAX = 160;

// ---- ring gauge (inline SVG, 270deg, gap at bottom) ----
const R = 40, CIRC = 2 * Math.PI * R, TRACK = 0.75 * CIRC;
function makeGauge({ name }) {
  const el = document.createElement('div');
  el.className = 'gauge';
  el.innerHTML = `
    <svg viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="${R}" fill="#0c110d" stroke="#11160f" stroke-width="2"/>
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="var(--green-track)"
        stroke-width="5" stroke-linecap="round"
        stroke-dasharray="${TRACK} ${CIRC}" transform="rotate(135 50 50)"/>
      <circle class="val" cx="50" cy="50" r="${R}" fill="none" stroke="var(--green-val)"
        stroke-width="5" stroke-linecap="round"
        stroke-dasharray="0 ${CIRC}" transform="rotate(135 50 50)"/>
    </svg>
    <img class="icon" src="assets/oilcan.svg" alt=""/>
    <span class="lab l">L</span><span class="lab h">H</span>
    <span class="name">${name}</span>`;
  const val = el.querySelector('.val');
  el.setValue = (frac, color) => {
    frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    val.setAttribute('stroke-dasharray', `${frac * TRACK} ${CIRC}`);
    if (color) val.setAttribute('stroke', color);
  };
  return el;
}

// gauge definitions: id, label, value(d)->0..1, color(d)->optional
const RED = '#ff4d4d', GRN = 'var(--green-val)', AMB = '#ffb020';
const GAUGES_L = [
  { name: 'Fuel',    val: d => (d.fuelPct || 0) / 100,
    col: d => (d.fuelPct < 15 ? RED : d.fuelPct < 30 ? AMB : GRN) },
  { name: 'Coolant', val: d => clamp((d.tempC ?? 20) / 120, 0, 1),
    col: d => ((d.tempC ?? 0) > 105 ? RED : GRN) },
  { name: 'Oil',     val: () => 0.62, col: () => GRN },
];
const GAUGES_R = [
  { name: 'Humid',   val: d => (d.humidity ?? 0) / 100, col: () => GRN },
  { name: 'Range',   val: d => clamp((d.distanceCm ?? 0) / 400, 0, 1), col: () => GRN },
  { name: 'Batt',    val: () => 0.72, col: () => GRN },
];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

// build gauges
const gaugesL = document.getElementById('gaugesL');
const gaugesR = document.getElementById('gaugesR');
const gEls = [];
GAUGES_L.forEach(g => { const e = makeGauge(g); gaugesL.appendChild(e); gEls.push([e, g]); });
GAUGES_R.forEach(g => { const e = makeGauge(g); gaugesR.appendChild(e); gEls.push([e, g]); });

// ---- elements ----
const $ = id => document.getElementById(id);
const elSpeed = $('speed'), elSpeedBar = $('speedBar');
const elRpmText = $('rpmText'), elRpmBar = $('rpmBar'), elGear = $('gear');
const elTurnL = $('turnL'), elTurnR = $('turnR');
const elTells = [...document.querySelectorAll('.tell')];
const elLinkDot = $('linkDot'), elLinkText = $('linkText'), elClock = $('clock');

// ---- telemetry ----
const target = { rpm: 0, mph: 0, fuelPct: 0, tempC: null, humidity: null, distanceCm: null,
                 lights: {}, status: {}, seq: 0, link: 'stale' };
const shown = { rpm: 0, mph: 0 };

// ---- websocket ----
function connect() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws`); }
  catch (e) { setTimeout(connect, 1000); return; }
  ws.onmessage = ev => { try { Object.assign(target, JSON.parse(ev.data)); } catch (e) {} };
  ws.onclose = () => { target.link = 'stale'; setTimeout(connect, 1000); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
connect();

// ---- render loop ----
let last = performance.now();
let lastTextRpm = -1, lastSpeed = -1, lastGear = '';
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  const k = 1 - Math.pow(0.0015, dt);
  shown.mph = lerp(shown.mph, target.mph || 0, k);
  shown.rpm = lerp(shown.rpm, target.rpm || 0, k);
  const blink = (Math.floor(now / 420) % 2) === 0;

  // speed
  const mph = Math.round(shown.mph);
  if (mph !== lastSpeed) { elSpeed.textContent = mph; lastSpeed = mph; }
  elSpeedBar.style.width = clamp(shown.mph / SPEED_MAX, 0, 1) * 100 + '%';

  // rpm + gear
  const rpm = Math.round(shown.rpm / 10) * 10;
  if (rpm !== lastTextRpm) { elRpmText.textContent = rpm + ' rpm'; lastTextRpm = rpm; }
  elRpmBar.style.width = clamp(shown.rpm / TACH_REDLINE, 0, 1) * 100 + '%';
  const gear = (target.mph || 0) < 1 ? 'P' : 'D';
  if (gear !== lastGear) { elGear.textContent = gear; lastGear = gear; }

  // gauges (throttled: every other frame is fine, but cheap enough)
  for (const [e, g] of gEls) e.setValue(g.val(target), g.col(target));

  // turn signals + tells
  const L = target.lights || {};
  elTurnL.classList.toggle('on', !!(L.left || L.hazard) && blink);
  elTurnR.classList.toggle('on', !!(L.right || L.hazard) && blink);
  for (const t of elTells) {
    const key = t.dataset.t;
    const on = key === 'hazard' ? (!!L.hazard && blink) : !!L[key];
    t.classList.toggle('on', on);
  }

  // link + clock
  const lk = target.link || 'stale';
  if (elLinkText.textContent !== lk.toUpperCase()) {
    elLinkText.textContent = lk.toUpperCase();
    const c = lk === 'live' ? '#34d058' : lk === 'demo' ? '#ffb020' : '#ff3b30';
    elLinkDot.style.background = c;
    elLinkDot.style.boxShadow = `0 0 8px ${c}`;
  }
  const t = new Date();
  elClock.textContent = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
