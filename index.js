/**
 * dsh-reach — điểm vào plugin.
 *
 * Đăng ký bốn công cụ chỉ-đọc lên `ctx.tools`, mô phỏng năng lực của Agent Reach
 * (MIT, https://github.com/Panniantong/Agent-Reach) ngay trong tiến trình DSH,
 * không cần cài CLI Python bên ngoài:
 *
 *   - reach_search   tìm kiếm trên một kênh
 *   - reach_read     đọc một URL, tự chọn kênh theo tên miền
 *   - reach_run      gọi một hành động bất kỳ của một kênh
 *   - reach_channels xem danh mục kênh, hành động và trạng thái sẵn sàng
 *
 * Nguyên tắc bất di bất dịch: chỉ đọc. Không đăng bài, bình luận, thích, nhắn
 * tin, không đăng nhập thay người dùng, không đòi mật khẩu.
 *
 * @module dsh-reach
 */

import { CHANNELS, LEVEL_NOTES, channelForUrl, getChannel } from './lib/channels/index.js';
import {
  DEFAULT_HTTP,
  ReachError,
  classify,
  runAction,
  throwIfAborted,
} from './lib/runtime.js';

/** Số ký tự văn bản tối đa hiển thị cho mỗi item khi model không yêu cầu khác. */
const DEFAULT_TEXT_BUDGET = 1500;

/** Tên plugin trong Cordis. */
export const name = 'reach';

/** Dịch vụ cần có trước khi `apply` chạy. */
export const inject = ['tools'];

/** Mọi kênh bản dựng này cung cấp, suy ra từ sổ đăng ký nên không bao giờ lệch. */
const DEFAULT_CHANNELS = Object.keys(CHANNELS);

/** Giá trị mặc định của cả plugin, dùng khi dòng patch không khai báo gì. */
/**
 * Ánh xạ cấu hình dòng patch sang hình dạng nội bộ, điền mặc định và bỏ giá trị
 * không hợp lệ.
 *
 * Cố ý KHÔNG export `Config`: DSH coi một export `Config` là schema Schemastery
 * và gọi `.validate()` trên nó, nên export object thường làm entry không kích
 * hoạt được. Cùng cách với `dsh-ffmpeg`: tự resolve trong `apply`.
 *
 * @param {unknown} raw config của dòng patch
 */
