"use strict";

/* ---------- Configuration ---------- */

const STARTING_BALANCE = 100000;
const LEVERAGE = 100;
const CONTRACT_SIZE = 100000; // units per lot
const TICK_MS = 1000;
const MAX_HISTORY_POINTS = 120;
const STORAGE_KEY = "fx-paper-trader-v1";

// base price, typical spread (in price terms), pip size, volatility per tick
const PAIRS = {
  "EUR/USD": { price: 1.08500, spread: 0.00012, pip: 0.0001, vol: 0.00035, quote: "USD" },
  "GBP/USD": { price: 1.27000, spread: 0.00018, pip: 0.0001, vol: 0.00045, quote: "USD" },
  "USD/JPY": { price: 151.500, spread: 0.015,   pip: 0.01,   vol: 0.045,   quote: "JPY" },
  "AUD/USD": { price: 0.66200, spread: 0.00015, pip: 0.0001, vol: 0.00030, quote: "USD" },
  "USD/CHF": { price: 0.90400, spread: 0.00016, pip: 0.0001, vol: 0.00030, quote: "USD" },
  "USD/CAD": { price: 1.36500, spread: 0.00018, pip: 0.0001, vol: 0.00032, quote: "CAD" },
  // Deriv-style synthetic index (MT5): no mean reversion, high constant
  // volatility, multiplicative random walk, traded 24/7.
  "Volatility 100 Index": {
    price: 1200.00, spread: 0.10, pip: 0.01, vol: 0.012, quote: "USD",
    synthetic: true, contractSize: 100, digits: 2,
  },
};

/* ---------- State ---------- */

let state = {
  balance: STARTING_BALANCE,
  positions: [], // {id, pair, side, volume, openPrice, openTime}
  history: [],   // {pair, side, volume, openPrice, closePrice, pl, closeTime}
  nextId: 1,
};

const market = {}; // pair -> {bid, ask, mid, prev, series:[]}
let selectedPair = "EUR/USD";

/* ---------- Persistence ---------- */

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    /* storage unavailable — run in-memory only */
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.balance === "number") {
      state = {
        balance: parsed.balance,
        positions: Array.isArray(parsed.positions) ? parsed.positions : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        nextId: parsed.nextId || 1,
      };
    }
  } catch (e) {
    /* corrupt data — start fresh */
  }
}

/* ---------- Price engine ---------- */

function initMarket() {
  for (const [pair, cfg] of Object.entries(PAIRS)) {
    const mid = cfg.price;
    market[pair] = {
      mid,
      bid: mid - cfg.spread / 2,
      ask: mid + cfg.spread / 2,
      prev: mid,
      series: [mid],
    };
  }
}

function tickPrices() {
  for (const [pair, cfg] of Object.entries(PAIRS)) {
    const m = market[pair];
    m.prev = m.mid;
    let mid;
    if (cfg.synthetic) {
      // Pure multiplicative random walk — synthetic indices do not revert.
      const shock = (Math.random() - 0.5) * 2 * cfg.vol;
      mid = m.mid * (1 + shock);
    } else {
      // Random walk with slight mean reversion toward the base price.
      const drift = (cfg.price - m.mid) * 0.01;
      const shock = (Math.random() - 0.5) * 2 * cfg.vol;
      mid = m.mid + drift + shock;
    }
    if (mid <= 0) mid = cfg.price;
    m.mid = mid;
    m.bid = mid - cfg.spread / 2;
    m.ask = mid + cfg.spread / 2;
    m.series.push(mid);
    if (m.series.length > MAX_HISTORY_POINTS) m.series.shift();
  }
}

/* ---------- Trading ---------- */

function priceDigits(pair) {
  const cfg = PAIRS[pair];
  if (cfg.digits != null) return cfg.digits;
  return cfg.quote === "JPY" ? 3 : 5;
}

function contractSize(pair) {
  return PAIRS[pair].contractSize || CONTRACT_SIZE;
}

function fmtPrice(pair, p) {
  return p.toFixed(priceDigits(pair));
}

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Profit/loss of a position in account currency (USD).
function positionPL(pos) {
  const m = market[pos.pair];
  const cfg = PAIRS[pos.pair];
  const closePrice = pos.side === "buy" ? m.bid : m.ask;
  const priceDiff = pos.side === "buy"
    ? closePrice - pos.openPrice
    : pos.openPrice - closePrice;
  const units = pos.volume * contractSize(pos.pair);
  let pl = priceDiff * units;
  // Convert to USD when the quote currency is not USD.
  if (cfg.quote !== "USD") {
    // pair is USD/XXX, so 1 USD = closePrice XXX -> divide by rate
    pl = pl / closePrice;
  }
  return pl;
}

