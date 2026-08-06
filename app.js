(function () {
  "use strict";

  // ============================================================================
  // AniCult — free, ad-free anime streaming SPA. Vanilla JS, no build step.
  //
  //  Data source  : AniList GraphQL API (https://graphql.anilist.co)
  //  Streaming    : embedded third-party players via megavid.buzz iframes
  //  Persistence  : localStorage (watchlist, history, progress, dub cache)
  //  Routing      : hash-based (#/anime/:id, #/watch/:id/:ep, #/search?...)
  //
  //  Section index:
  //   1. API config & GraphQL query templates
  //   2. GraphQL client (gql)
  //   3. Data fetching layer
  //   4. localStorage persistence helpers
  //   5. Dub availability detection
  //   6. User library (watchlist / history / progress)
  //   7. Rendering utilities
  //   8. Episode availability logic
  //   9. Icons & shared components
  //  10. Router
  //  11. Page renderers
  //  12. Navigation & bootstrap
  // ============================================================================

  // ----------------------------------------------------------------------------
  // 1. API CONFIG & GRAPHQL QUERY TEMPLATES
  // ----------------------------------------------------------------------------
  const ANILIST_URL = "https://graphql.anilist.co";

  // Lightweight card data — used on home feeds, search results and lists.
  const MEDIA_FIELDS_SMALL = `
    id
    idMal
    title { romaji english }
    coverImage { extraLarge large color }
    format status episodes averageScore season seasonYear
    nextAiringEpisode { airingAt episode }
  `;

  // Full detail payload — used on the anime detail and watch pages
  // (includes relations for the "Related" section).
  const MEDIA_FIELDS = `
    id
    idMal
    title { romaji english native }
    coverImage { extraLarge large color }
    bannerImage description genres format status episodes duration
    season seasonYear averageScore popularity trending
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

  // ----------------------------------------------------------------------------
  // GLOBAL DOM REFERENCES & ROUTING STATE
  // ----------------------------------------------------------------------------
  const app = document.getElementById("app");
  const searchInput = document.getElementById("nav-search-input");
  const searchForm = document.getElementById("nav-search-form");

  // Holds the active page's cleanup callback (timers, observers, listeners).
  // The router calls it before rendering the next page.
  let currentPage = { destroy: null };

  // ----------------------------------------------------------------------------
  // STREAMING EMBED PROVIDERS
  //
  // Every embed URL is built from a provider template. Providers were researched
  // and verified before integration (August 2026): the gogoanime/animepahe/
  // hianime/kisskh APIs are dead, parked or bot-protected, while megavid.buzz
  // is a live, documented "Anime Player Embed API" (its own homepage documents
  // the /mal, /ani, /aniwave routes, sub/dub suffixes and the postMessage
  // protocol). We therefore ship TWO verified content backends on that host:
  //
  //   megavid  — the megavid catalog:  /mal/{malId} | /ani/{anilistId} / {ep} / {sub|dub}
  //   aniwave  — the AniWave backend: /aniwave/{mal|al}/{id}/{ep}/{sub|dub}
  //
  // Both were HTTP-verified to return a live player page for every route, and
  // both speak the same postMessage protocol (channel "kisskh", events
  // time/complete/error, plus watching-log with currentTime/duration).
  //
  // Only providers whose probe succeeds at runtime are offered in the UI, so a
  // dead backend degrades to the remaining one instead of a black player.
  // ----------------------------------------------------------------------------
  const EMBED_PROVIDERS = [
    {
      id: "megavid",
      name: "Megavid",
      desc: "Primary catalog",
      buildUrl(anime, episode, lang, malId) {
        const route = malId ? `mal/${malId}` : `ani/${anime.id}`;
        return `https://megavid.buzz/${route}/${episode}/${lang}?color=%23e63946&autoplay=true`;
      },
    },
    {
      id: "aniwave",
      name: "AniWave",
      desc: "Secondary source",
      buildUrl(anime, episode, lang, malId) {
        const route = malId ? `mal/${malId}` : `al/${anime.id}`;
        return `https://megavid.buzz/aniwave/${route}/${episode}/${lang}?color=%23e63946&autoplay=true`;
      },
    },
  ];

  function providerById(id) {
    return EMBED_PROVIDERS.find((p) => p.id === id) || EMBED_PROVIDERS[0];
  }

  function buildEmbedUrl(providerId, anime, episode, lang) {
    return providerById(providerId).buildUrl(anime, episode, lang, anime.idMal || null);
  }

  // ----------------------------------------------------------------------------
  // 2. GRAPHQL CLIENT
  // Thin wrapper around fetch. Throws on HTTP/GraphQL errors so callers can
  // rely on the try/catch in the router.
  // ----------------------------------------------------------------------------
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

  // ----------------------------------------------------------------------------
  // 3. DATA FETCHING LAYER
  // One function per feed/query. All return plain AniList media objects (plus
  // a few app-injected fields, e.g. `latestAired`).
  // ----------------------------------------------------------------------------
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

  // Recently-updated feed: pulls the newest *aired* episodes via the
  // airingSchedules query, then dedupes by anime so each title appears once.
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

  // Detail/watch data. Also fetches the most recently aired episode from the
  // airing schedule and attaches it as `media.latestAired` — the source of
  // truth for the episode availability logic (section 8).
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

  // ----------------------------------------------------------------------------
  // 4. LOCAL STORAGE PERSISTENCE
  // All user data (watchlist, history, progress, dub cache) lives in
  // localStorage — no accounts or backend required.
  // ----------------------------------------------------------------------------
  const KEYS = {
    watchlist: "anicult_watchlist",
    history: "anicult_history",
    progress: "anicult_progress",
    // v3: bumped to invalidate dub results cached by the old probe, which
    // (a) decided the whole series' dub status from episode 1, (b) cached
    // probe timeouts as definitive "no dub", and (c) used a `max_dub`
    // heuristic that poisoned every later episode as sub-only. The new cache
    // is per-episode/per-provider and only stores verified results.
    dubCache: "anicult_dub_cache_v3",
    prefs: "anicult_prefs_v1",
    epProgress: "anicult_ep_progress_v1",
  };

  // User player preferences — saved whenever the user changes anything, and
  // restored on the next visit so audio, provider, speed, quality and the
  // playback toggles all "stick".
  const DEFAULT_PREFS = {
    lang: "sub",
    provider: "megavid",
    speed: 1,
    quality: "auto",
    autoNext: true,
    skipIntro: true,
    skipOutro: false,
  };

  function getPrefs() {
    return { ...DEFAULT_PREFS, ...(storageGet(KEYS.prefs) || {}) };
  }

  function setPrefs(patch) {
    const next = { ...getPrefs(), ...patch };
    storageSet(KEYS.prefs, next);
    return next;
  }

  // Per-episode playback position ("resume from here"). Keyed by anime+episode;
  // written on a throttle while playing, read back when the episode is reopened.
  function getEpProgress(animeId, episode) {
    const all = storageGet(KEYS.epProgress) || {};
    const e = all[animeId + "_" + episode];
    return e && typeof e === "object" ? e : null;
  }

  function setEpProgress(animeId, episode, time, duration) {
    const all = storageGet(KEYS.epProgress) || {};
    all[animeId + "_" + episode] = {
      time: Math.max(0, time || 0),
      duration: duration || 0,
      updatedAt: Date.now(),
    };
    // Keep the store bounded: drop the oldest entries beyond 300.
    const keys = Object.keys(all);
    if (keys.length > 300) {
      keys
        .sort((a, b) => all[a].updatedAt - all[b].updatedAt)
        .slice(0, keys.length - 300)
        .forEach((k) => delete all[k]);
    }
    storageSet(KEYS.epProgress, all);
  }

  function clearEpProgress(animeId, episode) {
    const all = storageGet(KEYS.epProgress) || {};
    delete all[animeId + "_" + episode];
    storageSet(KEYS.epProgress, all);
  }

  function storageGet(key) {
    try {
      const r = localStorage.getItem(key);
      return r ? JSON.parse(r) : null;
    } catch {
      return null;
    }
  }
  function storageSet(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getDubCache() {
    return storageGet(KEYS.dubCache) || {};
  }

  // Dub cache shape:
  //   "<animeId>"                      -> { available: true }  series-level positive
  //   "<animeId>_<ep>"                 -> { available }         per-episode result
  //   "<animeId>_<ep>_<providerId>"    -> { available }         per-episode/provider result
  //
  // IMPORTANT: only *verified* outcomes are stored. A probe that times out
  // returns null ("unknown") and writes nothing, so a busy CDN or a slow
  // first load can never poison the cache into hiding a real dub. Negative
  // results also expire (see TTLs below) because dubs are often added later
  // AND because a provider outage (retryable 503s, busy CDNs) can masquerade
  // as "no dub" — a negative cached during an outage must not hide a dub
  // once the backend recovers.
  const DUB_FALSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // Probe errors are the least trustworthy negative (hidden iframe, possibly
  // during a provider outage) — expire them fast so the dub gets re-checked.
  const DUB_PROBE_FALSE_TTL_MS = 6 * 60 * 60 * 1000;

  function dubEntryValue(entry) {
    if (typeof entry === "boolean") return entry;
    if (entry && typeof entry === "object") return entry.available;
    return undefined;
  }

  function dubEntryFresh(entry, ttlMs) {
    if (!entry || typeof entry !== "object" || !entry.timestamp) return true;
    // Negatives written before the TTL field existed (v3 early entries) default
    // to the short probe TTL so any poisoned data self-heals quickly.
    const effective = ttlMs || (entry.available === false ? DUB_PROBE_FALSE_TTL_MS : DUB_FALSE_TTL_MS);
    return Date.now() - entry.timestamp < effective;
  }

  // Provider outages surface as errors with retryable hints ("temporarily
  // unavailable", "busy", "503", "try again"). Such an error is NOT evidence
  // that a dub doesn't exist — only that it couldn't be checked right now — so
  // negatives recorded from retryable errors must expire fast.
  function isRetryableDubError(message) {
    if (!message) return false;
    return /temporarily|busy|503|retry|try again|source may be/i.test(
      String(message),
    );
  }

  function setDubCached(id, episode, isAvailable, providerId = null, ttlMs = DUB_FALSE_TTL_MS) {
    const cache = getDubCache();
    const ep = episode || 1;
    const key = providerId
      ? `${id}_${ep}_${providerId}`
      : `${id}_${ep}`;
    cache[key] = {
      available: isAvailable,
      timestamp: Date.now(),
      // Long-lived negatives come from real playback failures; probe-derived
      // negatives use the shorter TTL so transient outages self-heal.
      ttl: isAvailable ? undefined : ttlMs,
    };
    // Keep the store bounded: drop the oldest entries beyond a cap so a large
    // library (per-episode/per-provider keys) can't grow toward the
    // localStorage limit.
    const keys = Object.keys(cache);
    if (keys.length > 1500) {
      keys
        .sort((a, b) => (cache[a].timestamp || 0) - (cache[b].timestamp || 0))
        .slice(0, keys.length - 1500)
        .forEach((k) => delete cache[k]);
    }

    const existingSeries = dubEntryValue(cache[id]);
    if (isAvailable) {
      // A confirmed dub on ANY episode is solid series-level knowledge.
      cache[id] = { available: true, timestamp: Date.now() };
    } else if (existingSeries === undefined) {
      // A definitive per-episode miss is good evidence the series is sub-only
      // — BUT only when EVERY provider is confirmed to lack the dub too, so a
      // single provider missing an episode can never hide a dub the other one
      // serves. Caching this lets the watch page and the "Dubbed only" filter
      // skip re-probing every episode of the same show; the TTL above ensures
      // it gets re-checked later.
      const othersConfirmedFalse = EMBED_PROVIDERS.filter(
        (p) => p.id !== providerId,
      ).every((p) => isDubCached(id, ep, p.id) === false);
      if (othersConfirmedFalse) {
        cache[id] = {
          available: false,
          timestamp: Date.now(),
          ttl: ttlMs,
        };
      }
    }
    storageSet(KEYS.dubCache, cache);
  }

  function isDubCached(id, episode = null, providerId = null) {
    const cache = getDubCache();
    if (episode) {
      const epKey = providerId ? `${id}_${episode}_${providerId}` : `${id}_${episode}`;
      const epEntry = cache[epKey];
      if (epEntry !== undefined) {
        const v = dubEntryValue(epEntry);
        if (v === true) return true;
        // Expired negatives are treated as unknown so the dub gets re-probed
        // (a transient error or a later dub release shouldn't hide it forever).
        if (v === false) return dubEntryFresh(epEntry, epEntry.ttl) ? false : null;
      }
    }
    const entry = cache[id];
    if (entry === undefined) return null;
    const v = dubEntryValue(entry);
    if (v === undefined) return null;
    if (v === false) return dubEntryFresh(entry, entry.ttl) ? false : null;
    return v;
  }

  // ----------------------------------------------------------------------------
  // 5. DUB AVAILABILITY DETECTION
  // Feature: "DUB" badges and the Sub/Dub player toggle. A hidden iframe loads
  // the dub source; the embed notifies us via postMessage whether it can play.
  // Results are cached per episode AND per provider (see KEYS.dubCache), so each
  // (anime, episode, provider) combination is only probed once.
  // ----------------------------------------------------------------------------
  // Megavid/KissKH players post player events to the parent frame as JSON
  // *strings* (e.g. '{"channel":"kisskh","event":"time",...}'). Normalize the
  // payload so callers can read `channel` / `event` / `type` on the object.
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

  // Probes whether `provider` serves a DUB of (anime, episode). Resolves to
  // true / false / null (null = unknown, e.g. probe timed out — never cached).
  //
  // The player only confirms a source by actually starting playback: it posts
  // `time` / `complete` / `watching-log` events while playing and `error` when a
  // stream fails. A `display:none` iframe can't autoplay, so the probe is parked
  // off-screen instead and granted autoplay permission.
  //
  // On `error` the player self-heals by reloading itself (?refresh=1), so a
  // single error event is NOT treated as final: we wait a short grace window
  // for playback events to override it before concluding "no dub".
  // Live dub probes, tracked so a page navigation can tear them down instead of
  // leaving hidden video players loading in the background (resource leak).
  const activeDubProbes = new Set();

  // Force-cleanup every in-flight probe. Idempotent (each probe's cleanup only
  // runs once), resolves the pending promises with null ("unknown"), removes the
  // hidden iframes and stops their play-command timers and message listeners.
  function cancelActiveDubProbes() {
    activeDubProbes.forEach((stop) => {
      try {
        stop();
      } catch (err) {}
    });
    activeDubProbes.clear();
  }

  function probeDub(anime, episode = 1, providerId = null) {
    const provider = providerId || getPrefs().provider;
    const cached = isDubCached(anime.id, episode, provider);
    if (cached !== null) return Promise.resolve(cached);

    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.src = buildEmbedUrl(provider, anime, episode, "dub");
      iframe.setAttribute("allow", "autoplay; fullscreen");
      iframe.setAttribute("loading", "eager");
      iframe.style.cssText =
        "position:fixed;left:-10000px;top:0;width:320px;height:180px;border:0;opacity:0;pointer-events:none;";
      document.body.appendChild(iframe);

      let settled = false;
      let errorTimer = null;
      let playTimer = null;

      // Probe negatives expire fast (DUB_PROBE_FALSE_TTL_MS): a hidden-iframe
      // error could be a transient provider outage, not a missing dub.
      const probeTtl = DUB_PROBE_FALSE_TTL_MS;

      function cleanup(res, cacheIt) {
        if (settled) return;
        settled = true;
        activeDubProbes.delete(stop);
        if (errorTimer) clearTimeout(errorTimer);
        if (playTimer) clearInterval(playTimer);
        window.removeEventListener("message", onMsg);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        if (cacheIt)
          setDubCached(anime.id, episode, res, provider, probeTtl);
        resolve(res);
      }

      // Registered BEFORE the iframe loads so navigation can cancel us anytime.
      const stop = () => cleanup(null, false);
      activeDubProbes.add(stop);

      // The megavid player gates autoplay behind a "viewable" check, which never
      // fires for an off-screen probe iframe — so its own autoplay never starts
      // and it never reports the time/watching-log events we need to confirm a
      // source. Kick it: the player listens for play/unmute commands when
      // autoplay is enabled, so we re-post them a few times to cover its boot
      // time. (This is also the historical root cause of "dub never detected".)
      let playAttempts = 0;
      playTimer = setInterval(() => {
        playAttempts++;
        if (settled) {
          clearInterval(playTimer);
          return;
        }
        try {
          iframe.contentWindow.postMessage(
            JSON.stringify({ channel: "kisskh", event: "play" }),
            "*",
          );
          iframe.contentWindow.postMessage(JSON.stringify({ type: "play" }), "*");
        } catch (err) {}
        if (playAttempts >= 8) clearInterval(playTimer);
      }, 1200);

      function onMsg(e) {
        const d = parseKisskhMessage(e);
        if (!d || e.source !== iframe.contentWindow) return;

        // Playback actually started — the dub exists.
        if (
          d.type === "watching-log" ||
          (d.channel === "kisskh" && (d.event === "time" || d.event === "complete"))
        ) {
          cleanup(true, true);
          return;
        }

        if (
          d.channel === "kisskh" &&
          (d.event === "error" ||
            d.event === "unavailable" ||
            d.event === "no_source")
        ) {
          // Give the player's automatic ?refresh=1 reload a moment to start
          // playback before we declare the dub missing. A retryable error
          // (busy CDN / provider outage) is NOT evidence the dub is absent —
          // resolve as unknown and cache nothing so it gets re-probed later.
          if (errorTimer === null) {
            const retryable = isRetryableDubError(d.message);
            errorTimer = setTimeout(
              () => cleanup(retryable ? null : false, !retryable),
              1500,
            );
          }
        }
      }

      window.addEventListener("message", onMsg);

      // Timeout: leave the result unknown (null) and cache nothing.
      setTimeout(() => cleanup(null, false), 8000);
    });
  }

  // Series-level "does this anime have dubs anywhere?" — used for DUB badges
  // on cards and the search "Dubbed only" filter. Any provider counts: an
  // episode-1 dub on EITHER backend is a series-level positive. Unknowns are
  // resolved by probing episode 1 on every provider whose result we don't
  // already know (best-effort, cached answer).
  function probeDubSeries(anime) {
    const unknown = EMBED_PROVIDERS.filter(
      (p) => isDubCached(anime.id, 1, p.id) === null,
    );
    if (unknown.length === 0) {
      return Promise.resolve(
        EMBED_PROVIDERS.some((p) => isDubCached(anime.id, 1, p.id) === true),
      );
    }
    return Promise.all(
      unknown.map((p) => probeDub(anime, 1, p.id)),
    ).then((rs) => rs.some((r) => r === true));
  }

  // ----------------------------------------------------------------------------
  // 6. USER LIBRARY
  // ----------------------------------------------------------------------------

  // --- Watchlist (newest first) ---
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

  // --- Watch history (capped at 200 entries, newest first, no duplicates) ---
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

  // --- Per-anime progress (highest episode watched) ---
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

  // ----------------------------------------------------------------------------
  // 7. RENDERING UTILITIES
  // ----------------------------------------------------------------------------

  // HTML-escapes untrusted strings. AniList-provided text (titles, descriptions,
  // genres) is user-generated, so always pass it through esc() before injecting
  // it into template literals.
  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    // d.innerHTML escapes <, > and & but NOT quotes — which is unsafe when the
    // output lands inside an attribute value (e.g. alt="...", title="...") or
    // a single-quoted url('...'). Escape quotes explicitly on top.
    return d.innerHTML
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/`/g, "&#96;");
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
  // ----------------------------------------------------------------------------
  // 8. EPISODE AVAILABILITY LOGIC
  // AniList's `episodes` field is the *planned* total, which can exceed what
  // has actually aired (batch releases, hiatus, unknown schedules). These
  // helpers compute how many episodes are released and which numbers are
  // currently playable. Every page renderer uses them, so the rules stay
  // consistent across the whole app.
  //
  // Source of truth for "released" (in priority order):
  //   1. `latestAired`            — most recent aired episode from the airing
  //                                 schedule (attached by getAnimeById)
  //   2. nextAiringEpisode - 1    — the episode before the next scheduled one
  //   3. `episodes`               — trusted ONLY when status is FINISHED
  //                                 (it is the actual final count then)
  // ----------------------------------------------------------------------------
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

  // Label shown under locked episodes in episode grids: a live countdown for
  // the next scheduled episode ("3d" / "12h" / "<1h"), otherwise "TBA"
  // (scheduled but no date published, or no schedule at all).
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

  // Short episode-status text used on cards ("Ep 5", "Airing", "26 eps").
  // Deliberately never shows the *planned* total as if it had aired.
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

  // ----------------------------------------------------------------------------
  // 9. ICON LIBRARY & SHARED COMPONENTS
  // ----------------------------------------------------------------------------

  // Inline SVG icons (16px default) — no external icon dependency.
  const icons = {
    arrowLeft: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>`,
    arrowRight: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><polyline points="12 5 19 12 12 19"/></svg>`,
    alert: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    clock: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    skipForward: (s = 16) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>`,
  };

  // Reusable anime card used across home feeds and search results.
  function cardHtml(anime) {
    const t = title(anime);
    const img = cover(anime);
    const score = anime.averageScore;
    const fmt = anime.format;
    const ep = epText(anime);
    const isDub = isDubCached(anime.id) === true;
    return `<a href="#/anime/${anime.id}" class="card" id="card-${anime.id}">
      <div class="card-image">
        <img src="${esc(img)}" alt="${esc(t)}" loading="lazy">
        ${score ? `<span class="card-score">${score}%</span>` : ""}
        ${fmt ? `<span class="card-format">${esc(fmt)}</span>` : ""}
        ${isDub ? `<span class="card-dub">DUB</span>` : ""}
        ${ep ? `<span class="card-ep">${esc(ep)}</span>` : ""}
      </div>
      <div class="card-body"><div class="card-title">${esc(t)}</div></div>
    </a>`;
  }

  // ----------------------------------------------------------------------------
  // 10. ROUTER — hash-based SPA routing
  // ----------------------------------------------------------------------------

  // Parses "#/path?query" into { path, params }.
  function parseHash() {
    const hash = location.hash.slice(1) || "/";
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs || "");
    return { path, params };
  }

  // Incremented on every route change. Async page renderers capture it on entry
  // and bail out (instead of touching the DOM) if a newer route took over while
  // they were awaiting — prevents stale continuations from overwriting the
  // currently displayed page (e.g. a slow dub-probe batch on the search page).
  let routeGen = 0;

  // Dispatches the current hash to the matching page renderer. Every renderer
  // replaces the #app content and may register a cleanup callback on
  // `currentPage.destroy` (timers, observers, listeners).
  async function route() {
    routeGen++;
    // Tear down the previous page before rendering the new one.
    if (currentPage.destroy) {
      currentPage.destroy();
      currentPage = { destroy: null };
    }
    // Stop hidden dub-probe players left behind by the previous page.
    cancelActiveDubProbes();
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

    window.scrollTo(0, 0);
  }

  // ----------------------------------------------------------------------------
  // 11. PAGE RENDERERS
  // ----------------------------------------------------------------------------

  // Home: hero slideshow of currently-airing titles + Trending / Recently
  // Updated / Popular sections. "Popular" is lazily paginated via an
  // IntersectionObserver on a sentinel loader element.
  async function renderHome() {
    const gen = routeGen;
    const [topAiring, trending, recent, popular] = await Promise.all([
      getTopAiring(),
      getTrending(1, 20),
      getRecentlyUpdated(1, 20),
      getPopular(1, 20),
    ]);
    if (gen !== routeGen) return; // navigated away while fetching

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
          <div class="hero-slide-bg" style="background-image:url('${esc(bg)}')"></div>
          <div class="hero-slide-overlay"></div>
          <div class="hero-slide-content">
            <div class="hero-rank">#${i + 1}</div>
            <div class="hero-slide-main">
              <div class="hero-slide-cover"><img src="${esc(cover(anime))}" alt="${esc(t)}"></div>
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

    function showSlide(n) {
      heroIndex = (n + heroCount) % heroCount;
      slides.forEach((s, i) => s.classList.toggle("active", i === heroIndex));
      dots.forEach((d, i) => d.classList.toggle("active", i === heroIndex));
    }

    function startHero() {
      clearInterval(heroTimer);
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
    currentPage.destroy = () => {
      if (heroTimer) clearInterval(heroTimer);
      observer.disconnect();
    };
  }

  // Search & browse page: text search or filtered browsing, with format
  // filters, 6 sort options, and a "Dubbed only" toggle that probes unknown
  // titles on demand (see section 5).
  async function renderSearch(params) {
    const gen = routeGen;
    const q = params.get("q") || "";
    const page = parseInt(params.get("page")) || 1;
    const format = params.get("format") || "";
    const sort = params.get("sort") || (q ? "SEARCH_MATCH" : "TRENDING_DESC");
    const dub = params.get("dub") === "1" || params.get("dubbed") === "1";

    let result;
    if (q) result = await searchAnime(q, page, 24, format || null, sort);
    else result = await browseAnime(page, 24, sort, format || null);
    if (gen !== routeGen) return; // navigated away while fetching

    if (dub && result && result.media) {
      const unknownItems = result.media.filter(
        (a) => isDubCached(a.id) === null,
      );
      if (unknownItems.length > 0) {
        // Probe in small batches so we never spawn dozens of hidden players
        // (each one briefly boots a real video element) at the same time.
        const BATCH = 5;
        for (let i = 0; i < unknownItems.length; i += BATCH) {
          await Promise.all(
            unknownItems.slice(i, i + BATCH).map((a) => probeDubSeries(a)),
          );
          if (gen !== routeGen) return; // user left mid-probe
        }
      }
      result.media = result.media.filter((a) => isDubCached(a.id) === true);
    }

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
        dub: dub ? "1" : "",
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
    html += `<a href="${buildUrl({ dub: dub ? "" : "1", page: "1" })}" class="btn btn-sm ${dub ? "btn-primary" : "btn-outline"}">${dub ? "✓ Dubbed" : "Dubbed"}</a>`;
    html += `</div>`;

    if (result.media.length === 0) {
      html += `<div class="empty"><div class="empty-title">No results found</div><div class="empty-text">Try a different search term or filter</div></div>`;
    } else {
      html += `<div class="grid grid-wide">${result.media
        .map((a) => {
          const t = title(a),
            img = cover(a),
            s = a.averageScore,
            ep = epText(a),
            isDub = isDubCached(a.id) === true;
          return `<a href="#/anime/${a.id}" class="card" id="search-card-${a.id}">
          <div class="card-image"><img src="${esc(img)}" alt="${esc(t)}" loading="lazy">
            ${s ? `<span class="card-score">${s}%</span>` : ""}
            ${a.format ? `<span class="card-format">${esc(a.format)}</span>` : ""}
            ${isDub ? `<span class="card-dub">DUB</span>` : ""}
            ${ep ? `<span class="card-ep">${esc(ep)}</span>` : ""}
          </div>
          <div class="card-body"><div class="card-title">${esc(t)}</div></div>
        </a>`;
        })
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

    app.innerHTML = html;
  }

  // Anime detail page: hero banner, stats, synopsis, next-episode countdown
  // banner, and the episodes grid. Released episodes are links; unaired ones
  // are locked with TBA/countdown labels (see section 8).
  async function renderAnimeDetail(id) {
    const gen = routeGen;
    const anime = await getAnimeById(id);
    if (gen !== routeGen) return; // navigated away while loading
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
            ${isDubCached(anime.id) === true ? `<span class="tag-accent tag-dub">DUB</span>` : ""}
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

  // ----------------------------------------------------------------------------
  // SHARED HELPERS
  // ----------------------------------------------------------------------------
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

  // Human-readable "Xd Xh Xm Xs" countdown used by every airing timer.
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

  // "m:ss" clock used for saved playback positions.
  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // Watch page (player): loads the anime, blocks unaired episodes (canWatch),
  // renders the selected provider's embed iframe, and wires up sub/dub + source
  // switching, auto-next with countdown, skip-intro/outro buttons, remembered
  // playback position (resume), preference persistence, and airing timers.
  // History and progress are only recorded for episodes that are actually
  // playable. This is the most stateful page — most logic lives in closures
  // (unavailableHtml, render, controlBarHtml, onPlayerMessage, discoverSources,
  // refreshDub) that share the page-level state declared below.
  async function renderWatch(id, episode) {
    const gen = routeGen;
    const anime = await getAnimeById(id);
    if (gen !== routeGen) return; // navigated away while loading the anime
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

    // ---- Player state (shared by every closure below) ----
    const savedPrefs = getPrefs();
    let prefs = { ...savedPrefs };
    let providerId = EMBED_PROVIDERS.some((p) => p.id === savedPrefs.provider)
      ? savedPrefs.provider
      : EMBED_PROVIDERS[0].id;
    let currentLang = savedPrefs.lang;
    let embedUrl = "";
    let loading = true;
    let error = null;
    let customUrl = null;

    // Dub availability for THIS episode on THIS provider. null = unknown yet.
    let dubState = { available: null, probing: false };
    let dubProbeSeq = 0;

    // Playback telemetry reported by the embed (channel "kisskh" / watching-log).
    let playback = { time: 0, duration: 0 };
    let lastProgressSave = 0;
    let pendingError = null; // { timer, atTime } — grace window for auto-reload

    // One-shot overlay / behaviour flags.
    let resumeShown = false;
    let autoNextTimer = null;
    let autoNextShown = false;
    let skipIntroDone = false;
    let skipOutroDone = false;
    let introAutoSkipped = false;
    let outroAutoSkipped = false;
    let fallbackUsed = false;
    let episodeCompleted = false;

    function introEndFor() {
      const d = playback.duration;
      return d > 0 ? Math.min(95, Math.max(45, d * 0.2)) : 95;
    }

    // Best-effort seek into the embed. The megavid player (JWPlayer) currently
    // only handles play/unmute commands, so this is forward-compatible: a source
    // that supports seek commands will honor one of these shapes, and on megavid
    // it is a harmless no-op (the player's own control bar still lets users skip).
    function attemptSeek(seconds) {
      const iframe = app.querySelector("iframe");
      if (!iframe || !iframe.contentWindow || typeof seconds !== "number") return;
      [
        JSON.stringify({ channel: "kisskh", event: "seek", time: seconds }),
        JSON.stringify({ channel: "kisskh", type: "seek", time: seconds }),
        JSON.stringify({ type: "seek", time: seconds }),
      ].forEach((m) => {
        try {
          iframe.contentWindow.postMessage(m, "*");
        } catch (err) {}
      });
    }

    // Forward a speed/quality preference to the player (best-effort; ignored by
    // providers that don't support the command).
    function attemptSeekControl(kind, value) {
      const iframe = app.querySelector("iframe");
      if (!iframe || !iframe.contentWindow) return;
      try {
        iframe.contentWindow.postMessage(
          JSON.stringify({ channel: "kisskh", type: kind, value }),
          "*",
        );
      } catch (err) {}
    }

    // Ensures dubState reflects whether THIS provider serves a dub of THIS
    // episode. Cached answers return immediately; unknown ones are probed via a
    // hidden iframe (section 5) in the background so the page paints fast and
    // the Dub chip lights up when the answer arrives. Only the Audio chips are
    // re-rendered here — never the whole page — so playback is not restarted
    // when a probe resolves mid-episode.
    async function refreshDub() {
      if (!canWatch) return;
      const seq = ++dubProbeSeq;
      const probeGen = routeGen;
      const cached = isDubCached(anime.id, episode, providerId);
      if (cached !== null) {
        dubState = { available: cached, probing: false };
        // Only a *definitive* no-dub downgrades a dub request to sub. A stale
        // positive/false is authoritative here.
        if (currentLang === "dub" && cached === false) {
          currentLang = "sub";
          prefs = setPrefs({ lang: "sub" });
          discoverSources();
          return;
        }
        refreshDubUI();
        return;
      }
      dubState = { available: null, probing: true };
      refreshDubUI();
      // Supersede any earlier probe (e.g. a provider/lang switch started one
      // that's still loading its hidden player) so they don't pile up.
      cancelActiveDubProbes();
      const res = await probeDub(anime, episode, providerId);
      if (seq !== dubProbeSeq || probeGen !== routeGen) return;
      dubState = { available: res, probing: false };
      // res === null means UNKNOWN (timeout / retryable outage) — keep the
      // current language and leave the chip re-checkable rather than silently
      // downgrading a dub viewer during a transient provider hiccup.
      if (currentLang === "dub" && res === false) {
        currentLang = "sub";
        prefs = setPrefs({ lang: "sub" });
        discoverSources();
      } else {
        refreshDubUI();
      }
    }

    function handleLangClick(lang) {
      if (lang === currentLang) return;
      if (lang === "dub" && dubState.available !== true) {
        refreshDub();
        return;
      }
      currentLang = lang;
      prefs = setPrefs({ lang });
      discoverSources();
    }

    function hideResumeOverlay() {
      const overlay = document.getElementById("resume-overlay");
      if (overlay) overlay.classList.remove("show");
    }

    // Rebuilds just the Audio chip group in the control bar (no player restart).
    function refreshDubUI() {
      const audioGroup = app.querySelector(".ctl-group .ctl-chips");
      if (!audioGroup) return;
      audioGroup.innerHTML = audioChipsHtml();
      audioGroup.querySelectorAll("[data-lang]").forEach((btn) => {
        btn.addEventListener("click", () => handleLangClick(btn.dataset.lang));
      });
      const checkBtn = audioGroup.querySelector("#check-dub-btn");
      if (checkBtn) checkBtn.addEventListener("click", refreshDub);
    }

    function audioChipsHtml() {
      const dub = dubState.available;
      let chips = `<button class="ctl-chip ${currentLang === "sub" ? "ctl-chip-active" : ""}" data-lang="sub">Sub</button>`;
      if (dub === true) {
        chips += `<button class="ctl-chip ${currentLang === "dub" ? "ctl-chip-active" : ""}" data-lang="dub">Dub</button>`;
      } else if (dub === null && dubState.probing) {
        chips += `<button class="ctl-chip ctl-chip-disabled" title="Checking for a dubbed version…">Dub…</button>`;
      } else if (dub === null) {
        chips += `<button class="ctl-chip ctl-chip-disabled" id="check-dub-btn" title="Check whether a dubbed version exists">Dub…</button>`;
      } else {
        chips += `<button class="ctl-chip ctl-chip-disabled" title="No dubbed version for this episode on this source">Dub</button>`;
      }
      return chips;
    }

    // The control bar: Audio (Sub/Dub), Source (provider chips) and playback
    // settings (Auto Next / Skip Intro / Skip Outro toggles, speed + quality
    // selects). Every change is persisted via setPrefs.
    function controlBarHtml() {
      const audioChips = audioChipsHtml();

      const providerChips = EMBED_PROVIDERS.map(
        (p) =>
          `<button class="ctl-chip ${providerId === p.id ? "ctl-chip-active" : ""}" data-provider="${p.id}" title="${esc(p.desc)}">${esc(p.name)}</button>`,
      ).join("");
      const customChip = customUrl
        ? `<button class="ctl-chip ctl-chip-active ctl-chip-custom" title="Custom embed URL">Custom</button>`
        : "";

      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
      const qualities = [
        { v: "auto", l: "Auto" },
        { v: "1080", l: "1080p" },
        { v: "720", l: "720p" },
        { v: "480", l: "480p" },
      ];

      return `
      <div class="player-controls">
        <div class="ctl-groups">
          <div class="ctl-group">
            <span class="ctl-label">Audio</span>
            <div class="ctl-chips">${audioChips}</div>
          </div>
          <div class="ctl-group">
            <span class="ctl-label">Source</span>
            <div class="ctl-chips">${providerChips}${customChip}</div>
          </div>
        </div>
        <div class="ctl-settings">
          <label class="ctl-toggle" title="Automatically play the next episode when this one ends">
            <input type="checkbox" data-pref="autoNext" ${prefs.autoNext ? "checked" : ""} />
            <span class="ctl-toggle-track"><span class="ctl-toggle-thumb"></span></span>
            <span class="ctl-toggle-label">Auto Next</span>
          </label>
          <label class="ctl-toggle" title="Show a Skip Intro button while the opening plays">
            <input type="checkbox" data-pref="skipIntro" ${prefs.skipIntro ? "checked" : ""} />
            <span class="ctl-toggle-track"><span class="ctl-toggle-thumb"></span></span>
            <span class="ctl-toggle-label">Skip Intro</span>
          </label>
          <label class="ctl-toggle" title="Show a Skip Outro button near the end">
            <input type="checkbox" data-pref="skipOutro" ${prefs.skipOutro ? "checked" : ""} />
            <span class="ctl-toggle-track"><span class="ctl-toggle-thumb"></span></span>
            <span class="ctl-toggle-label">Skip Outro</span>
          </label>
          <label class="ctl-select">
            <span>Speed</span>
            <select data-pref="speed">${speeds
              .map(
                (s) =>
                  `<option value="${s}" ${prefs.speed == s ? "selected" : ""}>${s}×</option>`,
              )
              .join("")}</select>
          </label>
          <label class="ctl-select">
            <span>Quality</span>
            <select data-pref="quality">${qualities
              .map(
                (q) =>
                  `<option value="${q.v}" ${prefs.quality === q.v ? "selected" : ""}>${q.l}</option>`,
              )
              .join("")}</select>
          </label>
        </div>
        <div class="ctl-hint">Playback position is saved automatically; speed &amp; quality are forwarded to the player when the source supports them.</div>
      </div>`;
    }

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

    function render() {
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

      html += `<div class="player-wrapper">`;
      if (loading && canWatch) {
        html += `<div class="loading"><div class="loading-spinner"></div><div>Finding video sources...</div></div>`;
      } else if (!canWatch) {
        html += unavailableHtml();
      } else if (embedUrl) {
        html += `<iframe src="${esc(embedUrl)}" allowfullscreen loading="lazy" allow="autoplay; fullscreen"></iframe>`;
        html += `<div class="episode-badge">Episode ${episode}</div>`;
        html += `<button class="player-skip-btn skip-intro" id="skip-intro-btn" aria-label="Skip opening">${icons.skipForward(14)} Skip Intro</button>`;
        html += `<button class="player-skip-btn skip-outro" id="skip-outro-btn" aria-label="Skip ending">${icons.skipForward(14)} Skip Outro</button>`;
        html += `<div class="player-overlay resume-overlay" id="resume-overlay">
          <div class="resume-card">
            <div class="resume-title">Resume watching?</div>
            <div class="resume-sub" id="resume-sub"></div>
            <div class="resume-actions">
              <button class="btn btn-outline btn-sm" id="resume-restart">Start Over</button>
              <button class="btn btn-primary btn-sm" id="resume-go">Resume</button>
            </div>
          </div>
        </div>`;
        html += `<div class="player-overlay auto-next-overlay" id="auto-next-overlay">
          <div class="auto-next-card">
            <div class="auto-next-title">Episode ${episode} finished</div>
            <div class="auto-next-sub" id="auto-next-label"></div>
            <div class="auto-next-actions">
              <button class="btn btn-outline btn-sm" id="auto-next-cancel">Cancel</button>
              <a class="btn btn-primary btn-sm" id="auto-next-go" href="#/watch/${anime.id}/${Math.min(episode + 1, airedEps)}">Play Next ${icons.arrowRight(14)}</a>
            </div>
          </div>
        </div>`;
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

      if (canWatch) html += controlBarHtml();

      if (error) {
        const other = EMBED_PROVIDERS.find((p) => p.id !== providerId);
        html += `<div class="embed-error">
          <div class="embed-error-text">${esc(error)}</div>
          <div class="embed-error-actions">
            <button class="btn btn-outline btn-sm" id="retry-btn">Retry</button>
            ${other && !customUrl ? `<button class="btn btn-outline btn-sm" id="switch-provider-btn">Try ${esc(other.name)}</button>` : ""}
          </div>
        </div>`;
      }

      if (!loading && !embedUrl && canWatch) {
        html += `<div class="player-url-input"><input type="text" id="custom-embed-url" placeholder="Or paste an embed URL..." /><button class="btn btn-primary btn-sm" id="load-custom-url">Load</button></div>`;
      }

      if (totalEps > 0) {
        const watched = getProgress(anime.id);
        html += `<div style="margin-top:24px"><h3 class="episodes-title" style="margin-bottom:12px">Episodes</h3><div class="episodes-grid">`;
        for (let i = 1; i <= totalEps; i++) {
          const isReleased = i <= airedEps;
          const isWatched = i <= watched;
          let cls = "ep-btn";
          if (i === episode) cls += " ep-btn-current";
          if (isReleased) {
            cls += isWatched ? " ep-btn-watched" : " ep-btn-aired";
            html += `<a href="#/watch/${anime.id}/${i}" class="${cls}">${i}</a>`;
          } else {
            cls += " ep-btn-upcoming";
            const lbl = upcomingEpLabel(anime, i);
            if (lbl.today) cls += " ep-btn-today";
            html += `<span class="${cls}" title="Not yet aired">${i}${lbl.text ? `<div class="ep-air-date upcoming-date">${esc(lbl.text)}</div>` : ""}</span>`;
          }
        }
        html += `</div></div>`;
      }

      html += `</div>`;
      app.innerHTML = html;

      // Audio chips (Sub / Dub).
      document.querySelectorAll("[data-lang]").forEach((btn) => {
        btn.addEventListener("click", () => handleLangClick(btn.dataset.lang));
      });

      // Source (provider) chips.
      document.querySelectorAll("[data-provider]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pid = btn.dataset.provider;
          if (pid === providerId) return;
          providerId = pid;
          customUrl = null;
          prefs = setPrefs({ provider: pid });
          if (
            currentLang === "dub" &&
            isDubCached(anime.id, episode, pid) === false
          ) {
            currentLang = "sub";
            prefs = setPrefs({ lang: "sub" });
          }
          refreshDub();
          discoverSources();
        });
      });

      // Persisted settings (toggles + selects).
      document.querySelectorAll("[data-pref]").forEach((el) => {
        const key = el.dataset.pref;
        const isCheck = el.type === "checkbox";
        el.addEventListener("change", () => {
          const raw = isCheck ? el.checked : el.value;
          const val = !isCheck && key === "speed" ? parseFloat(raw) : raw;
          prefs = setPrefs({ [key]: val });
          if (key === "speed") attemptSeekControl("speed", val);
          if (key === "quality") attemptSeekControl("quality", val);
        });
      });

      // Skip Intro / Skip Outro overlay buttons.
      const introBtn = document.getElementById("skip-intro-btn");
      if (introBtn) {
        introBtn.addEventListener("click", () => {
          skipIntroDone = true;
          attemptSeek(introEndFor());
          introBtn.classList.remove("show");
        });
      }
      const outroBtn = document.getElementById("skip-outro-btn");
      if (outroBtn) {
        outroBtn.addEventListener("click", () => {
          skipOutroDone = true;
          attemptSeek(Math.max(0, playback.duration - 3));
          outroBtn.classList.remove("show");
        });
      }

      // Resume overlay.
      const resumeGo = document.getElementById("resume-go");
      if (resumeGo) {
        resumeGo.addEventListener("click", () => {
          const saved = getEpProgress(anime.id, episode);
          clearEpProgress(anime.id, episode);
          hideResumeOverlay();
          if (saved) attemptSeek(saved.time);
        });
      }
      const resumeRestart = document.getElementById("resume-restart");
      if (resumeRestart) {
        resumeRestart.addEventListener("click", () => {
          clearEpProgress(anime.id, episode);
          hideResumeOverlay();
        });
      }

      // Auto-next overlay.
      const autoNextCancel = document.getElementById("auto-next-cancel");
      if (autoNextCancel) {
        autoNextCancel.addEventListener("click", () => {
          if (autoNextTimer) {
            clearInterval(autoNextTimer);
            autoNextTimer = null;
          }
          const overlay = document.getElementById("auto-next-overlay");
          if (overlay) overlay.classList.remove("show");
        });
      }

      const checkDubBtn = document.getElementById("check-dub-btn");
      if (checkDubBtn) checkDubBtn.addEventListener("click", refreshDub);

      const loadBtn = document.getElementById("load-custom-url");
      if (loadBtn) {
        loadBtn.addEventListener("click", () => {
          const input = document.getElementById("custom-embed-url");
          if (input && input.value.trim()) {
            customUrl = input.value.trim();
            discoverSources();
          }
        });
      }

      const retryBtn = document.getElementById("retry-btn");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          error = null;
          discoverSources();
        });
      }

      const switchBtn = document.getElementById("switch-provider-btn");
      if (switchBtn) {
        switchBtn.addEventListener("click", () => {
          const other = EMBED_PROVIDERS.find((p) => p.id !== providerId);
          if (other) {
            providerId = other.id;
            prefs = setPrefs({ provider: providerId });
            refreshDub();
            discoverSources();
          }
        });
      }
    }

    function updatePlaybackUI() {
      const { time, duration } = playback;

      // Resume overlay — offered once, only when we have meaningful saved progress
      // ahead of where the player started.
      if (!resumeShown && duration > 0 && time > 2) {
        const saved = getEpProgress(anime.id, episode);
        if (
          saved &&
          saved.time > 20 &&
          saved.time < duration - 90 &&
          saved.time > time + 5
        ) {
          resumeShown = true;
          const overlay = document.getElementById("resume-overlay");
          const sub = document.getElementById("resume-sub");
          if (overlay) overlay.classList.add("show");
          if (sub) {
            sub.textContent = `You stopped at ${formatTime(saved.time)}${
              saved.duration ? ` of ${formatTime(saved.duration)}` : ""
            }.`;
          }
        }
      }

      // Skip Intro / Skip Outro overlay windows (intro = opening minutes,
      // outro = last ~105 seconds once the duration is known).
      const introEnd = introEndFor();
      const introBtn = document.getElementById("skip-intro-btn");
      if (introBtn) {
        const visible = time < introEnd && !skipIntroDone;
        introBtn.classList.toggle("show", visible);
        // With Skip Intro on, auto-attempt the skip ONCE per episode window.
        if (visible && prefs.skipIntro && time > 1 && !introAutoSkipped) {
          introAutoSkipped = true;
          attemptSeek(introEnd);
        }
      }
      const outroBtn = document.getElementById("skip-outro-btn");
      if (outroBtn) {
        const visible =
          duration > 0 &&
          time > duration - 105 &&
          time < duration - 2 &&
          !skipOutroDone;
        outroBtn.classList.toggle("show", visible);
        if (visible && prefs.skipOutro && !outroAutoSkipped) {
          outroAutoSkipped = true;
          attemptSeek(Math.max(0, duration - 3));
        }
      }
    }

    function onPlayerMessage(e) {
      const d = parseKisskhMessage(e);
      if (!d) return;
      const iframe = app.querySelector("iframe");
      if (!iframe || e.source !== iframe.contentWindow) return;

      // Playback position + duration (both watching-log and kisskh/time carry it).
      if (
        d.type === "watching-log" ||
        (d.channel === "kisskh" && d.event === "time")
      ) {
        // Any position event after a stream error means the player's automatic
        // ?refresh=1 reload self-healed — cancel the pending error. (Comparing
        // positions would fail because the reload restarts from 0.)
        if (pendingError) {
          clearTimeout(pendingError.timer);
          pendingError = null;
        }
        const time = typeof d.time === "number" ? d.time : d.currentTime;
        const duration = typeof d.duration === "number" ? d.duration : 0;
        if (typeof time === "number" && time >= 0) {
          playback = {
            time,
            duration: duration > 0 ? duration : playback.duration,
          };
          updatePlaybackUI();
          const now = Date.now();
          // Never re-save a resume position once the episode has completed —
          // handleComplete() already cleared it so the finished episode doesn't
          // reappear in the resume overlay or watch progress.
          if (
            !episodeCompleted &&
            now - lastProgressSave > 5000 &&
            playback.time > 5
          ) {
            lastProgressSave = now;
            setEpProgress(anime.id, episode, playback.time, playback.duration);
          }
        }
        return;
      }
      if (d.channel !== "kisskh") return;

      if (d.event === "complete") {
        handleComplete();
      } else if (d.event === "error" && !pendingError && !error) {
        // The player auto-reloads itself once (?refresh=1) on stream errors and
        // often self-heals, so wait a short grace window for playback to resume
        // before declaring a real failure.
        pendingError = {
          timer: setTimeout(() => {
            pendingError = null;
            realHandleError(d.message);
          }, 2500),
          atTime: playback.time,
        };
      }
    }

    function handleComplete() {
      // Episode watched to the end — clear the resume position and make sure the
      // page-destroy flush below doesn't re-save it.
      episodeCompleted = true;
      clearEpProgress(anime.id, episode);
      if (episode >= airedEps) return;
      const overlay = document.getElementById("auto-next-overlay");
      if (!overlay) {
        location.hash = `#/watch/${anime.id}/${episode + 1}`;
        return;
      }
      if (autoNextShown) return;
      autoNextShown = true;
      overlay.classList.add("show");
      const label = document.getElementById("auto-next-label");
      const goBtn = document.getElementById("auto-next-go");
      if (goBtn) goBtn.setAttribute("href", `#/watch/${anime.id}/${episode + 1}`);
      if (prefs.autoNext) {
        let left = 5;
        const tick = () => {
          if (label) label.textContent = `Next episode in ${left}s`;
          if (left <= 0) {
            clearInterval(autoNextTimer);
            autoNextTimer = null;
            location.hash = `#/watch/${anime.id}/${episode + 1}`;
            return;
          }
          left--;
        };
        tick();
        autoNextTimer = setInterval(tick, 1000);
      } else if (label) {
        label.textContent = "Episode complete — play the next one?";
      }
    }

    function realHandleError(message) {
      if (error) return;

      // A dub stream that errors means this provider has no working dub for this
      // episode — record it and drop back to sub. But a retryable error (busy
      // CDN / provider outage) only gets the short TTL so a recovered backend
      // doesn't stay hidden for a week.
      if (currentLang === "dub") {
        setDubCached(
          anime.id,
          episode,
          false,
          providerId,
          isRetryableDubError(message)
            ? DUB_PROBE_FALSE_TTL_MS
            : DUB_FALSE_TTL_MS,
        );
        dubState = { available: false, probing: false };
        currentLang = "sub";
        prefs = setPrefs({ lang: "sub" });
        discoverSources();
        return;
      }

      // Once per session, silently fall back to the other provider before
      // surfacing an error — the whole point of having multiple sources.
      if (!fallbackUsed && !customUrl && EMBED_PROVIDERS.length > 1) {
        const other = EMBED_PROVIDERS.find((p) => p.id !== providerId);
        if (other) {
          fallbackUsed = true;
          providerId = other.id;
          prefs = setPrefs({ provider: providerId });
          refreshDub();
          discoverSources();
          return;
        }
      }

      error = message || "The video failed to load. Please try another source.";
      render();
    }

    function discoverSources() {
      if (!canWatch) {
        loading = false;
        render();
        return;
      }
      loading = true;
      error = null;
      embedUrl = "";
      // Reset per-episode playback state when (re)loading the iframe.
      playback = { time: 0, duration: 0 };
      resumeShown = false;
      skipIntroDone = false;
      skipOutroDone = false;
      introAutoSkipped = false;
      outroAutoSkipped = false;
      // A fresh iframe load is a new playback session: if the previous stream
      // completed but the user cancelled auto-next and switched source to keep
      // watching, re-allow progress saving for the rewatch.
      episodeCompleted = false;
      // If the user switches source while the auto-next countdown is up, cancel
      // it (they're clearly still watching this episode) so a stale timer can't
      // yank them to the next episode after the reload.
      if (autoNextTimer) {
        clearInterval(autoNextTimer);
        autoNextTimer = null;
      }
      autoNextShown = false;
      if (pendingError) {
        clearTimeout(pendingError.timer);
        pendingError = null;
      }

      if (customUrl) {
        embedUrl = customUrl;
        loading = false;
        render();
        return;
      }
      embedUrl = buildEmbedUrl(providerId, anime, episode, currentLang);
      loading = false;
      render();
    }

    render();

    // Background dub probe for the current episode + provider — does not block
    // the first paint. The result flips the Dub chip (and switches back to sub
    // if we asked for a dub that isn't available).
    if (canWatch) refreshDub();

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
      if (autoNextTimer) clearInterval(autoNextTimer);
      if (pendingError) clearTimeout(pendingError.timer);
      window.removeEventListener("message", onPlayerMessage);
      // Stop any in-flight dub probe from resolving into this (now dead) page.
      dubProbeSeq++;
      // Flush any unsaved position when leaving the page (unless the episode
      // was finished, whose resume position was already cleared).
      if (canWatch && !episodeCompleted && playback.time > 5) {
        setEpProgress(anime.id, episode, playback.time, playback.duration);
      }
    };
    discoverSources();
  }

  // Watchlist page: saved titles with per-title progress and one-click remove.
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
          return `<div class="card" style="position:relative" id="watchlist-card-${a.id}">
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

  // History page: recent watches (newest first) with a "Continue Watching"
  // card for the latest entry and one-click resume links.
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

  // About page: static project info, community Discord card and developer links.
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
    html += `<li>Sub/Dub player with autoplay, auto-next, and error retry support</li>`;
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
    html += `</div>`;

    app.innerHTML = html;
  }

  // ----------------------------------------------------------------------------
  // 12. NAVIGATION & BOOTSTRAP
  // ----------------------------------------------------------------------------

  // Navbar search: navigates to #/search?q=<query>.
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (q) {
      location.hash = "/search?q=" + encodeURIComponent(q);
      searchInput.value = "";
    }
  });

  // Mobile menu toggle + auto-close on navigation or outside click.
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("nav-links");
  function closeMenu() {
    navLinks.classList.remove("open");
    navToggle.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
  }
  navToggle.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    navToggle.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", String(open));
  });
  navLinks.addEventListener("click", (e) => {
    if (e.target.closest("a")) closeMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".nav") && navLinks.classList.contains("open"))
      closeMenu();
  });

  // Boot: re-render on every hash change, then render the initial route.
  window.addEventListener("hashchange", () => {
    if (navLinks.classList.contains("open")) closeMenu();
    route();
  });
  route();
})();
