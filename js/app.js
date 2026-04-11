
// ── GLOBALS ─────────────────────────────────────────────────────────────
const ANILIST = "https://graphql.anilist.co";

let currentPage     = "home";
let prevPage        = "home";
let heroList        = [];
let heroIdx         = 0;
let heroTimer       = null;
let heroHovered     = false;
let playerAnime     = null;
let playerEp        = 1;
let playerStream    = null;
let playerSubs      = [];
let playerQualities = {};
let searchPage      = 1;
let searchMode      = "search"; // "search" | "genre"
let searchQuery     = "";
let searchGenre     = "";
let wlFilter        = "All";

const GENRES = [
  "Action","Adventure","Comedy","Drama","Fantasy","Horror",
  "Mystery","Romance","Sci-Fi","Slice of Life","Sports","Supernatural",
  "Thriller","Psychological","Mecha","Music","Ecchi","Shounen","Shoujo","Seinen"
];

const PAGE_LABELS = {
  home: "Home",
  search: "Search",
  watchlist: "Watchlist",
  history: "History",
  downloads: "Downloads",
  settings: "Settings",
  detail: "Anime Details"
};

function syncChrome(page) {
  const label = PAGE_LABELS[page] || page;
  const topbar = document.getElementById("topbar-title");
  if (topbar) topbar.textContent = label;
  document.title = `${label} · AniCult`;
}

// ── ANILIST API ──────────────────────────────────────────────────────────
async function anilistQuery(query, variables = {}) {
  try {
    const res = await fetch(ANILIST, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ query, variables })
    });
    const data = await res.json();
    return data.data || {};
  } catch (e) {
    console.error("[AniList]", e);
    return {};
  }
}

const GQL_CARD = `
  id
  title { romaji english }
  coverImage { large medium }
  bannerImage
  episodes
  status
  format
  averageScore
  genres
  description(asHtml: false)
  season
  seasonYear
`;

async function fetchTrending(page = 1, perPage = 20) {
  const d = await anilistQuery(`
    query($p:Int,$n:Int){
      Page(page:$p,perPage:$n){
        media(type:ANIME,sort:TRENDING_DESC){ ${GQL_CARD} }
      }
    }
  `, { p: page, n: perPage });
  return d.Page?.media || [];
}

async function fetchTopRated(page = 1, perPage = 20) {
  const d = await anilistQuery(`
    query($p:Int,$n:Int){
      Page(page:$p,perPage:$n){
        media(type:ANIME,sort:SCORE_DESC,format_in:[TV,MOVIE,OVA]){ ${GQL_CARD} }
      }
    }
  `, { p: page, n: perPage });
  return d.Page?.media || [];
}

async function fetchSeasonal(season, year, perPage = 20) {
  const d = await anilistQuery(`
    query($s:MediaSeason,$y:Int,$n:Int){
      Page(perPage:$n){
        media(type:ANIME,season:$s,seasonYear:$y,sort:POPULARITY_DESC){ ${GQL_CARD} }
      }
    }
  `, { s: season, y: year, n: perPage });
  return d.Page?.media || [];
}

async function fetchSearch(q, page = 1, perPage = 21) {
  const d = await anilistQuery(`
    query($q:String,$p:Int,$n:Int){
      Page(page:$p,perPage:$n){
        pageInfo { total hasNextPage }
        media(search:$q,type:ANIME,sort:SEARCH_MATCH){ ${GQL_CARD} }
      }
    }
  `, { q, p: page, n: perPage });
  return d.Page || {};
}

async function fetchByGenre(genre, page = 1, perPage = 21) {
  const d = await anilistQuery(`
    query($g:String,$p:Int,$n:Int){
      Page(page:$p,perPage:$n){
        pageInfo { total hasNextPage }
        media(genre:$g,type:ANIME,sort:POPULARITY_DESC){ ${GQL_CARD} }
      }
    }
  `, { g: genre, p: page, n: perPage });
  return d.Page || {};
}

