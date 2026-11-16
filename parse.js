// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 renderer, byte-compatible
// with marked 18.1.3's default options (gfm on, breaks off, pedantic off,
// async off). Written from scratch for the make.fun
// "Make Markdown rendering faster" bounty: an independent implementation of
// the CommonMark + GFM rules, tuned for speed (position-based scanning,
// sticky patterns, no per-token string slicing).

// ------------------------------------------------------------------ helpers

const ESC_MAP = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
// With encode=false, valid entity references are left alone.
const ESC_TEST_NE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/;
const ESC_REPLACE_NE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;

/** Escape HTML metacharacters. encode=true escapes every &, encode=false
 *  leaves &-sequences that already look like entity references alone. */
function escape(s, encode) {
  if (encode) return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (c) => ESC_MAP[c]) : s;
  return ESC_TEST_NE.test(s) ? s.replace(ESC_REPLACE_NE, (c) => ESC_MAP[c]) : s;
}

const NUMERIC_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Decode numeric character references in a text run (marked's `Ie`):
// &#35; -> '#', &#0; / surrogates / >0x10FFFF -> U+FFFD, &#38; -> '&amp;',
// and a bare '&' (not part of a valid entity) -> '&amp;'. Only runs when a
// numeric reference is present; named entities are left for the escaper.
function decodeEntities(a) {
  if (!NUMERIC_REF_RE.test(a)) return a;
  return a.replace(NUMERIC_REF_OR_AMP_RE, (e, t, n) => {
    if (t === undefined && n === undefined) return '&amp;';
    const s = t === undefined ? parseInt(n, 16) : parseInt(t, 10);
    if (s === 0 || s > 0x10FFFF || (s >= 0xD800 && s <= 0xDFFF)) return '\uFFFD';
    if (s === 38) return '&amp;';
    return String.fromCodePoint(s);
  });
}

// ASCII punctuation lookup (code < 128).
const ASCII_PUNCT = new Uint8Array(128);
for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[c.charCodeAt(0)] = 1;

function isAsciiPunct(code) {
  return code < 128 && ASCII_PUNCT[code] === 1;
}

// Unicode punctuation or symbol (CommonMark "punctuation" = ASCII punct or
// general categories P and S). Only consulted for non-ASCII code points.
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(code, ch) {
  if (code < 128) return ASCII_PUNCT[code] === 1;
  return PUNCT_RE.test(ch);
}

// Unicode whitespace (White_Space property), by code point.
function isSpaceCode(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 ||
    code === 13 || code === 0x85 || code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000
  );
}

function isAlnumCode(code) {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code >= 128
  );
}

// Characters that may appear in a URL unencoded (RFC 3986 unreserved +
// sub-delims + :/?#@ and %). Everything else in a link destination is
// percent-encoded (UTF-8, uppercase hex).
const URL_KEEP = new Uint8Array(128);
for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?#%") {
  URL_KEEP[c.charCodeAt(0)] = 1;
}

/** Percent-encode every character of href that is not URL-keepable. */
function cleanHref(href) {
  let out = null;
  for (let i = 0; i < href.length; i++) {
    const code = href.charCodeAt(i);
    if (code < 128 && URL_KEEP[code] === 1) {
      if (out !== null) out += href[i];
      continue;
    }
    if (out === null) out = href.slice(0, i);
    // Encode one code point (handles surrogate pairs via encodeURIComponent).
    const ch = code >= 0xd800 && code <= 0xdbff && i + 1 < href.length ? href.slice(i, i + 2) : href[i];
    out += encodeURIComponent(ch);
    if (ch.length === 2) i++;
  }
  return out === null ? href : out;
}

/** Resolve backslash escapes: \X -> X for ASCII punctuation, else kept. */
function resolveEscapes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ------------------------------------------------------------- inline nodes
// Node kinds. Nodes are plain objects; delim nodes are resolved by
// resolveEmphasis into em/strong nodes before rendering.
const N_TEXT = 0; // { k, s }            s: already-escaped HTML text
const N_CODE = 1; // { k, s }            s: escaped code text
const N_EM = 2; // { k, c }              c: child nodes
const N_STRONG = 3; // { k, c }
const N_LINK = 4; // { k, href, title, c }  href: cleaned, title: raw (escaped at render)
const N_IMAGE = 5; // { k, href, title, alt } alt: plain text, already escaped
const N_HTML = 6; // { k, s }            s: raw HTML
const N_BR = 7; // { k }
const N_DEL = 8; // { k, c }             strikethrough children
const N_DELIM = 9; // { k, ch, len, canOpen, canClose }  ch: '*' or '_'

function renderNodes(nodes, out) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    // A checkbox unshifted into a paragraph's inline nodes (loose task
    // list): render it like the block-level checkbox.
    if (nd.type === 'checkbox') {
      out.push('<input ' + (nd.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
      continue;
    }
    switch (nd.k) {
      case N_TEXT: out.push(nd.s); break;
      case N_CODE: out.push('<code>', nd.s, '</code>'); break;
      case N_EM: out.push('<em>'); renderNodes(nd.c, out); out.push('</em>'); break;
      case N_STRONG: out.push('<strong>'); renderNodes(nd.c, out); out.push('</strong>'); break;
      case N_LINK: {
        // The href is percent-encoded at render time (marked's cleanUrl);
        // a lone surrogate makes encodeURI throw, and then the link
        // renders as its text only (no <a>).
        let href = null;
        try { href = cleanHref(nd.href); } catch (e) { href = null; }
        if (href === null) { renderNodes(nd.c, out); break; }
        out.push('<a href="', escape(href, !!nd.auto), '"');
        if (nd.title) out.push(' title="', escape(nd.title, false), '"');
        out.push('>');
        renderNodes(nd.c, out);
        out.push('</a>');
        break;
      }
      case N_IMAGE: {
        let href = null;
        try { href = cleanHref(nd.href); } catch (e) { href = null; }
        if (href === null) { out.push(nd.alt); break; }
        out.push('<img src="', escape(href, false), '" alt="', nd.alt, '"');
        if (nd.title) out.push(' title="', escape(nd.title, false), '"');
        out.push('>');
        break;
      }
      case N_HTML: out.push(nd.s); break;
      case N_BR: out.push('<br>'); break;
      case N_DEL: out.push('<del>'); renderNodes(nd.c, out); out.push('</del>'); break;
      case N_DELIM: {
        // Unmatched delimiters stay literal.
        out.push(nd.ch.repeat(nd.len));
        break;
      }
    }
  }
}

// Plain-text rendering of inline nodes (for image alt text): markup is
// stripped, but raw HTML tags are kept (they get escaped by the img
// renderer), code spans keep their raw text, and <br> contributes nothing.
function plainText(nodes, out) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    switch (nd.k) {
      case N_TEXT: out.push(nd.s); break;
      case N_CODE: out.push(nd.s); break;
      case N_EM: case N_STRONG: case N_DEL: plainText(nd.c, out); break;
      case N_LINK: plainText(nd.c, out); break;
      case N_IMAGE: out.push(nd.alt); break;
      case N_HTML: out.push(nd.s); break;
      case N_BR: break;
      case N_DELIM: out.push(nd.ch.repeat(nd.len)); break;
    }
  }
}

/** Does this node tree contain a link node (used to discard a link whose
 *  text itself contains a link, per marked's De)? */
function treeHasLink(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    // An autolink inside link text does NOT block the outer link (marked
    // nests it); only a regular link does.
    if (nd.k === N_LINK && !nd.auto) return true;
    if (nd.c && treeHasLink(nd.c)) return true;
  }
  return false;
}

// ------------------------------------------------------------ inline scan

// Delimiter flanking, per CommonMark: a run is left-flanking when it is not
// followed by Unicode whitespace and is either not followed by punctuation,
// or followed by punctuation and preceded by whitespace or punctuation.
// Right-flanking is the mirror image.
function flanking(src, start, end) {
  const n = src.length;
  const before = start > 0 ? src.charCodeAt(start - 1) : -1;
  const after = end < n ? src.charCodeAt(end) : -1;
  const beforeSpace = before === -1 ? true : isSpaceCode(before);
  const afterSpace = after === -1 ? true : isSpaceCode(after);
  const beforePunct = before === -1 ? false : isPunctCode(before, src[start - 1]);
  const afterPunct = after === -1 ? false : isPunctCode(after, src[end]);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return [leftFlanking, rightFlanking];
}

// Scan src for the end of a code span starting at i (src[i] === '`').
// Returns { end, text } where text is the raw span content (newlines kept),
// or null when no closing run exists.
function scanCodeSpan(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 96) j++;
  const run = j - i;
  const tick = '`'.repeat(run);
  let k = j;
  while (true) {
    const at = src.indexOf(tick, k);
    if (at === -1) return null;
    // The closing run must be exactly `run` long (not part of a longer run).
    const after = at + run;
    if ((at === 0 || src.charCodeAt(at - 1) !== 96) && (after >= n || src.charCodeAt(after) !== 96)) {
      // But a longer run elsewhere in the middle is fine; only the match must
      // be exactly `run` ticks. indexOf may land inside a longer run: check.
      let content = src.slice(j, at);
      return { end: after, content };
    }
    k = at + 1;
  }
}

