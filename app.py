"""
AniCult Web — Flask Backend  ·  Version 4
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Stream backend: AnimePahe  (https://animepahe.si)
  → No external API server needed — works out of the box.
  → Sources served via Kwik.cx (HLS / m3u8).
  → Sub only (AnimePahe does not offer dub).

Everything else (watchlist / history / downloads / settings) unchanged.
AniList is still called directly from the browser.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

from flask import Flask, request, jsonify, render_template
import sqlite3, requests, os, re, subprocess, threading, urllib.request, urllib.parse
from datetime import datetime
from html.parser import HTMLParser

app = Flask(__name__)
DB_PATH   = os.path.join(os.path.dirname(__file__), "anicult.db")

PAHE_BASE  = "https://animepahe.si"
KWIK_REF   = "https://kwik.cx"

# DDoS-Guard bypass cookies required by AnimePahe
PAHE_COOKIES = {"__ddg1_": "", "__ddg2_": ""}

# Common browser headers
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# ── DB ───────────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY,
                anime_id INTEGER UNIQUE,
                title TEXT, cover_url TEXT,
                status TEXT DEFAULT 'Plan to Watch',
                score INTEGER DEFAULT 0,
                progress INTEGER DEFAULT 0,
                total_eps INTEGER DEFAULT 0,
                added_at TEXT, updated_at TEXT, notes TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER, title TEXT, episode INTEGER,
                watched_at TEXT, position REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id INTEGER, title TEXT, episode INTEGER,
                file_path TEXT, status TEXT DEFAULT 'queued',
                downloaded_at TEXT, file_size TEXT DEFAULT '',
                progress INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, value TEXT
            );
        """)

init_db()

# ── HELPERS ──────────────────────────────────────────────────────────────────

def setting(key, default=""):
    with get_db() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

def pahe_get(path="", params=None, timeout=12):
    """GET from AnimePahe with required cookies."""
    url = f"{PAHE_BASE}{path}"
    return requests.get(url, params=params, cookies=PAHE_COOKIES,
                        headers={"User-Agent": BROWSER_UA}, timeout=timeout)

# ── KWIK UNPACKER ────────────────────────────────────────────────────────────
# AnimePahe serves video via Kwik.cx which obfuscates the m3u8 URL inside
# a JS packed eval(function(p,a,c,k,e,d){...}) block.  We unpack it in Python.

def _unpack_kwik(packed_js: str) -> str | None:
    """
    Unpack a JS eval(function(p,a,c,k,e,d){...}) string.
    Returns the unpacked JS, or None if it can't be decoded.
    """
    # Match: eval(function(p,a,c,k,e,{d,r}?){...}('...','...'.split('|'),...))
    m = re.search(
        r"eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)",
        packed_js, re.DOTALL
    )
    if not m:
        return None

    payload, radix, _count, symbols_raw = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
    symbols = symbols_raw.split("|")

    def base_decode(n: str, r: int) -> int:
        chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        result, n = 0, n.strip()
        for ch in n:
            result = result * r + chars.index(ch)
        return result

    def replace_token(tok: str) -> str:
        try:
            idx = base_decode(tok, radix)
            return symbols[idx] if idx < len(symbols) and symbols[idx] else tok
        except Exception:
            return tok

    # Replace all alphanumeric tokens
    unpacked = re.sub(r"\b([0-9A-Za-z]+)\b", lambda m2: replace_token(m2.group(1)), payload)
    return unpacked


def _extract_m3u8_from_kwik(kwik_url: str) -> str | None:
    """Fetch a kwik.cx/e/... page and extract the final m3u8 URL."""
    try:
        resp = requests.get(
            kwik_url,
            headers={
                "Referer":    KWIK_REF,
                "User-Agent": BROWSER_UA,
            },
            timeout=15,
        )
        html = resp.text

        # Find all eval(...) packed blocks
        packed_blocks = re.findall(r"eval\(function\(p,a,c,k,e,[dr]\).*?\}\('.*?'\|'\)\)", html, re.DOTALL)
        if not packed_blocks:
            # Broader fallback pattern
            packed_blocks = re.findall(r"eval\(.+?\)\)", html, re.DOTALL)

        for block in packed_blocks:
            unpacked = _unpack_kwik(block)
            if not unpacked:
                continue
            # Look for the m3u8 source URL
            link_m = re.search(r"source='(https?://[^']+\.m3u8[^']*)'", unpacked)
            if link_m:
                return link_m.group(1)

        return None
    except Exception as e:
        print(f"[Kwik] Failed to extract from {kwik_url}: {e}")
        return None


