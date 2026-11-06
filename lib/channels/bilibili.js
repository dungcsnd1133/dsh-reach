/**
 * Kênh `bilibili` — tìm kiếm video, đọc metadata video và bảng xếp hạng.
 *
 * Dùng API công khai `https://api.bilibili.com` theo cách `_bili_api` của bản
 * Python (`agent_reach/channels/bilibili.py`, MIT) làm: gửi kèm `Referer` và
 * `User-Agent` của trình duyệt. Kênh này **chỉ đọc**, không đăng nhập, không
 * ghi gì lên Bilibili.
 *
 * Bilibili chặn khá gắt. Trong môi trường kiểm thử, các endpoint cũ
 * (`/x/web-interface/search/type`, `/x/web-interface/view`) trả 412 nếu máy
 * khách chưa có cookie `buvid3`; vì vậy kênh làm hai việc:
 *
 *   1. "hâm" cookie ẩn danh bằng một lần GET trang chủ công khai
 *      (`buvid3`, `b_nut` — không phải cookie đăng nhập), giữ trong bộ nhớ;
 *   2. nếu endpoint cũ vẫn bị chặn, tự chuyển sang endpoint WBI tương ứng
 *      (`/x/web-interface/wbi/...`), vốn không đòi cookie.
 *
 * Chỉ khi cả hai đều thất bại mới báo `PLATFORM_BLOCKED` kèm thông điệp thật.
 *
 * @module dsh-reach/channels/bilibili
 */

import {
  BAD_INPUT,
  NEED_LOGIN,
  NOT_FOUND,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  ReachError,
  TIMEOUT,
  UPSTREAM_BROKEN,
  classify,
  hostMatches,
  httpRequest,
  makeItem,
  normalizePublicHttpUrl,
  unixToIso,
} from '../runtime.js';

/** User-Agent trình duyệt đầy đủ; Bilibili 412 nếu thiếu. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Header trình duyệt tối thiểu để Bilibili không coi là bot. */
const BROWSER_HEADERS = {
  'User-Agent': BROWSER_UA,
  Referer: 'https://www.bilibili.com/',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'application/json, text/plain, */*',
};

/** Regex BV id, giống `_BV_RE` của bản Python. */
const BV_RE = /BV[0-9A-Za-z]{10}/;

/** Chỉ giữ cookie ẩn danh do trang chủ đặt; tuyệt đối không gửi cookie đăng nhập. */
const ANON_COOKIE_RE = /^(buvid3|buvid4|b_nut|buvid_fp|b_lsid|_uuid|CURRENT_FNVAL)$/;

/** Thời gian sống của cookie ẩn danh trong bộ nhớ. */
const COOKIE_TTL_MS = 5 * 60 * 1000;

/** Số kết quả tối đa một trang tìm kiếm trả về. */
const SEARCH_PAGE_SIZE = 20;
/** `ps` tối đa mà `/x/web-interface/popular` chấp nhận. */
const POPULAR_MAX_PS = 50;

/** Cookie ẩn danh dùng lại giữa các lần gọi trong cùng tiến trình. */
let cookieCache = { jar: '', expiresAt: 0 };

