const axios = require("axios");

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

const DEFAULT_COVERS = [
  "https://p2.music.126.net/N2YiRib0YwZ-Gj6VqdUYig==/109951166952706604.jpg",
  "https://p2.music.126.net/DrRIy6jBsBtx9V2_BxDu_A==/109951166952686384.jpg",
  "https://p2.music.126.net/b4oy2DGeBw7hAhH1h2w4ug==/109951166952687980.jpg",
];

/**
 * 字符串清理与 HTML / Unicode 转义序列反转义
 */
function cleanString(str) {
  if (!str) return "";
  let result = String(str);
  try {
    result = result.replace(/\\u([0-9a-fA-F]{4})/g, function (match, grp) {
      return String.fromCharCode(parseInt(grp, 16));
    });
  } catch (e) {}
  return result
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\u003cbr\\u003e/gi, " ")
    .replace(/\\u0026nbsp;/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 高效纯本地封面直链解析 (零延迟算力转换)
 */
function resolveArtworkUrlSync(picId, source) {
  if (!picId) return DEFAULT_COVERS[0];

  let picStr = String(picId).trim();
  if (picStr.indexOf("http://") === 0 || picStr.indexOf("https://") === 0) {
    return picStr.replace("http://", "https://");
  }

  if (source === "kuwo") {
    if (picStr.indexOf(".jpg") !== -1 || picStr.indexOf(".png") !== -1) {
      return `https://img2.kuwo.cn/star/albumcover/300/${picStr}`;
    }
  }

  if (source === "tencent") {
    if (picStr.length > 5 && picStr.indexOf("/") === -1) {
      return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${picStr}.jpg`;
    }
  }

  if (source === "netease") {
    if (picStr.indexOf("http") === 0)
      return picStr.replace("http://", "https://");
  }

  return DEFAULT_COVERS[0];
}

const SEARCH_REQUEST_TTL_MS = 30000;
const LYRIC_REQUEST_TTL_MS = 5 * 60 * 1000;
const SHEET_SEARCH_TTL_MS = 30000;
const SHEET_DETAIL_TTL_MS = 60000;
const SEARCH_REQUEST_CACHE_MAX = 100;
const SEARCH_FAILURE_MAX = 50;
const requestCache = new Map();
const requestsInFlight = new Map();
const requestFailures = [];

const playlistDetailCache = new Map();
const PLAYLIST_DETAIL_CACHE_MAX = 50;

function getPlaylistDetailCache(key) {
  var entry = playlistDetailCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry;
  if (entry) playlistDetailCache.delete(key);
  return null;
}

function setPlaylistDetailCache(key, musicList, total, sheetItem) {
  playlistDetailCache.set(key, {
    musicList: musicList,
    total: total,
    sheetItem: sheetItem,
    expiresAt: Date.now() + SHEET_DETAIL_TTL_MS,
  });
  if (playlistDetailCache.size > PLAYLIST_DETAIL_CACHE_MAX) {
    playlistDetailCache.delete(playlistDetailCache.keys().next().value);
  }
}

function getSearchRequestKey(source, query, page, endpointVariant) {
  return ["search-music", source, endpointVariant || "default", String(query), String(page)].join("\u0001");
}

function getLyricRequestKey(operation, source, lyricId) {
  return [operation, source, String(lyricId)].join("\u0001");
}

function getSheetSearchRequestKey(source, query, page, endpointVariant) {
  return ["search-sheet", source, endpointVariant || "default", String(query), String(page)].join("\u0001");
}

function getSheetDetailRequestKey(source, playlistId, endpointVariant) {
  return ["sheet-detail", source, endpointVariant || "primary", String(playlistId)].join("\u0001");
}

function getMediaRequestKey(source, operation, cohesiveKey) {
  return ["media-url", source, operation, String(cohesiveKey)].join("\u0001");
}

function isTransientRequestError(error) {
  const status = error && error.response && error.response.status
    ? error.response.status
    : error && error.status;
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
  if (error && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) return true;
  return !status;
}

function getSafeRequestFailureKind(error) {
  if (error && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) return "timeout";
  return isTransientRequestError(error) ? "transient" : "terminal";
}

function recordRequestFailure(source, operation, error) {
  requestFailures.push({
    source: source,
    operation: operation,
    kind: getSafeRequestFailureKind(error),
  });
  if (requestFailures.length > SEARCH_FAILURE_MAX) requestFailures.shift();
}

function waitForRequestRetry() {
  return new Promise(function (resolve) { setTimeout(resolve, 200); });
}

function allSettled(promises) {
  return Promise.all(promises.map(function (promise) {
    return Promise.resolve(promise).then(function (value) {
      return { status: "fulfilled", value: value };
    }, function (reason) {
      return { status: "rejected", reason: reason };
    });
  }));
}

function resilientGet(source, operation, key, request, options) {
  const now = Date.now();
  const cached = requestCache.get(key);
  if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);
  if (cached) requestCache.delete(key);
  if (requestsInFlight.has(key)) return requestsInFlight.get(key);

  const promise = (async function () {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await request();
        const status = response && response.status;
        if (!response || status === 408 || status === 429 || (status >= 500 && status <= 599)) {
          const error = new Error("request unsuccessful");
          error.status = status;
          throw error;
        }
        if (!options || !options.isCacheable || options.isCacheable(response)) {
          requestCache.set(key, { value: response, expiresAt: Date.now() + ((options && options.ttlMs) || SEARCH_REQUEST_TTL_MS) });
          while (requestCache.size > SEARCH_REQUEST_CACHE_MAX) {
            requestCache.delete(requestCache.keys().next().value);
          }
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isTransientRequestError(error)) {
          await waitForRequestRetry();
          continue;
        }
        break;
      }
    }
    if (!options || options.recordFailure !== false) recordRequestFailure(source, operation, lastError);
    throw lastError;
  })();

  let inFlightPromise;
  inFlightPromise = promise.then(function (response) {
    if (requestsInFlight.get(key) === inFlightPromise) requestsInFlight.delete(key);
    return response;
  }, function (error) {
    if (requestsInFlight.get(key) === inFlightPromise) requestsInFlight.delete(key);
    throw error;
  });
  requestsInFlight.set(key, inFlightPromise);
  return inFlightPromise;
}

function searchMusicGet(source, query, page, request, options) {
  return resilientGet(source, "search-music", getSearchRequestKey(source, query, page, options && options.cacheKeyVariant), request, options);
}

function lyricGet(source, operation, lyricId, request, isCacheable) {
  return resilientGet(source, operation, getLyricRequestKey(operation, source, lyricId), request, {
    ttlMs: LYRIC_REQUEST_TTL_MS,
    isCacheable: isCacheable,
  });
}

function sheetSearchGet(source, query, page, request, options) {
  return resilientGet(source, "search-sheet", getSheetSearchRequestKey(source, query, page, options && options.cacheKeyVariant), request, Object.assign({ ttlMs: SHEET_SEARCH_TTL_MS }, options));
}

function sheetDetailGet(source, playlistId, request, options) {
  return resilientGet(source, "sheet-detail", getSheetDetailRequestKey(source, playlistId, options && options.cacheKeyVariant), request, Object.assign({ ttlMs: SHEET_DETAIL_TTL_MS }, options));
}

function mediaCoalesceGet(source, operation, cohesiveKey, request) {
  return resilientGet(source, operation, getMediaRequestKey(source, operation, cohesiveKey), request, { ttlMs: 0, isCacheable: function () { return false; } });
}

function getRequestDiagnostics() {
  return {
    failures: requestFailures.map(function (failure) {
      return { source: failure.source, operation: failure.operation, kind: failure.kind };
    }),
    cacheEntries: requestCache.size,
    inFlight: requestsInFlight.size,
  };
}

/**
 * 多源并发检索单曲 (网易云, 酷我, QQ音乐, 酷狗 四平台并发聚合与交叉混排)
 */
async function fetchMultiSourceData(query, pageNum, sourceSetting) {
  const allSources = ["netease", "kuwo", "tencent", "kugou"];
  const selectedSetting = (sourceSetting || "all").toLowerCase();

  const targetSources =
    selectedSetting !== "all" && allSources.indexOf(selectedSetting) !== -1
      ? [selectedSetting]
      : allSources;

  const pageSize = 10;

  const fetchPromises = targetSources.map(async function (src) {
    // 1. 网易云音乐 (采用未加密高可靠 v1 API，Fallback 到 gdstudio)
    if (src === "netease") {
      try {
        const offset = (pageNum - 1) * pageSize;
        const neteaseUrl = `https://music.163.com/api/v1/search/get?s=${encodeURIComponent(query)}&type=1&offset=${offset}&limit=${pageSize}`;
        const res = await searchMusicGet("netease", query, pageNum, function () {
          return axios.get(neteaseUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 2200,
          });
        }, { recordFailure: false, cacheKeyVariant: "netease-primary" });
        if (res && res.data && res.data.result && res.data.result.songs) {
          return res.data.result.songs.map(function (item) {
            const artistStr = item.artists
              ? item.artists
                  .map(function (a) {
                    return cleanString(a.name);
                  })
                  .join(" / ")
              : "未知歌手";
            const coverUrl =
              item.album && item.album.picUrl
                ? item.album.picUrl.replace("http://", "https://")
                : DEFAULT_COVERS[0];
            const durationSec = item.duration
              ? Math.round(item.duration / 1000)
              : item.dt
                ? Math.round(item.dt / 1000)
                : 0;

            return {
              id: String(item.id),
              name: cleanString(item.name),
              artist: artistStr,
              album: cleanString(item.album && item.album.name),
              source: "netease",
              url_id: String(item.id),
              lyric_id: String(item.id),
              pic_id: coverUrl,
              duration: durationSec,
            };
          });
        }
      } catch (e) {
        try {
          const fallbackUrl = `https://music-api.gdstudio.xyz/api.php?types=search&count=${pageSize}&source=netease&pages=${pageNum}&name=${encodeURIComponent(query)}`;
          const res = await searchMusicGet("netease", query, pageNum, function () {
            return axios.get(fallbackUrl, {
              headers: DEFAULT_HEADERS,
              timeout: 2200,
            });
          }, { cacheKeyVariant: "netease-fallback" });
          if (Array.isArray(res.data)) {
            return res.data.map(function (item) {
              return {
                id: String(item.id || item.url_id),
                name: cleanString(item.name),
                artist: Array.isArray(item.artist)
                  ? item.artist.map(cleanString).join(" / ")
                  : cleanString(item.artist),
                album: cleanString(item.album),
                source: "netease",
                url_id: String(item.url_id || item.id),
                lyric_id: String(item.lyric_id || item.id),
                pic_id: item.pic_id,
                duration: 0,
              };
            });
          }
        } catch (err) {}
      }
    }

    // 2. 酷我音乐
    if (src === "kuwo") {
      try {
        const kuwoUrl = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&ft=music&itemset=ft&client=kt&pn=${pageNum - 1}&rn=${pageSize}&rformat=json&encoding=utf8`;
        const res = await searchMusicGet("kuwo", query, pageNum, function () {
          return axios.get(kuwoUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 4500,
          });
        });
        const cleanText = (
          typeof res.data === "string" ? res.data : JSON.stringify(res.data)
        ).replace(/'/g, '"');
        const json = JSON.parse(cleanText);

        if (json && Array.isArray(json.abslist)) {
          return json.abslist.map(function (item) {
            const songId =
              (item.MUSICRID || "").replace("MUSIC_", "") || item.DC_TARGETID;
            const durationSec = item.SONGTIME
              ? parseInt(item.SONGTIME, 10)
              : item.duration
                ? parseInt(item.duration, 10)
                : 0;

            return {
              id: String(songId),
              name: cleanString(item.SONGNAME),
              artist: cleanString(item.ARTIST || "未知歌手"),
              album: cleanString(item.ALBUM),
              source: "kuwo",
              url_id: String(songId),
              lyric_id: String(songId),
              pic_id:
                item.web_albumpic ||
                item.hts_pic0 ||
                item.hts_pic ||
                item.albumcover,
              duration: durationSec,
            };
          });
        }
      } catch (e) {}
    }

    // 3. QQ 音乐
    if (src === "tencent") {
      try {
        const qqUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&n=${pageSize}&p=${pageNum}&format=json`;
        const res = await searchMusicGet("tencent", query, pageNum, function () {
          return axios.get(qqUrl, {
            headers: Object.assign({}, DEFAULT_HEADERS, { Referer: "https://y.qq.com/" }),
            timeout: 4500,
          });
        });
        if (
          res &&
          res.data &&
          res.data.data &&
          res.data.data.song &&
          res.data.data.song.list
        ) {
          return res.data.data.song.list.map(function (item) {
            return {
              id: String(item.songmid || item.songid),
              name: cleanString(item.songname),
              artist: item.singer
                ? item.singer
                    .map(function (s) {
                      return cleanString(s.name);
                    })
                    .join(" / ")
                : "未知歌手",
              album: cleanString(item.albumname),
              source: "tencent",
              url_id: String(item.songmid || item.songid),
              lyric_id: String(item.songmid || item.songid),
              pic_id: item.albummid,
              duration: item.interval ? parseInt(item.interval, 10) : 0,
            };
          });
        }
      } catch (e) {}
    }

    // 4. 酷狗音乐 (采用 HTTP 规避移动端与 Node.js 中的 SSL 证书匹配错误)
    if (src === "kugou") {
      try {
        const kgUrl = `http://mobilecdn.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(query)}&page=${pageNum}&pagesize=${pageSize}`;
        const res = await searchMusicGet("kugou", query, pageNum, function () {
          return axios.get(kgUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 4500,
          });
        });
        if (res && res.data && res.data.data && res.data.data.info) {
          return res.data.data.info.map(function (item) {
            return {
              id: String(item.hash || item.audio_id),
              name: cleanString(item.songname || item.filename),
              artist: cleanString(item.singername || "未知歌手"),
              album: cleanString(item.album_name),
              source: "kugou",
              url_id: String(item.hash),
              lyric_id: String(item.hash),
              pic_id: item.album_s_id || item.album_id,
              duration: item.duration ? parseInt(item.duration, 10) : 0,
            };
          });
        }
      } catch (e) {}
    }

    return [];
  });

  const results = await allSettled(fetchPromises);
  const lists = results.map(function (r) {
    return r.status === "fulfilled" ? r.value : [];
  });

  const combined = [];
  const maxLen = Math.max(
    ...lists.map(function (l) {
      return l.length;
    }),
    0,
  );
  for (let i = 0; i < maxLen; i++) {
    for (let j = 0; j < lists.length; j++) {
      if (lists[j][i]) {
        combined.push(lists[j][i]);
      }
    }
  }

  const unique = new Map();
  combined.forEach(function (item) {
    const normalizedTitle = cleanString(item.name)
      .toLowerCase()
      .replace(/\s+/g, "");
    const normalizedArtist = cleanString(item.artist)
      .toLowerCase()
      .replace(/\s+/g, "");
    const duration = parseInt(item.duration, 10) || 0;
    const durationBucket = duration > 0
      ? Math.floor(duration / 10)
      : `unknown:${item.source}:${item.id}`;
    const key = `${normalizedTitle}|${normalizedArtist}|${durationBucket}`;
    const sourceRecord = {
      source: item.source,
      id: item.id,
      url_id: item.url_id || item.id,
      lyric_id: item.lyric_id || item.id,
      pic_id: item.pic_id,
      duration: item.duration || 0,
    };
    const existing = unique.get(key);
    if (existing) {
      existing.sourceRecords.push(sourceRecord);
    } else {
      item.sourceRecords = [sourceRecord];
      unique.set(key, item);
    }
  });
  return Array.from(unique.values());
}

