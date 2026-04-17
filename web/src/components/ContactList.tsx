"use client";

import { Contact } from "@/lib/api";
import { StatusDot } from "./StatusDot";
import { timeAgo } from "@/lib/utils";

interface Props {
  contacts: Contact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ContactList({ contacts, selectedId, onSelect }: Props) {
  if (contacts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#667781] text-sm p-8 text-center">
        No contacts being tracked yet.<br />
        Click &quot;+ Add&quot; to start.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {contacts.map((contact) => {
        const isOnline = contact.currentStatus === "online";
        const selected = contact.id === selectedId;

        return (
          <button
            key={contact.id}
            onClick={() => onSelect(contact.id)}
            className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#F0F2F5] border-b border-[#E9EDEF] transition-colors ${
              selected ? "bg-[#F0F2F5]" : ""
            }`}
          >
            {/* Avatar circle */}
            <div className="w-12 h-12 rounded-full bg-[#DFE5E7] flex items-center justify-center text-[#FFFFFF] text-lg font-medium flex-shrink-0"
              style={{ backgroundColor: isOnline ? "#25D366" : "#a0aeb6" }}
            >
              {contact.name.charAt(0).toUpperCase()}
            </div>

            {/* Name + status */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[#111B21] truncate">
                  {contact.name}
                </span>
                <StatusDot online={isOnline} />
              </div>
              <p className="text-xs text-[#667781] truncate">
                {isOnline
                  ? "Online now"
                  : contact.lastChange
                  ? `Last seen ${timeAgo(contact.lastChange)}`
                  : contact.phone}
              </p>
            </div>

            {/* Online indicator bar */}
            {isOnline && (
              <div className="w-1 h-8 bg-[#25D366] rounded-full flex-shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}
