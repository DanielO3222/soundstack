"""Rebuild songs.js from a folder of Suno MP3s: copies audio + cover, picks the glow color from the cover, precomputes waveform peaks.
Usage: python3 tools_build_songs.py /workspace/shared-music slug1 slug2 ..."""
import sys, os, json, shutil, subprocess, colorsys, numpy as np
from PIL import Image
src, slugs = sys.argv[1], sys.argv[2:]
COLORS = {"keep-the-beat": "#8fa3c8", "abundance": "#c9963f", "light-goes-dark": "#3d6fd6", "under-the-rain": "#b48ad6", "arcadius-fury": "#35a585", "breaking-through": "#f07a5a", "viking-hardcore-motivational-remastered": "#e8963c", "shogunai": "#e0321c", "viking": "#1c86b8"}   # hand-tuned glows; auto-picked for anything else
STYLES = {"light-goes-dark": "Cinematic · Epic · Orchestral"}
out = []
for slug in slugs:
    d = os.path.join(src, slug); mp3 = os.path.join(d, slug + "-with-cover.mp3")
    if not os.path.exists(mp3): mp3 = os.path.join(d, slug + ".mp3")
    shutil.copy(mp3, f"songs/{slug}.mp3")
    cov = os.path.join(d, "cover.jpeg")
    if not os.path.exists(cov): subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp3, "-an", "-frames:v", "1", "/tmp/_c.jpg"]); cov = "/tmp/_c.jpg"
    im = Image.open(cov).convert("RGB"); w, h = im.size; s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).resize((640, 640), Image.LANCZOS); im.save(f"covers/{slug}.jpg", quality=86)
    px = np.asarray(im.resize((48, 48))).reshape(-1, 3) / 255.; bins = np.zeros(24); acc = np.zeros((24, 3))
    for p in px:
        hh, sa, v = colorsys.rgb_to_hsv(*p)
        if sa < .22 or v < .18: continue
        wgt = sa * v * (.3 + v); b = int(hh * 24) % 24; bins[b] += wgt; acc[b] += p * wgt
    if bins.max() > .5:
        c = acc[bins.argmax()] / bins.max(); hh, sa, v = colorsys.rgb_to_hsv(*c); c = colorsys.hsv_to_rgb(hh, min(1, sa * 1.15), min(.88, max(.5, v)))
    else: c = (.48, .5, .6)
    color = COLORS.get(slug) or "#%02x%02x%02x" % tuple(int(x * 255) for x in c)
    tags = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags=title,artist", "-of", "json", mp3], capture_output=True, text=True).stdout)["format"]
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", mp3, "-map", "0:a", "-ac", "1", "-ar", "4000", "-f", "s16le", "-"], capture_output=True).stdout
    a = np.abs(np.frombuffer(pcm, np.int16).astype(float)); pk = np.array([np.sqrt((x ** 2).mean()) for x in np.array_split(a, 96)]); pk = pk / pk.max()
    t = tags.get("tags", {})
    out.append(dict(file=f"songs/{slug}.mp3", title=t.get("title", slug), artist=t.get("artist", "Odisus"), style=STYLES.get(slug, "Suno original"), cover=f"covers/{slug}.jpg", color=color, duration=round(float(tags["duration"]), 1), peaks=[round(float(x), 2) for x in pk]))
    if slug == "light-goes-dark": out[-1]["featured"] = True   # first song shown on a fresh install
    print(slug, color, out[-1]["title"], out[-1]["duration"])
js = ("// SoundStack song list (rebuild with: python3 tools_build_songs.py <folder> <slugs...>, or edit by hand).\n"
      "// To add a song by hand: put the MP3 in songs/, a square cover in covers/ (optional), and add a line below. Only file and title are required;\n"
      "// a missing cover/color is read from the MP3's embedded art, and a missing waveform is drawn automatically.\n"
      "// \"file\": \"\" makes a cover-only placeholder; its MP3 attaches when you add a file with the same title in the app.\n"
      "window.SONGS = [\n" + ",\n".join("  " + json.dumps(o, ensure_ascii=False, separators=(', ', ': ')) for o in out) + "\n];\n")
open("songs.js", "w").write(js)