/** Kẹp số nguyên vào khoảng [min, max]. */
function clamp(value, min, max) {
  const numeric = Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : min;
  return Math.min(max, Math.max(min, integer));
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/**
 * Giải mã entity HTML (`&amp;`, `&quot;`, `&#39;`, `&#x4e2d;`…).
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Bóc thẻ HTML (ví dụ `<em class="keyword">Python</em>`) rồi giải mã entity. */
function plainText(value) {
  if (value === null || value === undefined) return null;
  const stripped = String(value).replace(/<[^>]*>/g, '');
  const decoded = decodeEntities(stripped).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
  return decoded === '' ? null : decoded;
}

/** Đọc các cookie ẩn danh từ header `Set-Cookie`, không bao giờ lấy cookie đăng nhập. */
function anonymousCookies(headers) {
  const raw = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const kept = [];
  for (const line of raw) {
    const pair = String(line).split(';', 1)[0].trim();
    const name = pair.slice(0, pair.indexOf('='));
    if (ANON_COOKIE_RE.test(name)) kept.push(pair);
  }
  return kept.join('; ');
}

/**
 * Lấy cookie ẩn danh bằng một lần GET trang chủ Bilibili (công khai, không đăng nhập).
 * Lỗi mạng ở bước này không làm hỏng hành động: WBI vẫn dùng được không cookie.
 */
async function warmCookies(ctx) {
  if (cookieCache.jar !== '' && Date.now() < cookieCache.expiresAt) return cookieCache.jar;
  try {
    const home = await httpRequest('https://www.bilibili.com/', {
      headers: BROWSER_HEADERS,
      http: ctx.http,
      signal: ctx.signal,
    });
    const jar = anonymousCookies(home.headers);
    if (jar !== '') cookieCache = { jar, expiresAt: Date.now() + COOKIE_TTL_MS };
    return jar;
  } catch (error) {
    // Người gọi đã hủy: dừng hẳn, không đoán tiếp.
    if (ctx.signal?.aborted === true) {
      throw new ReachError(
        TIMEOUT,
        'tác vụ đã bị hủy trong lúc lấy cookie ẩn danh của Bilibili',
      );
    }
    // Trang chủ chậm/lỗi không chặn được đường WBI: vẫn thử tiếp không cookie.
    return cookieCache.jar;
  }
}

/** URL video dựng từ BV id. */
function videoUrl(bvid) {
  return typeof bvid === 'string' && BV_RE.test(bvid)
    ? 'https://www.bilibili.com/video/' + bvid
    : null;
}

/** Dựng một item từ object video của Bilibili (search / popular / view). */
function videoItem(video, text) {
  const source = video ?? {};
  const owner = source.owner ?? {};
  const description =
    typeof source.desc === 'string' && source.desc !== ''
      ? source.desc
      : typeof source.description === 'string'
        ? source.description
        : null;
  return makeItem({
    title: plainText(source.title),
    url: videoUrl(source.bvid),
    author: typeof owner.name === 'string' ? owner.name : (source.author ?? null),
    publishedAt: unixToIso(source.pubdate),
    text: text === undefined ? description : text,
    raw: {
      bvid: typeof source.bvid === 'string' ? source.bvid : null,
      aid: source.aid ?? null,
      duration: source.duration ?? null,
      stat: source.stat ?? null,
      play: source.play ?? null,
      tname: source.tname ?? source.typename ?? null,
    },
  });
}

/** Thông điệp chặn, nêu đúng mã HTTP quan sát được. */
function blockedMessage(status) {
  return (
    'Bilibili chặn yêu cầu bằng HTTP ' +
    status +
    ' (chống bot/risk control) nên không lấy được dữ liệu; hãy thử lại sau hoặc tự mở trình duyệt để xác minh.'
  );
}

/**
 * Một lần gọi API Bilibili, có áp mã lỗi thống nhất.
 *
 * @param {string} path đường dẫn bắt đầu bằng `/`
 * @param {object} ctx ngữ cảnh hành động
 * @param {string} cookieJar cookie ẩn danh (có thể rỗng)
 * @returns {Promise<object>} trường `data` của phản hồi
 */
async function requestOnce(path, ctx, cookieJar) {
  const headers = cookieJar === '' ? { ...BROWSER_HEADERS } : { ...BROWSER_HEADERS, Cookie: cookieJar };
  let response;
  try {
    response = await httpRequest('https://api.bilibili.com' + path, {
      headers,
      http: ctx.http,
      signal: ctx.signal,
    });
  } catch (error) {
    throw classify(error);
  }

  if (response.status === 412 || response.status === 403) {
    throw new ReachError(PLATFORM_BLOCKED, blockedMessage(response.status));
  }
  if (response.status === 429) {
    throw new ReachError(RATE_LIMITED, 'Bilibili báo giới hạn tần suất (HTTP 429)');
  }
  if (response.status >= 500) {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'Bilibili đang lỗi phía máy chủ (HTTP ' + response.status + ')',
    );
  }

  const body = response.body.trim();
  let payload;
  if (body.startsWith('{')) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
  }
  if (payload === null || payload === undefined) {
    // Bilibili trả trang HTML xác minh thay vì JSON — không bịa dữ liệu.
    throw new ReachError(
      PLATFORM_BLOCKED,
      'Bilibili trả về trang xác minh chống bot thay vì JSON (HTTP ' +
        response.status +
        '); không lấy được dữ liệu.',
    );
  }

  const code = Number(payload.code);
  const upstream = String(payload.message ?? '').slice(0, 200);
  if (code === 0) return payload.data ?? {};
  if (code === -404) {
    throw new ReachError(NOT_FOUND, 'không tìm thấy nội dung Bilibili này' + (upstream ? ': ' + upstream : ''));
  }
  if (code === -101) {
    throw new ReachError(
      NEED_LOGIN,
      'Bilibili yêu cầu đăng nhập cho yêu cầu này; kênh chỉ đọc nên không tự đăng nhập.',
    );
  }
  if (code === -412 || code === -352) {
    throw new ReachError(
      PLATFORM_BLOCKED,
      'Bilibili chặn yêu cầu (mã ' + code + (upstream ? ': ' + upstream : '') + ') do risk control.',
    );
  }
  if (code === -400) {
    throw new ReachError(BAD_INPUT, 'Bilibili từ chối tham số (mã -400' + (upstream ? ': ' + upstream : '') + ')');
  }
  throw new ReachError(
    UPSTREAM_BROKEN,
    'Bilibili API mã ' + payload.code + (upstream ? ': ' + upstream : ''),
  );
}