# ── MINI HTML PARSER — extract og:url meta ───────────────────────────────────

class _MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.og_url = None

    def handle_starttag(self, tag, attrs):
        if tag == "meta":
            attrs_d = dict(attrs)
            if attrs_d.get("property") == "og:url":
                self.og_url = attrs_d.get("content", "")


def _scrape_og_url(html: str) -> str | None:
    p = _MetaParser()
    p.feed(html)
    return p.og_url


# ── ROUTES — PAGES ───────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

# ── STREAM — SEARCH ──────────────────────────────────────────────────────────
#
#  GET /api/v2/... was the old aniwatch shape.
#  We now hit: GET https://animepahe.si/api?m=search&q=...
#  Response:   { data: [{ id, title, type, year, poster, session }] }
#  We normalise to: { animes: [{ id, title, cover_url, session }] }

@app.route("/api/stream/search")
def stream_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"animes": []})
    try:
        resp = pahe_get("/api", params={"m": "search", "q": q})
        data = resp.json()
        animes = []
        for item in data.get("data", []):
            animes.append({
                "id":        item.get("session", ""),
                "title":     item.get("title", ""),
                "cover_url": item.get("poster", ""),
                "type":      item.get("type", ""),
                "year":      item.get("year", ""),
                "session":   item.get("session", ""),
            })
        return jsonify({"animes": animes})
    except Exception as e:
        return jsonify({"error": str(e), "animes": []})


# ── STREAM — EPISODES ────────────────────────────────────────────────────────
#
#  1. Fetch the anime page: GET /anime/{session}  (or /a/{numericId})
#  2. Scrape og:url → extract numeric tempId from the URL's last segment
#  3. Paginate: GET /api?m=release&id={tempId}&sort=episode_asc&page=N
#  Response: { episodes: [{ id: "{epSession}${animeSession}", number, title }] }

@app.route("/api/stream/episodes/<path:slug>")
def stream_episodes(slug):
    try:
        # slug is the anime session string, e.g. "attack-on-titan"
        path = f"/anime/{slug}" if "-" in slug else f"/a/{slug}"
        page_resp = pahe_get(path)
        html = page_resp.text

        og_url = _scrape_og_url(html)
        if not og_url:
            return jsonify({"error": "Could not find og:url in anime page", "episodes": []})

        temp_id = og_url.rstrip("/").split("/")[-1]

        # Page 1
        r1 = pahe_get("/api", params={"m": "release", "id": temp_id,
                                       "sort": "episode_asc", "page": 1})
        page1 = r1.json()
        last_page = page1.get("last_page", 1)
        all_eps_raw = list(page1.get("data", []))

        # Remaining pages
        for page_num in range(2, last_page + 1):
            rp = pahe_get("/api", params={"m": "release", "id": temp_id,
                                           "sort": "episode_asc", "page": page_num})
            all_eps_raw.extend(rp.json().get("data", []))

        episodes = []
        for item in all_eps_raw:
            ep_num = item.get("episode", 0)
            # Skip decimal/filler episodes
            if not float(ep_num).is_integer():
                continue
            episodes.append({
                "id":     f"{item['session']}${slug}",
                "number": int(ep_num),
                "title":  item.get("title") or f"Episode {int(ep_num)}",
                "snapshot": item.get("snapshot", ""),
            })

        episodes.sort(key=lambda e: e["number"])
        return jsonify({"episodes": episodes, "totalEpisodes": len(episodes)})
    except Exception as e:
        return jsonify({"error": str(e), "episodes": []})


# ── STREAM — SOURCES ─────────────────────────────────────────────────────────
#
#  id format: "{episodeSession}${animeSession}"
#  1. Fetch /play/{animeSession}/{episodeSession}
#  2. Collect all <button data-src="kwik.cx/e/..."> elements
#  3. For each kwik URL, unpack the obfuscated JS to get the m3u8