async function fetchAnimeDetail(id) {
  const d = await anilistQuery(`
    query($id:Int){
      Media(id:$id,type:ANIME){
        id
        title { romaji english native }
        coverImage { extraLarge large }
        bannerImage
        description(asHtml:false)
        episodes status format
        averageScore meanScore popularity favourites
        genres
        tags { name rank }
        season seasonYear
        startDate { year month day }
        endDate   { year month day }
        studios(isMain:true){ nodes { name siteUrl } }
        characters(sort:ROLE,perPage:8){ nodes { name { full } image { large } } }
        recommendations(sort:RATING_DESC,perPage:8){
          nodes { mediaRecommendation { id title { romaji } coverImage { medium } averageScore } }
        }
        trailer { id site }
      }
    }
  `, { id });
  return d.Media || null;
}

// ── HELPERS ──────────────────────────────────────────────────────────────
function getTitle(anime) {
  const t = anime?.title || {};
  return t.english || t.romaji || t.native || "Unknown";
}

function getCover(anime) {
  const c = anime?.coverImage || {};
  return c.extraLarge || c.large || c.medium || "";
}

function cleanDesc(t, n = 350) {
  if (!t) return "No description available.";
  t = t.replace(/<[^>]+>/g, "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function scoreColor(s) {
  if (!s)    return "var(--grey3)";
  if (s >= 80) return "var(--green)";
  if (s >= 60) return "var(--gold)";
  return "var(--accent2)";
}

function currentSeason() {
  const m = new Date().getMonth() + 1;
  const y = new Date().getFullYear();
  const s = m <= 3 ? "WINTER" : m <= 6 ? "SPRING" : m <= 9 ? "SUMMER" : "FALL";
  return { s, y };
}

// ── CARD HTML ─────────────────────────────────────────────────────────────
function cardHTML(anime) {
  const score    = anime.averageScore;
  const scoreStr = score ? `★ ${(score / 10).toFixed(1)}` : "";
  const scoreBg  = score >= 80 ? "var(--green)" : score >= 60 ? "var(--gold)" : score ? "var(--accent)" : "var(--bg4)";
  const genres   = (anime.genres || []).slice(0, 2).join(" · ");
  const fmt      = (anime.format || "").replace(/_/g, " ");
  const cover    = getCover(anime);

  return `
    <div class="card" onclick='openDetail(${JSON.stringify(anime).replace(/'/g, "&#39;")})'>
      <div class="card-img">
        <img src="${cover}" loading="lazy" onerror="this.style.display='none'" alt="${getTitle(anime)}"/>
        <div class="card-img-overlay"></div>
        ${scoreStr ? `<div class="card-score" style="background:${scoreBg}">${scoreStr}</div>` : ""}
        ${fmt      ? `<div class="card-format">${fmt}</div>` : ""}
      </div>
      <div class="card-body">
        <div class="card-title">${getTitle(anime)}</div>
        <div class="card-genre">${genres}</div>
      </div>
    </div>`;
}

// ── NAVIGATION ────────────────────────────────────────────────────────────
function navigate(page) {
  if (page === "detail" || page === currentPage) return;
  prevPage    = currentPage;
  currentPage = page;

  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");

  document.querySelectorAll(".nav-item").forEach(n => {
    n.classList.toggle("active", n.dataset.page === page);
  });

  syncChrome(page);

  if (page === "watchlist") loadWatchlist();
  if (page === "history")   loadHistory();
  if (page === "downloads") loadDownloads();
  if (page === "settings")  loadSettings();
}

function showDetail(anime) {
  prevPage    = currentPage;
  currentPage = "detail";

  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("page-detail").classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  syncChrome("detail");

  renderDetail(anime);
}

function goBack() {
  navigate(prevPage === "detail" ? "home" : prevPage);
}

// nav click + keyboard
document.querySelectorAll(".nav-item").forEach(n => {
  n.addEventListener("click", () => navigate(n.dataset.page));
  n.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigate(n.dataset.page);
    }
  });
});

