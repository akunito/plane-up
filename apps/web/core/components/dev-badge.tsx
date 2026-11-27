import { useEffect, useState } from "react";

/** APLANE-76: dev and prod run the same image, so "this is dev" is read from the host at runtime. */
export function isDevHost(hostname: string): boolean {
  return hostname.startsWith("plane-dev.");
}

/** An orange "DEV" in the top-right corner of every page on dev. After mount: the shell is prerendered once
 * for both hosts, so reading the host while rendering would not match the hydrated markup. Taps pass through. */
export function DevBadge() {
  const [dev, setDev] = useState(false);
  useEffect(() => setDev(isDevHost(window.location.hostname)), []);
  if (!dev) return null;
  return (
    <div
      data-testid="dev-badge"
      aria-label="Development environment"
      style={{
        position: "fixed",
        top: "env(safe-area-inset-top, 0px)",
        right: 0,
        zIndex: 2147483000,
        padding: "1px 6px",
        borderBottomLeftRadius: 4,
        background: "#f97316",
        color: "#fff",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.05em",
        pointerEvents: "none",
      }}
    >
      DEV
    </div>
  );
}
