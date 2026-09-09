import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { CyclePoint } from "@/lib/traffic-data";

function formatSaved(totalSeconds: number) {
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export function CycleChart({
  data,
  totalSaved,
  loading,
}: {
  data: CyclePoint[];
  totalSaved: number;
  loading: boolean;
}) {
  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Predicted waiting time per cycle</h2>
          <p className="text-xs text-muted-foreground">
            Modelled average wait per vehicle under the adaptive plan against the same demand run on
            a fixed 30s / 120s plan.
          </p>
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-signal-low/40 bg-signal-low/10 px-3 py-1 text-xs font-medium text-signal-low transition-data">
          <TrendingDown className="h-3.5 w-3.5" />
          <span className="numeric">{formatSaved(totalSaved)}</span> vehicle-waiting avoided
        </span>
      </div>


      <div className="mt-4 h-[240px]">
        {loading ? (
          <Skeleton className="h-full w-full rounded-lg" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barGap={2}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="cycle_number"
                stroke="var(--muted-foreground)"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                tickFormatter={(v: number) => `#${v}`}
              />
              <YAxis
                stroke="var(--muted-foreground)"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={34}
                unit="s"
              />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "var(--foreground)",
                }}
                labelFormatter={(v) => `Cycle #${v}`}
                formatter={(value: number, name: string) => [`${value}s`, name]}
              />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
              <Bar
                dataKey="fixed_sec"
                name="Fixed baseline"
                fill="var(--baseline)"
                radius={[3, 3, 0, 0]}
                animationDuration={350}
              />
              <Bar
                dataKey="adaptive_sec"
                name="Adaptive allocation"
                fill="var(--primary)"
                radius={[3, 3, 0, 0]}
                animationDuration={350}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
