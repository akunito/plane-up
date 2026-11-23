// Quick capture: search, one action per mode, pin toggle, create into a list (mockup Apuntar). Creating
// needs a connection: items are created by the server, never queued (brief).

import { useEffect, useMemo, useRef, useState } from "react";
import { view } from "@plane/inventory";
import type { AppState } from "../controller";
import { prefs } from "../store";
import { ItemControl, useCtx } from "../ui";

const DEBOUNCE_MS = 200;

/** As the server's fold_for_search: NFKC + casefold-ish, whitespace collapsed, accents gone (ł stays). */
const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();

/** Where the folded query sits in the name, as [start, end) in the name's own UTF-16 indices: each character is
 * folded on its own and every folded unit remembers the character it came from, so "sol" bolds "Sól" (the server
 * matches names without accents too) and emoji or ß (folding to 0 or 2 units) keep the positions right. */
function findFolded(name: string, query: string): [number, number] | null {
  const q = fold(query);
  if (!q) return null;
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < name.length; ) {
    const ch = String.fromCodePoint(name.codePointAt(i)!);
    const f = /\s/.test(ch) ? " " : fold(ch);
    for (let k = 0; k < f.length; k++) {
      from.push(i);
      to.push(i + ch.length);
    }
    folded += f;
    i += ch.length;
  }
  const at = folded.indexOf(q);
  return at < 0 ? null : [from[at]!, to[at + q.length - 1]!];
}

function Highlight({ name, query }: { name: string; query: string }) {
  const hit = findFolded(name, query);
  if (!hit) return <>{name}</>;
  return (
    <>
      {name.slice(0, hit[0])}
      <strong>{name.slice(hit[0], hit[1])}</strong>
      {name.slice(hit[1])}
    </>
  );
}

/** The keyword a search matched when the name did not: "also: butter" under "Mantequilla / Masło". Compared as the
 * server compares; when no single keyword holds the query (it spans a comma), the whole list is shown. */
function matchedKeyword(name: string, keywords: string | undefined, query: string): string | null {
  const q = fold(query);
  if (!q || !keywords || fold(name).includes(q)) return null;
  return (
    keywords
      .split(",")
      .map((k) => k.trim())
      .find((k) => fold(k).includes(q)) ?? (fold(keywords).includes(q) ? keywords : null)
  );
}

export function Capture({ s }: { s: AppState }) {
  const { c, t } = useCtx();
  const [query, setQuery] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const lists = s.lists?.lists ?? [];
  const [listId, setListId] = useState(() => {
    const last = prefs.get("captureList");
    return lists.some((l) => l.id === last) ? last! : (lists[0]?.id ?? "");
  });
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const q = query.trim();
    setMessage(null);
    if (!q) {
      setIds([]);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const out = await c.search(q);
      if (mine !== seq.current) return; // a later keystroke owns the screen
      if (out) setIds(out.ids);
      else setMessage(t("needs_connection"));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, c, t]);

  const shown = useMemo(() => view(s.queue), [s.queue]);
  const q = query.trim();
  const exact = ids.some(
    (id) => s.known[id]?.data.name.toLocaleLowerCase() === q.toLocaleLowerCase() && s.known[id]?.data.list.id === listId
  );

  async function create() {
    if (!q || !listId) return;
    prefs.set("captureList", listId);
    const out = await c.createItem(listId, q);
    if (out.kind === "created") {
      setIds((prev) => [out.id, ...prev.filter((x) => x !== out.id)]);
      c.showToast(t("created_toast", { item: q }));
    } else if (out.kind === "exists") {
      if (out.id) setIds((prev) => [out.id!, ...prev.filter((x) => x !== out.id)]);
      setMessage(t("exists", { name: q }));
    } else setMessage(t("needs_connection"));
  }

  return (
    <div className="screen">
      <header className="topbar">
        <label className="search">
          <span className="visually-hidden">{t("search_label")}</span>
          <input
            ref={input}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label={t("search_label")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <a href="#/" className="text-button">
          {t("close")}
        </a>
      </header>
      <main className="scroll">
        {q && ids.length === 0 && !message ? <p className="empty">{t("no_results")}</p> : null}
        {ids.map((id) => {
          const k = s.known[id];
          const state = shown[id];
          if (!k || !state) return null;
          const hint =
            state.mode === "pinned"
              ? t("always_on_list")
              : state.mode === "on_demand"
                ? t("occasional")
                : state.mode === "units"
                  ? t("minimum", { n: state.min_quantity ?? 0 })
                  : null;
          return (
            <div className="row tall" key={id} data-item={id}>
              <div className="grow">
                <a href={`#/item/${id}`} className="name block">
                  <Highlight name={k.data.name} query={q} />
                </a>
                {(() => {
                  const also = matchedKeyword(k.data.name, k.data.keywords, q);
                  return also ? (
                    <span className="sub block">
                      {t("also_called")} <Highlight name={also} query={q} />
                    </span>
                  ) : null;
                })()}
                <span className="sub block">
                  {[k.data.list.name, k.data.project.name, hint].filter(Boolean).join(" · ")}
                </span>
              </div>
              <ItemControl data={k.data} state={state} />
            </div>
          );
        })}
        {message ? (
          <p className="notice" role="alert">
            {message}
          </p>
        ) : null}
        {q && !exact && lists.length > 0 ? (
          <div className="create">
            <button type="button" className="dashed" onClick={() => void create()}>
              {t("create_into", { name: q })}
            </button>
            <div className="chips" role="group" aria-label={t("in_list")}>
              <span className="muted small">{t("in_list")}</span>
              {lists.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className="chip"
                  aria-pressed={l.id === listId}
                  onClick={() => setListId(l.id)}
                >
                  {l.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
