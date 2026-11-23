/** Letters without a decomposition, as the server's _BASE_LETTERS (ł→l: "l" and "ł" find each other). */
const BASE_LETTERS: Record<string, string> = { ł: "l", đ: "d", ø: "o", ı: "i", ħ: "h", ŧ: "t" };

/** As the server's fold_for_search: whitespace collapsed, lower case, accents gone, ł→l. */
export const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .replace(/[łđøıħŧ]/g, (ch) => BASE_LETTERS[ch] ?? ch);
