"use client";

import { useState } from "react";
import { api } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

export function AddContactModal({ open, onClose, onAdded }: Props) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() || !name.trim()) return;

    setLoading(true);
    setError("");
    try {
      await api.addContact(phone.trim(), name.trim());
      setPhone("");
      setName("");
      onAdded();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to add contact");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="bg-[#075E54] text-white px-6 py-4 rounded-t-lg">
          <h2 className="text-lg font-medium">Add Contact to Track</h2>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-[#111B21] mb-1">
              Phone Number
            </label>
            <input
              type="text"
              placeholder="919999414559"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 border border-[#E9EDEF] rounded-lg focus:outline-none focus:border-[#25D366] text-sm"
            />
            <p className="text-xs text-[#667781] mt-1">
              With country code, digits only (no + or spaces)
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[#111B21] mb-1">
              Display Name
            </label>
            <input
              type="text"
              placeholder="Chetan"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-[#E9EDEF] rounded-lg focus:outline-none focus:border-[#25D366] text-sm"
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm">{error}</p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-[#667781] hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-2 text-sm text-white bg-[#25D366] hover:bg-[#20BD5A] rounded-lg disabled:opacity-50"
            >
              {loading ? "Adding..." : "Add Contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
