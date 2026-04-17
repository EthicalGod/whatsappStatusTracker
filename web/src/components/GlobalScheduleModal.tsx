"use client";

import { useEffect, useState } from "react";
import { api, ScheduleSlot } from "@/lib/api";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  open: boolean;
  onClose: () => void;
}

type Draft = { day_of_week: number; start_time: string; end_time: string };

export function GlobalScheduleModal({ open, onClose }: Props) {
  const [slots, setSlots] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api
      .getGlobalSchedule()
      .then((data) => {
        if (cancelled) return;
        setSlots(
          data.map((s) => ({
            day_of_week: s.day_of_week,
            start_time: s.start_time.slice(0, 5),
            end_time: s.end_time.slice(0, 5),
          }))
        );
        setDirty(false);
        setMsg(null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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
      await api.setGlobalSchedule(sorted as ScheduleSlot[]);
      setDirty(false);
      setMsg("Schedule saved. Applies to every tracked contact.");
      setTimeout(() => setMsg(null), 2500);
    } catch (err: any) {
      setMsg(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function clearAll() {
    if (!confirm("Clear all slots? Tracker will resume 24/7 tracking for every contact.")) return;
    setSlots([]);
    setDirty(true);
  }

  if (!open) return null;

  const byDay = DAYS.map((_, day) =>
    slots
      .map((s, i) => ({ ...s, _idx: i }))
      .filter((s) => s.day_of_week === day)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
  );

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-3"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg max-w-lg w-full max-h-[90vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-[#075E54] text-white px-5 py-3 flex items-center justify-between rounded-t-lg">
          <div>
            <h3 className="text-base font-medium">Tracking Schedule</h3>
            <p className="text-xs text-white/70">
              Applies to every tracked contact.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-white/80 hover:text-white text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body (scrollable) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <p className="text-sm text-[#667781] py-8 text-center">Loading...</p>
          ) : (
            <>
              <p className="text-xs text-[#667781] leading-relaxed">
                Set time windows per day when tracking is active. Outside the
                windows, the tracker is marked offline and activity is ignored.
                Leave all days empty for 24/7 tracking.
              </p>
              <div className="space-y-2">
                {DAYS.map((label, day) => (
                  <div
                    key={day}
                    className="rounded-lg border border-[#E9EDEF] p-3"
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
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[#E9EDEF] p-3 flex gap-2 bg-[#F0F2F5] rounded-b-lg">
          <button
            onClick={save}
            disabled={!dirty || saving || loading}
            className="flex-1 text-sm font-medium text-white bg-[#25D366] hover:bg-[#20BD5A] disabled:bg-[#a0aeb6] disabled:cursor-not-allowed px-4 py-2 rounded-lg"
          >
            {saving ? "Saving..." : "Save schedule"}
          </button>
          <button
            onClick={clearAll}
            disabled={loading}
            className="text-sm text-[#667781] hover:text-[#111B21] px-3 py-2 border border-[#E9EDEF] rounded-lg bg-white"
          >
            Clear all
          </button>
        </div>
      </div>
    </div>
  );
}