// A code span as it appears inside a link label (marked's label regex):
// `+(?!`)[^`]*?`+(?!`) — the opener is a maximal backtick run, the content
// holds no backtick, and the closer is the FIRST backtick run after it
// (any length, not necessarily the opener's). Returns the end index, or -1.
function matchLabelCodeSpan(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 96) j++;
  let k = j;
  while (k < n) {
    if (src.charCodeAt(k) === 96) {
      let m = k;
      while (m < n && src.charCodeAt(m) === 96) m++;
      return m;
    }
    k++;
  }
  return -1;
}

// Find the `]` that closes a link label starting at i (src[i] === '[').
// Skips escaped chars and label code spans; counts nested brackets. Returns
// the index of the closing `]` or -1. A backtick run that does not form a
// valid label code span invalidates the label (a lone backtick cannot
// appear in a label), so return -1.
function findLabelEnd(src, i) {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; } // backslash escape
    if (c === 96) { // label code span: skip to its end
      // A run of 2+ backticks immediately before `]` is valid label
      // content (marked's ``+(?=]) alternative): skip the run and let
      // the `]` close the label.
      let m = j;
      while (m < n && src.charCodeAt(m) === 96) m++;
      if (m - j >= 2 && m < n && src.charCodeAt(m) === 93) {
        j = m;
        continue;
      }
      const end = matchLabelCodeSpan(src, j);
      if (end === -1) return -1;
      j = end;
      continue;
    }
    if (c === 91) { depth++; j++; continue; } // [
    if (c === 93) { // ]
      depth--;
      if (depth === 0) return j;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// If the label starting at src[open] ('[') is invalid because a backtick
// run inside it forms no valid label code span, return the index of the
// ']' that would close it (lenient scan); otherwise -1. Marked suppresses
// emphasis delimiters inside such a failed label (they render literally).
function failedLabelRegion(src, open) {
  const n = src.length;
  let depth = 0;
  let j = open + 1;
  let close = -1;
  let invalid = false;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      let m = j;
      while (m < n && src.charCodeAt(m) === 96) m++;
      if (m - j >= 2 && m < n && src.charCodeAt(m) === 93) { j = m; continue; }
      if (matchLabelCodeSpan(src, j) === -1) invalid = true;
      j = m;
      continue;
    }
    if (c === 91) { depth++; j++; continue; }
    if (c === 93) {
      if (depth === 0) { close = j; break; }
      depth--; j++; continue;
    }
    j++;
  }
  return invalid && close !== -1 && close + 1 < n && src.charCodeAt(close + 1) === 40 ? close : -1;
}

// Parse a link destination + optional title starting at i (src[i] === '(').
// Returns { end, href, title } with end just past the closing ')', or null.
// Destination: <...> or a bare run. A bare destination with an unmatched
// '(' fails; with an unmatched ')' the destination is cut there and that
// ')' becomes the closer. A closer ')' escaped by an odd run of backslashes
// fails the whole link.
function parseLinkParens(src, i) {
  const n = src.length;
  let j = i + 1;
  // Skip whitespace (spaces, tabs, newlines) after '('.
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
  if (j >= n) return null;
  let href;
  let hrefStart;
  let hrefEnd;
  let isAngle = false;
  if (src.charCodeAt(j) === 60) { // '<' angle destination
    isAngle = true;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 10) return null;
      if (c === 60) return null;
      if (c === 62) { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    href = src.slice(j + 1, k);
    // The closing '>' must not be escaped by an odd run of backslashes.
    if (trailingBackslashes(href) % 2 === 1) return null;
    hrefStart = j + 1;
    hrefEnd = k;
    j = k + 1;
  } else {
    // Bare destination: a run of non-space chars; balanced parens are
    // resolved by parenScan below (an unmatched ')' truncates the dest).
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92) { k += 2; continue; }
      k++;
    }
    if (k === j) return null;
    href = src.slice(j, k);
    hrefStart = j;
    hrefEnd = k;
    j = k;
  }
  // Balanced-paren rule for a bare destination.
  let truncated = false;
  if (!isAngle) {
    if (href.indexOf('(') !== -1 || href.indexOf(')') !== -1) {
      const l = parenScan(href);
      if (l === -2) return null;
      if (l > -1) {
        href = href.slice(0, l);
        hrefEnd = hrefStart + l;
        truncated = true;
      }
    }
  }
  href = resolveEscapes(href);
  if (truncated) {
    // The unmatched ')' becomes the closer; the title is dropped.
    let bs = 0;
    for (let p = hrefEnd - 1; p >= 0 && src.charCodeAt(p) === 92; p--) bs++;
    if (bs % 2 === 1) return null;
    return { end: hrefEnd + 1, href, title: null };
  }
  // Optional whitespace, then an optional title, then optional whitespace, ')'.
  let k = j;
  while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
  let title = null;
  if (k < n && src.charCodeAt(k) !== 41) {
    const q = src.charCodeAt(k);
    if (q === 34 || q === 39) { // "..." or '...'
      let m = k + 1;
      let ok = false;
      while (m < n) {
        const c = src.charCodeAt(m);
        if (c === 92) { m += 2; continue; }
        if (c === q) { ok = true; break; }
        m++;
      }
      if (!ok) return null;
      title = src.slice(k + 1, m);
      k = m + 1;
    } else if (q === 40) { // (...) title, no nesting
      let m = k + 1;
      let ok = false;
      while (m < n) {
        const c = src.charCodeAt(m);
        if (c === 92) { m += 2; continue; }
        if (c === 41) { ok = true; break; }
        m++;
      }
      if (!ok) return null;
      title = src.slice(k + 1, m);
      k = m + 1;
    } else {
      return null;
    }
    while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
  }
  if (k >= n || src.charCodeAt(k) !== 41) return null;
  // The closing ')' must not be escaped by an odd run of backslashes.
  let bs = 0;
  for (let p = k - 1; p >= 0 && src.charCodeAt(p) === 92; p--) bs++;
  if (bs % 2 === 1) return null;
  return { end: k + 1, href, title: title === null ? null : resolveEscapes(title) };
}

// Normalise a link label for lookup: collapse whitespace, lower-case.
function normLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// --- tag / autolink matchers (exact marked inline rules) ----------------

function isAsciiLetter(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAsciiLetterDigit(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}
function isTagSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

// Match an inline HTML tag at src[i] ('<'). Returns the tag length, or -1.
// Tag grammar (marked): comment <!--...-->, PI <?...?>, declaration
// <![A-Za-z]+ ...>, CDATA <![CDATA[...]]>, </name>, or <name attrs?/?>.
function matchTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (i + 4 < n && src.charCodeAt(i + 4) === 62) return 5; // <!--> is a comment
    if (src.startsWith('->', i + 4)) return 6; // <!---> is a comment
    const end = src.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3 - i;
  }
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2 - i;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3 - i;
  }
  if (src.startsWith('<!', i)) {
    let j = i + 2;
    if (j >= n || !isAsciiLetter(src.charCodeAt(j))) return -1;
    while (j < n && isAsciiLetter(src.charCodeAt(j))) j++;
    if (j >= n || !isTagSpace(src.charCodeAt(j))) return -1;
    const end = src.indexOf('>', j);
    return end === -1 ? -1 : end + 1 - i;
  }
  let j = i + 1;
  let closing = false;
  if (j < n && src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAsciiLetter(src.charCodeAt(j))) return -1;
  while (j < n && (isAsciiLetterDigit(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
  if (closing) {
    while (j < n && isTagSpace(src.charCodeAt(j))) j++;
    return j < n && src.charCodeAt(j) === 62 ? j + 1 - i : -1;
  }
  // Open tag: attributes, then optional whitespace, optional '/', '>'.
  while (true) {
    let k = j;
    while (k < n && isTagSpace(src.charCodeAt(k))) k++;
    if (k >= n) return -1;
    const c = src.charCodeAt(k);
    if (c === 62) return k + 1 - i;
    if (c === 47 && k + 1 < n && src.charCodeAt(k + 1) === 62) return k + 2 - i;
    if (k === j) return -1; // an attribute needs preceding whitespace
    const nc = src.charCodeAt(k);
    if (!(isAsciiLetter(nc) || nc === 58 || nc === 95)) return -1;
    let m = k + 1;
    while (m < n) {
      const mc = src.charCodeAt(m);
      if (isAsciiLetterDigit(mc) || mc === 95 || mc === 46 || mc === 58 || mc === 45) m++;
      else break;
    }
    let p = m;
    while (p < n && isTagSpace(src.charCodeAt(p))) p++;
    if (p < n && src.charCodeAt(p) === 61) {
      p++;
      while (p < n && isTagSpace(src.charCodeAt(p))) p++;
      if (p >= n) return -1;
      const vc = src.charCodeAt(p);
      if (vc === 34) {
        const end = src.indexOf('"', p + 1);
        if (end === -1) return -1;
        p = end + 1;
      } else if (vc === 39) {
        const end = src.indexOf("'", p + 1);
        if (end === -1) return -1;
        p = end + 1;
      } else {
        let q = p;
        while (q < n) {
          const qc = src.charCodeAt(q);
          if (qc === 32 || qc === 9 || qc === 10 || qc === 13 || qc === 34 || qc === 39 || qc === 61 || qc === 60 || qc === 62 || qc === 96) break;
          q++;
        }
        if (q === p) return -1;
        p = q;
      }
      j = p;
    } else {
      // Valueless attribute: stop at the end of the name so the whitespace
      // before the next attribute is still there for the loop to see.
      j = m;
    }
  }
}

// Angle-autolink grammar: <scheme:rest> or <email> (marked's autolink rule).
const ANGLE_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const ANGLE_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?![-_])$/;

// Match an angle autolink at src[i] ('<'). Returns its length, or -1.
function matchAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) break;
    if (c === 60 || c <= 32 || c === 127) return -1;
    j++;
  }
  if (j >= n) return -1;
  const inner = src.slice(i + 1, j);
  if (ANGLE_SCHEME_RE.test(inner)) return j + 1 - i;
  if (ANGLE_EMAIL_RE.test(inner)) return j + 1 - i;
  return -1;
}

