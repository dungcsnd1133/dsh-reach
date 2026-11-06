/**
 * Kênh `reddit` — đọc công khai Reddit qua **Atom/RSS**, không cần đăng nhập,
 * không dùng OAuth, không dùng API JSON.
 *
 * Vì sao là RSS: các endpoint JSON (`/r/<sub>/hot.json`, old.reddit, oembed…)
 * trả 403 khi không có phiên đăng nhập, nhưng endpoint `.rss` vẫn trả 200 công
 * khai. Đổi lại, RSS của Reddit có giới hạn tần suất rất chặt và trả 429 kèm
 * `x-ratelimit-reset`, nên module này không bao giờ tự thử lại vòng lặp: mọi
 * 429 được ánh xạ thành `RATE_LIMITED` kèm gợi ý chờ đúng số giây.
 *
 * Port hành vi từ `agent_reach/channels/reddit.py` (Agent Reach 1.6.1, MIT),
 * nhưng bản Python đi qua OpenCLI + trình duyệt; bản này chỉ dùng HTTP thuần.
 *
 * @module dsh-reach/channels/reddit
 */

import {
  BAD_INPUT,
  NOT_FOUND,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  ReachError,
  UPSTREAM_BROKEN,
  classify,
  hostMatches,
  httpRequest,
  makeItem,
  normalizePublicHttpUrl,
} from '../runtime.js';

/** Gốc công khai; mọi đường dẫn trong module đều nối vào đây. */
const BASE = 'https://www.reddit.com';

/**
 * User-Agent riêng, mô tả rõ mục đích: Reddit yêu cầu UA có thể nhận diện,
 * UA mặc định của Node hoặc UA rỗng dễ bị chặn hơn.
 */
const USER_AGENT = 'dsh-reach/1.0 (read-only)';

/** Chỉ xin đúng loại nội dung Atom; RSS endpoint luôn trả Atom. */
const FEED_ACCEPT = 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8';

/** Các kiểu sắp xếp được chấp nhận cho hành động `subreddit`. */
const SORTS = new Set(['hot', 'new', 'top', 'rising']);

/** Tên subreddit hợp lệ: chữ, số, gạch dưới; 2–30 ký tự. */
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,30}$/;

/** Id bài viết Reddit dạng base36; RSS chấp nhận id ngắn vài ký tự. */
const POST_ID_RE = /^[A-Za-z0-9]{2,16}$/;

/** Trần số entry Reddit trả cho một feed RSS; limit luôn bị kẹp theo con số này. */
const MAX_ITEMS = 25;

/** Giới hạn số ký tự của `text` khi ghép bài viết với bình luận. */
const MAX_TEXT_CHARS = 50000;

// ── giải mã XML/HTML ────────────────────────────────────────────────────────

/** Bảng entity tên thường gặp trong Atom feed của Reddit. */
const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/**
 * Giải một lớp entity XML/HTML.
 *
 * Reddit escape nội dung `<content>` hai lớp (`&amp;#32;` ⇒ `&#32;` ⇒ dấu
 * cách), nên hàm này phải được gọi hai lần liên tiếp cho phần content.
 *
 * @param {string} input
 * @returns {string}
 */
function decodeEntitiesOnce(input) {
  return String(input).replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, hex, decimal, name) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      if (decimal !== undefined) {
        const code = Number.parseInt(decimal, 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      const known = NAMED_ENTITIES[String(name).toLowerCase()];
      return known === undefined ? match : known;
    },
  );
}

/** Giải hai lớp entity, đúng như cách Reddit escape `content`. */
function decodeEntitiesTwice(input) {
  return decodeEntitiesOnce(decodeEntitiesOnce(input));
}

/**
 * Đổi HTML trong `<content>` thành văn bản thuần: `<br/>` thành xuống dòng,
 * bỏ mọi thẻ, giải entity hai lớp, gộp khoảng trắng thừa.
 *
 * Phần chrome do chính Reddit chèn (dòng "submitted by /u/…", các nhãn
 * `[link]`, `[comments]`) bị bỏ đi vì tác giả và liên kết đã có ở trường
 * riêng của item; giữ lại chỉ làm nhiễu `text`.
 *
 * @param {string} raw nội dung thô trong thẻ `<content>`
 * @returns {string|null}
 */
