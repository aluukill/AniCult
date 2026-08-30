(function () {
  "use strict";

  const ANILIST_URL = "https://graphql.anilist.co";

  const MEDIA_FIELDS_SMALL = `
    id
    idMal
    title { romaji english }
    coverImage { extraLarge large }
    format status episodes averageScore
    nextAiringEpisode { airingAt episode }
  `;

  const MEDIA_FIELDS = `
    id
    idMal
    title { romaji english native }
    coverImage { extraLarge large }
    bannerImage description genres format status episodes duration
    season seasonYear averageScore
    studios(isMain: true) { nodes { name } }
    nextAiringEpisode { airingAt episode }
    relations {
      edges {
        relationType
        node {
          id
          title { romaji english }
          coverImage { large }
          format status episodes averageScore
        }
      }
    }
  `;

  const app = document.getElementById("app");
  const searchInput = document.getElementById("nav-search-input");
  const searchForm = document.getElementById("nav-search-form");

  let currentPage = { destroy: null };

  let navToken = 0;

  const MEGAPLAY_BASE = "https://megaplay.buzz";
  const ANIKOTO_API_BASE = "https://anikotoapi.site";

  const EMBED_PROVIDERS = [
    {
      id: "megavid",
      name: "Megavid",
      makeUrl(episode, anilistId, lang = "sub", malId = null) {
        const idType = malId ? "mal" : "ani";
        const id = malId || anilistId;
        return `https://megavid.buzz/${idType}/${id}/${episode}/${lang}?color=%23e63946&autoplay=true`;
      },
    },
    {
      id: "anixo",
      name: "AniXo",
      makeUrl(episode, anilistId, lang = "sub") {
        return `https://anixo.buzz/embed/ani/${anilistId}/${episode}/${lang}?color=%23e63946`;
      },
    },
    {
      id: "megaplay",
      name: "MegaPlay",
      makeUrl(episode, anilistId, lang = "sub", malId = null) {
        const safeLang = lang === "dub" ? "dub" : "sub";
        if (malId) {
          return `${MEGAPLAY_BASE}/stream/mal/${malId}/${episode}/${safeLang}`;
        }
        return `${MEGAPLAY_BASE}/stream/ani/${anilistId}/${episode}/${safeLang}`;
      },
      makeUrlFromEpisodeId(episodeEmbedId, lang = "sub") {
        const safeLang = lang === "dub" ? "dub" : "sub";
        return `${MEGAPLAY_BASE}/stream/s-2/${episodeEmbedId}/${safeLang}`;
      },
      anikoto: {
        base: ANIKOTO_API_BASE,
        recentUrl(page = 1, perPage = 20) {
          return `${ANIKOTO_API_BASE}/recent-anime?page=${page}&per_page=${perPage}`;
        },
        seriesUrl(id) {
          return `${ANIKOTO_API_BASE}/series/${id}`;
        },
      },
    },
  ];

  function isAnixoUrl(url) {
    return /^https:\/\/anixo\.buzz\//.test(url);
  }

  function isMegaPlayUrl(url) {
    return /^https:\/\/megaplay\.buzz\//.test(url);
  }

  async function requestMegaPlayMapping({ idType, externalId, episode, message }) {
    const payload = {
      id_type: idType,
      external_id: Number(externalId),
      message: String(message || ""),
    };
    if (episode != null && String(episode).trim() !== "") {
      payload.episode = String(episode);
    }
    const res = await fetch(`${MEGAPLAY_BASE}/api/mapping-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Mapping request failed: ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.ok === false) throw new Error(data.message || "Mapping request failed");
    return data;
  }

  async function fetchAnikotoSeries(id) {
    const res = await fetch(`${ANIKOTO_API_BASE}/series/${id}`);
    if (!res.ok) throw new Error(`Anikoto API error: ${res.status}`);
    return res.json();
  }

  async function fetchAnikotoRecent(page = 1, perPage = 20) {
    const res = await fetch(
      `${ANIKOTO_API_BASE}/recent-anime?page=${page}&per_page=${perPage}`,
    );
    if (!res.ok) throw new Error(`Anikoto API error: ${res.status}`);
    return res.json();
  }

  function classifyPlayerMessage(d) {
    if (!d || typeof d !== "object") return null;
    if (d.channel === "megacloud") {
      if (d.event === "complete") return { provider: "megaplay", state: "ended" };
      if (d.event === "time") return { provider: "megaplay", state: "playing" };
      if (d.event === "error")
        return { provider: "megaplay", state: "error", message: d.message };
      return { provider: "megaplay", state: "ignored" };
    }
    if (d.type === "watching-log") {
      return { provider: "megavid", state: "playing" };
    }
    if (d.channel === "kisskh") {
      if (d.event === "complete") return { provider: "megavid", state: "ended" };
      if (d.event === "time") return { provider: "megavid", state: "playing" };
      if (
        d.event === "error" ||
        d.event === "unavailable" ||
        d.event === "no_source"
      )
        return { provider: "megavid", state: "error", message: d.message };
      return { provider: "megavid", state: "ignored" };
    }
    if (typeof d.type === "string" && d.type.indexOf("aniko:") === 0) {
      if (d.type === "aniko:ended")
        return { provider: "anixo", state: "ended" };
      if (d.type === "aniko:ready") {
        if (d.streams > 0) return { provider: "anixo", state: "playing" };
        return {
          provider: "anixo",
          state: "error",
          message: "No video sources available.",
        };
      }
      if (
        d.type === "aniko:play" ||
        d.type === "aniko:pause" ||
        d.type === "aniko:timeupdate"
      )
        return { provider: "anixo", state: "playing" };
      if (d.type.indexOf("aniko:error") === 0)
        return { provider: "anixo", state: "error", message: d.message };
      return { provider: "anixo", state: "ignored" };
    }
    return null;
  }

  function isTrustedMegaPlayOrigin(origin) {
    return origin === "https://megaplay.buzz";
  }

  async function gql(query, variables = {}) {
    const res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`AniList API error: ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function browseAnime(
    page = 1,
    perPage = 20,
    sort = "TRENDING_DESC",
    format = null,
  ) {
    const q = `query($page:Int,$perPage:Int,$sort:[MediaSort],$format:MediaFormat){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage}media(type:ANIME,sort:$sort,format:$format){${MEDIA_FIELDS_SMALL}}}}`;
    const variables = { page, perPage, sort: [sort] };
    if (format) variables.format = format;
    return (await gql(q, variables)).Page;
  }

  async function getTrending(page = 1, perPage = 20) {
    return browseAnime(page, perPage, "TRENDING_DESC");
  }

  async function getPopular(page = 1, perPage = 20) {
    return browseAnime(page, perPage, "POPULARITY_DESC");
  }

  async function getRecentlyUpdated(page = 1, perPage = 20) {
    const q = `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage}airingSchedules(sort:TIME_DESC,notYetAired:false){episode airingAt media{${MEDIA_FIELDS_SMALL}}}}}`;
    const data = await gql(q, { page, perPage });
    const seen = new Set();
    const unique = [];
    for (const s of data.Page.airingSchedules) {
      if (s.media && !seen.has(s.media.id)) {
        seen.add(s.media.id);
        unique.push({ ...s.media, latestEpisode: s.episode });
      }
    }
    return { media: unique, pageInfo: data.Page.pageInfo };
  }

  async function searchAnime(
    searchQuery,
    page = 1,
    perPage = 20,
    format = null,
    sort = "SEARCH_MATCH",
  ) {
    const q = `query($page:Int,$perPage:Int,$search:String,$format:MediaFormat,$sort:[MediaSort]){Page(page:$page,perPage:$perPage){pageInfo{total currentPage lastPage hasNextPage}media(type:ANIME,search:$search,format:$format,sort:$sort){${MEDIA_FIELDS_SMALL}}}}`;
    const variables = { page, perPage, search: searchQuery, sort: [sort] };
    if (format) variables.format = format;
    return (await gql(q, variables)).Page;
  }

  async function getAnimeById(id) {
    const q = `query($id:Int){Media(id:$id,type:ANIME){${MEDIA_FIELDS}} Page(perPage:1){airingSchedules(mediaId:$id,notYetAired:false,sort:TIME_DESC){episode}}}`;
    const data = await gql(q, { id: parseInt(id) });
    const media = data.Media;
    const latestAired =
      data.Page && data.Page.airingSchedules && data.Page.airingSchedules[0];
    if (latestAired) media.latestAired = latestAired.episode;
    return media;
  }

  async function getTopAiring(page = 1, perPage = 10) {
    const q = `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,status:RELEASING,sort:POPULARITY_DESC){id title{romaji english} coverImage{extraLarge large} bannerImage description genres format status episodes averageScore nextAiringEpisode{airingAt episode}}}}`;
    return (await gql(q, { page, perPage })).Page.media;
  }

  const KEYS = {
    watchlist: "anicult_watchlist",
    history: "anicult_history",
    progress: "anicult_progress",
  };

  const storageCache = new Map();

  function storageGet(key) {
    if (storageCache.has(key)) return storageCache.get(key);
    let value = null;
    try {
      const r = localStorage.getItem(key);
      value = r ? JSON.parse(r) : null;
    } catch {
      value = null;
    }
    storageCache.set(key, value);
    return value;
  }
  function storageSet(key, value) {
    const serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
    storageCache.set(key, value);
  }

  function parseKisskhMessage(e) {
    let d = e.data;
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch (err) {
        return null;
      }
    }
    if (!d || typeof d !== "object") return null;
    return d;
  }

  function getWatchlist() {
    return storageGet(KEYS.watchlist) || [];
  }
  function addToWatchlist(anime) {
    const list = getWatchlist();
    if (list.find((a) => a.id === anime.id)) return list;
    const entry = {
      id: anime.id,
      title: anime.title,
      coverImage: anime.coverImage,
      format: anime.format,
      episodes: anime.episodes,
      averageScore: anime.averageScore,
      addedAt: Date.now(),
    };
    const updated = [entry, ...list];
    storageSet(KEYS.watchlist, updated);
    return updated;
  }
  function removeFromWatchlist(id) {
    const list = getWatchlist().filter((a) => a.id !== id);
    storageSet(KEYS.watchlist, list);
    return list;
  }
  function isInWatchlist(id) {
    return getWatchlist().some((a) => a.id === id);
  }

  function getHistory() {
    return storageGet(KEYS.history) || [];
  }
  function addToHistory(entry) {
    if (!entry.episode || isNaN(entry.episode) || entry.episode <= 0)
      return getHistory();
    const history = getHistory();
    const filtered = history.filter(
      (h) => !(h.animeId === entry.animeId && h.episode === entry.episode),
    );
    const newEntry = {
      animeId: entry.animeId,
      title: entry.title,
      coverImage: entry.coverImage,
      episode: entry.episode,
      timestamp: Date.now(),
    };
    const updated = [newEntry, ...filtered].slice(0, 200);
    storageSet(KEYS.history, updated);
    return updated;
  }
  function clearHistory() {
    storageSet(KEYS.history, []);
  }

  function getProgress(animeId) {
    const p = storageGet(KEYS.progress) || {};
    return p[animeId] || 0;
  }
  function setProgress(animeId, episode) {
    if (!episode || isNaN(episode) || episode <= 0) return;
    const p = storageGet(KEYS.progress) || {};
    p[animeId] = Math.max(p[animeId] || 0, episode);
    storageSet(KEYS.progress, p);
  }

  const ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  function esc(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
  }

  function cssUrl(str) {
    return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  function stripHtml(html) {
    return html
      ? html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]*>/g, "")
      : "No description available.";
  }

  function title(anime) {
    return anime?.title?.english || anime?.title?.romaji || "";
  }
  function cover(anime) {
    return anime?.coverImage?.extraLarge || anime?.coverImage?.large || "";
  }

  function getAiredCount(anime) {
    if (!anime) return 0;
    const scheduleLatest = anime.latestAired || 0;
    const nextAired =
      anime.nextAiringEpisode && anime.nextAiringEpisode.episode
        ? anime.nextAiringEpisode.episode - 1
        : 0;
    if (anime.status === "FINISHED") {
      return anime.episodes || Math.max(scheduleLatest, nextAired) || 0;
    }
    if (anime.status === "NOT_YET_RELEASED") return 0;
    return Math.max(scheduleLatest, nextAired);
  }

  function getPlannedCount(anime) {
    if (!anime) return 0;
    if (anime.episodes) return anime.episodes;
    if (anime.nextAiringEpisode && anime.nextAiringEpisode.episode)
      return anime.nextAiringEpisode.episode;
    return getAiredCount(anime);
  }

  function isEpisodeReleased(anime, episode) {
    return episode >= 1 && episode <= getAiredCount(anime);
  }

  function upcomingEpLabel(anime, i) {
    const nextEp = anime.nextAiringEpisode && anime.nextAiringEpisode.episode;
    const nextEpDate =
      anime.nextAiringEpisode && anime.nextAiringEpisode.airingAt;
    if (nextEp === i && nextEpDate) {
      const diff = nextEpDate * 1000 - Date.now();
      if (diff > 0) {
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        if (days < 1)
          return { text: hours > 0 ? `${hours}h` : "<1h", today: true };
        return { text: `${days}d`, today: false };
      }
    }
    return { text: "TBA", today: false };
  }

  function epText(anime) {
    if (anime.nextAiringEpisode)
      return "Ep " + (anime.nextAiringEpisode.episode - 1);
    if (anime.status === "FINISHED")
      return anime.episodes ? anime.episodes + " eps" : null;
    if (anime.status === "RELEASING") return "Airing";
    if (anime.status === "HIATUS") return "On Hiatus";
    if (anime.status === "NOT_YET_RELEASED") return "Unreleased";
    return anime.episodes ? anime.episodes + " eps" : null;
  }

  const icons = {
    arrowLeft: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>`,
    arrowRight: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><polyline points="12 5 19 12 12 19"/></svg>`,
    alert: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    clock: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  };

  function cardHtml(anime) {
    const t = title(anime);
    const img = cover(anime);
    const score = anime.averageScore;
    const fmt = anime.format;
    const ep = epText(anime);
    return `<a href="#/anime/${anime.id}" class="card">
      <div class="card-image">
        <img src="${esc(img)}" alt="${esc(t)}" loading="lazy">
        ${score ? `<span class="card-score">${score}%</span>` : ""}
        ${fmt ? `<span class="card-format">${esc(fmt)}</span>` : ""}
        ${ep ? `<span class="card-ep">${esc(ep)}</span>` : ""}
      </div>
      <div class="card-body"><div class="card-title">${esc(t)}</div></div>
    </a>`;
  }

  function parseHash() {
    const hash = location.hash.slice(1) || "/";
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs || "");
    return { path, params };
  }

  async function route() {
    if (currentPage.destroy) {
      currentPage.destroy();
      currentPage = { destroy: null };
    }
    navToken++;
    const { path, params } = parseHash();

    app.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div>Loading...</div></div>`;

    try {
      if (path === "/" || path === "") await renderHome();
      else if (path === "/search") await renderSearch(params);
      else if (path.startsWith("/anime/"))
        await renderAnimeDetail(path.split("/")[2]);
      else if (path.startsWith("/watch/")) {
        const parts = path.split("/");
        await renderWatch(parts[2], parseInt(parts[3]) || 1);
      } else if (path === "/watchlist") renderWatchlist();
      else if (path === "/history") renderHistory();
      else if (path === "/about") renderAbout();
      else
        app.innerHTML = `<div class="empty"><div class="empty-title">404</div><div class="empty-text">Page not found</div><a href="#/" class="btn btn-primary">Go Home</a></div>`;
    } catch (err) {
      console.error(err);
      app.innerHTML = `<div class="empty"><div class="empty-title">Something went wrong</div><div class="empty-text">${esc(err.message)}</div><a href="#/" class="btn btn-primary">Go Home</a></div>`;
    }

    updateActiveNav();
    window.scrollTo(0, 0);
  }

  async function renderHome() {
    const [topAiring, trending, recent, popular] = await Promise.all([
      getTopAiring(),
      getTrending(1, 20),
      getRecentlyUpdated(1, 20),
      getPopular(1, 20),
    ]);

    let html = "";

    if (topAiring.length > 0) {
      html += `<div class="hero-slideshow" id="hero-slideshow">`;
      topAiring.forEach((anime, i) => {
        const t = title(anime);
        const bg = anime.bannerImage || cover(anime);
        const desc = stripHtml(anime.description || "");
        const nxt = anime.nextAiringEpisode;
        const aired = getAiredCount(anime);
        const airedText = aired > 0 ? aired : "?";
        let airMeta = "";
        if (nxt) {
          const diff = nxt.airingAt * 1000 - Date.now();
          airMeta =
            diff > 0
              ? `Next Ep ${nxt.episode} in ${formatCountdown(nxt.airingAt)}`
              : `Next Ep ${nxt.episode} soon`;
        }
        html += `<div class="hero-slide ${i === 0 ? "active" : ""}" data-index="${i}">
          <div class="hero-slide-bg"${i === 0 ? ` style="background-image:url('${esc(bg)}')"` : ""}></div>
          <div class="hero-slide-overlay"></div>
          <div class="hero-slide-content">
            <div class="hero-rank">#${i + 1}</div>
            <div class="hero-slide-main">
              <div class="hero-slide-cover"><img${i === 0 ? ` src="${esc(cover(anime))}"` : ""} alt="${esc(t)}"></div>
              <div class="hero-slide-info">
                <div class="hero-slide-badge">Now Airing</div>
                <div class="hero-slide-title">${esc(t)}</div>
                <div class="hero-slide-tags">
                  ${(anime.genres || [])
                    .slice(0, 3)
                    .map((g) => `<span>${esc(g)}</span>`)
                    .join("")}
                  ${anime.averageScore ? `<span class="tag-accent">${anime.averageScore}%</span>` : ""}
                </div>
                <div class="hero-slide-desc">${esc(desc)}</div>
                <div class="hero-slide-meta">${anime.format || "TV"} · ${airedText} eps aired${airMeta ? " · " + esc(airMeta) : ""}</div>
                <div class="hero-slide-actions">
                  <a href="#/anime/${anime.id}" class="btn btn-primary">View Details</a>
                  ${aired > 0 ? `<a href="#/watch/${anime.id}/1" class="btn btn-outline">Watch Now</a>` : ""}
                </div>
              </div>
            </div>
          </div>
        </div>`;
      });
      html += `<button class="hero-arrow prev" id="hero-prev" aria-label="Previous slide">${icons.arrowLeft(18)}</button>`;
      html += `<button class="hero-arrow next" id="hero-next" aria-label="Next slide">${icons.arrowRight(18)}</button>`;
      html += `<div class="hero-dots">${topAiring
        .map(
          (_, i) =>
            `<button class="hero-dot ${i === 0 ? "active" : ""}" data-dot="${i}" aria-label="Slide ${i + 1}"></button>`,
        )
        .join("")}</div>`;
      html += `</div>`;
    }

    html += `<section class="section"><div class="section-header"><h2 class="section-title">Trending Now</h2><a href="#/search?sort=TRENDING_DESC" class="section-link">View All</a></div><div class="scroll-row">${trending.media.map(cardHtml).join("")}</div></section>`;

    html += `<section class="section"><div class="section-header"><h2 class="section-title">Recently Updated</h2><a href="#/search?sort=UPDATED_AT_DESC" class="section-link">View All</a></div><div class="scroll-row">${recent.media.map(cardHtml).join("")}</div></section>`;

    html += `<section class="section"><div class="section-header"><h2 class="section-title">All Time Popular</h2><a href="#/search?sort=POPULARITY_DESC" class="section-link">View All</a></div><div id="popular-grid" class="grid">${popular.media.map(cardHtml).join("")}</div><div id="popular-loader" style="text-align:center;padding:2rem;color:var(--text-muted)"></div></section>`;

    app.innerHTML = html;

    let heroIndex = 0;
    let heroTimer = null;
    const heroCount = topAiring.length;
    const slides = document.querySelectorAll(".hero-slide");
    const dots = document.querySelectorAll(".hero-dot");
    const slideshowEl = document.getElementById("hero-slideshow");
    const heroBgs = topAiring.map((a) => a.bannerImage || cover(a));

    function ensureSlideMedia(slide, i) {
      const bg = slide.querySelector(".hero-slide-bg");
      if (bg && !bg.style.backgroundImage) {
        bg.style.backgroundImage = `url('${cssUrl(heroBgs[i])}')`;
      }
      const coverImg = slide.querySelector(".hero-slide-cover img");
      if (coverImg && !coverImg.getAttribute("src")) {
        coverImg.src = cover(topAiring[i]);
      }
    }

    function showSlide(n) {
      heroIndex = (n + heroCount) % heroCount;
      slides.forEach((s, i) => {
        s.classList.toggle("active", i === heroIndex);
        if (i === heroIndex) ensureSlideMedia(s, i);
      });
      dots.forEach((d, i) => d.classList.toggle("active", i === heroIndex));
    }

    function startHero() {
      clearInterval(heroTimer);
      if (document.hidden) return;
      heroTimer = setInterval(() => showSlide(heroIndex + 1), 3000);
    }

    if (slideshowEl && heroCount > 1) {
      const prevBtn = document.getElementById("hero-prev");
      const nextBtn = document.getElementById("hero-next");
      if (prevBtn)
        prevBtn.addEventListener("click", () => {
          showSlide(heroIndex - 1);
          startHero();
        });
      if (nextBtn)
        nextBtn.addEventListener("click", () => {
          showSlide(heroIndex + 1);
          startHero();
        });
      dots.forEach((d) =>
        d.addEventListener("click", () => {
          showSlide(parseInt(d.dataset.dot));
          startHero();
        }),
      );
      slideshowEl.addEventListener("mouseenter", () =>
        clearInterval(heroTimer),
      );
      slideshowEl.addEventListener("mouseleave", startHero);

      let touchStartX = null;
      slideshowEl.addEventListener("touchstart", (e) => {
        touchStartX = e.changedTouches[0].clientX;
        startHero();
      });
      slideshowEl.addEventListener("touchend", (e) => {
        if (touchStartX === null) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        touchStartX = null;
        if (Math.abs(dx) > 40) {
          showSlide(heroIndex + (dx < 0 ? 1 : -1));
          startHero();
        }
      });
      startHero();
    }

    let popPage = 2;
    let popHasNext = popular.pageInfo.hasNextPage;
    let popLoading = false;
    const loader = document.getElementById("popular-loader");
    const grid = document.getElementById("popular-grid");

    async function loadMorePopular() {
      if (popLoading || !popHasNext) return;
      popLoading = true;
      loader.textContent = "Loading more...";
      try {
        const data = await getPopular(popPage, 20);
        if (data) {
          grid.insertAdjacentHTML(
            "beforeend",
            data.media.map(cardHtml).join(""),
          );
          popHasNext = data.pageInfo.hasNextPage;
          popPage++;
        }
      } catch (e) {
        console.error(e);
      }
      popLoading = false;
      loader.textContent = "";
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMorePopular();
      },
      { rootMargin: "200px" },
    );

    if (loader) observer.observe(loader);

    const onVisibility = () => {
      if (document.hidden) clearInterval(heroTimer);
      else if (slideshowEl && heroCount > 1) startHero();
    };
    document.addEventListener("visibilitychange", onVisibility);

    currentPage.destroy = () => {
      if (heroTimer) clearInterval(heroTimer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  async function renderSearch(params) {
    const q = params.get("q") || "";
    const page = parseInt(params.get("page")) || 1;
    const format = params.get("format") || "";
    const sort = params.get("sort") || (q ? "SEARCH_MATCH" : "TRENDING_DESC");

    const nav = navToken;

    let result;
    if (q) result = await searchAnime(q, page, 24, format || null, sort);
    else result = await browseAnime(page, 24, sort, format || null);

    if (nav !== navToken) return;

    const sortOpts = [
      { v: "SEARCH_MATCH", l: "Relevance" },
      { v: "TRENDING_DESC", l: "Trending" },
      { v: "POPULARITY_DESC", l: "Popularity" },
      { v: "SCORE_DESC", l: "Score" },
      { v: "START_DATE_DESC", l: "Newest" },
      { v: "UPDATED_AT_DESC", l: "Recently Updated" },
    ];
    const fmtOpts = [
      { v: "", l: "All Formats" },
      { v: "TV", l: "TV" },
      { v: "MOVIE", l: "Movie" },
      { v: "OVA", l: "OVA" },
      { v: "ONA", l: "ONA" },
      { v: "SPECIAL", l: "Special" },
    ];

    function buildUrl(overrides) {
      const p = {
        q,
        page: String(page),
        format,
        sort,
        ...overrides,
      };
      const sp = new URLSearchParams();
      Object.entries(p).forEach(([k, v]) => {
        if (v) sp.set(k, v);
      });
      return "#/search?" + sp.toString();
    }

    let html = `<h1 class="section-title" style="margin-bottom:16px">${q ? `Results for "${esc(q)}"` : "Browse Anime"}</h1>`;
    html += `<div class="filters">`;
    sortOpts.forEach((o) => {
      html += `<a href="${buildUrl({ sort: o.v, page: "1" })}" class="btn btn-sm ${sort === o.v ? "btn-primary" : "btn-outline"}">${o.l}</a>`;
    });
    html += `<span style="color:var(--text-dim)">|</span>`;
    fmtOpts.forEach((o) => {
      html += `<a href="${buildUrl({ format: o.v, page: "1" })}" class="btn btn-sm ${format === o.v ? "btn-primary" : "btn-outline"}">${o.l}</a>`;
    });
    html += `<span style="color:var(--text-dim)">|</span>`;
    html += `</div>`;

    if (result.media.length === 0) {
      html += `<div class="empty"><div class="empty-title">No results found</div><div class="empty-text">Try a different search term or filter</div></div>`;
    } else {
      html += `<div class="grid grid-wide">${result.media
        .map(cardHtml)
        .join("")}</div>`;
    }

    if (result.pageInfo) {
      html += `<div class="pagination">`;
      if (page > 1)
        html += `<a href="${buildUrl({ page: String(page - 1) })}" class="page-btn">Previous</a>`;
      Array.from(
        { length: Math.min(result.pageInfo.lastPage || 1, 10) },
        (_, i) => i + 1,
      )
        .filter(
          (p) =>
            p === 1 ||
            p === (result.pageInfo.lastPage || 1) ||
            Math.abs(p - page) <= 2,
        )
        .forEach((p) => {
          html += `<a href="${buildUrl({ page: String(p) })}" class="page-btn ${p === page ? "page-btn-active" : ""}">${p}</a>`;
        });
      if (result.pageInfo.hasNextPage)
        html += `<a href="${buildUrl({ page: String(page + 1) })}" class="page-btn">Next</a>`;
      html += `</div>`;
    }

    if (nav !== navToken) return;
    app.innerHTML = html;
  }

  async function renderAnimeDetail(id) {
    const anime = await getAnimeById(id);
    const t = title(anime);
    const engT = anime.title.english;
    const nativeT = anime.title.native;
    const altT =
      engT && anime.title.romaji !== engT ? anime.title.romaji : nativeT || "";
    const img = cover(anime);
    const banner = anime.bannerImage || img;
    const nextEp = anime.nextAiringEpisode?.episode || null;
    const nextEpDate = anime.nextAiringEpisode?.airingAt || null;
    const airedEps = getAiredCount(anime);
    const plannedEps = getPlannedCount(anime);
    const totalKnown = Math.max(airedEps, plannedEps, nextEp || 0);
    const studio = anime.studios?.nodes?.[0]?.name || "Unknown";
    const desc = stripHtml(anime.description);
    const watched = getProgress(anime.id);
    const inList = isInWatchlist(anime.id);
    const status = anime.status || "";
    const isAiring = status === "RELEASING";

    const relations = (anime.relations?.edges || []).filter((e) =>
      ["SEQUEL", "PREQUEL", "SIDE_STORY", "PARENT"].includes(e.relationType),
    );

    let ctaHtml = "";
    if (airedEps > 0) {
      const resumeEp = watched + 1;
      if (watched > 0 && resumeEp <= airedEps) {
        ctaHtml = `<a href="#/watch/${anime.id}/${resumeEp}" class="btn btn-primary">Continue Ep ${resumeEp}</a>`;
      } else if (watched > 0) {
        ctaHtml = `<a href="#/watch/${anime.id}/1" class="btn btn-primary">Rewatch Ep 1</a>`;
      } else {
        ctaHtml = `<a href="#/watch/${anime.id}/1" class="btn btn-primary">Start Watching</a>`;
      }
    }

    let html = "";

    html += `<div class="detail-hero">
      <div class="detail-hero-bg" style="background-image:url('${esc(banner)}')"></div>
      <div class="detail-hero-overlay"></div>
      <div class="detail-hero-content">
        <div class="detail-hero-cover"><img src="${esc(img)}" alt="${esc(t)}"></div>
        <div class="detail-hero-info">
          <div class="detail-hero-title">${esc(t)}</div>
          ${altT ? `<div class="detail-hero-alt-title">${esc(altT)}</div>` : ""}
          <div class="detail-hero-tags">
            ${(anime.genres || [])
              .slice(0, 4)
              .map((g) => `<span>${esc(g)}</span>`)
              .join("")}
            ${anime.averageScore ? `<span class="tag-accent">${anime.averageScore}%</span>` : ""}
            ${statusBadge(status)}
          </div>
          <div class="detail-hero-desc">${esc(desc)}</div>
          <div class="detail-hero-actions">
            ${ctaHtml}
            <button class="btn ${inList ? "btn-danger" : "btn-outline"}" id="watchlist-btn">${inList ? "Remove from Watchlist" : "Add to Watchlist"}</button>
          </div>
        </div>
      </div>
    </div>`;

    html += `<div class="detail-body">`;

    html += `<div class="detail-stats">`;
    const stats = [
      {
        label: "Score",
        value: anime.averageScore ? anime.averageScore + "%" : "—",
        cls: "accent",
      },
      { label: "Format", value: anime.format || "—" },
      {
        label: "Status",
        value: status.replace(/_/g, " ") || "—",
        cls: isAiring ? "green" : status === "FINISHED" ? "blue" : "",
      },
      {
        label: "Episodes",
        value: isAiring
          ? (airedEps > 0 ? String(airedEps) : "—") +
            (anime.episodes ? " / " + anime.episodes : "")
          : anime.episodes
            ? String(anime.episodes)
            : airedEps > 0
              ? String(airedEps)
              : "—",
      },
      {
        label: "Duration",
        value: anime.duration ? anime.duration + " min" : "—",
      },
      {
        label: "Season",
        value: anime.season
          ? anime.season + " " + (anime.seasonYear || "")
          : "—",
      },
      { label: "Studio", value: esc(studio) },
    ];
    stats.forEach((s) => {
      html += `<div class="detail-stat"><div class="detail-stat-label">${s.label}</div><div class="detail-stat-value${s.cls ? " " + s.cls : ""}">${s.value}</div></div>`;
    });
    html += `</div>`;

    html += `<div class="detail-section">
      <div class="detail-synopsis expandable" id="synopsis">${esc(desc)}</div>
    </div>`;

    if (totalKnown > 0) {
      const progressPct = anime.episodes
        ? Math.round((watched / anime.episodes) * 100)
        : 0;
      html += `<div class="detail-section"><div class="detail-section-title">Episodes</div>`;
      html += `<div class="ep-progress">
        <span class="ep-progress-text">${watched} ${isAiring && airedEps > 0 ? "of " + airedEps + " released" : anime.episodes ? "of " + anime.episodes : ""} watched</span>
        <div class="ep-progress-bar"><div class="ep-progress-fill" style="width:${progressPct}%"></div></div>
      </div>`;

      if (nextEp && nextEpDate) {
        const diff = nextEpDate * 1000 - Date.now();
        if (diff > 0) {
          const days = Math.floor(diff / 86400000);
          const hours = Math.floor((diff % 86400000) / 3600000);
          const mins = Math.floor((diff % 3600000) / 60000);
          const countdown =
            days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m`;
          const dateStr = new Date(nextEpDate * 1000).toLocaleDateString(
            undefined,
            {
              weekday: "short",
              month: "short",
              day: "numeric",
            },
          );
          html += `<div class="next-ep-banner">
            <div class="next-ep-info">
              <div class="next-ep-label">${icons.clock(12)} Next Episode</div>
              <div class="next-ep-title">Episode ${nextEp} airs in <strong>${countdown}</strong></div>
            </div>
            <div class="next-ep-date">${dateStr}</div>
          </div>`;
        }
      }
      html += `<div class="episodes-grid">`;
      for (let i = 1; i <= totalKnown; i++) {
        const isReleased = i <= airedEps;
        const isWatched = i <= watched;

        let cls = "ep-btn";
        let attrs = "";
        let airLabel = "";
        let lbl = null;

        if (isReleased) {
          cls += isWatched ? " ep-btn-watched" : " ep-btn-aired";
          attrs = `href="#/watch/${anime.id}/${i}"`;
        } else {
          cls += " ep-btn-upcoming";
          lbl = upcomingEpLabel(anime, i);
          airLabel = lbl.text;
          if (lbl.today) cls += " ep-btn-today";
        }

        if (attrs) {
          html += `<a ${attrs} class="${cls}" id="ep-${i}">${i}${airLabel ? `<div class="ep-air-date${lbl && lbl.today ? " today-date" : " upcoming-date"}">${esc(airLabel)}</div>` : ""}</a>`;
        } else {
          html += `<span class="${cls}" id="ep-${i}">${i}${airLabel ? `<div class="ep-air-date upcoming-date">${esc(airLabel)}</div>` : ""}</span>`;
        }
      }
      html += `</div></div>`;
    }

    if (relations.length > 0) {
      html += `<div class="detail-section related-section"><div class="detail-section-title">Related</div><div class="scroll-row">${relations
        .map((rel) => {
          const r = rel.node,
            rT = title(r);
          return `<a href="#/anime/${r.id}" class="card">
          <div class="card-image"><img src="${esc(r.coverImage.large)}" alt="${esc(rT)}" loading="lazy">
            ${r.averageScore ? `<span class="card-score">${r.averageScore}%</span>` : ""}
            <span class="related-badge">${esc(rel.relationType.replace(/_/g, " "))}</span>
          </div>
          <div class="card-body"><div class="card-title">${esc(rT)}</div></div>
        </a>`;
        })
        .join("")}</div></div>`;
    }

    html += `</div>`;
    app.innerHTML = html;

    const synEl = document.getElementById("synopsis");
    if (synEl && synEl.scrollHeight > synEl.clientHeight) {
      synEl.addEventListener("click", () => synEl.classList.toggle("expanded"));
    }

    const btn = document.getElementById("watchlist-btn");
    let currentInList = inList;
    btn.addEventListener("click", () => {
      if (currentInList) {
        removeFromWatchlist(anime.id);
        btn.textContent = "Add to Watchlist";
        btn.className = "btn btn-outline";
        currentInList = false;
      } else {
        addToWatchlist(anime);
        btn.textContent = "Remove from Watchlist";
        btn.className = "btn btn-danger";
        currentInList = true;
      }
    });
  }

  function statusBadge(s) {
    const map = {
      FINISHED: { cls: "finished", label: "Finished" },
      RELEASING: { cls: "airing", label: "Airing" },
      NOT_YET_RELEASED: { cls: "upcoming", label: "Unreleased" },
      HIATUS: { cls: "dim", label: "Hiatus" },
      CANCELLED: { cls: "dim", label: "Cancelled" },
    };
    const m = map[s];
    if (!m) return "";
    return `<span class="status-badge ${m.cls}">${m.label}</span>`;
  }

  function formatCountdown(airingAt) {
    const diff = airingAt * 1000 - Date.now();
    if (diff <= 0) return "Airing now";
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  }

  async function renderWatch(id, episode) {
    const anime = await getAnimeById(id);
    const t = title(anime);
    const airedEps = getAiredCount(anime);
    const plannedEps = getPlannedCount(anime);
    const totalEps = Math.max(
      airedEps,
      plannedEps,
      anime.nextAiringEpisode ? anime.nextAiringEpisode.episode : 0,
    );
    const nextEp = anime.nextAiringEpisode?.episode || null;
    const nextEpDate = anime.nextAiringEpisode?.airingAt || null;
    const notYetReleased = anime.status === "NOT_YET_RELEASED";
    const canWatch = isEpisodeReleased(anime, episode);

    if (canWatch) {
      addToHistory({
        animeId: anime.id,
        title: t,
        coverImage: anime.coverImage,
        episode,
      });
      setProgress(anime.id, episode);
    }

    let sources = [],
      activeSource = 0,
      loading = true,
      error = null,
      embedUrl = "",
      currentLang = "sub",
      currentProvider = EMBED_PROVIDERS[0].id;

    function unavailableHtml() {
      if (notYetReleased) {
        return `<div class="player-unavailable">
          <div class="unavailable-icon">${icons.clock(36)}</div>
          <div class="unavailable-title">Not Available Yet</div>
          <div class="unavailable-text">"${esc(t)}" has not been released online yet. It will be added to AniCult as soon as it airs on streaming platforms.</div>
        </div>`;
      }
      if (!canWatch) {
        const latestText =
          airedEps > 0
            ? `The latest released episode is Episode ${airedEps}.`
            : "No episodes have been released yet.";
        let countdownHtml = "";
        if (nextEp && nextEpDate) {
          countdownHtml = `<div class="unavailable-countdown">${nextEp === episode ? "Airs in" : `Episode ${nextEp} airs in`} <span id="countdown-timer">${esc(formatCountdown(nextEpDate))}</span></div>`;
        }
        return `<div class="player-unavailable">
          <div class="unavailable-icon">${icons.clock(36)}</div>
          <div class="unavailable-title">Episode ${episode} hasn't aired yet</div>
          ${countdownHtml}
          <div class="unavailable-text">${latestText} ${nextEpDate ? "This episode becomes available here as soon as it airs on streaming platforms." : "The release schedule for upcoming episodes is currently unknown. Check back later."}</div>
          ${airedEps > 0 ? `<a href="#/watch/${anime.id}/${airedEps}" class="btn btn-primary">Watch Latest Episode</a>` : ""}
        </div>`;
      }
      return `<div class="player-unavailable">
        <div class="unavailable-icon">${icons.alert(36)}</div>
        <div class="unavailable-title">No Video Sources</div>
        <div class="unavailable-text">This title isn't currently available on streaming platforms. It will be added as soon as it becomes available.</div>
      </div>`;
    }

    let episodeGridHtml = "";
    if (totalEps > 0) {
      const watched = getProgress(anime.id);
      episodeGridHtml = `<div class="episodes-section"><h3 class="episodes-title" style="margin-bottom:12px">Episodes</h3><div class="episodes-grid">`;
      for (let i = 1; i <= totalEps; i++) {
        const isReleased = i <= airedEps;
        const isWatched = i <= watched;
        let cls = "ep-btn";
        if (i === episode) cls += " ep-btn-current";
        if (isReleased) {
          cls += isWatched ? " ep-btn-watched" : " ep-btn-aired";
          episodeGridHtml += `<a href="#/watch/${anime.id}/${i}" class="${cls}">${i}</a>`;
        } else {
          cls += " ep-btn-upcoming";
          const lbl = upcomingEpLabel(anime, i);
          if (lbl.today) cls += " ep-btn-today";
          episodeGridHtml += `<span class="${cls}" title="Not yet aired">${i}${lbl.text ? `<div class="ep-air-date upcoming-date">${esc(lbl.text)}</div>` : ""}</span>`;
        }
      }
      episodeGridHtml += `</div></div>`;
    }

    function playerAreaHtml() {
      let html = `<div class="player-wrapper">`;
      if (loading && canWatch) {
        html += `<div class="loading"><div class="loading-spinner"></div><div>Finding video sources...</div></div>`;
      } else if (!canWatch) {
        html += unavailableHtml();
      } else if (embedUrl) {
        const sandboxAttr =
          isAnixoUrl(embedUrl) || isMegaPlayUrl(embedUrl)
            ? ""
            : ' sandbox="allow-scripts allow-same-origin"';
        html += `<iframe src="${esc(embedUrl)}" loading="lazy" allow="autoplay; fullscreen"${sandboxAttr}></iframe>`;
      } else {
        html += unavailableHtml();
      }
      html += `</div>`;

      if (canWatch && nextEp && nextEpDate) {
        const diff = nextEpDate * 1000 - Date.now();
        if (diff > 0) {
          html += `<div class="watch-countdown">
            <div class="watch-countdown-label">${icons.clock(14)} Next Episode ${nextEp}</div>
            <div class="watch-countdown-timer">airs in <span id="next-ep-countdown">${esc(formatCountdown(nextEpDate))}</span></div>
          </div>`;
        }
      }

      if (canWatch) {
        html += `<div class="player-lang-toggle">
          <button class="lang-btn ${currentLang === "sub" ? "lang-btn-active" : ""}" data-lang="sub">Sub</button>
          <button class="lang-btn ${currentLang === "dub" ? "lang-btn-active" : ""}" data-lang="dub">Dub</button>
        </div>`;
      }

      if (canWatch && EMBED_PROVIDERS.length > 1) {
        html += `<div class="player-provider-toggle">`;
        EMBED_PROVIDERS.forEach((p) => {
          html += `<button class="provider-btn ${currentProvider === p.id ? "provider-btn-active" : ""}" data-provider="${p.id}">${esc(p.name)}</button>`;
        });
        html += `</div>`;
      }

      if (sources.length > 2) {
        html += `<div class="player-source-list">`;
        sources.forEach((s, i) => {
          html += `<button class="player-source-btn ${i === activeSource ? "player-source-btn-active" : ""}" data-source-index="${i}">${esc(s.name)}</button>`;
        });
        html += `</div>`;
      }

      if (error) {
        html += `<div class="embed-error">${esc(error)} <button class="btn btn-outline btn-sm" id="retry-btn">Retry</button></div>`;
        if (currentProvider === "megaplay") {
          const malId = anime.idMal || null;
          const idType = malId ? "MAL" : "AniList";
          const extId = malId || anime.id;
          html += `<div class="mapping-request"><div class="mapping-request-title">Missing mapping? Request it</div><div class="mapping-request-text">MegaPlay hosts the full HiAnime library but ${esc(idType)} mapping for "${esc(t)}" may be missing. Submit a request to add it.</div><div class="mapping-request-form"><input type="text" id="mapping-message" placeholder="What's wrong? Include title, language, etc." value="Please add mapping for ${esc(t)} — ${esc(idType)} ${esc(String(extId))} episode ${episode} (${esc(currentLang)})" style="flex:1;min-width:180px"><button class="btn btn-primary btn-sm" id="request-mapping-btn">Send Request</button><span id="mapping-status" class="mapping-status"></span></div></div>`;
        }
      }

      if (currentProvider === "megaplay" && canWatch && !error) {
        html += `<div class="mapping-note">Note: MegaPlay MAL/AniList coverage isn't 100% — if this title doesn't load, use the mapping request on error or switch provider. Catalog ID (s-2) is most reliable.</div>`;
      }

      if (!loading && !embedUrl && canWatch) {
        html += `<div class="player-url-input"><input type="text" id="custom-embed-url" placeholder="Or paste an embed URL..." /><button class="btn btn-primary btn-sm" id="load-custom-url">Load</button></div>`;
      }

      return html;
    }

    function renderPlayer() {
      const region = document.getElementById("player-dynamic");
      region.innerHTML = playerAreaHtml();

      region.querySelectorAll("[data-source-index]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = parseInt(btn.dataset.sourceIndex);
          if (idx !== activeSource) {
            activeSource = idx;
            embedUrl = sources[idx].url;
            renderPlayer();
          }
        });
      });

      region.querySelectorAll("[data-lang]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const lang = btn.dataset.lang;
          if (lang !== currentLang) {
            currentLang = lang;
            discoverSources();
          }
        });
      });

      region.querySelectorAll("[data-provider]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pid = btn.dataset.provider;
          if (pid !== currentProvider) {
            currentProvider = pid;
            discoverSources();
          }
        });
      });

      const loadBtn = region.querySelector("#load-custom-url");
      if (loadBtn) {
        loadBtn.addEventListener("click", () => {
          const input = region.querySelector("#custom-embed-url");
          if (input && input.value.trim()) {
            embedUrl = input.value.trim();
            sources.push({ id: "custom", name: "Custom", url: embedUrl });
            activeSource = sources.length - 1;
            renderPlayer();
          }
        });
      }

      const retryBtn = region.querySelector("#retry-btn");
      if (retryBtn) retryBtn.addEventListener("click", discoverSources);

      const mappingBtn = region.querySelector("#request-mapping-btn");
      if (mappingBtn) {
        mappingBtn.addEventListener("click", async () => {
          const msgInput = region.querySelector("#mapping-message");
          const statusEl = region.querySelector("#mapping-status");
          const message = msgInput ? msgInput.value.trim() : "";
          if (!message) {
            if (statusEl) statusEl.textContent = "Please enter a message.";
            return;
          }
          const malId = anime.idMal || null;
          const idType = malId ? "MAL" : "AniList";
          const externalId = malId || anime.id;
          mappingBtn.disabled = true;
          if (statusEl) statusEl.textContent = "Sending...";
          try {
            await requestMegaPlayMapping({
              idType,
              externalId,
              episode: String(episode),
              message,
            });
            if (statusEl) statusEl.textContent = "Thanks — we received your request.";
            mappingBtn.textContent = "Sent";
          } catch (err) {
            if (statusEl) statusEl.textContent = err.message || "Something went wrong. Please try again.";
            mappingBtn.disabled = false;
          }
        });
      }
    }

    function onPlayerMessage(e) {
      const d = parseKisskhMessage(e);
      if (!d) return;
      const iframe = app.querySelector("iframe");
      if (!iframe || e.source !== iframe.contentWindow) return;
      if (d.channel === "megacloud" && e.origin && !isTrustedMegaPlayOrigin(e.origin)) {
        return;
      }
      if (d.type === "watching-log") {
        if (currentProvider === "megavid" || currentProvider === "megaplay") {
          return;
        }
      }
      const cls = classifyPlayerMessage(d);
      if (!cls || cls.provider !== currentProvider) return;
      if (cls.state === "ended") {
        if (episode < airedEps) {
          location.hash = `#/watch/${anime.id}/${episode + 1}`;
        }
      } else if (cls.state === "error" && !error) {
        error =
          cls.message || "The video failed to load. Please try another source.";
        renderPlayer();
      }
    }

    function discoverSources() {
      if (!canWatch) {
        loading = false;
        renderPlayer();
        return;
      }
      loading = true;
      error = null;
      embedUrl = "";
      sources = [];
      activeSource = 0;

      const malId = anime.idMal || null;
      const provider =
        EMBED_PROVIDERS.find((p) => p.id === currentProvider) ||
        EMBED_PROVIDERS[0];
      const subUrl = provider.makeUrl(episode, id, "sub", malId);
      sources = [{ id: "sub", name: "Sub", url: subUrl }];
      const dubUrl = provider.makeUrl(episode, id, "dub", malId);
      sources.push({ id: "dub", name: "Dub", url: dubUrl });
      const langIdx = sources.findIndex((s) => s.id === currentLang);
      activeSource = langIdx >= 0 ? langIdx : 0;
      embedUrl = sources[activeSource].url;
      loading = false;
      renderPlayer();
    }

    let html = `<div class="player-container">`;
    html += `<div class="player-info"><div>
      <a href="#/anime/${anime.id}" class="player-title">${esc(t)}</a>
      <div class="player-episode">Episode ${episode}</div>
    </div><div class="player-nav">`;
    if (episode > 1)
      html += `<a href="#/watch/${anime.id}/${episode - 1}" class="btn btn-outline btn-sm">${icons.arrowLeft()} Prev</a>`;
    if (episode < airedEps)
      html += `<a href="#/watch/${anime.id}/${episode + 1}" class="btn btn-primary btn-sm">Next ${icons.arrowRight()}</a>`;
    html += `</div></div>`;
    html += `<div id="player-dynamic"></div>`;
    html += episodeGridHtml;
    html += `</div>`;
    app.innerHTML = html;

    renderPlayer();

    const showCountdown = nextEp && nextEpDate;
    const timer = showCountdown
      ? setInterval(() => {
          let alive = false;
          const a = document.getElementById("countdown-timer");
          if (a) {
            a.textContent = formatCountdown(nextEpDate);
            alive = true;
          }
          const b = document.getElementById("next-ep-countdown");
          if (b) {
            b.textContent = formatCountdown(nextEpDate);
            alive = true;
          }
          if (!alive) clearInterval(timer);
        }, 1000)
      : null;
    window.addEventListener("message", onPlayerMessage);
    currentPage.destroy = () => {
      if (timer) clearInterval(timer);
      window.removeEventListener("message", onPlayerMessage);
    };
    discoverSources();
  }

  function renderWatchlist() {
    const list = getWatchlist();
    let html = `<h1 class="section-title" style="margin-bottom:24px">My Watchlist</h1>`;

    if (list.length === 0) {
      html += `<div class="empty"><div class="empty-title">Your watchlist is empty</div><div class="empty-text">Find anime you like and add them to your list.</div><a href="#/" class="btn btn-primary">Browse Anime</a></div>`;
    } else {
      html += `<div class="grid grid-wide">${list
        .map((a) => {
          const t = title(a),
            img = cover(a),
            s = a.averageScore,
            fmt = a.format;
          const eps = a.episodes || 0,
            watched = getProgress(a.id);
          return `<div class="card" style="position:relative">
          <a href="#/anime/${a.id}">
            <div class="card-image">
              <img src="${esc(img)}" alt="${esc(t)}">
              ${s ? `<span class="card-score">${s}%</span>` : ""}
              ${fmt ? `<span class="card-format">${esc(fmt)}</span>` : ""}
            </div>
            <div class="card-body">
              <div class="card-title" style="margin-bottom:4px">${esc(t)}</div>
              <div class="watchlist-progress">Progress: ${watched} / ${eps || "?"}</div>
            </div>
          </a>
          <button class="wl-remove-btn" data-id="${a.id}">Remove</button>
        </div>`;
        })
        .join("")}</div>`;
    }

    app.innerHTML = html;
    document.querySelectorAll(".wl-remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeFromWatchlist(parseInt(btn.dataset.id));
        renderWatchlist();
      });
    });
  }

  function renderHistory() {
    const historyList = getHistory();
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px"><h1 class="section-title">Watch History</h1>`;
    if (historyList.length > 0)
      html += `<button class="btn btn-outline btn-sm" id="clear-history-btn">Clear History</button>`;
    html += `</div>`;

    if (historyList.length === 0) {
      html += `<div class="empty"><div class="empty-title">No watch history</div><div class="empty-text">Anime you watch will show up here.</div><a href="#/" class="btn btn-primary">Browse Anime</a></div>`;
    } else {
      const latest = historyList[0];
      if (latest) {
        html += `<div class="continue-card" id="continue-watching-card">
          <div class="history-thumb"><img src="${esc(latest.coverImage?.extraLarge || latest.coverImage?.large || "")}" alt="${esc(latest.title)}"></div>
          <div class="history-info">
            <div class="continue-label">Continue Watching</div>
            <h2 class="history-title" style="font-size:16px;font-weight:600">${esc(latest.title)}</h2>
            <div class="history-ep">Episode ${latest.episode}</div>
          </div>
          <div><a href="#/watch/${latest.animeId}/${latest.episode}" class="btn btn-primary btn-sm">Resume Ep ${latest.episode}</a></div>
        </div>`;
      }

      html += `<div>${historyList
        .map((item, i) => {
          const ft = new Date(item.timestamp).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          return `<div class="history-item" id="history-item-${i}">
          <div class="history-thumb"><img src="${esc(item.coverImage?.extraLarge || item.coverImage?.large || "")}" alt="${esc(item.title)}"></div>
          <div class="history-info">
            <a href="#/anime/${item.animeId}" class="history-title" style="font-weight:600;display:block">${esc(item.title)}</a>
            <div class="history-ep">Episode ${item.episode}</div>
            <div class="history-time">${ft}</div>
          </div>
          <div class="history-actions"><a href="#/watch/${item.animeId}/${item.episode}" class="btn btn-outline btn-sm">Watch Again</a></div>
        </div>`;
        })
        .join("")}</div>`;
    }

    app.innerHTML = html;
    const clearBtn = document.getElementById("clear-history-btn");
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        clearHistory();
        renderHistory();
      });
  }

  function renderAbout() {
    const discordIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
    const githubIcon = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`;

    let html = `<div class="about">`;
    html += `<h1 class="section-title" style="margin-bottom:8px">About AniCult</h1>`;
    html += `<p class="about-text">AniCult is a free, ad-free anime streaming experience that runs entirely in your browser. Browse anime powered by AniList, stream instantly through the built-in player, and track your watchlist, history, and episode progress with no account or sign-up required.</p>`;

    html += `<h2 class="about-subtitle">What's Inside</h2>`;
    html += `<ul class="about-list">`;
    html += `<li>Trending, popular, and recently updated anime refreshed directly from AniList</li>`;
    html += `<li>Search with format filters (TV, Movie, OVA, ONA, Special) and 6 sort options</li>`;
    html += `<li>Sub/Dub player with autoplay, auto-next, and error retry support — choose Megavid, AniXo, or MegaPlay (Anikoto + MAL/AniList at megaplay.buzz)</li>`;
    html += `<li>Watchlist, watch history, and episode progress saved locally in your browser</li>`;
    html += `<li>Fully responsive design built for both desktop and mobile devices</li>`;
    html += `</ul>`;

    html += `<div class="about-connect">`;
    html += `<div class="about-card-col">`;
    html += `<div class="about-dev-header"><span class="about-dev-badge">Founded by</span></div>`;
    html += `<div class="about-discord">`;
    html += `<img class="about-discord-banner" src="https://cdn.discordapp.com/banners/1455877276007796738/a_5d74cf1372c78893f1ac6c1f3170a7ba.gif?size=1024" alt="Dacca Cult banner" loading="lazy">`;
    html += `<div class="about-discord-body">`;
    html += `<img class="about-discord-icon" src="https://cdn.discordapp.com/icons/1455877276007796738/b863a4836ae39be4a9afbecd969504c5.png?size=256" alt="Dacca Cult icon" loading="lazy">`;
    html += `<div class="about-discord-name">Dacca Cult</div>`;
    html += `<div class="about-discord-meta"><span>237 members</span><span class="about-sep">&middot;</span><span class="about-online"><i class="presence-dot"></i>27 online</span></div>`;
    html += `<p class="about-discord-desc">We value freedom of speech, ensuring a welcoming space for community bonding with dedicated rooms for various discussions.</p>`;
    html += `<a href="https://discord.gg/rsC4V32GZa" target="_blank" rel="noopener noreferrer" class="btn btn-primary">${discordIcon}Join Server</a>`;
    html += `</div></div></div>`;
    html += `<div class="about-card-col">`;
    html += `<div class="about-dev-header"><span class="about-dev-badge">Main Developer of AniCult</span></div>`;
    html += `<a class="about-row" href="https://github.com/aluukill/AniCult" target="_blank" rel="noopener noreferrer">${githubIcon}<span class="about-card-text"><span class="about-link-title">Source on GitHub</span><span class="about-link-text">Star the project, report issues, or contribute</span></span></a>`;
    html += `<a class="about-row" href="https://linktr.ee/aluukill" target="_blank" rel="noopener noreferrer"><img class="about-social-logo" src="https://assets.streamlinehq.com/image/private/w_300,h_300,ar_1/f_auto/v1/icons/logos/linktree-hrggdeqdzll06zjl9h6j.png/linktree-bafynmeua3noot52xbu71.png?_a=DATAiZAAZAA0" alt="Linktree" loading="lazy"><span class="about-card-text"><span class="about-link-title">Linktree</span><span class="about-link-text">@aluukill</span></span></a>`;
    html += `<a class="about-row" href="https://syedtanvir.vercel.app" target="_blank" rel="noopener noreferrer"><img class="about-portfolio-logo" src="https://syedtanvir.vercel.app/assets/icon.png" alt="Portfolio" loading="lazy"><span class="about-card-text"><span class="about-link-title">Portfolio</span><span class="about-link-text">syedtanvir.vercel.app</span></span></a>`;
    html += `</div>`;
    html += `</div>`;

    html += `<div class="about-more">`;
    html += `<div class="about-dev-header"><span class="about-dev-badge">More of Us</span></div>`;
    html += `<a class="about-platform" href="https://movicult.vercel.app" target="_blank" rel="noopener noreferrer">`;
    html += `<img class="about-platform-logo" src="https://movicult.vercel.app/logo.png" alt="MoviCult logo" loading="lazy">`;
    html += `<div class="about-platform-body">`;
    html += `<div class="about-link-title">MoviCult</div>`;
    html += `<div class="about-platform-desc">Free movies and TV shows without ads. Stream the latest movies and hit TV series in full HD — no sign-up required, no interruptions, just press play and enjoy.</div>`;
    html += `<span class="btn btn-primary about-platform-cta">Visit MoviCult</span>`;
    html += `</div>`;
    html += `</a>`;
    html += `</div>`;

    app.innerHTML = html;
  }

  const NOTICE_FILE = "notice.json";
  const NOTICE_SEEN_KEY = "anicult_notice_seen";

  async function showUpdateNotice() {
    let notice;
    try {
      const res = await fetch(NOTICE_FILE, { cache: "no-cache" });
      if (!res.ok) return;
      notice = await res.json();
    } catch {
      return;
    }
    if (
      !notice ||
      typeof notice.version !== "string" ||
      !Array.isArray(notice.items) ||
      notice.items.length === 0
    ) {
      return;
    }
    if (storageGet(NOTICE_SEEN_KEY) === notice.version) return;

    const overlay = document.createElement("div");
    overlay.className = "notice-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "notice-title");
    overlay.innerHTML = `<div class="notice-card">
      <div class="notice-title" id="notice-title">${esc(
        notice.title || "What's new in AniCult",
      )}</div>
      <ul class="notice-list">${notice.items
        .map((item) => `<li>${esc(item)}</li>`)
        .join("")}</ul>
      <div class="notice-actions">
        <button class="btn btn-primary notice-close" id="notice-close" disabled>${esc(
          notice.buttonLabel || "Got it",
        )}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector(".notice-close");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const revealAt = Date.now() + 4000;
    let countdown = null;
    function tick() {
      const left = Math.ceil((revealAt - Date.now()) / 1000);
      if (left > 0) {
        closeBtn.textContent = `${notice.buttonLabel || "Got it"} (${left}s)`;
      } else {
        closeBtn.textContent = notice.buttonLabel || "Got it";
        closeBtn.disabled = false;
        closeBtn.focus();
        clearInterval(countdown);
      }
    }
    countdown = setInterval(tick, 1000);
    tick();

    function closeNotice() {
      if (closeBtn.disabled) return;
      clearInterval(countdown);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      storageSet(NOTICE_SEEN_KEY, notice.version);
    }
    const onKey = (e) => {
      if (e.key === "Escape" && !closeBtn.disabled) closeNotice();
    };
    closeBtn.addEventListener("click", closeNotice);
    document.addEventListener("keydown", onKey);
  }

  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) {
      closeSuggestions();
      closeSearch();
      location.hash = "/search?q=" + encodeURIComponent(q);
      searchInput.value = "";
    }
  });

  const suggestionsEl = document.getElementById("search-suggestions");
  let activeSuggestion = -1;
  let suggestionItems = [];
  let debounceTimer = null;

  function closeSuggestions() {
    suggestionsEl.classList.remove("open");
    suggestionsEl.innerHTML = "";
    activeSuggestion = -1;
    suggestionItems = [];
  }

  async function fetchSuggestions(query) {
    if (!query || query.length < 2) {
      closeSuggestions();
      return;
    }
    const q = `query($search:String){Page(page:1,perPage:6){media(type:ANIME,search:$search,sort:SEARCH_MATCH){id title{romaji english}coverImage{large}format averageScore}}}`;
    try {
      const data = await gql(q, { search: query });
      const media = data.Page.media;
      if (!media.length) {
        suggestionsEl.innerHTML = '<div class="search-suggestions-empty">No suggestions</div>';
        suggestionsEl.classList.add("open");
        suggestionItems = [];
        return;
      }
      suggestionsEl.innerHTML = media
        .map(
          (a, i) => {
            const t = title(a);
            const fmt = a.format || "";
            const score = a.averageScore ? a.averageScore + "%" : "";
            const meta = [fmt, score].filter(Boolean).join(" \u00b7 ");
            return `<a href="#/anime/${a.id}" class="search-suggestion" data-index="${i}">
              <img src="${esc(a.coverImage?.large || "")}" alt="${esc(t)}">
              <div class="search-suggestion-info">
                <div class="search-suggestion-title">${esc(t)}</div>
                ${meta ? `<div class="search-suggestion-meta">${esc(meta)}</div>` : ""}
              </div>
            </a>`;
          },
        )
        .join("");
      suggestionsEl.classList.add("open");
      suggestionItems = suggestionsEl.querySelectorAll(".search-suggestion");
      activeSuggestion = -1;
    } catch {
      closeSuggestions();
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (!q) {
      closeSuggestions();
      return;
    }
    debounceTimer = setTimeout(() => fetchSuggestions(q), 300);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (!suggestionsEl.classList.contains("open")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeSuggestion = Math.min(activeSuggestion + 1, suggestionItems.length - 1);
      updateActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, -1);
      updateActive();
    } else if (e.key === "Enter" && activeSuggestion >= 0) {
      e.preventDefault();
      const link = suggestionItems[activeSuggestion];
      if (link) {
        closeSuggestions();
        closeSearch();
        searchInput.value = "";
        location.hash = link.getAttribute("href");
      }
    } else if (e.key === "Escape") {
      closeSuggestions();
      closeSearch();
    }
  });

  function updateActive() {
    suggestionItems.forEach((el, i) => {
      el.classList.toggle("active", i === activeSuggestion);
    });
    if (activeSuggestion >= 0 && suggestionItems[activeSuggestion]) {
      suggestionItems[activeSuggestion].scrollIntoView({ block: "nearest" });
    }
  }

  suggestionsEl.addEventListener("click", (e) => {
    const link = e.target.closest(".search-suggestion");
    if (link) {
      closeSuggestions();
      closeSearch();
      searchInput.value = "";
    }
  });

  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("nav-links");
  const navSearchToggle = document.getElementById("nav-search-toggle");
  const navSearchWrap = document.getElementById("nav-search-wrap");

  function closeMenu() {
    navLinks.classList.remove("open");
    navToggle.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
  }

  function closeSearch() {
    if (navSearchWrap) navSearchWrap.classList.remove("open");
    if (navSearchToggle) {
      navSearchToggle.classList.remove("open");
      navSearchToggle.setAttribute("aria-expanded", "false");
    }
    closeSuggestions();
  }

  function openSearch() {
    closeMenu();
    if (navSearchWrap) navSearchWrap.classList.add("open");
    if (navSearchToggle) {
      navSearchToggle.classList.add("open");
      navSearchToggle.setAttribute("aria-expanded", "true");
    }
    if (searchInput) {
      setTimeout(() => searchInput.focus(), 50);
    }
  }

  if (navSearchToggle) {
    navSearchToggle.addEventListener("click", () => {
      const isOpen = navSearchWrap && navSearchWrap.classList.contains("open");
      if (isOpen) {
        closeSearch();
      } else {
        openSearch();
      }
    });
  }

  navToggle.addEventListener("click", () => {
    closeSearch();
    const open = navLinks.classList.toggle("open");
    navToggle.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", String(open));
  });

  navLinks.addEventListener("click", (e) => {
    if (e.target.closest("a")) closeMenu();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".nav-search-wrap") && !e.target.closest("#nav-search-toggle")) {
      if (navSearchWrap && navSearchWrap.classList.contains("open")) {
        closeSearch();
      } else {
        closeSuggestions();
      }
    }
    if (!e.target.closest(".nav") && navLinks.classList.contains("open")) {
      closeMenu();
    }
  });

  function updateActiveNav() {
    const currentHash = location.hash || "#/";
    if (!navLinks) return;
    navLinks.querySelectorAll("a").forEach((link) => {
      const href = link.getAttribute("href");
      if (href === currentHash) {
        link.classList.add("active");
      } else if (href !== "#/" && currentHash.startsWith(href)) {
        link.classList.add("active");
      } else if (
        href === "#/" &&
        (currentHash === "#/" || currentHash === "#" || currentHash === "")
      ) {
        link.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });
  }

  window.addEventListener("hashchange", () => {
    if (navLinks.classList.contains("open")) closeMenu();
    if (navSearchWrap && navSearchWrap.classList.contains("open")) closeSearch();
    route();
  });
  route();
  showUpdateNotice();
})();
