"use client";

import { useMemo } from "react";
import { PresenceUpdate } from "@/lib/socket";

interface Props {
  events: PresenceUpdate[];
  /** Optional — shown as a back arrow at mobile widths only. */
  onBack?: () => void;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LiveActivityFeed({ events, onBack }: Props) {
  // Precompute per-contact online→offline durations so OFFLINE rows can show
  // "(Xs)" like the Python tracker. events is newest-first; walk it to pair
  // each OFFLINE with the most recent prior ONLINE for that contact.
  const durationByEventIdx = useMemo(() => {
    const map = new Map<number, number>();
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
      <div className="px-3 sm:px-6 py-3 border-b border-[#E9EDEF] bg-white flex items-center gap-2">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back to contacts"
            className="md:hidden -ml-1 p-1.5 rounded-full hover:bg-[#F0F2F5]"
          >
            <svg className="w-5 h-5 text-[#111B21]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-[#111B21]">Live Activity</h2>
          <p className="text-xs text-[#667781] mt-0.5 hidden sm:block">
            Every ONLINE / OFFLINE event across all tracked contacts, newest first.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 sm:px-6 py-2 sm:py-3">
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
          <ul className="space-y-1 sm:space-y-1.5">
            {events.map((e, idx) => {
              const isOnline = e.status === "online";
              const durSecs = durationByEventIdx.get(idx);
              return (
                <li
                  key={`${e.contactId}-${e.timestamp}-${idx}`}
                  className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-lg bg-white sm:bg-transparent border border-[#E9EDEF] sm:border-0 sm:hover:bg-white"
                >
                  {/* Status dot */}
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      isOnline ? "bg-[#25D366]" : "bg-[#a0aeb6]"
                    }`}
                  />

                  {/* Name + status line (truncates on tight screens) */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[#111B21] font-semibold text-sm truncate">
                        {e.name}
                      </span>
                      <span
                        className={`text-[10px] sm:text-xs font-bold uppercase tracking-wide flex-shrink-0 ${
                          isOnline ? "text-[#128C7E]" : "text-[#667781]"
                        }`}
                      >
                        {isOnline ? "Online" : "Offline"}
                      </span>
                    </div>
                    {!isOnline && durSecs != null && (
                      <p className="text-[11px] text-[#667781] mt-0.5">
                        was online for {durSecs}s
                      </p>
                    )}
                  </div>

                  {/* Time (right-aligned, monospace for easy scanning) */}
                  <span className="text-[11px] sm:text-xs text-[#667781] font-mono tabular-nums flex-shrink-0">
                    {formatTime(e.timestamp)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
