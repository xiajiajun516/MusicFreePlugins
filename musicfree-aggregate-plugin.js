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

  if (source === "netease") {
    if (picStr.indexOf("http") === 0)
      return picStr.replace("http://", "https://");
  }

  return DEFAULT_COVERS[0];
}

/**
 * Audius 曲目 → MusicFree 曲目条目（搜索与音乐人作品共用同一映射）
 */
function mapAudiusTrack(item) {
  const art =
    (item.artwork && (item.artwork["480x480"] || item.artwork["150x150"])) || "";
  return {
    id: String(item.id),
    name: cleanString(item.title),
    artist: cleanString(item.user && item.user.name) || "未知艺术家",
    album: "",
    source: "audius",
    url_id: String(item.id),
    lyric_id: String(item.id),
    pic_id: art,
    duration: item.duration ? parseInt(item.duration, 10) : 0,
  };
}

/**
 * Audius 曲目 → MusicFree 对外曲目条目（title/artwork/extra 形态，供歌手作品与歌单详情复用）
 */
function mapAudiusToMusicItem(item) {
  const t = mapAudiusTrack(item);
  const art = t.pic_id || DEFAULT_COVERS[0];
  return {
    id: t.id,
    title: t.name,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    artwork: art,
    coverImg: art,
    cover: art,
    extra: {
      source: "audius",
      url_id: t.url_id,
      lyric_id: t.lyric_id,
      pic_id: t.pic_id,
    },
  };
}

/**
 * 纯 JS MD5（RFC 1321）—— 插件运行时只允许 require("axios")，故自带实现，用于 B 站 wbi 签名
 * 输入按 UTF-8 编码，输出 32 位小写 hex。已与 node crypto 对拍 55/55 一致。
 */
const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_SINES = (function () {
  const table = [];
  for (let i = 0; i < 64; i++) {
    table.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  }
  return table;
})();

function md5Utf8Bytes(value) {
  const text = String(value === undefined || value === null ? "" : value);
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
  }
  return out;
}

function md5Hex(value) {
  const bytes = md5Utf8Bytes(value);
  const byteLen = bytes.length;
  const padLen = (((byteLen + 8) >> 6) << 6) + 64;
  const buf = [];
  for (let i = 0; i < padLen; i++) buf.push(0);
  for (let i = 0; i < byteLen; i++) buf[i] = bytes[i];
  buf[byteLen] = 0x80;
  const bitLenLo = (byteLen * 8) >>> 0;
  const bitLenHi = Math.floor(byteLen / 536870912);
  buf[padLen - 8] = bitLenLo & 255;
  buf[padLen - 7] = (bitLenLo >>> 8) & 255;
  buf[padLen - 6] = (bitLenLo >>> 16) & 255;
  buf[padLen - 5] = (bitLenLo >>> 24) & 255;
  buf[padLen - 4] = bitLenHi & 255;
  buf[padLen - 3] = (bitLenHi >>> 8) & 255;
  buf[padLen - 2] = (bitLenHi >>> 16) & 255;
  buf[padLen - 1] = (bitLenHi >>> 24) & 255;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = [];
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const base = offset + i * 4;
      words[i] = buf[base] | (buf[base + 1] << 8) | (buf[base + 2] << 16) | (buf[base + 3] << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const mixed = (f + a + MD5_SINES[i] + words[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((mixed << MD5_SHIFTS[i]) | (mixed >>> (32 - MD5_SHIFTS[i])))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const digest = [a0, b0, c0, d0];
  let hex = "";
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const byte = (digest[i] >>> (j * 8)) & 255;
      hex += (byte < 16 ? "0" : "") + byte.toString(16);
    }
  }
  return hex;
}

/**
 * ===== Bilibili（视频区）=====
 * 站内公开接口，无需登录；仅需匿名设备 cookie（x/frontend/finger/spi 下发）与 wbi 签名。
 */
const BILIBILI_REFERER = "https://www.bilibili.com/";
const BILIBILI_MIXIN_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const BILIBILI_NAV_TTL_MS = 30 * 60 * 1000;
const BILIBILI_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
// 结果里混有教程 / 鼓谱 / 讲解 / 合集等非歌曲内容，直接剔除，避免污染聚合结果
const BILIBILI_NOISE_PATTERN = /(教程|教学|鼓谱|吉他谱|曲谱|谱子|乐谱|附谱|伴奏|KTV|讲解|解说|reaction|合集|循环|铃声|教你)/;

function bilibiliHeaders(extra) {
  return Object.assign({
    "User-Agent": DEFAULT_HEADERS["User-Agent"],
    Referer: BILIBILI_REFERER,
    Accept: "application/json, text/plain, */*",
  }, extra || {});
}

function cleanBilibiliText(value) {
  const text = String(value === undefined || value === null ? "" : value).replace(/<[^>]*>/g, "");
  return cleanString(text);
}

function parseBilibiliDuration(raw) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!text) return 0;
  const parts = text.split(":");
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const value = parseInt(parts[i], 10);
    if (isNaN(value)) return 0;
    total = total * 60 + value;
  }
  return total;
}

