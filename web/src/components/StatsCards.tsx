"use client";

import { Analytics } from "@/lib/api";

interface Props {
  analytics: Analytics | null;
}

export function StatsCards({ analytics }: Props) {
  if (!analytics) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-lg p-4 animate-pulse">
            <div className="h-3 bg-[#E9EDEF] rounded w-20 mb-2" />
            <div className="h-6 bg-[#E9EDEF] rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  const { summary } = analytics;
  const cards = [
    {
      label: "Total Online",
      value: `${summary.totalOnlineHours}h`,
      sub: `${summary.daysTracked} days tracked`,
      color: "#25D366",
    },
    {
      label: "Total Sessions",
      value: summary.totalSessions.toString(),
      sub: `${summary.avgSessionsPerDay}/day avg`,
      color: "#128C7E",
    },
    {
      label: "Avg Daily",
      value: `${summary.avgDailyOnlineMinutes}m`,
      sub: "online per day",
      color: "#075E54",
    },
    {
      label: "Days Tracked",
      value: summary.daysTracked.toString(),
      sub: "with activity",
      color: "#667781",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="bg-white rounded-lg p-4 border border-[#E9EDEF]">
          <p className="text-xs text-[#667781] font-medium uppercase tracking-wide">
            {card.label}
          </p>
          <p className="text-2xl font-bold mt-1" style={{ color: card.color }}>
            {card.value}
          </p>
          <p className="text-xs text-[#667781] mt-1">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}