@app.route("/api/stream/sources")
def stream_sources():
    ep_id = request.args.get("id", "")
    if "$" not in ep_id:
        return jsonify({"error": "Invalid episode id format", "sources": []})

    ep_session, anime_session = ep_id.split("$", 1)

    try:
        play_resp = pahe_get(f"/play/{anime_session}/{ep_session}")
        html = play_resp.text

        # Extract all kwik URLs from data-src attributes on buttons
        # Pattern: data-src="https://kwik.cx/e/XXXXXXXX"
        kwik_urls = re.findall(r'data-src="(https://kwik\.cx/e/[^"]+)"', html)

        # Also extract quality / fansub metadata alongside each button
        # Full button pattern to get resolution + fansub
        button_pattern = re.compile(
            r'<button[^>]+data-src="(https://kwik\.cx/e/[^"]+)"'
            r'[^>]*data-resolution="(\d+)"'
            r'[^>]*data-fansub="([^"]*)"'
            r'(?:[^>]*data-audio="([^"]*)")?',
            re.DOTALL
        )
        meta_map = {}  # kwik_url → {quality, fansub, audio}
        for m in button_pattern.finditer(html):
            url_, res, fansub, audio = m.group(1), m.group(2), m.group(3), m.group(4) or ""
            meta_map[url_] = {"resolution": res, "fansub": fansub, "audio": audio}

        if not kwik_urls:
            return jsonify({"error": "No Kwik sources found on play page", "sources": []})

        sources = []
        for kwik_url in kwik_urls:
            m3u8 = _extract_m3u8_from_kwik(kwik_url)
            if not m3u8:
                continue
            meta = meta_map.get(kwik_url, {})
            res  = meta.get("resolution", "?")
            fansub = meta.get("fansub", "")
            audio  = meta.get("audio", "")
            quality = f"{res}p"
            if fansub:
                quality += f" [{fansub}]"
            if audio == "eng":
                quality += " (Eng)"
            sources.append({
                "url":     m3u8,
                "quality": quality,
                "isM3U8":  True,
            })

        # Sort by resolution descending
        def _res(s):
            m = re.match(r"(\d+)p", s["quality"])
            return int(m.group(1)) if m else 0

        sources.sort(key=_res, reverse=True)

        return jsonify({
            "sources": sources,
            "headers": {"Referer": KWIK_REF},
        })
    except Exception as e:
        return jsonify({"error": str(e), "sources": []})


# ── STREAM — INFO ────────────────────────────────────────────────────────────
#
#  Fetches the anime page and returns basic info for display.

@app.route("/api/stream/info/<path:slug>")
def stream_info(slug):
    try:
        path = f"/anime/{slug}" if "-" in slug else f"/a/{slug}"
        resp = pahe_get(path)
        html = resp.text

        # Scrape title from <title> tag
        title_m = re.search(r"<title>([^<]+)</title>", html)
        title = title_m.group(1).replace(" - AnimePahe", "").strip() if title_m else slug

        # Scrape cover from og:image
        cover_m = re.search(r'<meta property="og:image" content="([^"]+)"', html)
        cover = cover_m.group(1) if cover_m else ""

        # Scrape description from og:description
        desc_m = re.search(r'<meta property="og:description" content="([^"]+)"', html)
        desc = desc_m.group(1) if desc_m else ""

        return jsonify({
            "id":          slug,
            "title":       title,
            "cover_url":   cover,
            "description": desc,
        })
    except Exception as e:
        return jsonify({"error": str(e)})


# ── HEALTH CHECK ─────────────────────────────────────────────────────────────

@app.route("/api/health")
def health():
    try:
        r = pahe_get("/api", params={"m": "search", "q": "naruto"}, timeout=8)
        ok = r.status_code == 200 and bool(r.json().get("data"))
        return jsonify({"pahe": ok, "url": PAHE_BASE})
    except Exception as e:
        return jsonify({"pahe": False, "url": PAHE_BASE, "error": str(e)})


# ── WATCHLIST ────────────────────────────────────────────────────────────────

