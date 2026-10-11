#!/usr/bin/env node
'use strict';

/**
 * Music Getter — interactive music download CLI.
 *
 *   you name a song  ->  we list matching + similar tracks  ->  you pick
 *   ->  yt-dlp grabs the best available audio  ->  saved as MP3 in ~/Music
 *
 * Requires: Node >= 18, yt-dlp, ffmpeg. No npm dependencies.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');

/* ------------------------------------------------------------------ config */

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(os.homedir(), 'Music');
const DEEZER = 'https://api.deezer.com';
const YT_DLP = process.env.YT_DLP || findYtDlp();
const URL_RE = /^https?:\/\/\S+$/i;

/* ------------------------------------------------------------------ colors */

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

const TTY = !!process.stdout.isTTY;

function paint(text, ...codes) {
  if (!TTY || codes.length === 0) return String(text);
  return codes.join('') + String(text) + C.reset;
}

function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* -------------------------------------------------------------- yt-dlp loc */

function findYtDlp() {
  const candidates = [
    path.join(os.homedir(), '.local/bin/yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const found = execFileSync('which', ['yt-dlp'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {
    /* not on PATH */
  }
  return null;
}

/* ------------------------------------------------------------- Deezer API */

function mapTrack(t) {
  return {
    id: t.id,
    title: t.title || t.title_short || 'Unknown',
    artist: (t.artist && t.artist.name) || 'Unknown artist',
    artistId: t.artist && t.artist.id,
    album: t.album && t.album.title,
    duration: t.duration,
    rank: t.rank || 0,
  };
}

async function deezerSearch(query, limit = 6) {
  const url = `${DEEZER}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Deezer responded ${res.status}`);
  const data = await res.json();
  return (data.data || []).map(mapTrack);
}

