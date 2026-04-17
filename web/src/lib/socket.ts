"use client";

import { io, Socket } from "socket.io-client";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(WS_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 2000,
    });
  }
  return socket;
}

export interface PresenceUpdate {
  contactId: string;
  name: string;
  status: "online" | "offline";
  timestamp: string;
}

export interface ContactStatus {
  [jid: string]: {
    name: string;
    isOnline: boolean;
    since: string;
  };
}