function contentToText(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let text = decodeEntitiesTwice(raw);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p\s*>/gi, '\n\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/\[\s*(?:link|comments)\s*\]/gi, ' ');
  text = text.replace(/submitted\s+by\s+\/?u\/[A-Za-z0-9_-]+/gi, ' ');
  text = text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

/** Cắt văn bản dài một cách có ý thức, kèm dấu hiệu đã cắt. */
function clampText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '\n…(đã cắt bớt)';
}

// ── chuẩn hóa tham số ───────────────────────────────────────────────────────

/** Chuẩn hóa `limit`: số nguyên, kẹp trong 1..25; giá trị rác là BAD_INPUT. */
function normalizeLimit(value, fallback = 10) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.trunc(numeric) < 1) {
    throw new ReachError(
      BAD_INPUT,
      'tham số "limit" phải là số nguyên dương',
      'Truyền limit là số nguyên từ 1 đến 25, ví dụ 10.',
    );
  }
  return Math.min(Math.trunc(numeric), MAX_ITEMS);
}

/** Bỏ tiền tố `r/` (hoặc `/r/`) và khoảng trắng thừa khỏi tên subreddit. */
function bareSubredditName(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Kiểm tra và chuẩn hóa tên subreddit.
 *
 * @param {unknown} value
 * @param {string} paramName tên tham số để báo lỗi cho đúng
 * @returns {string}
 * @throws {ReachError} BAD_INPUT khi tên không hợp lệ
 */
function requireSubredditName(value, paramName) {
  const name = bareSubredditName(value);
  if (name === '') {
    throw new ReachError(
      BAD_INPUT,
      'thiếu tham số bắt buộc "' + paramName + '"',
      'Ví dụ: programming, rust, Vietnam.',
    );
  }
  if (!SUBREDDIT_RE.test(name)) {
    throw new ReachError(
      BAD_INPUT,
      'tên subreddit "' + name + '" không hợp lệ (chỉ chữ, số, gạch dưới; 2–30 ký tự)',
      'Bỏ tiền tố "r/", ví dụ: programming hoặc rust.',
    );
  }
  return name;
}

/** Kiểm tra `sort`; sai thì BAD_INPUT liệt kê lựa chọn hợp lệ. */
function requireSort(value) {
  if (value === undefined || value === null || value === '') return 'hot';
  const sort = String(value).trim().toLowerCase();
  if (!SORTS.has(sort)) {
    throw new ReachError(
      BAD_INPUT,
      'tham số "sort" phải là một trong: hot, new, top, rising',
      'Mặc định là hot.',
    );
  }
  return sort;
}

/**
 * Bóc id bài viết khỏi URL Reddit hoặc nhận id trần.
 *
 * Chấp nhận: link `/r/<sub>/comments/<id>/…`, `redd.it/<id>`,
 * `/comments/<id>/…` (kể cả old.reddit) và id base36 trần.
 *
 * @param {unknown} target
 * @returns {string} id viết thường
 * @throws {ReachError} BAD_INPUT khi không nhận dạng được
 */
function parsePostId(target) {
  const text = String(target ?? '').trim();
  if (text === '') {
    throw new ReachError(
      BAD_INPUT,
      'thiếu tham số bắt buộc "target"',
      'Ví dụ: https://www.reddit.com/r/programming/comments/1xojg3s/… hoặc 1xojg3s.',
    );
  }
  if (POST_ID_RE.test(text)) return text.toLowerCase();

  const withoutScheme = text.replace(/^https?:\/\//i, '');
  const patterns = [
    /^redd\.it\/([A-Za-z0-9]+)/i,
    /^(?:[A-Za-z0-9-]+\.)*reddit\.com\/(?:r\/[A-Za-z0-9_]+\/)?comments\/([A-Za-z0-9]+)/i,
    /^(?:[A-Za-z0-9-]+\.)*reddit\.com\/r\/[A-Za-z0-9_]+\/s\/([A-Za-z0-9]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(withoutScheme);
    if (match !== null && POST_ID_RE.test(match[1])) return match[1].toLowerCase();
  }
  throw new ReachError(
    BAD_INPUT,
    'target không phải liên kết bài viết Reddit hay id bài viết hợp lệ',
    'Ví dụ: https://www.reddit.com/r/programming/comments/1xojg3s/… hoặc 1xojg3s.',
  );
}

// ── tải và phân tích feed ───────────────────────────────────────────────────

/**
 * Đọc số giây cần chờ từ header của Reddit.
 *
 * Reddit trả `x-ratelimit-reset` (số giây, có thể lẻ) và đôi khi cả
 * `retry-after`. Không có header nào thì trả null để gợi ý dùng mức chờ mặc định.
 *
 * @param {Headers|undefined} headers
 * @returns {number|null}
 */
function rateLimitWaitSeconds(headers) {
  const read = (name) => {
    try {
      return headers?.get?.(name) ?? null;
    } catch {
      return null;
    }
  };
  for (const name of ['x-ratelimit-reset', 'retry-after']) {
    const raw = read(name);
    if (raw === null || String(raw).trim() === '') continue;
    const seconds = Number(String(raw).trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return null;
}

/** Dựng ReachError RATE_LIMITED nêu rõ số giây phải chờ, nếu đọc được header. */
function rateLimitedError(headers, what) {
  const wait = rateLimitWaitSeconds(headers);
  const message =
    'Reddit báo giới hạn tần suất cho RSS (HTTP 429) khi ' +
    what +
    (wait === null ? '' : '; cần chờ khoảng ' + wait + ' giây');
  const hint =
    wait === null
      ? 'Reddit giới hạn tần suất rất chặt: chờ khoảng 30 giây rồi thử lại một lần, không gọi liên tiếp và không đổi backend.'
      : 'Chờ ' +
        wait +
        ' giây rồi thử lại một lần; không gọi liên tiếp, không đổi backend.';
  return new ReachError(RATE_LIMITED, message, hint);
}

/** Thông điệp chặn, nêu đúng mã HTTP quan sát được. */
function blockedMessage(status, what) {
  return (
    'Reddit chặn yêu cầu khi ' +
    what +
    ' bằng HTTP ' +
    status +
    ' (chống bot/không có phiên đăng nhập); không lấy được dữ liệu RSS.'
  );
}

/**
 * GET một feed Atom của Reddit qua client có giới hạn, đã ánh xạ mã lỗi.
 *
 * @param {string} url
 * @param {object} ctx ngữ cảnh hành động
 * @param {string} what mô tả ngắn việc đang làm, dùng trong thông điệp lỗi
 * @returns {Promise<string>} thân phản hồi Atom
 */
async function fetchFeed(url, ctx, what) {
  // URL do module tự dựng từ thành phần đã kiểm, nhưng vẫn cho qua hàm chuẩn
  // hóa của runtime để giữ đúng hợp đồng an toàn URL.
  const safeUrl = normalizePublicHttpUrl(url);
  let response;
  try {
    response = await httpRequest(safeUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: FEED_ACCEPT },
      http: ctx.http,
      signal: ctx.signal,
    });
  } catch (error) {
    throw classify(error);
  }

  const status = response.status;
  if (status === 429) throw rateLimitedError(response.headers, what);
  if (status === 401 || status === 403 || status === 412) {
    throw new ReachError(PLATFORM_BLOCKED, blockedMessage(status, what), undefined);
  }
  if (status === 404) {
    throw new ReachError(
      NOT_FOUND,
      'Reddit không trả về nội dung nào cho yêu cầu ' + what + ' (HTTP 404)',
      'Kiểm tra lại tên subreddit, từ khóa hoặc id bài viết.',
    );
  }
  if (status === 451) {
    throw new ReachError(
      PLATFORM_BLOCKED,
      'Reddit không cung cấp nội dung này ở khu vực hiện tại (HTTP 451) khi ' + what,
    );
  }
  if (status >= 500) {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'Reddit đang lỗi phía máy chủ (HTTP ' + status + ') khi ' + what,
    );
  }
  if (status !== 200) {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'Reddit trả về HTTP ' + status + ' khi ' + what,
    );
  }

  const body = response.body ?? '';
  if (body.trim() === '') {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'Reddit trả về thân rỗng khi ' + what,
    );
  }
  if (!/<feed[\s>]/.test(body) && !/<entry[\s>]/.test(body)) {
    // 200 nhưng không phải Atom: nhiều khả năng là trang xác minh chống bot.
    throw new ReachError(
      PLATFORM_BLOCKED,
      'Reddit trả về nội dung không phải Atom feed (có thể là trang xác minh chống bot) khi ' +
        what,
    );
  }
  return body;
}

