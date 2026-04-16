# GST Tracker — System Architecture

## Why Baileys over whatsapp-web.js

| Feature | whatsapp-web.js | Baileys |
|---------|----------------|---------|
| Presence detection | NOT available | Native `presenceSubscribe()` |
| Online/offline events | NO (DOM polling only) | `presence.update` event |
| Browser required | Yes (Puppeteer/Chrome) | No (raw WebSocket protocol) |
| Resource usage | Heavy (Chrome instance) | Light (Node.js process only) |
| Scalability | 1 browser per session | 100s of contacts per session |
| Ban risk | Higher (browser automation detectable) | Lower (mimics official client) |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      FRONTEND                            │
│                  Next.js + Tailwind                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Dashboard │  │ Contacts │  │ Analytics│  │ Alerts │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘  │
│         │              │             │            │      │
│         └──────────────┴─────────────┴────────────┘      │
│                         │  WebSocket + REST              │
└─────────────────────────┼───────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────┐
│                      BACKEND                             │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  REST API    │  │  WebSocket   │  │  Notification │  │
│  │  (Fastify)   │  │  (Socket.io) │  │  Service      │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│  ┌──────┴─────────────────┴───────────────────┴───────┐  │
│  │              Tracking Engine                        │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │  │
│  │  │ Baileys     │  │ Presence     │  │ Analytics │  │  │
│  │  │ Client      │  │ Manager      │  │ Aggregator│  │  │
│  │  │ (WhatsApp)  │  │ (subscribe)  │  │ (cron)    │  │  │
│  │  └─────────────┘  └──────────────┘  └───────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                               │
│  ┌───────────┐    ┌──────┴──────┐    ┌───────────────┐  │
│  │  Redis    │    │ PostgreSQL  │    │  Bull Queue   │  │
│  │  (cache)  │    │ (storage)   │    │  (jobs)       │  │
│  └───────────┘    └─────────────┘    └───────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Folder Structure

```
gst-tracker/
├── docker-compose.yml
├── .env.example
│
├── server/                    # Backend
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts           # Entry point
│   │   ├── config.ts          # Env config
│   │   │
│   │   ├── whatsapp/          # Baileys integration
│   │   │   ├── client.ts      # Baileys client wrapper
│   │   │   └── presence.ts    # Presence tracking engine
│   │   │
│   │   ├── db/
│   │   │   ├── schema.sql     # PostgreSQL schema
│   │   │   ├── connection.ts  # DB pool
│   │   │   └── queries.ts     # Typed query functions
│   │   │
│   │   ├── api/
│   │   │   ├── routes.ts      # REST endpoints
│   │   │   └── websocket.ts   # Socket.io handlers
│   │   │
│   │   ├── services/
│   │   │   ├── tracking.ts    # Business logic
│   │   │   ├── analytics.ts   # Aggregation logic
│   │   │   └── notify.ts      # Push notifications
│   │   │
│   │   └── utils/
│   │       └── logger.ts
│   │
│   └── auth_info/             # Baileys session (gitignored)
│
├── web/                       # Frontend (Next.js)
│   ├── package.json
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx       # Dashboard
│   │   │   ├── contacts/
│   │   │   └── analytics/
│   │   ├── components/
│   │   └── lib/
│   │       ├── api.ts
│   │       └── socket.ts
│   └── tailwind.config.ts
│
└── nginx/
    └── default.conf
```

## Database Schema (PostgreSQL)

### contacts
Contacts being tracked.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| phone | VARCHAR(20) | With country code |
| name | VARCHAR(100) | Display name |
| jid | VARCHAR(50) | WhatsApp JID (phone@s.whatsapp.net) |
| is_active | BOOLEAN | Currently being tracked |
| created_at | TIMESTAMPTZ | |

### presence_logs
Raw online/offline transition events.

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | PK |
| contact_id | UUID | FK → contacts |
| status | VARCHAR(10) | 'online' or 'offline' |
| timestamp | TIMESTAMPTZ | When detected |

### sessions
Computed online sessions (start → end).

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | PK |
| contact_id | UUID | FK → contacts |
| start_time | TIMESTAMPTZ | Came online |
| end_time | TIMESTAMPTZ | Went offline (NULL if still online) |
| duration_s | INTEGER | Computed on close |

### daily_stats
Pre-aggregated daily analytics (computed by cron).

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | PK |
| contact_id | UUID | FK → contacts |
| date | DATE | |
| total_online_s | INTEGER | Total seconds online |
| session_count | INTEGER | Number of sessions |
| first_seen | TIME | Earliest online time |
| last_seen | TIME | Latest online time |
| peak_hour | SMALLINT | Hour with most activity (0-23) |

### UNIQUE constraint on (contact_id, date) for daily_stats.

## API Endpoints

### Contacts
- `GET    /api/contacts`          — List all tracked contacts
- `POST   /api/contacts`          — Add a contact to track
- `DELETE /api/contacts/:id`      — Stop tracking a contact
- `GET    /api/contacts/:id`      — Contact details + current status

### Logs & Sessions
- `GET /api/contacts/:id/sessions?from=&to=`  — Session history
- `GET /api/contacts/:id/timeline?date=`      — Minute-by-minute timeline

### Analytics
- `GET /api/contacts/:id/analytics?from=&to=` — Daily stats
- `GET /api/analytics/summary?date=`          — All contacts summary

### Real-time (WebSocket)
- `presence:update`  — Fired when any tracked contact goes online/offline
- `contacts:status`  — Current status of all tracked contacts

## Scaling Strategy

### Phase 1: Single Instance (1–50 contacts)
- One Baileys client, one Node.js process
- Subscribe to all contacts' presence
- PostgreSQL + Redis on same machine

### Phase 2: Multi-Worker (50–500 contacts)
- Bull queue distributes contacts across workers
- Each worker handles a batch of presence subscriptions
- Shared PostgreSQL, Redis pub/sub for real-time fan-out

### Phase 3: Multi-Account (500+ contacts)
- Multiple WhatsApp accounts (separate phone numbers)
- Each account handles ~100–200 contacts
- Load balancer routes API requests
- Central PostgreSQL, Redis cluster

## Anti-Ban Best Practices

1. Subscribe to presence (don't poll) — Baileys handles this natively
2. Stagger subscription requests — don't subscribe to 100 contacts instantly
3. Respect connection state — pause on disconnect, backoff on reconnect
4. Limit to ~100–200 contacts per account
5. Use an aged phone number (1+ month old)
6. Run during business hours only (use time slots)
7. Don't send any messages from the tracking account
8. Keep the session alive — avoid frequent re-auths

## Risks & Limitations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Account ban | Medium | Read-only usage, aged number, rate limiting |
| WhatsApp protocol changes | Medium | Pin Baileys version, test before upgrading |
| Presence not available for all contacts | Low | Only works for contacts who haven't disabled "last seen" |
| Legal/privacy | High | Internal use only, inform tracked contacts if required by jurisdiction |
| Session expiry | Low | RemoteAuth + auto-reconnect |