function requiredMargin(pair, volume) {
  const m = market[pair];
  const cfg = PAIRS[pair];
  const notionalQuote = volume * contractSize(pair) * m.ask;
  // Notional expressed in USD.
  let notionalUsd;
  if (cfg.quote === "USD") {
    notionalUsd = notionalQuote; // e.g. EUR/USD: quote is USD
  } else {
    notionalUsd = volume * contractSize(pair); // base is USD (USD/XXX)
  }
  return notionalUsd / LEVERAGE;
}

function usedMargin() {
  return state.positions.reduce(
    (sum, p) => sum + requiredMargin(p.pair, p.volume), 0);
}

function openPL() {
  return state.positions.reduce((sum, p) => sum + positionPL(p), 0);
}

function equity() {
  return state.balance + openPL();
}

function openPosition(side) {
  const pair = selectedPair;
  const volume = parseFloat(document.getElementById("orderVolume").value);
  const msg = document.getElementById("orderMsg");

  if (!pair || !PAIRS[pair]) {
    return showMsg(msg, "Select a valid pair.", "error");
  }
  if (!(volume > 0)) {
    return showMsg(msg, "Volume must be greater than 0.", "error");
  }

  const margin = requiredMargin(pair, volume);
  const freeMargin = equity() - usedMargin();
  if (margin > freeMargin) {
    return showMsg(msg,
      `Not enough free margin. Need ${fmtMoney(margin)}, have ${fmtMoney(freeMargin)}.`,
      "error");
  }

  const m = market[pair];
  const openPrice = side === "buy" ? m.ask : m.bid;
  state.positions.push({
    id: state.nextId++,
    pair,
    side,
    volume,
    openPrice,
    openTime: Date.now(),
  });
  save();
  showMsg(msg,
    `${side.toUpperCase()} ${volume} ${pair} @ ${fmtPrice(pair, openPrice)}`,
    "ok");
  render();
}

function closePosition(id) {
  const idx = state.positions.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const pos = state.positions[idx];
  const m = market[pos.pair];
  const closePrice = pos.side === "buy" ? m.bid : m.ask;
  const pl = positionPL(pos);

  state.balance += pl;
  state.history.unshift({
    pair: pos.pair,
    side: pos.side,
    volume: pos.volume,
    openPrice: pos.openPrice,
    closePrice,
    pl,
    closeTime: Date.now(),
  });
  state.positions.splice(idx, 1);
  save();
  render();
}

function resetAccount() {
  if (!confirm("Reset account to the starting balance? This clears all positions and history.")) {
    return;
  }
  state = {
    balance: STARTING_BALANCE,
    positions: [],
    history: [],
    nextId: 1,
  };
  save();
  render();
}

/* ---------- Rendering ---------- */

function showMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg " + (kind || "");
}

function renderAccount() {
  const eq = equity();
  const um = usedMargin();
  const opl = openPL();
  document.getElementById("balance").textContent = fmtMoney(state.balance);
  document.getElementById("equity").textContent = fmtMoney(eq);
  document.getElementById("margin").textContent = fmtMoney(um);
  document.getElementById("freeMargin").textContent = fmtMoney(eq - um);
  const oplEl = document.getElementById("openPL");
  oplEl.textContent = fmtMoney(opl);
  oplEl.className = "value " + (opl > 0 ? "up" : opl < 0 ? "down" : "");
}

function renderQuotes() {
  const body = document.getElementById("quotesBody");
  body.innerHTML = "";
  for (const pair of Object.keys(PAIRS)) {
    const m = market[pair];
    const dir = m.mid > m.prev ? "up" : m.mid < m.prev ? "down" : "";
    const chg = ((m.mid - PAIRS[pair].price) / PAIRS[pair].price * 100);
    const tr = document.createElement("tr");
    if (pair === selectedPair) tr.className = "active";
    tr.innerHTML =
      `<td>${pair}</td>` +
      `<td class="${dir}">${fmtPrice(pair, m.bid)}</td>` +
      `<td class="${dir}">${fmtPrice(pair, m.ask)}</td>` +
      `<td class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</td>`;
    tr.addEventListener("click", () => {
      selectedPair = pair;
      document.getElementById("orderPair").value = pair;
      render();
    });
    body.appendChild(tr);
  }
}

