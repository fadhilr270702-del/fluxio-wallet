/**
 * Prompt 0160 — the pure half of the folder-tree generator, extracted out
 * of `update-struktur-folder.js` specifically so the actual tree-building
 * logic (not the git/filesystem plumbing around it) has direct, framework-
 * free test coverage. No filesystem or git access here at all — a caller
 * gathers two flat path lists first (see `update-struktur-folder.js`'s own
 * comment for how) and this function turns them into the same ASCII-art
 * tree the old raw-`readdirSync` walk used to produce.
 */

/**
 * Deliberately NOT `String.prototype.localeCompare()` — that comparison
 * depends on the running machine's ICU data/default locale, which is
 * exactly the kind of thing that can silently differ between two
 * developers' machines (or CI vs. a laptop) and produce a spurious tree
 * diff for zero actual structural change.
 *
 * ALSO deliberately not plain `<`/`>` on the raw strings, even though
 * that's fully deterministic too — a first attempt at exactly that sorted
 * every uppercase-first name before every lowercase-first one (ASCII
 * 'A'-'Z' are all below 'a'-'z'), which is technically stable but reads
 * nothing like the old `localeCompare()` order every existing entry in
 * this file was already sorted by — regenerating the tree with it
 * reordered thousands of unrelated, unchanged entries in one pass (a real
 * diff caught live before this fix, not a hypothetical). Comparing
 * lowercased names first gives the same case-insensitive-ish order
 * `localeCompare()` produced for this repo's own filenames (almost
 * entirely plain ASCII), while `String.prototype.toLowerCase()` itself
 * (unlike `toLocaleLowerCase()`) is the ECMAScript-spec "default case
 * conversion" — fixed by spec, not ICU/locale data, so it stays
 * deterministic across machines exactly like the rest of this comparator.
 * The exact-string tiebreak only matters for two names differing purely
 * by case (rare in this repo, never actually observed), and is itself
 * plain code-unit comparison — still no locale involved anywhere.
 */
function compareNames(a, b) {
  if (a === b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a < b ? -1 : 1;
}

/**
 * Builds the same tree.txt/tree-utf8.txt text this project has always
 * produced, from two flat lists of forward-slash-separated paths relative
 * to the tree root:
 *  - `filePaths`: every real file that should appear as a leaf (in
 *    practice, `git ls-files --cached --others --exclude-standard`'s own
 *    output — see update-struktur-folder.js).
 *  - `emptyDirPaths`: directories that should appear even though they
 *    contain zero files of their own (git has no concept of an empty
 *    directory, so these can never come from a git-file-list no matter
 *    how it's queried — a caller has to find them separately, e.g. a real
 *    but ignore-filtered filesystem walk, and pass them in here
 *    explicitly). A directory that's an ancestor of some entry in
 *    `filePaths` needs no separate entry here — inserting the file already
 *    creates every ancestor directory node along the way.
 *
 * Returns the tree as an array of lines (caller decides how to join them /
 * what trailing newline to use) — `[rootLabel, ...one line per entry]`.
 */
function buildTreeLines(filePaths, emptyDirPaths, rootLabel) {
  const root = { name: rootLabel, isDir: true, children: new Map() };

  function insert(path, leafIsDir) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, isDir: isLast ? leafIsDir : true, children: new Map() };
        node.children.set(part, child);
      } else if (isLast && leafIsDir) {
        // An empty-dir entry that turns out to already have real children
        // (a file under it was also passed in `filePaths`) — not actually
        // empty after all; leave the already-created directory node as is.
        child.isDir = true;
      }
      node = child;
    });
  }

  (filePaths || []).forEach((p) => insert(p, false));
  (emptyDirPaths || []).forEach((p) => insert(p, true));

  const lines = [rootLabel];
  function render(node, prefix) {
    const entries = Array.from(node.children.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return compareNames(a.name, b.name);
    });
    entries.forEach((entry, i) => {
      const last = i === entries.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + (entry.isDir ? `${entry.name}/` : entry.name));
      if (entry.isDir) render(entry, prefix + (last ? '    ' : '│   '));
    });
  }
  render(root, '');
  return lines;
}

module.exports = { buildTreeLines, compareNames };