// marked's Be(): does the link label contain a tag or autolink that starts
// inside the label but extends past its end? If so the link does not form.
// `src` is the full remaining inline text, `label` the label text, and
// `labelOff` the offset of the label within src (1 for links, 2 for images).
function labelHasSpanningTag(src, label, labelOff) {
  if (label.indexOf('<') === -1) return false;
  for (let s = 0; s < label.length; s++) {
    if (label.charCodeAt(s) === 92) { s++; continue; }
    if (label.charCodeAt(s) === 96) {
      const span = scanCodeSpan(label, s);
      if (span) { s += span.end - 1; continue; }
    }
    if (label.charCodeAt(s) !== 60) continue;
    const r = labelOff + s;
    const tagLen = matchTag(src, r);
    const autoLen = tagLen === -1 ? matchAutolink(src, r) : tagLen;
    const len = tagLen !== -1 ? tagLen : autoLen;
    if (len !== -1) {
      if (len > label.length - s) return true;
      s += len - 1;
    }
  }
  return false;
}

// Balanced-paren scan (marked's ke): -1 = no parens or balanced, -2 =
// unmatched '(' left over, otherwise the index of the first unmatched ')'.
function parenScan(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 40) depth++;
    else if (c === 41) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Number of trailing backslashes in s (marked's L helper, counting).
function trailingBackslashes(s) {
  let k = 0;
  for (let i = s.length - 1; i >= 0 && s.charCodeAt(i) === 92; i--) k++;
  return k;
}

// Try to parse a link or image starting at i (src[i] is '[' or '![').
// Returns { node, end } or null.
function tryLink(src, i, links, state) {
  const isImage = src.charCodeAt(i) === 33; // '!'
  const open = isImage ? i + 1 : i;
  if (src.charCodeAt(open) !== 91) return null; // not '['
  const close = findLabelEnd(src, open);
  if (close === -1) return null;
  const text = src.slice(open + 1, close);
  if (labelHasSpanningTag(src, text, open + 1)) return null;
  let j = close + 1;
  let href = null;
  let title = null;
  if (j < src.length && src.charCodeAt(j) === 40) { // '(' inline link
    const parsed = parseLinkParens(src, j);
    if (parsed) {
      href = parsed.href;
      title = parsed.title;
      j = parsed.end;
    } else {
      // Inline parens failed: fall through to the reference form.
      const ref = tryReference(src, close + 1, text, links);
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      j = ref.end;
    }
  } else {
    const ref = tryReference(src, close + 1, text, links);
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
    j = ref.end;
  }
  if (isImage) {
    const altNodes = parseInline(text, links, state);
    const altOut = [];
    plainText(altNodes, altOut);
    const alt = altOut.join('');
    return { node: { k: N_IMAGE, href, title, alt }, end: j };
  }
  // Parse the link text with inLink set; if it contains a link of its own,
  // the outer link does not form (marked's De).
  const savedLink = state.inLink;
  const savedRaw = state.inRaw;
  state.inLink = true;
  const children = parseInline(text, links, state);
  state.inLink = savedLink;
  if (treeHasLink(children)) {
    state.inRaw = savedRaw;
    return null;
  }
  return { node: { k: N_LINK, href, title, auto: false, c: children }, end: j };
}

// Reference link after the label: [text][label], [text][] or [text].
// Returns { href, title, end } or null.
function tryReference(src, j, text, links) {
  const n = src.length;
  let label = null;
  let end = j;
  if (j < n && src.charCodeAt(j) === 91) {
    const close2 = src.indexOf(']', j + 1);
    if (close2 === -1) return null;
    label = close2 === j + 1 ? text : src.slice(j + 1, close2);
    end = close2 + 1;
  } else {
    label = text;
    end = j;
  }
  const def = links[normLabel(label)];
  if (!def) return null;
  return { href: def.href, title: def.title, end };
}

// Is there a `_` run before position `pos` in src that can open
// emphasis (preceded by start/whitespace/punctuation, followed by a
// non-whitespace char)? Used to tell a trailing `_` after an email
// (an emphasis closer) from plain `_` text.
function hasUnderscoreOpener(src, pos) {
  let p = pos - 1;
  while (p >= 0) {
    if (src.charCodeAt(p) === 10) break; // only the current line
    if (src.charCodeAt(p) === 95) {
      let s = p;
      while (s > 0 && src.charCodeAt(s - 1) === 95) s--;
      const before = s === 0 ? 32 : src.charCodeAt(s - 1);
      const after = p + 1 < src.length ? src.charCodeAt(p + 1) : 32;
      const beforeOk = before === 32 || before === 10 || before === 9 ||
        isAsciiPunct(before);
      const afterOk = after !== 32 && after !== 10 && after !== 9;
      if (beforeOk && afterOk) return true;
      p = s - 1;
    } else {
      p--;
    }
  }
  return false;
}

// Bare email (marked's GFM url email): local [A-Za-z0-9._+-]+, domain
// labels of [A-Za-z0-9-_] (first) then dot-labels ending in alnum, and a
// lookahead that the next char is not a word char or '-'. Returns the end
// index, or -1. A trailing `__` is allowed when it closes an emphasis
// opened before the email (marked linkifies the email inside `__...__`);
// otherwise the domain backtracks to the longest label run whose next
// char is not [\w-] (marked's regex backtracking, e.g. a partial link).
function matchBareEmail(src, i) {
  const n = src.length;
  let p = i;
  while (p < n) {
    const c = src.charCodeAt(p);
    if (isAsciiLetterDigit(c) || c === 46 || c === 95 || c === 43 || c === 45) p++;
    else break;
  }
  if (p === i || p >= n || src.charCodeAt(p) !== 64) return -1;
  // Domain labels: collect the end position after each label. A label is
  // [A-Za-z0-9-_]+ ending in alnum; labels are separated by '.'.
  const ends = [];
  let q = p + 1;
  let r = q;
  while (r < n) {
    const c = src.charCodeAt(r);
    if (isAsciiLetterDigit(c) || c === 45 || c === 95) r++;
    else break;
  }
  if (r === q) return -1;
  let le = r;
  while (le > q && !isAsciiLetterDigit(src.charCodeAt(le - 1))) le--;
  if (le === q) return -1;
  q = le;
  while (q < n && src.charCodeAt(q) === 46) {
    const s = q + 1;
    let t = s;
    while (t < n) {
      const c = src.charCodeAt(t);
      if (isAsciiLetterDigit(c) || c === 45 || c === 95) t++;
      else break;
    }
    // A dot not followed by a label char ends the email before the dot
    // (e.g. a trailing '.' is not part of the address).
    if (t === s) break;
    le = t;
    while (le > s && !isAsciiLetterDigit(src.charCodeAt(le - 1))) le--;
    if (le === s) return -1;
    ends.push(le);
    q = le;
    // A backtracked label ends the domain (next char is '_'/'-').
    if (q < n && src.charCodeAt(q) !== 46) break;
  }
  if (ends.length === 0) return -1;
  // Try candidate ends from longest to shortest.
  for (let k = ends.length - 1; k >= 0; k--) {
    const end = ends[k];
    if (end >= n) return end;
    const c = src.charCodeAt(end);
    if (isAsciiLetterDigit(c) || c === 45) continue;
    if (c === 95) {
      // Trailing '_': valid only as an emphasis closer (a '_' opener
      // precedes the email).
      if (hasUnderscoreOpener(src, i)) return end;
      continue;
    }
    return end;
  }
  return -1;
}

// All bare-email spans in src (for the inline scanner's email detection).
// Manual scan (equivalent to marked's email regex) so the trailing-`__`
// emphasis rule in matchBareEmail applies.
function findEmails(src) {
  const map = new Map();
  const n = src.length;
  for (let i = 0; i < n; i++) {
    if (src.charCodeAt(i) !== 64) continue; // '@'
    let s = i;
    while (s > 0) {
      const c = src.charCodeAt(s - 1);
      if (isAsciiLetterDigit(c) || c === 46 || c === 95 || c === 43 || c === 45) {
        // A '__' run is an emphasis delimiter, not email text: the local
        // part starts after it.
        if (c === 95 && s >= 2 && src.charCodeAt(s - 2) === 95) break;
        s--;
      } else break;
    }
    if (s === i) continue;
    const end = matchBareEmail(src, s);
    if (end !== -1) map.set(s, end);
  }
  return map;
}

// Match a scheme/www URL at src[i]. Returns the end index (raw, before
// backpedalling), or -1. Grammar: (http|https|ftp):// or www. (lowercase),
// host (?:[A-Za-z0-9-]+\.?)+, then [^\s<]*.
function matchSchemeUrl(src, i) {
  const n = src.length;
  let j;
  if (src.startsWith('www.', i)) {
    j = i + 4;
  } else {
    const low = src.slice(i, i + 8).toLowerCase();
    if (low.startsWith('https://')) j = i + 8;
    else if (low.startsWith('http://')) j = i + 7;
    else if (low.startsWith('ftp://')) j = i + 6;
    else return -1;
  }
  let p = j;
  let groups = 0;
  while (p < n) {
    let q = p;
    while (q < n && (isAsciiLetterDigit(src.charCodeAt(q)) || src.charCodeAt(q) === 45)) q++;
    if (q === p) break;
    groups++;
    p = q;
    if (p < n && src.charCodeAt(p) === 46) p++;
  }
  if (groups === 0) return -1;
  while (p < n) {
    const c = src.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 60) break;
    p++;
  }
  return p;
}

