/**
 * Kênh `linkedin` — tìm việc làm và đọc mô tả công việc qua endpoint
 * **jobs-guest công khai** của LinkedIn: chỉ đọc, không đăng nhập, không cookie,
 * không giữ hay gửi bất kỳ thông tin đăng nhập nào.
 *
 * Khác với bản Python gốc (`agent_reach/channels/linkedin.py`, Agent Reach 1.6.1,
 * MIT): bản gốc dùng OpenCLI + trình duyệt riêng + cookie `li_at`, tức là bắt
 * người dùng đăng nhập trước. Bản JS này bỏ hoàn toàn đường đó và dùng API khách
 * mà trang việc làm công khai của LinkedIn tự gọi:
 *
 *   - `GET /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=…&location=…&start=0`
 *     trả HTML danh sách thẻ việc làm (`data-entity-urn="urn:li:jobPosting:<id>"`);
 *   - `GET /jobs-guest/jobs/api/jobPosting/<id>` trả HTML chi tiết một tin.
 *
 * Hai endpoint này không cần cookie, nhưng rất nhạy với header: thiếu
 * `User-Agent` giống trình duyệt thật thì LinkedIn thường trả 999/403. Vì vậy
 * mọi yêu cầu đều gửi kèm `User-Agent` Chrome và `Accept-Language`.
 *
 * Toàn bộ lần gọi mạng đi qua `httpRequest` của `../runtime.js` nên vẫn có giới
 * hạn byte, timeout và chặn đích không công khai như các kênh khác.
 *
 * @module dsh-reach/channels/linkedin
 */

import {
  BAD_INPUT,
  NOT_FOUND,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  ReachError,
  UPSTREAM_BROKEN,
  hostMatches,
  httpRequest,
  makeItem,
  normalizePublicHttpUrl,
  scrubUrlCredentials,
  throwIfAborted,
} from '../runtime.js';

/** Gốc API khách (guest) của trang việc làm công khai LinkedIn. */
const JOBS_API = 'https://www.linkedin.com/jobs-guest/jobs/api';

/** Endpoint tìm việc, tương đương `_jobs` của bản Python nhưng không cần trình duyệt. */
const SEARCH_ENDPOINT = JOBS_API + '/seeMoreJobPostings/search';

/** Endpoint chi tiết một tin việc làm, tương đương `_read` của bản Python. */
const JOB_ENDPOINT = JOBS_API + '/jobPosting/';

/** Trang xem công khai của một tin, dùng để dựng `url` cho item. */
const JOB_VIEW_BASE = 'https://www.linkedin.com/jobs/view/';

/**
 * `User-Agent` của trình duyệt thật.
 *
 * Đây là header bắt buộc: LinkedIn coi request không có UA trình duyệt là bot và
 * trả 999/403. Cố ý không dùng `ctx.http.userAgent` vì giá trị mặc định của
 * plugin (`dsh-reach/1.0 …`) chắc chắn bị chặn.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

/** Header dùng chung cho cả hai endpoint. */
const BROWSER_HEADERS = {
  'User-Agent': BROWSER_USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
};

/** `limit` mặc định và trần của hành động `jobs`. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

/** Trần số ký tự mô tả công việc trả về, tránh nhồi cả trang vào ngữ cảnh. */
const MAX_DESCRIPTION_CHARS = 50000;

/** Trần số ký tự phần trích lỗi lấy từ body, dùng cho thông điệp ReachError. */
const MAX_DETAIL_CHARS = 300;

// ── tiện ích HTML ───────────────────────────────────────────────────────────

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
 * Giải mã entity HTML (`&amp;`, `&quot;`, `&#39;`, `&#x1F600;`…).
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return String(text).replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body) => {
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
    },
  );
}

/**
 * Bóc thẻ HTML, giải entity và gộp khoảng trắng.
 *
 * `blockBreaks: false` (mặc định) trả một dòng gọn — dùng cho tiêu đề, công ty,
 * địa điểm. `blockBreaks: true` giữ xuống dòng theo `<br>`/`<p>`/`</div>` — dùng
 * cho mô tả công việc để văn bản còn đọc được.
 *
 * @param {unknown} value đoạn HTML
 * @param {{blockBreaks?: boolean}} [options]
 * @returns {string|null} null khi rỗng
 */
