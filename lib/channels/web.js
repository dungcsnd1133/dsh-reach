/**
 * Kênh `web` — tìm kiếm (Exa) và đọc trang bất kỳ (Jina Reader, dự phòng Exa).
 *
 * Đây là kênh dự phòng: agent nào đã có web_search/web_fetch hoạt động thì nên
 * dùng trước. Port từ `agent_reach/channels/web.py` (MIT).
 *
 * Kênh này là ví dụ tham chiếu cho các kênh khác: nó chỉ export dữ liệu và các
 * hàm `run`, không tự dựng phong bì kết quả.
 *
 * @module dsh-reach/channels/web
 */

import {
  BAD_INPUT,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  ReachError,
  UPSTREAM_BROKEN,
  getJson,
  httpRequest,
  makeItem,
  normalizePublicHttpUrl,
} from '../runtime.js';

const EXA_MCP = 'https://mcp.exa.ai/mcp';

/** Giới hạn kích thước riêng của kênh web, khớp bản Python. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Số byte đầu dùng để nhận diện trang chống bot. */
const ANTIBOT_SCAN_BYTES = 4096;

const EXA_LIMIT_RE =
  /\b429\b|rate[ _-]?limit|too many requests|\bquota\b|(?:usage|request|daily|monthly|free)[ _-]+limit|(?:credit|credits|balance).{0,40}(?:exhaust|deplet|insufficient|exceed|reach)|(?:out of|insufficient|exhausted).{0,20}credits?/i;

/** Nhận diện trang xác minh Jina/Cloudflare với độ tin cậy cao. */
function isAntibotPage(body) {
  const sample = body.slice(0, ANTIBOT_SCAN_BYTES).toLowerCase();
  const jinaCaptchaWarning = sample.includes('warning:') && sample.includes('requiring captcha');
  const challengeStructure =
    sample.includes('title: just a moment...') ||
    sample.includes('## performing security verification') ||
    sample.includes('title: attention required! | cloudflare');
  const cloudflareBlock =
    sample.includes('title: attention required! | cloudflare') &&
    (sample.includes('ray id') || sample.includes('/cdn-cgi/challenge-platform/'));
  return (jinaCaptchaWarning && challengeStructure) || cloudflareBlock;
}

/** Đổi lỗi Exa thành ReachError với mã phù hợp. */
function exaError(text, rpcCode) {
  if (rpcCode === -32602 || rpcCode === '-32602') {
    return new ReachError(BAD_INPUT, 'Exa từ chối tham số: ' + String(text).slice(0, 300));
  }
  if (rpcCode === 429 || rpcCode === '429' || EXA_LIMIT_RE.test(String(text))) {
    return new ReachError(
      RATE_LIMITED,
      'Exa: ' + String(text).slice(0, 300),
      'Hạn mức tìm kiếm miễn phí của Exa đã cạn. Dùng web_search sẵn có của agent hoặc chờ rồi thử lại.',
    );
  }
  return new ReachError(UPSTREAM_BROKEN, 'Exa: ' + String(text).slice(0, 300));
}

/**
 * Gọi một tool trên MCP công khai của Exa (không cần key) và trả về text.
 *
 * Một lần thử lại chỉ dành cho trường hợp truyền tải bị cắt cụt; không bao giờ
 * thử lại HTTP 429/403 hay lỗi tool.
 */
async function exaCall(tool, args, ctx) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  const response = await httpRequest(EXA_MCP, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    http: ctx.http,
    signal: ctx.signal,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  // Phản hồi SSE: lấy dòng `data:` cuối cùng; nếu không có thì coi cả là JSON.
  const dataLines = response.body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : response.body;

  let message;
  try {
    message = JSON.parse(payload);
  } catch {
    throw new ReachError(UPSTREAM_BROKEN, 'Exa trả về phản hồi không đọc được');
  }
  if (message.error !== undefined) {
    const text = String(message.error?.message ?? message.error);
    throw exaError(text, message.error?.code);
  }
  const result = message.result ?? {};
  const text = (result.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
  if (result.isError === true) throw exaError(text, undefined);
  return text;
}

const EXA_HEADER_RE = /^(Title|URL|Published|Author):\s*(.*)$/;

/** Tách các khối `Title: / URL: / Published: / Author:` của Exa thành item. */
function parseExaText(text) {
  const items = [];
  const blocks = ('\n' + String(text).trim()).split(/\n(?=Title: )/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block.startsWith('Title:')) continue;
    const fields = {};
    const lines = block.split('\n');
    let index = 0;
    while (index < lines.length) {
      const match = EXA_HEADER_RE.exec(lines[index]);
      if (match === null) break;
      fields[match[1].toLowerCase()] = match[2].trim();
      index += 1;
    }
    const body = [];
    for (const line of lines.slice(index)) {
      const trimmed = line.trim();
      if (trimmed === 'Highlights:' || trimmed === 'Text:') continue;
      body.push(line);
    }
    const na = (value) => (value === undefined || value === '' || value === 'N/A' ? null : value);
    items.push(
      makeItem({
        title: na(fields.title),
        url: na(fields.url),
        author: na(fields.author),
        publishedAt: na(fields.published),
        text: body.join('\n').trim(),
        raw: fields,
      }),
    );
  }
  return items;
}

