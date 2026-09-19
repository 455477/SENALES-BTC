'use strict';
/*
 * Revisor de señales de BTC (La Visión del Precio) para GitHub Actions.
 * El motor (indicadores, zonas y reglas) es el mismo de analizador-btc.html.
 * Variables de entorno:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (secrets del repo; también acepta BOT_TOKEN / CHAT_ID)
 *   MIN_GRADE   calidad mínima para avisar: A, B o C (por defecto B)
 *   DRY_RUN=1   no envía ni guarda nada, solo muestra el mensaje
 *   TEST_MESSAGE=true  envía un mensaje de prueba y termina
 */
const fs = require('fs');

const TFS = ['5m', '15m', '1h'];
const TF = {
  '5m':  { ms: 300000,  binance: '5m',  bybit: '5',  okx: '5m',  cb: 300,  kraken: 5 },
  '15m': { ms: 900000,  binance: '15m', bybit: '15', okx: '15m', cb: 900,  kraken: 15 },
  '1h':  { ms: 3600000, binance: '1h',  bybit: '60', okx: '1H',  cb: 3600, kraken: 60 }
};
const DEFAULTS = {
  sepK: 0.5, slopeN: 10, rangeN: 200,
  swingL: 5, reactK: 1, reactWindow: 12, maxAge5: 288, maxAge15: 250,
  touchTol: 0.1, stopBuf: 0.1, minStop: 0.5, minRR: 1.5, fresh: 3, use5mTargets: false,
  riskPct: 2, capital: 1000,
  feePct: 0.1, btDays: 30, btGrade: 'AB', btHold: 24
};

/* ============================================================
   Fuentes de datos (Binance primero, luego respaldos)
   ============================================================ */
const mapArr = (arr, t, o, h, l, c, v, mul) => arr.map(k => ({ t: +k[t] * mul, o: +k[o], h: +k[h], l: +k[l], c: +k[c], v: +k[v] }));
const SOURCES = [
  { id: 'binance', name: 'Binance', quote: 'USDT',
    url: tf => `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${TF[tf].binance}&limit=500`,
    parse: j => mapArr(j, 0, 1, 2, 3, 4, 5, 1) },
  { id: 'binance-vision', name: 'Binance (datos públicos)', quote: 'USDT',
    url: tf => `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=${TF[tf].binance}&limit=500`,
    parse: j => mapArr(j, 0, 1, 2, 3, 4, 5, 1) },
  { id: 'bybit', name: 'Bybit', quote: 'USDT',
    url: tf => `https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=${TF[tf].bybit}&limit=500`,
    parse: j => { if (j.retCode !== 0) throw new Error(j.retMsg || 'Respuesta inválida'); return mapArr(j.result.list, 0, 1, 2, 3, 4, 5, 1).reverse(); } },
  { id: 'okx', name: 'OKX', quote: 'USDT',
    url: tf => `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${TF[tf].okx}&limit=300`,
    parse: j => { if (j.code !== '0') throw new Error(j.msg || 'Respuesta inválida'); return mapArr(j.data, 0, 1, 2, 3, 4, 5, 1).reverse(); } },
  { id: 'coinbase', name: 'Coinbase', quote: 'USD',
    url: tf => `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${TF[tf].cb}`,
    parse: j => j.map(k => ({ t: +k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5] })).reverse() },
  { id: 'kraken', name: 'Kraken', quote: 'USD',
    url: tf => `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${TF[tf].kraken}`,
    parse: j => {
      if (j.error && j.error.length) throw new Error(j.error[0]);
      const key = Object.keys(j.result).find(k => k !== 'last');
      return mapArr(j.result[key], 0, 1, 2, 3, 4, 6, 1000);
    } }
];

async function fetchJSON(url, timeout = 8000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}
async function fetchKlines(src, tf) {
  const arr = src.parse(await fetchJSON(src.url(tf)));
  const ok = arr.filter(c => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)).sort((a, b) => a.t - b.t);
  const out = ok.filter((c, i) => i === 0 || c.t !== ok[i - 1].t);
  if (out.length < 120) throw new Error('Pocas velas recibidas (' + out.length + ')');
  return out;
}


/* ============================================================
   Indicadores
   ============================================================ */
