/**
 * Kênh `xueqiu` — tra giá cổ phiếu và tìm mã cổ phiếu (A-share, Hồng Kông, Mỹ)
 * qua các endpoint công khai của Tencent mà Xueqiu dùng cho ô tìm kiếm.
 *
 * Port một phần từ `agent_reach/channels/xueqiu.py` (Agent Reach 1.6.1, MIT).
 * Bản Python có 4 hành động; ở đây chỉ giữ 2 hành động không cần đăng nhập:
 *
 *   - `quote`  → qt.gtimg.cn (dữ liệu thô mã hóa GBK)
 *   - `search` → smartbox.gtimg.cn (gợi ý mã, unicode escape JSON)
 *
 * Hai hành động `hot_posts` và `hot_stocks` bị bỏ vì chúng cần phiên đăng nhập
 * Xueqiu và cookie từ trình duyệt — plugin này chỉ đọc dữ liệu công khai.
 *
 * @module dsh-reach/channels/xueqiu
 */

import {
  BAD_INPUT,
  DEFAULT_HTTP,
  NOT_FOUND,
  ReachError,
  TIMEOUT,
  UPSTREAM_BROKEN,
  classify,
  hostMatches,
  httpRequest,
  makeItem,
  normalizePublicHttpUrl,
  throwIfAborted,
} from '../runtime.js';

/** Endpoint giá realtime của Tencent (body GBK). */
const QUOTE_URL = 'https://qt.gtimg.cn/q=';

/** Endpoint gợi ý mã cổ phiếu của Tencent. */
const SEARCH_URL = 'https://smartbox.gtimg.cn/s3/?v=2&q=';

/** Số trường tối thiểu của một phản hồi quote hợp lệ. */
const MIN_QUOTE_FIELDS = 35;

/** Chuẩn hóa `limit`: số nguyên dương, mặc định 5. */
function normalizeLimit(value, fallback = 5) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.trunc(numeric) < 1) {
    throw new ReachError(
      BAD_INPUT,
      'tham số "limit" phải là số nguyên dương',
      'Truyền limit là số nguyên từ 1 trở lên, ví dụ 5.',
    );
  }
  return Math.trunc(numeric);
}

/**
 * Đổi mã người dùng nhập sang mã Tencent, y hệt `_tencent_code` của bản Python.
 *
 * @param {unknown} symbol
 * @returns {string}
 * @throws {ReachError} BAD_INPUT khi không nhận dạng được
 */
function tencentCode(symbol) {
  const s = String(symbol ?? '').trim().toUpperCase();
  if (/^(SH|SZ|BJ)\d{6}$/.test(s)) return s.toLowerCase();
  if (/^\d{6}$/.test(s)) {
    const prefix = '69'.includes(s[0]) ? 'sh' : '48'.includes(s[0]) ? 'bj' : 'sz';
    return prefix + s;
  }
  if (/^HK\d{1,5}$/.test(s)) return 'hk' + s.slice(2).padStart(5, '0');
  if (/^\d{1,5}$/.test(s)) return 'hk' + s.padStart(5, '0');
  if (/^[A-Z][A-Z.\-]{0,9}$/.test(s)) return 'us' + s;
  throw new ReachError(
    BAD_INPUT,
    'symbol phải có dạng SH600519, 600519, 00700 hoặc AAPL',
    'Ví dụ: SH600519 (thượng Hải), 600519 (A-share), 00700 (Hồng Kông), AAPL (Mỹ).',
  );
}

/**
 * Đổi cặp (thị trường Tencent, mã) sang mã Xueqiu dùng trong URL `/S/<mã>`.
 * Tương đương `_xueqiu_symbol` của bản Python.
 *
 * @param {string} market
 * @param {string} code
 * @returns {string}
 */
function xueqiuSymbol(market, code) {
  const m = String(market ?? '').toLowerCase();
  const c = String(code ?? '');
  if (m === 'sh' || m === 'sz' || m === 'bj') return m.toUpperCase() + c;
  if (m === 'hk') return c;
  return c.split('.')[0].toUpperCase();
}