/** Lấy văn bản của thẻ con đầu tiên; giải entity một lớp. */
function atomField(block, tag) {
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>');
  const match = pattern.exec(block);
  return match === null ? null : decodeEntitiesOnce(match[1]).trim();
}

/** Lấy `href` của thẻ `<link>` đầu tiên trong một entry. */
function atomLink(block) {
  const match = /<link\b[^>]*\bhref\s*=\s*"([^"]*)"/i.exec(block);
  if (match !== null) return decodeEntitiesOnce(match[1]).trim() || null;
  return null;
}

/** Bỏ tiền tố `/u/` hoặc `u/` cho gọn. */
function bareAuthor(value) {
  const author = String(value ?? '').trim();
  if (author === '') return null;
  return author.replace(/^\/?u\//i, '') || null;
}

/** Đổi mốc thời gian ISO của Reddit về ISO 8601 UTC; sai thì null. */
function normalizeIso(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Phân tích một khối `<entry>` thành object trung gian.
 *
 * `kind` suy ra từ tiền tố id Atom: `t3_` là bài viết, `t1_` là bình luận.
 */
function parseEntry(block) {
  const id = atomField(block, 'id');
  let kind = 'unknown';
  if (id !== null && /^t3_/i.test(id)) kind = 'post';
  else if (id !== null && /^t1_/i.test(id)) kind = 'comment';
  return {
    id: id === null ? null : id.replace(/^t\d_/i, ''),
    kind,
    title: atomField(block, 'title'),
    url: atomLink(block),
    author: bareAuthor(atomField(block, 'name')),
    publishedAt: normalizeIso(atomField(block, 'updated') ?? atomField(block, 'published')),
    text: contentToText(atomField(block, 'content')),
  };
}

/**
 * Bóc mọi entry trong feed Atom. Dùng regex vì feed này có hình dạng ổn định
 * và hợp đồng cho phép không kéo thêm thư viện XML.
 *
 * @param {string} body
 * @returns {Array<object>}
 */
function parseFeed(body) {
  const entries = [];
  const pattern = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1].trim() === '') continue;
    entries.push(parseEntry(match[1]));
  }
  return entries;
}