function htmlToText(value, { blockBreaks = false } = {}) {
  if (value === null || value === undefined) return null;
  let working = String(value);
  working = working.replace(/<!--[\s\S]*?-->/g, ' ');
  working = working.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  if (blockBreaks) {
    working = working.replace(/<br\s*\/?>/gi, '\n');
    working = working.replace(/<li\b[^>]*>/gi, '\n- ');
    working = working.replace(
      /<\/(?:p|div|li|ul|ol|h[1-6]|section|tr|table|blockquote)\s*>/gi,
      '\n',
    );
  } else {
    working = working.replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, ' ');
  }
  working = working.replace(/<[^>]*>/g, '');
  working = decodeEntities(working).replace(/\u00a0/g, ' ');
  if (blockBreaks) {
    const text = working
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line) => line !== '')
      .join('\n')
      .trim();
    return text === '' ? null : text;
  }
  const compact = working.replace(/\s+/g, ' ').trim();
  return compact === '' ? null : compact;
}

/** Kết quả của nhóm capture đầu tiên (đã bóc HTML), hoặc null. */
function firstMatch(html, regex) {
  const match = regex.exec(String(html ?? ''));
  return match === null ? null : htmlToText(match[1]);
}

/**
 * Lấy nội dung bên trong `<div class="…<className>…">`, có đếm độ sâu thẻ `<div>`
 * để không cắt nhầm khi mô tả chứa div lồng nhau.
 *
 * @param {string} html
 * @param {string} className lớp cần tìm (khớp chuỗi con trong thuộc tính class)
 * @returns {string|null} innerHTML, hoặc null khi không thấy thẻ
 */
function divByClass(html, className) {
  const source = String(html ?? '');
  const openRe = new RegExp(
    '<div\\b[^>]*class="[^"]*' + className + '[^"]*"[^>]*>',
    'i',
  );
  const open = openRe.exec(source);
  if (open === null) return null;
  const contentStart = open.index + open[0].length;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = contentStart;
  let depth = 1;
  let tag;
  while ((tag = tagRe.exec(source)) !== null) {
    if (tag[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) return source.slice(contentStart, tag.index);
    } else if (!/\/>$/.test(tag[0])) {
      depth += 1;
    }
  }
  // Không thấy thẻ đóng: trả phần còn lại thay vì bịa nội dung.
  return source.slice(contentStart);
}

// ── nhận diện chặn / lỗi ────────────────────────────────────────────────────

/**
 * Dấu hiệu trang chặn/xác minh của LinkedIn. Chỉ dùng khi phản hồi 200 nhưng
 * không có dữ liệu, nên không làm nhiễu các trang việc làm bình thường.
 */
const BLOCK_PAGE_RE =
  /authwall|\/checkpoint\/|captcha|unusual activity|security verification/i;

/** Phản hồi có phải trang chặn của LinkedIn hay không. */
function isBlockPage(body) {
  return BLOCK_PAGE_RE.test(String(body ?? '').slice(0, 20000));
}

/** Trích một dòng ngắn từ body lỗi, đã bỏ thẻ HTML và thông tin đăng nhập trong URL. */
function clippedDetail(body) {
  const text = htmlToText(String(body ?? '').slice(0, 4000)) ?? '';
  return scrubUrlCredentials(text).slice(0, MAX_DETAIL_CHARS).trim();
}

/** Gợi ý dùng chung khi LinkedIn chặn truy cập ẩn danh. */
const BLOCKED_HINT =
  'LinkedIn chặn truy cập ẩn danh từ máy này. Không thử lại liên tục và không đổi backend; ' +
  'hãy mở liên kết bằng trình duyệt hoặc thử lại sau.';

/**
 * Ánh xạ phản hồi HTTP không thành công sang ReachError.
 *
 * Quy ước: 404 → NOT_FOUND khi đọc một tin cụ thể; 429 → RATE_LIMITED;
 * 401/403/999 (999 là mã LinkedIn dùng cho request bị nghi bot) → PLATFORM_BLOCKED;
 * còn lại → UPSTREAM_BROKEN.
 *
 * @param {{status: number, headers?: Headers, body: string}} response
 * @param {'search'|'job'} context
 * @returns {ReachError|null} null khi phản hồi thành công
 */