// ── HOME ──────────────────────────────────────────────────────────────────
async function loadHome() {
  const { s, y } = currentSeason();
  const [trending, topRated, seasonal] = await Promise.all([
    fetchTrending(1, 20),
    fetchTopRated(1, 20),
    fetchSeasonal(s, y, 20)
  ]);

  heroList = trending.slice(0, 8);
  heroIdx  = 0;
  renderHero();

  document.getElementById("trending-row").innerHTML  = trending.map(cardHTML).join("");
  document.getElementById("toprated-row").innerHTML  = topRated.map(cardHTML).join("");
  document.getElementById("seasonal-row").innerHTML  = seasonal.map(cardHTML).join("");
}

function renderHero() {
  if (!heroList.length) return;
  const a      = heroList[heroIdx];
  const imgEl  = document.getElementById("hero-img");
  const banner = a.bannerImage || getCover(a);

  imgEl.style.opacity = 0;
  setTimeout(() => {
    imgEl.src = banner;
    imgEl.style.opacity = 1;
  }, 180);

  document.getElementById("hero-title").textContent = getTitle(a);
  const scoreStr = a.averageScore ? `★ ${(a.averageScore / 10).toFixed(1)}  ·  ` : "";
  document.getElementById("hero-meta").textContent =
    `${scoreStr}${(a.format || "").replace(/_/g, " ")}  ·  ${a.episodes || "?"} eps  ·  ${a.season || ""} ${a.seasonYear || ""}`;
  document.getElementById("hero-desc").textContent = cleanDesc(a.description, 180);

  const dotsEl = document.getElementById("hero-dots");
  if (dotsEl.children.length !== heroList.length) {
    dotsEl.innerHTML = heroList.map((_, i) =>
      `<div class="hero-dot${i === 0 ? " active" : ""}"
            onclick="event.stopPropagation();gotoHero(${i})"
            aria-label="Hero slide ${i + 1}"></div>`
    ).join("");
  } else {
    [...dotsEl.children].forEach((d, i) => d.classList.toggle("active", i === heroIdx));
  }

  clearTimeout(heroTimer);
  heroTimer = setTimeout(() => {
    if (!heroHovered) {
      heroIdx = (heroIdx + 1) % heroList.length;
      renderHero();
    }
  }, 6000);
}

function gotoHero(i)  { heroIdx = i; renderHero(); }
function heroClick()   { if (heroList[heroIdx]) showDetail(heroList[heroIdx]); }
function heroWatch()   {
  const a = heroList[heroIdx];
  if (a) { showDetail(a); setTimeout(() => openPlayer(a, 1), 400); }
}
function heroDetail() { heroClick(); }

// pause auto-advance on hover
document.getElementById("hero").addEventListener("mouseenter", () => { heroHovered = true; });
document.getElementById("hero").addEventListener("mouseleave", () => {
  heroHovered = false;
  clearTimeout(heroTimer);
  heroTimer = setTimeout(() => {
    heroIdx = (heroIdx + 1) % heroList.length;
    renderHero();
  }, 6000);
});

// ── SEARCH ────────────────────────────────────────────────────────────────
function buildGenrePills() {
  document.getElementById("genre-pills").innerHTML = GENRES.map(g =>
    `<div class="genre-pill" onclick="searchByGenre('${g}')">${g}</div>`
  ).join("");
}

async function doSearch() {
  const q = document.getElementById("search-input-big").value.trim();
  if (!q) return;

  searchQuery = q;
  searchMode  = "search";
  searchPage  = 1;

  document.querySelectorAll(".genre-pill").forEach(p => p.classList.remove("active"));
  document.getElementById("search-label").textContent = "Searching…";
  document.getElementById("search-grid").innerHTML = `
    <div style="grid-column:1/-1;display:flex;justify-content:center;padding:40px 0">
      <div class="spinner" style="margin:0"></div>
    </div>`;
  document.getElementById("load-more-btn").style.display = "none";

  const res   = await fetchSearch(q, 1);
  const media = res.media || [];
  const total = res.pageInfo?.total || media.length;

  document.getElementById("search-label").textContent =
    total ? `${total} result${total !== 1 ? "s" : ""} for "${q}"` : `No results for "${q}"`;
  document.getElementById("search-grid").innerHTML = media.map(cardHTML).join("");

  if (res.pageInfo?.hasNextPage) {
    document.getElementById("load-more-btn").style.display = "block";
  }
}

