"use client";

import { useEffect, useState, useCallback } from "react";
import { api, Contact } from "@/lib/api";
import { getSocket, PresenceUpdate } from "@/lib/socket";
import { ContactList } from "@/components/ContactList";
import { ContactDetail } from "@/components/ContactDetail";
import { AddContactModal } from "@/components/AddContactModal";
import { SignInModal } from "@/components/SignInModal";
import { LiveActivityFeed } from "@/components/LiveActivityFeed";

export default function Dashboard() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const loadContacts = useCallback(async () => {
    try {
      const data = await api.getContacts();
      setContacts(data);
    } catch {
      // API not reachable yet
    }
  }, []);

  async function handleLogout() {
    if (!confirm("Sign out of WhatsApp? This deletes the current session and you'll need to scan a new QR code to reconnect.")) {
      return;
    }
    setLoggingOut(true);
    try {
      await api.whatsappLogout();
      // Server wipes auth_info and reconnects in ~2s; the Sign In modal
      // polls /api/qr/data every 2s and will show the fresh QR automatically.
      setShowSignIn(true);
    } catch (err: any) {
      alert("Logout failed: " + (err.message || "unknown error"));
    } finally {
      setLoggingOut(false);
    }
  }

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  // Real-time presence updates via Socket.io
  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("presence:update", (update: PresenceUpdate) => {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === update.contactId
            ? {
                ...c,
                currentStatus: update.status,
                lastChange: update.timestamp,
              }
            : c
        )
      );
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("presence:update");
    };
  }, []);

  const selectedContact = contacts.find((c) => c.id === selectedId) || null;
  const onlineCount = contacts.filter((c) => c.currentStatus === "online").length;

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <header className="bg-[#075E54] text-white px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 shadow-md z-10">
        <h1 className="text-base sm:text-lg font-bold tracking-wide">GST Tracker</h1>
        <div className="flex-1" />

        {/* Connection indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-[#25D366]" : "bg-red-400"
            }`}
          />
          <span className="hidden sm:inline text-white/70">
            {connected ? "Live" : "Connecting..."}
          </span>
        </div>

        {/* Download CSV of all sessions */}
        <a
          href="/api/export/sessions.csv"
          download
          title="Download all session history as CSV"
          aria-label="Download CSV"
          className="flex items-center gap-1.5 text-xs px-2 sm:px-3 py-1.5 rounded-full border border-white/20 hover:border-white/40 hover:bg-white/10 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-5l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          <span className="hidden sm:inline">CSV</span>
        </a>

        {/* Sign in button — opens QR modal */}
        <button
          onClick={() => setShowSignIn(true)}
          title="Show WhatsApp QR code to link a device"
          aria-label="Sign in"
          className="flex items-center gap-1.5 text-xs px-2 sm:px-3 py-1.5 rounded-full border border-white/20 hover:border-white/40 hover:bg-white/10 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 4v1m6.364 1.636l-.707.707M20 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <span className="hidden sm:inline">Sign In</span>
        </button>

        {/* Sign out button */}
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          title="Sign out of WhatsApp (deletes session, QR re-scan required)"
          aria-label="Sign out"
          className="flex items-center gap-1.5 text-xs px-2 sm:px-3 py-1.5 rounded-full border border-white/20 hover:border-white/40 hover:bg-white/10 transition-colors disabled:opacity-50"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          <span className="hidden sm:inline">{loggingOut ? "Signing out..." : "Sign Out"}</span>
        </button>

        {onlineCount > 0 && (
          <span className="bg-[#25D366] text-white text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap">
            {onlineCount} online
          </span>
        )}
      </header>

      {/* Main: sidebar + detail.
          Below md (<768px): single-panel. Sidebar shown when nothing is
          selected; detail slides in when a contact is picked. md+: classic
          two-panel split. */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div
          className={`${
            selectedId ? "hidden md:flex" : "flex"
          } w-full md:w-80 lg:w-96 flex-col border-r border-[#E9EDEF] bg-white md:flex-shrink-0`}
        >
          <div className="px-4 py-3 border-b border-[#E9EDEF] flex items-center gap-2">
            <h2 className="text-sm font-medium text-[#111B21] flex-1">
              Contacts ({contacts.length})
            </h2>
            <button
              onClick={() => setShowAddModal(true)}
              className="text-xs font-medium text-white bg-[#25D366] hover:bg-[#20BD5A] px-3 py-1.5 rounded-full"
            >
              + Add
            </button>
          </div>

          <ContactList
            contacts={contacts}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>

        {/* Detail panel */}
        <div
          className={`${
            selectedId ? "flex" : "hidden md:flex"
          } flex-1 flex-col bg-[#F0F2F5]`}
        >
          {selectedId ? (
            <ContactDetail
              key={selectedId}
              contactId={selectedId}
              contact={selectedContact}
              onBack={() => setSelectedId(null)}
              onRemove={() => {
                setSelectedId(null);
                loadContacts();
              }}
            />
          ) : (
            <LiveActivityFeed />
          )}
        </div>
      </div>

      {/* Add contact modal */}
      <AddContactModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdded={loadContacts}
      />

      {/* Sign in (WhatsApp QR) modal */}
      <SignInModal
        open={showSignIn}
        onClose={() => setShowSignIn(false)}
        onConnected={() => {
          // Keep the modal visible for a second so the user sees the
          // "Already connected" confirmation, then close + refresh.
          setTimeout(() => {
            setShowSignIn(false);
            loadContacts();
          }, 1200);
        }}
      />
    </div>
  );
}