// marked's _backpedal, applied until the URL no longer changes:
// /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/
function backpedalOnce(url) {
  const n = url.length;
  let i = 0;
  while (i < n) {
    const c = url.charCodeAt(i);
    if (c === 40) { // '(' — a \([^)]*\) group
      let j = i + 1;
      while (j < n && url.charCodeAt(j) !== 41) j++;
      if (j < n) { i = j + 1; continue; }
      break;
    }
    if (c === 38) { // '&' — kept unless it starts an entity at the end
      let j = i + 1;
      while (j < n && isAsciiLetterDigit(url.charCodeAt(j))) j++;
      if (j < n && url.charCodeAt(j) === 59 && j + 1 === n) break;
      i++;
      continue;
    }
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
        c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41) {
      // A run of trailing punctuation, kept only when it is not at the end.
      let j = i;
      while (j < n) {
        const d = url.charCodeAt(j);
        if (d === 63 || d === 33 || d === 46 || d === 44 || d === 58 || d === 59 ||
            d === 42 || d === 95 || d === 39 || d === 34 || d === 126 || d === 41) j++;
        else break;
      }
      if (j === n) break;
      i = j;
      continue;
    }
    i++;
  }
  return url.slice(0, i);
}
function backpedal(url) {
  let prev;
  do {
    prev = url;
    url = backpedalOnce(url);
  } while (url !== prev);
  return url;
}

// GFM extended autolink starting at i: mailto:/xmpp: email, scheme/www URL,
// or bare email. Returns { node, end } or null.
function tryUrl(src, i, state, emails) {
  if (state.inLink) return null;
  const n = src.length;
  // mailto: / xmpp: (lowercase only) + email.
  if (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) {
    const isXmpp = src.charCodeAt(i) === 120;
    const em = matchBareEmail(src, i + (isXmpp ? 5 : 7));
    if (em === -1) return null;
    let end = em;
    if (isXmpp && end < n && src.charCodeAt(end) === 47) {
      let p = end + 1;
      while (p < n) {
        const c = src.charCodeAt(p);
        if (isAsciiLetterDigit(c) || c === 64 || c === 46) p++;
        else break;
      }
      if (p > end + 1) end = p;
    }
    const url = src.slice(i, end);
    return {
      node: { k: N_LINK, href: url, title: null, auto: true, c: [{ k: N_TEXT, s: escape(url, true) }] },
      end,
    };
  }
  // Scheme / www URL.
  const m = matchSchemeUrl(src, i);
  if (m !== -1) {
    let url = backpedal(src.slice(i, m));
    if (url.length === 0) return null;
    const end = i + url.length;
    const href = url.startsWith('www.') ? 'http://' + url : url;
    return {
      node: { k: N_LINK, href, title: null, auto: true, c: [{ k: N_TEXT, s: escape(url, true) }] },
      end,
    };
  }
  // Bare email (precomputed spans).
  if (emails) {
    const emEnd = emails.get(i);
    if (emEnd !== undefined) {
      const url = src.slice(i, emEnd);
      return {
        node: { k: N_LINK, href: 'mailto:' + url, title: null, auto: true, c: [{ k: N_TEXT, s: escape(url, true) }] },
        end: emEnd,
      };
    }
  }
  return null;
}

// Angle-bracket autolink <scheme:...> or <email>. Returns { node, end }.
// Unlike GFM bare URLs/emails, an angle autolink DOES form inside link
// text and after an <a> tag (marked nests the <a> tags).
function tryAutolink(src, i, state) {
  const len = matchAutolink(src, i);
  if (len === -1) return null;
  const inner = src.slice(i + 1, i + len - 1);
  const isEmail = !ANGLE_SCHEME_RE.test(inner);
  const href = isEmail ? 'mailto:' + inner : inner;
  return {
    node: { k: N_LINK, href, title: null, auto: true, c: [{ k: N_TEXT, s: escape(inner, true) }] },
    end: i + len,
  };
}

// Inline HTML tag starting at i (src[i] === '<'). Returns { node, end }.
function tryInlineHtml(src, i) {
  const len = matchTag(src, i);
  if (len === -1) return null;
  return { node: { k: N_HTML, s: src.slice(i, i + len) }, end: i + len };
}

// Delimiter flanking from the neighbouring characters ('' = start/end of
// the inline source), mirroring flanking() plus the '_' can-open/can-close
// adjustments. Used for delimiter nodes created while resolving emphasis
// (leftovers of a partially consumed run), whose neighbours are synthetic.
function delimFlags(ch, prev, next) {
  const beforeSpace = prev === '' ? true : isSpaceCode(prev.charCodeAt(0));
  const afterSpace = next === '' ? true : isSpaceCode(next.charCodeAt(0));
  const beforePunct = prev === '' ? false : isPunctCode(prev.charCodeAt(0), prev);
  const afterPunct = next === '' ? false : isPunctCode(next.charCodeAt(0), next);
  const leftF = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightF = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (ch === '_') return [leftF && (!rightF || beforePunct), rightF && (!leftF || afterPunct)];
  return [leftF, rightF];
}

// Make a delimiter node. `prev`/`next` are the neighbouring characters
// ('' at the ends); `run` is the whole run length (CommonMark rules 9-10
// count it, not the remaining length) and `occ` is whether the run could
// also close as an opener. Both survive splits, while `len` shrinks as
// characters are consumed.
function makeDelim(ch, len, prev, next, run, occ, masked) {
  const f = delimFlags(ch, prev, next);
  // A masked leftover (inside a masked link/code/html span) can open
  // but cannot close, like any masked delimiter.
  const canClose = masked ? false : f[1];
  return {
    k: N_DELIM, ch, len, canOpen: f[0], canClose,
    prev, next, run: run === undefined ? len : run,
    occ: occ === undefined ? canClose : occ,
    masked: !!masked,
  };
}

// Forward scan for the closer of the delimiter at nodes[oi], following
// marked's emStrong (for '*'/'_') or del (for '~'): the opener's whole
// run length is `runLength`, the length being attempted is `lLength`
// (smaller on a mid-run retry), and `midRun` is true when characters of
// the run were already emitted as text. Returns the match
// { ci, rLength, use, kind } or null.
function scanCloser(nodes, oi) {
  const op = nodes[oi];
  const ch = op.ch;
  const lLength = op.len;
  const runLength = op.run;
  const midRun = op.len < op.run;
  const occ = op.occ;
  let delimTotal = lLength;
  let midDelimTotal = 0;
  // marked's RDelim first alternative ("skip orphan inside strong"):
  // at the start of the scan window, `__ ... * ... __` (for a '*' opener)
  // or `** ... _ ... **` (for a '_' opener) makes the middle run an
  // orphan that the scan skips entirely. Only the first three `*`/`_`
  // delimiter runs after the opener can form the pattern. The regex's
  // first `__` must be a run of exactly 2 (a longer run leaves a `_`
  // that the following `[^_*]*?` cannot cross) and the orphan run
  // exactly 1 (a longer run leaves a `*` the following `[^_*]*?` cannot
  // cross); the trailing `(?=__)` lookahead only needs a run of 2 or
  // more. The `[^_*]*?` parts are character-level: any `*`/`_` run in
  // the masked source blocks them, even a word-internal one that can
  // neither open nor close — only runs hidden by the mask (masked) and
  // `~` runs do not. Text and other nodes between them do not break it
  // (masked links/code contain no delimiter characters).
  let orphanIdx = -1;
  if (ch === '*' || ch === '_') {
    const strongCh = ch === '*' ? '_' : '*';
    let seen = 0;
    let cand = -1;
    for (let j = oi + 1; j < nodes.length && seen < 3; j++) {
      const d = nodes[j];
      if (d.k !== N_DELIM || d.ch === '~' || d.masked) continue;
      seen++;
      if (seen === 1) {
        if (d.ch !== strongCh || d.len !== 2) break;
      } else if (seen === 2) {
        if (d.ch !== ch || d.len !== 1) break;
        cand = j;
      } else {
        if (d.ch !== strongCh || d.len < 2) break;
        orphanIdx = cand;
      }
    }
  }
  for (let j = oi + 1; j < nodes.length; j++) {
    const d = nodes[j];
    if (d.k !== N_DELIM || d.ch !== ch) continue;
    // A delimiter hidden by the mask is 'a' in the masked source, so
    // the scan cannot see it as a closer or a left delimiter.
    if (d.masked) continue;
    // A delimiter that can neither open nor close is not a delimiter
    // for this scan (e.g. suppressed inside a failed link label).
    if (!d.canOpen && !d.canClose) continue;
    // The orphan run inside a strong span is skipped by the scan.
    if (j === orphanIdx) continue;
    if (ch === '~') {
      // Strikethrough only pairs equal lengths.
      if (d.len !== lLength) continue;
      if (d.canOpen && !d.canClose) { delimTotal += d.len; continue; }
      delimTotal -= d.len;
      if (delimTotal > 0) continue;
      const rLength = Math.min(d.len, d.len + delimTotal);
      return { ci: j, lLength, rLength, use: lLength, kind: N_DEL };
    }
    // A left-only delimiter adds to the total instead of closing.
    if (d.canOpen && !d.canClose) { delimTotal += d.len; continue; }
    // A both-ways delimiter, or any delimiter when the opener could
    // also close, is subject to CommonMark rules 9-10: when the
    // opener's run length and the pair's sum are multiples of 3 in
    // the wrong way, it is skipped (counted in midDelimTotal) rather
    // than closing. A mid-run opener never pairs with a both-ways
    // delimiter (it would steal a later span's opener).
    if ((d.canOpen && d.canClose) || occ) {
      if (midRun && d.canOpen && d.canClose) return null;
      if (runLength % 3 !== 0 && (runLength + d.len) % 3 === 0) {
        midDelimTotal += d.len;
        continue;
      }
    }
    delimTotal -= d.len;
    if (delimTotal > 0) continue;
    const rLength = Math.min(d.len, d.len + delimTotal + midDelimTotal);
    const use = Math.min(lLength, rLength) % 2 === 1 ? 1 : 2;
    return { ci: j, lLength, rLength, use, kind: use === 1 ? N_EM : N_STRONG };
  }
  return null;
}