async function searchByGenre(g) {
  searchGenre = g;
  searchMode  = "genre";
  searchPage  = 1;

  document.querySelectorAll(".genre-pill").forEach(p => p.classList.toggle("active", p.textContent === g));
  document.getElementById("search-label").textContent = `Genre: ${g}`;
  document.getElementById("search-grid").innerHTML = `
    <div style="grid-column:1/-1;display:flex;justify-content:center;padding:40px 0">
      <div class="spinner" style="margin:0"></div>
    </div>`;
  document.getElementById("load-more-btn").style.display = "none";

  const res   = await fetchByGenre(g, 1);
  const media = res.media || [];
  document.getElementById("search-grid").innerHTML = media.map(cardHTML).join("");

  if (res.pageInfo?.hasNextPage) {
    document.getElementById("load-more-btn").style.display = "block";
  }
}

async function loadMore() {
  searchPage++;
  const res   = searchMode === "search"
    ? await fetchSearch(searchQuery, searchPage)
    : await fetchByGenre(searchGenre, searchPage);
  const media = res.media || [];
  document.getElementById("search-grid").innerHTML += media.map(cardHTML).join("");
  if (!res.pageInfo?.hasNextPage) {
    document.getElementById("load-more-btn").style.display = "none";
  }
}

// Enter key on big search input — Bug fix
document.getElementById("search-input-big").addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch();
});

// ── DETAIL ────────────────────────────────────────────────────────────────
function openDetail(anime) { showDetail(anime); }

async function renderDetail(animeSummary) {
  // Populate immediately from summary data
  document.getElementById("detail-title").textContent    = getTitle(animeSummary);
  document.getElementById("detail-cover-img").src        = getCover(animeSummary);
  document.getElementById("detail-banner-img").src       = animeSummary.bannerImage || getCover(animeSummary);
  document.getElementById("detail-title-jp").textContent = "";
  document.getElementById("detail-desc").textContent     = "Loading…";
  document.getElementById("ep-grid").innerHTML           = "";
  document.getElementById("detail-stats").innerHTML      = "";
  document.getElementById("detail-genres").innerHTML     = "";
  document.getElementById("detail-actions").innerHTML    = "";
  document.getElementById("detail-studio").textContent   = "";
  document.getElementById("char-divider").style.display  = "none";
  document.getElementById("rec-divider").style.display   = "none";
  document.getElementById("char-row").innerHTML          = "";
  document.getElementById("rec-row").innerHTML           = "";
  document.getElementById("page-detail").scrollTop       = 0;

  const anime = await fetchAnimeDetail(animeSummary.id);
  if (!anime) {
    document.getElementById("detail-title").textContent = "Failed to load";
    return;
  }

  const title  = getTitle(anime);
  const cover  = getCover(anime);
  const banner = anime.bannerImage || cover;

  document.getElementById("detail-banner-img").src = banner;
  document.getElementById("detail-cover-img").src  = cover;
  document.getElementById("detail-title").textContent =
    anime.title?.english || anime.title?.romaji || title;

  const jp = (anime.title?.english && anime.title?.romaji)
    ? anime.title.romaji
    : (anime.title?.native || "");
  document.getElementById("detail-title-jp").textContent = jp;
  window.currentDetailAnime = anime;

  // Stats
  const score = anime.averageScore;
  const stats = [
    { label: "Score",    value: score ? `${(score / 10).toFixed(1)}/10` : "N/A", color: scoreColor(score) },
    { label: "Format",   value: (anime.format || "N/A").replace(/_/g, " "),       color: "var(--white)" },
    { label: "Episodes", value: anime.episodes || "?",                            color: "var(--white)" },
    { label: "Status",   value: (anime.status || "N/A").replace(/_/g, " "),
      color: anime.status === "RELEASING" ? "var(--green)" : "var(--white)" },
  ];
  if (anime.season && anime.seasonYear) {
    stats.push({
      label: "Season",
      value: `${anime.season.charAt(0) + anime.season.slice(1).toLowerCase()} ${anime.seasonYear}`,
      color: "var(--white)"
    });
  }
  document.getElementById("detail-stats").innerHTML = stats.map(s => `
    <div class="stat-block">
      <div class="label">${s.label}</div>
      <div class="value" style="color:${s.color}">${s.value}</div>
    </div>`
  ).join("");

  // Genres
  document.getElementById("detail-genres").innerHTML = (anime.genres || []).map(g =>
    `<div class="genre-tag" onclick="searchByGenre('${g}');navigate('search')">${g}</div>`
  ).join("");

  // Studio
  const studios = (anime.studios?.nodes || []).map(s => s.name).join(", ");
  document.getElementById("detail-studio").textContent = studios ? `Studio: ${studios}` : "";

  // Description
  document.getElementById("detail-desc").textContent = cleanDesc(anime.description, 900);

  // Action buttons
  const inWl = await checkWatchlist(anime.id);
  renderDetailActions(anime, inWl);

  // Episodes
  const epCount = anime.episodes || 0;
  if (epCount > 0) {
    let epHTML = "";
    for (let i = 1; i <= epCount; i++) {
      epHTML += `<button type="button" class="ep-btn" onclick="openPlayer(currentDetailAnime,${i})">${i}</button>`;
    }
    document.getElementById("ep-grid").innerHTML = epHTML;
  } else {
    document.getElementById("ep-grid").innerHTML =
      `<p style="color:var(--grey3);font-size:13px;font-family:var(--mono)">Episode list unavailable for this title.</p>`;
  }

  // Characters
  const chars = anime.characters?.nodes || [];
  if (chars.length) {
    document.getElementById("char-divider").style.display = "flex";
    document.getElementById("char-row").innerHTML = chars.map(c => `
      <div class="char-card">
        <img src="${c.image?.large || ""}" loading="lazy" onerror="this.style.display='none'" alt="${c.name?.full || ""}"/>
        <div class="char-name">${c.name?.full || ""}</div>
      </div>`
    ).join("");
  }

  // Recommendations
  const recs = (anime.recommendations?.nodes || [])
    .map(n => n.mediaRecommendation)
    .filter(Boolean);
  if (recs.length) {
    document.getElementById("rec-divider").style.display = "flex";
    document.getElementById("rec-row").innerHTML = recs.map(r => `
      <div class="rec-card" onclick='openDetail(${JSON.stringify(r).replace(/'/g, "&#39;")})'>
        <img src="${r.coverImage?.medium || ""}" loading="lazy" onerror="this.style.display='none'" alt="${getTitle(r)}"/>
        <div class="rec-title">${getTitle(r)}</div>
      </div>`
    ).join("");
  }

  window.currentDetailAnime = anime;
}