function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let e = sum / period; out[period - 1] = e;
  const a = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { e = values[i] * a + e * (1 - a); out[i] = e; }
  return out;
}
function atr(cs, period = 14) {
  const out = new Array(cs.length).fill(NaN);
  if (cs.length <= period) return out;
  const tr = cs.map((c, i) => i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c)));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period; out[period] = a;
  for (let i = period + 1; i < cs.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}
const lastOf = a => a[a.length - 1];

/* ============================================================
   Tendencia en 1h: cruce de EMAs 50/100 con separación real
   ============================================================ */
function analyzeTrend(c1h, P) {
  const closes = c1h.map(c => c.c);
  const e50 = ema(closes, 50), e100 = ema(closes, 100), at = atr(c1h);
  const i = c1h.length - 1;
  if (i < 100 + P.slopeN || !isFinite(e100[i]) || !isFinite(at[i])) {
    return { dir: 'none', reason: 'Faltan velas de 1h para calcular las EMAs.' };
  }
  const sep = e50[i] - e100[i], A = at[i], sepAtr = sep / A;
  const s50 = e50[i] - e50[i - P.slopeN], s100 = e100[i] - e100[i - P.slopeN];
  const close = c1h[i].c;
  let crossIdx = -1;
  for (let k = i; k > 100; k--) {
    const d = e50[k] - e100[k], dp = e50[k - 1] - e100[k - 1];
    if (!isFinite(dp)) break;
    if ((d >= 0) !== (dp >= 0)) { crossIdx = k; break; }
  }
  const strong = Math.abs(sepAtr) >= P.sepK;
  let dir = 'none', reason = '';
  if (!strong) {
    reason = `La EMA 50 y la EMA 100 están pegadas (separación de ${nf2.format(Math.abs(sepAtr))} ATR, mínimo ${nf2.format(P.sepK)}). El libro dice que en ese caso las EMAs no ayudan.`;
  } else if (sep > 0) {
    if (!(s50 > 0 && s100 > 0)) reason = 'Las EMAs están abiertas hacia arriba, pero no se desplazan con fuerza en esa dirección.';
    else if (!(close > e100[i])) reason = 'El precio cerró por debajo de la EMA 100: no confirma la tendencia alcista.';
    else dir = 'up';
  } else {
    if (!(s50 < 0 && s100 < 0)) reason = 'Las EMAs están abiertas hacia abajo, pero no se desplazan con fuerza en esa dirección.';
    else if (!(close < e100[i])) reason = 'El precio cerró por encima de la EMA 100: no confirma la tendencia bajista.';
    else dir = 'down';
  }
  return { dir, reason, e50: e50[i], e100: e100[i], sep, sepAtr, s50, s100, atr: A, close,
    crossAgo: crossIdx < 0 ? null : i - crossIdx };
}

/* ============================================================
   Zonas de compra/venta de 2 velas
   ============================================================ */