function responseFailure(response, context) {
  const status = Number(response.status);
  if (!Number.isFinite(status) || status < 400) return null;
  const detail = clippedDetail(response.body);
  const suffix = detail === '' ? '' : ': ' + detail;
  const retryAfter = response.headers?.get?.('retry-after') ?? null;

  if (status === 404 && context === 'job') {
    return new ReachError(
      NOT_FOUND,
      'LinkedIn không tìm thấy tin tuyển dụng này (HTTP 404)' + suffix,
      'Kiểm tra lại liên kết hoặc id tin việc làm.',
    );
  }
  if (status === 429) {
    const retryHint =
      retryAfter === null || retryAfter === ''
        ? ''
        : ' Thử lại sau ' + retryAfter + ' giây.';
    return new ReachError(
      RATE_LIMITED,
      'LinkedIn báo giới hạn tần suất (HTTP 429)' + suffix,
      'Tôn trọng thời gian chờ rồi thử lại; không đổi backend.' + retryHint,
    );
  }
  if (status === 999 || status === 401 || status === 403) {
    return new ReachError(
      PLATFORM_BLOCKED,
      'LinkedIn chặn yêu cầu ẩn danh (HTTP ' + status + ')' + suffix,
      BLOCKED_HINT,
    );
  }
  return new ReachError(
    UPSTREAM_BROKEN,
    'LinkedIn trả về HTTP ' + status + suffix,
    'Kênh việc làm công khai của LinkedIn đang lỗi hoặc đổi địa chỉ; thử lại sau.',
  );
}

// ── tham số ─────────────────────────────────────────────────────────────────

/** Cắt chuỗi dài cho thông điệp lỗi. */
function clipped(text, limit = MAX_DETAIL_CHARS) {
  return scrubUrlCredentials(String(text ?? '')).trim().slice(0, limit);
}

/**
 * Chuẩn hóa `limit`: mặc định 5, kẹp vào khoảng 1..25.
 *
 * `validateArgs` ở `index.js` đã ép int và điền default, nhưng backend tự kiểm
 * để gọi trực tiếp (kiểm thử, nhúng) vẫn hành xử đúng.
 *
 * @param {unknown} value
 * @returns {number}
 * @throws {ReachError} BAD_INPUT khi giá trị không phải số
 */
function normaliseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ReachError(BAD_INPUT, 'tham số "limit" phải là số nguyên');
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(numeric)));
}

/**
 * Đường dẫn `/jobs/view/<slug>-<id>` — slug có thể có hoặc không, id là nhóm số
 * ở cuối đoạn đường dẫn (bản Python dùng đúng dạng `(?:[^/]+-)?([0-9]+)`).
 */