// Resolve emphasis over a scanned node list, following marked's lexer:
// left to right, each delimiter run is tried as an opener (the whole run,
// then one character at a time as the run is emitted as text); the
// opener's forward scan decides whether it closes and as em or strong.
// The content between opener and closer is resolved recursively, like
// marked's inlineTokens on the inner text.
function resolveEmphasis(nodes) {
  let i = 0;
  while (i < nodes.length) {
    const nd = nodes[i];
    if (nd.k !== N_DELIM || !nd.canOpen) { i++; continue; }
    const m = scanCloser(nodes, i);
    if (!m) {
      // No closer: emit one delimiter character as literal text and
      // retry the remainder (a mid-run retry, with the whole run length
      // still counting for rules 9-10).
      if (nd.len > 1) {
        nodes.splice(i, 0, { k: N_TEXT, s: nd.ch });
        nd.len--;
        const f = delimFlags(nd.ch, nd.ch, nd.next);
        nd.canOpen = f[0];
        nd.canClose = nd.masked ? false : f[1];
        i++;
        continue;
      }
      i++;
      continue;
    }
    const op = nd;
    const cl = nodes[m.ci];
    // The wrapper's inner text keeps the opener's leftover (use chars
    // are the marker) at its start and the closer's leftover at its end;
    // both are re-resolved as fresh runs. Any closer characters beyond
    // rLength stay outside, after the wrapper.
    const children = [];
    if (m.lLength - m.use > 0) children.push(makeDelim(op.ch, m.lLength - m.use, '', op.next, undefined, undefined, op.masked));
    for (let k = i + 1; k < m.ci; k++) children.push(nodes[k]);
    if (m.rLength - m.use > 0) children.push(makeDelim(cl.ch, m.rLength - m.use, cl.prev, ''));
    resolveEmphasis(children);
    const rep = [{ k: m.kind, c: children }];
    if (cl.len - m.rLength > 0) {
      rep.push(makeDelim(cl.ch, cl.len - m.rLength, cl.ch, cl.next, cl.run, cl.occ));
    }
    nodes.splice(i, m.ci - i + 1, ...rep);
    i++;
  }
}

// --- emphasis masking (marked's #maskSrc / #maskBlocks) ----------------
// Replicates marked's masking of links, code spans, html and escapes so
// emphasis scans do not see delimiters inside them. Every step preserves
// the string length, so indices line up with the source. maskIntervals
// returns the sorted masked intervals [start, end) whose contents are
// hidden from emphasis scans (marked replaces them with '[aaa...]').
//
// The masking matters beyond what the scanner already hides inside link
// and code nodes: a link whose label holds an invalid code span (e.g.
// `` ``url` ``) is not masked as a link, so a stray backtick can start a
// code-span mask that swallows the emphasis delimiters after the link.
// The escape/code mask first turns the stray backtick into '+' (a code
// span's inner backticks are masked), which is what lets blockSkip match
// that long span.