/** Dựng item từ một entry feed, kèm dữ liệu thô của ngữ cảnh gọi. */
function entryItem(entry, raw) {
  return makeItem({
    title: entry.title,
    url: entry.url,
    author: entry.author,
    publishedAt: entry.publishedAt,
    text: entry.text,
    raw,
  });
}

/** Feed không có entry nào ⇒ nội dung không tồn tại, không phải mảng rỗng. */
function emptyFeedError(what, hint) {
  return new ReachError(NOT_FOUND, 'Reddit không trả về entry nào khi ' + what, hint);
}

export const channel = {
  name: 'reddit',
  description:
    'Reddit (chỉ đọc, qua RSS công khai): bài trong subreddit, tìm kiếm và đọc bài kèm bình luận; không cần đăng nhập',
  level: 'optional',

  /** Kênh nhận URL thuộc reddit.com hoặc redd.it. */
  canHandle(url) {
    return hostMatches(url, 'reddit.com', 'redd.it');
  },

  actions: {
    subreddit: {
      description:
        'Liệt kê bài viết trong một subreddit Reddit (hot/new/top/rising) qua RSS công khai',
      params: {
        name: {
          type: 'string',
          required: true,
          description: 'tên subreddit, ví dụ: programming, rust (bỏ tiền tố "r/")',
        },
        sort: {
          type: 'string',
          required: false,
          default: 'hot',
          description: 'kiểu sắp xếp: hot, new, top hoặc rising',
        },
        limit: {
          type: 'integer',
          required: false,
          default: 10,
          description: 'số bài tối đa (từ 1 đến 25)',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'reddit-rss',
            async run() {
              const name = requireSubredditName(ctx.args.name, 'name');
              const sort = requireSort(ctx.args.sort);
              const limit = normalizeLimit(ctx.args.limit);
              // Reddit trả feed "hot" ở cả /r/<name>/.rss và /r/<name>/hot/.rss;
              // dùng dạng ngắn cho hot, dạng có sort cho các kiểu còn lại.
              const path = sort === 'hot' ? '/r/' + name + '/.rss' : '/r/' + name + '/' + sort + '/.rss';
              const body = await fetchFeed(BASE + path, ctx, 'đọc subreddit r/' + name);
              const entries = parseFeed(body);
              if (entries.length === 0) {
                throw emptyFeedError(
                  'đọc subreddit r/' + name,
                  'Subreddit có thể không tồn tại hoặc chưa có bài nào; kiểm tra lại tên.',
                );
              }
              return entries
                .slice(0, limit)
                .map((entry) => entryItem(entry, { subreddit: name, sort }));
            },
          },
        ];
      },
    },

    search: {
      description:
        'Tìm bài viết trên Reddit (toàn site hoặc trong một subreddit) qua RSS công khai',
      params: {
        query: {
          type: 'string',
          required: true,
          description: 'nội dung cần tìm',
        },
        subreddit: {
          type: 'string',
          required: false,
          description: 'giới hạn tìm trong subreddit này (bỏ tiền tố "r/")',
        },
        limit: {
          type: 'integer',
          required: false,
          default: 10,
          description: 'số kết quả tối đa (từ 1 đến 25)',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'reddit-rss',
            async run() {
              const query = String(ctx.args.query ?? '').trim();
              if (query === '') {
                throw new ReachError(
                  BAD_INPUT,
                  'thiếu tham số bắt buộc "query"',
                  'Ví dụ: "rust async", "kernel panic".',
                );
              }
              const limit = normalizeLimit(ctx.args.limit);
              const rawSub = ctx.args.subreddit;
              const hasSubreddit =
                rawSub !== undefined && rawSub !== null && String(rawSub).trim() !== '';
              const subreddit = hasSubreddit
                ? requireSubredditName(rawSub, 'subreddit')
                : null;

              const encodedQuery = encodeURIComponent(query);
              const url = subreddit === null
                ? BASE + '/search.rss?q=' + encodedQuery + '&limit=' + limit
                : BASE +
                  '/r/' +
                  subreddit +
                  '/search.rss?q=' +
                  encodedQuery +
                  '&restrict_sr=1&limit=' +
                  limit;

              const what =
                subreddit === null
                  ? 'tìm "' + query + '" trên Reddit'
                  : 'tìm "' + query + '" trong r/' + subreddit;
              const body = await fetchFeed(url, ctx, what);
              const entries = parseFeed(body);
              if (entries.length === 0) {
                throw emptyFeedError(
                  what,
                  'Thử từ khóa ngắn hơn hoặc bỏ giới hạn subreddit.',
                );
              }
              return entries
                .slice(0, limit)
                .map((entry) => entryItem(entry, { query, subreddit }));
            },
          },
        ];
      },
    },

    read: {
      description:
        'Đọc một bài viết Reddit kèm bình luận lấy từ RSS công khai (không cần đăng nhập)',
      params: {
        target: {
          type: 'string',
          required: true,
          description:
            'liên kết bài viết Reddit (reddit.com/r/<sub>/comments/<id>/…) hoặc id bài viết',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'reddit-rss',
            async run() {
              const postId = parsePostId(ctx.args.target);
              const body = await fetchFeed(
                BASE + '/comments/' + postId + '/.rss',
                ctx,
                'đọc bài viết ' + postId,
              );
              const entries = parseFeed(body);
              if (entries.length === 0) {
                throw emptyFeedError(
                  'đọc bài viết ' + postId,
                  'Bài viết có thể đã bị xóa hoặc id không đúng.',
                );
              }

              // Entry đầu thường là bài viết; nhận diện chắc hơn bằng tiền tố id
              // Atom (t3_ = bài viết, t1_ = bình luận) để feed đổi thứ tự vẫn đúng.
              const post =
                entries.find((entry) => entry.kind === 'post') ?? entries[0];
              const comments = entries.filter((entry) => entry !== post);

              const lines = [];
              if (post.text !== null) lines.push(post.text);
              for (const comment of comments) {
                const who = comment.author ?? 'ẩn danh';
                const content = comment.text ?? '';
                lines.push('\n@' + who + ': ' + content);
              }
              const text = lines.join('\n').trim();

              return [
                makeItem({
                  title: post.title,
                  url: post.url,
                  author: post.author,
                  publishedAt: post.publishedAt,
                  text: text === '' ? null : clampText(text),
                  raw: {
                    post: {
                      id: post.id,
                      title: post.title,
                      url: post.url,
                      author: post.author,
                      published_at: post.publishedAt,
                      text: post.text,
                    },
                    comments: comments.map((comment) => ({
                      id: comment.id,
                      author: comment.author,
                      url: comment.url,
                      published_at: comment.publishedAt,
                      text: comment.text,
                    })),
                  },
                }),
              ];
            },
          },
        ];
      },
    },
  },
};