const JOB_VIEW_PATH_RE = /\/jobs\/view\/(?:[^/?#]*?-)?(\d+)\/?(?=$|[?#])/i;

/**
 * Bóc id tin việc làm từ liên kết `linkedin.com/jobs/view/…` hoặc từ chính id số.
 *
 * URL do người dùng nhập được kiểm qua `normalizePublicHttpUrl` trước, dù kênh
 * chỉ đọc id rồi tự dựng URL API — nhờ vậy target có thông tin đăng nhập nhúng
 * hay đích không công khai đều bị từ chối sớm.
 *
 * @param {unknown} target
 * @returns {string} id dạng chuỗi số
 * @throws {ReachError} BAD_INPUT khi target không đúng dạng
 */
function parseJobId(target) {
  const text = String(target ?? '').trim();
  if (text === '') {
    throw new ReachError(
      BAD_INPUT,
      'thiếu tham số bắt buộc "target"',
      'Truyền liên kết dạng https://www.linkedin.com/jobs/view/<id> hoặc id số.',
    );
  }
  if (/^\d+$/.test(text)) return text;

  let normalised;
  try {
    normalised = normalizePublicHttpUrl(text);
  } catch {
    throw new ReachError(
      BAD_INPUT,
      'target phải là liên kết việc làm trên linkedin.com hoặc id số',
      'Ví dụ: https://www.linkedin.com/jobs/view/4465379983 hoặc 4465379983.',
    );
  }
  if (!hostMatches(normalised, 'linkedin.com')) {
    throw new ReachError(
      BAD_INPUT,
      'target phải là liên kết việc làm trên linkedin.com hoặc id số',
      'Ví dụ: https://www.linkedin.com/jobs/view/4465379983 hoặc 4465379983.',
    );
  }
  const match = JOB_VIEW_PATH_RE.exec(new URL(normalised).pathname);
  if (match === null) {
    throw new ReachError(
      BAD_INPUT,
      'liên kết LinkedIn không phải trang việc làm /jobs/view/<id>',
      'Ví dụ: https://www.linkedin.com/jobs/view/4465379983.',
    );
  }
  return match[1];
}

// ── hành động `jobs` ────────────────────────────────────────────────────────

const CARD_TITLE_RE =
  /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i;
const CARD_TITLE_FALLBACK_RE =
  /<span[^>]*class="[^"]*sr-only[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
const CARD_COMPANY_RE =
  /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i;
const CARD_LOCATION_RE =
  /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i;

/**
 * Tách HTML danh sách việc làm thành các thẻ thô.
 *
 * Mỗi thẻ bắt đầu ở `data-entity-urn="urn:li:jobPosting:<id>"`; nội dung của thẻ
 * là đoạn từ mốc đó tới mốc của thẻ kế tiếp, nên các regex tiêu đề/công ty/địa
 * điểm không vô tình đọc sang thẻ sau. Id trùng (LinkedIn hay lặp thẻ) bị loại.
 *
 * @param {string} html
 * @returns {Array<{job_id: string, title: string|null, company: string|null, location: string|null}>}
 */
function parseSearchCards(html) {
  const source = String(html ?? '');
  const urnRe = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;
  const starts = [];
  let match;
  while ((match = urnRe.exec(source)) !== null) {
    starts.push({ id: match[1], index: match.index });
  }
  const cards = [];
  const seen = new Set();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
    const segment = source.slice(start.index, end);
    cards.push({
      job_id: start.id,
      title:
        firstMatch(segment, CARD_TITLE_RE) ??
        firstMatch(segment, CARD_TITLE_FALLBACK_RE),
      company: firstMatch(segment, CARD_COMPANY_RE),
      location: firstMatch(segment, CARD_LOCATION_RE),
    });
  }
  return cards;
}

/** Dựng item từ một thẻ việc làm đã bóc. */
function cardItem(card) {
  return makeItem({
    title: card.title,
    url: JOB_VIEW_BASE + card.job_id,
    author: card.company,
    text: card.location,
    raw: {
      job_id: card.job_id,
      company: card.company,
      location: card.location,
    },
  });
}

/** Tìm việc làm qua endpoint khách công khai. */
async function searchJobs(ctx) {
  throwIfAborted(ctx.signal);
  const query = String(ctx.args?.query ?? '').trim();
  if (query === '') {
    throw new ReachError(
      BAD_INPUT,
      'thiếu tham số bắt buộc "query"',
      'Truyền từ khóa việc làm, ví dụ: python, data engineer.',
    );
  }
  const location = String(ctx.args?.location ?? '').trim();
  const limit = normaliseLimit(ctx.args?.limit);

  const params = new URLSearchParams({ keywords: query, start: '0' });
  if (location !== '') params.set('location', location);

  const response = await httpRequest(SEARCH_ENDPOINT + '?' + params.toString(), {
    headers: BROWSER_HEADERS,
    http: ctx.http,
    signal: ctx.signal,
  });
  const failure = responseFailure(response, 'search');
  if (failure !== null) throw failure;

  const cards = parseSearchCards(response.body);
  if (cards.length === 0) {
    if (isBlockPage(response.body)) {
      throw new ReachError(
        PLATFORM_BLOCKED,
        'LinkedIn trả trang xác minh thay vì danh sách việc làm',
        BLOCKED_HINT,
      );
    }
    throw new ReachError(
      NOT_FOUND,
      'LinkedIn không có tin việc làm nào khớp truy vấn "' +
        clipped(query) +
        '"' +
        (location === '' ? '' : ' tại "' + clipped(location) + '"'),
      'Thử từ khóa rộng hơn hoặc bỏ tham số "location".',
    );
  }
  return cards.slice(0, limit).map((card) => cardItem(card));
}

// ── hành động `read` ────────────────────────────────────────────────────────

/** Tiêu đề trang chi tiết; fallback cho biến thể chỉ có `topcard__title`. */
const JOB_TITLE_RE =
  /<[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/i;
const JOB_TITLE_FALLBACK_RE =
  /<[^>]*class="[^"]*topcard__title[^"]*"[^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/i;
/** Công ty: link trang công ty trước, rồi mới tới `topcard__flavor`. */
const JOB_COMPANY_RE =
  /<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
const JOB_COMPANY_FALLBACK_RE =
  /<span[^>]*class="[^"]*topcard__flavor[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
/** Địa điểm: span `topcard__flavor--bullet` (figure số ứng viên dùng class khác thẻ). */
const JOB_LOCATION_RE =
  /<span[^>]*class="[^"]*topcard__flavor--bullet[^"]*"[^>]*>([\s\S]*?)<\/span>/i;

/** Cắt mô tả quá dài kèm ghi chú rõ ràng. */
function clampDescription(text) {
  if (text === null) return null;
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  return (
    text.slice(0, MAX_DESCRIPTION_CHARS) +
    '\n…(đã cắt bớt, còn ' +
    (text.length - MAX_DESCRIPTION_CHARS) +
    ' ký tự)'
  );
}

/**
 * Bóc dữ liệu từ HTML trang chi tiết một tin việc làm.
 *
 * @param {string} html
 * @returns {{title: string|null, company: string|null, location: string|null, description: string|null}}
 */
function parseJobDetail(html) {
  const source = String(html ?? '');
  const title =
    firstMatch(source, JOB_TITLE_RE) ?? firstMatch(source, JOB_TITLE_FALLBACK_RE);
  const company =
    firstMatch(source, JOB_COMPANY_RE) ?? firstMatch(source, JOB_COMPANY_FALLBACK_RE);
  const location = firstMatch(source, JOB_LOCATION_RE);
  const descriptionHtml =
    divByClass(source, 'show-more-less-html__markup') ??
    divByClass(source, 'description__text');
  return {
    title,
    company,
    location,
    description: clampDescription(
      htmlToText(descriptionHtml, { blockBreaks: true }),
    ),
  };
}

/** Đọc một tin việc làm qua endpoint khách công khai. */
async function readJob(ctx) {
  throwIfAborted(ctx.signal);
  const jobId = parseJobId(ctx.args?.target);

  const response = await httpRequest(JOB_ENDPOINT + encodeURIComponent(jobId), {
    headers: BROWSER_HEADERS,
    http: ctx.http,
    signal: ctx.signal,
  });
  const failure = responseFailure(response, 'job');
  if (failure !== null) throw failure;

  const detail = parseJobDetail(response.body);
  if (detail.title === null) {
    if (isBlockPage(response.body)) {
      throw new ReachError(
        PLATFORM_BLOCKED,
        'LinkedIn trả trang xác minh thay vì nội dung tin việc làm',
        BLOCKED_HINT,
      );
    }
    throw new ReachError(
      NOT_FOUND,
      'LinkedIn không trả về nội dung cho tin việc làm ' + jobId,
      'Kiểm tra lại liên kết hoặc id tin việc làm.',
    );
  }

  return [
    makeItem({
      title: detail.title,
      url: JOB_VIEW_BASE + jobId,
      author: detail.company,
      text: detail.description,
      raw: {
        job_id: jobId,
        company: detail.company,
        location: detail.location,
      },
    }),
  ];
}

export const channel = {
  name: 'linkedin',
  description:
    'LinkedIn: tìm việc làm công khai và đọc mô tả công việc — không cần đăng nhập, không dùng cookie',
  level: 'optional',

  /** Mọi URL thuộc linkedin.com do kênh này đọc. */
  canHandle(url) {
    return hostMatches(url, 'linkedin.com');
  },

  actions: {
    jobs: {
      description:
        'Tìm việc làm trên LinkedIn qua endpoint khách công khai (không cần đăng nhập)',
      params: {
        query: {
          type: 'string',
          required: true,
          description: 'từ khóa việc làm, ví dụ: python, data engineer',
        },
        location: {
          type: 'string',
          required: false,
          description: 'địa điểm, ví dụ: Vietnam, Hanoi, Remote',
        },
        limit: {
          type: 'integer',
          required: false,
          default: DEFAULT_LIMIT,
          description: 'số tin tối đa (1–25)',
        },
      },
      backends(ctx) {
        // Tham số bắt buộc được kiểm trong `run` để `runAction` vẫn dựng phong
        // bì lỗi BAD_INPUT thay vì để ngoại lệ thoát ra từ `backends`.
        return [
          {
            label: 'linkedin-jobs-guest',
            async run() {
              return searchJobs(ctx);
            },
          },
        ];
      },
    },

    read: {
      description: 'Đọc mô tả chi tiết một tin tuyển dụng LinkedIn',
      params: {
        target: {
          type: 'string',
          required: true,
          description:
            'liên kết https://www.linkedin.com/jobs/view/<id> (kèm slug cũng được) hoặc id số',
        },
      },
      backends(ctx) {
        // Target được kiểm trong `readJob` (tức trong `run`), nên target sai vẫn
        // đi qua `runAction` và người gọi nhận phong bì lỗi BAD_INPUT.
        return [
          {
            label: 'linkedin-jobs-guest',
            async run() {
              return readJob(ctx);
            },
          },
        ];
      },
    },
  },
};