/**
 * 瀑布流音频直链解析
 */
async function fetchMediaUrlFromEngines(musicItem, quality, userVars) {
  const title = cleanString(
    musicItem.title ? musicItem.title.replace(/\[.*?\]/g, "") : "",
  );
  const artist = cleanString(musicItem.artist);
  const source = (musicItem.extra && musicItem.extra.source) || "netease";
  const urlId = (musicItem.extra && musicItem.extra.url_id) || musicItem.id;
  const keyword = `${title} ${artist}`.trim();

  // 1. 自定义 API 接口
  if (userVars.customApiUrl) {
    try {
      const customUrl = userVars.customApiUrl
        .replace("{id}", urlId)
        .replace("{source}", source)
        .replace("{quality}", quality)
        .replace("{keyword}", encodeURIComponent(keyword));
      const resp = await mediaCoalesceGet(source, "custom-resolve", source + "|" + urlId + "|" + quality + "|custom", function () {
        return axios.get(customUrl, {
          headers: DEFAULT_HEADERS,
          timeout: 4500,
        });
      });
      if (resp.data) {
        const url =
          resp.data.url ||
          (resp.data.data && resp.data.data.url) ||
          resp.data.data;
        if (url && typeof url === "string" && url.indexOf("http") === 0) {
          return url;
        }
      }
    } catch (e) {}
  }

  // 2. 仅调用能保留原始平台 ID 与 source 的解析端点；
  // 跨平台关键词/网易云回退没有返回曲目元数据，不能安全替代请求曲目。
  const engineApis = [
    `https://music-api.gdstudio.xyz/api.php?types=url&id=${urlId}&source=${source}`,
  ];

  for (const apiUrl of engineApis) {
    try {
      const res = await mediaCoalesceGet(source, "engine-resolve", source + "|" + urlId, function () {
        return axios.get(apiUrl, {
          headers: DEFAULT_HEADERS,
          timeout: 4000,
        });
      });
      const data = res ? res.data : null;
      const url = data
        ? data.url ||
          (data.data && data.data.url) ||
          (Array.isArray(data.data) && data.data[0] ? data.data[0].url : null)
        : null;
      if (url && typeof url === "string" && url.indexOf("http") === 0) {
        return url;
      }
    } catch (e) {}
  }

  throw new Error(`所有解析引擎均未能获取 [${title} - ${artist}] 的音频直链`);
}

