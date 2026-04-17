"use client";

import { useEffect, useState, useCallback } from "react";
import { api, Contact, Analytics } from "@/lib/api";
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

  const loadAnalytics = useCallback(async () => {
    try {
      const data = await api.getAnalytics(contactId);
      setAnalytics(data);
    } catch {
      // will show empty state
    }
  }, [contactId]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

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
            <StatsCards analytics={analytics} />

            <div className="bg-white rounded-lg p-4 border border-[#E9EDEF]">
              <h3 className="text-sm font-medium text-[#111B21] mb-3">
                Daily Activity (last 30 days)
              </h3>
              <ActivityChart data={analytics?.dailyStats || []} />
            </div>
          </>
        )}

        {tab === "sessions" && (
          <div className="bg-white rounded-lg p-4 border border-[#E9EDEF]">
            <h3 className="text-sm font-medium text-[#111B21] mb-3">
              Recent Sessions
            </h3>
            <SessionTimeline sessions={analytics?.recentSessions || []} />
          </div>
        )}
      </div>
    </div>
  );
}
