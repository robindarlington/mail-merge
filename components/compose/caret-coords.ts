/**
 * getCaretRect — measure the viewport pixel position of a text caret inside an
 * `<input>` or `<textarea>` using the hand-rolled mirror-div technique (no npm
 * dependency). A hidden div is cloned with the field's relevant computed styles,
 * the text before the caret is rendered into it followed by a zero-width marker
 * span, and the span's offset (plus the field's own rect, minus scroll) yields
 * the caret's viewport coordinates.
 *
 * PURITY: DOM-only; safe to call from a client component. The mirror div is
 * always removed before returning, even for the single-line input case.
 */

/** Computed styles copied onto the mirror div so wrapping + metrics match. */
const COPIED_STYLES = [
  "boxSizing",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRightWidth",
  "borderTopWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "textTransform",
  "textIndent",
] as const;

/**
 * Return the caret's viewport-relative `{ top, left, height }` for the given
 * field and caret index. `top`/`left` are the caret's upper-left corner and
 * `height` is one line's height, so a popover can be anchored just below it.
 */
export function getCaretRect(
  el: HTMLInputElement | HTMLTextAreaElement,
  caret: number,
): { top: number; left: number; height: number } {
  const isInput = el.tagName === "INPUT";
  const computed = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  const mirror = document.createElement("div");
  const style = mirror.style;
  style.position = "absolute";
  style.visibility = "hidden";
  style.top = "0";
  style.left = "-9999px";
  style.whiteSpace = isInput ? "pre" : "pre-wrap";
  style.wordWrap = "break-word";
  style.overflow = "hidden";
  // Match the field's content-box width so a textarea wraps identically.
  style.width = `${rect.width}px`;
  if (isInput) style.height = `${rect.height}px`;

  for (const name of COPIED_STYLES) {
    style[name] = computed[name];
  }

  const value = el.value;
  mirror.textContent = value.slice(0, caret);
  // An input never wraps: collapse literal newlines so metrics stay single-line.
  if (isInput) mirror.textContent = mirror.textContent.replace(/\n/g, " ");

  const marker = document.createElement("span");
  marker.textContent = "​"; // zero-width space — a measurable caret proxy
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  // Caret line top-left in viewport coords; height is one line so the anchor's
  // bottom (top + height) sits just under the caret for the popover.
  const top = rect.top + marker.offsetTop - el.scrollTop;
  const left = rect.left + marker.offsetLeft - el.scrollLeft;
  const height = marker.offsetHeight || parseFloat(computed.lineHeight) || 16;
  document.body.removeChild(mirror);

  return { top, left, height };
}
