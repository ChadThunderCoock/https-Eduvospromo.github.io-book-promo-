import React, { useEffect, useRef, useState } from "react";

/**
 * Forex / Synthetic Paper Trader — single-file React artifact.
 *
 * Self-contained: no backend, no external data, no localStorage (so it runs
 * in sandboxed artifact environments). Prices are simulated. The
 * "Volatility 100 Index" is a Deriv/MT5-style synthetic: pure multiplicative
 * random walk, no mean reversion, high constant volatility, traded 24/7.
 */

const STARTING_BALANCE = 100000;
const LEVERAGE = 100;
const DEFAULT_CONTRACT = 100000;
const TICK_MS = 1000;
const MAX_POINTS = 120;

const PAIRS = {
  "EUR/USD": { price: 1.085, spread: 0.00012, vol: 0.00035, quote: "USD" },
  "GBP/USD": { price: 1.27, spread: 0.00018, vol: 0.00045, quote: "USD" },
  "USD/JPY": { price: 151.5, spread: 0.015, vol: 0.045, quote: "JPY", digits: 3 },
  "AUD/USD": { price: 0.662, spread: 0.00015, vol: 0.0003, quote: "USD" },
  "USD/CHF": { price: 0.904, spread: 0.00016, vol: 0.0003, quote: "CHF" },
  "USD/CAD": { price: 1.365, spread: 0.00018, vol: 0.00032, quote: "CAD" },
  "Volatility 100 Index": {
    price: 1200, spread: 0.1, vol: 0.012, quote: "USD",
    synthetic: true, contractSize: 100, digits: 2,
  },
};

