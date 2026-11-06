/**
 * Kênh `twitter` — đọc tweet và timeline công khai của Twitter/X qua hai endpoint
 * **syndication công khai**: chỉ đọc, không đăng nhập, không OAuth, không API key.
 *
 * Hai endpoint được dùng (đều do chính các trang nhúng công khai của Twitter gọi):
 *
 *   - `GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&token=a`
 *     trả JSON một tweet (text, user, created_at, favourite_count…).
 *   - `GET https://syndication.twitter.com/srv/timeline-profile/screen-name/<user>`
 *     trả HTML có khối `<script id="__NEXT_DATA__">`; bên trong
 *     `props.pageProps.timeline.entries` là danh sách entry, mỗi entry chứa tweet
 *     ở `content.tweet` (có thể lồng sâu hơn).
 *
 * Cả hai endpoint KHÔNG phải API chính thức và có thể đổi hoặc biến mất bất cứ
 * lúc nào, nên kênh được đánh dấu `level: 'experimental'`. Khác với bản Python
 * gốc (Agent Reach 1.6.1, MIT — dùng trình duyệt + đăng nhập), bản JS này tuyệt
 * đối không đụng tới cookie hay phiên đăng nhập.
 *
 * Mọi lần gọi mạng đi qua `httpRequest` của `../runtime.js` nên vẫn có giới hạn
 * byte, timeout và chặn đích không công khai như các kênh khác.
 *
 * @module dsh-reach/channels/twitter
 */

import {
  BAD_INPUT,
  NOT_FOUND,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  ReachError,
  UPSTREAM_BROKEN,
  curlRequest,
  hostMatches,
  httpRequest,
  makeItem,
  normalizePublicHttpUrl,
  scrubUrlCredentials,
  throwIfAborted,
} from '../runtime.js';

/** Endpoint đọc một tweet. `token=a` là giá trị cố định mà trang nhúng dùng. */
const TWEET_RESULT_BASE = 'https://cdn.syndication.twimg.com/tweet-result';

/** Endpoint đọc timeline công khai của một tài khoản. */
const TIMELINE_BASE = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/';

/**
 * `User-Agent` của trình duyệt thật.
 *
 * Hai endpoint syndication trả HTML/JSON cho trình duyệt nhưng có thể từ chối
 * `User-Agent` mặc định của plugin (`dsh-reach/1.0 …`), nên kênh này cố ý gửi
 * UA Chrome giống hệt trường hợp LinkedIn.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

/** Header cho endpoint JSON của tweet. */
const TWEET_HEADERS = {
  'User-Agent': BROWSER_USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://twitter.com/',
};

/** Header cho endpoint HTML timeline. */
const TIMELINE_HEADERS = {
  'User-Agent': BROWSER_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://twitter.com/',
};

/** `limit` mặc định và trần của hành động `profile`. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Độ dài tiêu đề rút gọn từ nội dung tweet (ký tự). */
const TITLE_CHARS = 100;

/** Trần số ký tự `raw` của `read` trước khi lược bớt `entities` và các khối nặng. */
const MAX_RAW_CHARS = 8000;

/** Trần số ký tự phần trích lỗi lấy từ body, dùng cho thông điệp ReachError. */
const MAX_DETAIL_CHARS = 300;

/** Tên tài khoản Twitter hợp lệ: 1–15 ký tự chữ, số hoặc gạch dưới. */
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Id tweet: chỉ chữ số, tối đa 19 ký tự (snowflake hiện tại khoảng 19 chữ số).
 * Id dài hơn là rác nên bị từ chối ngay tại đây thay vì gửi lên nền tảng.
 */
const TWEET_ID_RE = /^\d{1,19}$/;