function renderDetailActions(anime, wlEntry) {
  const inWl   = !!wlEntry;
  const icPlay = `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  const icBook = `<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;

  // Bug fix: use correct conditional classes — avoid applying btn-ghost always
  document.getElementById("detail-actions").innerHTML = `
    <button type="button" class="btn btn-primary" onclick="openPlayer(currentDetailAnime,1)">
      ${icPlay} Watch
    </button>
    <button type="button" class="btn ${inWl ? "btn-ghost" : "btn-outline"}" id="wl-toggle-btn"
            onclick="toggleWatchlist(currentDetailAnime)">
      ${icBook} ${inWl ? "In Watchlist" : "Add to Watchlist"}
    </button>
    ${anime.trailer?.site === "youtube"
      ? `<button type="button" class="btn btn-outline"
                 onclick="window.open('https://youtube.com/watch?v=${anime.trailer.id}','_blank')">
           ${icPlay} Trailer
         </button>`
      : ""
    }`;
}

function checkWatchlist(animeId) {
  const list = getWatchlist();
  return list.find(i => i.anime_id === animeId) || null;
}

function toggleWatchlist(anime) {
  const list = getWatchlist();
  const existingIdx = list.findIndex(i => i.anime_id === anime.id);
  if (existingIdx > -1) {
    list.splice(existingIdx, 1);
    toast("Removed from watchlist", "ok");
  } else {
    list.push({
      anime_id: anime.id,
      title: getTitle(anime),
      cover_url: getCover(anime),
      status: "Plan to Watch",
      total_eps: anime.episodes || 0,
      progress: 0,
      score: null
    });
    toast("Added to watchlist", "ok");
  }
  saveWatchlist(list);
  renderDetailActions(anime, checkWatchlist(anime.id));
}

