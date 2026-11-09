/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * What our custom extensions actually render (APLANE-30, the tiptap 2 -> 3 prerequisite).
 *
 * `packages/editor` had NO tests — no files, no runner, no script — and no E2E spec touches the
 * editor or `description_html`. So the 144-file migration to tiptap 3 would have had nothing behind
 * it but `tsc`, in the component that eats user content. These are the first tests here.
 *
 * They assert the thing a major upgrade is most likely to move: the HTML a node or mark serialises
 * to. `generateHTML` from `@tiptap/html` runs the real `renderHTML` of the real extension through
 * prosemirror's serialiser against **zeed-dom**, so there is no browser and no jsdom — which is why
 * this package can be tested at all.
 *
 * Deliberately NOT snapshots. A snapshot of a 2 -> 3 diff tells you something changed; these say
 * which attribute, on which tag, and the comments say whether that would matter.
 *
 * This is a first slice, not coverage: the extensions below are the ones whose `renderHTML` puts
 * user-controlled attributes into the DOM. Extending it to the rest is mechanical.
 *
 * **KNOWN BLIND SPOT, measured 2026-11-09 and pinned by the last test in this file: zeed-dom drops
 * the `style` attribute entirely.** Everything else survives. So nothing here can test a `style`,
 * and — the dangerous half — a negative assertion about one passes VACUOUSLY. `TableCell`
 * interpolates user-controlled attrs straight into `style` (table-cell.ts:116,
 * `background-color: ${node.attrs.background}`), and a test asserting that a hostile value does not
 * inject a second CSS declaration there would go green while proving nothing. That surface needs a
 * browser, or a different renderer, to test at all.
 */

import { Node } from "@tiptap/core";
import { generateHTML } from "@tiptap/html";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { CustomCalloutExtensionConfig } from "@/extensions/callout/extension-config";
import { CustomLinkExtension } from "@/extensions/custom-link";
import { CustomHorizontalRule } from "@/extensions/horizontal-rule";

/** StarterKit supplies doc/paragraph/text; without them a node with `content: "block+"` cannot be built. */
const baseExtensions = [StarterKit];

const hrefOf = (html: string) => html.match(/href="([^"]*)"/)?.[1];