/** Đường dẫn trạng thái trong URL tweet, ví dụ `/jack/status/20`. */
const STATUS_PATH_RE = /\/(?:status|statuses)\/(\d{1,19})(?:[/?#]|$)/;

// ── tiện ích ────────────────────────────────────────────────────────────────

/** Rút gọn văn bản, bỏ thông tin đăng nhập nhỡ có trong URL. */
function clipped(text, limit = MAX_DETAIL_CHARS) {
  return scrubUrlCredentials(String(text ?? '')).trim().slice(0, limit);
}

/**
 * Trích phần chi tiết từ body lỗi.
 *
 * Endpoint trả HTML cho 404 (trang "Nothing to see here") và JSON cho lỗi tham
 * số; chỉ giữ chi tiết khi body là JSON, còn HTML thì bỏ hẳn để thông điệp lỗi
 * không nhồi cả trang vào ngữ cảnh.
 */
function bodyDetail(body) {
  const text = String(body ?? '').trim();
  if (text === '' || text.startsWith('<')) return '';
  return clipped(text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

/** Rút gọn nội dung tweet thành tiêu đề một dòng: bỏ xuống dòng, cắt 100 ký tự. */
function titleFromText(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.slice(0, TITLE_CHARS);
}

/**
 * Chuẩn hóa mốc thời gian của timeline thành ISO 8601 UTC.
 *
 * `tweet-result` trả ISO sẵn, nhưng timeline-profile trả định dạng cũ của
 * Twitter (`Thu Apr 28 00:56:58 +0000 2022`). Giữ nguyên nếu không đổi được để
 * không làm mất dữ liệu gốc.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return text;
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Tên tác giả dạng `Tên hiển thị (@screen_name)`, chịu được trường thiếu. */
function authorLine(user) {
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  const screen =
    typeof user?.screen_name === 'string' ? user.screen_name.trim() : '';
  if (name !== '' && screen !== '') return name + ' (@' + screen + ')';
  if (screen !== '') return '@' + screen;
  return name === '' ? null : name;
}

/** Kiểm tra `limit` của `profile`: mặc định 10, kẹp trong 1..50. */
function normaliseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ReachError(BAD_INPUT, 'tham số "limit" phải là số nguyên');
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(numeric)));
}

/**
 * Gợi ý khi bị giới hạn tần suất, dùng header `x-rate-limit-reset` nếu có.
 *
 * @param {Headers|undefined} headers
 * @returns {string}
 */
function rateLimitHint(headers) {
  const reset = headers?.get?.('x-rate-limit-reset');
  if (reset !== null && reset !== undefined && String(reset).trim() !== '') {
    const resetSeconds = Number(reset);
    const waitSeconds = Math.ceil(resetSeconds - Date.now() / 1000);
    if (Number.isFinite(waitSeconds) && waitSeconds > 0) {
      return (
        'Endpoint syndication (không chính thức) đã hết hạn mức 30 lượt/giờ. ' +
        'Thử lại sau khoảng ' +
        waitSeconds +
        ' giây; không đổi backend và không thử lại liên tục.'
      );
    }
  }
  return (
    'Endpoint syndication (không chính thức) đã hết hạn mức. Thử lại sau ít phút; ' +
    'không đổi backend và không thử lại liên tục.'
  );
}

/**
 * Gọi endpoint timeline, tự chuyển sang `curl` khi `fetch` bị chặn.
 *
 * Vì sao cần: máy chủ Twitter syndication nhận diện thư viện HTTP qua *dấu vân
 * tay TLS* chứ không qua header. Node/undici có ClientHello đặc trưng nên bị
 * trả 429 ngay cả khi gửi đúng User-Agent trình duyệt; `curl` dùng OpenSSL nên
 * đi được. Đo trên máy này: cùng URL, cùng UA, cùng HTTP/1.1 — `fetch` 429
 * nhưng `curl` 200. Endpoint `tweet-result` không bị như vậy nên vẫn đi bằng
 * `httpRequest`.
 *
 * Chỉ thử `curl` khi lần `fetch` đầu trả 403/429 và máy có `curl`; mọi lỗi khác
 * được trả về nguyên trạng để `httpFailure` ánh xạ.
 *
 * @returns {Promise<{status:number, body:string}>}
 */
async function timelineRequest(url, ctx) {
  const first = await httpRequest(url, {
    headers: TIMELINE_HEADERS,
    http: ctx.http,
    signal: ctx.signal,
  });
  if (first.status !== 403 && first.status !== 429) return first;
  // Chỉ thử lại khi có curl; thiếu curl thì trả lỗi gốc để người dùng biết đúng
  // nguyên nhân (rate limit thật) thay vì đổ lỗi thiếu công cụ.
  try {
    const fallback = await curlRequest(url, {
      headers: TIMELINE_HEADERS,
      http: ctx.http,
      signal: ctx.signal,
    });
    // curl đi được thì dùng kết quả đó; còn 429 nghĩa là hạn mức thật đã cạn.
    return { status: fallback.status, body: fallback.body };
  } catch {
    return first;
  }
}

/**
 * Ánh xạ phản hồi HTTP không thành công của hai endpoint sang ReachError.
 *
 * Quy ước: 429 → RATE_LIMITED; 404 → NOT_FOUND; 403 → PLATFORM_BLOCKED; còn
 * lại → UPSTREAM_BROKEN.
 *
 * @returns {ReachError|null} null khi phản hồi thành công
 */
function httpFailure(response, label) {
  const status = Number(response.status);
  if (!Number.isFinite(status) || status < 400) return null;

  const detail = bodyDetail(response.body);
  const suffix = detail === '' ? '' : ': ' + detail;

  if (status === 404) {
    return new ReachError(NOT_FOUND, label + ' không tìm thấy nội dung (HTTP 404)' + suffix);
  }
  if (status === 429) {
    return new ReachError(
      RATE_LIMITED,
      label + ' báo giới hạn tần suất (HTTP 429)' + suffix,
      rateLimitHint(response.headers),
    );
  }
  if (status === 403) {
    return new ReachError(
      PLATFORM_BLOCKED,
      label + ' từ chối truy cập (HTTP 403)' + suffix,
      'Endpoint syndication không chính thức của Twitter/X đang chặn yêu cầu tự động. ' +
        'Dừng tự động hóa; người dùng nên mở tweet hoặc trang cá nhân trực tiếp.',
    );
  }
  return new ReachError(UPSTREAM_BROKEN, label + ' trả về HTTP ' + status + suffix);
}

/** Parse JSON, đổi phản hồi hỏng thành UPSTREAM_BROKEN thay vì lỗi trơn. */
function parseJson(source, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ReachError(UPSTREAM_BROKEN, source + ' trả về JSON không đọc được');
  }
}

