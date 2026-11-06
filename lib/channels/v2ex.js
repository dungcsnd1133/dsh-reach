/**
 * Kênh `v2ex` — API JSON công khai của V2EX: chủ đề nóng, chủ đề theo node,
 * đọc topic kèm trả lời, và hồ sơ thành viên.
 *
 * Port từ `agent_reach/channels/v2ex.py` (Agent Reach 1.6.1, MIT). Không cần
 * API key, không đăng nhập, chỉ đọc dữ liệu công khai.
 *
 * @module dsh-reach/channels/v2ex
 */

import {
  BAD_INPUT,
  NOT_FOUND,
  ReachError,
  UPSTREAM_BROKEN,
  getJson,
  hostMatches,
  makeItem,
  unixToIso,
} from '../runtime.js';

/** Gốc API công khai; mọi đường dẫn trong module đều nối vào đây. */
const API_BASE = 'https://www.v2ex.com/api';

/** Giới hạn số ký tự của `text` khi đọc một topic nhiều trả lời. */
const MAX_TEXT_CHARS = 50000;

/**
 * Ghép URL API và mã hóa từng tham số, để giá trị do người dùng nhập không
 * thể chèn thêm tham số truy vấn khác.
 *
 * @param {string} path đường dẫn tuyệt đối trong `/api`
 * @param {Record<string, unknown>} params tham số truy vấn
 * @returns {string}
 */
function v2exUrl(path, params) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(
      ([key, value]) =>
        encodeURIComponent(key) + '=' + encodeURIComponent(String(value)),
    )
    .join('&');
  return API_BASE + path + '?' + query;
}

/** Chuẩn hóa `limit`: số nguyên dương, mặc định 10. */
function normalizeLimit(value, fallback = 10) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.trunc(numeric) < 1) {
    throw new ReachError(
      BAD_INPUT,
      'tham số "limit" phải là số nguyên dương',
      'Truyền limit là số nguyên từ 1 trở lên, ví dụ 10.',
    );
  }
  return Math.trunc(numeric);
}

const TOPIC_URL_RE = /^(?:https?:\/\/)?(?:www\.)?v2ex\.com\/t\/(\d+)/i;

/**
 * Nhận id topic từ một link `https://www.v2ex.com/t/<id>` hoặc từ chính id.
 *
 * @param {unknown} target
 * @returns {number}
 * @throws {ReachError} BAD_INPUT khi không nhận dạng được
 */
function parseTopicId(target) {
  const text = String(target ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = TOPIC_URL_RE.exec(text);
  if (match !== null) return Number(match[1]);
  throw new ReachError(
    BAD_INPUT,
    'target phải là link topic V2EX (https://www.v2ex.com/t/<id>) hoặc id số',
    'Ví dụ: https://www.v2ex.com/t/1000 hoặc 1000.',
  );
}

/**
 * Dựng item từ một object topic của V2EX.
 *
 * @param {object} topic
 * @param {string|null} [text] nội dung thay thế cho `content`
 * @param {unknown} [raw] dữ liệu thô kèm theo
 */
function topicItem(topic, text = null, raw = null) {
  const member = topic?.member ?? {};
  return makeItem({
    title: topic?.title ?? null,
    url: topic?.url ?? null,
    author: member?.username ?? null,
    publishedAt: unixToIso(topic?.created),
    text: text === null ? (topic?.content ?? null) : text,
    raw: raw === null ? topic : raw,
  });
}

/** Lấy nội dung topic; không phải mảng thì là lỗi nền tảng. */
function asTopicList(payload, action) {
  if (!Array.isArray(payload)) {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'V2EX trả về dữ liệu không phải danh sách topic cho hành động "' + action + '"',
    );
  }
  return payload;
}

/** Cắt văn bản dài một cách có ý thức, kèm dấu hiệu đã cắt. */
function clampText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '\n…(đã cắt bớt)';
}

/** Ghép nội dung topic với từng trả lời theo đúng định dạng của bản Python. */
function topicWithReplies(topic, replies) {
  const lines = [topic?.content ?? ''];
  for (const reply of replies) {
    const who = reply?.member?.username ?? '';
    lines.push('\n@' + who + ': ' + (reply?.content ?? ''));
  }
  return clampText(lines.join('\n').trim());
}

