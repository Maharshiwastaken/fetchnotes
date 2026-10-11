'use strict';

/**
 * album.js — search and download whole albums by name, via Deezer + yt-dlp.
 *
 * Reuses cli.js for yt-dlp invocation and formatting. This module is
 * deliberately *non-interactive*: it exposes data + download functions, and
 * cli.js owns the interactive prompts (avoids a circular require).
 *
 * Why retag with ffmpeg? YouTube titles/artists are polluted
 * ("Queen – Bohemian Rhapsody (Official Video Remastered)", artist
 * "Queen Official"), so we overwrite ID3 tags with Deezer's exact metadata.
 * Stream copy means it costs ~0.05s per track.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const cli = require('./cli.js');

const { DEEZER, paint, C } = cli;

/* ---------------------------------------------------------------- deezer io */

/** Search albums by name. Deezer's /search/album omits release_date. */
async function searchAlbums(query, limit = 8) {
  const url = `${DEEZER}/search/album?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Deezer responded ${res.status}`);
  const data = await res.json();

  return (data.data || []).map((a) => ({
    id: a.id,
    title: a.title,
    artist: (a.artist && a.artist.name) || 'Unknown artist',
    artistId: a.artist && a.artist.id,
    nbTracks: a.nb_tracks || 0,
    cover: a.cover_medium || null,
    // /search/album does not return release_date — filled by getAlbum().
    releaseDate: null,
    type: a.type || 'album',
  }));
}

/** Full album metadata, including release_date and record_type. */
async function getAlbum(id) {
  const res = await fetch(`${DEEZER}/album/${id}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Deezer album ${id}: HTTP ${res.status}`);
  const a = await res.json();
  if (a.error) throw new Error(`Deezer album ${id}: ${a.error.message}`);

  return {
    id: a.id,
    title: a.title,
    artist: (a.artist && a.artist.name) || 'Unknown artist',
    artistId: a.artist && a.artist.id,
    nbTracks: a.nb_tracks || (a.tracks && a.tracks.data.length) || 0,
    releaseDate: a.release_date || null,
    recordType: a.record_type || 'album',
    label: a.label || null,
    duration: a.duration || 0,
    upc: a.upc || null,
  };
}

/**
 * Full tracklist, following Deezer pagination (limit caps at 100).
 * Returns tracks in album order, each with position/disc/duration.
 */