@app.route("/api/watchlist", methods=["GET"])
def get_watchlist():
    status = request.args.get("status")
    with get_db() as db:
        if status and status != "All":
            rows = db.execute(
                "SELECT * FROM watchlist WHERE status=? ORDER BY updated_at DESC", (status,)
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM watchlist ORDER BY updated_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/watchlist", methods=["POST"])
def add_watchlist():
    data = request.json
    now  = datetime.now().isoformat()
    with get_db() as db:
        db.execute("""
            INSERT OR REPLACE INTO watchlist
            (anime_id, title, cover_url, status, score, progress, total_eps, added_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (data["anime_id"], data["title"], data.get("cover_url", ""),
              data.get("status", "Plan to Watch"), data.get("score", 0),
              data.get("progress", 0), data.get("total_eps", 0), now, now))
    return jsonify({"ok": True})

@app.route("/api/watchlist/<int:anime_id>", methods=["DELETE"])
def remove_watchlist(anime_id):
    with get_db() as db:
        db.execute("DELETE FROM watchlist WHERE anime_id=?", (anime_id,))
    return jsonify({"ok": True})

@app.route("/api/watchlist/<int:anime_id>", methods=["PATCH"])
def update_watchlist(anime_id):
    data = request.json
    now  = datetime.now().isoformat()
    with get_db() as db:
        for field in ("status", "progress", "score", "notes"):
            if field in data:
                db.execute(f"UPDATE watchlist SET {field}=?, updated_at=? WHERE anime_id=?",
                           (data[field], now, anime_id))
    return jsonify({"ok": True})

@app.route("/api/watchlist/<int:anime_id>/check")
def check_watchlist(anime_id):
    with get_db() as db:
        row = db.execute(
            "SELECT status, progress, score FROM watchlist WHERE anime_id=?", (anime_id,)
        ).fetchone()
    return jsonify(dict(row) if row else None)


# ── HISTORY ──────────────────────────────────────────────────────────────────

@app.route("/api/history", methods=["GET"])
def get_history():
    limit = int(request.args.get("limit", 100))
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM history ORDER BY watched_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/history", methods=["POST"])
def add_history():
    data = request.json
    now  = datetime.now().isoformat()
    with get_db() as db:
        db.execute(
            "INSERT INTO history (anime_id, title, episode, watched_at) VALUES (?,?,?,?)",
            (data["anime_id"], data["title"], data["episode"], now)
        )
    return jsonify({"ok": True})

@app.route("/api/history", methods=["DELETE"])
def clear_history():
    with get_db() as db:
        db.execute("DELETE FROM history")
    return jsonify({"ok": True})


# ── DOWNLOADS ────────────────────────────────────────────────────────────────

@app.route("/api/downloads", methods=["GET"])
def get_downloads():
    with get_db() as db:
        rows = db.execute("SELECT * FROM downloads ORDER BY downloaded_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/downloads", methods=["POST"])
def start_download():
    data   = request.json
    now    = datetime.now().isoformat()
    url    = data["url"]
    title  = data["title"]
    ep     = data["episode"]
    folder = setting("download_folder", os.path.expanduser("~/Downloads"))
    safe   = re.sub(r"[^\w\s\-]", "", title)
    fname  = f"{safe} - Episode {ep}.mp4"
    fpath  = os.path.join(folder, fname)

    with get_db() as db:
        db.execute("""
            INSERT INTO downloads (anime_id, title, episode, file_path, status, downloaded_at)
            VALUES (?,?,?,?,?,?)
        """, (data.get("anime_id", 0), title, ep, fpath, "downloading", now))
        dl_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]

    def run():
        try:
            os.makedirs(folder, exist_ok=True)
            if ".m3u8" in url:
                cmd = ["ffmpeg", "-i", url,
                       "-headers", f"Referer: {KWIK_REF}\r\n",
                       "-c", "copy", "-bsf:a", "aac_adtstoasc", fpath, "-y"]
                subprocess.run(cmd, check=True, capture_output=True)
            else:
                urllib.request.urlretrieve(url, fpath)
            with get_db() as db:
                db.execute("UPDATE downloads SET status='done' WHERE id=?", (dl_id,))
        except Exception as e:
            with get_db() as db:
                db.execute("UPDATE downloads SET status='failed' WHERE id=?", (dl_id,))
            print(f"[DL] Failed: {e}")

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"ok": True, "path": fpath, "id": dl_id})

@app.route("/api/downloads/<int:dl_id>", methods=["DELETE"])
def delete_download(dl_id):
    with get_db() as db:
        db.execute("DELETE FROM downloads WHERE id=?", (dl_id,))
    return jsonify({"ok": True})


# ── SETTINGS ─────────────────────────────────────────────────────────────────

@app.route("/api/settings", methods=["GET"])
def get_settings():
    with get_db() as db:
        rows = db.execute("SELECT key, value FROM settings").fetchall()
    return jsonify({r["key"]: r["value"] for r in rows})

@app.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.json
    with get_db() as db:
        for key, value in data.items():
            db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)",
                       (key, str(value)))
    return jsonify({"ok": True})


# ── MAIN ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        print("\n  ╔═══════════════════════════════════════╗")
        print("  ║  AniCult Web  v4  🔴                  ║")
        print("  ║  Powered by AnimePahe + Kwik           ║")
        print("  ╚═══════════════════════════════════════╝")
        print("\n  → Open: http://localhost:5000\n")
    except UnicodeEncodeError:
        print("\n  AniCult Web v4  (AnimePahe + Kwik)\n\n  Open: http://localhost:5000\n")
    app.run(debug=False, host="0.0.0.0", port=5000, threaded=True)