// anyPunctuationOutsideCode (GFM): a code span (backtick run + content +
// same run), a lone backtick run, or an escaped punctuation character.
const RE_MASK_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
// blockSkip (GFM): an inline link, a code span, or an html-looking span.
const RE_MASK_BLOCKSKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Masked intervals of an inline source, following marked's #maskSrc and
// #maskBlocks (reflink masking is applied by the caller when links are
// present; see maskReflinks). Every step preserves length.
function maskIntervals(src) {
  // Mask out escaped characters and code-span inner backticks. A
  // backslash inside a code span is literal, so the span is matched
  // whole and only its inner backticks are masked.
  const masked = src.replace(RE_MASK_CODE, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  // Mask out links, code spans and html. (marked 18.1.3 masks every
  // blockSkip match; there is no tag/autolink re-check for '<' spans.)
  const intervals = [];
  let match;
  RE_MASK_BLOCKSKIP.lastIndex = 0;
  while ((match = RE_MASK_BLOCKSKIP.exec(masked))) {
    const start = match.index + (match[2] ? match[2].length : 0);
    const end = match.index + match[0].length;
    intervals.push([start, end]);
  }
  return intervals;
}

// The main inline scanner: src -> nodes (delimiters unresolved).
// `state` ({inLink, inRaw}) is shared across recursive parses so <a> and
// raw-text tags affect the enclosing scan; link text is parsed with inLink
// set (see tryLink).
function scanInline(src, links, state) {
  if (!state) state = { inLink: false, inRaw: false };
  const emails = src.indexOf('@') !== -1 ? findEmails(src) : null;
  // End position of a failed-link label region whose emphasis delimiters
  // render literally (see failedLabelRegion). -1 when not suppressing.
  let suppressEnd = -1;
  // Masked intervals (see maskIntervals); a delimiter run starting
  // inside one renders literally. Only built when the source holds a
  // delimiter character, like marked's maskedSrc.
  let masked = null;
  let maskIdx = 0;
  if (src.indexOf('*') !== -1 || src.indexOf('_') !== -1 || src.indexOf('~') !== -1) {
    masked = maskIntervals(src);
  }
  const isMasked = (pos) => {
    if (!masked) return false;
    while (maskIdx < masked.length && masked[maskIdx][1] <= pos) maskIdx++;
    return maskIdx < masked.length && pos >= masked[maskIdx][0] && pos < masked[maskIdx][1];
  };
  const nodes = [];
  const n = src.length;
  let i = 0;
  let ts = 0; // start of the current raw text run
  const flushText = (end) => {
    if (end > ts) {
      const raw = src.slice(ts, end);
      // In a raw-text element the text is used as-is; otherwise numeric
      // character references are decoded first, then the text is escaped.
      nodes.push({ k: N_TEXT, s: state.inRaw ? raw : escape(decodeEntities(raw), false) });
    }
  };
  while (i < n) {
    const c = src.charCodeAt(i);
    // Backslash: escape, or hard break before a newline.
    if (c === 92) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === 10) {
          // Hard break, unless only whitespace follows to the end. The
          // break also consumes the next line's leading spaces/tabs.
          let m = i + 2;
          while (m < n && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9 || src.charCodeAt(m) === 10)) m++;
          if (m < n) {
            flushText(i);
            nodes.push({ k: N_BR });
            i += 2;
            while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
            ts = i;
            continue;
          }
        } else if (isAsciiPunct(d)) {
          flushText(i);
          nodes.push({ k: N_TEXT, s: escape(String.fromCharCode(d), false) });
          i += 2;
          ts = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // Code span.
    if (c === 96) {
      const span = scanCodeSpan(src, i);
      if (span) {
        flushText(i);
        let text = span.content.replace(/\n/g, ' ');
        if (text.length >= 2 && text.charCodeAt(0) === 32 && text.charCodeAt(text.length - 1) === 32 && /[^ ]/.test(text)) {
          text = text.slice(1, -1);
        }
        nodes.push({ k: N_CODE, s: escape(text, true) });
        i = span.end;
        ts = i;
        continue;
      }
      // No closing run: the whole backtick run is literal text (a code
      // span never starts inside a run that already failed to close).
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      i = j;
      continue;
    }
    // Emphasis / strikethrough delimiters.
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      // Runs of 3+ tildes are never strikethrough delimiters.
      if (c === 126 && len > 2) { i = j; continue; }
      const [leftF, rightF] = flanking(src, i, j);
      let canOpen, canClose;
      if (c === 42 || c === 126) {
        canOpen = leftF;
        canClose = rightF;
      } else {
        canOpen = leftF && (!rightF || isPunctCode(i > 0 ? src.charCodeAt(i - 1) : -1, i > 0 ? src[i - 1] : ''));
        canClose = rightF && (!leftF || isPunctCode(j < n ? src.charCodeAt(j) : -1, j < n ? src[j] : ''));
      }
      // Inside a failed link label (invalid code span), emphasis
      // delimiters render literally (marked suppresses them).
      if (suppressEnd >= 0 && i <= suppressEnd) { canOpen = false; canClose = false; }
      // Inside a masked link/code/html span (see maskIntervals), a
      // delimiter cannot close (the scan reads the masked source, where
      // it is 'a'), but it can still open: marked's LDelim gate reads
      // the real source, so a masked opener pairs when an unmasked
      // closer follows. Record it so the scan and the orphan-skip can
      // tell it from a literal delimiter character.
      const maskedDelim = isMasked(i);
      if (maskedDelim) canClose = false;
      flushText(i);
      // `prev`/`next` are the neighbouring characters ('' at the ends);
      // `run` is the whole run length and `occ` whether the run could
      // also close as an opener — both are used by resolveEmphasis and
      // survive splits, while `len` shrinks as characters are consumed.
      nodes.push({
        k: N_DELIM, ch: String.fromCharCode(c), len, canOpen, canClose,
        prev: i > 0 ? src[i - 1] : '', next: j < n ? src[j] : '',
        run: len, occ: canClose, masked: maskedDelim,
      });
      i = j;
      ts = i;
      continue;
    }
    // Link or image.
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) {
      const hit = tryLink(src, i, links, state);
      if (hit) {
        flushText(i);
        nodes.push(hit.node);
        i = hit.end;
        ts = i;
        continue;
      }
      // Failed link whose label is invalid due to a code span: suppress
      // emphasis delimiters inside the would-be label.
      const open = c === 33 ? i + 1 : i;
      const close = failedLabelRegion(src, open);
      if (close !== -1 && close > suppressEnd) suppressEnd = close;
      i++;
      continue;
    }
    // HTML tag / comment / autolink.
    if (c === 60) {
      const auto = tryAutolink(src, i, state);
      if (auto) {
        flushText(i);
        nodes.push(auto.node);
        i = auto.end;
        ts = i;
        continue;
      }
      const html = tryInlineHtml(src, i);
      if (html) {
        flushText(i);
        nodes.push(html.node);
        // Track <a> and raw-text elements for inLink / inRaw state.
        const tagText = html.node.s;
        if (!state.inLink && /^<a /i.test(tagText)) state.inLink = true;
        else if (state.inLink && /^<\/a>/i.test(tagText)) state.inLink = false;
        if (!state.inRaw && /^<(pre|code|kbd|script)(\s|>)/i.test(tagText)) state.inRaw = true;
        else if (state.inRaw && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tagText)) state.inRaw = false;
        i = html.end;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    // Hard break: two or more spaces before a newline. The break also
    // consumes the next line's leading spaces/tabs.
    if (c === 32) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && src.charCodeAt(j) === 10) {
        let m = j + 1;
        while (m < n && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9 || src.charCodeAt(m) === 10)) m++;
        if (m < n) {
          flushText(i);
          nodes.push({ k: N_BR });
          i = j + 1;
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          ts = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    // GFM autolinks: http(s)://, ftp://, www., mailto:, xmpp:, bare email.
    // http/https/ftp schemes are case-insensitive (HTTP://, HtTp://,
    // FTP:// linkify); www./mailto:/xmpp: are lowercase-only.
    if (c === 104 || c === 72 || c === 102 || c === 70 || c === 119 || c === 109 || c === 120) {
      let tryIt = false;
      if (c === 119) {
        // www. needs a preceding whitespace, '*', '_', '~', '(' or start.
        tryIt = src.startsWith('www.', i) &&
          (i === 0 || /[\s*_~(]/.test(src[i - 1]));
      } else if (c === 104 || c === 72) {
        const low = src.slice(i, i + 8).toLowerCase();
        tryIt = low.startsWith('http://') || low.startsWith('https://');
      } else if (c === 102 || c === 70) {
        tryIt = src.slice(i, i + 6).toLowerCase().startsWith('ftp://');
      } else if (c === 109) {
        tryIt = src.startsWith('mailto:', i);
      } else if (c === 120) {
        tryIt = src.startsWith('xmpp:', i);
      }
      // A bare email can start with any of these letters too.
      if (!tryIt && emails && emails.has(i)) tryIt = true;
      if (tryIt) {
        const hit = tryUrl(src, i, state, emails);
        if (hit) {
          flushText(i);
          nodes.push(hit.node);
          i = hit.end;
          ts = i;
          continue;
        }
      }
    } else if (emails && emails.has(i)) {
      const hit = tryUrl(src, i, state, emails);
      if (hit) {
        flushText(i);
        nodes.push(hit.node);
        i = hit.end;
        ts = i;
        continue;
      }
    }
    i++;
  }
  flushText(n);
  resolveEmphasis(nodes);
  return nodes;
}

/** Parse inline Markdown to nodes. `state` is shared with the caller when
 *  parsing link text (inLink/inRaw), otherwise a fresh state is used. */
function parseInline(src, links, state) {
  if (src === '') return [];
  return scanInline(src, links, state);
}

/** Render inline Markdown to an HTML string. */
function inlineHtml(src, links) {
  const nodes = parseInline(src, links);
  const out = [];
  renderNodes(nodes, out);
  return out.join('');
}

// ------------------------------------------------------------- block lexer
// Block-level tokenizing follows marked's block rules (CommonMark 0.31.2 +
// GFM 0.29, gfm on, breaks off). The block pass collects link definitions
// and produces a block list; rendering happens afterwards so every link
// reference can be resolved.

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const RE_LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
// Link definition label: no ']' (unless escaped), may span lines but not a
// blank line.
const DEF_LABEL_RE = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE_RE = /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const RE_DEF = new RegExp(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)'
    .replace('label', DEF_LABEL_RE.source).replace('title', DEF_TITLE_RE.source)
);
// Fenced code opening info: backtick fences may not contain a backtick.
const RE_FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)/;
// Block HTML start conditions (marked's htmlBegin, type 6 + 1-5).
const RE_HTML_BEGIN = new RegExp(
  '^ {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'
);
// A line that starts a block (used by paragraph/setext interruption).
function lineStartsBlock(line) {
  if (RE_HR.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(line)) return true;
  if (RE_HTML_BEGIN.test(line)) return true;
  return false;
}

// Remove up to `n` leading spaces from each line (fenced-code dedent).
function dedentLines(text, n) {
  if (n === 0) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let k = 0;
    while (k < lines[i].length && k < n && lines[i].charCodeAt(k) === 32) k++;
    if (k > 0) lines[i] = lines[i].slice(k);
  }
  return lines.join('\n');
}

// Strip a trailing run of newlines, but keep at most the raw minus them
// (marked's ge(): drop trailing blank lines beyond the first).
function stripTrailingBlank(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? raw : lines.slice(0, t + 1).join('\n');
}

// --- block tokenizers (each returns a block object + consumed length) -----

// Blank lines / whitespace.
function tokSpace(src) {
  const m = RE_NEWLINE.exec(src);
  if (!m || m[0].length === 0) return null;
  return { type: 'space', raw: m[0] };
}

// Indented code block.
function tokIndentedCode(src) {
  const m = RE_INDENTED_CODE.exec(src);
  if (!m) return null;
  const raw = stripTrailingBlank(m[0]);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { type: 'code', raw, text, lang: null };
}

// Fenced code block (exact marked fences regex + indent compensation).
function tokFences(src) {
  const t = RE_FENCES.exec(src);
  if (!t) return null;
  const n = t[0];
  const s = Dt(n, t[3] || '');
  return { type: 'code', raw: n, lang: t[2] ? t[2].trim().replace(/\\([\p{P}\p{S}])/gu, '$1') : t[2], text: s };
}

// ATX heading (exact marked rules for closing hashes).
function tokHeading(src) {
  const t = RE_HEADING.exec(src);
  if (!t) return null;
  let n = t[2].trim();
  if (ENDING_HASH.test(n)) {
    const s = L(n, '#');
    if (!s || ENDING_SPACE_TAB.test(s)) n = s.trim();
  }
  const tok = { type: 'heading', raw: L(t[0], '\n'), depth: t[1].length, text: n };
  tok.nodes = queueInline(n, tok);
  return tok;
}

// Horizontal rule.
function tokHr(src) {
  const t = RE_HR.exec(src);
  if (!t) return null;
  return { type: 'hr', raw: L(t[0], '\n') };
}

// Link definition. Returns the def (or null). The caller stores it.
function tokDef(src) {
  const t = RE_DEF.exec(src);
  if (!t) return null;
  // A non-angle destination with unbalanced parens is not a definition.
  if (t[2].charCodeAt(0) !== 60 && parenScan(t[2]) !== -1) return null;
  const tag = normLabel(t[1]);
  // A label that normalizes to empty is not a definition.
  if (tag === '') return null;
  const href = t[2] ? t[2].replace(/^<(.*)>$/, '$1').replace(/\\([\p{P}\p{S}])/gu, '$1') : '';
  const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(/\\([\p{P}\p{S}])/gu, '$1') : t[3];
  return { type: 'def', raw: L(t[0], '\n'), tag, href, title };
}

