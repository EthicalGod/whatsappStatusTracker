"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

export function SignInModal({ open, onClose, onConnected }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const data = await api.getQr();
        if (cancelled) return;
        setConnected(data.connected);
        setQrDataUrl(data.qrDataUrl);
        setError(null);
        if (data.connected) onConnected();
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load QR");
      }
    };

    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, onConnected]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg max-w-sm w-full p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-[#111B21]">
            Sign in to WhatsApp
          </h3>
          <button
            onClick={onClose}
            className="text-[#667781] hover:text-[#111B21] text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {connected ? (
          <div className="text-center py-8">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-[#25D366] flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-[#111B21] font-medium">Already connected</p>
            <p className="text-xs text-[#667781] mt-1">
              Sign out first if you want to link a different account.
            </p>
          </div>
        ) : error ? (
          <p className="text-sm text-red-600 py-4 text-center">{error}</p>
        ) : qrDataUrl ? (
          <>
            <p className="text-xs text-[#667781] text-center mb-3">
              On your phone: <br />
              <span className="text-[#111B21] font-medium">
                WhatsApp → Settings → Linked Devices → Link a Device
              </span>
            </p>
            <div className="flex justify-center">
              <img
                src={qrDataUrl}
                alt="WhatsApp QR code"
                className="border border-[#E9EDEF] rounded"
              />
            </div>
            <p className="text-[10px] text-[#667781] text-center mt-3">
              QR refreshes automatically. This window closes once you scan.
            </p>
          </>
        ) : (
          <p className="text-sm text-[#667781] py-8 text-center">
            Waiting for QR code...
          </p>
        )}
      </div>
    </div>
  );
}