export const channel = {
  name: 'v2ex',
  description: 'V2EX: chủ đề nóng, chủ đề theo node, đọc topic kèm trả lời và hồ sơ thành viên',
  level: 'default',

  /** Kênh nhận URL thuộc v2ex.com. */
  canHandle(url) {
    return hostMatches(url, 'v2ex.com');
  },

  actions: {
    hot: {
      description: 'Liệt kê các chủ đề đang nóng nhất hôm nay trên V2EX',
      params: {
        limit: {
          type: 'integer',
          required: false,
          default: 10,
          description: 'số chủ đề tối đa',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'v2ex-api',
            async run() {
              const limit = normalizeLimit(ctx.args.limit);
              const { json } = await getJson(API_BASE + '/topics/hot.json', {
                http: ctx.http,
                signal: ctx.signal,
              });
              const topics = asTopicList(json, 'hot');
              return topics.slice(0, limit).map((topic) => topicItem(topic));
            },
          },
        ];
      },
    },

    node: {
      description: 'Liệt kê các chủ đề mới nhất trong một node V2EX (ví dụ: python, jobs)',
      params: {
        node_name: {
          type: 'string',
          required: true,
          description: 'tên node, ví dụ: python, programmer, jobs',
        },
        limit: {
          type: 'integer',
          required: false,
          default: 10,
          description: 'số chủ đề tối đa',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'v2ex-api',
            async run() {
              const nodeName = String(ctx.args.node_name ?? '').trim();
              if (nodeName === '') {
                throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "node_name"');
              }
              const limit = normalizeLimit(ctx.args.limit);
              const { json } = await getJson(
                v2exUrl('/topics/show.json', { node_name: nodeName, page: 1 }),
                { http: ctx.http, signal: ctx.signal },
              );
              if (!Array.isArray(json)) {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy node V2EX: ' + nodeName,
                  'Kiểm tra lại tên node, ví dụ: python, programmer, jobs.',
                );
              }
              return json.slice(0, limit).map((topic) => topicItem(topic));
            },
          },
        ];
      },
    },

    read: {
      description: 'Đọc một chủ đề V2EX kèm toàn bộ trả lời trên trang đầu',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'link topic (https://www.v2ex.com/t/<id>) hoặc id topic',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'v2ex-api',
            async run() {
              const topicId = parseTopicId(ctx.args.target);
              const { json } = await getJson(
                v2exUrl('/topics/show.json', { id: topicId }),
                { http: ctx.http, signal: ctx.signal },
              );
              const topic = Array.isArray(json) ? json[0] : json;
              if (topic === undefined || topic === null || typeof topic !== 'object' || !topic.id) {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy topic V2EX: ' + topicId,
                  'Kiểm tra lại id hoặc liên kết topic.',
                );
              }
              const { json: repliesPayload } = await getJson(
                v2exUrl('/replies/show.json', { topic_id: topicId, page: 1 }),
                { http: ctx.http, signal: ctx.signal },
              );
              const replies = Array.isArray(repliesPayload) ? repliesPayload : [];
              return [
                topicItem(topic, topicWithReplies(topic, replies), {
                  topic,
                  replies,
                }),
              ];
            },
          },
        ];
      },
    },

    user: {
      description: 'Xem hồ sơ công khai của một thành viên V2EX',
      params: {
        username: {
          type: 'string',
          required: true,
          description: 'tên đăng nhập V2EX',
        },
      },
      backends(ctx) {
        return [
          {
            label: 'v2ex-api',
            async run() {
              const username = String(ctx.args.username ?? '').trim();
              if (username === '') {
                throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "username"');
              }
              const { json } = await getJson(
                v2exUrl('/members/show.json', { username }),
                { http: ctx.http, signal: ctx.signal },
              );
              if (json === null || typeof json !== 'object' || Array.isArray(json) || !json.id) {
                throw new ReachError(
                  NOT_FOUND,
                  'không tìm thấy người dùng V2EX: ' + username,
                  'Kiểm tra lại tên đăng nhập.',
                );
              }
              return [
                makeItem({
                  title: json.username || username,
                  url: json.url ?? null,
                  author: json.username || username,
                  publishedAt: unixToIso(json.created),
                  text: json.bio ?? null,
                  raw: json,
                }),
              ];
            },
          },
        ];
      },
    },
  },
};