function detectZones(cs, tf, at, P) {
  const n = cs.length, L = P.swingL, M = P.reactWindow;
  const maxAge = tf === '5m' ? P.maxAge5 : P.maxAge15;
  const ms = TF[tf].ms;
  const buy = [], sell = [];
  const start = Math.max(L + 1, n - maxAge);
  for (let k = start; k < n - 1; k++) {
    const c = cs[k], d = cs[k + 1], A = at[k];
    if (!isFinite(A)) continue;
    const range = c.h - c.l;

    // --- zona de compra
    let isLow = true;
    for (let j = 1; j <= L; j++) if (cs[k - j].l < c.l) { isLow = false; break; }
    if (isLow && d.l >= c.l) {
      const bottom = c.l;
      let top = Math.max(c.o, c.c);
      if (top - bottom < 0.15 * A) top = bottom + 0.15 * A;
      let conf = -1;
      for (let j = k + 1; j < n && j <= k + 1 + M; j++) {
        if (cs[j].c < bottom) break;
        if (cs[j].h - bottom >= P.reactK * A) { conf = j; break; }
      }
      if (conf >= 0) {
        let broken = false, tests = 0, prev = false;
        for (let j = conf + 1; j < n; j++) {
          if (cs[j].c < bottom) { broken = true; break; }
          const t = cs[j].l <= top;
          if (t && !prev) tests++;
          prev = t;
        }
        if (!broken) {
          const wick = range > 0 && (Math.min(c.o, c.c) - c.l) / range >= 0.5;
          buy.push({ kind: 'buy', tf, bottom, top, t: c.t, activeFrom: cs[conf].t + ms, wick, tests, merged: 1, id: `${tf}-buy-${c.t}` });
        }
      }
    }

    // --- zona de venta
    let isHigh = true;
    for (let j = 1; j <= L; j++) if (cs[k - j].h > c.h) { isHigh = false; break; }
    if (isHigh && d.h <= c.h) {
      const top = c.h;
      let bottom = Math.min(c.o, c.c);
      if (top - bottom < 0.15 * A) bottom = top - 0.15 * A;
      let conf = -1;
      for (let j = k + 1; j < n && j <= k + 1 + M; j++) {
        if (cs[j].c > top) break;
        if (top - cs[j].l >= P.reactK * A) { conf = j; break; }
      }
      if (conf >= 0) {
        let broken = false, tests = 0, prev = false;
        for (let j = conf + 1; j < n; j++) {
          if (cs[j].c > top) { broken = true; break; }
          const t = cs[j].h >= bottom;
          if (t && !prev) tests++;
          prev = t;
        }
        if (!broken) {
          const wick = range > 0 && (c.h - Math.max(c.o, c.c)) / range >= 0.5;
          sell.push({ kind: 'sell', tf, bottom, top, t: c.t, activeFrom: cs[conf].t + ms, wick, tests, merged: 1, id: `${tf}-sell-${c.t}` });
        }
      }
    }
  }
  const gap = 0.1 * (lastOf(at.filter(isFinite)) || 0);
  return [...mergeZones(buy, gap), ...mergeZones(sell, gap)];
}
function mergeZones(zs, gap) {
  zs.sort((a, b) => a.bottom - b.bottom);
  const out = [];
  for (const z of zs) {
    const l = out[out.length - 1];
    if (l && z.bottom <= l.top + gap) {
      l.top = Math.max(l.top, z.top); l.bottom = Math.min(l.bottom, z.bottom);
      l.wick = l.wick || z.wick; l.tests += z.tests; l.merged += 1;
      l.activeFrom = Math.min(l.activeFrom, z.activeFrom);
      if (z.t < l.t) { l.t = z.t; l.id = z.id; }
    } else out.push({ ...z });
  }
  return out;
}
function scoreZone(z) {
  if (z.principal) return 4;
  let s = 1;
  if (z.wick) s++;
  if (z.tests >= 2) s++;
  if (z.merged >= 2) s++;
  if (z.conf) s++;
  return Math.min(4, s);
}
function principalRange(c1h, A, P) {
  const arr = c1h.slice(-P.rangeN);
  let hi = -Infinity, lo = Infinity, hiT = 0, loT = 0;
  for (const c of arr) { if (c.h > hi) { hi = c.h; hiT = c.t; } if (c.l < lo) { lo = c.l; loT = c.t; } }
  const th = 0.4 * A;
  return {
    hi, lo,
    resistance: { kind: 'sell', tf: '1h', principal: true, top: hi, bottom: hi - th, t: hiT, activeFrom: 0, tests: 0, merged: 1, id: `1h-principal-sell-${hiT}` },
    support:    { kind: 'buy',  tf: '1h', principal: true, bottom: lo, top: lo + th, t: loT, activeFrom: 0, tests: 0, merged: 1, id: `1h-principal-buy-${loT}` }
  };
}

/* ============================================================
   Velas de confirmación
   ============================================================ */
const isHammer = c => { const r = c.h - c.l; if (r <= 0) return false; const lw = Math.min(c.o, c.c) - c.l, uw = c.h - Math.max(c.o, c.c); return lw / r >= 0.55 && uw / r <= 0.25; };
const isInvHammer = c => { const r = c.h - c.l; if (r <= 0) return false; const lw = Math.min(c.o, c.c) - c.l, uw = c.h - Math.max(c.o, c.c); return uw / r >= 0.55 && lw / r <= 0.25; };
const bullEngulf = (p, c) => p.c < p.o && c.c > c.o && c.o <= p.c && c.c >= p.o;
const bearEngulf = (p, c) => p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o;

/* ============================================================
   Motor de señales
   ============================================================ */