const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("custom callout", () => {
  const render = (attrs: Record<string, unknown>) =>
    generateHTML({ type: "doc", content: [{ type: "calloutComponent", attrs, content: [paragraph("inside")] }] }, [
      ...baseExtensions,
      CustomCalloutExtensionConfig,
    ]);

  it("renders a div carrying the attribute it was given, and its content", () => {
    const html = render({ "data-background": "#ff0000" });

    expect(html).toContain("<div");
    expect(html).toContain('data-background="#ff0000"');
    expect(html).toContain("<p>inside</p>");
  });

  it("fills in its declared defaults for attributes nobody passed", () => {
    // Separated from the assertion above on purpose. The first version of this test also checked
    // `data-logo-in-use="emoji"` while passing it in, and that proved nothing: it is a DEFAULT from
    // DEFAULT_CALLOUT_BLOCK_ATTRIBUTES and appears whether you pass it or not. Printing the real
    // output is what showed it. Pinned here as what it actually is — a default, and a contract a
    // 2 -> 3 change to addAttributes would break.
    const html = render({});

    expect(html).toContain('data-logo-in-use="emoji"');
    expect(html).toContain('data-block-type="callout-component"');
    expect(html).toContain('data-emoji-unicode="128161"');
  });

  it("escapes a quote in an attribute instead of breaking out of it", () => {
    // The reason this extension is in the first slice: its attributes are user-controlled, and
    // `renderHTML` is `["div", mergeAttributes(HTMLAttributes), 0]` — everything declared goes
    // straight into the DOM. The serialiser must escape; if a tiptap upgrade ever stopped doing so
    // this is an attribute-injection bug in the thing that stores user content.
    const html = render({ "data-background": '" onload="alert(1)' });

    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("drops an attribute the extension does not declare", () => {
    // The guard behind the APLANE-30 reachability finding: `mergeAttributes` only ever sees keys
    // the extension declared, so an undeclared one — `__proto__` being the interesting case for
    // GHSA-cp6q-959q-f8rh — cannot reach it through our own extensions.
    const html = render({ "data-background": "#00ff00", "data-not-declared": "x" });

    expect(html).toContain('data-background="#00ff00"');
    expect(html).not.toContain("data-not-declared");
  });
});

describe("custom horizontal rule", () => {
  it("renders a div tagged with its own name rather than an <hr>", () => {
    // Upstream's horizontal rule renders `<hr>`; ours renders a div carrying `data-type`, because
    // the node view needs an element it can select. A 2 -> 3 upgrade that reverted this to `<hr>`
    // would change every stored document's rendering, and nothing else would notice.
    // StarterKit ships its own horizontalRule under the SAME node name, so it has to be turned
    // off or prosemirror refuses the schema with a duplicate-name error.
    const html = generateHTML({ type: "doc", content: [{ type: "horizontalRule" }] }, [
      StarterKit.configure({ horizontalRule: false }),
      CustomHorizontalRule,
    ]);

    expect(html).toContain('data-type="horizontalRule"');
    // `this.options.HTMLAttributes` lands here too — the styling is part of the render contract,
    // and a 2 -> 3 change to how mergeAttributes folds options in would drop it silently.
    expect(html).toContain('class="py-4 border-strong-1"');
  });
});

describe("what this harness cannot see", () => {
  it("drops the style attribute, so no style assertion here can be trusted", () => {
    // Pinned as a TEST rather than a comment because the failure mode is a green one: a negative
    // assertion about a style — "the hostile value did not inject another declaration" — passes
    // whatever the code does. If a future zeed-dom starts serialising style, this test fails, and
    // that failure is the signal that the style-based extensions became testable here.
    const Styled = Node.create({
      name: "styledProbe",
      group: "block",
      content: "inline*",
      parseHTML: () => [{ tag: "div[data-styled]" }],
      renderHTML: () => ["div", { "data-styled": "yes", style: "color: red;", title: "kept" }, 0],
    });

    const html = generateHTML(
      { type: "doc", content: [{ type: "styledProbe", content: [{ type: "text", text: "x" }] }] },
      [StarterKit, Styled]
    );

    expect(html).toContain('data-styled="yes"');
    expect(html).toContain('title="kept"');
    expect(html).not.toContain("style=");
  });
});

describe("custom link href sanitising (GHSA-v2vv-7wq3-8w2j)", () => {
  // The highest-value guard in this package and it had NO tests: `isDangerousHref` is module-private,
  // so renderHTML through generateHTML is the only way to reach it. It blocks javascript:, data: and
  // vbscript:, and — the part worth pinning — it first replicates the WHATWG URL parser's
  // normalisation, because browsers strip Tab/LF/CR from ANYWHERE in a URL and strip leading C0
  // controls before the scheme. A naive startsWith("javascript:") is bypassable with "\tjavascript:".
  // When it fires it empties the href rather than dropping the anchor.
  const render = (href: string) =>
    generateHTML(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] }] },
        ],
      },
      [StarterKit, CustomLinkExtension]
    );

  it("leaves an ordinary https link alone", () => {
    // The control that keeps the rest honest: a guard that emptied everything would pass every
    // assertion below and break every real link.
    expect(hrefOf(render("https://plane.example.com/x"))).toBe("https://plane.example.com/x");
  });

  it.each([
    ["a plain javascript: url", "javascript:alert(1)"],
    ["a TAB before the scheme — the bypass the guard names", "\tjavascript:alert(1)"],
    ["a TAB inside the scheme, which browsers strip too", "java\tscript:alert(1)"],
    ["a NEWLINE inside the scheme", "java\nscript:alert(1)"],
    ["mixed case", "JaVaScRiPt:alert(1)"],
    ["a data: url", "data:text/html;base64,PHNjcmlwdD4="],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["a non-breaking space before the scheme", "\u00A0javascript:alert(1)"],
    ["a NUL before the scheme", "\u0000javascript:alert(1)"],
  ])("empties the href for %s", (_label, href) => {
    // Measured 2026-11-09: all nine are neutralised today. Without the guard the href comes
    // through verbatim, so each of these fails loudly if it is ever removed or narrowed.
    expect(hrefOf(render(href))).toBe("");
  });

  it("keeps the anchor's rel and target, which are the other half of the protection", () => {
    const html = render("https://plane.example.com/x");

    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });
});
