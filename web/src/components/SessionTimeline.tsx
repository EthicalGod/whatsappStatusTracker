"use client";

import { Session } from "@/lib/api";
import { formatDuration, formatTime12h } from "@/lib/utils";

interface Props {
  sessions: Session[];
}

/** Group sessions by local date (Monday, Apr 17, 2026) */
function groupByDate(sessions: Session[]) {
  const groups: Record<string, Session[]> = {};
  for (const s of sessions) {
    const date = new Date(s.start_time).toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    (groups[date] ??= []).push(s);
  }
  return groups;
}

export function SessionTimeline({ sessions }: Props) {
  if (sessions.length === 0) {
    return (
      <p className="text-[#667781] text-sm text-center py-8">
        No sessions recorded yet.
      </p>
    );
  }

  const grouped = groupByDate(sessions);

  return (
    <div className="space-y-5">
      {Object.entries(grouped).map(([date, dateSessions]) => {
        const totalSecs = dateSessions.reduce((sum, s) => {
          const d = s.end_time
            ? s.duration_s || 0
            : Math.floor((Date.now() - new Date(s.start_time).getTime()) / 1000);
          return sum + d;
        }, 0);

        return (
          <div key={date}>
            {/* Date header with daily summary */}
            <div className="flex items-center justify-between mb-2 sticky top-0 bg-white py-1 border-b border-[#E9EDEF]">
              <h4 className="text-xs font-semibold text-[#667781] uppercase tracking-wide">
                {date}
              </h4>
              <span className="text-xs text-[#667781]">
                {dateSessions.length} session{dateSessions.length > 1 ? "s" : ""}{" "}
                · {formatDuration(totalSecs)} total
              </span>
            </div>

            {/* Sessions for this date */}
            <div className="space-y-2 pt-2">
              {dateSessions.map((session) => {
                const isActive = !session.end_time;
                const duration = isActive
                  ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000)
                  : session.duration_s || 0;

                return (
                  <div
                    key={session.id}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg ${
                      isActive ? "bg-[#DCF8C6]" : "bg-white border border-[#E9EDEF]"
                    }`}
                  >
                    <div
                      className={`w-3 h-3 rounded-full flex-shrink-0 ${
                        isActive ? "bg-[#25D366] animate-pulse" : "bg-[#128C7E]"
                      }`}
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-semibold text-[#111B21]">
                          {formatTime12h(session.start_time)}
                        </span>
                        <span className="text-[#667781]">→</span>
                        <span className="font-semibold text-[#111B21]">
                          {isActive ? "Now (live)" : formatTime12h(session.end_time!)}
                        </span>
                      </div>
                      {isActive && (
                        <p className="text-xs text-[#128C7E] font-medium mt-0.5">
                          Currently online
                        </p>
                      )}
                    </div>

                    <span
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${
                        isActive
                          ? "bg-[#25D366] text-white"
                          : "bg-[#E9EDEF] text-[#111B21]"
                      }`}
                    >
                      {formatDuration(duration)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
