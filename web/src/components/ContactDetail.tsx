"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { api, Contact, Analytics } from "@/lib/api";
import { getSocket, PresenceUpdate } from "@/lib/socket";
import { StatusDot } from "./StatusDot";
import { StatsCards } from "./StatsCards";
import { ActivityChart } from "./ActivityChart";
import { SessionTimeline } from "./SessionTimeline";
import { timeAgo } from "@/lib/utils";

interface Props {
  contactId: string;
  contact: Contact | null;
  onRemove: () => void;
}

export function ContactDetail({ contactId, contact, onRemove }: Props) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tab, setTab] = useState<"overview" | "sessions">("overview");
  const [removing, setRemoving] = useState(false);
  // Used to force live duration recalc every second while a session is open
  const [nowTick, setNowTick] = useState(Date.now());

  const loadAnalytics = useCallback(async () => {
    try {
      const data = await api.getAnalytics(contactId);
      setAnalytics(data);
    } catch {
      // will show empty state
    }
  }, [contactId]);

  // Initial load + refetch when contact changes
  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  // Refetch analytics when THIS contact's presence changes (online/offline).
  // The backend now awaits DB writes before firing the WS event, so 200 ms
  // is plenty of margin. A second retry at 1500 ms catches any edge-case
  // replication lag (e.g. separate read replica in future).
  useEffect(() => {
    const socket = getSocket();
    const handler = (update: PresenceUpdate) => {
      if (update.contactId !== contactId) return;

      const refresh = async () => {
        try {
          const data = await api.getAnalytics(contactId);
          setAnalytics(data);

          // If the contact just went offline but a session still looks "live"
          // (no end_time), refetch once more after a short delay.
          if (update.status === "offline") {
            const stillOpen = data.recentSessions.some((s) => !s.end_time);
            if (stillOpen) {
              setTimeout(loadAnalytics, 1500);
            }
          }
        } catch {
          // retry on next periodic refresh
        }
      };

      setTimeout(refresh, 200);
    };
    socket.on("presence:update", handler);
    return () => {
      socket.off("presence:update", handler);
    };
  }, [contactId, loadAnalytics]);

  // Periodic refresh while viewing this contact (catches stats from
  // in-progress sessions + hourly aggregation on the backend)
  useEffect(() => {
    const id = setInterval(loadAnalytics, 30_000);
    return () => clearInterval(id);
  }, [loadAnalytics]);

  // Tick every second while contact is online so live session duration updates
  useEffect(() => {
    if (contact?.currentStatus !== "online") return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [contact?.currentStatus]);

  // Compute LIVE stats — add time from any in-progress session to the totals
  const liveAnalytics = useMemo(() => {
    if (!analytics) return null;
    const openSession = analytics.recentSessions.find((s) => !s.end_time);
    if (!openSession) return analytics;

    const liveSeconds = Math.floor(
      (nowTick - new Date(openSession.start_time).getTime()) / 1000
    );

    const liveTotal = analytics.summary.totalOnlineSeconds + liveSeconds;
    const daysTracked = Math.max(analytics.summary.daysTracked, 1);

    return {
      ...analytics,
      summary: {
        ...analytics.summary,
        totalOnlineSeconds: liveTotal,
        totalOnlineHours: Math.round((liveTotal / 3600) * 10) / 10,
        avgDailyOnlineMinutes: Math.round(liveTotal / daysTracked / 60),
      },
    };
  }, [analytics, nowTick]);

  async function handleRemove() {
    if (!confirm(`Stop tracking ${contact?.name}?`)) return;
    setRemoving(true);
    try {
      await api.removeContact(contactId);
      onRemove();
    } catch {
      setRemoving(false);
    }
  }

  if (!contact) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#667781]">
        Loading...
      </div>
    );
  }

  const isOnline = contact.currentStatus === "online";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-[#075E54] text-white px-6 py-4 flex items-center gap-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-medium flex-shrink-0"
          style={{ backgroundColor: isOnline ? "#25D366" : "#a0aeb6" }}
        >
          {contact.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-medium truncate">{contact.name}</h2>
            <StatusDot online={isOnline} />
          </div>
          <p className="text-xs text-white/70">
            {isOnline
              ? "Online now"
              : contact.lastChange
              ? `Last seen ${timeAgo(contact.lastChange)}`
              : contact.phone}
          </p>
        </div>
        <button
          onClick={handleRemove}
          disabled={removing}
          className="text-xs text-white/60 hover:text-white px-3 py-1 rounded border border-white/20 hover:border-white/40"
        >
          {removing ? "..." : "Remove"}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#E9EDEF] bg-white">
        <button
          onClick={() => setTab("overview")}
          className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
            tab === "overview"
              ? "text-[#075E54] border-[#075E54]"
              : "text-[#667781] border-transparent hover:text-[#111B21]"
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setTab("sessions")}
          className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${
            tab === "sessions"
              ? "text-[#075E54] border-[#075E54]"
              : "text-[#667781] border-transparent hover:text-[#111B21]"
          }`}
        >
          Sessions
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#F0F2F5]">
        {tab === "overview" && (
          <>
            <StatsCards analytics={liveAnalytics} />

            <div className="bg-white rounded-lg p-4 border border-[#E9EDEF]">
              <h3 className="text-sm font-medium text-[#111B21] mb-3">
                Daily Activity (last 30 days)
              </h3>
              <ActivityChart data={liveAnalytics?.dailyStats || []} />
            </div>
          </>
        )}

        {tab === "sessions" && (
          <div className="bg-white rounded-lg p-4 border border-[#E9EDEF]">
            <h3 className="text-sm font-medium text-[#111B21] mb-3">
              Recent Sessions
            </h3>
            <SessionTimeline sessions={liveAnalytics?.recentSessions || []} />
          </div>
        )}
      </div>
    </div>
  );
}
