// Entry of the standalone shopping app. The service worker registration arrives in phase 6 and lives
// here only: anything the main bundle imports must never register one (gate L3-11).
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is a side effect by nature
import "./style.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Controller } from "./controller";
import { pickLocale } from "./i18n";

// The main app's links name the workspace they were clicked in (?ws=slug): without it the app opens the
// workspace it remembers, so a counter read in workspace B would lead to A's list (phase 5 audit). The
// parameter is dropped from the address once read, so a reload or an installed start keeps the choice.
const params = new URLSearchParams(location.search);
const asked = params.get("ws")?.trim() ?? "";
if (params.has("ws")) history.replaceState(history.state, "", `${location.pathname}${location.hash}`);
const controller = new Controller(asked ? { base: "", slug: asked } : { base: "" });
const locale = pickLocale(navigator.languages ?? [navigator.language]);
document.documentElement.lang = locale;
createRoot(document.getElementById("app")!).render(<App controller={controller} locale={locale} />);
controller.attach(window);
void controller.start();
