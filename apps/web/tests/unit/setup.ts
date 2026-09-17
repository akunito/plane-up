/** Unmount whatever a test rendered (Testing Library only auto-cleans with vitest globals on). */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