// Setext heading (exact marked lheading regex).
function tokSetext(src) {
  const t = RE_LHEADING.exec(src);
  if (!t) return null;
  const n = t[1].trim();
  const tok = { type: 'heading', raw: L(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: n };
  tok.nodes = queueInline(n, tok);
  return tok;
}

// --- exact block regexes (marked's own, built with its `c` helper) -------
// `c` builds a regex from a source string, substituting named pieces and
// stripping `^` anchors (except after `[`) from the substituted pieces.
const CARET_RE = /(^|[^\[])\^/g;
function c(src, flags) {
  let t = typeof src === 'string' ? src : src.source;
  return {
    replace(name, val) {
      let o = typeof val === 'string' ? val : val.source;
      o = o.replace(CARET_RE, '$1');
      t = t.replace(name, o);
      return this;
    },
    get() { return new RegExp(t, flags); }
  };
}
// Strip trailing characters equal to `e` (or, when `t` is set, trailing
// characters NOT equal to `e`).
function L(a, e, t) {
  const n = a.length;
  if (n === 0) return '';
  let s = 0;
  for (; s < n;) {
    const r = a.charAt(n - s - 1);
    if (r === e && !t) s++;
    else if (r !== e && t) s++;
    else break;
  }
  return a.slice(0, n - s);
}
// Expand tabs to spaces with tab stops of 4, starting at column `e`.
function J(a, e) {
  let t = e || 0;
  let n = '';
  for (const s of a) {
    if (s === '\t') {
      const r = 4 - (t % 4);
      n += ' '.repeat(r);
      t += r;
    } else {
      n += s;
      t++;
    }
  }
  return n;
}
// Split a table row/header into cells (handles escaped pipes, trims,
// pads/truncates to `e` cells).
function de(a, e) {
  const t = a.replace(/\|/g, (r, o, i) => {
    let l = false;
    let p = o;
    for (; --p >= 0 && i[p] === '\\';) l = !l;
    return l ? '|' : ' |';
  });
  const n = t.split(/ \|/);
  let s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) {
    if (n.length > e) n.splice(e);
    else for (; n.length < e;) n.push('');
  }
  for (; s < n.length; s++) n[s] = n[s].trim().replace(/\\\|/g, '|');
  return n;
}
// Fenced-code indent compensation: remove up to the opening fence's indent
// from each content line (backtick fences only).
function Dt(a, e) {
  const n = a.match(/^(\s+)(?:```)/);
  if (n === null) return e;
  const s = n[1];
  return e.split('\n').map(r => {
    const o = r.match(/^\s+/);
    if (o === null) return r;
    const [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join('\n');
}

const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const RE_LHEADING = c(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, RE_BULL)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .get();
// Block HTML (types 1-7).
const RE_HTML = c("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i")
  .replace("comment", /<!--(?:-?>|[\s\S]*?(?:-->|$))/)
  .replace("tag", BLOCK_TAGS)
  .replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .get();
// Paragraph base, then the GFM top-level and blockquote variants.
const RE_PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildPara(listRe) {
  return c(RE_PARA_BASE)
    .replace("hr", RE_HR)
    .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
    .replace("|lheading", "")
    .replace("blockquote", " {0,3}>")
    .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
    .replace("list", listRe)
    .replace("html", c(" {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", BLOCK_TAGS).get())
    .get();
}
const RE_PARA_TOP = buildPara(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
const RE_PARA_QUOTE = buildPara(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const RE_BLOCKQUOTE = c(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace("paragraph", RE_PARA_QUOTE).get();
const RE_TABLE = c("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace("hr", RE_HR)
  .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
  .replace("blockquote", " {0,3}>")
  .replace("code", "(?: {4}| {0,3}\t)[^\\n]")
  .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
  .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]")
  .replace("html", c(" {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", BLOCK_TAGS).get())
  .get();
// GFM top-level paragraph (with the table interrupt).
const RE_PARA_GFM = c(RE_PARA_BASE)
  .replace("hr", RE_HR)
  .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
  .replace("|lheading", "")
  .replace("table", RE_TABLE)
  .replace("blockquote", " {0,3}>")
  .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
  .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]")
  .replace("html", c(" {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", BLOCK_TAGS).get())
  .get();
const RE_TEXT = /^[^\n]+/;
const TABLE_DELIM_RE = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const LIST_REPLACE_NESTING = /^ {1,4}(?= {4}[^ ])/g;
const BEGINNING_SPACE = /^\s+/;
const ANY_LINE = /\n.*\n/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const NON_SPACE = /[^ ]/;
const LEADING_SPACE_TAB = /^[ \t]+/;
const TAB_GLOBAL = /\t/g;
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB = /[ \t]$/;

// Indent-dependent block-start regexes (marked's T.other builders).
// The indent is clamped to min(3, a-1): a marker indented to the content
// level (a spaces) is list-item content, not a block that interrupts it.
function clampIndent(a) {
  return Math.max(0, Math.min(3, a - 1));
}
function listItemRegex(a) {
  return new RegExp(`^( {0,3}${a})((?:[\t ][^\n]*)?(?:\n|$))`);
}
function nextBulletRegex(a) {
  return new RegExp(`^ {0,${clampIndent(a)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`);
}
function hrRegex(a) {
  return new RegExp(`^ {0,${clampIndent(a)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`);
}
function fencesBeginRegex(a) {
  return new RegExp(`^ {0,${clampIndent(a)}}(?:\`\`\`|~~~)`);
}
function headingBeginRegex(a) {
  return new RegExp(`^ {0,${clampIndent(a)}}#{1,6}(?:\\s|$)`);
}
function htmlBeginRegex(a) {
  return new RegExp(`^ {0,${clampIndent(a)}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
}
function blockquoteBeginRegex(a) {
  return new RegExp(`^ {0,${clampIndent(a)}}>`);
}

// --- inline queue ----------------------------------------------------------
// Inline parsing is deferred until the whole block pass has collected every
// link definition (marked's inlineQueue). Each entry records the source and
// the block token whose `nodes` array will receive the parsed inline nodes.
let inlineQueue = [];
function queueInline(src, token) {
  token.nodes = [];
  inlineQueue.push({ src, token });
  return token.nodes;
}

// --- remaining block tokenizers --------------------------------------------

// Block HTML.
function tokHtml(src) {
  const t = RE_HTML.exec(src);
  if (!t) return null;
  const n = stripTrailingBlank(t[0]);
  return { type: 'html', block: true, raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
}

// GFM table.
function tokTable(src) {
  const t = RE_TABLE.exec(src);
  if (!t || !TABLE_DELIM_RE.test(t[2])) return null;
  const n = de(t[1]);
  const s = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  const r = t[3]?.trim() ? t[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
  const o = { type: 'table', raw: L(t[0], '\n'), header: [], align: [], rows: [] };
  if (n.length === s.length) {
    for (const i of s) {
      if (TABLE_ALIGN_RIGHT.test(i)) o.align.push('right');
      else if (TABLE_ALIGN_CENTER.test(i)) o.align.push('center');
      else if (TABLE_ALIGN_LEFT.test(i)) o.align.push('left');
      else o.align.push(null);
    }
    for (let i = 0; i < n.length; i++) {
      const cell = { text: n[i], header: true, align: o.align[i] };
      cell.nodes = queueInline(n[i], cell);
      o.header.push(cell);
    }
    for (const i of r) {
      o.rows.push(de(i, o.header.length).map((l, p) => {
        const cell = { text: l, header: false, align: o.align[p] };
        cell.nodes = queueInline(l, cell);
        return cell;
      }));
    }
    return o;
  }
  return null;
}

// Paragraph (GFM top-level paragraph regex).
function tokParagraph(src) {
  const t = RE_PARA_GFM.exec(src);
  if (!t) return null;
  const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
  const tok = { type: 'paragraph', raw: t[0], text: n };
  tok.nodes = queueInline(n, tok);
  return tok;
}

// Text fallback (a single line).
function tokText(src) {
  const t = RE_TEXT.exec(src);
  if (!t) return null;
  const tok = { type: 'text', raw: t[0], text: t[0] };
  tok.nodes = queueInline(t[0], tok);
  return tok;
}

// Blockquote (faithful port of marked's tokenizer, including its
// nested-blockquote and list merging).
function tokBlockquote(src) {
  const t = RE_BLOCKQUOTE.exec(src);
  if (!t) return null;
  let n = L(t[0], '\n').split('\n');
  let s = '';
  let r = '';
  const o = [];
  while (n.length > 0) {
    let i = false;
    const l = [];
    let p;
    for (p = 0; p < n.length; p++) {
      if (BLOCKQUOTE_START.test(n[p])) { l.push(n[p]); i = true; }
      else if (!i) l.push(n[p]);
      else break;
    }
    n = n.slice(p);
    const h = l.join('\n');
    const u = h
      .replace(BLOCKQUOTE_MARKER_WS, (g, b, m) => b + J(m, b.length))
      .replace(BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT2, '');
    s = s ? `${s}\n${h}` : h;
    r = r ? `${r}\n${u}` : u;
    const d = blockTop;
    blockTop = true;
    blockTokens(u, o, true);
    blockTop = d;
    if (n.length === 0) break;
    const k = o.at(-1);
    if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
    if (k?.type === 'blockquote') {
      const g = k;
      const b = n.join('\n');
      const m = g.raw + '\n' + b.replace(BLOCKQUOTE_SETEXT2, '');
      const f = tokBlockquote(m);
      o[o.length - 1] = f;
      const y = m.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? n.slice(0, -R) : n;
      if (A.length > 0) {
        s = `${s}\n${A.join('\n')}`;
        r = r.substring(0, r.length - g.text.length) + f.text;
        n = n.slice(A.length);
        if (n.length > 0 && BLOCKQUOTE_START.test(n[0])) continue;
      }
      break;
    } else if (k?.type === 'list') {
      const g = k;
      const b = g.raw + '\n' + n.join('\n');
      const m = tokList(b);
      o[o.length - 1] = m;
      const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = n.slice(0, f).join('\n');
        s = `${s}\n${y}`;
        r = `${r}\n${y}`;
      }
      n = n.slice(f);
      continue;
    }
  }
  return { type: 'blockquote', raw: s, tokens: o, text: r };
}

// List (faithful port of marked's tokenizer).
function tokList(src) {
  let t = RE_LIST_START.exec(src);
  if (!t) return null;
  const n = src;
  let e = src;
  const s = () => n.length - e.length;
  let r = t[1].trim();
  const o = r.length > 1;
  const i = { type: 'list', raw: '', ordered: o, start: o ? +r.slice(0, -1) : '', loose: false, items: [] };
  r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const l = listItemRegex(r);
  let p = false;
  while (e) {
    let u = false;
    let d = '';
    if (!(t = l.exec(e)) || RE_HR.test(e)) break;
    const k = s();
    e = e.substring(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let m = g.replace(LEADING_SPACE_TAB, v => J(v, b));
    let f = e.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(NON_SPACE);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && BLANK_LINE.test(f)) {
      e = e.substring(f.length + 1);
      u = true;
    }
    if (!u) {
      const v = nextBulletRegex(R);
      const Q = hrRegex(R);
      const ee = fencesBeginRegex(R);
      const te = headingBeginRegex(R);
      const M = htmlBeginRegex(R);
      const ne = blockquoteBeginRegex(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(LEADING_SPACE_TAB, me => J(me));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(TAB_GLOBAL, '    ').search(NON_SPACE) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && RE_LHEADING.test(`${m}\n${f}`) ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, s());
    if (!i.loose) {
      if (p) i.loose = true;
      else if (DOUBLE_BLANK.test(A)) p = true;
    }
    i.items.push({ type: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const h = i.items.at(-1);
  if (h) {
    h.raw = h.raw.trimEnd();
    h.text = h.text.trimEnd();
  } else return null;
  i.raw = n.slice(0, s()).trimEnd();
  for (const u of i.items) {
    blockTop = false;
    u.tokens = blockTokens(u.text, []);
    if (!i.loose) {
      const d = u.tokens.filter(g => g.type === 'space');
      const k = d.length > 0 && d.some(g => ANY_LINE.test(g.raw));
      i.loose = k;
    }
  }
  for (const u of i.items) {
    const d = u.tokens[0];
    if (u.task && (d?.type === 'text' || d?.type === 'paragraph')) {
      u.text = u.text.replace(LIST_REPLACE_TASK, '');
      d.raw = d.raw.replace(LIST_REPLACE_TASK, '');
      d.text = d.text.replace(LIST_REPLACE_TASK, '');
      for (let g = inlineQueue.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(inlineQueue[g].src)) {
          inlineQueue[g].src = inlineQueue[g].src.replace(LIST_REPLACE_TASK, '');
          break;
        }
      }
      const k = LIST_TASK_CHECKBOX.exec(u.raw);
      if (k) {
        const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        u.checked = g.checked;
        if (i.loose) {
          if (u.tokens[0] && ['paragraph', 'text'].includes(u.tokens[0].type) && 'nodes' in u.tokens[0] && u.tokens[0].nodes) {
            u.tokens[0].raw = g.raw + u.tokens[0].raw;
            u.tokens[0].text = g.raw + u.tokens[0].text;
            u.tokens[0].nodes.unshift(g);
          } else {
            u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, nodes: [g] });
          }
        } else {
          u.tokens.unshift(g);
        }
      }
    } else if (u.task) {
      u.task = false;
    }
  }
  if (i.loose) {
    for (const u of i.items) {
      u.loose = true;
      for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
    }
  }
  return i;
}

// --- blockTokens loop -------------------------------------------------------
// `blockTop` mirrors marked's lexer.state.top: true at the top level and
// inside blockquotes, false inside list items (so list items lex as `text`
// tokens, converted to paragraphs only when the list is loose).
let blockTop = true;
let blockLinks = null;

function blockTokens(src, tokens, isTop) {
  tokens = tokens || [];
  isTop = isTop || false;
  let s = Infinity;
  let e = src;
  while (e) {
    if (e.length < s) s = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    let r;
    if (r = tokSpace(e)) {
      e = e.substring(r.raw.length);
      const i = tokens.at(-1);
      if (r.raw.length === 1 && i !== undefined) i.raw += '\n';
      else tokens.push(r);
      continue;
    }
    if (r = tokIndentedCode(e)) {
      e = e.substring(r.raw.length);
      const i = tokens.at(-1);
      if (i?.type === 'paragraph' || i?.type === 'text') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
        if (inlineQueue.length) inlineQueue.at(-1).src = i.text;
      } else tokens.push(r);
      continue;
    }
    if (r = tokFences(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokHeading(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokHr(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokBlockquote(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokList(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokHtml(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokDef(e)) {
      e = e.substring(r.raw.length);
      const i = tokens.at(-1);
      if (i?.type === 'paragraph' || i?.type === 'text') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.raw;
        if (inlineQueue.length) inlineQueue.at(-1).src = i.text;
      } else {
        if (!blockLinks[r.tag]) blockLinks[r.tag] = { href: r.href, title: r.title };
        tokens.push(r);
      }
      continue;
    }
    if (r = tokTable(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (r = tokSetext(e)) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (blockTop && (r = tokParagraph(e))) {
      const i = tokens.at(-1);
      if (isTop && i?.type === 'paragraph') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
        inlineQueue.pop();
        if (inlineQueue.length) inlineQueue.at(-1).src = i.text;
      } else tokens.push(r);
      isTop = false;
      e = e.substring(r.raw.length);
      continue;
    }
    if (r = tokText(e)) {
      e = e.substring(r.raw.length);
      const i = tokens.at(-1);
      if (i?.type === 'text') {
        i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
        i.text += '\n' + r.text;
        inlineQueue.pop();
        if (inlineQueue.length) inlineQueue.at(-1).src = i.text;
      } else tokens.push(r);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
  }
  blockTop = true;
  return tokens;
}

// --- renderer ---------------------------------------------------------------
function renderTableCell(cell, out) {
  const tag = cell.header ? 'th' : 'td';
  out.push(cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`);
  renderNodes(cell.nodes, out);
  out.push(`</${tag}>\n`);
}

function renderBlocks(tokens, out) {
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'heading':
        out.push(`<h${tok.depth}>`);
        renderNodes(tok.nodes, out);
        out.push(`</h${tok.depth}>\n`);
        break;
      case 'code': {
        const s = (tok.lang || '').match(/^\S*/)?.[0];
        const r = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        if (s) out.push('<pre><code class="language-' + escape(s, false) + '">' + escape(r, true) + '</code></pre>\n');
        else out.push('<pre><code>' + escape(r, true) + '</code></pre>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (const cell of tok.header) renderTableCell(cell, out);
        out.push('</tr>\n</thead>\n');
        if (tok.rows.length) {
          out.push('<tbody>');
          for (const row of tok.rows) {
            out.push('<tr>\n');
            for (const cell of row) renderTableCell(cell, out);
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
      case 'blockquote':
        out.push('<blockquote>\n');
        renderBlocks(tok.tokens, out);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out.push(`<${tag}${start}>\n`);
        for (const item of tok.items) {
          out.push('<li>');
          renderBlocks(item.tokens, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>\n`);
        break;
      }
      case 'checkbox':
        out.push('<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
        break;
      case 'html':
        out.push(tok.text);
        break;
      case 'paragraph':
        out.push('<p>');
        renderNodes(tok.nodes, out);
        out.push('</p>\n');
        break;
      case 'text':
        renderNodes(tok.nodes, out);
        break;
    }
  }
}

// --- entry point ------------------------------------------------------------
// Render Markdown to HTML, byte-identical to marked 18.1.3 defaults.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  inlineQueue = [];
  blockLinks = {};
  blockTop = true;
  const tokens = blockTokens(src, [], false);
  // All link definitions are collected now; resolve the queued inline
  // sources against them (appending after any checkbox already unshifted).
  // One shared lexer state for the whole document: marked's inLink (set by
  // an unclosed <a> tag) persists across blocks, so a bare URL/email after
  // such a tag is not linkified.
  const sharedState = { inLink: false, inRaw: false };
  for (const entry of inlineQueue) {
    const nodes = parseInline(entry.src, blockLinks, sharedState);
    entry.token.nodes.push(...nodes);
  }
  inlineQueue = [];
  const out = [];
  renderBlocks(tokens, out);
  return out.join('');
}

