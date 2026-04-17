const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Only set JSON content-type when we're actually sending a body. Fastify
  // rejects bodyless requests that declare Content-Type: application/json
  // with a 400 Bad Request, which broke DELETE /api/contacts/:id.
  const headers: Record<string, string> = {};
  if (options?.body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

// ── Types ─────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  phone: string;
  name: string;
  jid: string;
  is_active: boolean;
  created_at: string;
  currentStatus: "online" | "offline";
  lastChange: string | null;
}

export interface Session {
  id: number;
  contact_id: string;
  start_time: string;
  end_time: string | null;
  duration_s: number | null;
}

export interface DailyStat {
  date: string;
  total_online_s: number;
  session_count: number;
  first_seen: string | null;
  last_seen: string | null;
  peak_hour: number | null;
}

export interface Analytics {
  summary: {
    totalOnlineSeconds: number;
    totalOnlineHours: number;
    totalSessions: number;
    daysTracked: number;
    avgDailyOnlineMinutes: number;
    avgSessionsPerDay: number;
  };
  dailyStats: DailyStat[];
  recentSessions: Session[];
}

// ── API Functions ─────────────────────────────────────────────────────

export const api = {
  getContacts: () => request<Contact[]>("/api/contacts"),

  addContact: (phone: string, name: string) =>
    request<Contact>("/api/contacts", {
      method: "POST",
      body: JSON.stringify({ phone, name }),
    }),

  removeContact: (id: string) =>
    request<{ ok: boolean }>(`/api/contacts/${id}`, { method: "DELETE" }),

  getContact: (id: string) => request<Contact>(`/api/contacts/${id}`),

  getSessions: (id: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return request<Session[]>(`/api/contacts/${id}/sessions?${params}`);
  },

  getAnalytics: (id: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return request<Analytics>(`/api/contacts/${id}/analytics?${params}`);
  },

  whatsappLogout: () =>
    request<{ ok: boolean; message: string }>("/api/whatsapp/logout", { method: "POST" }),

  getDailySummary: (date?: string) => {
    const params = date ? `?date=${date}` : "";
    return request<DailyStat[]>(`/api/analytics/summary${params}`);
  },
};
