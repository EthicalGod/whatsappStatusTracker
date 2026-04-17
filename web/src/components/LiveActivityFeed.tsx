"use client";

import { useMemo } from "react";
import { PresenceUpdate } from "@/lib/socket";

interface Props {
  events: PresenceUpdate[];
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LiveActivityFeed({ events }: Props) {
  // Precompute per-contact online→offline durations so OFFLINE rows can show
  // "(Xs)" like the Python tracker. events is newest-first; walk it to pair
  // each OFFLINE with the most recent prior ONLINE for that contact.
  const durationByEventIdx = useMemo(() => {
    const map = new Map<number, number>();
    // Walk chronologically (oldest first) so we can track the open online per contact
    const openOnlineAt = new Map<string, number>();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const t = new Date(e.timestamp).getTime();
      if (e.status === "online") {
        openOnlineAt.set(e.contactId, t);
      } else {
        const startedAt = openOnlineAt.get(e.contactId);
        if (startedAt) {
          map.set(i, Math.max(0, Math.round((t - startedAt) / 1000)));
          openOnlineAt.delete(e.contactId);
        }
      }
    }
    return map;
  }, [events]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#F0F2F5]">
      <div className="px-4 sm:px-6 py-3 border-b border-[#E9EDEF] bg-white">
        <h2 className="text-sm font-semibold text-[#111B21]">Live Activity</h2>
        <p className="text-xs text-[#667781] mt-0.5">
          Every ONLINE / OFFLINE event across all tracked contacts, newest first.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3">
        {events.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[#667781] gap-3 px-6 text-center">
            <div className="w-16 h-16 rounded-full bg-[#E9EDEF] flex items-center justify-center">
              <svg className="w-8 h-8 text-[#667781]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <p className="text-sm">Waiting for activity...</p>
            <p className="text-xs opacity-75">
              Events appear here as tracked contacts come online or go offline.
            </p>
          </div>
        ) : (
          <ul className="font-mono text-sm space-y-1">
            {events.map((e, idx) => {
              const isOnline = e.status === "online";
              const durSecs = durationByEventIdx.get(idx);
              return (
                <li
                  key={`${e.contactId}-${e.timestamp}-${idx}`}
                  className="flex items-start gap-2 px-2 py-1 rounded hover:bg-white"
                >
                  <span
                    className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                      isOnline ? "bg-[#25D366]" : "bg-[#a0aeb6]"
                    }`}
                  />
                  <span className="text-[#667781] flex-shrink-0">
                    {formatTime(e.timestamp)}
                  </span>
                  <span className="text-[#111B21] font-semibold truncate">
                    [{e.name}]
                  </span>
                  <span
                    className={`font-bold ${
                      isOnline ? "text-[#128C7E]" : "text-[#667781]"
                    }`}
                  >
                    {isOnline ? "ONLINE" : "OFFLINE"}
                  </span>
                  {durSecs != null && (
                    <span className="text-[#667781]">  ({durSecs}s)</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
