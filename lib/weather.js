'use strict';

// Game weather via Open-Meteo (free, no key) + MLB venue geometry. The MLB venue API
// supplies coordinates, azimuthAngle (home-plate→center-field bearing) and elevation, so
// we can turn a raw wind vector into the thing that actually matters for HR: how hard it's
// blowing OUT toward center vs IN. Archive endpoint for past dates (validation), forecast
// for upcoming games (live). Wired into the live HR model via weatherHrMult (see
// probabilities.js), with per-park wind sensitivity (PARK_WIND_SENSITIVITY) and a
// game-window vector average rather than a single first-pitch snapshot.

const https = require('https');

function getJ(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mlbapp/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const venueCache = {};
async function getVenueMeta(venueId) {
  if (venueCache[venueId]) return venueCache[venueId];
  const v = await getJ(`https://statsapi.mlb.com/api/v1/venues/${venueId}?hydrate=location,fieldInfo`).catch(() => null);
  const ven = v?.venues?.[0];
  const loc = ven?.location;
  const c = loc?.defaultCoordinates;
  if (!c || c.latitude == null) return null;
  const meta = {
    lat: c.latitude, lon: c.longitude,
    azimuth: loc.azimuthAngle ?? null, elevation: loc.elevation ?? null,
    roof: ven?.fieldInfo?.roofType || 'Open',
    name: ven?.name ?? null,
  };
  venueCache[venueId] = meta;
  return meta;
}

// Signed "out-wind" in mph: + = blowing out toward CF (HR boost), − = blowing in (suppress).
// Open-Meteo windDir = degrees the wind comes FROM. Out-to-CF means the wind vector points
// toward the azimuth, i.e. comes from (azimuth+180). out-component = −cos(windFrom − azimuth).
function windOutMph(windMph, windFromDeg, azimuth) {
  if (windMph == null || windFromDeg == null || azimuth == null) return null;
  const out = -Math.cos((windFromDeg - azimuth) * Math.PI / 180);
  return +(windMph * out).toFixed(1);
}

// Cross-wind component: perpendicular to the CF axis.
// + = blowing from the RF/1B side toward LF/3B side (helps RHB pull hitters to LF).
// − = blowing from the LF/3B side toward RF/1B side (helps LHB pull hitters to RF).
// Combined with outWindMph, this lets probabilities.js compute a batter-hand-specific
// effective wind for their pull-side HR direction (LHB HR → RF, RHB HR → LF).
function windCrossMph(windMph, windFromDeg, azimuth) {
  if (windMph == null || windFromDeg == null || azimuth == null) return null;
  const cross = Math.sin((windFromDeg - azimuth) * Math.PI / 180);
  return +(windMph * cross).toFixed(1);
}

// Precise, park-relative wind label — combines the out/cross components into an 8-point
// compass description ("Out to Right-Center", "In from Left", etc.) instead of a blunt
// In/Out-to-CF bucket. Requested : the old bucket was too vague, and showing
// only a coarse "In"/"Out" next to the raw total windMph (rather than the actual
// out-component) made the header and the live-weather-driven prop notes look like they
// disagreed even when they were reading the same data — a 10mph wind blowing mostly
// cross with only a mild out-component is very different from 10mph dead out, but both
// used to render as similar-looking text.
function windCompassLabel(outMph, crossMph) {
  if (outMph == null || crossMph == null) return null;
  const mag = Math.sqrt(outMph * outMph + crossMph * crossMph);
  if (mag < 2) return `${mag.toFixed(0)} mph, calm`;
  // atan2(cross, out): 0=dead out, +90=cross toward RF/1B, ±180=dead in, -90=cross toward LF/3B
  const angle = Math.atan2(crossMph, outMph) * 180 / Math.PI;
  let dir;
  if      (angle > -22.5  && angle <= 22.5)  dir = 'out to center';
  else if (angle > 22.5   && angle <= 67.5)  dir = 'out to right-center';
  else if (angle > 67.5   && angle <= 112.5) dir = 'crossing toward right field';
  else if (angle > 112.5  && angle <= 157.5) dir = 'in from right-center';
  else if (angle > 157.5  || angle <= -157.5) dir = 'in from center';
  else if (angle > -157.5 && angle <= -112.5) dir = 'in from left-center';
  else if (angle > -112.5 && angle <= -67.5)  dir = 'crossing toward left field';
  else dir = 'out to left-center'; // -67.5 to -22.5
  return `${mag.toFixed(0)} mph ${dir}`;
}

// Park-specific wind SENSITIVITY multiplier — scales the global per-mph wind slope below.
// Added from two independent real sources: (1) MLB's own Weather Applied
// Metrics/Statcast charts of 2023-24 wind-created/prevented HR counts and total
// wind-affected batted-ball volume per park (ground truth — a physics model comparing each
// batted ball's actual trajectory to a calm-air counterfactual), and (2) this app's own
// PA-normalized team HR-rate study across all 30 parks, 2026 season (in-wind suppression
// side only — the more reliable half; the out-wind-lift side was noisy/backwards at ~half
// the league, likely from uncontrolled batter-quality confounds on a modest per-park game
// count). Tiered only where both sources agree on direction with real magnitude — every
// other park stays at the league-average 1.0x rather than force a number off a single or
// noisy source. Keyed by lowercase venue name (matches PARK_HAND_HR's convention).
const PARK_WIND_SENSITIVITY = {
  'wrigley field':      2.0,   // ~3x the next park on total wind-affected-ball volume, and
                                // the only park where this app's own rate study confirmed
                                // BOTH directions (out +33%, in +44%) — the one park worth
                                // pushing furthest from neutral
  'kauffman stadium':   1.4,   // most HR prevented by wind in MLB (67, 2023-24); this app's
                                // in-wind rate (+34%) agrees on direction and magnitude
  't-mobile park':      1.4,   // 2nd-most HR prevented (55); in-wind rate (+49%) agrees
  'fenway park':        1.4,   // large total wind-affected volume; in-wind rate (+59%) agrees
  'citi field':         1.35,  // most HR CREATED by wind (28) plus large total volume —
                                // high two-way sensitivity even though net washes out
  'citizens bank park': 1.3,   // large prevented count (48); in-wind rate (+34%) agrees
  'coors field':        1.15,  // moderate wind-chart activity; altitude/carry effects are
                                // already handled by the separate park factor, this is wind only
  'yankee stadium':     1.15,  // meaningful prevented count (37) on the real chart, but this
                                // app's own in-wind number was noise — kept conservative
};

// HR multiplier from temperature + out-wind. Hot air carries (~+6% per 10°F over 72);
// each mph of out-wind ~+1.8% HR, in-wind the reverse. Clamped so a bad/extreme forecast
// can't dominate the rate. windSensitivity (default 1.0) scales ONLY the wind term — see
// PARK_WIND_SENSITIVITY above — temp sensitivity is not known to vary by park.
function weatherHrMult(tempF, outWindMph, windSensitivity) {
  const sens = windSensitivity != null ? windSensitivity : 1.0;
  let m = 1.0;
  if (tempF != null) m *= Math.max(0.90, Math.min(1.12, 1 + (tempF - 72) * 0.006));
  if (outWindMph != null) {
    if (outWindMph >= 0) {
      // Out-wind: capped at +25% for a neutral park, but the cap itself has to scale with
      // sensitivity too — a flat 1.25 ceiling saturates by ~14mph out even at sens=1.0,
      // which would silently erase Wrigley's extra sensitivity on exactly the days (15-20+
      // mph out) it matters most. Absolute ceiling of +60% regardless of park so a bad
      // forecast still can't run away.
      const outCap = Math.min(1.60, 1 + 0.25 * sens);
      m *= Math.min(outCap, 1 + outWindMph * 0.018 * sens);
    } else {
      // In-wind suppression — empirically calibrated against 2,694 open-park games
      // (Jun-Aug 2023-2025): 0-5mph in → -5% HR, 5-10mph in → -7% HR.
      // Implied sensitivity: ~0.010/mph (much less than the symmetric 0.018/mph boost
      // for out-wind — in-wind affect is real but smaller per mph than commonly claimed).
      // Floor scales with sensitivity the same way as the out-cap above; absolute floor of
      // 0.20 (some HRs always happen even in gale-force conditions on perfectly struck balls).
      const inFloor = Math.max(0.20, 1 - 0.55 * sens);
      m *= Math.max(inFloor, 1 + outWindMph * 0.010 * sens);
    }
  }
  return +m.toFixed(4);
}

// ---------------------------------------------------------------------------
// Sun glare for hitters. The batter looks toward center field (the venue azimuth); a LOW sun
// roughly in that sightline is in their eyes → tougher ABs → offense suppressed. Pure solar
// math (no API): date/time + lat/lon → sun elevation & azimuth. MLB orients parks so the
// setting sun is usually BEHIND the batter, so this fires rarely — a sparse, high-signal flag.
// ---------------------------------------------------------------------------
const RAD = Math.PI / 180;
function solarPosition(date, lat, lon) {
  const n = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const L   = (280.460 + 0.9856474 * n) % 360;
  const g   = (357.528 + 0.9856003 * n) % 360;
  const lam = (L + 1.915 * Math.sin(g * RAD) + 0.020 * Math.sin(2 * g * RAD)) % 360;
  const eps = 23.439 - 0.0000004 * n;
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lam * RAD)) / RAD;
  const ra   = Math.atan2(Math.cos(eps * RAD) * Math.sin(lam * RAD), Math.cos(lam * RAD)) / RAD;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let ha = ((gmst + lon) % 360 - ra) % 360; if (ha < -180) ha += 360; if (ha > 180) ha -= 360;
  const el = Math.asin(Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD)) / RAD;
  let az = Math.atan2(-Math.sin(ha * RAD), Math.tan(decl * RAD) * Math.cos(lat * RAD) - Math.sin(lat * RAD) * Math.cos(ha * RAD)) / RAD;
  return { el, az: (az + 360) % 360 };
}
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Worst glare across the game (samples first pitch → ~3 hours, since the sun drops as it goes).
// roofOpen=false (dome/closed) → no glare. Returns { rating:'high'|'moderate'|'none', el, off, minutesIn }.
function sunGlare(lat, lon, azimuth, gameTimeUTC, roofOpen) {
  if (!roofOpen || lat == null || azimuth == null || !gameTimeUTC) return { rating: 'none' };
  const t0 = new Date(gameTimeUTC); if (isNaN(t0)) return { rating: 'none' };
  let worst = { rating: 'none', score: 0 };
  for (const mins of [0, 45, 90, 135, 180]) {
    const { el, az } = solarPosition(new Date(t0.getTime() + mins * 60000), lat, lon);
    if (el <= 3 || el >= 38) continue;          // below horizon/stands, or too high to blind
    const off = angDiff(az, azimuth);
    if (off >= 55) continue;                    // sun not in the batter's forward field of view
    const score = (1 - off / 55) * (1 - (el - 3) / 35);   // closer + lower = worse, 0..1
    if (score > worst.score) {
      const rating = (el < 28 && off < 45) ? 'high' : 'moderate';
      worst = { rating, score: +score.toFixed(2), el: Math.round(el), off: Math.round(off), minutesIn: mins };
    }
  }
  return worst.rating === 'none' ? { rating: 'none' } : worst;
}