async function getAlbumTracks(id) {
  const tracks = [];
  let url = `${DEEZER}/album/${id}/tracks?limit=100`;

  while (url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Deezer album ${id} tracks: HTTP ${res.status}`);
    const page = await res.json();
    if (page.error) throw new Error(`Deezer album ${id}: ${page.error.message}`);

    for (const t of page.data || []) {
      tracks.push({
        id: t.id,
        title: t.title,
        position: t.track_position || tracks.length + 1,
        disc: t.disk_number || 1,
        duration: t.duration || 0,
        explicit: !!t.explicit_lyrics,
        // readable flag false = unavailable in that region; skip those.
        readable: t.readable !== false,
      });
    }

    url = page.next || null;
  }

  return tracks;
}

/** Album + tracklist in one call. */
async function getAlbumFull(id) {
  const [album, tracks] = await Promise.all([getAlbum(id), getAlbumTracks(id)]);
  return { ...album, tracks };
}

/* ------------------------------------------------------------ file naming */

/** Strip characters that are unsafe in filenames (keeps CJK/Devanagari). */
function sanitize(name) {
  return (
    String(name || '')
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 150) || 'Unknown'
  );
}

/**
 * Track filename: "01 - Title.mp3", or "D1T01 - Title.mp3" when multi-disc.
 */
function trackFileName(track, multiDisc) {
  const pos = String(track.position).padStart(2, '0');
  const disc = track.disc || 1;
  const prefix = multiDisc ? `D${disc}T${pos}` : pos;
  return `${prefix} - ${sanitize(track.title)}.mp3`;
}

/** Album folder: <root>/<Artist>/<Album Title> */
function albumDir(root, album) {
  return path.join(root, sanitize(album.artist), sanitize(album.title));
}

/* -------------------------------------------------------------- ffmpeg io */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const line = String(stderr || '').split('\n').find((l) => /error/i.test(l));
        reject(new Error(line ? line.trim() : `ffmpeg exited ${err.code}`));
      } else {
        resolve(true);
      }
    });
  });
}

function runFfprobe(file) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration:format_tags=title,artist,album,track',
        '-of', 'json',
        file,
      ],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Overwrite ID3 tags on an mp3 with exact album metadata.
 * Stream copy (-c copy) — no re-encode, ~0.05s.
 */
async function retag(file, meta) {
  const tmp = `${file}.retag.mp3`;
  const args = ['-y', '-i', file, '-c', 'copy', '-map_metadata', '0'];

  const put = (key, val) => {
    if (val === undefined || val === null || val === '') return;
    args.push('-metadata', `${key}=${String(val)}`);
  };

  put('title', meta.title);
  put('artist', meta.artist);
  put('album_artist', meta.albumArtist || meta.artist);
  put('album', meta.album);
  put('track', meta.track);
  put('disc', meta.disc);
  put('date', meta.date || meta.year);
  put('comment', meta.comment);

  args.push(tmp);

  await runFfmpeg(args);
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------- downloading */

/**
 * yt-dlp args for one album track.
 *
 * --match-filter pins the result to within `tolerance` seconds of the Deezer
 * duration, so a search can't silently grab the live/remix/karaoke version.
 */
function trackArgs(dir, query, durationSec, tolerance) {
  const args = [
    '--js-runtimes', 'node',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--newline',
    '--progress',
    '--print', 'after_move:filepath',
    '--no-playlist',
    // ytsearch5 lets the duration filter skip wrong versions, but without
    // this cap it downloads EVERY candidate that passes the filter.
    '--max-downloads', '1',
    '-o', path.join(dir, '%(title)s.%(ext)s'),
  ];

  if (durationSec > 0 && tolerance > 0) {
    const lo = Math.max(1, Math.round(durationSec - tolerance));
    const hi = Math.round(durationSec + tolerance);
    args.push('--match-filter', `duration >= ${lo} & duration <= ${hi}`);
  }

  args.push(`ytsearch5:${query}`);
  return args;
}

/**
 * Download one track into `dir`, retag it, and rename to the numbered name.
 *
 * Two passes: first with the duration filter (rejects wrong versions); if
 * nothing survives the filter, retry unfiltered so we still get *a* file.
 */
async function downloadTrack(track, album, dir, opts = {}) {
  const tolerance = opts.tolerance ?? 15;
  const wantTags = opts.retag !== false;
  const query = `${track.title} ${album.artist}`;

  let file = null;

  // Pass 1: duration-filtered search. Note yt-dlp exits 0 with EMPTY output
  // when --match-filter rejects every candidate, so an empty `file` is just
  // as much a trigger for the fallback as a thrown error.
  try {
    file = await cli.runYtDlp(trackArgs(dir, query, track.duration, tolerance), {
      allowMaxDownloads: true,
    });
  } catch (err) {
    file = '';
  }

  // Pass 2: unfiltered, so we still get *a* file rather than nothing.
  if (!file || !fs.existsSync(file)) {
    try {
      file = await cli.runYtDlp(trackArgs(dir, query, 0, 0), {
        allowMaxDownloads: true,
      });
    } catch (err2) {
      cli.cleanupFailed(cli.snapshotDir(dir), dir);
      return { ok: false, error: err2.message, unfiltered: true };
    }
  }

  if (!file || !fs.existsSync(file)) {
    cli.cleanupFailed(cli.snapshotDir(dir), dir);
    return { ok: false, error: 'yt-dlp produced no file' };
  }

  if (wantTags) {
    try {
      await retag(file, {
        title: track.title,
        artist: album.artist,
        albumArtist: album.artist,
        album: album.title,
        track: track.position,
        disc: track.disc,
        year: album.releaseDate ? String(album.releaseDate).slice(0, 4) : null,
        comment: album.releaseDate ? `Originally released ${album.releaseDate}` : null,
      });
    } catch {
      // Tagging is cosmetic — keep the file even if retagging failed.
    }
  }

  // Rename to the numbered filename, keeping the mp3 extension.
  const dest = path.join(dir, trackFileName(track, opts.multiDisc));
  if (path.resolve(file) !== path.resolve(dest)) {
    if (fs.existsSync(dest)) fs.unlinkSync(file);
    else fs.renameSync(file, dest);
  }

  return { ok: true, file: dest };
}

/**
 * Download a whole album sequentially (keeps album order, avoids rate limits).
 * Returns { ok, failed, dir, results }.
 */
async function downloadAlbum(albumFull, opts = {}) {
  const root = opts.root || cli.MUSIC_DIR;
  const dir = albumDir(root, albumFull);
  const tracks = albumFull.tracks.filter((t) => t.readable !== false);
  const multiDisc = new Set(tracks.map((t) => t.disc)).size > 1;

  fs.mkdirSync(dir, { recursive: true });

  const results = [];
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    if (opts.onProgress) opts.onProgress(t, i, tracks.length);

    // eslint-disable-next-line no-await-in-loop
    const res = await downloadTrack(t, albumFull, dir, { ...opts, multiDisc });
    results.push({ track: t, ...res });
    if (res.ok) ok += 1;
    else failed += 1;
  }

  // Drop a small cue file so the album order survives file managers.
  if (opts.writeCue !== false && ok > 0) {
    try {
      writeCue(dir, albumFull, results.filter((r) => r.ok));
    } catch {
      /* cosmetic */
    }
  }

  return { ok, failed, dir, results };
}

/** Write album.cue listing downloaded tracks in order. */
function writeCue(dir, album, okResults) {
  const esc = (s) => String(s).replace(/"/g, "'");
  const lines = [
    `PERFORMER "${esc(album.artist)}"`,
    `TITLE "${esc(album.title)}"`,
    '',
  ];

  for (const r of okResults) {
    const file = path.basename(r.file);
    lines.push(`FILE "${file}" WAVE`);
    lines.push(`  TRACK ${String(r.track.position).padStart(2, '0')} AUDIO`);
    lines.push(`    TITLE "${esc(r.track.title)}"`);
    lines.push(`    PERFORMER "${esc(album.artist)}"`);
    lines.push('');
  }

  fs.writeFileSync(path.join(dir, 'album.cue'), `${lines.join('\n')}\n`, 'utf8');
}

/* -------------------------------------------------------------- formatting */

function formatAlbumRow(n, a) {
  const num = paint(String(n).padStart(2), C.cyan, C.bold);
  const title = cli.truncate(a.title, 44);
  const artist = cli.truncate(a.artist, 26);
  const meta = a.nbTracks ? `${a.nbTracks} tracks` : '?';
  return (
    `      ${num}  ${paint(title, C.bold)} ${paint('—', C.dim)} ` +
    `${paint(artist, C.yellow)} ${paint(`· ${meta}`, C.dim)}`
  );
}

module.exports = {
  searchAlbums,
  getAlbum,
  getAlbumTracks,
  getAlbumFull,
  sanitize,
  trackFileName,
  albumDir,
  retag,
  runFfmpeg,
  runFfprobe,
  downloadTrack,
  downloadAlbum,
  writeCue,
  formatAlbumRow,
};