module.exports = {
  // ===== 必填规范属性 =====
  platform: "通用聚合音源",
  version: "2.3.3",
  author: "yzbtdmz1",
  srcUrl: "https://raw.githubusercontent.com/xiajiajun516/MusicFreePlugins/master/musicfree-aggregate-plugin.js",
  description:
    "通用音乐全网聚合音源，严格遵循 MusicFree 官方协议规范，兼容 ES8 及手机原生 JS 引擎。",
  cacheControl: "no-cache",
  getRequestDiagnostics: getRequestDiagnostics,
  supportedSearchType: ["music", "album", "artist", "sheet"],

  // ===== 官方 userVariables (兼顾 name 与 title 别名字段) =====
  userVariables: [
    {
      key: "searchSource",
      name: "默认搜索源模式",
      title: "默认搜索源模式",
      hint: "all (全平台并发聚合搜索，默认) / netease / kuwo / tencent / kugou",
    },
    {
      key: "showBadge",
      name: "显示平台标签后缀",
      title: "显示平台标签后缀",
      hint: "false (默认关闭，歌名保持干净) / true (在歌名后附加 [网易] [酷我] [QQ] [酷狗] 等后缀)",
    },
    {
      key: "customApiUrl",
      name: "自定义 API 接口",
      title: "自定义 API 接口",
      hint: "自定义解析接口模板（支持 {id}, {source}, {quality}, {keyword} 占位符）",
    },
  ],

  // ===== 官方 hints 文案提示 =====
  hints: {
    importMusicSheet: [
      "支持粘贴网易云歌单 ID（如 3778678）或酷我歌单 ID",
      "支持直接粘贴歌单链接或歌单名称自动搜索导入",
    ],
    importMusicItem: [
      "支持粘贴单曲 ID（如网易云 186016 or 酷我/QQ 音乐单曲 ID）",
      "支持直接输入歌曲名 + 歌手名快速导入",
    ],
  },

  // ===== 全维度多源并发搜索 =====
  async search(query, page, type) {
    let userVars = {};
    try {
      if (typeof env !== "undefined" && env.getUserVariables) {
        userVars = env.getUserVariables() || {};
      }
    } catch (e) {}

    const sourceSetting = (userVars.searchSource || "all").toLowerCase();
    const showBadge = String(userVars.showBadge).toLowerCase() === "true";
    const pageNum = page && page > 0 ? page : 1;

    // A. 单曲搜索 (网易云, 酷我, QQ音乐, 酷狗 四平台并发检索并交叉混排)
    if (type === "music" || !type) {
      const list = await fetchMultiSourceData(query, pageNum, sourceSetting);
      const data = list.map(function (item) {
        const artistStr = item.artist || "未知歌手";
        const src = item.source || "netease";
        const artworkUrl = resolveArtworkUrlSync(item.pic_id, src);
        const sourceBadgeMap = {
          netease: "网易",
          kuwo: "酷我",
          tencent: "QQ",
          kugou: "酷狗",
        };
        const badge =
          showBadge && sourceBadgeMap[src] ? ` [${sourceBadgeMap[src]}]` : "";

        return {
          id: item.id,
          title: `${item.name || "未知歌名"}${badge}`,
          artist: artistStr,
          album: item.album || "",
          duration: item.duration || 0,
          artwork: artworkUrl,
          coverImg: artworkUrl,
          cover: artworkUrl,
          extra: {
            source: src,
            url_id: item.url_id || item.id,
            lyric_id: item.lyric_id || item.id,
            pic_id: item.pic_id,
            sourceRecords: item.sourceRecords || [],
          },
        };
      });
      return { isEnd: list.length < 8, data: data };
    }

    // B. 专辑搜索
    if (type === "album") {
      const list = await fetchMultiSourceData(query, pageNum, sourceSetting);
      const albumMap = new Map();
      for (const item of list) {
        const albumKey = `${item.source}_${item.artist}_${item.album}`;
        if (item.album && !albumMap.has(albumKey)) {
          const src = item.source || "netease";
          const cover = resolveArtworkUrlSync(item.pic_id, src);
          const sourceBadgeMap = {
            netease: "网易",
            kuwo: "酷我",
            tencent: "QQ",
            kugou: "酷狗",
          };
          const badge = sourceBadgeMap[src]
            ? ` [${sourceBadgeMap[src]}专辑]`
            : "";

          albumMap.set(albumKey, {
            id: albumKey,
            title: `${item.album}${badge}`,
            artist: item.artist || "未知歌手",
            artwork: cover,
            coverImg: cover,
            cover: cover,
            description: `专辑《${item.album}》 - ${item.artist || "未知歌手"}`,
            extra: { source: src, albumName: item.album },
          });
        }
      }
      return { isEnd: true, data: Array.from(albumMap.values()) };
    }

    // C. 歌手搜索
    if (type === "artist") {
      const list = await fetchMultiSourceData(query, pageNum, sourceSetting);
      const artistMap = new Map();
      for (const item of list) {
        const artists = item.artist ? item.artist.split(" / ") : ["未知歌手"];
        for (const art of artists) {
          if (art && !artistMap.has(art)) {
            const src = item.source || "netease";
            const cover = resolveArtworkUrlSync(item.pic_id, src);
            artistMap.set(art, {
              id: art,
              name: art,
              avatar: cover,
              artwork: cover,
              coverImg: cover,
              cover: cover,
              description: `歌手/音乐人 ${art}`,
              extra: { source: src, artistName: art },
            });
          }
        }
      }
      return { isEnd: true, data: Array.from(artistMap.values()) };
    }

    // D. 歌单四平台并发聚合搜索 (网易云, QQ音乐, 酷狗, 酷我)
    if (type === "sheet") {
      const pageSize = 12;

      const sheetPromises = [
        // 1. 网易云 (采用未加密的 v1 search API)
        (async function () {
          if (sourceSetting !== "all" && sourceSetting !== "netease") return [];
          try {
            const offset = (pageNum - 1) * pageSize;
            const neteaseSheetUrl = `https://music.163.com/api/v1/search/get?s=${encodeURIComponent(query)}&type=1000&offset=${offset}&limit=${pageSize}`;
            const res = await sheetSearchGet("netease", query, pageNum, function () {
              return axios.get(neteaseSheetUrl, {
                headers: DEFAULT_HEADERS,
                timeout: 4500,
              });
            }, { cacheKeyVariant: "netease-primary" });
            if (
              res &&
              res.data &&
              res.data.result &&
              res.data.result.playlists
            ) {
              return res.data.result.playlists.map(function (item) {
                const imgUrl = item.coverImgUrl
                  ? item.coverImgUrl.replace("http://", "https://")
                  : DEFAULT_COVERS[0];
                return {
                  id: `sheet_netease_${item.id}`,
                  title: cleanString(item.name),
                  artist: `网易云 · ${cleanString((item.creator && item.creator.nickname) || "精选")}`,
                  artwork: imgUrl,
                  coverImg: imgUrl,
                  cover: imgUrl,
                  description:
                    cleanString(item.description) ||
                    `包含 ${item.trackCount || 30} 首精选单曲`,
                  playCount: item.playCount || 100000,
                  worksNum: item.trackCount || 30,
                  extra: {
                    source: "netease",
                    playlistId: String(item.id),
                    query: cleanString(item.name),
                  },
                };
              });
            }
          } catch (e) {}
          return [];
        })(),

        // 2. QQ 音乐歌单搜索
        (async function () {
          if (sourceSetting !== "all" && sourceSetting !== "tencent") return [];
          try {
            const qqUrl = `https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?remoteplace=txt.yqq.playlist&page=${pageNum - 1}&num=${pageSize}&query=${encodeURIComponent(query)}&format=json`;
            const res = await sheetSearchGet("tencent", query, pageNum, function () {
              return axios.get(qqUrl, {
                headers: Object.assign({}, DEFAULT_HEADERS, { Referer: "https://y.qq.com/" }),
                timeout: 4500,
              });
            }, { cacheKeyVariant: "tencent-primary" });
            if (res && res.data && res.data.data && res.data.data.list) {
              return res.data.data.list.map(function (item) {
                const imgUrl = item.imgurl
                  ? item.imgurl.replace("http://", "https://")
                  : DEFAULT_COVERS[1];
                return {
                  id: `sheet_tencent_${item.dissid}`,
                  title: cleanString(item.dissname),
                  artist: `QQ音乐 · ${cleanString((item.creator && item.creator.name) || "精选")}`,
                  artwork: imgUrl,
                  coverImg: imgUrl,
                  cover: imgUrl,
                  description:
                    cleanString(item.introduction) ||
                    `播放量 ${item.listennum || 50000}`,
                  playCount: parseInt(item.listennum || 50000, 10),
                  worksNum: item.song_count || 30,
                  extra: {
                    source: "tencent",
                    playlistId: String(item.dissid),
                    query: cleanString(item.dissname),
                  },
                };
              });
            }
          } catch (e) {}
          return [];
        })(),

        // 3. 酷狗音乐歌单搜索
        (async function () {
          if (sourceSetting !== "all" && sourceSetting !== "kugou") return [];
          try {
            const kgUrl = `http://mobilecdn.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(query)}&page=${pageNum}&pagesize=${pageSize}`;
            const res = await sheetSearchGet("kugou", query, pageNum, function () {
              return axios.get(kgUrl, {
                headers: DEFAULT_HEADERS,
                timeout: 4500,
              });
            }, { cacheKeyVariant: "kugou-primary" });
            if (res && res.data && res.data.data && res.data.data.info) {
              return res.data.data.info.map(function (item) {
                let imgUrl = item.imgurl || item.user_avatar;
                if (imgUrl && typeof imgUrl === "string") {
                  imgUrl = imgUrl
                    .replace("{size}", "400")
                    .replace("http://", "https://");
                } else {
                  imgUrl = DEFAULT_COVERS[2];
                }
                return {
                  id: `sheet_kugou_${item.specialid}`,
                  title: cleanString(item.specialname),
                  artist: `酷狗 · ${cleanString(item.nickname || "精选")}`,
                  artwork: imgUrl,
                  coverImg: imgUrl,
                  cover: imgUrl,
                  description:
                    cleanString(item.intro) ||
                    `包含 ${item.songcount || 30} 首单曲`,
                  playCount: parseInt(item.playcount || 50000, 10),
                  worksNum: item.songcount || 30,
                  extra: {
                    source: "kugou",
                    playlistId: String(item.specialid),
                    query: cleanString(item.specialname),
                  },
                };
              });
            }
          } catch (e) {}
          return [];
        })(),

        // 4. 酷我音乐歌单搜索
        (async function () {
          if (sourceSetting !== "all" && sourceSetting !== "kuwo") return [];
          try {
            const kuwoSearchUrl = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&ft=playlist&itemset=ft&client=kt&pn=${pageNum - 1}&rn=${pageSize}&rformat=json&encoding=utf8`;
            const res = await sheetSearchGet("kuwo", query, pageNum, function () {
              return axios.get(kuwoSearchUrl, {
                headers: DEFAULT_HEADERS,
                timeout: 4500,
              });
            }, { cacheKeyVariant: "kuwo-primary" });
            const cleanText = (
              typeof res.data === "string" ? res.data : JSON.stringify(res.data)
            ).replace(/'/g, '"');
            const json = JSON.parse(cleanText);

            if (json && Array.isArray(json.abslist)) {
              return json.abslist.map(function (item) {
                let imgUrl = item.hts_pic || item.img || item.pic;
                if (imgUrl && typeof imgUrl === "string") {
                  imgUrl = imgUrl.replace("http://", "https://");
                } else {
                  imgUrl = DEFAULT_COVERS[0];
                }

                const rawTitle =
                  item.intro &&
                  item.intro.length > 2 &&
                  item.intro !== item.name
                    ? item.intro
                    : item.nickname
                      ? `${item.nickname} 的 ${query} 歌单`
                      : item.name;

                const realPlayCount = parseInt(
                  item.playcnt || item.playnum || 50000,
                  10,
                );
                const plId = String(item.playlistid || item.DC_TARGETID);

                return {
                  id: `sheet_kuwo_${plId}`,
                  title: cleanString(rawTitle),
                  artist: `酷我 · ${cleanString(item.nickname || "精选")}`,
                  artwork: imgUrl,
                  coverImg: imgUrl,
                  cover: imgUrl,
                  description:
                    cleanString(item.intro) ||
                    `包含 ${item.songnum || 30} 首精选单曲`,
                  playCount: realPlayCount,
                  worksNum: parseInt(item.songnum || "30", 10),
                  extra: {
                    source: "kuwo",
                    playlistId: plId,
                    query: cleanString(rawTitle),
                  },
                };
              });
            }
          } catch (e) {}
          return [];
        })(),
      ];

      const results = await allSettled(sheetPromises);
      const lists = results.map(function (r) {
        return r.status === "fulfilled" ? r.value : [];
      });

      const sheets = [];
      const maxLen = Math.max(
        ...lists.map(function (l) {
          return l.length;
        }),
        0,
      );
      for (let i = 0; i < maxLen; i++) {
        for (let j = 0; j < lists.length; j++) {
          if (lists[j][i]) {
            sheets.push(lists[j][i]);
          }
        }
      }

      if (pageNum === 1 && sheets.length > 0) {
        const tracks = await fetchMultiSourceData(query, 1, sourceSetting);
        if (tracks.length > 0) {
          const derivedWorksNum = tracks.length;
          const c1 = resolveArtworkUrlSync(
            tracks[0] && tracks[0].pic_id,
            tracks[0] && tracks[0].source,
          );
          const c2 = tracks[1]
            ? resolveArtworkUrlSync(tracks[1].pic_id, tracks[1].source)
            : c1;
          const c3 = tracks[2]
            ? resolveArtworkUrlSync(tracks[2].pic_id, tracks[2].source)
            : c1;

          sheets.unshift(
            {
              id: `sheet_derived_${encodeURIComponent(query)}_1`,
              title: `${query} · 聚合检索结果（第 1 组）`,
              artist: "多源聚合检索（非平台歌单）",
              artwork: c1,
              coverImg: c1,
              cover: c1,
              description: `基于“${query}”的多来源搜索结果，不代表实时榜单或平台排名`,
              playCount: 0,
              worksNum: derivedWorksNum,
              extra: {
                source: "all",
                query: query,
                derived: true,
                derivedFrom: "search",
              },
            },
            {
              id: `sheet_derived_${encodeURIComponent(query)}_2`,
              title: `${query} · 聚合检索结果（第 2 组）`,
              artist: "多源聚合检索（非平台歌单）",
              artwork: c2,
              coverImg: c2,
              cover: c2,
              description: `基于“${query}”的多来源搜索结果，不代表实时榜单或平台排名`,
              playCount: 0,
              worksNum: derivedWorksNum,
              extra: {
                source: "all",
                query: `${query} 相关`,
                derived: true,
                derivedFrom: "search",
              },
            },
            {
              id: `sheet_derived_${encodeURIComponent(query)}_3`,
              title: `${query} · 聚合检索结果（第 3 组）`,
              artist: "多源聚合检索（非平台歌单）",
              artwork: c3,
              coverImg: c3,
              cover: c3,
              description: `基于“${query}”的多来源搜索结果，不代表实时榜单或平台排名`,
              playCount: 0,
              worksNum: derivedWorksNum,
              extra: {
                source: "all",
                query: `${query} 延伸`,
                derived: true,
                derivedFrom: "search",
              },
            },
          );
        }
      }

      const totalFetched = lists.reduce(function (acc, curr) {
        return acc + curr.length;
      }, 0);
      return { isEnd: totalFetched < pageSize, data: sheets };
    }

    return { isEnd: true, data: [] };
  },

  // ===== 专辑详情 =====
  async getAlbumInfo(albumItem, page) {
    const query =
      cleanString(
        albumItem.title ? albumItem.title.replace(/\[.*?\]/g, "") : "",
      ) || albumItem.id;
    const res = await this.search(query, page, "music");
    return {
      isEnd: res.isEnd,
      musicList: res.data,
      albumItem: {
        title: albumItem.title,
        artwork: albumItem.artwork || DEFAULT_COVERS[0],
        coverImg: albumItem.artwork || DEFAULT_COVERS[0],
        description: `专辑《${albumItem.title}》全曲目`,
      },
    };
  },

  // ===== 歌手作品 =====
  async getArtistWorks(artistItem, page, type) {
    const query = artistItem.name || artistItem.id;
    const res = await this.search(query, page, type || "music");
    return {
      isEnd: res.isEnd,
      data: res.data,
    };
  },

  // ===== 歌单详情 (支持超大型网易云歌单全量 100~1000+ 首无遗漏提取) =====
  async getMusicSheetInfo(sheetItem, page) {
    const source = (sheetItem.extra && sheetItem.extra.source) || "netease";
    const playlistId =
      (sheetItem.extra && sheetItem.extra.playlistId) || sheetItem.id;
    const pageNum = page && page > 0 ? page : 1;

    // 页码大于 1 时优先返回已缓存的完整歌单 (按 60s TTL 分页)
    var detailCacheKey = source + "" + playlistId;
    if (pageNum > 1) {
      var cached = getPlaylistDetailCache(detailCacheKey);
      if (cached) {
        var pgSize = 30;
        var stIdx = (pageNum - 1) * pgSize;
        var pgdSongs = cached.musicList.slice(stIdx, stIdx + pgSize);
        return {
          isEnd: stIdx + pgSize >= cached.total,
          musicList: pgdSongs,
          sheetItem: cached.sheetItem,
        };
      }
    }

    // A. 网易云歌单 (基于 v6/playlist/detail 全量 trackIds 提取 + v3/song/detail 批量并发装载)
    if (
      (source === "netease" || source === "all") &&
      playlistId &&
      /^\d+$/.test(String(playlistId))
    ) {
      try {
        // 1. 优先尝试调用 v6/playlist/detail 获取包含全量歌曲 ID 的 trackIds 数组
        const v6Url = `https://music.163.com/api/v6/playlist/detail?id=${playlistId}`;
        const res = await sheetDetailGet("netease", playlistId, function () {
          return axios.get(v6Url, {
            headers: DEFAULT_HEADERS,
            timeout: 4500,
          });
        }, { cacheKeyVariant: "v6" });

        if (res && res.data && res.data.playlist) {
          const pl = res.data.playlist;
          let allRawSongs = pl.tracks || [];

          // 若包含全量 trackIds，且数量大于直接返回的 tracks，则进行分批补充拉取
          if (
            Array.isArray(pl.trackIds) &&
            pl.trackIds.length > allRawSongs.length
          ) {
            const trackIds = pl.trackIds;
            const missingIds = trackIds
              .slice(allRawSongs.length)
              .map(function (t) {
                return { id: t.id };
              });
            const batchSize = 100;

            // 控制最大补充抓取 500 首，确保响应流畅度
            const maxFetchIds = missingIds.slice(0, 500);
            const batchPromises = [];

            for (let i = 0; i < maxFetchIds.length; i += batchSize) {
              const chunk = maxFetchIds.slice(i, i + batchSize);
              const batchUrl = `https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(chunk))}`;
              const batchIndex = Math.floor(i / batchSize);
              batchPromises.push(
                sheetDetailGet("netease", playlistId + "-batch-" + batchIndex, function () {
                  return axios.get(batchUrl, {
                    headers: DEFAULT_HEADERS,
                    timeout: 5000,
                  });
                }, { cacheKeyVariant: "v3-batch" }),
              );
            }

            const batchResults = await allSettled(batchPromises);
            batchResults.forEach(function (bRes) {
              if (
                bRes.status === "fulfilled" &&
                bRes.value &&
                bRes.value.data &&
                Array.isArray(bRes.value.data.songs)
              ) {
                allRawSongs = allRawSongs.concat(bRes.value.data.songs);
              }
            });
          }

          const musicList = allRawSongs.map(function (item) {
            const artistStr = item.ar
              ? item.ar
                  .map(function (a) {
                    return cleanString(a.name);
                  })
                  .join(" / ")
              : item.artists
                ? item.artists
                    .map(function (a) {
                      return cleanString(a.name);
                    })
                    .join(" / ")
                : "未知歌手";

            const cover =
              item.al && item.al.picUrl
                ? item.al.picUrl.replace("http://", "https://")
                : item.album && item.album.picUrl
                  ? item.album.picUrl.replace("http://", "https://")
                  : DEFAULT_COVERS[0];

            const durationSec = item.dt
              ? Math.round(item.dt / 1000)
              : item.duration
                ? Math.round(item.duration / 1000)
                : 0;

            return {
              id: String(item.id),
              title: cleanString(item.name) || "未知歌名",
              artist: artistStr,
              album:
                cleanString(
                  (item.al && item.al.name) || (item.album && item.album.name),
                ) || "",
              duration: durationSec,
              artwork: cover,
              coverImg: cover,
              cover: cover,
              extra: {
                source: "netease",
                url_id: String(item.id),
                lyric_id: String(item.id),
              },
            };
          });

          var v6Total = musicList.length;
          var v6PageSize = 30;
          var v6StartIdx = (pageNum - 1) * v6PageSize;
          var v6Paged = musicList.slice(v6StartIdx, v6StartIdx + v6PageSize);

          var v6SheetItem = {
            title: cleanString(pl.name),
            artwork: pl.coverImgUrl
              ? pl.coverImgUrl.replace("http://", "https://")
              : DEFAULT_COVERS[0],
            coverImg: pl.coverImgUrl
              ? pl.coverImgUrl.replace("http://", "https://")
              : DEFAULT_COVERS[0],
            description:
              cleanString(pl.description) ||
              "歌单共包含 " + v6Total + " 首歌曲",
          };

          setPlaylistDetailCache(detailCacheKey, musicList, v6Total, v6SheetItem);

          return {
            isEnd: v6StartIdx + v6PageSize >= v6Total,
            musicList: v6Paged,
            sheetItem: v6SheetItem,
          };
        }
      } catch (e) {}

      // Fallback 到 v1 API (支持 offset/limit 分页参数)
      try {
        var v1Offset = (pageNum - 1) * 30;
        var v1Url = "https://music.163.com/api/playlist/detail?id=" + playlistId + "&offset=" + v1Offset + "&limit=30";
        var res = await sheetDetailGet("netease", playlistId, function () {
          return axios.get(v1Url, { headers: DEFAULT_HEADERS, timeout: 4500 });
        }, { cacheKeyVariant: "v1-offset-" + pageNum });
        if (res && res.data && res.data.result && res.data.result.tracks) {
          var tracks = res.data.result.tracks;
          var v1Total = res.data.result.trackCount || tracks.length;
          var v1PageSize = 30;
          var musicList = tracks.map(function (item) {
            var artistStr = item.artists
              ? item.artists
                  .map(function (a) {
                    return cleanString(a.name);
                  })
                  .join(" / ")
              : "未知歌手";
            var cover =
              item.album && item.album.picUrl
                ? item.album.picUrl.replace("http://", "https://")
                : DEFAULT_COVERS[0];
            var durationSec = item.duration
              ? Math.round(item.duration / 1000)
              : 0;

            return {
              id: String(item.id),
              title: cleanString(item.name) || "未知歌名",
              artist: artistStr,
              album: cleanString(item.album && item.album.name) || "",
              duration: durationSec,
              artwork: cover,
              coverImg: cover,
              cover: cover,
              extra: {
                source: "netease",
                url_id: String(item.id),
                lyric_id: String(item.id),
              },
            };
          });

          return {
            isEnd: v1Offset + v1PageSize >= v1Total,
            musicList: musicList,
            sheetItem: {
              description:
                cleanString(res.data.result.description) ||
                "歌单包含 " + tracks.length + " 首歌曲",
            },
          };
        }
      } catch (e) {}
    }

    // B. QQ 音乐歌单
    if (source === "tencent" && playlistId) {
      try {
        const qqPlUrl = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?g_tk=5381&disstid=${playlistId}&format=json`;
        const res = await sheetDetailGet("tencent", playlistId, function () {
          return axios.get(qqPlUrl, {
            headers: Object.assign({}, DEFAULT_HEADERS, { Referer: "https://y.qq.com/" }),
            timeout: 6000,
          });
        }, { cacheKeyVariant: "primary" });
        if (
          res &&
          res.data &&
          res.data.cdlist &&
          res.data.cdlist[0] &&
          res.data.cdlist[0].songlist
        ) {
          var tracks = res.data.cdlist[0].songlist;
          var musicList = tracks.map(function (item) {
            var artistStr = item.singer
              ? item.singer
                  .map(function (s) {
                    return cleanString(s.name);
                  })
                  .join(" / ")
              : "未知歌手";
            var cover = item.albummid
              ? "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + item.albummid + ".jpg"
              : DEFAULT_COVERS[1];

            return {
              id: String(item.songmid || item.songid),
              title: cleanString(item.songname),
              artist: artistStr,
              album: cleanString(item.albumname),
              duration: item.interval ? parseInt(item.interval, 10) : 0,
              artwork: cover,
              coverImg: cover,
              cover: cover,
              extra: {
                source: "tencent",
                url_id: String(item.songmid || item.songid),
                lyric_id: String(item.songmid || item.songid),
              },
            };
          });

          var qqTotal = musicList.length;
          var qqPageSize = 30;
          var qqStartIdx = (pageNum - 1) * qqPageSize;
          var qqPaged = musicList.slice(qqStartIdx, qqStartIdx + qqPageSize);

          var qqSheetItem = {
            description:
              cleanString(res.data.cdlist[0].desc) || "QQ 音乐精选歌单",
          };

          setPlaylistDetailCache(detailCacheKey, musicList, qqTotal, qqSheetItem);

          return {
            isEnd: qqStartIdx + qqPageSize >= qqTotal,
            musicList: qqPaged,
            sheetItem: qqSheetItem,
          };
        }
      } catch (e) {}
    }

    // C. 酷狗音乐歌单 (支持分页参数)
    if (source === "kugou" && playlistId) {
      try {
        var kgPageSize = 30;
        var kgPlUrl = "http://mobilecdn.kugou.com/api/v3/special/song?specialid=" + playlistId + "&page=" + pageNum + "&pagesize=" + kgPageSize;
        var res = await sheetDetailGet("kugou", playlistId, function () {
          return axios.get(kgPlUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 6000,
          });
        }, { cacheKeyVariant: "page-" + pageNum });
        if (res && res.data && res.data.data && res.data.data.info) {
          var tracks = res.data.data.info;
          var musicList = tracks.map(function (item) {
            var names = (item.filename || item.songname || "").split(" - ");
            var artistStr =
              names.length > 1 ? cleanString(names[0]) : "未知歌手";
            var songName =
              names.length > 1 ? cleanString(names[1]) : cleanString(names[0]);

            return {
              id: String(item.hash || item.audio_id),
              title: songName,
              artist: artistStr,
              album: "",
              duration: item.duration ? parseInt(item.duration, 10) : 0,
              artwork: DEFAULT_COVERS[2],
              coverImg: DEFAULT_COVERS[2],
              cover: DEFAULT_COVERS[2],
              extra: {
                source: "kugou",
                url_id: String(item.hash),
                lyric_id: String(item.hash),
              },
            };
          });

          return {
            isEnd: tracks.length < kgPageSize,
            musicList: musicList,
            sheetItem: {
              description: "酷狗音乐精选歌单",
            },
          };
        }
      } catch (e) {}
    }

    // D. 酷我与聚合歌单全量一次性拉取 (同时并发拉取 page 1 与 page 2，一次性返回 40 首全量曲目，并强制 isEnd: true)
    if (pageNum > 1) {
      return { isEnd: true, musicList: [] };
    }

    const query =
      (sheetItem.extra && sheetItem.extra.query) ||
      sheetItem.title ||
      sheetItem.id;
    const [res1, res2] = await Promise.all([
      this.search(query, 1, "music"),
      this.search(query, 2, "music"),
    ]);

    const combinedList = (res1.data || []).concat(res2.data || []);
    return {
      isEnd: true, // 强制设为 true，彻底消除 APP 界面底部的“加载更多”按钮
      musicList: combinedList,
      sheetItem: {
        title: sheetItem.title,
        artwork: sheetItem.artwork || DEFAULT_COVERS[0],
        coverImg: sheetItem.artwork || DEFAULT_COVERS[0],
        description: `歌单《${sheetItem.title}》精选曲目`,
      },
    };
  },

  // ===== 导入歌单 =====
  async importMusicSheet(urlLike) {
    if (!urlLike) return null;
    const cleanUrl = String(urlLike).trim();
    const neteaseMatch =
      cleanUrl.match(/playlist\?id=(\d+)/) || cleanUrl.match(/^(\d+)$/);
    if (neteaseMatch) {
      const res = await this.getMusicSheetInfo(
        {
          extra: { source: "netease", playlistId: neteaseMatch[1] },
          id: neteaseMatch[1],
        },
        1,
      );
      return res ? res.musicList : null;
    }
    const res = await this.search(cleanUrl, 1, "music");
    return res ? res.data : null;
  },

  // ===== 导入单曲 =====
  async importMusicItem(urlLike) {
    if (!urlLike) return null;
    const cleanUrl = String(urlLike).trim();
    const neteaseMatch =
      cleanUrl.match(/song\?id=(\d+)/) || cleanUrl.match(/^(\d+)$/);
    if (neteaseMatch) {
      const songs = await fetchMultiSourceData(neteaseMatch[1], 1, "netease");
      if (songs && songs[0]) {
        const item = songs[0];
        const artworkUrl = resolveArtworkUrlSync(item.pic_id, "netease");
        return {
          id: item.id,
          title: item.name,
          artist: item.artist,
          album: item.album,
          duration: item.duration,
          artwork: artworkUrl,
          coverImg: artworkUrl,
          cover: artworkUrl,
          extra: {
            source: "netease",
            url_id: item.url_id,
            lyric_id: item.lyric_id,
            pic_id: item.pic_id,
          },
        };
      }
    }
    const res = await this.search(cleanUrl, 1, "music");
    return res && res.data && res.data[0] ? res.data[0] : null;
  },

  // ===== 音频播放直链 =====
  async getMediaSource(musicItem, quality) {
    let userVars = {};
    try {
      if (typeof env !== "undefined" && env.getUserVariables) {
        userVars = env.getUserVariables() || {};
      }
    } catch (e) {}

    const url = await fetchMediaUrlFromEngines(musicItem, quality, userVars);
    return { url: url };
  },

  // ===== 歌词获取 =====
  async getLyric(musicItem) {
    const source = (musicItem.extra && musicItem.extra.source) || "netease";
    const lyricId =
      (musicItem.extra && musicItem.extra.lyric_id) || musicItem.id;

    if (source === "netease" || source === "all") {
      try {
        const res = await lyricGet("netease", "lyric-primary", lyricId, function () {
          return axios.get(
            `https://music.163.com/api/song/lyric?id=${lyricId}&lv=1&tv=1`,
            { headers: DEFAULT_HEADERS, timeout: 2200 },
          );
        }, function (response) {
          return !!(response && response.data && response.data.lrc && response.data.lrc.lyric);
        });
        if (res && res.data && res.data.lrc && res.data.lrc.lyric) {
          return {
            rawLrc: res.data.lrc.lyric,
            translation: (res.data.tlyric && res.data.tlyric.lyric) || "",
          };
        }
      } catch (e) {}
    }

    try {
      const apiSource =
        source === "tencent" || source === "kugou" ? "netease" : source;
      const res = await lyricGet(apiSource, "lyric-fallback", lyricId, function () {
        return axios.get(
          `https://music-api.gdstudio.xyz/api.php?types=lyric&id=${lyricId}&source=${apiSource}`,
          { headers: DEFAULT_HEADERS, timeout: 2200 },
        );
      }, function (response) {
        return !!(response && response.data && response.data.lyric);
      });
      if (res && res.data && res.data.lyric) {
        return {
          rawLrc: res.data.lyric || "",
          translation: res.data.tlyric || "",
        };
      }
    } catch (e) {}

    return { rawLrc: "" };
  },

  // ===== 歌曲信息获取 =====
  async getMusicInfo(musicItem) {
    if (musicItem.artwork && musicItem.artwork.indexOf("http") === 0) {
      return {
        artwork: musicItem.artwork,
        coverImg: musicItem.artwork,
        cover: musicItem.artwork,
      };
    }
    const src = (musicItem.extra && musicItem.extra.source) || "netease";
    const picId = (musicItem.extra && musicItem.extra.pic_id) || musicItem.id;
    const artworkUrl = resolveArtworkUrlSync(picId, src);
    return {
      artwork: artworkUrl,
      coverImg: artworkUrl,
      cover: artworkUrl,
    };
  },

  // ===== 多平台排行榜 =====
  async getTopLists() {
    return [
      {
        title: "网易云音乐榜单",
        data: [
          {
            id: "3778678",
            title: "网易云热歌榜",
            artwork: DEFAULT_COVERS[0],
            coverImg: DEFAULT_COVERS[0],
            cover: DEFAULT_COVERS[0],
            extra: { source: "netease", playlistId: "3778678" },
          },
          {
            id: "19723756",
            title: "网易云飙升榜",
            artwork: DEFAULT_COVERS[1],
            coverImg: DEFAULT_COVERS[1],
            cover: DEFAULT_COVERS[1],
            extra: { source: "netease", playlistId: "19723756" },
          },
        ],
      },
      {
        title: "QQ 音乐榜单",
        data: [
          {
            id: "qq_hot",
            title: "QQ 音乐热歌榜",
            artwork:
              "https://y.gtimg.cn/music/photo_new/T003R300x300M000003b30hZ3q2u1g.jpg",
            coverImg:
              "https://y.gtimg.cn/music/photo_new/T003R300x300M000003b30hZ3q2u1g.jpg",
            cover:
              "https://y.gtimg.cn/music/photo_new/T003R300x300M000003b30hZ3q2u1g.jpg",
            extra: { source: "tencent", query: "热歌" },
          },
        ],
      },
      {
        title: "酷我音乐榜单",
        data: [
          {
            id: "kuwo_hot",
            title: "酷我音乐热歌榜",
            artwork: "https://img2.kuwo.cn/star/albumcover/300/s400.jpg",
            coverImg: "https://img2.kuwo.cn/star/albumcover/300/s400.jpg",
            cover: "https://img2.kuwo.cn/star/albumcover/300/s400.jpg",
            extra: { source: "kuwo", query: "热歌" },
          },
        ],
      },
    ];
  },

  async getTopListDetail(topListItem, page) {
    return await this.getMusicSheetInfo(topListItem, page);
  },

  // ===== 热门推荐歌单 =====
  async getRecommendSheetTags() {
    return {
      pinned: [
        { id: "3778678", title: "全网热歌" },
        { id: "19723756", title: "飙升爆款" },
      ],
      data: [
        {
          title: "热门推荐",
          data: [
            { id: "3778678", title: "网易热歌榜" },
            { id: "19723756", title: "网易飙升榜" },
            { id: "kuwo_hot", title: "酷我热歌榜" },
            { id: "qq_hot", title: "QQ热歌榜" },
          ],
        },
      ],
    };
  },

  async getRecommendSheetsByTag(tag, page) {
    const sheets = [
      {
        id: "3778678",
        title: "网易云热歌榜 - 全网热播单曲合集",
        artwork: DEFAULT_COVERS[0],
        coverImg: DEFAULT_COVERS[0],
        cover: DEFAULT_COVERS[0],
        artist: "官方推荐",
        extra: { source: "netease", playlistId: "3778678" },
      },
      {
        id: "19723756",
        title: "网易云飙升榜 - 近期热度暴涨好歌",
        artwork: DEFAULT_COVERS[1],
        coverImg: DEFAULT_COVERS[1],
        cover: DEFAULT_COVERS[1],
        artist: "官方推荐",
        extra: { source: "netease", playlistId: "19723756" },
      },
    ];

    return {
      isEnd: true,
      data: sheets,
    };
  },
};