// Run-total suppression from hitter glare (offense down when the sun's in their eyes). Conservative.
function glareRunMult(glare) {
  return glare?.rating === 'high' ? 0.95 : glare?.rating === 'moderate' ? 0.98 : 1.0;
}

// gameTimeUTC: the game's UTC ISO start. isPast => archive endpoint, else forecast.
// We index Open-Meteo in GMT so the game's UTC hour maps directly (no timezone math).
// mlbCondition: MLB's own schedule-hydrated weather.condition string for this exact game
// (e.g. "Sunny", "Roof Closed"). For Retractable venues this tells us the ACTUAL roof
// state for this game rather than a blanket "always treat as closed" guess — MLB reports
// the literal string "Roof Closed" when shut, and a normal outdoor condition (Clear,
// Sunny, Cloudy, etc.) whenever it's open. Confirmed against Rogers Centre's full 2026
// schedule: only those two patterns appear, no ambiguous third case.
async function getGameWeather(venueId, gameTimeUTC, isPast, mlbCondition) {
  const m = await getVenueMeta(venueId);
  if (!m || !gameTimeUTC) return null;
  const dt = new Date(gameTimeUTC);
  if (isNaN(dt)) return null;
  const dateStr = dt.toISOString().slice(0, 10);
  const hour    = dt.getUTCHours();
  const base = isPast
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';
  const range = isPast ? `&start_date=${dateStr}&end_date=${dateStr}` : '&forecast_days=3';
  const url = `${base}?latitude=${m.lat}&longitude=${m.lon}`
    + `&hourly=temperature_2m,apparent_temperature,wind_speed_10m,wind_direction_10m`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT${range}`;
  const j = await getJ(url).catch(() => null);
  if (!j?.hourly?.time) return null;
  const want = `${dateStr}T${String(hour).padStart(2, '0')}:00`;
  let i = j.hourly.time.indexOf(want);
  if (i < 0) return null;
  let tempF = j.hourly.temperature_2m[i];
  let feelsLikeF = j.hourly.apparent_temperature?.[i];

  // Game-window wind (fix): average the OUT and CROSS vector COMPONENTS across
  // the game's ~3-hour span (first pitch → +3h), not a single first-pitch snapshot. Fixes
  // two real failure modes caught on the Busch/ATL@STL card: (1) a one-hour speed SPIKE in
  // the hourly model (12mph at first pitch, 6-7mph the hours on either side) was read as the
  // whole-game wind; (2) on light/variable days the direction swings hour to hour (out one
  // hour, straight in the next), so a lone reading asserts a confident "out to center" that
  // isn't real. Vector-averaging handles both physically: a lone spike is diluted by the
  // representative surrounding hours, and opposing hours cancel (wind that's out then in nets
  // ~zero real carry effect). windMph becomes the EFFECTIVE net magnitude — so a variable
  // day that nets to nothing correctly reads "calm" rather than a phantom strong wind.
  const hourlyVec = (offsetH) => {
    const t2 = new Date(dt.getTime() + offsetH * 3600000);
    const i2 = j.hourly.time.indexOf(t2.toISOString().slice(0, 13) + ':00');
    if (i2 < 0) return null;
    const ws = j.hourly.wind_speed_10m[i2], wd = j.hourly.wind_direction_10m[i2];
    const o = windOutMph(ws, wd, m.azimuth), c = windCrossMph(ws, wd, m.azimuth);
    return (o == null || c == null) ? null : { o, c };
  };
  const gameHours = [0, 1, 2, 3].map(hourlyVec).filter(Boolean);
  let outWindMph, crossWindMph, windMph, windDir = j.hourly.wind_direction_10m[i];
  if (gameHours.length) {
    outWindMph   = +(gameHours.reduce((a, g) => a + g.o, 0) / gameHours.length).toFixed(1);
    crossWindMph = +(gameHours.reduce((a, g) => a + g.c, 0) / gameHours.length).toFixed(1);
    windMph      = +Math.sqrt(outWindMph * outWindMph + crossWindMph * crossWindMph).toFixed(1);
  } else {
    // Fallback: original single first-pitch reading if the game-window hours aren't present.
    windMph = j.hourly.wind_speed_10m[i];
    outWindMph   = windOutMph(windMph, windDir, m.azimuth);
    crossWindMph = windCrossMph(windMph, windDir, m.azimuth); // + = toward RF/1B side
  }
  const windSens   = PARK_WIND_SENSITIVITY[(m.name || '').toLowerCase()] ?? 1.0;

  // Roof handling: a fixed Dome is climate-controlled (no wind, neutral temp). A
  // Retractable's true state comes from mlbCondition when available (see above); if MLB
  // hasn't reported it yet (far-future game), fall back to the conservative "assume shut"
  // default. Open parks use the full forecast.
  const roof = m.roof || 'Open';
  const roofConfirmedClosed = mlbCondition ? /closed/i.test(mlbCondition) : true;
  let hrMult, windDesc;
  if (roof === 'Dome') {
    // A fixed dome is fully climate-controlled — neutralize feelsLikeF too, not just
    // tempF. Confirmed : probabilities.js's run-total weather formula prefers
    // feelsLikeF over tempF whenever it's present, so leaving the outdoor apparent
    // temperature un-reset here leaked a real "hot/windy +7% runs" note into a Tropicana
    // Field (dome) game — wind was correctly zeroed, but the heat side wasn't.
    tempF = 72; feelsLikeF = 72; windMph = 0; outWindMph = 0; crossWindMph = 0; hrMult = 1.0; windDesc = 'Roof closed';
  } else if (roof === 'Retractable' && roofConfirmedClosed) {
    outWindMph = 0; crossWindMph = 0;
    // Half temp effect (closed roof still carries some day's-heat residual, unlike a
    // permanently climate-controlled fixed dome) — feelsLikeF gets the same half-blend
    // as tempF so it can't leak the full outdoor value the way it did for fixed domes.
    if (feelsLikeF != null) feelsLikeF = 72 + (feelsLikeF - 72) * 0.5;
    tempF = 72 + (tempF - 72) * 0.5;
    hrMult = weatherHrMult(tempF, 0);
    windDesc = mlbCondition ? 'Roof closed' : 'Retractable roof (unconfirmed, assumed closed)';
  } else {
    hrMult = weatherHrMult(tempF, outWindMph, windSens);
    windDesc = (windMph == null || windMph < 4) ? 'Calm'
             : Math.abs(outWindMph) >= 3 ? (outWindMph > 0 ? 'Out' : 'In')
             : 'Cross';
  }
  // Wind trend across the game — sampled from the SAME hourly response (no extra API
  // call), at first pitch / ~mid-game / ~late-game (0h, +2h, +4h). Wind can meaningfully
  // build or fade over a 3-hour game (e.g. Kauffman 7/1/26: 12.6mph out at first pitch,
  // down to 4.9mph by the final innings). The main HR reading is now the game-window
  // vector average (above); this hour-by-hour trend is surfaced alongside it so a user can
  // SEE the variability the average smooths over (building/fading/steady).
  let windTrend = null;
  const roofOpenForTrend = roof === 'Open' || (roof === 'Retractable' && !roofConfirmedClosed);
  if (roofOpenForTrend) {
    const points = [];
    for (const offsetH of [0, 2, 4]) {
      const t2 = new Date(dt.getTime() + offsetH * 3600000);
      const want2 = t2.toISOString().slice(0, 13) + ':00';
      const i2 = j.hourly.time.indexOf(want2);
      if (i2 < 0) continue;
      const ws2 = j.hourly.wind_speed_10m[i2], wd2 = j.hourly.wind_direction_10m[i2];
      const out2   = windOutMph(ws2, wd2, m.azimuth);
      const cross2 = windCrossMph(ws2, wd2, m.azimuth);
      if (out2 == null) continue;
      points.push({ hoursFromStart: offsetH, outWindMph: out2, windLabel: windCompassLabel(out2, cross2) });
    }
    if (points.length >= 2) {
      const first = points[0].outWindMph, last = points[points.length - 1].outWindMph;
      const label = Math.abs(first) < 3 && Math.abs(last) < 3 ? 'steady'
        : (last - first) <= -3 ? 'fading'
        : (last - first) >= 3  ? 'building'
        : 'steady';
      windTrend = { points, label };
    }
  }

  const glare = sunGlare(m.lat, m.lon, m.azimuth, gameTimeUTC, roof === 'Open');
  // Heat-index flag (open parks only — roofed games are climate-controlled, no exposure).
  // Display/monitor only for now: the humid-extreme fatigue effect is unproven (tiny sample),
  // so this flags the condition and lets us accumulate it over the summer to test later.
  const heatFlag = (roof === 'Open' && feelsLikeF != null)
    ? (feelsLikeF >= 100 ? 'extreme' : feelsLikeF >= 95 ? 'hot' : null)
    : null;
  return {
    tempF: tempF != null ? Math.round(tempF) : null,
    feelsLikeF: feelsLikeF != null ? Math.round(feelsLikeF) : null,
    windMph: windMph != null ? Math.round(windMph) : null,
    windDir, azimuth: m.azimuth, elevation: m.elevation,
    outWindMph, crossWindMph, roof, windDesc, windTrend,
    windLabel: windCompassLabel(outWindMph, crossWindMph),
    hrMult, windSensitivity: windSens, heatFlag,
    sunGlare: glare, glareRunMult: glareRunMult(glare),
  };
}

module.exports = { getGameWeather, getVenueMeta, windOutMph, windCrossMph, windCompassLabel, weatherHrMult, solarPosition, sunGlare, glareRunMult };
