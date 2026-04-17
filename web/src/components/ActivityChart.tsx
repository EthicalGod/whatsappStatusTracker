"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { DailyStat } from "@/lib/api";

interface Props {
  data: DailyStat[];
}

function CustomTooltip(props: any) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  const minutes = payload[0].value as number;
  const sessions = payload[0].payload.sessions as number;

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return (
    <div className="bg-white px-3 py-2 rounded-lg shadow-lg border border-[#E9EDEF]">
      <p className="text-xs font-semibold text-[#111B21] mb-1">{label}</p>
      <div className="flex items-center gap-2 text-xs">
        <span className="w-2 h-2 rounded-full bg-[#25D366]" />
        <span className="text-[#667781]">Online:</span>
        <span className="font-semibold text-[#111B21]">{timeStr}</span>
      </div>
      <div className="flex items-center gap-2 text-xs mt-0.5">
        <span className="w-2 h-2 rounded-full bg-[#128C7E]" />
        <span className="text-[#667781]">Sessions:</span>
        <span className="font-semibold text-[#111B21]">{sessions}</span>
      </div>
    </div>
  );
}

export function ActivityChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-[#667781]">
        <svg
          className="w-12 h-12 opacity-40 mb-2"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
          />
        </svg>
        <p className="text-sm">No activity data yet</p>
        <p className="text-xs mt-0.5 opacity-75">
          Daily stats appear after the contact comes online
        </p>
      </div>
    );
  }

  const chartData = [...data].reverse().map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    minutes: Math.round(d.total_online_s / 60),
    sessions: d.session_count,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        {/* Gradient fill under the line */}
        <defs>
          <linearGradient id="onlineGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#25D366" stopOpacity={0.4} />
            <stop offset="100%" stopColor="#25D366" stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#E9EDEF" vertical={false} />

        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: "#667781" }}
          tickLine={false}
          axisLine={{ stroke: "#E9EDEF" }}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#667781" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => {
            if (v >= 60) return `${Math.round(v / 60)}h`;
            return `${v}m`;
          }}
        />

        <Tooltip
          content={<CustomTooltip />}
          cursor={{ stroke: "#25D366", strokeWidth: 1, strokeDasharray: "3 3" }}
        />

        <Area
          type="monotone"
          dataKey="minutes"
          stroke="#25D366"
          strokeWidth={2.5}
          fill="url(#onlineGradient)"
          dot={{ r: 3, fill: "#25D366", stroke: "#fff", strokeWidth: 2 }}
          activeDot={{ r: 5, fill: "#128C7E", stroke: "#fff", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