const zoneName = z => z.principal ? (z.kind === 'buy' ? 'soporte principal' : 'resistencia principal') : `zona de ${z.kind === 'buy' ? 'compra' : 'venta'} de ${z.tf}`;
const zoneRange = z => `${fmt(z.bottom)} a ${fmt(z.top)}`;

function gradeSignal(plan, z, type) {
  let pts = 0;
  const s = z.score || 1;
  pts += s >= 3 ? 2 : s >= 2 ? 1 : 0;                 // fuerza de la zona
  pts += plan.rr >= 2.5 ? 2 : plan.rr >= 2 ? 1 : 0;   // recorrido hasta el objetivo
  if (type === 'martillo' || type === 'martillo invertido' || type.startsWith('envolvente')) pts += 1; // vela clara
  if (plan.fallback) pts -= 1;                        // objetivo inventado
  return pts >= 4 ? 'A' : pts >= 2 ? 'B' : 'C';
}

function evaluateSignal(A, P) {
  const { trend, zones, c5, price, atr5 } = A;
  const out = { state: 'wait', dir: null, checks: [], plan: null, why: '', next: '', nearest: null, cand: null, alertZone: null };
  const NA = (label, detail = 'Todavía no corresponde evaluarlo') => ({ label, status: 'na', detail });
  const tLabel = 'Tendencia en 1 hora';

  if (trend.dir === 'none') {
    out.checks = [{ label: tLabel, status: 'fail', detail: trend.reason }, NA('Zona a favor de la tendencia'), NA('Precio en la zona'), NA('Vela de confirmación'), NA('Riesgo y beneficio')];
    out.why = 'No hay una tendencia clara en 1 hora. ' + trend.reason;
    out.next = 'Solo se opera a favor de la tendencia. Cuando las EMAs 50 y 100 se separen y se desplacen con fuerza hacia un lado, la app empieza a buscar entradas.';
    return out;
  }

  const dir = trend.dir === 'up' ? 'buy' : 'sell';
  out.dir = dir;
  const word = dir === 'buy' ? 'compra' : 'venta';
  const trendWord = dir === 'buy' ? 'alcista' : 'bajista';
  const tol = P.touchTol * atr5;
  const n = c5.length, lastC = c5[n - 1];
  const trendDetail = `${dir === 'buy' ? 'Alcista' : 'Bajista'}: EMAs separadas ${nf2.format(Math.abs(trend.sepAtr))} ATR y con pendiente a favor.`;

  const zs = zones.filter(z => z.kind === dir && !z.broken);
  zs.sort((a, b) => a.dist - b.dist);
  out.nearest = zs[0] || null;

  const touch = (c, z) => dir === 'buy' ? (c.l <= z.top + tol && c.c >= z.bottom) : (c.h >= z.bottom - tol && c.c <= z.top);
  const confirmAt = (j, z) => {
    const c = c5[j], p = c5[j - 1];
    if (!p || c.t < z.activeFrom) return null;
    const tj = touch(c, z), tp = p.t >= z.activeFrom && touch(p, z);
    if (dir === 'buy') {
      if (tj && isHammer(c)) return 'martillo';
      if ((tj || tp) && bullEngulf(p, c)) return 'envolvente alcista';
      if ((tj || tp) && c.c > z.top && c.c > c.o) return 'cierre por encima de la zona';
    } else {
      if (tj && isInvHammer(c)) return 'martillo invertido';
      if ((tj || tp) && bearEngulf(p, c)) return 'envolvente bajista';
      if ((tj || tp) && c.c < z.bottom && c.c < c.o) return 'cierre por debajo de la zona';
    }
    return null;
  };

  // buscar confirmación en las últimas velas cerradas de 5m
  let cand = null;
  for (let j = n - 1; j >= Math.max(1, n - P.fresh) && !cand; j--) {
    let best = null;
    for (const z of zs) {
      const type = confirmAt(j, z);
      if (!type) continue;
      let t = j;
      for (let k = Math.max(0, j - 2); k <= j; k++) if (c5[k].t >= z.activeFrom && touch(c5[k], z)) { t = k; break; }
      let broken = false;
      for (let k = t; k < n; k++) if (dir === 'buy' ? c5[k].c < z.bottom : c5[k].c > z.top) { broken = true; break; }
      if (broken) continue;
      const sc = z.score || 1;
      if (!best || sc > best.sc || (sc === best.sc && z.dist < best.z.dist)) best = { z, j, t, type, sc };
    }
    if (best) cand = best;
  }

  // zonas que el precio está tocando ahora (para la alerta)
  const touching = zs.filter(z => {
    const inNow = price >= z.bottom - tol && price <= z.top + tol;
    const recent = [n - 1, n - 2].some(k => k >= 0 && c5[k].t >= z.activeFrom && touch(c5[k], z));
    return inNow || recent;
  });
  const alertZone = touching.sort((a, b) => (b.score || 1) - (a.score || 1) || a.dist - b.dist)[0] || null;

  // plan de la operación
  let plan = null;
  if (cand) {
    const { z, t, j } = cand;
    const buf = P.stopBuf * atr5;
    const since = c5.slice(t);
    let stop, risk;
    if (dir === 'buy') { stop = Math.min(z.bottom, ...since.map(c => c.l)) - buf; risk = price - stop; }
    else { stop = Math.max(z.top, ...since.map(c => c.h)) + buf; risk = stop - price; }
    let widened = false;
    const minRisk = P.minStop * atr5;
    if (risk < minRisk) { widened = true; risk = minRisk; stop = dir === 'buy' ? price - risk : price + risk; }
    if (risk > 0) {
      const tz = zones.filter(q => q.kind !== dir && !q.broken && (q.tf !== '5m' || P.use5mTargets) &&
        (dir === 'buy' ? q.bottom > price : q.top < price));
      tz.sort((a, b) => dir === 'buy' ? a.bottom - b.bottom : b.top - a.top);
      let target, tInfo, fallback = false;
      if (tz[0]) { target = dir === 'buy' ? tz[0].bottom : tz[0].top; tInfo = `${zoneName(tz[0])} (${zoneRange(tz[0])})`; }
      else { target = dir === 'buy' ? price + 2 * risk : price - 2 * risk; fallback = true; tInfo = `Referencia de 2 a 1: no hay zonas ${dir === 'buy' ? 'por encima' : 'por debajo'}`; }
      const rr = Math.abs(target - price) / risk;
      plan = { dir, entry: price, stop, target, rr, risk, riskPct: risk / price * 100, tInfo, fallback, widened, zone: z, type: cand.type, confTime: c5[j].t };
      plan.grade = gradeSignal(plan, z, cand.type);
    }
  }
  out.cand = cand; out.plan = plan;

  const checks = [];
  checks.push({ label: tLabel, status: 'ok', detail: trendDetail });
  checks.push(zs.length
    ? { label: `Zona de ${word} vigente`, status: 'ok', detail: `${zs.length} vigente${zs.length > 1 ? 's' : ''} entre 15m, 5m y el rango principal.` }
    : { label: `Zona de ${word} vigente`, status: 'fail', detail: `No hay zonas de ${word} vigentes.` });
  const near = out.nearest;
  const inZone = !!(cand || alertZone);
  checks.push(!zs.length ? NA('Precio en la zona')
    : inZone ? { label: 'Precio en la zona', status: 'ok', detail: `Tocando la ${zoneName((cand && cand.z) || alertZone)} (${zoneRange((cand && cand.z) || alertZone)}).` }
    : { label: 'Precio en la zona', status: 'fail', detail: `A ${fmt(near.dist)} (${nf2.format(near.dist / price * 100)}%) de la ${zoneName(near)}.` });
  checks.push(!inZone ? NA('Vela de confirmación', 'Se busca cuando el precio toca la zona.')
    : cand ? { label: 'Vela de confirmación', status: 'ok', detail: `${cand.type[0].toUpperCase() + cand.type.slice(1)} en 5m, vela de las ${hhmm(c5[cand.j].t)}.` }
    : { label: 'Vela de confirmación', status: 'fail', detail: dir === 'buy' ? 'Todavía no hay martillo, envolvente alcista ni cierre por encima de la zona.' : 'Todavía no hay martillo invertido, envolvente bajista ni cierre por debajo de la zona.' });
  checks.push(!plan ? NA('Riesgo y beneficio', 'Se calcula cuando hay confirmación.')
    : plan.fallback && plan.rr >= P.minRR ? { label: 'Riesgo y beneficio', status: 'warn', detail: `No hay ${dir === 'buy' ? 'zona de venta por encima' : 'zona de compra por debajo'}: se usa una referencia de 2 a 1. No es un nivel del mercado, así que el objetivo es incierto.` }
    : plan.rr >= P.minRR ? { label: 'Riesgo y beneficio', status: 'ok', detail: `1 a ${nf2.format(plan.rr)} (mínimo 1 a ${nf2.format(P.minRR)}).` }
    : { label: 'Riesgo y beneficio', status: 'fail', detail: `1 a ${nf2.format(plan.rr)}, menor al mínimo de 1 a ${nf2.format(P.minRR)}: poco recorrido.` });
  out.checks = checks;

  // estado y explicación
  if (plan && plan.rr >= P.minRR) {
    out.state = dir;
    out.why = `La tendencia en 1 hora es ${trendWord} y el precio tocó la ${zoneName(cand.z)}, donde apareció ${cand.type}. Es una entrada a favor de la tendencia.`;
    out.next = dir === 'buy'
      ? 'Si una vela de 5m cierra por debajo del stop, la idea queda invalidada. La decisión final es tuya.'
      : 'Si una vela de 5m cierra por encima del stop, la idea queda invalidada. La decisión final es tuya.';
  } else if (plan) {
    out.state = 'wait';
    out.why = `Hay ${cand.type} en la ${zoneName(cand.z)}, pero el objetivo más cercano da una relación de 1 a ${nf2.format(plan.rr)}, menor al mínimo de 1 a ${nf2.format(P.minRR)}. Hay poco recorrido hasta ${plan.fallback ? 'el objetivo de referencia' : 'la ' + plan.tInfo.split(' (')[0]}.`;
    out.next = 'Conviene esperar un punto de entrada con más recorrido hasta el objetivo.';
  } else if (alertZone) {
    out.state = 'alert'; out.alertZone = alertZone;
    out.why = `La tendencia en 1 hora es ${trendWord} y el precio está en la ${zoneName(alertZone)} (${zoneRange(alertZone)}). Falta la confirmación para entrar.`;
    out.next = dir === 'buy'
      ? 'Se necesita un martillo, una envolvente alcista o un cierre de 5m por encima de la zona.'
      : 'Se necesita un martillo invertido, una envolvente bajista o un cierre de 5m por debajo de la zona.';
  } else if (near) {
    const far = near.dist > 2 * A.atr15;
    out.why = `La tendencia en 1 hora es ${trendWord}, pero el precio todavía no llegó a una zona de ${word}. La más cercana es la ${zoneName(near)} (${zoneRange(near)}), a ${fmt(near.dist)} del precio.`;
    out.next = far
      ? 'Está lejos de las zonas. En tendencias fuertes el precio puede no volver a ellas (el libro lo llama punto de interés): no conviene perseguirlo.'
      : `Cuando toque la zona y aparezca ${dir === 'buy' ? 'un martillo, una envolvente alcista o un cierre por encima' : 'un martillo invertido, una envolvente bajista o un cierre por debajo'}, habrá señal.`;
  } else {
    out.why = `La tendencia en 1 hora es ${trendWord}, pero no hay zonas de ${word} vigentes.`;
    out.next = 'Cuando el precio arme una zona nueva (se detiene, la segunda vela no rompe el extremo y hay un rebote), la app la va a marcar.';
  }
  return out;
}


