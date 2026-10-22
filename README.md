# SoundStack 🎵

A 3D cover-stack music player for Odisus's own Suno songs. Mobile-first PWA: plain HTML/CSS/JS, no build step, works offline.

**Open:** https://danielo3222.github.io/soundstack/ (in Safari: Share → Add to Home Screen)

## What it does
- Your songs sit as glossy 3D CD cases in a diagonal stack, each showing its real Suno cover. Swipe the stack down-left for the next song, up-right to go back, or tap the front case to play/pause.
- **Pick for me** spins through the stack like a slot machine (with soft clicks and a buzz on Android), slows down, and lands on a song with a ✦ Tonight's pick badge.
- The whole background glows in the colors of the song in front and crossfades when it changes. The stack gently drifts when idle.
- Waveform scrubber: tap or drag anywhere on it to jump in the song.
- Play/pause, next/previous, shuffle, repeat (all / one / off), ♥ favorites with a "Favorites only" filter, search.
- Keeps playing with the screen locked; lock-screen and headphone controls show the title and cover art.
- Works offline once opened (songs are saved the first time they play).

## Adding songs
**On the phone (no help needed):** download the song from Suno as MP3 (⋯ → Download → MP3), open SoundStack, tap **＋** (top right) and pick the file. The title, artist and cover art are read from the MP3, the glow color comes from the cover, and the song stays on that phone (IndexedDB) even offline. Remove one in ☰ Library with the ×.

**Bundled for everyone:** put the MP3 in `songs/`, a square cover in `covers/` (optional), and add a line to `songs.js`. Only `file` and `title` are required; a missing cover/color is read from the MP3's embedded art. Or rebuild the whole list from a folder of Suno downloads:
```
python3 tools_build_songs.py /workspace/shared-music keep-the-beat abundance light-goes-dark ...
```
(each `<slug>/` folder holds `<slug>-with-cover.mp3` or `<slug>.mp3` and an optional `cover.jpeg`). Bump `VERSION` in `sw.js` after changes.

## Tech
`app.js` (stack, player, ID3v2 reader for title/artist/APIC cover, IndexedDB, Media Session), `style.css`, `songs.js` (song list with precomputed waveform peaks), `sw.js` (network-first shell, songs cached at runtime with Range support).

Test: serve the folder with Range support, then `python tests/test.py http://127.0.0.1:8822/` (Playwright + headless Chrome at 390×844).