/**
 * 匿名设备 cookie（非登录态）：buvid3 / buvid4 由 spi 接口匿名下发，缓存 12 小时
 */
async function getBilibiliCookie() {
  try {
    const res = await resilientGet("bilibili", "fingerprint", "bilibili\u0001fingerprint", function () {
      return axios.get("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: bilibiliHeaders(),
        timeout: 2500,
      });
    }, { ttlMs: BILIBILI_COOKIE_TTL_MS, maxAttempts: 1 });
    const data = res && res.data && res.data.data;
    if (!data || !data.b_3) return "";
    return (
      "buvid3=" + data.b_3 + "; buvid4=" + data.b_4 + "; b_nut=" +
      Math.floor(Date.now() / 1000) + "; CURRENT_FNVAL=4048"
    );
  } catch (e) {
    return "";
  }
}

/**
 * wbi mixinKey：imgKey+subKey 按固定表重排后取前 32 位；keys 每日轮换故只缓存 30 分钟
 */
async function getBilibiliMixinKey() {
  const res = await resilientGet("bilibili", "wbi-nav", "bilibili\u0001wbi-nav", function () {
    return axios.get("https://api.bilibili.com/x/web-interface/nav", {
      headers: bilibiliHeaders(),
      timeout: 2500,
    });
  }, { ttlMs: BILIBILI_NAV_TTL_MS, maxAttempts: 1 });
  const img = res && res.data && res.data.data && res.data.data.wbi_img;
  if (!img || !img.img_url || !img.sub_url) return "";
  const imgKey = String(img.img_url).split("/").pop().split(".")[0];
  const subKey = String(img.sub_url).split("/").pop().split(".")[0];
  const origin = imgKey + subKey;
  let key = "";
  for (let i = 0; i < BILIBILI_MIXIN_ORDER.length; i++) {
    key += origin.charAt(BILIBILI_MIXIN_ORDER[i]);
  }
  return key.slice(0, 32);
}

/**
 * wbi 签名（算法已用抓包值对拍 2/2 MATCH）：参数按 key 排序 → 值去 !'()* → w_rid = md5(query + mixinKey)
 */
