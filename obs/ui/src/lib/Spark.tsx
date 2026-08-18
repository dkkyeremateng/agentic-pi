// A tiny inline sparkline for a 0..1 value series (oldest → newest).
export function Spark({
  values,
  color,
  w = 80,
  h = 20,
}: {
  values: number[];
  color: string;
  w?: number;
  h?: number;
}) {
  // a single point can't draw a line — show a centered dot at its value so the
  // row still reads (datasets/agents with one run)
  if (values.length === 1) {
    const cy = h - 2 - values[0] * (h - 4);
    return (
      <svg className="evspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <circle cx={w / 2} cy={cy} r="1.6" fill={color} />
      </svg>
    );
  }
  if (!values.length) return <svg className="evspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" />;
  const n = values.length;
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => h - 2 - v * (h - 4); // 0..1 → bottom..top
  const d = values.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="evspark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