function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = Array.isArray(input.channels)
    ? input.channels.filter((item) => typeof item === 'string' && item.trim() !== '')
    : DEFAULT_CHANNELS;
  return {
    timeoutMs: positiveNumber(input.timeoutMs, DEFAULT_HTTP.timeoutMs),
    maxResponseBytes: positiveNumber(input.maxResponseBytes, DEFAULT_HTTP.maxResponseBytes),
    githubTokenEnv:
      typeof input.githubTokenEnv === 'string' && input.githubTokenEnv.trim() !== ''
        ? input.githubTokenEnv.trim()
        : 'GITHUB_TOKEN',
    textBudget: positiveNumber(input.textBudget, DEFAULT_TEXT_BUDGET),
    channels: enabled.filter((item) => CHANNELS[item] !== undefined),
  };
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Đăng ký ba công cụ và trả về hàm dọn dẹp.
 *
 * @param {object} ctx ngữ cảnh Cordis (cần `ctx.tools`)
 * @param {object} [rawConfig] config của dòng patch
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const http = {
    ...DEFAULT_HTTP,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    githubToken: readToken(config.githubTokenEnv),
  };

  /** Kênh đang bật, theo đúng thứ tự khai báo. */
  const enabled = config.channels.map((item) => CHANNELS[item]);

  /**
   * Chạy một hành động trên một kênh.
   *
   * @param {object} channel
   * @param {string} action
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>} phong bì kết quả
   */
  async function dispatch(channel, action, rawArgs, signal) {
    const definition = channel.actions[action];
    if (definition === undefined) {
      throw new ReachError(
        'BAD_INPUT',
        'kênh "' + channel.name + '" không có hành động "' + action + '"',
      );
    }
    // DSH truyền `arguments` dưới dạng object chỉ-đọc (bị freeze), nên phải sao
    // chép trước khi điền giá trị mặc định hoặc ép kiểu.
    const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? { ...rawArgs }
      : {};
    validateArgs(definition.params ?? {}, args);
    const actionCtx = {
      args,
      http,
      signal,
      channel: channel.name,
      action,
    };
    if (typeof definition.backends !== 'function') {
      throw new ReachError(
        'BAD_INPUT',
        'hành động "' + action + '" của kênh "' + channel.name + '" chưa có backend',
      );
    }
    return runAction(channel.name, action, definition.backends(actionCtx));
  }

  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: 'reach_search',
      description:
        'Tìm kiếm trên một nền tảng cụ thể, chỉ đọc: web (Exa), github, v2ex, youtube, bilibili. '
        + 'Chỉ dùng khi web_search sẵn có không đủ hoặc nền tảng là mạng xã hội/中文. '
        + 'Với nội dung công khai, ưu tiên web_search trước.',
      parameters: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            enum: enabled.map((item) => item.name),
            description: 'nền tảng cần tìm',
          },
          query: { type: 'string', description: 'nội dung cần tìm' },
          limit: {
            type: 'integer',
            description: 'số kết quả tối đa (mặc định 5)',
          },
        },
        required: ['channel', 'query'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: renderEnvelope(value, config) }];
        },
      },
      async execute(args, exec) {
        throwIfAborted(exec?.signal);
        const channel = getChannel(String(args.channel));
        assertEnabled(enabled, channel);
        const definition = channel.actions.search;
        if (definition === undefined) {
          throw new ReachError(
            'BAD_INPUT',
            'kênh "' + channel.name + '" không hỗ trợ tìm kiếm',
          );
        }
        return dispatch(channel, 'search', args, exec?.signal);
      },
      isConcurrencySafe() {
        return true;
      },
      presentCall(args) {
        return {
          card: 'web',
          title: 'Tìm trên ' + String(args.channel) + ': ' + String(args.query),
          kind: 'search',
        };
      },
      presentResult(_args, result) {
        if (result?.isError === true) return undefined;
        const value = result?.value;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const items = Array.isArray(value.items) ? value.items : [];
        return {
          card: 'web',
          title: channel === undefined ? 'Kết quả' : 'Tìm trên ' + String(value.channel),
          kind: 'search',
          sources: items
            .filter((item) => typeof item?.url === 'string' && item.url !== '')
            .map((item) => ({
              url: item.url,
              ...(typeof item.title === 'string' && item.title !== ''
                ? { title: item.title }
                : {}),
              ...(typeof item.text === 'string' && item.text !== ''
                ? { snippet: item.text.slice(0, 300) }
                : {}),
              ...(typeof item.published_at === 'string' && item.published_at !== ''
                ? { publishedAt: item.published_at }
                : {}),
            })),
          truncated: false,
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'reach_read',
      description:
        'Đọc nội dung một liên kết, chia theo nền tảng: GitHub repo/issue/PR, V2EX topic, '
        + 'YouTube (kèm phụ đề), Bilibili (kèm phụ đề), hoặc trang web bất kỳ. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'URL, hoặc owner/repo với GitHub, hoặc id topic V2EX',
          },
          channel: {
            type: 'string',
            enum: enabled.map((item) => item.name),
            description: 'ép dùng một kênh cụ thể (mặc định tự nhận theo URL)',
          },
          include_comments: {
            type: 'boolean',
            description: 'lấy cả bình luận/phụ đề khi kênh hỗ trợ (mặc định true)',
          },
        },
        required: ['target'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: renderEnvelope(value, config) }];
        },
      },
      async execute(args, exec) {
        throwIfAborted(exec?.signal);
        const target = String(args.target ?? '').trim();
        if (target === '') throw new ReachError('BAD_INPUT', 'thiếu tham số target');
        const explicitChannel =
          typeof args.channel === 'string' && args.channel !== '' ? args.channel : '';
        // Khi không có URL để nhận diện, các kênh nhận id trần (v2ex topic id,
        // LinkedIn job id, YouTube video id, GitHub owner/repo) không thể tự
        // đoán — báo lỗi kèm gợi ý thay vì để lỗi SSRF khó hiểu ở tầng dưới.
        if (explicitChannel === '' && !looksLikeUrl(target)) {
          // `owner/repo` chỉ GitHub nhận, nên nhận diện riêng thay vì bắt người
          // dùng luôn khai channel cho trường hợp phổ biến này.
          const bare = looksLikeOwnerRepo(target) ? CHANNELS.github : undefined;
          if (bare === undefined) {
            throw new ReachError(
              'BAD_INPUT',
              'target "' + target + '" không phải URL nên không tự chọn được kênh; '
                + 'hãy truyền tham số channel. Kênh nhận id trần: '
                + enabled
                  .filter((item) => item.actions.read !== undefined)
                  .map((item) => item.name)
                  .join(', '),
            );
          }
          assertEnabled(enabled, bare);
          return dispatch(bare, 'read', args, exec?.signal);
        }
        const channel = explicitChannel !== '' ? getChannel(explicitChannel) : channelForUrl(target);
        assertEnabled(enabled, channel);
        if (channel.actions.read === undefined) {
          throw new ReachError('BAD_INPUT', 'kênh "' + channel.name + '" không hỗ trợ đọc');
        }
        return dispatch(channel, 'read', args, exec?.signal);
      },
      isConcurrencySafe() {
        return true;
      },
      presentCall(args) {
        return {
          card: 'web',
          title: 'Đọc ' + String(args.target),
          kind: 'fetch',
        };
      },
      presentResult(_args, result) {
        if (result?.isError === true) return undefined;
        const value = result?.value;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const first = Array.isArray(value.items) ? value.items[0] : undefined;
        return {
          card: 'web',
          title: typeof first?.title === 'string' ? first.title : 'Nội dung',
          kind: 'fetch',
          url: typeof first?.url === 'string' ? first.url : String(first?.url ?? ''),
          statusCode: 200,
          truncated: false,
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'reach_run',
      description:
        'Gọi một hành động bất kỳ của một kênh: hot/new/node/user/subtitle và cả search/read. '
        + 'Dùng reach_channels để xem kênh nào có hành động gì. Chỉ đọc.',
      parameters: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            enum: enabled.map((item) => item.name),
            description: 'nền tảng cần gọi',
          },
          action: {
            type: 'string',
            description:
              'tên hành động của kênh đó (ví dụ hot, node, user, subtitle, search, read)',
          },
          args: {
            type: 'object',
            additionalProperties: true,
            description:
              'tham số của hành động, đúng như reach_channels mô tả '
              + '(ví dụ {"limit": 5}, {"node_name": "python"}, {"username": "Livid"})',
          },
        },
        required: ['channel', 'action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: renderEnvelope(value, config) }];
        },
      },
      async execute(args, exec) {
        throwIfAborted(exec?.signal);
        const channel = getChannel(String(args.channel));
        assertEnabled(enabled, channel);
        const action = String(args.action ?? '').trim();
        if (action === '') throw new ReachError('BAD_INPUT', 'thiếu tham số action');
        const rawArgs =
          args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args)
            ? { ...args.args }
            : {};
        return dispatch(channel, action, rawArgs, exec?.signal);
      },
      isConcurrencySafe() {
        return true;
      },
      presentCall(args) {
        return {
          card: 'web',
          title: String(args.channel) + '.' + String(args.action),
          kind: 'search',
        };
      },
      presentResult(_args, result) {
        if (result?.isError === true) return undefined;
        const value = result?.value;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const items = Array.isArray(value.items) ? value.items : [];
        return {
          card: 'web',
          title: String(value.channel) + '.' + String(value.action),
          kind: 'search',
          sources: items
            .filter((item) => typeof item?.url === 'string' && item.url !== '')
            .map((item) => ({
              url: item.url,
              ...(typeof item.title === 'string' && item.title !== ''
                ? { title: item.title }
                : {}),
              ...(typeof item.text === 'string' && item.text !== ''
                ? { snippet: item.text.slice(0, 300) }
                : {}),
            })),
          truncated: false,
        };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'reach_channels',
      description:
        'Liệt kê các kênh reach đang bật, hành động từng kênh và tham số chúng nhận. '
        + 'Gọi khi chưa chắc kênh nào hỗ trợ thao tác mình cần.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const rows = Array.isArray(value?.channels) ? value.channels : [];
          const lines = ['Kênh reach đang bật (' + rows.length + '):'];
          for (const row of rows) {
            const actions = Array.isArray(row.actions) ? row.actions.join(', ') : '';
            lines.push('- ' + String(row.name) + ' [' + String(row.level ?? '') + ']: ' + actions);
            if (typeof row.description === 'string' && row.description !== '') {
              lines.push('  ' + row.description);
            }
          }
          const levels = [...new Set(rows.map((row) => String(row.level ?? 'default')))];
          if (levels.length > 0) {
            lines.push('');
            lines.push('Mức ổn định:');
            for (const level of levels) {
              const note = LEVEL_NOTES[level];
              if (note !== undefined) lines.push('- ' + level + ': ' + note);
            }
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(_args, exec) {
        throwIfAborted(exec?.signal);
        return {
          ok: true,
          channels: enabled.map((channel) => ({
            name: channel.name,
            description: channel.description,
            level: channel.level ?? 'default',
            level_note: LEVEL_NOTES[channel.level ?? 'default'] ?? '',
            actions: Object.keys(channel.actions),
            action_help: Object.fromEntries(
              Object.entries(channel.actions).map(([key, value]) => [
                key,
                {
                  description: value.description ?? '',
                  params: Object.keys(value.params ?? {}),
                },
              ]),
            ),
          })),
        };
      },
      isConcurrencySafe() {
        return true;
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** URL có scheme, hoặc trông như tên miền để kênh tự nhận diện. */
function looksLikeUrl(target) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return true;
  // "example.com/..." hoặc "github.com/a/b" — có dấu chấm ở phần host.
  const head = target.split('/')[0];
  return /^[\w-]+(\.[\w-]+)+$/.test(head);
}

/** `owner/repo` — dạng GitHub duy nhất nhận ngoài URL. */
function looksLikeOwnerRepo(target) {
  return /^[\w.-]+\/[\w.-]+$/.test(target);
}

/** Đọc token GitHub từ biến môi trường; rỗng thì để API công khai 60 lượt/giờ. */
function readToken(envName) {
  if (envName === '') return '';
  const value = process.env[envName];
  return typeof value === 'string' ? value.trim() : '';
}

/** Từ chối kênh bị tắt trong dòng patch. */
function assertEnabled(enabled, channel) {
  if (!enabled.some((item) => item.name === channel.name)) {
    throw new ReachError(
      'NEED_SETUP',
      'kênh "' + channel.name + '" đang bị tắt trong cấu hình dsh-reach',
    );
  }
}

/**
 * Kiểm tra tham số theo DSL `params` và điền giá trị mặc định.
 * Ném BAD_INPUT khi thiếu tham số bắt buộc.
 */
function validateArgs(params, args) {
  for (const [key, spec] of Object.entries(params)) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      if (spec.required === true) {
        throw new ReachError(
          'BAD_INPUT',
          'thiếu tham số bắt buộc "' + key + '" (' + (spec.description ?? '') + ')',
        );
      }
      if (spec.default !== undefined && args[key] === undefined) args[key] = spec.default;
      continue;
    }
    if (spec.type === 'integer') {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new ReachError('BAD_INPUT', 'tham số "' + key + '" phải là số nguyên');
      }
      args[key] = Math.trunc(numeric);
    } else if (typeof value !== 'string') {
      args[key] = String(value);
    }
  }
}