// ── PLAYER ────────────────────────────────────────────────────────────────
async function openPlayer(anime, ep) {
  playerAnime     = anime;
  playerEp        = ep;
  playerStream    = null;
  playerSubs      = [];
  playerQualities = {};

  document.getElementById("player-overlay").classList.add("open");
  document.getElementById("player-title").textContent =
    `${getTitle(anime)}  ·  Episode ${ep}`;
  document.getElementById("player-ep-label").textContent =
    `Ep ${ep} / ${anime.episodes || "?"}`;
  document.getElementById("player-status").innerHTML =
    `<div class="spinner"></div>Fetching stream…`;
  document.getElementById("quality-sel").innerHTML = `<option>Auto</option>`;
  document.getElementById("sub-sel").innerHTML     = `<option value="">None</option>`;

  // Log history (fire-and-forget)
  fetch("/api/history", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ anime_id: anime.id, title: getTitle(anime), episode: ep })
  }).catch(() => {});

  // Update watchlist progress (fire-and-forget)
  const list = getWatchlist();
  const idx = list.findIndex(i => i.anime_id === anime.id);
  if (idx > -1) { list[idx].progress = ep; saveWatchlist(list); }

  await fetchStream();
}

async function fetchStream() {
  try {
    const title  = getTitle(playerAnime);
    const server = document.getElementById("server-sel").value || "hd-1";

    // Step 1: find anime in stream DB
    const sRes   = await fetch(`/api/stream/search?q=${encodeURIComponent(title)}`);
    const sData  = await sRes.json();
    const animes = sData.animes || [];
    if (!animes.length) throw new Error("Anime not found in stream database");
    const slug = animes[0].id;

    // Step 2: get episode list
    const eRes     = await fetch(`/api/stream/episodes/${slug}`);
    const eData    = await eRes.json();
    const episodes = eData.episodes || [];
    const target   = episodes.find(e => e.number === playerEp) || episodes[playerEp - 1];
    if (!target) throw new Error(`Episode ${playerEp} not found`);
    const epId = target.episodeId || target.id;

    // Step 3: get stream sources
    const srcRes  = await fetch(`/api/stream/sources?id=${encodeURIComponent(epId)}&server=${server}&category=sub`);
    const srcData = await srcRes.json();
    const sources = srcData.sources || [];
    playerSubs    = (srcData.tracks || []).filter(t => t.kind === "captions" || t.kind === "subtitles");

    if (!sources.length) throw new Error("No stream sources found — try a different server.");

    // Build quality map
    sources.forEach(s => {
      playerQualities[s.quality || "auto"] = s.url;
    });
    playerStream = playerQualities["1080p"] || playerQualities["720p"] || sources[0].url;

    // Update quality dropdown
    const qualOpts = Object.keys(playerQualities);
    document.getElementById("quality-sel").innerHTML =
      qualOpts.map(q => `<option value="${q}">${q}</option>`).join("");

    // Bug fix: was using array + array concatenation — now using proper array spread
    const subOptsArr = [
      `<option value="">None</option>`,
      ...playerSubs.map(t => `<option value="${t.file || t.url || ""}">${t.label || "Sub"}</option>`)
    ];
    document.getElementById("sub-sel").innerHTML = subOptsArr.join("");

    document.getElementById("player-status").innerHTML = `
      <div style="display:flex;justify-content:center;margin-bottom:10px">
        <svg class="icon" style="width:22px;height:22px;stroke:var(--green);opacity:1" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
      </div>
      Stream ready<br>
      <span style="font-size:10.5px;opacity:.45">Available: ${qualOpts.join(", ")}</span><br>
      <span style="font-size:10.5px;opacity:.45">Open in MPV or VLC · or copy URL</span>`;

  } catch (e) {
    document.getElementById("player-status").innerHTML = `
      <div style="display:flex;justify-content:center;margin-bottom:10px">
        <svg class="icon" style="width:22px;height:22px;stroke:var(--danger);opacity:1" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      ${e.message}<br>
      <span style="font-size:10.5px;opacity:.38">Make sure aniwatch-api is running · Settings → API URL</span>`;
  }
}