/**
 * Tải một URL trả về văn bản mã hóa GBK.
 *
 * Vì sao không dùng `httpRequest` của runtime? Hàm đó giải mã phản hồi bằng
 * UTF-8 (`buffer.toString('utf8')`), nên tên cổ phiếu tiếng Trung của
 * `qt.gtimg.cn` sẽ thành ký tự rác. Ở đây vẫn giữ nguyên hàng rào an toàn:
 * URL được kiểm tra SSRF trước khi gọi và cả URL cuối sau chuyển hướng, giới
 * hạn số byte lấy từ `ctx.http.maxResponseBytes`, timeout lấy từ
 * `ctx.http.timeoutMs` (AbortSignal.timeout) và kết hợp `ctx.signal`.
 *
 * @param {string} url
 * @param {object} ctx ngữ cảnh backend của runAction
 * @returns {Promise<string>} nội dung đã giải mã GBK
 */
async function fetchGbkText(url, ctx) {
  const http = ctx.http ?? DEFAULT_HTTP;
  const target = normalizePublicHttpUrl(url);
  const timeoutMs = Number(http.timeoutMs);
  const maxBytes = Number(http.maxResponseBytes);

  const signals = [];
  const timeoutSignal =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  if (timeoutSignal !== null) signals.push(timeoutSignal);
  if (ctx.signal !== undefined) signals.push(ctx.signal);
  const signal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  let bytes;
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { 'User-Agent': http.userAgent, Accept: '*/*' },
      redirect: 'follow',
      signal,
    });
    throwIfAborted(ctx.signal);
    // Chuyển hướng có thể đã trỏ về vùng mạng nội bộ; kiểm tra URL cuối.
    normalizePublicHttpUrl(response.url);
    if (!response.ok) {
      throw new ReachError(
        UPSTREAM_BROKEN,
        'máy chủ giá cổ phiếu Tencent trả về HTTP ' + response.status,
      );
    }
    const buffer = await response.arrayBuffer();
    throwIfAborted(ctx.signal);
    bytes = new Uint8Array(buffer);
  } catch (error) {
    if (error instanceof ReachError) throw error;
    if (ctx.signal?.aborted === true) throwIfAborted(ctx.signal);
    if (timeoutSignal?.aborted === true) {
      throw new ReachError(
        TIMEOUT,
        'yêu cầu giá cổ phiếu vượt quá thời gian chờ ' + timeoutMs + 'ms',
      );
    }
    throw classify(error);
  }

  if (Number.isFinite(maxBytes) && maxBytes > 0 && bytes.byteLength > maxBytes) {
    throw new ReachError(UPSTREAM_BROKEN, 'phản hồi vượt quá ' + maxBytes + ' byte');
  }
  // Node 24 có sẵn bảng mã GBK trong TextDecoder; không cần thư viện ngoài.
  return new TextDecoder('gbk').decode(bytes);
}

/** Bóc nội dung trong cặp dấu ngoặc kép đầu tiên của phản hồi Tencent. */
function firstQuoted(text) {
  const match = /="([^"]*)"/.exec(text);
  return match === null ? null : match[1];
}