function signBilibiliQuery(params, mixinKey) {
  const merged = {};
  for (const name in params) {
    if (Object.prototype.hasOwnProperty.call(params, name)) merged[name] = params[name];
  }
  merged.wts = Math.floor(Date.now() / 1000);
  const names = Object.keys(merged).sort();
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const value = String(merged[names[i]]).replace(/[!'()*]/g, "");
    parts.push(encodeURIComponent(names[i]) + "=" + encodeURIComponent(value));
  }
  const query = parts.join("&");
  return query + "&w_rid=" + md5Hex(query + mixinKey);
}

function isBilibiliNoise(item) {
  if (!item) return true;
  if (BILIBILI_NOISE_PATTERN.test(String(item.title || ""))) return true;
  const duration = parseBilibiliDuration(item.duration);
  if (duration > 0 && (duration < 30 || duration > 900)) return true;
  return false;
}

/**
 * Bilibili 视频条目 → 内部曲目形态（url_id = bvid，播放时再取 cid）
 */
function mapBilibiliTrack(item) {
  const pic = item && item.pic ? String(item.pic) : "";
  let artwork = "";
  if (pic) {
    artwork = pic.indexOf("//") === 0 ? "https:" + pic : pic.replace("http://", "https://");
  }
  return {
    id: String(item.bvid),
    name: cleanBilibiliText(item.title),
    artist: cleanBilibiliText(item.author) || "未知UP主",
    album: "",
    source: "bilibili",
    url_id: String(item.bvid),
    lyric_id: "",
    pic_id: artwork,
    duration: parseBilibiliDuration(item.duration),
  };
}

/**
 * 解析 Bilibili 播放地址：pagelist 取 cid → wbi 签名 playurl 取 DASH 音轨。
 * CDN 必须带 Referer（实测无 Referer 一律 403），故返回 headers 一并交给播放器。
 */
async function resolveBilibiliMedia(bvid) {
  const cookie = await getBilibiliCookie();
  const cookieHeader = cookie ? { Cookie: cookie } : null;
  const listRes = await mediaCoalesceGet("bilibili", "pagelist", "bvid:" + bvid, function () {
    return axios.get("https://api.bilibili.com/x/player/pagelist?bvid=" + encodeURIComponent(bvid), {
      headers: bilibiliHeaders(cookieHeader),
      timeout: 3500,
    });
  }, { maxAttempts: 1 });
  const pages = listRes && listRes.data && listRes.data.data;
  const cid = Array.isArray(pages) && pages[0] ? pages[0].cid : null;
  if (!cid) return null;

  const mixinKey = await getBilibiliMixinKey();
  if (!mixinKey) return null;
  const query = signBilibiliQuery({
    bvid: bvid,
    cid: cid,
    fnval: 16,
    qn: 80,
    fnver: 0,
    fourk: 1,
  }, mixinKey);

  const playRes = await mediaCoalesceGet("bilibili", "playurl", "bvid:" + bvid, function () {
    return axios.get("https://api.bilibili.com/x/player/wbi/playurl?" + query, {
      headers: bilibiliHeaders(cookieHeader),
      timeout: 4000,
    });
  }, { maxAttempts: 1 });
  const dash = playRes && playRes.data && playRes.data.data && playRes.data.data.dash;
  const audios = dash && Array.isArray(dash.audio) ? dash.audio.slice(0) : [];
  if (!audios.length) return null;
  audios.sort(function (a, b) { return (b.bandwidth || 0) - (a.bandwidth || 0); });
  const url = audios[0].baseUrl || (audios[0].backupUrl && audios[0].backupUrl[0]);
  if (!url) return null;
  return { url: url, headers: { Referer: BILIBILI_REFERER } };
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
    // 单方法 10s 沙箱上限下，某些串行多步流程（如 B 站取流）必须能显式关掉重试
    const maxAttempts = options && options.maxAttempts ? options.maxAttempts : 2;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        if (attempt + 1 < maxAttempts && isTransientRequestError(error)) {
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

function mediaCoalesceGet(source, operation, cohesiveKey, request, options) {
  return resilientGet(source, operation, getMediaRequestKey(source, operation, cohesiveKey), request, Object.assign({ ttlMs: 0, isCacheable: function () { return false; } }, options));
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
 * 多源并发检索单曲 (网易云, 酷我, Audius 并发聚合与交叉混排；受「启用来源」开关控制)
 */
/**
 * 方案 B：每个来源一个 true/false 开关（缺省 / 空值视为启用）。
 * MusicFree 的 userVariables 只有纯文本框，因此用 true/false 文本表达开关。
 */
function getEnabledSources() {
  const candidates = ["netease", "kuwo", "audius", "bilibili"];
  const keyMap = {
    netease: "enableNetease",
    kuwo: "enableKuwo",
    audius: "enableAudius",
    bilibili: "enableBilibili",
  };
  let vars = {};
  try {
    if (typeof env !== "undefined" && env.getUserVariables) {
      vars = env.getUserVariables() || {};
    }
  } catch (e) {}
  const enabled = candidates.filter(function (source) {
    const value = vars[keyMap[source]];
    if (value === undefined || value === null || value === "") return true;
    return !(
      value === false ||
      value === 0 ||
      value === "0" ||
      value === "false" ||
      value === "no" ||
      value === "off"
    );
  });
  // 全部关掉时兜底为全部启用，避免插件变成完全搜不到东西
  return enabled.length ? enabled : candidates;
}

/**
 * 某来源本次是否参与：同时受「默认搜索源模式」与「启用来源」开关约束
 */
function isSourceActive(sourceSetting, source) {
  if (getEnabledSources().indexOf(source) === -1) return false;
  const setting = (sourceSetting || "all").toLowerCase();
  return setting === "all" || setting === source;
}

async function fetchMultiSourceData(query, pageNum, sourceSetting) {
  const allSources = getEnabledSources();
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
            family: 4,
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

    // 5. Audius（去中心化音乐平台；公开 API 无鉴权，主流为独立/电子/嘻哈曲目，提供全长音频流）
    if (src === "audius") {
      try {
        const audiusOffset = (pageNum - 1) * pageSize;
        const audiusUrl = `https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=MusicFree&limit=${pageSize}&offset=${audiusOffset}`;
        const res = await searchMusicGet("audius", query, pageNum, function () {
          return axios.get(audiusUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 6000,
          });
        });
        const list = res && res.data && res.data.data;
        if (Array.isArray(list)) {
          return list
            .filter(function (item) {
              return item && item.is_streamable !== false;
            })
            .map(mapAudiusTrack);
        }
      } catch (e) {}
    }

    // 7. Bilibili（视频区；匿名 buvid cookie + wbi 签名，返回 AAC/MP4 音轨）
    if (src === "bilibili") {
      try {
        const bilibiliCookie = await getBilibiliCookie();
        const bilibiliUrl =
          "https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=" +
          encodeURIComponent(query) +
          "&page=" +
          pageNum;
        const res = await searchMusicGet("bilibili", query, pageNum, function () {
          return axios.get(bilibiliUrl, {
            headers: bilibiliHeaders(bilibiliCookie ? { Cookie: bilibiliCookie } : null),
            timeout: 5000,
          });
        });
        const list = res && res.data && res.data.data && res.data.data.result;
        if (!Array.isArray(list)) return [];
        return list
          .filter(function (item) {
            return item && item.bvid && !isBilibiliNoise(item);
          })
          .slice(0, pageSize)
          .map(mapBilibiliTrack);
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
async function fetchMediaUrlFromEngines(musicItem, quality, userVars, skipCrossSource) {
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

  // 2. 酷我音乐直链解析 (antiserver.kuwo.cn 官方 CDN 接口)
  if (source === "kuwo") {
    try {
      var rid = String(urlId).replace("MUSIC_", "");
      var kuwoDirectUrl = `https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=${rid}&format=mp3&response=url`;
      var kwRes = await mediaCoalesceGet(source, "kuwo-direct", source + "|" + urlId, function () {
        return axios.get(kuwoDirectUrl, {
          headers: DEFAULT_HEADERS,
          timeout: 4000,
          family: 4,
        });
      });
      if (kwRes && kwRes.data && kwRes.data.code === 200 && kwRes.data.url && typeof kwRes.data.url === "string" && kwRes.data.url.indexOf("http") === 0) {
        return kwRes.data.url;
      }
    } catch (e) {}
  }

  // 2a. Audius 直链解析：`/stream` 由服务端 302 到 CDN，直接交给播放器跟随，避免签名过期
  if (source === "audius" && urlId) {
    return `https://api.audius.co/v1/tracks/${encodeURIComponent(urlId)}/stream?app_name=MusicFree`;
  }

  // 2b. Bilibili：pagelist 取 cid → wbi 签名 playurl 取 DASH 音轨，并附 CDN 必需的 Referer
  if (source === "bilibili" && urlId) {
    const bilibiliBvid = String(urlId).split("|")[0];
    if (bilibiliBvid) {
      try {
        const resolved = await resolveBilibiliMedia(bilibiliBvid);
        if (resolved && resolved.url) return resolved;
      } catch (e) {}
    }
  }

  // 3. 仅调用能保留原始平台 ID 与 source 的解析端点；
  // 跨平台关键词/网易云回退没有返回曲目元数据，不能安全替代请求曲目。
  const engineApis = [
    `https://music-api.gdstudio.xyz/api.php?types=url&id=${urlId}&source=${source}&use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light`,
    `https://api.injahow.cn/meting/?type=url&id=${urlId}&server=${source}`,
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

  // 4. 跨源回退：同一曲目在其它平台再试一次。
  // 依据 search 阶段按「标题+歌手+时长分桶」合并出的 sourceRecords，元数据已匹配，不会串歌。
  if (!skipCrossSource) {
    const records = (musicItem.extra && musicItem.extra.sourceRecords) || [];
    for (const record of records) {
      if (!record || !record.source || record.source === source) continue;
      try {
        const altItem = {
          id: record.id,
          title: title,
          artist: artist,
          duration: record.duration || 0,
          extra: {
            source: record.source,
            url_id: record.url_id || record.id,
            lyric_id: record.lyric_id || record.id,
          },
        };
        const altUrl = await fetchMediaUrlFromEngines(altItem, quality, userVars, true);
        if (altUrl && typeof altUrl === "object" && altUrl.url) return altUrl;
        if (altUrl && typeof altUrl === "string" && altUrl.indexOf("http") === 0) {
          return altUrl;
        }
      } catch (e) {}
    }
  }

  // 5. 跨源检索回退：本平台解析不到时，用「歌名 + 首歌手」在可解析平台重新定位同一首。
  // 严格校验：归一化标题必须完全一致、歌手互相包含、时长差 <= 8 秒，避免串歌。
  if (!skipCrossSource && title) {
    const wanted = (title + " " + String(artist).split(" / ")[0]).trim();
    const matchTitle = title.toLowerCase().replace(/[\s\-_()（）\[\]]/g, "");
    const matchArtist = String(artist)
      .split(" / ")[0]
      .toLowerCase()
      .replace(/\s+/g, "");
    for (const altSource of ["netease", "kuwo"]) {
      if (altSource === source) continue;
      try {
        const altList = await fetchMultiSourceData(wanted, 1, altSource);
        for (const cand of altList) {
          const candTitle = cleanString(cand.name)
            .toLowerCase()
            .replace(/[\s\-_()（）\[\]]/g, "");
          const candArtist = cleanString(cand.artist).toLowerCase().replace(/\s+/g, "");
          if (!candTitle || candTitle !== matchTitle) continue;
          if (!candArtist || !matchArtist) continue;
          if (candArtist.indexOf(matchArtist) === -1 && matchArtist.indexOf(candArtist) === -1) continue;
          if (cand.duration && musicItem.duration && Math.abs(cand.duration - musicItem.duration) > 8) continue;
          const altItem = {
            id: cand.id,
            title: title,
            artist: artist,
            duration: cand.duration || 0,
            extra: {
              source: cand.source,
              url_id: cand.url_id || cand.id,
              lyric_id: cand.lyric_id || cand.id,
            },
          };
          const altUrl = await fetchMediaUrlFromEngines(altItem, quality, userVars, true);
          if (altUrl && typeof altUrl === "string" && altUrl.indexOf("http") === 0) {
            return altUrl;
          }
        }
      } catch (e) {}
    }
  }

  throw new Error(`所有解析引擎均未能获取 [${title} - ${artist}] 的音频直链`);
}

module.exports = {
  // ===== 必填规范属性 =====
  platform: "通用聚合音源",
  version: "4.1.1",
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
      hint: "all (按下方开关并发聚合，默认) / netease / kuwo / audius / bilibili",
    },
    {
      key: "enableNetease",
      name: "启用 网易云",
      title: "启用 网易云",
      hint: "true (默认启用) / false 关闭；仅在搜索源模式为 all 时生效",
    },
    {
      key: "enableKuwo",
      name: "启用 酷我",
      title: "启用 酷我",
      hint: "true (默认启用) / false 关闭；仅在搜索源模式为 all 时生效",
    },
    {
      key: "enableAudius",
      name: "启用 Audius",
      title: "启用 Audius",
      hint: "true (默认启用) / false 关闭；仅在搜索源模式为 all 时生效",
    },
    {
      key: "enableBilibili",
      name: "启用 Bilibili",
      title: "启用 Bilibili",
      hint: "true (默认启用) / false 关闭；仅在搜索源模式为 all 时生效",
    },
    {
      key: "showBadge",
      name: "显示平台标签后缀",
      title: "显示平台标签后缀",
      hint: "false (默认关闭，歌名保持干净) / true (在歌名后附加 [网易] [酷我] [Audius] [B站] 等后缀)",
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
      "支持粘贴单曲 ID（如网易云 186016 或酷我单曲 ID）",
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

    // A. 单曲搜索 (网易云, 酷我, Audius 并发检索并交叉混排)
    if (type === "music" || !type) {
      const list = await fetchMultiSourceData(query, pageNum, sourceSetting);
      const data = list.map(function (item) {
        const artistStr = item.artist || "未知歌手";
        const src = item.source || "netease";
        const artworkUrl = resolveArtworkUrlSync(item.pic_id, src);
        const sourceBadgeMap = {
          netease: "网易",
          kuwo: "酷我",
          audius: "Audius",
          bilibili: "B站",
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
            audius: "Audius",
            bilibili: "B站",
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
      const artistMap = new Map();

      // C0. Audius 音乐人：直接查用户库，拿官方头像与作品数（比从曲目反推更准）
      if (isSourceActive(sourceSetting, "audius")) {
        try {
          const audiusArtistOffset = (pageNum - 1) * 10;
          const audiusArtistUrl = `https://api.audius.co/v1/users/search?query=${encodeURIComponent(query)}&app_name=MusicFree&limit=10&offset=${audiusArtistOffset}`;
          const res = await searchMusicGet("audius", query, pageNum, function () {
            return axios.get(audiusArtistUrl, {
              headers: DEFAULT_HEADERS,
              timeout: 6000,
            });
          }, { cacheKeyVariant: "audius-artist" });
          const users = res && res.data && res.data.data;
          if (Array.isArray(users)) {
            users.forEach(function (u) {
              if (!u || !u.name) return;
              const av =
                (u.profile_picture &&
                  (u.profile_picture["480x480"] ||
                    u.profile_picture["150x150"])) ||
                DEFAULT_COVERS[0];
              artistMap.set(String(u.id), {
                id: `audius_artist_${u.id}`,
                name: cleanString(u.name),
                avatar: av,
                artwork: av,
                coverImg: av,
                cover: av,
                description: `Audius 音乐人 · ${u.track_count || 0} 首作品`,
                extra: {
                  source: "audius",
                  artistId: String(u.id),
                  artistName: cleanString(u.name),
                },
              });
            });
          }
        } catch (e) {}
      }

      const list = await fetchMultiSourceData(query, pageNum, sourceSetting);
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

    // D. 歌单并发聚合搜索 (网易云, 酷我, Audius)
    if (type === "sheet") {
      const pageSize = 12;

      const sheetPromises = [
        // 1. 网易云 (采用未加密的 v1 search API)
        (async function () {
          if (!isSourceActive(sourceSetting, "netease")) return [];
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

        // 4. 酷我音乐歌单搜索
        (async function () {
          if (!isSourceActive(sourceSetting, "kuwo")) return [];
          try {
            const kuwoSearchUrl = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&ft=playlist&itemset=ft&client=kt&pn=${pageNum - 1}&rn=${pageSize}&rformat=json&encoding=utf8`;
            const res = await sheetSearchGet("kuwo", query, pageNum, function () {
              return axios.get(kuwoSearchUrl, {
                headers: DEFAULT_HEADERS,
                timeout: 4500,
                family: 4,
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

        // 5. Audius 歌单
        (async function () {
          if (!isSourceActive(sourceSetting, "audius")) return [];
          try {
            const offset = (pageNum - 1) * pageSize;
            const audiusSheetUrl = `https://api.audius.co/v1/playlists/search?query=${encodeURIComponent(query)}&app_name=MusicFree&limit=${pageSize}&offset=${offset}`;
            const res = await sheetSearchGet("audius", query, pageNum, function () {
              return axios.get(audiusSheetUrl, {
                headers: DEFAULT_HEADERS,
                timeout: 6000,
              });
            }, { cacheKeyVariant: "audius-primary" });
            const list = res && res.data && res.data.data;
            if (Array.isArray(list)) {
              return list.map(function (item) {
                const img =
                  (item.artwork &&
                    (item.artwork["480x480"] || item.artwork["150x150"])) ||
                  DEFAULT_COVERS[0];
                const owner = cleanString(item.user && item.user.name) || "Audius";
                return {
                  id: `sheet_audius_${item.id}`,
                  title: cleanString(item.playlist_name),
                  artist: `Audius · ${owner}`,
                  artwork: img,
                  coverImg: img,
                  cover: img,
                  description:
                    cleanString(item.description) ||
                    `包含 ${item.track_count || 0} 首曲目`,
                  playCount: item.total_play_count || 0,
                  worksNum: item.track_count || 0,
                  extra: {
                    source: "audius",
                    playlistId: String(item.id),
                    query: cleanString(item.playlist_name),
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
    const artistSource = artistItem.extra && artistItem.extra.source;
    const artistId = artistItem.extra && artistItem.extra.artistId;

    // Audius 音乐人：按 user id 精确拉取作品，避免用名字模糊搜索串到同名艺人
    if (artistSource === "audius" && artistId) {
      try {
        const artistPage = page && page > 0 ? page : 1;
        const offset = (artistPage - 1) * 20;
        const audiusWorksUrl = `https://api.audius.co/v1/users/${encodeURIComponent(artistId)}/tracks?app_name=MusicFree&limit=20&offset=${offset}`;
        const res = await searchMusicGet("audius", "artist-works", artistPage, function () {
          return axios.get(audiusWorksUrl, {
            headers: DEFAULT_HEADERS,
            timeout: 6000,
          });
        }, { cacheKeyVariant: "audius-artist-works-" + artistId });
        const list = res && res.data && res.data.data;
        if (Array.isArray(list)) {
          const data = list
            .filter(function (item) {
              return item && item.is_streamable !== false;
            })
            .map(mapAudiusToMusicItem);
          return { isEnd: data.length < 20, data: data };
        }
      } catch (e) {}
    }

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

    // 页码大于 1 时: 全量已在第 1 页返回, 后续页返回空列表 + isEnd
    var detailCacheKey = source + "\u0001" + playlistId;
    if (pageNum > 1) {
      var cached = getPlaylistDetailCache(detailCacheKey);
      if (cached) {
        return {
          isEnd: true,
          musicList: [],
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

          // 第 1 页返回全量歌单; page>1 已在缓存检查中返回空
          if (pageNum === 1) {
            return {
              isEnd: true,
              musicList: musicList,
              sheetItem: v6SheetItem,
            };
          }
          return {
            isEnd: true,
            musicList: [],
          };
        }
      } catch (e) {}

      // Fallback 到 v1 API (内部迭代拉取全量曲目, 第 1 页返回全部)
      try {
        var v1AllTracks = [];
        var v1Total = 0;
        var v1Desc = "";
        var v1Limit = 30;
        var v1Offset = 0;
        var v1More = true;
        var v1GotResponse = false;

        while (v1More) {
          var v1Url = "https://music.163.com/api/playlist/detail?id=" + playlistId + "&offset=" + v1Offset + "&limit=" + v1Limit;
          var v1Res = await sheetDetailGet("netease", playlistId, function () {
            return axios.get(v1Url, { headers: DEFAULT_HEADERS, timeout: 4500 });
          }, { cacheKeyVariant: "v1-offset-" + v1Offset });

          if (v1Res && v1Res.data && v1Res.data.result && Array.isArray(v1Res.data.result.tracks)) {
            v1GotResponse = true;
            var v1Tracks = v1Res.data.result.tracks;
            v1Total = v1Res.data.result.trackCount || v1Tracks.length;
            v1Desc = cleanString(v1Res.data.result.description) || "";
            v1AllTracks = v1AllTracks.concat(v1Tracks);
            v1Offset += v1Limit;
            v1More = v1Offset < v1Total && v1Tracks.length === v1Limit;
          } else {
            v1More = false;
          }
        }

        if (v1GotResponse) {
          var musicList = v1AllTracks.map(function (item) {
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

          var v1SheetItem = {
            description: v1Desc || "歌单包含 " + v1AllTracks.length + " 首歌曲",
          };
          setPlaylistDetailCache(detailCacheKey, musicList, v1AllTracks.length, v1SheetItem);

          // 第 1 页返回全量; page>1 已在缓存检查中返回空
          if (pageNum === 1) {
            return {
              isEnd: true,
              musicList: musicList,
              sheetItem: v1SheetItem,
            };
          }
          return {
            isEnd: true,
            musicList: [],
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

    const resolved = await fetchMediaUrlFromEngines(musicItem, quality, userVars);
    // B 站等来源需要随直链下发请求头（CDN 无 Referer 会 403）
    if (resolved && typeof resolved === "object") {
      const result = { url: resolved.url };
      if (resolved.headers) result.headers = resolved.headers;
      return result;
    }
    return { url: resolved };
  },

  // ===== 歌词获取 =====
  async getLyric(musicItem) {
    const source = (musicItem.extra && musicItem.extra.source) || "netease";
    const lyricId =
      (musicItem.extra && musicItem.extra.lyric_id) || musicItem.id;

    // Bilibili 视频区无歌词接口，直接返回空歌词，不做无谓请求
    if (source === "bilibili") {
      return { rawLrc: "" };
    }

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
        source;
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
