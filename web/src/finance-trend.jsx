import React, { useEffect, useId, useState } from "react";

const series = [
  { key: "incomeCents", label: "收入", color: "#077c68", dash: undefined },
  { key: "costCents", label: "成本", color: "#af5d12", dash: "5 3" },
  { key: "profitCents", label: "利润", color: "#505aca", dash: "2 2" },
];
const yuan = (v) =>
  v == null
    ? "—"
    : (v / 100).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export function FinanceTrend({ points = [] }) {
  const title = useId(),
    desc = useId();
  const [compact,setCompact]=useState(()=>window.matchMedia("(max-width: 480px)").matches);
  useEffect(()=>{
    const media=window.matchMedia("(max-width: 480px)");
    const change=()=>setCompact(media.matches);
    change();media.addEventListener("change",change);
    return ()=>media.removeEventListener("change",change);
  },[]);
  if (!points.length) return null;
  const width=compact ? 320 : 588;
  const plot = { left: compact ? 40 : 66, right: width-(compact?18:26), top: 14, bottom: 130 };
  const nums = points
    .flatMap((p) => series.map((s) => p[s.key]))
    .filter(Number.isFinite);
  const min = Math.min(0, ...nums),
    max = Math.max(0, ...nums);
  const magnitude = Math.max(max - min, 100),
    base = 10 ** Math.floor(Math.log10(magnitude / 3));
  const step =
    ([1, 2, 5, 10].find((k) => k * base >= magnitude / 3) || 10) * base;
  const lo = Math.floor(min / step) * step,
    hi = Math.max(lo + step, Math.ceil(max / step) * step);
  const x = (i) =>
    plot.left + (i * (plot.right - plot.left)) / Math.max(1, points.length - 1);
  const y = (v) =>
    plot.bottom - ((v - lo) * (plot.bottom - plot.top)) / (hi - lo);
  const ticks = Array.from(
    { length: Math.round((hi - lo) / step) + 1 },
    (_, i) => lo + i * step,
  );
  return (
    <section className="finance-trend" aria-label="近七日收支">
      <header>
        <div>
          <h3>近 7 日收支</h3>
          <small>
            {points[0].day} 至 {points.at(-1).day} · 元
          </small>
        </div>
        <div className="finance-trend-legend">
          {series.map((s) => (
            <span key={s.key}>
              <svg width="15" height="8" aria-hidden="true">
                <path
                  d="M0 4 H15"
                  stroke={s.color}
                  strokeWidth="2.5"
                  strokeDasharray={s.dash}
                />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      </header>
      <svg
        viewBox={`0 0 ${width} 161`}
        className="finance-trend-chart"
        role="img"
        aria-labelledby={title + " " + desc}
      >
        <title id={title}>近七日的收入、成本与利润</title>
        <desc id={desc}>
          以北京时间为准。无记录的日期留空，未完整采样用空心点表示；具体金额见下方明细。
        </desc>
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={plot.left}
              x2={plot.right}
              y1={y(v)}
              y2={y(v)}
              stroke={v === 0 ? "#a8b6c5" : "#e1e8ef"}
              strokeDasharray={v === 0 ? undefined : "3 3"}
            />
            <text x={plot.left - 9} y={y(v) + 4} textAnchor="end">
              {(v / 100).toLocaleString("zh-CN", {
                maximumFractionDigits: 2,
                notation: "compact",
              })}
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={p.day} x={x(i)} y="151" textAnchor="middle">
            {p.day.slice(5).replace("-", "/")}
          </text>
        ))}
        {series.map((s) => {
          let consecutive = false;
          const path = points
            .map((p, i) => {
              const v = p[s.key];
              if (!Number.isFinite(v)) {
                consecutive = false;
                return "";
              }
              const command = consecutive ? "L" : "M";
              consecutive = true;
              return command + x(i) + " " + y(v);
            })
            .join(" ");
          return (
            <g key={s.key}>
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth="2.4"
                strokeDasharray={s.dash}
                strokeLinejoin="round"
              />
              {points.map((p, i) =>
                Number.isFinite(p[s.key]) ? (
                  <circle
                    key={p.day}
                    cx={x(i)}
                    cy={y(p[s.key])}
                    r="3.5"
                    fill={p.complete ? s.color : "#fff"}
                    stroke={s.color}
                    strokeWidth="1.8"
                  >
                    <title>
                      {p.day} {s.label} ¥{yuan(p[s.key])}
                      {p.complete ? "" : "（采样未完整）"}
                    </title>
                  </circle>
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
      {!nums.length && (
        <p className="finance-trend-empty">这七天尚无日账记录。</p>
      )}
      <details>
        <summary>按日查看金额</summary>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              {series.map((s) => (
                <th key={s.key}>{s.label}（元）</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day}>
                <th scope="row">
                  {p.day.slice(5)}
                  {p.exists && !p.complete ? " *" : ""}
                </th>
                {series.map((s) => (
                  <td key={s.key}>{yuan(p[s.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <small>— 无记录或未知；* 采样未完整。</small>
      </details>
    </section>
  );
}
