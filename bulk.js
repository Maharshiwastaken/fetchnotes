#!/usr/bin/env node
'use strict';

/**
 * bulk.js — batch-import Spotify CSV exports into MP3s, reusing cli.js.
 *
 * Two phases:
 *
 *   node bulk.js scan   [--csv DIR] [--limit N] [--concurrency N]
 *       Query every unique track against Deezer, score candidates, and write
 *       match-plan.json + match-report.csv. Downloads nothing.
 *
 *   node bulk.js fetch  [--limit N] [--concurrency N] [--min-score N]
 *       Read the plan and download each track into per-playlist subfolders.
 *       Resumable: re-running skips anything already on disk.
 *
 *   node bulk.js status
 *       Summarise the plan and how many files are already downloaded.
 *
 * Why fuzzy matching? Deezer's public API does not support ISRC lookup
 * (verified: returns 0 even for ISRCs known to exist), so we score on
 * title + artist + duration instead.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readCsv, writeCsv } = require('./csv.js');
const { bestMatch, similarity } = require('./match.js');
const cli = require('./cli.js');

const { paint, C, TTY } = cli;

/* ------------------------------------------------------------------ config */

const HERE = __dirname;
const DEFAULT_CSV_DIR = path.join(os.homedir(), 'Documents', 'Spotify');
const DEFAULT_MUSIC_DIR = path.join(os.homedir(), 'Music', 'Spotify');
const PLAN_FILE = path.join(HERE, 'match-plan.json');
const REPORT_FILE = path.join(HERE, 'match-report.csv');

/** Playlist subfolder name from a CSV filename. */
function playlistName(file) {
  return path.basename(file, path.extname(file));
}

/* --------------------------------------------------------------- arg parsing */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/* ------------------------------------------------------------- csv loading */

/**
 * Read every CSV in a directory and return rows enriched with playlist info.
 * Rows with no track name are Spotify "local files" — not downloadable.
 */