/* ============================================================
   Formato
   ============================================================ */
const nf2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const nf5 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
const fmt = x => isFinite(x) ? nf2.format(x) : '—';
const hhmm = t => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
const dt = t => new Date(t).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


/* ============================================================
   Análisis (mismo criterio que la página)
   ============================================================ */
function runAnalysis(data, P) {
  const r5 = data['5m'], r15 = data['15m'], r1h = data['1h'];
  if (r5.length < 60 || r15.length < 60 || r1h.length < 120) return null;
  const c5 = r5.slice(0, -1), c15 = r15.slice(0, -1), c1h = r1h.slice(0, -1);
  const live = lastOf(r5), price = live.c;
  const stale = Date.now() - live.t > 2 * TF['5m'].ms + 60000;
  const at5 = atr(c5), at15 = atr(c15), at1h = atr(c1h);
  const atr5 = lastOf(at5), atr15 = lastOf(at15), atr1h = lastOf(at1h);
  const trend = analyzeTrend(c1h, P);
  const z15 = detectZones(c15, '15m', at15, P);
  const z5 = detectZones(c5, '5m', at5, P);
  for (const a of z5) for (const b of z15) if (a.kind === b.kind && a.bottom <= b.top && a.top >= b.bottom) { a.conf = true; b.conf = true; }
  const rng = principalRange(c1h, atr1h, P);
  const zones = [...z15, ...z5, rng.support, rng.resistance];
  const lastC = lastOf(c5);
  for (const z of zones) {
    z.score = scoreZone(z);
    z.broken = z.kind === 'buy' ? lastC.c < z.bottom : lastC.c > z.top;
    z.dist = price >= z.bottom && price <= z.top ? 0 : (price > z.top ? price - z.top : z.bottom - price);
  }
  const A = { trend, zones, c5, c15, c1h, live, price, atr5, atr15, atr1h, rng, stale };
  A.signal = stale ? { state: 'wait', why: 'Datos desactualizados' } : evaluateSignal(A, P);
  return A;
}

