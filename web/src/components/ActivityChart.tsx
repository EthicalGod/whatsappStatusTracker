"use client";

import {
  BarChart,
  Bar,
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

export function ActivityChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <p className="text-[#667781] text-sm text-center py-8">
        No activity data yet.
      </p>
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
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E9EDEF" />
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
          label={{
            value: "Minutes Online",
            angle: -90,
            position: "insideLeft",
            style: { fontSize: 11, fill: "#667781" },
          }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#fff",
            border: "1px solid #E9EDEF",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(value, name) => {
            if (name === "minutes") return [`${value} min`, "Online Time"];
            return [`${value}`, "Sessions"];
          }}
        />
        <Bar dataKey="minutes" fill="#25D366" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