/**
 * Gọi lần lượt các đường dẫn dự phòng; chỉ chuyển tiếp khi endpoint bị chặn.
 * Lỗi đã hiểu (NOT_FOUND, BAD_INPUT, NEED_LOGIN…) dừng ngay.
 */
async function biliApi(paths, ctx) {
  const cookieJar = await warmCookies(ctx);
  let lastError = null;
  for (const path of paths) {
    try {
      return await requestOnce(path, ctx, cookieJar);
    } catch (error) {
      const failure = classify(error);
      lastError = failure;
      if (failure.code !== PLATFORM_BLOCKED) throw failure;
    }
  }
  throw lastError ?? new ReachError(UPSTREAM_BROKEN, 'Bilibili không phản hồi yêu cầu nào');
}

/**
 * Bóc BV id từ target: BV id trần, link bilibili.com/video/… hoặc link b23.tv.
 *
 * @param {string} target
 * @param {object} ctx
 * @returns {Promise<string>}
 */
async function parseTarget(target, ctx) {
  const text = String(target ?? '').trim();
  if (text === '') {
    throw new ReachError(BAD_INPUT, 'cần BV id hoặc link video Bilibili');
  }

  // Chuỗi chỉ là BV id: dùng thẳng, không cần đi qua URL.
  const looksLikeUrl = text.includes('://') || /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(text);
  const direct = BV_RE.exec(text);
  if (direct !== null && !looksLikeUrl) return direct[0];

  // URL người dùng nhập: bắt buộc qua normalizePublicHttpUrl và đúng tên miền.
  const url = normalizePublicHttpUrl(text);
  if (!hostMatches(url, 'bilibili.com', 'b23.tv')) {
    throw new ReachError(
      BAD_INPUT,
      'chỉ nhận BV id, link bilibili.com/video hoặc link rút gọn b23.tv',
    );
  }

  if (hostMatches(url, 'b23.tv')) {
    const resolved = await resolveShortLink(url, ctx);
    const match = BV_RE.exec(resolved);
    if (match !== null) return match[0];
    throw new ReachError(
      NOT_FOUND,
      'link b23.tv không dẫn tới video Bilibili nào: ' + resolved,
    );
  }

  const fromUrl = BV_RE.exec(url);
  if (fromUrl !== null) return fromUrl[0];

  throw new ReachError(
    BAD_INPUT,
    'link Bilibili không chứa BV id; hãy dùng link dạng bilibili.com/video/BV…',
  );
}

/** Đi theo chuyển hướng của link b23.tv để lấy URL cuối, rồi bóc BV id từ đó. */
async function resolveShortLink(url, ctx) {
  let finalUrl = '';
  try {
    const head = await httpRequest(url, {
      method: 'HEAD',
      headers: BROWSER_HEADERS,
      http: ctx.http,
      signal: ctx.signal,
    });
    finalUrl = head.url;
  } catch (error) {
    const failure = classify(error);
    if (failure.code !== UPSTREAM_BROKEN) throw failure;
  }
  if (!BV_RE.test(finalUrl)) {
    const response = await httpRequest(url, {
      headers: BROWSER_HEADERS,
      http: ctx.http,
      signal: ctx.signal,
    });
    finalUrl = response.url;
  }
  return finalUrl;
}

/** Đường dẫn tìm kiếm video cho endpoint cũ và endpoint WBI. */
function searchPaths(keyword) {
  const query = encodeURIComponent(keyword);
  return [
    '/x/web-interface/search/type?search_type=video&keyword=' + query + '&page=1',
    '/x/web-interface/wbi/search/type?search_type=video&keyword=' + query + '&page=1',
  ];
}