function renderTicket() {
  const sel = document.getElementById("orderPair");
  if (!sel.options.length) {
    for (const pair of Object.keys(PAIRS)) {
      const opt = document.createElement("option");
      opt.value = pair;
      opt.textContent = pair;
      sel.appendChild(opt);
    }
    sel.value = selectedPair;
  }
  document.getElementById("ticketHint").textContent =
    `1 lot = ${contractSize(selectedPair).toLocaleString()} units. ` +
    `Leverage ${LEVERAGE}:1.` +
    (PAIRS[selectedPair].synthetic ? " Synthetic index — trades 24/7." : "");
  const m = market[selectedPair];
  document.getElementById("ticketBid").textContent = fmtPrice(selectedPair, m.bid);
  document.getElementById("ticketAsk").textContent = fmtPrice(selectedPair, m.ask);
}

function renderPositions() {
  const body = document.getElementById("positionsBody");
  const empty = document.getElementById("noPositions");
  body.innerHTML = "";
  empty.style.display = state.positions.length ? "none" : "block";
  for (const pos of state.positions) {
    const m = market[pos.pair];
    const cur = pos.side === "buy" ? m.bid : m.ask;
    const pl = positionPL(pos);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${pos.pair}</td>` +
      `<td class="${pos.side === "buy" ? "up" : "down"}">${pos.side.toUpperCase()}</td>` +
      `<td>${pos.volume}</td>` +
      `<td>${fmtPrice(pos.pair, pos.openPrice)}</td>` +
      `<td>${fmtPrice(pos.pair, cur)}</td>` +
      `<td class="${pl >= 0 ? "up" : "down"}">${fmtMoney(pl)}</td>` +
      `<td></td>`;
    const btn = document.createElement("button");
    btn.className = "close-btn";
    btn.textContent = "Close";
    btn.addEventListener("click", () => closePosition(pos.id));
    tr.lastChild.appendChild(btn);
    body.appendChild(tr);
  }
}

function renderHistory() {
  const body = document.getElementById("historyBody");
  const empty = document.getElementById("noHistory");
  body.innerHTML = "";
  empty.style.display = state.history.length ? "none" : "block";
  for (const h of state.history.slice(0, 50)) {
    const t = new Date(h.closeTime).toLocaleTimeString();
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${t}</td>` +
      `<td>${h.pair}</td>` +
      `<td class="${h.side === "buy" ? "up" : "down"}">${h.side.toUpperCase()}</td>` +
      `<td>${h.volume}</td>` +
      `<td>${fmtPrice(h.pair, h.openPrice)}</td>` +
      `<td>${fmtPrice(h.pair, h.closePrice)}</td>` +
      `<td class="${h.pl >= 0 ? "up" : "down"}">${fmtMoney(h.pl)}</td>`;
    body.appendChild(tr);
  }
}

function renderChart() {
  const canvas = document.getElementById("chart");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pad = 36;
  ctx.clearRect(0, 0, W, H);

  document.getElementById("chartTitle").textContent = selectedPair + " — Price";

  const series = market[selectedPair].series;
  if (series.length < 2) return;

  let min = Math.min(...series);
  let max = Math.max(...series);
  if (min === max) { min -= 0.0005; max += 0.0005; }
  const range = max - min;

  const xStep = (W - pad * 2) / (series.length - 1);
  const y = (v) => H - pad - ((v - min) / range) * (H - pad * 2);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8b949e";
  ctx.font = "11px system-ui, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const gy = pad + (i / 4) * (H - pad * 2);
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(W - pad, gy);
    ctx.stroke();
    const val = max - (i / 4) * range;
    ctx.fillText(val.toFixed(priceDigits(selectedPair)), 2, gy + 3);
  }

  // line
  const last = series[series.length - 1];
  const first = series[0];
  ctx.strokeStyle = last >= first ? "#2ea043" : "#f85149";
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((v, i) => {
    const px = pad + i * xStep;
    const py = y(v);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // last price dot
  ctx.fillStyle = last >= first ? "#2ea043" : "#f85149";
  ctx.beginPath();
  ctx.arc(pad + (series.length - 1) * xStep, y(last), 3, 0, Math.PI * 2);
  ctx.fill();
}

function render() {
  renderAccount();
  renderQuotes();
  renderTicket();
  renderPositions();
  renderHistory();
  renderChart();
}

/* ---------- Bootstrap ---------- */

function tick() {
  tickPrices();
  render();
}

function init() {
  load();
  initMarket();

  document.getElementById("buyBtn").addEventListener("click", () => openPosition("buy"));
  document.getElementById("sellBtn").addEventListener("click", () => openPosition("sell"));
  document.getElementById("resetBtn").addEventListener("click", resetAccount);
  document.getElementById("orderPair").addEventListener("change", (e) => {
    selectedPair = e.target.value;
    render();
  });

  render();
  setInterval(tick, TICK_MS);
}

document.addEventListener("DOMContentLoaded", init);
