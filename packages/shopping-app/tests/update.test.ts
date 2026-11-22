// "Update the app" (S25): reload only once the new worker has taken over, or after a bound.

import { describe, expect, it } from "vitest";
import { updateApp } from "../src/update";

function fakeContainer(reg: { update: () => Promise<unknown>; installing: unknown; waiting: unknown } | undefined) {
  const listeners: (() => void)[] = [];
  const container = {
    getRegistration: async () => reg,
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
  } as unknown as ServiceWorkerContainer;
  return { container, takeOver: () => listeners.forEach((fn) => fn()) };
}

describe("updateApp", () => {
  it("asks for the new worker and reloads only after it has taken over", async () => {
    const reg = { update: async () => undefined, installing: {} as unknown, waiting: null as unknown };
    const { container, takeOver } = fakeContainer(reg);
    let reloads = 0;
    const done = updateApp({ container, reload: () => void reloads++ });
    await new Promise((r) => setTimeout(r, 10));
    expect(reloads).toBe(0);
    takeOver();
    await done;
    expect(reloads).toBe(1);
  });

  it("reloads at once when there is no new worker, no registration, or no worker support", async () => {
    let reloads = 0;
    const reload = () => void reloads++;
    await updateApp({
      container: fakeContainer({ update: async () => undefined, installing: null, waiting: null }).container,
      reload,
    });
    await updateApp({ container: fakeContainer(undefined).container, reload });
    await updateApp({ container: undefined, reload });
    expect(reloads).toBe(3);
  });

  it("does not wait for ever for a worker that never takes over", async () => {
    const reg = { update: async () => undefined, installing: {} as unknown, waiting: null as unknown };
    let reloads = 0;
    await updateApp({ container: fakeContainer(reg).container, reload: () => void reloads++, waitMs: 20 });
    expect(reloads).toBe(1);
  });
});