/** Đường dẫn metadata video cho endpoint cũ và endpoint WBI. */
function viewPaths(bvid) {
  const id = encodeURIComponent(bvid);
  return ['/x/web-interface/view?bvid=' + id, '/x/web-interface/wbi/view?bvid=' + id];
}

/** Một backend duy nhất `bilibili-api`; tự xử lý fallback nội bộ. */
function apiBackend(label, run) {
  return { label, run };
}

export const channel = {
  name: 'bilibili',
  description: 'Bilibili: tìm kiếm video, đọc metadata video và bảng xếp hạng thịnh hành (chỉ đọc)',
  level: 'default',

  /** Nhận URL của Bilibili và link rút gọn b23.tv. */
  canHandle(url) {
    return hostMatches(url, 'bilibili.com', 'b23.tv');
  },

  actions: {
    search: {
      description: 'Tìm kiếm video trên Bilibili theo từ khóa',
      params: {
        query: {
          type: 'string',
          required: true,
          description: 'nội dung cần tìm trên Bilibili',
        },
        limit: {
          type: 'integer',
          required: false,
          default: 5,
          description: 'số kết quả tối đa (1–20)',
        },
      },
      backends(ctx) {
        return [
          apiBackend('bilibili-api', async () => {
            const keyword = String(ctx.args.query ?? '').trim();
            if (keyword === '') {
              throw new ReachError(BAD_INPUT, 'tham số "query" không được để trống');
            }
            const limit = clamp(ctx.args.limit ?? 5, 1, SEARCH_PAGE_SIZE);
            const data = await biliApi(searchPaths(keyword), ctx);
            const results = Array.isArray(data.result) ? data.result : [];
            if (results.length === 0) {
              throw new ReachError(
                NOT_FOUND,
                'Bilibili không trả về video nào cho từ khóa "' + keyword + '"',
              );
            }
            return results.map((video) => videoItem(video)).slice(0, limit);
          }),
        ];
      },
    },

    read: {
      description: 'Đọc tiêu đề, tác giả, ngày đăng và mô tả một video Bilibili',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'BV id, link bilibili.com/video hoặc link rút gọn b23.tv',
        },
      },
      backends(ctx) {
        return [
          apiBackend('bilibili-api', async () => {
            const bvid = await parseTarget(ctx.args.target, ctx);
            const data = await biliApi(viewPaths(bvid), ctx);
            if (data === null || typeof data !== 'object' || typeof data.bvid !== 'string') {
              throw new ReachError(
                NOT_FOUND,
                'Bilibili không trả metadata cho video ' + bvid,
              );
            }
            return [videoItem(data)];
          }),
        ];
      },
    },

    hot: {
      description: 'Danh sách video thịnh hành trên Bilibili',
      params: {
        limit: {
          type: 'integer',
          required: false,
          default: 10,
          description: 'số video tối đa (1–50)',
        },
      },
      backends(ctx) {
        return [
          apiBackend('bilibili-api', async () => {
            const limit = clamp(ctx.args.limit ?? 10, 1, POPULAR_MAX_PS);
            const data = await biliApi(['/x/web-interface/popular?ps=' + limit + '&pn=1'], ctx);
            const list = Array.isArray(data.list) ? data.list : [];
            if (list.length === 0) {
              throw new ReachError(
                UPSTREAM_BROKEN,
                'Bilibili trả về bảng xếp hạng rỗng nên không có dữ liệu để hiển thị',
              );
            }
            return list.map((video) => videoItem(video)).slice(0, limit);
          }),
        ];
      },
    },

    subtitle: {
      description: 'Phụ đề video Bilibili — cần đăng nhập nên kênh chỉ đọc không lấy được',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'BV id hoặc link video Bilibili',
        },
      },
      backends(ctx) {
        return [
          apiBackend('bilibili-api', async () => {
            throw new ReachError(
              NEED_LOGIN,
              'Phụ đề Bilibili cần đăng nhập tài khoản. Kênh này chỉ đọc nên không tự đăng nhập: '
                + 'người dùng phải tự đăng nhập Bilibili trong trình duyệt rồi mới xem được phụ đề của '
                + String(ctx.args.target ?? '').trim()
                + '.',
            );
          }),
        ];
      },
    },
  },
};
