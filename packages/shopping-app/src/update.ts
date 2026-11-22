// "Update the app" (S25): navigations are answered cache-first by the active worker (sw.ts), so a plain
// reload brings back the same build. Ask the browser for the new worker first, and reload once it has taken
// over (it activates and claims at once), or after a bound if none comes (phase 9 audit).

export interface UpdateDeps {
  container: ServiceWorkerContainer | undefined;
  reload: () => void;
  waitMs?: number;
}

export async function updateApp({ container, reload, waitMs = 15_000 }: UpdateDeps): Promise<void> {
  const reg = container ? await container.getRegistration("/shopping/").catch(() => undefined) : undefined;
  if (!container || !reg) return reload();
  const takenOver = new Promise<void>((resolve) => {
    container.addEventListener("controllerchange", () => resolve(), { once: true });
    setTimeout(resolve, waitMs);
  });
  await reg.update().catch(() => undefined);
  if (reg.installing || reg.waiting) await takenOver;
  reload();
}
