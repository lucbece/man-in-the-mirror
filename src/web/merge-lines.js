/**
 * Three-way merge for the two config fields that are also written by voice.
 *
 * `customInstructions` and `notebook` are newline-separated lists where every
 * line stands on its own — nothing in one line depends on another's position,
 * or on the list as a whole — so treating a save as a merge of *sets* of
 * lines, rather than a replace of one whole string, is exact rather than a
 * heuristic. That is what makes a server-side merge possible at all.
 *
 * `base` is what the panel had loaded when the person started editing;
 * `next` is what they are now trying to save; `current` is whatever is on
 * disk right now, which `remember_instruction` / `remember_fact` may have
 * appended to after the panel loaded and before it saved. The result keeps
 * `current` as it stands, drops whatever the panel's edit removed from
 * `base`, and appends whatever it added — so a line the room just heard the
 * bot repeat back survives a save that was never shown it.
 */

/**
 * One line per entry, trimmed, blanks dropped — same shape parseInstructions()
 * reads. Exported so the route can tell "identical once normalised" from
 * "different" without duplicating this rule — that distinction decides
 * whether a field is touched at all, not just how it is merged.
 */
export function lines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Merge `next` into `current`, using `base` to tell an edit from a line
 * neither side touched.
 *
 * Compared as plain trimmed strings, not by position — a line edited in
 * place (the panel does this with `contenteditable`) is indistinguishable
 * from the old line being removed and the new one added, which is exactly
 * the behaviour wanted: the old wording goes, the new one stays.
 */
export function mergeLines(base, next, current) {
  const baseLines = lines(base);
  const nextLines = lines(next);
  const currentLines = lines(current);

  const baseSet = new Set(baseLines);
  const nextSet = new Set(nextLines);

  // What the panel's edit did, relative to what it started from.
  const added = nextLines.filter((line) => !baseSet.has(line));
  const removed = new Set(baseLines.filter((line) => !nextSet.has(line)));

  // Start from disk as it is now — that's what carries a voice addition the
  // panel never saw — drop what the panel removed, then append what it
  // added, in the order it appears in `next`, skipping anything already
  // there so a no-op edit can't duplicate a line.
  const merged = currentLines.filter((line) => !removed.has(line));
  const mergedSet = new Set(merged);
  for (const line of added) {
    if (mergedSet.has(line)) continue;
    merged.push(line);
    mergedSet.add(line);
  }

  return merged.join('\n');
}