function getSelectedStream() {
  const q = document.getElementById("quality-sel").value;
  return playerQualities[q] || playerStream;
}

function openMPV() {
  const url = getSelectedStream();
  if (!url) { toast("Stream not ready yet", "err"); return; }
  window.location.href = `mpv://${url}`;
  toast("Opening in MPV…", "ok");
}
function openVLC() {
  const url = getSelectedStream();
  if (!url) { toast("Stream not ready yet", "err"); return; }
  window.location.href = `vlc://${url}`;
  toast("Opening in VLC…", "ok");
}
function copyStream() {
  const url = getSelectedStream();
  if (!url) { toast("No stream yet", "err"); return; }
  navigator.clipboard.writeText(url);
  toast("Stream URL copied!", "ok");
}

async function downloadEp() {
  const url = getSelectedStream();
  if (!url) { toast("No stream yet", "err"); return; }
  await fetch("/api/downloads", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      url,
      anime_id: playerAnime.id,
      title:    getTitle(playerAnime),
      episode:  playerEp
    })
  });
  toast("Download started", "ok");
}

function prevEp() {
  if (playerEp > 1) { playerEp--; openPlayer(playerAnime, playerEp); }
}
function nextEp() {
  const max = playerAnime?.episodes || 9999;
  if (playerEp < max) { playerEp++; openPlayer(playerAnime, playerEp); }
}

document.getElementById("player-close").onclick = () => {
  document.getElementById("player-overlay").classList.remove("open");
};
document.getElementById("player-overlay").onclick = e => {
  if (e.target === document.getElementById("player-overlay")) {
    document.getElementById("player-overlay").classList.remove("open");
  }
};
document.getElementById("server-sel").onchange = () => fetchStream();

// Escape key closes player
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.getElementById("player-overlay").classList.remove("open");
  }
  // "/" shortcut focuses search
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
    e.preventDefault();
    navigate("search");
    setTimeout(() => document.getElementById("search-input-big").focus(), 80);
  }
});

// ── WATCHLIST (localStorage) ───────────────────────────────────────────
const WL_STATUSES = ["All","Watching","Completed","Plan to Watch","On Hold","Dropped"];

function getWatchlist() {
  try { return JSON.parse(localStorage.getItem("anicult_watchlist")) || []; }
  catch { return []; }
}
function saveWatchlist(list) {
  localStorage.setItem("anicult_watchlist", JSON.stringify(list));
}

function loadWatchlist() {
  const tabs = document.getElementById("wl-tabs");
  tabs.innerHTML = WL_STATUSES.map(s =>
    `<div class="status-tab${wlFilter === s ? " active" : ""}"
          onclick="setWlFilter('${s}')">${s}</div>`
  ).join("");

  const allItems = getWatchlist();
  const items = wlFilter === "All" ? allItems : allItems.filter(i => i.status === wlFilter);
  const list  = document.getElementById("wl-list");

  if (!items.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">
          <svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        Nothing here yet.<br>Browse anime and add to your watchlist.
      </div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const pct = item.total_eps ? Math.min(item.progress / item.total_eps, 1) * 100 : 0;
    return `
      <div class="wl-item" onclick="fetchAndOpenDetail(${item.anime_id},'${escapeQ(item.title)}','${escapeQ(item.cover_url || "")}')">
        <div class="wl-cover">
          <img src="${item.cover_url || ""}" loading="lazy" onerror="this.style.opacity=0" alt=""/>
        </div>
        <div class="wl-info">
          <div class="wl-title">${item.title}</div>
          <div class="wl-sub">${item.status} · EP ${item.progress}/${item.total_eps || "?"} · Score: ${item.score || "—"}/10</div>
          <div class="wl-progress-bar">
            <div class="wl-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="wl-actions" onclick="event.stopPropagation()">
          <select class="wl-status-sel" onchange="updateWlStatus(${item.anime_id},this.value)">
            ${WL_STATUSES.slice(1).map(s => `<option${s === item.status ? " selected" : ""}>${s}</option>`).join("")}
          </select>
          <button type="button" class="wl-remove" aria-label="Remove from watchlist"
                  onclick="removeWl(${item.anime_id})">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join("");
}

function setWlFilter(f) { wlFilter = f; loadWatchlist(); }

function updateWlStatus(id, status) {
  const list = getWatchlist();
  const idx = list.findIndex(i => i.anime_id === id);
  if (idx > -1) { list[idx].status = status; saveWatchlist(list); }
  loadWatchlist();
}

function removeWl(id) {
  if (!confirm("Remove from watchlist?")) return;
  const list = getWatchlist().filter(i => i.anime_id !== id);
  saveWatchlist(list);
  toast("Removed", "ok");
  loadWatchlist();
}

function fetchAndOpenDetail(id, title, cover) {
  openDetail({ id, title: { romaji: title }, coverImage: { large: cover } });
}

// ── HISTORY ───────────────────────────────────────────────────────────────
async function loadHistory() {
  const res   = await fetch("/api/history");
  const items = await res.json();
  const list  = document.getElementById("hist-list");

  if (!items.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">
          <svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        No watch history yet.
      </div>`;
    return;
  }

  list.innerHTML = items.map(h => `
    <div class="hist-item">
      <div class="hist-ep">EP ${h.episode}</div>
      <div class="hist-title">${h.title}</div>
      <div class="hist-date">${(h.watched_at || "").slice(0, 10)}</div>
    </div>`
  ).join("");
}

