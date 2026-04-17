"use client";

import { useEffect, useState, useCallback } from "react";
import { api, Contact } from "@/lib/api";
import { getSocket, PresenceUpdate } from "@/lib/socket";
import { ContactList } from "@/components/ContactList";
import { ContactDetail } from "@/components/ContactDetail";
import { AddContactModal } from "@/components/AddContactModal";

export default function Dashboard() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [connected, setConnected] = useState(false);

  const loadContacts = useCallback(async () => {
    try {
      const data = await api.getContacts();
      setContacts(data);
    } catch {
      // API not reachable yet
    }
  }, []);

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
      <header className="bg-[#075E54] text-white px-4 py-3 flex items-center gap-3 shadow-md z-10">
        <h1 className="text-lg font-bold tracking-wide">GST Tracker</h1>
        <div className="flex-1" />

        {/* Connection indicator */}
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-[#25D366]" : "bg-red-400"
            }`}
          />
          <span className="text-white/70">
            {connected ? "Live" : "Connecting..."}
          </span>
        </div>

        {onlineCount > 0 && (
          <span className="bg-[#25D366] text-white text-xs font-bold px-2 py-0.5 rounded-full">
            {onlineCount} online
          </span>
        )}
      </header>

      {/* Main: sidebar + detail */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-80 lg:w-96 flex flex-col border-r border-[#E9EDEF] bg-white flex-shrink-0">
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
        <div className="flex-1 flex flex-col bg-[#F0F2F5]">
          {selectedId ? (
            <ContactDetail
              key={selectedId}
              contactId={selectedId}
              contact={selectedContact}
              onRemove={() => {
                setSelectedId(null);
                loadContacts();
              }}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[#667781] gap-4">
              <div className="w-20 h-20 rounded-full bg-[#E9EDEF] flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-[#667781]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
                  />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-lg font-medium text-[#111B21]">
                  GST Tracker
                </p>
                <p className="text-sm mt-1">
                  Select a contact to view their activity
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add contact modal */}
      <AddContactModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdded={loadContacts}
      />
    </div>
  );
}