async function artistTop(artistId, limit = 6) {
  if (!artistId) return [];
  const url = `${DEEZER}/artist/${artistId}/top?limit=${limit}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map(mapTrack);
}

/* ------------------------------------------------------------ presentation */

function banner() {
  console.log('');
  console.log(
    `  ${paint('♪', C.magenta, C.bold)} ${paint('MUSIC GETTER', C.bold, C.cyan)}  ` +
      paint('search → suggest → download', C.dim)
  );
  console.log(`  ${paint('saves to', C.dim)} ${paint(MUSIC_DIR, C.yellow)}`);
  console.log(
    `  ${paint('tip', C.dim)}  type ${paint('album: Name', C.bold)} to grab a whole album`
  );
  console.log('');
}

function printRow(n, t) {
  const num = paint(String(n).padStart(2), C.cyan, C.bold);
  const title = paint(truncate(t.title, 46), C.bold);
  const artist = paint(truncate(t.artist, 26), C.yellow);
  const dur = paint(fmtDuration(t.duration), C.gray);
  console.log(
    `      ${num}  ${title} ${paint('—', C.dim)} ${artist}  ${paint('·', C.dim)} ${dur}`
  );
}

/* ---------------------------------------------------------------- readline */

let rl = null;
let rlClosed = false;
let pendingAnswer = null;
let scriptLines = null; // when stdin isn't a TTY, answers come from here

/** Read all of stdin up-front so piped input survives async gaps. */
function readAllStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      data += d;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Ask a question. Resolves with null when input ends (EOF) or the UI closes. */
async function ask(prompt) {
  if (scriptLines !== null) {
    process.stdout.write(prompt);
    const line = scriptLines.shift();
    if (line === undefined) return null;
    console.log(line);
    return line;
  }

  if (!rl || rlClosed) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (pendingAnswer === finish) pendingAnswer = null;
      resolve(value);
    };
    pendingAnswer = finish;
    try {
      rl.question(prompt, finish);
    } catch {
      finish(null);
    }
  });
}

/* ------------------------------------------------------------------ picking */

/**
 * Parse a multi-select answer such as "1,3,5", "1-4", "2 4", or "all".
 * Returns an ordered array of 1-based indices (deduped), or null if a
 * token could not be understood.
 */
function parseSelection(input, n) {
  const tokens = input.split(/[\s,;]+/).filter(Boolean);
  const picked = [];
  const seen = new Set();
  const add = (i) => {
    if (i >= 1 && i <= n && !seen.has(i)) {
      seen.add(i);
      picked.push(i);
    }
  };

  for (const token of tokens) {
    if (token === 'all' || token === '*') {
      for (let i = 1; i <= n; i += 1) add(i);
      continue;
    }

    const range = token.match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if (range) {
      let from = Number(range[1]);
      let to = Number(range[2]);
      if (from > to) [from, to] = [to, from];
      for (let i = from; i <= to; i += 1) add(i);
      continue;
    }

    if (/^\d+$/.test(token)) {
      add(Number(token));
      continue;
    }

    return null;
  }

  return picked;
}

/**
 * Show the suggestion list and collect one or more picks.
 * Resolves to an array of tracks, 'again' to re-search, or null to quit.
 */
async function pickFrom(sections) {
  const flat = [];
  let n = 0;

  console.log('');
  for (const sec of sections) {
    console.log(`    ${paint('▸', C.magenta, C.bold)} ${paint(sec.label, C.bold)}`);
    for (const t of sec.tracks) {
      n += 1;
      flat.push(t);
      printRow(n, t);
    }
    console.log('');
  }

  const hint = `1-${n} — e.g. ${paint('1,3,5', C.cyan)} ` +
    paint('·', C.dim) + ` ${paint('1-4', C.cyan)} ` +
    paint('·', C.dim) + ` ${paint('all', C.cyan)}`;

  for (;;) {
    const reply = await ask(
      `    ${paint('pick', C.dim)} ${hint} ${paint('·', C.dim)} ` +
        `${paint('enter', C.green, C.bold)} ${paint('= 1 ·', C.dim)} ` +
        `${paint('s', C.green, C.bold)} ${paint('= new search ·', C.dim)} ` +
        `${paint('q', C.green, C.bold)} ${paint('= quit ', C.dim)}${paint('>', C.green)} `
    );
    if (reply === null) return null;

    const ans = reply.trim().toLowerCase();

    if (ans === 's' || ans === 'again') return 'again';
    if (ans === 'q' || ans === 'quit' || ans === 'exit') return null;
    if (ans === '') return [flat[0]];

    const picked = parseSelection(ans, n);
    if (!picked || picked.length === 0) {
      console.log(`    ${paint(`pick 1-${n} — try "1,3,5", "1-4", or "all"`, C.red)}`);
      continue;
    }

    return picked.map((i) => flat[i - 1]);
  }
}

/* ---------------------------------------------------------------- download */

/** Snapshot a directory so we can spot files a failed download leaves behind. */
function snapshotDir(dir = MUSIC_DIR) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

const AUDIO_RE = /\.(mp3|m4a|opus|ogg|flac|wav|aac)$/i;
const JUNK_RE = /\.(jpe?g|png|webp|part|ytdl|temp|tmp|json|description|txt|vtt|ass|lrc)$/i;

/**
 * Delete files created during a failed download (thumbnails, .part files).
 * Never touches pre-existing files or anything that looks like finished audio.
 */
function cleanupFailed(before, dir = MUSIC_DIR) {
  let after;
  try {
    after = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of after) {
    if (before.has(name)) continue;
    if (AUDIO_RE.test(name)) continue; // keep partial audio out of caution
    if (!JUNK_RE.test(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* best effort */
    }
  }
}

function baseArgs(outDir = MUSIC_DIR) {
  return [
    '--js-runtimes', 'node',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-thumbnail',
    '--embed-metadata',
    '--newline',
    '--progress',
    '--print', 'after_move:filepath',
    '-o', path.join(outDir, '%(title)s.%(ext)s'),
  ];
}

function runYtDlp(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
    });

    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderrBuf += text;
      const m = text.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/);
      if (!m) return;
      if (opts.onProgress) {
        opts.onProgress(Number(m[1]));
        return;
      }
      if (TTY) {
        process.stdout.write(
          `\r    ${paint('downloading', C.dim)} ${paint(`${m[1]}%`, C.cyan, C.bold)}   `
        );
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (TTY) process.stdout.write('\r' + ' '.repeat(70) + '\r');
      // yt-dlp exits 101 when --max-downloads was reached, which is a
      // success for us: we wanted exactly one file.
      if (code !== 0 && !(opts.allowMaxDownloads && code === 101)) {
        const errLine = stderrBuf.split('\n').find((l) => /ERROR/i.test(l));
        return reject(new Error(errLine ? errLine.trim() : `yt-dlp exited ${code}`));
      }
      const lines = stdoutBuf
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(lines[lines.length - 1] || '');
    });
  });
}

async function download(track, opts = {}) {
  const outDir = opts.outDir || MUSIC_DIR;
  const log = opts.quiet ? () => {} : console.log;
  const isUrl = !!track.url;
  const query = isUrl ? null : `${track.title} ${track.artist}`;
  const target = isUrl ? track.url : `ytsearch1:${query}`;

  if (!opts.quiet) {
    console.log('');
    console.log(
      `    ${paint('⬇', C.green, C.bold)} ${paint(isUrl ? track.url : query, C.bold)}`
    );
    if (!isUrl) console.log(`      ${paint('youtube:', C.dim)} "${query}"`);
    if (!TTY) console.log(`      ${paint('downloading…', C.dim)}`);
  }

  const before = snapshotDir(outDir);

  try {
    const file = await runYtDlp([...baseArgs(outDir), target], opts);
    if (file && fs.existsSync(file)) {
      const { size } = fs.statSync(file);
      log(
        `    ${paint('✓ saved', C.green, C.bold)} ${paint(path.basename(file), C.bold)} ` +
          paint(`(${fmtBytes(size)})`, C.dim)
      );
      if (!opts.quiet) log(`      ${paint(file, C.gray)}`);
    } else if (file) {
      log(`    ${paint('✓ saved', C.green, C.bold)} ${paint(file, C.bold)}`);
    } else {
      log(`    ${paint('✓ done — check', C.green)} ${paint(outDir, C.yellow)}`);
    }
    return { ok: true, file: file || null };
  } catch (err) {
    cleanupFailed(before, outDir);
    if (!opts.quiet) {
      console.log(
        `    ${paint('✗ failed', C.red, C.bold)} ${paint(err.message, C.red)}`
      );
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Download a whole queue, keeping going if individual items fail.
 * Returns { ok, failed } counts for the summary line.
 */
async function downloadQueue(tracks, opts = {}) {
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i];
    if (tracks.length > 1 && !opts.quiet) {
      console.log(
        `\n  ${paint(`[${i + 1}/${tracks.length}]`, C.magenta, C.bold)}`
      );
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await download(track, opts);
    if (result.ok) ok += 1;
    else failed += 1;
  }

  if (tracks.length > 1 && !opts.quiet) {
    const bits = [paint(`${ok} saved`, C.green)];
    if (failed) bits.push(paint(`${failed} failed`, C.red));
    console.log(`\n  ${paint('✓ batch done', C.bold)}  ${bits.join(paint(' · ', C.dim))}\n`);
  }

  return { ok, failed };
}

/* ------------------------------------------------------------------- album */

/**
 * Album mode: search albums by name, pick one, download the whole tracklist
 * into <MUSIC_DIR>/<Artist>/<Album>/.
 *
 * album.js requires cli.js, so it's lazily required here to avoid a
 * circular-require cycle (which would leave its destructured imports undefined).
 */
async function albumFlow(query) {
  // eslint-disable-next-line global-require
  const album = require('./album.js');

  let albums;
  try {
    albums = await album.searchAlbums(query, 8);
  } catch (err) {
    console.log(`    ${paint('✗ album search failed:', C.red)} ${paint(err.message, C.red)}`);
    return;
  }

  if (albums.length === 0) {
    console.log(`    ${paint('no albums found — try a different spelling', C.yellow)}`);
    return;
  }

  console.log('');
  console.log(`    ${paint('◈', C.magenta, C.bold)} ${paint(`albums for "${query}"`, C.bold)}`);
  albums.forEach((a, i) => console.log(album.formatAlbumRow(i + 1, a)));
  console.log('');

  let picked = null;
  for (;;) {
    const reply = await ask(
      `    ${paint('pick', C.dim)} ${paint(`1-${albums.length}`, C.cyan, C.bold)} ` +
        `${paint('·', C.dim)} ${paint('enter', C.green, C.bold)} ${paint('= 1 ·', C.dim)} ` +
        `${paint('s', C.green, C.bold)} ${paint('= new search ·', C.dim)} ` +
        `${paint('q', C.green, C.bold)} ${paint('= quit ', C.dim)}${paint('>', C.green)} `
    );
    if (reply === null) return;

    const ans = reply.trim().toLowerCase();
    if (ans === 's' || ans === 'again') return;
    if (ans === 'q' || ans === 'quit' || ans === 'exit') return;
    if (ans === '') {
      picked = albums[0];
      break;
    }
    const idx = Number.parseInt(ans, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= albums.length) {
      picked = albums[idx - 1];
      break;
    }
    console.log(`    ${paint(`enter a number 1-${albums.length}`, C.red)}`);
  }

  // Fetch full tracklist so the user sees what they're committing to.
  let full;
  try {
    full = await album.getAlbumFull(picked.id);
  } catch (err) {
    console.log(`    ${paint('✗ could not load tracklist:', C.red)} ${paint(err.message, C.red)}`);
    return;
  }

  const playable = full.tracks.filter((t) => t.readable !== false);
  const multiDisc = new Set(full.tracks.map((t) => t.disc)).size > 1;

  console.log('');
  console.log(
    `    ${paint('▣', C.cyan, C.bold)} ${paint(full.title, C.bold)} ` +
      `${paint('—', C.dim)} ${paint(full.artist, C.yellow)} ` +
      `${paint(`· ${playable.length}/${full.tracks.length} tracks`, C.dim)}` +
      (full.releaseDate ? paint(` · ${String(full.releaseDate).slice(0, 4)}`, C.dim) : '')
  );
  for (const t of playable.slice(0, 12)) {
    console.log(`      ${paint(album.trackFileName(t, multiDisc).replace(/\.mp3$/, ''), C.dim)}`);
  }
  if (playable.length > 12) {
    console.log(paint(`      … and ${playable.length - 12} more`, C.dim));
  }
  console.log(
    `    ${paint('→', C.dim)} ${paint(album.albumDir(MUSIC_DIR, full), C.gray)}`
  );
  console.log('');

  const go = await ask(
    `    ${paint('download this album?', C.bold)} ` +
      `${paint('y', C.green, C.bold)}/${paint('n', C.red, C.bold)}${paint(' > ', C.dim)}`
  );
  if (go === null || !/^(y|yes)$/i.test(go.trim())) {
    console.log(`    ${paint('skipped', C.dim)}`);
    return;
  }

  console.log('');
  const started = Date.now();
  const res = await album.downloadAlbum(full, {
    root: MUSIC_DIR,
    onProgress: (t, i, total) => {
      if (!TTY) return;
      process.stdout.write(
        `\r    ${paint('downloading', C.dim)} ${i + 1}/${total} ` +
          `${paint(`${t.title}`.slice(0, 40), C.cyan)}   `
      );
    },
  });
  if (TTY) process.stdout.write('\r' + ' '.repeat(70) + '\r');

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log('');
  console.log(
    `    ${paint('✓ album done', C.green, C.bold)}  ` +
      `${paint(`${res.ok} saved`, C.green)}` +
      (res.failed ? paint(` · ${paint(`${res.failed} failed`, C.red)}`) : '') +
      paint(` · ${secs}s`, C.dim)
  );
  console.log(`      ${paint(res.dir, C.gray)}`);
  if (res.failed) {
    const bad = res.results.filter((r) => !r.ok).map((r) => r.track.title);
    for (const b of bad.slice(0, 8)) console.log(`      ${paint('✗', C.red)} ${paint(b, C.dim)}`);
    if (bad.length > 8) console.log(paint(`      … and ${bad.length - 8} more`, C.dim));
  }
  console.log('');
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!YT_DLP) {
    console.error(
      paint('  yt-dlp not found. Install it first, or set YT_DLP=/path/to/yt-dlp', C.red)
    );
    process.exit(1);
  }
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

  banner();

  if (process.stdin.isTTY) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rlClosed = false;
    pendingAnswer = null;
    rl.on('close', () => {
      rlClosed = true;
      if (pendingAnswer) pendingAnswer(null);
    });
    rl.on('SIGINT', () => {
      rl.close();
      console.log('');
      process.exit(0);
    });
  } else {
    // Piped/redirected input: buffer every line up front so async work
    // (network, downloads) can't race ahead of stdin's EOF.
    const data = await readAllStdin();
    scriptLines = data.split('\n');
    if (scriptLines.length && scriptLines[scriptLines.length - 1] === '') {
      scriptLines.pop();
    }
  }

  try {
    for (;;) {
      const reply = await ask(
        `${paint('  🔎', C.cyan)} ${paint('song name', C.bold)}` +
          `${paint(' · ', C.dim)}${paint('album: ', C.magenta)}${paint('Name', C.bold)}` +
          `${paint(' or YouTube URL ', C.dim)}${paint('>', C.green)} `
      );
      if (reply === null) break;

      const raw = reply.trim();

      if (!raw) continue;
      if (/^(q|quit|exit)$/i.test(raw)) break;

      // "album: Name" (or "a: Name") switches into whole-album mode.
      const albumMatch = raw.match(/^(?:album|a)\s*:\s*(.+)$/i);
      if (albumMatch) {
        await albumFlow(albumMatch[1].trim());
        continue;
      }

      // Direct link(s) — skip the search step entirely.
      // Accepts one URL, or several separated by whitespace/commas.
      const urls = raw.split(/[\s,]+/).filter((u) => URL_RE.test(u));
      if (urls.length > 0) {
        await downloadQueue(urls.map((url) => ({ url })));
        continue;
      }

      let results = [];
      try {
        results = await deezerSearch(raw, 6);
      } catch (err) {
        console.log(
          `    ${paint('✗ search failed:', C.red)} ${paint(err.message, C.red)}`
        );
        continue;
      }

      if (results.length === 0) {
        console.log(`    ${paint('no matches — try a different spelling', C.yellow)}`);
        continue;
      }

      let similar = [];
      try {
        similar = await artistTop(results[0].artistId, 6);
      } catch {
        /* suggestions are optional */
      }

      const seen = new Set(results.map((t) => t.id));
      similar = similar.filter((t) => !seen.has(t.id));

      const sections = [{ label: `matches for "${raw}"`, tracks: results }];
      if (similar.length) {
        sections.push({ label: `more by ${results[0].artist}`, tracks: similar });
      }

      const choice = await pickFrom(sections);
      if (choice === null) break;
      if (choice === 'again') continue;

      await downloadQueue(choice);
    }
  } finally {
    if (rl) rl.close();
  }

  console.log(`\n    ${paint('bye 👋', C.dim)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(paint(`\n  ✗ ${err.stack || err.message}\n`, C.red));
    process.exit(1);
  });
}

module.exports = {
  // config / env
  MUSIC_DIR,
  YT_DLP,
  DEEZER,
  // formatting + colors
  C,
  TTY,
  paint,
  truncate,
  fmtDuration,
  fmtBytes,
  // deezer
  mapTrack,
  deezerSearch,
  artistTop,
  // yt-dlp
  findYtDlp,
  baseArgs,
  runYtDlp,
  snapshotDir,
  cleanupFailed,
  AUDIO_RE,
  JUNK_RE,
  // io
  ask,
  parseSelection,
  readAllStdin,
  // workflow
  pickFrom,
  download,
  downloadQueue,
  albumFlow,
  banner,
  main,
};