async function clearHistory() {
  if (!confirm("Clear all watch history?")) return;
  await fetch("/api/history", { method: "DELETE" });
  loadHistory();
  toast("History cleared", "ok");
}

// ── DOWNLOADS ─────────────────────────────────────────────────────────────
async function loadDownloads() {
  const res   = await fetch("/api/downloads");
  const items = await res.json();
  const list  = document.getElementById("dl-list");

  if (!items.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">
          <svg class="icon icon-lg" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </div>
        No downloads yet.
      </div>`;
    return;
  }

  list.innerHTML = items.map(d => `
    <div class="dl-item">
      <div class="dl-info">
        <div class="dl-title">${d.title}</div>
        <div class="dl-ep">Episode ${d.episode} · ${d.downloaded_at?.slice(0, 10) || ""}</div>
      </div>
      <div class="dl-status ${d.status}">${d.status}</div>
      <button type="button" class="btn btn-outline btn-sm" aria-label="Remove download"
              onclick="deleteDownload(${d.id})">
        <svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>`
  ).join("");
}

async function deleteDownload(id) {
  await fetch(`/api/downloads/${id}`, { method: "DELETE" });
  loadDownloads();
}

// ── SETTINGS ──────────────────────────────────────────────────────────────
async function loadSettings() {
  const res  = await fetch("/api/settings");
  const data = await res.json();
  document.getElementById("s-aniwatch").value  = data.aniwatch_base   || "";
  document.getElementById("s-dl-folder").value = data.download_folder || "";
  const player = data.player || "mpv";
  document.querySelectorAll("[name=player]").forEach(r => r.checked = r.value === player);
}

async function saveSettings() {
  const player = [...document.querySelectorAll("[name=player]")].find(r => r.checked)?.value || "mpv";
  await fetch("/api/settings", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      aniwatch_base:   document.getElementById("s-aniwatch").value.trim(),
      download_folder: document.getElementById("s-dl-folder").value.trim(),
      player
    })
  });
  toast("Settings saved", "ok");
}

// ── TOPBAR SEARCH ─────────────────────────────────────────────────────────
document.getElementById("topbar-search").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    const q = e.target.value.trim();
    if (!q) return;
    document.getElementById("search-input-big").value = q;
    navigate("search");
    setTimeout(doSearch, 100);
  }
});

// ── TOAST ─────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = "ok") {
  const el = document.getElementById("toast");
  document.getElementById("toast-msg").textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

// ── UTILS ─────────────────────────────────────────────────────────────────
function escapeQ(s) {
  return (s || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// ── INIT ──────────────────────────────────────────────────────────────────
buildGenrePills();
syncChrome("home");
loadHome();