function loadRows(csvDir) {
  const files = fs
    .readdirSync(csvDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();

  const rows = [];
  const skipped = [];

  for (const file of files) {
    const playlist = playlistName(file);
    let parsed;
    try {
      parsed = readCsv(path.join(csvDir, file));
    } catch (err) {
      console.log(paint(`  ! could not read ${file}: ${err.message}`, C.red));
      continue;
    }

    for (const r of parsed) {
      const uri = (r['Track URI'] || '').trim();
      const title = (r['Track Name'] || '').trim();
      const artists = (r['Artist Name(s)'] || '').trim();
      const album = (r['Album Name'] || '').trim();
      const ms = Number.parseInt(r['Duration (ms)'], 10);
      const durationMs = Number.isFinite(ms) ? ms : 0;

      if (!title) {
        skipped.push({ uri, playlist, reason: 'empty (Spotify local file)' });
        continue;
      }
      if (!uri.startsWith('spotify:track:')) {
        skipped.push({ uri, playlist, reason: `unsupported URI` });
        continue;
      }

      rows.push({ uri, title, artists, album, durationMs, playlist, source: file });
    }
  }

  return { rows, skipped, files };
}

/**
 * Dedupe by Track URI while remembering every playlist a song belongs to.
 * Returns unique tracks sorted for a stable, reproducible plan.
 */
function dedupe(rows) {
  const byUri = new Map();

  for (const r of rows) {
    let t = byUri.get(r.uri);
    if (!t) {
      t = {
        uri: r.uri,
        title: r.title,
        artists: r.artists,
        album: r.album,
        durationMs: r.durationMs,
        playlists: [],
        sources: [],
      };
      byUri.set(r.uri, t);
    }
    if (!t.playlists.includes(r.playlist)) t.playlists.push(r.playlist);
    if (!t.sources.includes(r.source)) t.sources.push(r.source);
  }

  return [...byUri.values()].sort((a, b) => a.uri.localeCompare(b.uri));
}

/* --------------------------------------------------------------- deezer io */

/** Search Deezer with a couple of query shapes, merging + de-duping results. */
async function searchCandidates(track) {
  const primary = `${track.title} ${track.artists}`.trim();
  const fallback = track.title;

  const queries = primary.length > 2 ? [primary, fallback] : [fallback];
  const seen = new Set();
  const merged = [];

  for (const q of queries) {
    let results = [];
    try {
      results = await cli.deezerSearch(q, 8);
    } catch {
      results = [];
    }
    for (const r of results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
  }

  return merged;
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

/* ----------------------------------------------------------------- matching */

const REVIEW_BAND = 0.55; // below this we still record, but flag for review
const STRONG = 0.75; // comfortably a correct match

function classify(match) {
  if (!match) return 'no_match';
  if (match.score >= STRONG) return 'matched';
  return 'review';
}

async function matchTrack(track) {
  const candidates = await searchCandidates(track);

  if (candidates.length === 0) {
    return { ...track, status: 'no_match', deezer: null, score: 0, metrics: null };
  }

  const best = bestMatch(track, candidates, { minScore: 0 });
  const status = classify(best);

  return {
    ...track,
    status,
    score: Number(best.score.toFixed(4)),
    metrics: {
      dur: Number(best.dur.toFixed(3)),
      title: Number(best.title.toFixed(3)),
      artist: Number(best.artist.toFixed(3)),
    },
    deezer: {
      id: best.candidate.id,
      title: best.candidate.title,
      artist: best.candidate.artist,
      album: best.candidate.album,
      duration: best.candidate.duration,
      link: `https://www.deezer.com/track/${best.candidate.id}`,
    },
    candidateCount: candidates.length,
  };
}

/* --------------------------------------------------------------- reporting */

const STATUS_ICON = {
  matched: paint('✓', C.green, C.bold),
  review: paint('?', C.yellow, C.bold),
  no_match: paint('✗', C.red, C.bold),
  skipped: paint('·', C.dim),
};

function writeReport(tracks, skipped) {
  const cols = [
    'status', 'score', 'spotify_title', 'spotify_artist', 'spotify_album',
    'spotify_duration_s', 'deezer_title', 'deezer_artist', 'deezer_duration_s',
    'playlists', 'uri', 'deezer_link',
  ];

  const rows = tracks.map((t) => ({
    status: t.status,
    score: t.score,
    spotify_title: t.title,
    spotify_artist: t.artists,
    spotify_album: t.album,
    spotify_duration_s: (t.durationMs / 1000).toFixed(1),
    deezer_title: t.deezer ? t.deezer.title : '',
    deezer_artist: t.deezer ? t.deezer.artist : '',
    deezer_duration_s: t.deezer ? t.deezer.duration : '',
    playlists: t.playlists.join(' | '),
    uri: t.uri,
    deezer_link: t.deezer ? t.deezer.link : '',
  }));

  writeCsv(REPORT_FILE, rows, cols);
}

function summary(tracks, skipped) {
  const counts = { matched: 0, review: 0, no_match: 0 };
  for (const t of tracks) counts[t.status] = (counts[t.status] || 0) + 1;
  return counts;
}

/* ------------------------------------------------------------------ commands */

async function cmdScan(args) {
  const csvDir = path.resolve(args.csv || DEFAULT_CSV_DIR);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const concurrency = Number(args.concurrency || 8);

  console.log('');
  console.log(`  ${paint('◎', C.cyan, C.bold)} ${paint('SCAN', C.bold)}  ${paint('match Spotify CSVs against Deezer', C.dim)}`);
  console.log(`  ${paint('source', C.dim)} ${csvDir}`);
  console.log('');

  if (!fs.existsSync(csvDir)) {
    console.log(paint(`  ✗ directory not found: ${csvDir}`, C.red));
    process.exit(1);
  }

  const { rows, skipped, files } = loadRows(csvDir);
  const unique = dedupe(rows);
  const todo = unique.slice(0, limit);

  console.log(
    `  ${paint('·', C.dim)} ${files.length} CSVs · ${rows.length} rows · ` +
      `${paint(`${unique.length} unique tracks`, C.bold)} · ${skipped.length} skipped (local files)`
  );
  console.log(`  ${paint('·', C.dim)} matching ${todo.length} against Deezer (concurrency ${concurrency})…`);
  console.log('');

  let done = 0;
  const started = Date.now();

  const tracks = await mapLimit(todo, concurrency, async (t) => {
    const r = await matchTrack(t);
    done += 1;
    if (TTY) {
      process.stdout.write(
        `\r  ${paint('matching', C.dim)} ${done}/${todo.length} ` +
          `(${Math.round((done / todo.length) * 100)}%)`
      );
    }
    return r;
  });

  if (TTY) process.stdout.write('\r' + ' '.repeat(60) + '\r');

  const counts = summary(tracks);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  fs.writeFileSync(
    PLAN_FILE,
    JSON.stringify(
      { generated: new Date().toISOString(), csvDir, tracks, skipped },
      null,
      2
    ),
    'utf8'
  );
  writeReport(tracks, skipped);

  console.log(`  ${paint('✓', C.green, C.bold)} scan complete in ${secs}s`);
  console.log('');
  console.log(`    ${STATUS_ICON.matched} ${paint('matched', C.green)}   ${counts.matched}`);
  console.log(`    ${STATUS_ICON.review} ${paint('review', C.yellow)}    ${counts.review}   ${paint('(fuzzy — worth eyeballing)', C.dim)}`);
  console.log(`    ${STATUS_ICON.no_match} ${paint('no match', C.red)}   ${counts.no_match}`);
  console.log('');
  console.log(`  ${paint('plan', C.dim)}  ${PLAN_FILE}`);
  console.log(`  ${paint('report', C.dim)} ${REPORT_FILE}  ${paint('(open in a spreadsheet)', C.dim)}`);
  console.log('');
  console.log(`  ${paint('Next:', C.bold)} node bulk.js fetch`);
  console.log('');
}

function loadPlan() {
  if (!fs.existsSync(PLAN_FILE)) {
    console.log(paint(`  ✗ no plan found — run "node bulk.js scan" first`, C.red));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
}

async function cmdFetch(args) {
  const plan = loadPlan();
  const musicDir = path.resolve(args['music-dir'] || DEFAULT_MUSIC_DIR);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const concurrency = Number(args.concurrency || 3);
  const minScore = args['min-score'] ? Number(args['min-score']) : 0;
  const dryRun = !!args['dry-run'];

  // Only download confident matches unless the user lowers the bar.
  let wanted = plan.tracks.filter((t) => t.status === 'matched' && t.score >= minScore);
  if (args['include-review']) {
    wanted = plan.tracks.filter((t) => t.status !== 'no_match' && t.score >= minScore);
  }
  const todo = wanted.slice(0, limit);

  console.log('');
  console.log(
    `  ${paint('↓', C.green, C.bold)} ${paint('FETCH', C.bold)}  ` +
      paint('download matched tracks', C.dim)
  );
  console.log(`  ${paint('into', C.dim)} ${musicDir}`);
  console.log(
    `  ${paint('queue', C.dim)} ${todo.length} tracks (concurrency ${concurrency})` +
      (dryRun ? paint('  [dry-run]', C.yellow, C.bold) : '')
  );
  console.log('');

  if (todo.length === 0) {
    console.log(paint('  nothing to fetch — run "node bulk.js scan" first', C.yellow));
    return;
  }

  const state = loadState();
  let done = 0;
  let saved = 0;
  let failed = 0;
  let skippedExisting = 0;

  await mapLimit(todo, concurrency, async (t) => {
    done += 1;

    // Per-playlist subfolders; skip anything already on disk (resumable).
    const dirs = t.playlists.map((p) => path.join(musicDir, p));
    const primary = dirs[0];

    // Resumable: a previously saved track is skipped entirely.
    if (state.done[t.uri] && fs.existsSync(state.done[t.uri])) {
      skippedExisting += 1;
      linkIntoOtherPlaylists(state.done[t.uri], dirs.slice(1));
      paintProgress();
      return { ok: true, skipped: true };
    }

    if (dryRun) {
      paintProgress();
      return { ok: true, dryRun: true };
    }

    fs.mkdirSync(primary, { recursive: true });

    const res = await cli.download(
      { title: t.deezer.title, artist: t.deezer.artist },
      { outDir: primary, quiet: true }
    );

    if (res.ok && res.file) {
      saved += 1;
      state.done[t.uri] = res.file;
      saveState(state);
      linkIntoOtherPlaylists(res.file, dirs.slice(1));
    } else {
      failed += 1;
      state.failed[t.uri] = { error: res.error || 'unknown', at: new Date().toISOString() };
      saveState(state);
    }

    paintProgress();
    return res;
  });

  function paintProgress() {
    if (!TTY) return;
    process.stdout.write(
      `\r  ${paint('fetching', C.dim)} ${done}/${todo.length} ` +
        `saved=${saved} failed=${failed} skipped=${skippedExisting}   `
    );
  }

  if (TTY) process.stdout.write('\r' + ' '.repeat(70) + '\r');

  console.log('');
  console.log(`  ${paint('✓', C.green, C.bold)} fetch complete`);
  console.log(`    ${paint('saved', C.green)}   ${saved}`);
  console.log(`    ${paint('failed', C.red)}     ${failed}`);
  console.log(`    ${paint('skipped', C.dim)}    ${skippedExisting}  ${paint('(already on disk)', C.dim)}`);
  if (failed) {
    console.log('');
    console.log(
      `  ${paint('Re-run the same command to retry the failures —', C.dim)}`
    );
    console.log(`  ${paint('completed tracks are skipped automatically.', C.dim)}`);
  }
  console.log('');
}

/**
 * Hardlink a downloaded file into the other playlists it belongs to, so a
 * song liked in 3 lists costs one copy on disk, not three. Falls back to a
 * copy if the filesystem refuses the link.
 */
function linkIntoOtherPlaylists(sourceFile, dirs) {
  const base = path.basename(sourceFile);
  for (const dir of dirs) {
    const dest = path.join(dir, base);
    try {
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.linkSync(sourceFile, dest);
      } catch {
        fs.copyFileSync(sourceFile, dest);
      }
    } catch {
      /* best effort — never fail the batch over a link */
    }
  }
}

/* ------------------------------------------------------------------- state */

function stateFile() {
  return path.join(HERE, 'bulk-state.json');
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return { done: s.done || {}, failed: s.failed || {} };
  } catch {
    return { done: {}, failed: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
}

function cmdStatus() {
  if (!fs.existsSync(PLAN_FILE)) {
    console.log(paint('  no plan yet — run "node bulk.js scan"', C.yellow));
    return;
  }
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const counts = summary(plan.tracks, plan.skipped);
  console.log('');
  console.log(`  plan generated ${plan.generated}`);
  console.log(`    matched   ${counts.matched}`);
  console.log(`    review    ${counts.review}`);
  console.log(`    no match  ${counts.no_match}`);
  console.log(`    skipped   ${plan.skipped.length}`);
  console.log('');
}

/* --------------------------------------------------------------------- main */

const USAGE = `
  node bulk.js scan   [--csv DIR] [--limit N] [--concurrency N]
  node bulk.js fetch  [--music-dir DIR] [--limit N] [--concurrency N]
                      [--min-score N] [--include-review]
  node bulk.js status

  Defaults:
    --csv        ~/Documents/Spotify
    --music-dir  ~/Music/Spotify
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === 'scan') return cmdScan(args);
  if (cmd === 'fetch') return cmdFetch(args);
  if (cmd === 'status') return cmdStatus();

  console.log(USAGE);
  return undefined;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(paint(`\n  ✗ ${err.stack || err.message}\n`, C.red));
    process.exit(1);
  });
}

module.exports = {
  loadRows,
  dedupe,
  matchTrack,
  searchCandidates,
  mapLimit,
  classify,
  playlistName,
  PLAN_FILE,
  REPORT_FILE,
  DEFAULT_CSV_DIR,
  DEFAULT_MUSIC_DIR,
};
