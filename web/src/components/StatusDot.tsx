"use client";

export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${
        online ? "bg-[#25D366]" : "bg-[#667781]"
      }`}
      title={online ? "Online" : "Offline"}
    />
  );
}