/** Tách phản hồi Jina Reader thành item. */
function parseJina(url, body) {
  const title = /^Title:\s*(.*)$/m.exec(body);
  const published = /^Published Time:\s*(.*)$/m.exec(body);
  const marker = 'Markdown Content:';
  const content = body.includes(marker) ? body.split(marker, 2)[1] : body;
  return makeItem({
    title: title === null ? null : title[1].trim(),
    url,
    publishedAt: published === null ? null : published[1].trim(),
    text: content.trim(),
  });
}

/** Đọc một trang qua Jina Reader và trả Markdown toàn văn. */
async function jinaRead(url, ctx) {
  const response = await httpRequest('https://r.jina.ai/' + url, {
    headers: { Accept: 'text/plain' },
    http: ctx.http,
    signal: ctx.signal,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  if (isAntibotPage(response.body)) {
    throw new ReachError(
      PLATFORM_BLOCKED,
      'Jina Reader trả về trang xác minh chống bot nên không lấy được nội dung đích; hãy dùng công cụ riêng của trang hoặc trình duyệt.',
    );
  }
  return response.body;
}

/** Dựng danh sách backend cho một hành động theo thứ tự ưu tiên. */
function exaSearchBackend(ctx) {
  return {
    label: 'exa',
    async run() {
      const text = await exaCall(
        'web_search_exa',
        { query: ctx.query, objective: ctx.query, numResults: ctx.limit },
        ctx,
      );
      const items = parseExaText(text);
      if (items.length === 0) {
        // Không báo "tìm thấy 0 kết quả" cho một phản hồi không nhận dạng được.
        throw new ReachError(UPSTREAM_BROKEN, 'Exa không trả về kết quả nhận dạng được');
      }
      return items.slice(0, ctx.limit);
    },
  };
}

function jinaReadBackend(url, ctx) {
  return {
    label: 'jina',
    async run() {
      const body = await jinaRead(url, ctx);
      return [parseJina(url, body)];
    },
  };
}

function exaReadBackend(url, ctx) {
  return {
    label: 'exa',
    async run() {
      const text = await exaCall(
        'web_fetch_exa',
        { urls: [url], maxCharacters: 20000 },
        ctx,
      );
      const items = parseExaText(text);
      if (items.length > 0) {
        items[0].url = items[0].url || url;
        return items.slice(0, 1);
      }
      if (text.trim() === '') throw new ReachError(UPSTREAM_BROKEN, 'Exa không trả về nội dung');
      return [makeItem({ url, text: text.trim() })];
    },
  };
}

export const channel = {
  name: 'web',
  description: 'Tìm kiếm web và đọc trang bất kỳ (dự phòng khi công cụ sẵn có không dùng được)',
  level: 'default',

  /** Kênh dự phòng — nhận mọi URL. */
  canHandle() {
    return true;
  },

  actions: {
    search: {
      description: 'Tìm kiếm web (Exa semantic search, không cần API key)',
      params: {
        query: { type: 'string', required: true, description: 'nội dung cần tìm' },
        limit: {
          type: 'integer',
          required: false,
          default: 5,
          description: 'số kết quả tối đa',
        },
      },
      backends(ctx) {
        return [exaSearchBackend({ ...ctx, query: ctx.args.query, limit: ctx.args.limit ?? 5 })];
      },
    },

    read: {
      description: 'Đọc một trang web dưới dạng văn bản sạch',
      params: {
        target: { type: 'string', required: true, description: 'URL của trang' },
      },
      backends(ctx) {
        const url = normalizePublicHttpUrl(ctx.args.target);
        return [jinaReadBackend(url, ctx), exaReadBackend(url, ctx)];
      },
    },
  },
};