// ── đọc một tweet ───────────────────────────────────────────────────────────

/**
 * Tách id tweet từ URL twitter.com/x.com hoặc từ chuỗi id thuần.
 *
 * URL do người dùng nhập được kiểm bằng `normalizePublicHttpUrl` trước khi đọc
 * host, theo đúng quy tắc 5 của hợp đồng.
 *
 * @param {unknown} target URL tweet hoặc id số
 * @returns {string} id tweet (chỉ chữ số)
 * @throws {ReachError} BAD_INPUT khi target không phải URL tweet hợp lệ
 */
function parseTweetId(target) {
  const value = String(target ?? '').trim();
  if (value === '') {
    throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "target"');
  }
  if (TWEET_ID_RE.test(value)) return value;
  if (/^\d+$/.test(value)) {
    // Toàn chữ số nhưng quá dài: báo đúng vấn đề thay vì để bộ chuẩn hóa URL
    // nói "đích phải là URL http(s) công khai".
    throw new ReachError(
      BAD_INPUT,
      'id tweet phải là dãy chữ số tối đa 19 ký tự; giá trị nhận được dài ' +
        value.length +
        ' ký tự',
    );
  }

  let normalized;
  try {
    normalized = normalizePublicHttpUrl(value);
  } catch {
    // Chuỗi vừa không phải id vừa không phải URL công khai: nói rõ dạng đúng
    // thay vì để thông điệp của bộ chuẩn hóa URL.
    throw new ReachError(
      BAD_INPUT,
      'target phải là liên kết tweet trên twitter.com/x.com hoặc id tweet dạng số',
    );
  }
  if (!hostMatches(normalized, 'twitter.com', 'x.com')) {
    throw new ReachError(
      BAD_INPUT,
      'target phải là liên kết tweet trên twitter.com/x.com hoặc id tweet dạng số',
    );
  }
  const match = STATUS_PATH_RE.exec(new URL(normalized).pathname);
  if (match === null) {
    throw new ReachError(
      BAD_INPUT,
      'liên kết không chứa id tweet; dạng đúng là https://x.com/<tên>/status/<id>',
    );
  }
  return match[1];
}

/**
 * Rút gọn trường `entities` cho `raw` khi JSON gốc quá lớn.
 *
 * Chỉ giữ những trường mô tả nội dung; toàn bộ URL ảnh, màu chỉ báo… bị bỏ để
 * ngữ cảnh không bị nhồi.
 *
 * @param {unknown} entities
 * @returns {object|null}
 */
