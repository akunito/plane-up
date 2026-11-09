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
 */

import { generateHTML } from "@tiptap/html";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { CustomCalloutExtensionConfig } from "@/extensions/callout/extension-config";
import { CustomHorizontalRule } from "@/extensions/horizontal-rule";

/** StarterKit supplies doc/paragraph/text; without them a node with `content: "block+"` cannot be built. */
const baseExtensions = [StarterKit];

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
