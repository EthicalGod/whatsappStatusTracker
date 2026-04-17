"use client";

import { useEffect, useState } from "react";
import { api, ScheduleSlot } from "@/lib/api";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  contactId: string;
}

type Draft = { day_of_week: number; start_time: string; end_time: string };

export function ScheduleEditor({ contactId }: Props) {
  const [slots, setSlots] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSchedules(contactId)
      .then((data) => {
        if (cancelled) return;
        setSlots(
          data.map((s) => ({
            day_of_week: s.day_of_week,
            start_time: s.start_time.slice(0, 5),
            end_time: s.end_time.slice(0, 5),
          }))
        );
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  function addSlot(day: number) {
    setSlots((prev) => [
      ...prev,
      { day_of_week: day, start_time: "09:00", end_time: "17:00" },
    ]);
    setDirty(true);
  }

  function updateSlot(idx: number, patch: Partial<Draft>) {
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
    setDirty(true);
  }

  function removeSlot(idx: number) {
    setSlots((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }

  function applyToAllDays(idx: number) {
    const src = slots[idx];
    const withoutSrc = slots.filter((_, i) => i !== idx);
    const copies = DAYS.map((_, day) => ({
      day_of_week: day,
      start_time: src.start_time,
      end_time: src.end_time,
    }));
    setSlots([...withoutSrc, ...copies]);
    setDirty(true);
  }

  async function save() {
    // Basic validation before hitting the server
    for (const s of slots) {
      if (s.start_time >= s.end_time) {
        setMsg(`${DAYS[s.day_of_week]}: end time must be after start time`);
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    try {
      const sorted = [...slots].sort(
        (a, b) =>
          a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time)
      );
      await api.setSchedules(contactId, sorted as ScheduleSlot[]);
      setDirty(false);
      setMsg("Schedule saved.");
      setTimeout(() => setMsg(null), 2500);
    } catch (err: any) {
      setMsg(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    if (!confirm("Clear all slots? Contact will be tracked 24/7.")) return;
    setSlots([]);
    setDirty(true);
  }

  if (loading) {
    return <p className="text-sm text-[#667781] py-6 text-center">Loading...</p>;
  }

  const byDay = DAYS.map((_, day) =>
    slots
      .map((s, i) => ({ ...s, _idx: i }))
      .filter((s) => s.day_of_week === day)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
  );

  return (
    <div className="space-y-3">
      <div className="text-xs text-[#667781] leading-relaxed">
        Add one or more time windows per day. Outside these windows the
        contact&apos;s activity is ignored. Leave blank for 24/7 tracking.
      </div>

      <div className="space-y-2">
        {DAYS.map((label, day) => (
          <div
            key={day}
            className="rounded-lg border border-[#E9EDEF] bg-white p-3"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-[#111B21]">
                {label}
              </span>
              <button
                onClick={() => addSlot(day)}
                className="text-xs text-[#25D366] hover:text-[#128C7E] font-medium"
              >
                + Add slot
              </button>
            </div>

            {byDay[day].length === 0 ? (
              <p className="text-xs text-[#a0aeb6] italic">No slots</p>
            ) : (
              <div className="space-y-2">
                {byDay[day].map((s) => (
                  <div
                    key={s._idx}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <input
                      type="time"
                      value={s.start_time}
                      onChange={(e) =>
                        updateSlot(s._idx, { start_time: e.target.value })
                      }
                      className="border border-[#E9EDEF] rounded px-2 py-1 text-[#111B21] focus:outline-none focus:border-[#25D366]"
                    />
                    <span className="text-[#667781]">→</span>
                    <input
                      type="time"
                      value={s.end_time}
                      onChange={(e) =>
                        updateSlot(s._idx, { end_time: e.target.value })
                      }
                      className="border border-[#E9EDEF] rounded px-2 py-1 text-[#111B21] focus:outline-none focus:border-[#25D366]"
                    />
                    <button
                      onClick={() => applyToAllDays(s._idx)}
                      className="text-xs text-[#075E54] hover:underline"
                      title="Copy this slot to every day of the week"
                    >
                      Apply to all
                    </button>
                    <button
                      onClick={() => removeSlot(s._idx)}
                      aria-label="Remove slot"
                      className="text-xs text-red-500 hover:text-red-700 ml-auto px-2"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {msg && <p className="text-xs text-[#128C7E]">{msg}</p>}

      <div className="flex gap-2 sticky bottom-0 bg-[#F0F2F5] pt-3 pb-1">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="flex-1 text-sm font-medium text-white bg-[#25D366] hover:bg-[#20BD5A] disabled:bg-[#a0aeb6] disabled:cursor-not-allowed px-4 py-2 rounded-lg"
        >
          {saving ? "Saving..." : "Save schedule"}
        </button>
        <button
          onClick={clearAll}
          className="text-sm text-[#667781] hover:text-[#111B21] px-3 py-2 border border-[#E9EDEF] rounded-lg bg-white"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}