/** Kết xuất phong bì thành văn bản dễ đọc cho model. */
function renderEnvelope(value, options) {
  const render = { textBudget: options?.textBudget ?? DEFAULT_TEXT_BUDGET };
  if (value === null || typeof value !== 'object') return String(value);
  if (value.ok !== true) {
    const error = value.error ?? {};
    const lines = [
      'Lỗi ' + String(error.code ?? 'UNKNOWN') + ': ' + String(error.message ?? ''),
    ];
    if (typeof error.hint === 'string' && error.hint !== '') lines.push(error.hint);
    const attempts = Array.isArray(value.meta?.attempts) ? value.meta.attempts : [];
    if (attempts.length > 0) {
      lines.push(
        'Đã thử: ' +
          attempts
            .map((item) => String(item.backend) + ' → ' + String(item.result))
            .join(', '),
      );
    }
    return lines.join('\n');
  }
  const items = Array.isArray(value.items) ? value.items : [];
  const lines = [
    'Kênh ' +
      String(value.channel) +
      ' · ' +
      String(value.action) +
      ' · backend ' +
      String(value.backend ?? '') +
      ' · ' +
      String(value.meta?.elapsed_ms ?? 0) +
      'ms · ' +
      items.length +
      ' kết quả',
  ];
  items.forEach((item, index) => {
    lines.push('');
    lines.push('[' + (index + 1) + '] ' + String(item.title ?? '(không tiêu đề)'));
    if (typeof item.url === 'string' && item.url !== '') lines.push('URL: ' + item.url);
    if (typeof item.author === 'string' && item.author !== '') {
      lines.push('Tác giả: ' + item.author);
    }
    if (typeof item.published_at === 'string' && item.published_at !== '') {
      lines.push('Thời gian: ' + item.published_at);
    }
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text !== '') lines.push(clipText(text, render));
  });
  return lines.join('\n');
}

/** Cắt văn bản theo hạn mức của lượt gọi, kèm ghi chú rõ ràng. */
function clipText(text, options) {
  const budget = options.textBudget;
  if (!Number.isFinite(budget) || text.length <= budget) return text;
  return text.slice(0, budget).trimEnd() + '\n…(đã cắt bớt, còn ' + (text.length - budget) + ' ký tự)';
}