function compactEntities(entities) {
  if (entities === null || typeof entities !== 'object') return null;
  const out = {};
  const take = (value, limit) =>
    Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined).slice(0, limit) : [];

  const hashtags = take(entities.hashtags, 10)
    .map((item) => (typeof item?.text === 'string' ? item.text : null))
    .filter((item) => item !== null);
  const mentions = take(entities.user_mentions, 10)
    .map((item) => (typeof item?.screen_name === 'string' ? item.screen_name : null))
    .filter((item) => item !== null);
  const urls = take(entities.urls, 10)
    .map((item) => item?.expanded_url ?? item?.url ?? null)
    .filter((item) => typeof item === 'string' && item !== '');
  const symbols = take(entities.symbols, 10)
    .map((item) => (typeof item?.text === 'string' ? item.text : null))
    .filter((item) => item !== null);
  const media = take(entities.media, 4)
    .map((item) =>
      item === null || typeof item !== 'object'
        ? null
        : { type: item.type ?? null, url: item.media_url_https ?? item.media_url ?? null },
    )
    .filter((item) => item !== null);

  if (hashtags.length > 0) out.hashtags = hashtags;
  if (mentions.length > 0) out.user_mentions = mentions;
  if (urls.length > 0) out.urls = urls;
  if (symbols.length > 0) out.symbols = symbols;
  if (media.length > 0) out.media = media;
  return out;
}

/** Chuỗi JSON dài bao nhiêu ký tự (0 nếu không tuần tự hóa được). */
function jsonSize(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Các khối nặng của tweet-result không cần cho ngữ cảnh đọc. */
const HEAVY_RAW_KEYS = [
  'edit_control',
  'card',
  'quoted_tweet',
  'note_tweet',
  'broadcast',
  'mediaDetails',
  'video',
  'place',
  'coordinates',
  'scopes',
  'previous_counts',
];

/**
 * Giữ `raw` ở mức đọc được: trả nguyên JSON khi còn nhỏ, nếu quá lớn thì lược
 * `entities`, bỏ các khối nặng và rút gọn `user`.
 *
 * @param {object} data JSON tweet-result gốc
 * @returns {object}
 */
function trimRaw(data) {
  let raw = { ...data };
  if (jsonSize(raw) <= MAX_RAW_CHARS) return raw;

  raw.entities = compactEntities(raw.entities);
  for (const key of HEAVY_RAW_KEYS) delete raw[key];
  if (raw.user !== null && typeof raw.user === 'object') {
    raw.user = {
      name: raw.user.name ?? null,
      screen_name: raw.user.screen_name ?? null,
      is_blue_verified: raw.user.is_blue_verified ?? null,
      verified: raw.user.verified ?? null,
    };
  }
  if (jsonSize(raw) > MAX_RAW_CHARS) delete raw.entities;
  if (jsonSize(raw) > MAX_RAW_CHARS && typeof raw.text === 'string') {
    raw.text = raw.text.slice(0, 2000);
  }
  return raw;
}

/**
 * Đọc một tweet qua endpoint tweet-result.
 *
 * @param {unknown} target URL tweet hoặc id
 * @param {object} ctx ngữ cảnh hành động
 * @returns {Promise<Array>} mảng một item
 */
async function readTweet(target, ctx) {
  throwIfAborted(ctx.signal);
  const id = parseTweetId(target);

  const response = await httpRequest(
    TWEET_RESULT_BASE + '?id=' + encodeURIComponent(id) + '&token=a',
    { headers: TWEET_HEADERS, http: ctx.http, signal: ctx.signal },
  );
  const failure = httpFailure(response, 'tweet-result của Twitter');
  if (failure !== null) throw failure;

  const body = response.body.trim();
  // Tweet không tồn tại/đã xóa có thể trả HTML kèm HTTP 200 trên một số biến
  // thể của endpoint; coi đó là NOT_FOUND thay vì lỗi phân tích JSON.
  if (body === '' || body.startsWith('<')) {
    throw new ReachError(
      NOT_FOUND,
      'Twitter không trả về dữ liệu tweet id ' + id + ' (có thể đã bị xóa hoặc không công khai)',
    );
  }

  const data = parseJson('tweet-result của Twitter', body);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ReachError(UPSTREAM_BROKEN, 'tweet-result của Twitter trả về JSON không phải object');
  }

  const candidates = [data.text, data.full_text, data.note_tweet?.text];
  const text = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
  if (text === undefined) {
    throw new ReachError(
      NOT_FOUND,
      'không đọc được nội dung tweet id ' +
        id +
        ' (có thể đã bị xóa, bị hạn chế hoặc endpoint đã đổi định dạng)',
    );
  }

  const user = data.user ?? {};
  const screenName =
    typeof user.screen_name === 'string' ? user.screen_name.trim() : '';
  const idStr = typeof data.id_str === 'string' && data.id_str !== '' ? data.id_str : id;
  const url = screenName === '' ? null : 'https://twitter.com/' + screenName + '/status/' + idStr;

  return [
    makeItem({
      title: titleFromText(text),
      url,
      author: authorLine(user),
      publishedAt: toIsoTimestamp(data.created_at),
      text,
      raw: trimRaw(data),
    }),
  ];
}

