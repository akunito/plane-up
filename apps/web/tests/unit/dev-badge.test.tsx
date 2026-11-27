import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DevBadge, isDevHost } from "@/components/dev-badge";

// APLANE-76: the main app's own copy of the rule (the shopping app has its own test); prod must never show it.
describe("DevBadge", () => {
  it("only plane-dev.* is dev", () => {
    expect(isDevHost("plane-dev.local.akunito.com")).toBe(true);
    expect(isDevHost("plane.akunito.com")).toBe(false);
    expect(isDevHost("plane.local.akunito.com")).toBe(false);
    expect(isDevHost("my-plane-dev.example.com")).toBe(false);
  });

  it("renders nothing on a host that is not dev", () => {
    const { container } = render(<DevBadge />);
    expect(window.location.hostname.startsWith("plane-dev.")).toBe(false);
    expect(container.querySelector("[data-testid=dev-badge]")).toBeNull();
  });
});
