# Fetchnotes

Interactive CLI: name a song → get matching **and similar** track suggestions → pick one → high-quality MP3 downloaded into `~/Music`.

## Requirements

- Node.js ≥ 18 (no npm dependencies)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) (auto-detected in `~/.local/bin`, `/usr/local/bin`, or `PATH`)
- `ffmpeg`

## Usage

```bash
node cli.js
```

```
  ♪ Fetchnotes  search → suggest → download
  saves to /home/you/Music

  🔎 song name or YouTube URL > bohemian rhapsody

    ▸ matches for "bohemian rhapsody"
       1  Bohemian Rhapsody — Queen · 5:54
       2  Bohemian Rhapsody (Live Aid) — Queen · 6:59

    ▸ more by Queen
       3  Don't Stop Me Now — Queen · 3:32
       4  Somebody To Love — Queen · 4:56

    pick 1-4 — e.g. 1,3,5 · 1-4 · all · enter = 1 · s = new search · q = quit > 1,3

    ⬇ Bohemian Rhapsody Queen
    ✓ saved Bohemian Rhapsody.mp3 (11.0 MB)
    ⬇ Don't Stop Me Now Queen
    ✓ saved Don't Stop Me Now.mp3 (7.4 MB)
```

**Controls:** `1-N` picks tracks · `Enter` picks the first match · `s` searches again · `q` quits · `Ctrl+C` exits.

### Selecting multiple files

The pick prompt accepts several tracks at once, which are downloaded back to back:

| Input      | Meaning                          |
|------------|----------------------------------|
| `1,3,5`    | those three tracks               |
| `1 3 5`    | same, space-separated            |
| `1-4`      | an inclusive range               |
| `2;4` / `2:4` | alternative separators        |
| `all` / `*`| every listed track               |
| `1-3,5`    | mixed ranges + singles           |

Duplicates are removed and order is preserved. A failed item doesn't stop the batch — you get a summary at the end:

```
  ✓ batch done  2 saved · 1 failed
```

You can also paste **several YouTube URLs** on one line (space- or comma-separated) to queue them all.

### Album mode

Prefix a search with `album:` (or `a:`) to grab a **whole album** by name:

```
  🔎 song name · album: Name or YouTube URL > album: The Dark Side of the Moon Pink Floyd

    ◈ albums for "The Dark Side of the Moon Pink Floyd"
       1  The Dark Side of the Moon — Pink Floyd · 10 tracks
       2  Dub Side Of The Moon — Easy Star All-Stars · 13 tracks

    pick 1-2 · enter = 1 · s = new search · q = quit > 1

    ▣ The Dark Side of the Moon — Pink Floyd · 10/10 tracks · 1973
      01 - Speak to Me
      02 - Breathe (In the Air)
      …
    → /home/you/Music/Pink Floyd/The Dark Side of the Moon

    download this album? y/n > y

    ✓ album done  10 saved · 98s
```

Files land in **`<MUSIC_DIR>/<Artist>/<Album>/`**, named `01 - Title.mp3` (`D1T01 - …` for multi-disc sets). Each album also gets an `album.cue` listing the tracks in order.

What makes album mode different from a plain search:

- **Ordered tracklist** comes from Deezer (`/album/{id}/tracks`, paginated), not from YouTube search.
- **Duration guard** — each track is searched with `ytsearch5` plus `--match-filter "duration ±15s"`, so it won't silently grab a live/karaoke/wrong edit. If the filter rejects every candidate it retries unfiltered rather than failing.
- **Exact ID3 tags** — YouTube's metadata is usually wrong ("Queen Official"), so tags are overwritten with Deezer's using ffmpeg stream copy (~0.05s/track, no re-encode): title, artist, album, album_artist, track, disc, year.
- **`--max-downloads 1`** — without it, `ytsearch5` downloads *every* candidate that passes the filter.

## Notes

- **Search** uses the Deezer public API (no key required).
- **Suggestions** come from Deezer's top-tracks-by-artist endpoint.
- **Download** uses `yt-dlp -f bestaudio/best -x` → MP3 at the best available quality, with embedded metadata + thumbnail.

## Configuration

| Env var     | Default        | Purpose                          |
|-------------|----------------|----------------------------------|
| `MUSIC_DIR` | `~/Music`      | Where finished files are written |
| `YT_DLP`    | auto-detected  | Path to the `yt-dlp` binary      |