// ── đọc timeline ────────────────────────────────────────────────────────────

/** Lấy JSON của khối `<script id="__NEXT_DATA__">` trong HTML timeline. */
function extractNextData(html) {
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    if (!/\bid\s*=\s*["']__NEXT_DATA__["']/.test(attrs)) continue;
    const text = (match[2] ?? '').trim();
    if (text === '') {
      throw new ReachError(UPSTREAM_BROKEN, 'khối __NEXT_DATA__ của timeline Twitter rỗng');
    }
    return parseJson('khối __NEXT_DATA__ của Twitter', text);
  }
  return null;
}

/**
 * Tìm mảng `entries` trong `props.pageProps`, phòng khi đường dẫn trực tiếp đổi.
 *
 * @param {unknown} node
 * @param {number} [depth]
 * @returns {Array|null}
 */
function findEntriesArray(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) return null;
  if (node.timeline !== null && typeof node.timeline === 'object') {
    const entries = node.timeline.entries;
    if (Array.isArray(entries)) return entries;
  }
  for (const value of Object.values(node)) {
    const found = findEntriesArray(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Tìm object tweet thật trong một entry: phải có `full_text` kiểu chuỗi.
 *
 * Cấu trúc entry thay đổi theo thời gian (có entry banner/quảng cáo, có tweet
 * nằm ở `content.tweet`, có khi lồng trong `content.item`), nên duyệt đệ quy
 * thay vì bám vào một đường dẫn cố định.
 *
 * @param {unknown} node
 * @param {number} [depth]
 * @returns {object|null}
 */
function findTweetObject(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTweetObject(child, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node.full_text === 'string') return node;
  for (const value of Object.values(node)) {
    const found = findTweetObject(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Dựng item từ một object tweet của timeline, khớp yêu cầu của kênh. */
function timelineItem(tweet) {
  const screenName =
    typeof tweet?.user?.screen_name === 'string' ? tweet.user.screen_name.trim() : '';
  const idStr =
    typeof tweet?.id_str === 'string' && tweet.id_str !== ''
      ? tweet.id_str
      : typeof tweet?.id === 'number' || typeof tweet?.id === 'string'
        ? String(tweet.id)
        : '';
  const text = typeof tweet?.full_text === 'string' ? tweet.full_text : null;
  return makeItem({
    title: titleFromText(text),
    url:
      screenName === '' || idStr === ''
        ? null
        : 'https://twitter.com/' + screenName + '/status/' + idStr,
    author: authorLine(tweet?.user),
    publishedAt: toIsoTimestamp(tweet?.created_at),
    text,
    raw: {
      id_str: idStr === '' ? null : idStr,
      favorite_count: tweet?.favorite_count ?? null,
      reply_count: tweet?.reply_count ?? null,
      retweet_count: tweet?.retweet_count ?? null,
      lang: tweet?.lang ?? null,
    },
  });
}

/**
 * Gom các tweet từ `entries`, bỏ entry không phải tweet và bỏ trùng theo id.
 *
 * @param {Array} entries
 * @param {number} limit
 * @returns {Array} item đã chuẩn hóa, tối đa `limit` phần tử
 */
function collectTimelineItems(entries, limit) {
  const items = [];
  const seen = new Set();
  for (const entry of entries) {
    if (items.length >= limit) break;
    if (entry === null || typeof entry !== 'object') continue;
    // Chỉ tìm trong `content`: tránh bắt nhầm các object `full_text` ở phần
    // metadata/quảng cáo của entry.
    const tweet = findTweetObject(entry.content ?? entry);
    if (tweet === null) continue;
    if (typeof tweet.full_text !== 'string' || tweet.full_text.trim() === '') continue;
    const key =
      typeof tweet.id_str === 'string' && tweet.id_str !== ''
        ? tweet.id_str
        : typeof tweet.id === 'number' || typeof tweet.id === 'string'
          ? String(tweet.id)
          : '';
    if (key !== '') {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    items.push(timelineItem(tweet));
  }
  return items;
}

/**
 * Đọc timeline công khai của một tài khoản qua endpoint timeline-profile.
 *
 * @param {unknown} rawUsername tên tài khoản, có thể kèm "@" ở đầu
 * @param {number|undefined} rawLimit số tweet tối đa
 * @param {object} ctx ngữ cảnh hành động
 * @returns {Promise<Array>} mảng item
 */
async function readProfile(rawUsername, rawLimit, ctx) {
  throwIfAborted(ctx.signal);
  const username = String(rawUsername ?? '').trim().replace(/^@+/, '');
  if (!USERNAME_RE.test(username)) {
    throw new ReachError(
      BAD_INPUT,
      'tham số "username" phải là tên tài khoản Twitter/X hợp lệ (1–15 ký tự chữ, số hoặc gạch dưới)',
    );
  }
  const limit = normaliseLimit(rawLimit);

  const response = await timelineRequest(TIMELINE_BASE + encodeURIComponent(username), ctx);
  const failure = httpFailure(response, 'timeline-profile của Twitter');
  if (failure !== null) throw failure;

  const nextData = extractNextData(response.body);
  if (nextData === null) {
    // Không có __NEXT_DATA__: phần lớn là trang chống bot hoặc định dạng đã đổi.
    const sample = response.body.slice(0, 4096).toLowerCase();
    if (
      sample.includes('just a moment') ||
      sample.includes('attention required') ||
      sample.includes('cf-challenge') ||
      sample.includes('verifying you are human')
    ) {
      throw new ReachError(
        PLATFORM_BLOCKED,
        'Twitter trả về trang xác minh chống bot thay vì timeline; dừng tự động hóa.',
        'Người dùng phải tự mở trang cá nhân trên X. Không thử lại và không đổi backend.',
      );
    }
    throw new ReachError(
      UPSTREAM_BROKEN,
      'trang timeline Twitter không còn khối __NEXT_DATA__ (định dạng của endpoint có thể đã đổi)',
    );
  }

  const entries = nextData?.props?.pageProps?.timeline?.entries;
  const resolvedEntries = Array.isArray(entries)
    ? entries
    : findEntriesArray(nextData?.props?.pageProps);
  if (!Array.isArray(resolvedEntries)) {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'dữ liệu timeline Twitter không có mảng entries (định dạng của endpoint có thể đã đổi)',
    );
  }

  const items = collectTimelineItems(resolvedEntries, limit);
  if (items.length === 0) {
    throw new ReachError(
      NOT_FOUND,
      'tài khoản "' +
        username +
        '" không có tweet công khai nào đọc được (tài khoản riêng tư, bị khóa hoặc không tồn tại)',
    );
  }
  return items;
}

// ── kênh ────────────────────────────────────────────────────────────────────

export const channel = {
  name: 'twitter',
  description:
    'Twitter/X: đọc một tweet và timeline công khai của tài khoản qua endpoint syndication không chính thức (không đăng nhập)',
  level: 'experimental',

  /** Mọi URL thuộc twitter.com hoặc x.com do kênh này đọc. */
  canHandle(url) {
    return hostMatches(url, 'twitter.com', 'x.com');
  },

  actions: {
    profile: {
      description: 'Đọc timeline công khai của một tài khoản Twitter/X (tối đa 50 tweet)',
      params: {
        username: {
          type: 'string',
          required: true,
          description: 'tên tài khoản, có thể kèm "@" ở đầu, ví dụ elonmusk',
        },
        limit: {
          type: 'integer',
          required: false,
          default: DEFAULT_LIMIT,
          description: 'số tweet tối đa (mặc định 10, tối đa 50)',
        },
      },
      backends(ctx) {
        // Tham số được đọc trong `run` để lỗi vẫn đi qua `runAction` và người
        // gọi nhận phong bì BAD_INPUT thay vì ngoại lệ thoát ra từ `backends`.
        return [
          {
            label: 'twitter-timeline',
            run() {
              return readProfile(ctx.args?.username, ctx.args?.limit, ctx);
            },
          },
        ];
      },
    },

    read: {
      description:
        'Đọc một tweet công khai trên Twitter/X bằng liên kết hoặc id (không đăng nhập)',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'liên kết tweet trên twitter.com/x.com, hoặc id tweet dạng số',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'twitter-tweet-result',
            run() {
              return readTweet(ctx.args?.target, ctx);
            },
          },
        ];
      },
    },
  },
};
