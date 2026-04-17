"use client";

import { Session } from "@/lib/api";
import { formatDuration, formatTime12h } from "@/lib/utils";

interface Props {
  sessions: Session[];
}

export function SessionTimeline({ sessions }: Props) {
  if (sessions.length === 0) {
    return (
      <p className="text-[#667781] text-sm text-center py-8">
        No sessions recorded yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => {
        const isActive = !session.end_time;
        const duration = isActive
          ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000)
          : session.duration_s || 0;

        return (
          <div
            key={session.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg ${
              isActive ? "bg-[#DCF8C6]" : "bg-white"
            }`}
          >
            {/* Timeline dot */}
            <div className="flex flex-col items-center">
              <div
                className={`w-3 h-3 rounded-full ${
                  isActive ? "bg-[#25D366] animate-pulse" : "bg-[#128C7E]"
                }`}
              />
            </div>

            {/* Time range */}
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-[#111B21]">
                  {formatTime12h(session.start_time)}
                </span>
                <span className="text-[#667781]">→</span>
                <span className="font-medium text-[#111B21]">
                  {isActive ? "Now" : formatTime12h(session.end_time!)}
                </span>
              </div>
              <p className="text-xs text-[#667781] mt-0.5">
                {new Date(session.start_time).toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </p>
            </div>

            {/* Duration badge */}
            <span
              className={`text-xs font-medium px-2 py-1 rounded-full ${
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
  );
}