export const channel = {
  name: 'xueqiu',
  description:
    'Xueqiu/Tencent: giá cổ phiếu realtime (A-share, Hồng Kông, Mỹ) và tìm mã cổ phiếu, chỉ đọc',
  level: 'default',

  /** Kênh nhận URL thuộc xueqiu.com. */
  canHandle(url) {
    return hostMatches(url, 'xueqiu.com');
  },

  actions: {
    quote: {
      description:
        'Lấy giá cổ phiếu realtime (A-share, Hồng Kông, Mỹ) kèm giá mở cửa, cao, thấp và phần trăm thay đổi',
      params: {
        symbol: {
          type: 'string',
          required: true,
          description: 'mã cổ phiếu, ví dụ: SH600519, 600519, 00700, AAPL',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'tencent-quote',
            async run() {
              const symbol = String(ctx.args.symbol ?? '').trim();
              const code = tencentCode(symbol);
              const body = await fetchGbkText(QUOTE_URL + code, ctx);
              const payload = firstQuoted(body);
              if (payload === null) {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy giá cho mã "' + symbol + '"',
                  'Kiểm tra lại mã cổ phiếu, ví dụ: SH600519, 600519, 00700, AAPL.',
                );
              }
              const fields = payload.split('~');
              if (fields.length < MIN_QUOTE_FIELDS) {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy giá cho mã "' + symbol + '"',
                  'Kiểm tra lại mã cổ phiếu, ví dụ: SH600519, 600519, 00700, AAPL.',
                );
              }
              // Trường [2] là mã gốc; với cổ phiếu Mỹ dạng "AAPL.OQ" cần bỏ hậu tố.
              const xq = xueqiuSymbol(code.slice(0, 2), fields[2]);
              const name = fields[1];
              const current = fields[3];
              const percent = fields[32];
              return [
                makeItem({
                  title: name + ' (' + xq + ')',
                  url: 'https://xueqiu.com/S/' + xq,
                  text: name + ' ' + current + ' (' + percent + '%)',
                  raw: {
                    symbol: xq,
                    name,
                    current,
                    last_close: fields[4],
                    open: fields[5],
                    chg: fields[31],
                    percent,
                    high: fields[33],
                    low: fields[34],
                    time: fields[30],
                  },
                }),
              ];
            },
          },
        ];
      },
    },

    search: {
      description: 'Tìm mã cổ phiếu theo tên hoặc mã (A-share, Hồng Kông, Mỹ)',
      params: {
        query: {
          type: 'string',
          required: true,
          description: 'tên hoặc mã cần tìm, ví dụ: 茅台, AAPL, 腾讯',
        },
        limit: {
          type: 'integer',
          required: false,
          default: 5,
          description: 'số kết quả tối đa',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'tencent-search',
            async run() {
              const query = String(ctx.args.query ?? '').trim();
              if (query === '') {
                throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "query"');
              }
              const limit = normalizeLimit(ctx.args.limit);
              const url = SEARCH_URL + encodeURIComponent(query) + '&t=all';
              // Phản hồi smartbox là ASCII thuần (tên đã escape unicode) nên
              // httpRequest giải mã UTF-8 vẫn đúng và giữ nguyên giới hạn byte.
              const response = await httpRequest(url, {
                http: ctx.http ?? DEFAULT_HTTP,
                signal: ctx.signal,
                headers: { Referer: 'https://xueqiu.com/' },
              });
              const payload = firstQuoted(response.body);
              if (payload === null || payload === '' || payload === 'N') {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy cổ phiếu nào khớp với "' + query + '"',
                  'Thử tên ngắn hơn, mã chứng khoán, hoặc kiểm tra lại chính tả.',
                );
              }
              let decoded;
              try {
                // Tencent escape tên thành \\uXXXX; bọc lại thành chuỗi JSON để giải.
                decoded = JSON.parse('"' + payload + '"');
              } catch {
                throw new ReachError(
                  UPSTREAM_BROKEN,
                  'Tencent trả về dữ liệu gợi ý không đọc được cho "' + query + '"',
                );
              }
              const items = [];
              for (const entry of String(decoded).split('^').slice(0, limit)) {
                const parts = entry.split('~');
                if (parts.length < 3) continue;
                const market = parts[0];
                const code = parts[1];
                const name = parts[2];
                const xq = xueqiuSymbol(market, code);
                items.push(
                  makeItem({
                    title: name + ' (' + xq + ')',
                    url: 'https://xueqiu.com/S/' + xq,
                    raw: {
                      symbol: xq,
                      name,
                      market,
                      type: parts.length > 4 ? parts[4] : null,
                    },
                  }),
                );
              }
              if (items.length === 0) {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy cổ phiếu nào khớp với "' + query + '"',
                  'Thử tên ngắn hơn, mã chứng khoán, hoặc kiểm tra lại chính tả.',
                );
              }
              return items;
            },
          },
        ];
      },
    },
  },
};
