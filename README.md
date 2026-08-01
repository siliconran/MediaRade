# MediaRade

**by rad1x** — a YouTube and Uppbeat acquisition panel for Adobe Premiere Pro, built around a
strict, evidence-based licence risk checker.

Interface is a dependency-free CSS port of [PS2UI](https://github.com/Timmy-Lane/ps2ui) (MIT), Originally React based switched over to utilize SolidJS
retinted from its blue ramp to black-and-red. No Sony assets; PlayStation and PlayStation 2 are
trademarks of Sony Interactive Entertainment.

---

## What it does

- **Search YouTube** with real filters (sort, length, upload date, HD/4K/subs), encoded into
  YouTube's own `sp=` protobuf so the filtering happens server-side.
- **Audit every result** against a four-level risk model before anything can be downloaded.
- **Download** through `yt-dlp` as **Video + audio** (one muxed file), **Video only** or
  **Audio only**, with quality/container/format control, clip ranges, subtitles and SponsorBlock.
- **Preview in the panel** — a real stream, not a YouTube embed (see below).
- **Browse Uppbeat** and download pre-cleared library music, with the artist credit surfaced
  everywhere it matters.
- **Drag straight onto Premiere's timeline**, or one-click insert at the playhead.
- **Write the paperwork** — a `.license.json` and `attribution.txt` beside every file, a credits
  file for the project, and an append-only compliance ledger.

---

## The risk checker

The core rule: **words in a title or description are a claim, never a licence.**

The only machine-readable, platform-asserted licence signal YouTube publishes is the `license`
field in full metadata (`yt-dlp -J`) — it reads either *Creative Commons Attribution (reuse
allowed)* or *Standard YouTube Licence*. That field is the only thing treated as a licence.
Flat search listings do not contain it, so a search result is never green until it has been
verified.

| Level | Meaning |
| --- | --- |
| **CRITICAL** | Content ID already fingerprints the audio (`track`/`artist`/`album`, music metadata), or the upload is registered with a monetisation network (AdRev, Identifyy, DistroKid, TuneCore, CD Baby, Lickd…). **Never overridable.** |
| **HIGH** | The text advertises free reuse the licence field does not back up, or the work is a derivative (remix, cover, type beat, slowed+reverb) or a mislabelled reupload. Needs written permission. |
| **MODERATE** | Standard YouTube Licence, a CC NC/ND variant, or third-party material credited but not cleared. |
| **LOW** | Verified Creative Commons, no critical or warning signals. Cleared — attribution still required and written for you. |

The case this exists for: a video titled *"ROYALTY FREE — No Copyright!"* whose licence field does
not back that up. The text is marketing; the field is the licence. MediaRade reports the
contradiction as HIGH and refuses it under strict mode.

Worth knowing: for an all-rights-reserved upload YouTube returns an **empty** licence field, not
the literal string *"Standard YouTube Licence"*. An absent field is never read as permission — it
lands at MODERATE on its own, and HIGH the moment the text claims free reuse.

A genuine Creative Commons mark only covers what the uploader actually owned — credited music,
stock footage and subscription libraries (Epidemic Sound, Artlist, NCS…) keep their own licences
and are flagged separately even on a clean CC upload.

### Policy

| Setting | Passes without asking |
| --- | --- |
| **Strict mode** (default, on) | LOW only. |
| Creative Commons only | LOW only. |
| Royalty free | LOW and MODERATE. |
| Everything | Everything except CRITICAL. |

Anything the policy does not pass is *offered*, not forbidden: you get the verdict, the evidence,
and a **Download anyway** confirmation, and the choice is written to the ledger. The setting decides
what needs confirming — not what is possible. **CRITICAL is the sole exception** and never yields,
because Content ID already fingerprints the audio and no amount of consent creates a right that
is not there.

Every download, block, override and strict-mode change lands in
`Documents\MediaRade\Compliance\license-ledger.jsonl`.

> MediaRade records what the platform reported at the time of download. It is evidence of due
> diligence, not a grant of rights, and it is not legal advice.

---

## Preview

The panel does **not** embed the YouTube player. A CEP panel is served over `file://`, so its
origin is `null` and YouTube rejects the embed with *"Error 153 — Video player configuration
error"*. There is no header or parameter that fixes this.

Instead, pressing play asks `yt-dlp` for a **progressive stream URL** (one file carrying both
picture and sound) and hands it to a plain `<video>`. If a video has no progressive stream, the
panel says so and offers to open it in your browser rather than showing a dead player.

## Uppbeat

Uppbeat publishes no documented public API. MediaRade talks to its JSON endpoints directly, using a
session taken from the browser you signed in with. Those endpoint paths live in `Setup › Uppbeat`,
so if Uppbeat changes their site you repoint them instead of waiting for a patch. Per-track
downloads only — there is deliberately no bulk catalogue harvester.

**Signing in is one button.** Press **Sign in**: MediaRade opens uppbeat.io in your browser, you
sign in there as normal, and the panel polls until the session appears and picks it up on its own.
Your password never reaches MediaRade — the browser does the authenticating, and only the
**uppbeat.io** cookies are kept (via `yt-dlp`'s cookie reader). Nothing from any other domain is
retained. If it keeps timing out, check that `Setup › Uppbeat › Sign in with this browser` matches
the browser you actually used, and close that browser — Windows locks the cookie database while it
is running.

**Ingest a file** remains as a fallback: if the endpoints break, download from the site yourself and
MediaRade will file the track with its credit.

**Credit.** On the free plan the artist credit is **mandatory**: every download comes with an
Uppbeat credit that must appear wherever the track is used, normally the video description. That
credit is what tells YouTube the track is licensed to you — without it the licence does not apply
and the track can still be claimed. Each track needs its own credit in every video it appears in.
MediaRade shows this on the Uppbeat tab, puts a **Copy credit** button on every track, and writes
the credit to `attribution.txt` and `CREDITS.md`. Paid plans widen catalogue access and download
limits; check your plan's scope before using a track in advertising or for a client.

---

## Requirements

- Adobe Premiere Pro 14.0 or newer (CEP 9+)
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`ffmpeg`](https://ffmpeg.org/) — **not
  bundled**. Put them on `PATH`, drop them in `Documents\MediaRade\bin\`, or set explicit paths in
  `Setup › Tooling`.
- Node.js 18+ and npm, to build the panel.

---

## Install

```bash
npm install
npm run deploy
```

`deploy` builds, runs the smoke tests, and copies `CSXS\`, `dist\`, `jsx\` and `.debug` into
`%APPDATA%\Adobe\CEP\extensions\com.rad1x.mediarade`. Close Premiere first — it reads the manifest
once at startup. Then open **Window › Extensions › MediaRade**.

The panel loads `dist/`, so **rebuild after any change under `src/`**. `window.MR.builtAt` shows
which bundle is actually running; CEF caches hard, and a stale bundle looks exactly like a broken
feature.

To develop against the repo without re-copying, symlink instead (needs an elevated shell):

```bash
powershell -File tools\install.ps1 -Symlink
```

Unsigned extensions need debug mode enabled once per CSXS version. `install.ps1` checks this and
prints the exact command if it is missing:

```bash
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

---

## Development

```bash
npm run build      # compile src/ -> dist/
npm run smoke      # headless checks against the built bundle
npm run verify     # build + smoke
npm run deploy     # build + smoke + install into Premiere

# verify an installed copy rather than the repo
node tools/smoke.mjs "%APPDATA%\Adobe\CEP\extensions\com.rad1x.mediarade"
```

`tools/harness.html` boots the built panel in an ordinary browser with the CEP and Node surfaces
faked, so the UI can be clicked through without Premiere.

`tools/smoke.mjs` runs the same shims under jsdom and asserts the risk verdicts, the download gate
under each policy, the `sp=` encoding, the Uppbeat credit rules and the UI wiring.

The CEF debugger is on `http://localhost:8099` while the panel is open (see `.debug`).

### Layout

```
CSXS/manifest.xml   extension manifest (MainPath -> dist/index.html)
jsx/MediaRade.jsx   ExtendScript host: import, insert, markers, bins
src/core/           licence engine, yt-dlp, uppbeat, queue, library, ledger, paths
src/ui/             shared components, drag-and-drop, placement, modal, toast
src/views/          browse, video, queue, uppbeat, library, compliance, log, settings
css/                ps2ui.css (ported tokens + components) and mediarade.css
tools/              dev harness and smoke test
```

> `js/` holds the original pre-SolidJS implementation. Nothing loads it — `dist/` is built from
> `src/`. It is kept only for reference and can be deleted.

---

## Files it writes

```
Documents\MediaRade\
  Downloads\Video, Audio, Thumbnails, Subtitles
  Downloads\Audio\Uppbeat
  Licenses\                 .license.json per download
  Compliance\               license-ledger.jsonl (append-only), CREDITS.md
  Logs\                     yt-dlp output
  bin\                      optional local yt-dlp.exe / ffmpeg.exe
  config.json, library.json
```

Respect YouTube's and Uppbeat's Terms of Service and the rights of creators.
