'use strict';

/**
 * Fuzzy matching between Spotify CSV rows and Deezer search results.
 *
 * Deeizer's public API does NOT support ISRC lookup (verified: returns 0 even
 * for ISRCs known to exist), so we score candidates on:
 *
 *   - title similarity   (normalised Levenshtein + token overlap)
 *   - artist similarity  (normalised, handles multi-artist "A;B" fields)
 *   - duration agreement (strongest signal — catches Live/remix/radio edits)
 */

/* ------------------------------------------------------------ normalising */

/**
 * Normalise a string for comparison: lowercase, strip diacritics, drop
 * punctuation, collapse whitespace. Keeps CJK / Devanagari intact.
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9぀-ヿ㐀-鿿가-힯]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Strip version markers that make a *different recording* look like a title
 * mismatch: "(Live)", "- Remastered 2011", "[Deluxe]", "feat. X", etc.
 * Used as an extra comparison pass, never as the sole signal.
 */
function stripVersion(s) {
  return normalize(s)
    .replace(
      /\b(live|remaster(ed)?|remix|acoustic|demo|radio edit|edit|version|mono|stereo|deluxe|instrumental|karaoke|cover|sped up|slowed|nightcore|8 bit|acapella|single|ep|album)\b/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/* ----------------------------------------------------------- string metrics */

/** Levenshtein distance, capped for speed on long strings. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Ensure a is the shorter string to keep the row array small.
  if (a.length > b.length) [a, b] = [b, a];

  let prev = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i += 1) prev[i] = i;

  for (let j = 1; j <= b.length; j += 1) {
    let diag = prev[0];
    prev[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const tmp = prev[i];
      prev[i] = Math.min(
        prev[i] + 1, // deletion
        prev[i - 1] + 1, // insertion
        diag + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
      diag = tmp;
    }
  }
  return prev[a.length];
}

/** 0..1 ratio from Levenshtein distance. */
function levRatio(a, b) {
  if (!a.length && !b.length) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/** 0..1 Dice coefficient over token multisets — robust to word reordering. */
function tokenRatio(a, b) {
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;

  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);

  let matches = 0;
  for (const t of tb) {
    const c = counts.get(t);
    if (c > 0) {
      matches += 1;
      counts.set(t, c - 1);
    }
  }
  return (2 * matches) / (ta.length + tb.length);
}

/** Best of several similarity measures. */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;

  let best = Math.max(levRatio(na, nb), tokenRatio(na, nb));

  // Version-stripped pass lets "Song (Live At Wembley)" match "Song".
  const sa = stripVersion(a);
  const sb = stripVersion(b);
  if (sa && sb) best = Math.max(best, Math.max(levRatio(sa, sb), tokenRatio(sa, sb)));

  // Containment bonus: one title fully inside the other.
  if (na.includes(nb) || nb.includes(na)) {
    best = Math.max(best, 0.85);
  }
  return best;
}

/* -------------------------------------------------------------- artist set */

/** Split "A;B feat. C" style fields into a clean artist list. */
function artistList(raw) {
  return String(raw || '')
    .split(';')
    .map((a) =>
      a
        .replace(/\b(feat|ft|featuring)\b\.?\s*.*/i, '')
        .trim()
    )
    .filter(Boolean);
}

/** 0..1 best-match of any Spotify artist against the Deezer artist string. */
function artistScore(spotifyArtists, deezerArtist) {
  const list = artistList(spotifyArtists);
  if (!list.length) return 0.5; // unknown — don't penalise
  const target = String(deezerArtist || '');
  let best = 0;
  for (const a of list) {
    best = Math.max(best, similarity(a, target));
    if (best > 0.9) break;
  }
  return best;
}

/* ----------------------------------------------------------------- duration */

/**
 * Duration agreement in 0..1 using Spotify's Duration (ms) vs Deezer seconds.
 * Exact-ish matches score 1; the score decays to 0 by `falloff` seconds off.
 */
function durationScore(spotifyMs, deezerSec, falloff = 20) {
  const sp = Number(spotifyMs);
  if (!Number.isFinite(sp) || sp <= 0) return 0.5; // unknown duration
  const diff = Math.abs(sp / 1000 - Number(deezerSec));
  if (diff <= 2) return 1;
  return Math.max(0, 1 - (diff - 2) / falloff);
}

/* ------------------------------------------------------------------ scoring */

/**
 * Score one Deezer candidate against one Spotify row.
 * Weights: duration 0.40, title 0.45, artist 0.15.
 *
 * Duration carries heavy weight deliberately — it's the most reliable
 * discriminator between a studio track and the live/remix/karaoke versions
 * that clutter search results.
 */
function scoreCandidate(spotify, candidate) {
  const dur = durationScore(spotify.durationMs, candidate.duration);
  const title = similarity(spotify.title, candidate.title);
  const artist = artistScore(spotify.artists, candidate.artist);

  const score = 0.4 * dur + 0.45 * title + 0.15 * artist;
  return { score, dur, title, artist };
}

/**
 * Pick the best candidate for a Spotify row.
 * Returns { candidate, score, metrics } or null when nothing clears `minScore`.
 */
function bestMatch(spotify, candidates, opts = {}) {
  const minScore = opts.minScore ?? 0.55;
  let best = null;

  for (const c of candidates) {
    const m = scoreCandidate(spotify, c);
    if (!best || m.score > best.score) best = { candidate: c, ...m };
  }

  if (!best || best.score < minScore) return null;
  return best;
}

module.exports = {
  normalize,
  stripVersion,
  similarity,
  artistList,
  artistScore,
  durationScore,
  scoreCandidate,
  bestMatch,
};
