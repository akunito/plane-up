// Entry of the standalone shopping app. The service worker registration arrives in phase 6 and lives
// here only: anything the main bundle imports must never register one (gate L3-11).
// oxlint-disable-next-line import/no-unassigned-import -- the stylesheet is a side effect by nature
import "./style.css";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Controller } from "./controller";
import { pickLocale } from "./i18n";

const controller = new Controller({ base: "" });
const locale = pickLocale(navigator.languages ?? [navigator.language]);
document.documentElement.lang = locale;
createRoot(document.getElementById("app")!).render(<App controller={controller} locale={locale} />);
controller.attach(window);
void controller.start();