/* ============================================================
   Mensajes y envío a Telegram
   ============================================================ */
const GRADE_RANK = { A: 3, B: 2, C: 1 };
const BA_TZ = 'America/Argentina/Buenos_Aires';
function baNow() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: BA_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const o = {}; for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: (+o.hour) % 24 };
}
function whenBA() { return new Date().toLocaleString('es-AR', { timeZone: BA_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function buildMessage(A, srcInfo) {
  const sig = A.signal, p = sig.plan, buy = sig.state === 'buy';
  return [
    `${buy ? '🟢 COMPRA' : '🔴 VENTA'} BTC, calidad ${p.grade}`,
    '',
    `Entrada de referencia: ${fmt(p.entry)}`,
    `Stop: ${fmt(p.stop)}`,
    `Objetivo: ${fmt(p.target)} (riesgo y beneficio 1 a ${nf2.format(p.rr)}${p.fallback ? ', objetivo de referencia' : ''})`,
    '',
    `Por qué: ${sig.why}`,
    p.fallback ? 'Ojo: no hay ninguna zona por delante, el objetivo es solo una referencia.' : '',
    '',
    `Fuente: ${srcInfo.name}, precio en ${srcInfo.quote}. ${whenBA()}, hora de Buenos Aires.`,
    'Herramienta de apoyo, no consejo financiero: la decisión es tuya.'
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i !== a.length - 1)).join('\n');
}
function buildAlert(A) {
  const sig = A.signal, z = sig.alertZone, buy = sig.dir === 'buy';
  return [
    `⚠️ ALERTA de ${buy ? 'compra' : 'venta'} en BTC (todavía NO es señal)`,
    '',
    `El precio (${fmt(A.price)}) está en la ${zoneName(z)} (${zoneRange(z)}).`,
    `Falta la confirmación: ${buy ? 'martillo, envolvente alcista o cierre de 5m por encima de la zona' : 'martillo invertido, envolvente bajista o cierre de 5m por debajo de la zona'}.`,
    '',
    `No hagas nada todavía. Si se confirma, te aviso como señal de ${buy ? 'COMPRA' : 'VENTA'}.`
  ].join('\n');
}
function buildStatus(A, srcInfo, state) {
  const trend = { up: 'alcista', down: 'bajista', none: 'sin tendencia clara' }[A.trend.dir];
  const word = { buy: 'hay una señal de compra', sell: 'hay una señal de venta', alert: 'hay una alerta (falta confirmación)', wait: 'no hay señal' }[A.signal.state] || 'sin señal';
  const since = Date.now() - 24 * 3600 * 1000;
  const rec = (state.log || []).filter(e => e.t >= since);
  return [
    '✅ Sigo activo y revisando el mercado.',
    `BTC: ${fmt(A.price)} (${srcInfo.name}, ${srcInfo.quote}).`,
    `Tendencia en 1 hora: ${trend}.`,
    `Ahora ${word}. ${A.signal.why}`,
    `Últimas 24 horas: ${rec.filter(e => e.type === 'signal').length} señales y ${rec.filter(e => e.type === 'alert').length} alertas enviadas.`
  ].join('\n');
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
  if (!token || !chat) throw new Error('Faltan los secrets del bot (token o chat id). Revisá los nombres en Settings > Secrets.');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Telegram rechazó el mensaje: ' + (j.description || r.status));
}

/* ============================================================
   Ejecución
   ============================================================ */
const STATE_FILE = 'signal-state.json';
const ORDER = ['binance-vision', 'okx', 'coinbase', 'kraken', 'bybit', 'binance']; // las IPs de GitHub están en EE.UU.: api.binance.com suele bloquearlas
async function loadData() {
  const errors = {};
  for (const id of ORDER) {
    const src = SOURCES.find(s => s.id === id);
    try {
      const res = await Promise.all(TFS.map(tf => fetchKlines(src, tf)));
      return { src, data: { '5m': res[0], '15m': res[1], '1h': res[2] } };
    } catch (e) { errors[id] = String(e.message || e); console.log(`Fuente ${id} falló: ${errors[id]}`); }
  }
  throw new Error('Ninguna fuente de precios respondió: ' + JSON.stringify(errors));
}
async function main() {
  const dry = process.env.DRY_RUN === '1';
  const out = async text => { if (dry) console.log('--- DRY RUN ---\n' + text + '\n'); else await sendTelegram(text); };
  const P = { ...DEFAULTS, fresh: 4 }; // 4 velas de 5m de vigencia: tolera demoras del cron de GitHub
  const minGrade = (process.env.MIN_GRADE || 'B').toUpperCase();

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* primera vez */ }
  state.sent = state.sent || []; state.alertIds = state.alertIds || []; state.log = state.log || [];

  const { src, data } = await loadData();
  const A = runAnalysis(data, P);
  if (!A) throw new Error('No hay suficientes velas para analizar');
  const sig = A.signal;
  console.log(`Fuente ${src.name}. Precio ${fmt(A.price)}. Tendencia 1h: ${A.trend.dir}. Estado: ${sig.state}.`);
  console.log(`Motivo: ${sig.why}`);

  if (process.env.TEST_MESSAGE === 'true') {
    await out('✅ Prueba: el revisor de señales de La Visión del Precio está conectado a este grupo.');
    await out(buildStatus(A, src, state));
    console.log('Mensajes de prueba enviados.'); return;
  }

  let changed = false; const nowMs = Date.now();
  const note = type => { state.log.push({ t: nowMs, type }); state.log = state.log.slice(-100); changed = true; };

  if (sig.state === 'buy' || sig.state === 'sell') {
    const id = `${sig.state}|${sig.cand.z.id}|${A.c5[sig.cand.j].t}`;
    if (state.sent.includes(id)) console.log('Esa señal ya se avisó.');
    else if (GRADE_RANK[sig.plan.grade] < (GRADE_RANK[minGrade] || 2)) console.log(`Señal de calidad ${sig.plan.grade}, por debajo del mínimo ${minGrade}: no se avisa.`);
    else { await out(buildMessage(A, src)); state.sent = [...state.sent, id].slice(-60); note('signal'); console.log('Señal enviada a Telegram.'); }
  } else if (sig.state === 'alert' && sig.alertZone && process.env.SEND_ALERTS !== '0') {
    const id = `alert|${sig.dir}|${sig.alertZone.id}`;
    if (state.alertIds.includes(id)) console.log('Esa alerta ya se avisó.');
    else if ((sig.alertZone.score || 1) < 2) console.log('Alerta en una zona débil: no se avisa.');
    else if (nowMs - (state.lastAlertAt || 0) < 60 * 60000) console.log('Ya hubo una alerta hace menos de 1 hora: no se avisa.');
    else { await out(buildAlert(A)); state.alertIds = [...state.alertIds, id].slice(-60); state.lastAlertAt = nowMs; note('alert'); console.log('Alerta enviada a Telegram.'); }
  } else console.log('Sin señal.');

  const ba = baNow();
  if (process.env.DAILY_STATUS !== '0' && ba.hour >= 9 && state.lastStatus !== ba.date) {
    await out(buildStatus(A, src, state)); state.lastStatus = ba.date; changed = true; console.log('Estado diario enviado.');
  }
  if (changed && !dry) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
if (require.main === module) main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
module.exports = { runAnalysis, buildMessage, DEFAULTS, TF };