const digitsOf = (p) => PAIRS[p].digits ?? (PAIRS[p].quote === "JPY" ? 3 : 5);
const contractOf = (p) => PAIRS[p].contractSize || DEFAULT_CONTRACT;
const fmtPrice = (p, v) => v.toFixed(digitsOf(p));
const fmtMoney = (n) =>
  (n < 0 ? "-" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function makeMarket() {
  const m = {};
  for (const [pair, cfg] of Object.entries(PAIRS)) {
    m[pair] = {
      mid: cfg.price,
      prev: cfg.price,
      bid: cfg.price - cfg.spread / 2,
      ask: cfg.price + cfg.spread / 2,
      series: [cfg.price],
    };
  }
  return m;
}

function stepMarket(m) {
  for (const [pair, cfg] of Object.entries(PAIRS)) {
    const s = m[pair];
    s.prev = s.mid;
    let mid;
    if (cfg.synthetic) {
      mid = s.mid * (1 + (Math.random() - 0.5) * 2 * cfg.vol);
    } else {
      const drift = (cfg.price - s.mid) * 0.01;
      mid = s.mid + drift + (Math.random() - 0.5) * 2 * cfg.vol;
    }
    if (mid <= 0) mid = cfg.price;
    s.mid = mid;
    s.bid = mid - cfg.spread / 2;
    s.ask = mid + cfg.spread / 2;
    s.series.push(mid);
    if (s.series.length > MAX_POINTS) s.series.shift();
  }
}

function positionPL(pos, m) {
  const cfg = PAIRS[pos.pair];
  const close = pos.side === "buy" ? m[pos.pair].bid : m[pos.pair].ask;
  const diff =
    pos.side === "buy" ? close - pos.openPrice : pos.openPrice - close;
  let pl = diff * pos.volume * contractOf(pos.pair);
  if (cfg.quote !== "USD") pl = pl / close;
  return pl;
}

function requiredMargin(pair, volume, m) {
  const cfg = PAIRS[pair];
  const notionalUsd =
    cfg.quote === "USD"
      ? volume * contractOf(pair) * m[pair].ask
      : volume * contractOf(pair);
  return notionalUsd / LEVERAGE;
}

function Chart({ pair, series }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const pad = 40;
    ctx.clearRect(0, 0, W, H);
    if (series.length < 2) return;
    let min = Math.min(...series);
    let max = Math.max(...series);
    if (min === max) {
      min -= 0.0005;
      max += 0.0005;
    }
    const range = max - min;
    const xStep = (W - pad * 2) / (series.length - 1);
    const y = (v) => H - pad - ((v - min) / range) * (H - pad * 2);

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px system-ui, sans-serif";
    for (let i = 0; i <= 4; i++) {
      const gy = pad + (i / 4) * (H - pad * 2);
      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(W - pad, gy);
      ctx.stroke();
      ctx.fillText((max - (i / 4) * range).toFixed(digitsOf(pair)), 2, gy + 3);
    }

    const first = series[0];
    const last = series[series.length - 1];
    ctx.strokeStyle = last >= first ? "#2ea043" : "#f85149";
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((v, i) => {
      const px = pad + i * xStep;
      const py = y(v);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = last >= first ? "#2ea043" : "#f85149";
    ctx.beginPath();
    ctx.arc(pad + (series.length - 1) * xStep, y(last), 3, 0, Math.PI * 2);
    ctx.fill();
  }, [pair, series]);

  return (
    <canvas
      ref={ref}
      width={640}
      height={280}
      className="w-full h-auto block"
    />
  );
}

export default function ForexPaperTrader() {
  const marketRef = useRef(makeMarket());
  const idRef = useRef(1);
  const [, setTick] = useState(0);
  const [balance, setBalance] = useState(STARTING_BALANCE);
  const [positions, setPositions] = useState([]);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState("EUR/USD");
  const [volume, setVolume] = useState(0.1);
  const [msg, setMsg] = useState({ text: "", kind: "" });

  useEffect(() => {
    const id = setInterval(() => {
      stepMarket(marketRef.current);
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  const m = marketRef.current;
  const openPL = positions.reduce((s, p) => s + positionPL(p, m), 0);
  const usedMargin = positions.reduce(
    (s, p) => s + requiredMargin(p.pair, p.volume, m),
    0
  );
  const equity = balance + openPL;
  const freeMargin = equity - usedMargin;

  function placeOrder(side) {
    const vol = parseFloat(volume);
    if (!(vol > 0)) {
      setMsg({ text: "Volume must be greater than 0.", kind: "error" });
      return;
    }
    const margin = requiredMargin(selected, vol, m);
    if (margin > freeMargin) {
      setMsg({
        text: `Not enough free margin. Need ${fmtMoney(
          margin
        )}, have ${fmtMoney(freeMargin)}.`,
        kind: "error",
      });
      return;
    }
    const openPrice = side === "buy" ? m[selected].ask : m[selected].bid;
    setPositions((ps) => [
      ...ps,
      {
        id: idRef.current++,
        pair: selected,
        side,
        volume: vol,
        openPrice,
        openTime: Date.now(),
      },
    ]);
    setMsg({
      text: `${side.toUpperCase()} ${vol} ${selected} @ ${fmtPrice(
        selected,
        openPrice
      )}`,
      kind: "ok",
    });
  }

  function closePosition(id) {
    setPositions((ps) => {
      const pos = ps.find((p) => p.id === id);
      if (!pos) return ps;
      const close = pos.side === "buy" ? m[pos.pair].bid : m[pos.pair].ask;
      const pl = positionPL(pos, m);
      setBalance((b) => b + pl);
      setHistory((h) => [
        {
          pair: pos.pair,
          side: pos.side,
          volume: pos.volume,
          openPrice: pos.openPrice,
          closePrice: close,
          pl,
          closeTime: Date.now(),
        },
        ...h,
      ]);
      return ps.filter((p) => p.id !== id);
    });
  }

  function reset() {
    setBalance(STARTING_BALANCE);
    setPositions([]);
    setHistory([]);
    setMsg({ text: "", kind: "" });
    idRef.current = 1;
  }

  const stat = (label, value, cls = "") => (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <span className={`font-semibold tabular-nums ${cls}`}>{value}</span>
    </div>
  );

  const plClass = (n) =>
    n > 0 ? "text-green-500" : n < 0 ? "text-red-500" : "";

  return (
    <div className="min-h-screen bg-[#0e1116] text-gray-100 text-sm font-sans">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 bg-[#161b22] border-b border-[#2a313c]">
        <h1 className="text-lg font-bold">Forex Paper Trader</h1>
        <div className="flex flex-wrap items-center gap-5">
          {stat("Balance", fmtMoney(balance))}
          {stat("Equity", fmtMoney(equity))}
          {stat("Used Margin", fmtMoney(usedMargin))}
          {stat("Free Margin", fmtMoney(freeMargin))}
          {stat("Open P/L", fmtMoney(openPL), plClass(openPL))}
          <button
            onClick={reset}
            className="border border-[#2a313c] text-gray-400 px-3 py-1.5 rounded-md hover:text-gray-100 hover:border-blue-400"
          >
            Reset
          </button>
        </div>
      </header>

      <main className="grid gap-4 p-5 lg:grid-cols-[1.1fr_1.6fr_1fr] items-start">
        <section className="bg-[#161b22] border border-[#2a313c] rounded-xl p-4">
          <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
            Market Watch
          </h2>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[11px] text-gray-400">
                <th className="text-left py-1.5">Pair</th>
                <th className="text-right py-1.5">Bid</th>
                <th className="text-right py-1.5">Ask</th>
                <th className="text-right py-1.5">Change</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(PAIRS).map((pair) => {
                const s = m[pair];
                const dir =
                  s.mid > s.prev
                    ? "text-green-500"
                    : s.mid < s.prev
                    ? "text-red-500"
                    : "";
                const chg =
                  ((s.mid - PAIRS[pair].price) / PAIRS[pair].price) * 100;
                return (
                  <tr
                    key={pair}
                    onClick={() => setSelected(pair)}
                    className={`cursor-pointer border-b border-[#2a313c]/50 hover:bg-blue-400/10 ${
                      pair === selected ? "bg-blue-400/15" : ""
                    }`}
                  >
                    <td className="text-left py-1.5">{pair}</td>
                    <td className={`text-right py-1.5 tabular-nums ${dir}`}>
                      {fmtPrice(pair, s.bid)}
                    </td>
                    <td className={`text-right py-1.5 tabular-nums ${dir}`}>
                      {fmtPrice(pair, s.ask)}
                    </td>
                    <td
                      className={`text-right py-1.5 tabular-nums ${plClass(
                        chg
                      )}`}
                    >
                      {chg >= 0 ? "+" : ""}
                      {chg.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="bg-[#161b22] border border-[#2a313c] rounded-xl p-4">
          <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
            {selected} — Price
          </h2>
          <Chart pair={selected} series={m[selected].series} />
        </section>

        <section className="bg-[#161b22] border border-[#2a313c] rounded-xl p-4">
          <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
            New Order
          </h2>
          <label className="block mb-2.5 text-xs text-gray-400">
            Pair
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full mt-1 p-2 bg-[#0e1116] border border-[#2a313c] rounded-md text-gray-100 text-sm"
            >
              {Object.keys(PAIRS).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="block mb-1 text-xs text-gray-400">
            Volume (lots)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              className="w-full mt-1 p-2 bg-[#0e1116] border border-[#2a313c] rounded-md text-gray-100 text-sm"
            />
          </label>
          <p className="text-[11px] text-gray-400 mt-1 mb-3">
            1 lot = {contractOf(selected).toLocaleString()} units. Leverage{" "}
            {LEVERAGE}:1.
            {PAIRS[selected].synthetic
              ? " Synthetic index — trades 24/7."
              : ""}
          </p>
          <div className="flex justify-between text-xs text-gray-400 mb-3">
            <span>
              Sell{" "}
              <strong className="text-gray-100 tabular-nums">
                {fmtPrice(selected, m[selected].bid)}
              </strong>
            </span>
            <span>
              Buy{" "}
              <strong className="text-gray-100 tabular-nums">
                {fmtPrice(selected, m[selected].ask)}
              </strong>
            </span>
          </div>
          <div className="flex gap-2.5">
            <button
              onClick={() => placeOrder("sell")}
              className="flex-1 py-2.5 rounded-md bg-red-600 text-white font-semibold hover:brightness-110"
            >
              Sell
            </button>
            <button
              onClick={() => placeOrder("buy")}
              className="flex-1 py-2.5 rounded-md bg-green-600 text-white font-semibold hover:brightness-110"
            >
              Buy
            </button>
          </div>
          <p
            className={`text-xs mt-2.5 min-h-[16px] ${
              msg.kind === "error"
                ? "text-red-500"
                : msg.kind === "ok"
                ? "text-green-500"
                : ""
            }`}
          >
            {msg.text}
          </p>
        </section>

        <section className="lg:col-span-3 bg-[#161b22] border border-[#2a313c] rounded-xl p-4">
          <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
            Open Positions
          </h2>
          {positions.length === 0 ? (
            <p className="text-gray-400 text-xs text-center py-2">
              No open positions.
            </p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[11px] text-gray-400">
                  <th className="text-left py-1.5">Pair</th>
                  <th className="text-left py-1.5">Side</th>
                  <th className="text-right py-1.5">Vol</th>
                  <th className="text-right py-1.5">Open</th>
                  <th className="text-right py-1.5">Current</th>
                  <th className="text-right py-1.5">P/L</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const cur =
                    pos.side === "buy"
                      ? m[pos.pair].bid
                      : m[pos.pair].ask;
                  const pl = positionPL(pos, m);
                  return (
                    <tr
                      key={pos.id}
                      className="border-b border-[#2a313c]/50"
                    >
                      <td className="text-left py-1.5">{pos.pair}</td>
                      <td
                        className={`text-left py-1.5 ${
                          pos.side === "buy"
                            ? "text-green-500"
                            : "text-red-500"
                        }`}
                      >
                        {pos.side.toUpperCase()}
                      </td>
                      <td className="text-right py-1.5 tabular-nums">
                        {pos.volume}
                      </td>
                      <td className="text-right py-1.5 tabular-nums">
                        {fmtPrice(pos.pair, pos.openPrice)}
                      </td>
                      <td className="text-right py-1.5 tabular-nums">
                        {fmtPrice(pos.pair, cur)}
                      </td>
                      <td
                        className={`text-right py-1.5 tabular-nums ${plClass(
                          pl
                        )}`}
                      >
                        {fmtMoney(pl)}
                      </td>
                      <td className="text-right py-1.5">
                        <button
                          onClick={() => closePosition(pos.id)}
                          className="border border-[#2a313c] text-gray-400 px-2.5 py-1 rounded hover:text-red-500 hover:border-red-500"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="lg:col-span-3 bg-[#161b22] border border-[#2a313c] rounded-xl p-4">
          <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-3">
            Trade History
          </h2>
          {history.length === 0 ? (
            <p className="text-gray-400 text-xs text-center py-2">
              No closed trades yet.
            </p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[11px] text-gray-400">
                  <th className="text-left py-1.5">Time</th>
                  <th className="text-left py-1.5">Pair</th>
                  <th className="text-left py-1.5">Side</th>
                  <th className="text-right py-1.5">Vol</th>
                  <th className="text-right py-1.5">Open</th>
                  <th className="text-right py-1.5">Close</th>
                  <th className="text-right py-1.5">P/L</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 50).map((h, i) => (
                  <tr key={i} className="border-b border-[#2a313c]/50">
                    <td className="text-left py-1.5">
                      {new Date(h.closeTime).toLocaleTimeString()}
                    </td>
                    <td className="text-left py-1.5">{h.pair}</td>
                    <td
                      className={`text-left py-1.5 ${
                        h.side === "buy"
                          ? "text-green-500"
                          : "text-red-500"
                      }`}
                    >
                      {h.side.toUpperCase()}
                    </td>
                    <td className="text-right py-1.5 tabular-nums">
                      {h.volume}
                    </td>
                    <td className="text-right py-1.5 tabular-nums">
                      {fmtPrice(h.pair, h.openPrice)}
                    </td>
                    <td className="text-right py-1.5 tabular-nums">
                      {fmtPrice(h.pair, h.closePrice)}
                    </td>
                    <td
                      className={`text-right py-1.5 tabular-nums ${plClass(
                        h.pl
                      )}`}
                    >
                      {fmtMoney(h.pl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>

      <footer className="text-center text-gray-400 text-[11px] p-4">
        Simulated prices for educational use only. No real money is involved.
      </footer>
    </div>
  );
}
