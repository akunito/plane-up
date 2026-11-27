/** APLANE-76: dev and prod run the same image, so "this is dev" is read from the host at runtime. */
export function isDevHost(hostname: string): boolean {
  return hostname.startsWith("plane-dev.");
}
