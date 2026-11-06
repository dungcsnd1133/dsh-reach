/**
 * Kênh `github` — repository, issue và pull request qua `gh` CLI, dự phòng API
 * công khai của GitHub.
 *
 * Bản port của `agent_reach/channels/github.py` (Agent Reach 1.6.1, MIT) sang
 * JavaScript/Node thuần. Kênh chỉ đọc: không tạo issue, không bình luận, không
 * đăng nhập thay người dùng, không ghi gì lên GitHub.
 *
 * Thứ tự backend: `gh` (nếu có trên PATH và có thông tin đăng nhập), rồi
 * `github-api` (60 lượt/giờ khi không có token; 5000 lượt/giờ nếu
 * `ctx.http.githubToken` có giá trị). Mọi lần gọi mạng của backend dự phòng đi
 * qua `httpRequest` của `../runtime.js` nên vẫn có giới hạn byte, timeout và
 * chặn đích không công khai.
 *
 * @module dsh-reach/channels/github
 */

import { execFile } from 'node:child_process';

import {
  BAD_INPUT,
  NEED_SETUP,
  NOT_FOUND,
  RATE_LIMITED,
  ReachError,
  TIMEOUT,
  UPSTREAM_BROKEN,
  hostMatches,
  httpRequest,
  makeItem,
  scrubUrlCredentials,
  throwIfAborted,
} from '../runtime.js';

/** Gốc API công khai của GitHub. */
const API_BASE = 'https://api.github.com';

/** README dài hơn mức này bị cắt, khớp `_README_MAX_CHARS` của bản Python. */
const MAX_README_CHARS = 50000;

/** Số bình luận tối đa lấy cho một issue/PR, khớp bản Python. */
const MAX_COMMENTS = 50;

/** `per_page` lớn nhất mà API tìm kiếm của GitHub chấp nhận. */
const MAX_PER_PAGE = 100;

const ACCEPT_JSON = 'application/vnd.github+json';
const ACCEPT_RAW = 'application/vnd.github.raw';

/**
 * owner/repo, link repo, hoặc link issue/PR — port `_TARGET_RE` của bản Python.
 * Nhóm 3 chỉ có khi target là link issue/pull request kèm số.
 */
const TARGET_RE =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:issues|pull)\/(\d+))?\/?(?:[?#].*)?$/;

/**
 * Biến môi trường chỉ-đọc cho `gh`.
 *
 * Bản Python đặt đúng bộ này để `gh` không ghi file trạng thái/telemetry; giữ
 * nguyên để kênh vẫn tôn trọng tinh thần "không ghi đĩa".
 */
const GH_READ_ONLY_ENV = {
  GH_TELEMETRY: 'false',
  DO_NOT_TRACK: 'true',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
};

/** Rút gọn một dòng thông báo lỗi của nền tảng, bỏ thông tin đăng nhập trong URL. */
function clipped(text, limit = 300) {
  return scrubUrlCredentials(String(text ?? '')).trim().slice(0, limit);
}

/** Dòng có nội dung cuối cùng của stderr, giống `CommandFailed` bên Python. */
function lastMeaningfulLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== '') return clipped(lines[index]);
  }
  return '';
}

/** Parse JSON, đổi phản hồi hỏng thành UPSTREAM_BROKEN thay vì lỗi trơn. */
function parseJson(source, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ReachError(UPSTREAM_BROKEN, source + ' trả về JSON không đọc được');
  }
}

/**
 * Tách target của hành động `read` thành owner/repo và số issue/PR (nếu có).
 *
 * @param {unknown} target owner/repo, link repo, hoặc link issue/pull request
 * @returns {{owner: string, repo: string, number: number|null}}
 * @throws {ReachError} BAD_INPUT khi target không đúng dạng
 */
function parseTarget(target) {
  const match = TARGET_RE.exec(String(target ?? '').trim());
  if (match === null) {
    throw new ReachError(
      BAD_INPUT,
      'target phải là owner/repo hoặc liên kết repo/issue/pull request trên github.com',
    );
  }
  const [, owner, repo, number] = match;
  return { owner, repo, number: number === undefined ? null : Number(number) };
}

/**
 * Kiểm tra `limit` và trả số nguyên dương.
 *
 * `validateArgs` ở `index.js` đã ép int và điền default, nhưng backend vẫn tự
 * kiểm để gọi trực tiếp (kiểm thử, nhúng) không gửi `per_page` vô nghĩa.
 */
function normaliseLimit(value) {
  const limit = value === undefined || value === null || value === '' ? 5 : Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ReachError(BAD_INPUT, 'tham số "limit" phải là số nguyên dương');
  }
  return limit;
}

/** Token GitHub do profile cấu hình, hoặc chuỗi rỗng. */
function githubToken(ctx) {
  const token = ctx.http?.githubToken;
  return typeof token === 'string' ? token.trim() : '';
}

/** Ngân sách thời gian cho một lần gọi, lấy từ `ctx.http`, không hardcode. */
function resolveTimeoutMs(ctx, override) {
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  const base = Number(ctx.http?.timeoutMs);
  return Number.isFinite(base) && base > 0 ? Math.floor(base) : undefined;
}

/**
 * Chia đôi ngân sách cho các bước phụ, đúng như `timeout / 2` của bản Python
 * (`read` gọi info rồi README, hoặc issue rồi comments).
 */
function halfTimeoutMs(ctx) {
  const base = Number(ctx.http?.timeoutMs);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  return Math.max(1, Math.floor(base / 2));
}

/** Giới hạn bộ đệm stdout của `gh`, lấy từ `ctx.http.maxResponseBytes`. */
function resolveMaxBuffer(ctx) {
  const base = Number(ctx.http?.maxResponseBytes);
  return Number.isFinite(base) && base > 0 ? Math.floor(base) : undefined;
}

/**
 * Ánh xạ lỗi chạy `gh` sang ReachError.
 *
 * Thứ tự kiểm khớp `_gh_get` của bản Python: thiếu binary, quá thời gian, 404,
 * chưa đăng nhập, giới hạn tần suất, còn lại là UPSTREAM_BROKEN.
 */
function ghFailure(error, stderr, ctx, budget) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    const reason = ctx.signal?.reason;
    return reason instanceof ReachError ? reason : new ReachError(TIMEOUT, 'lệnh gh đã bị hủy');
  }
  if (error?.code === 'ENOENT') {
    return new ReachError(
      NEED_SETUP,
      'thiếu chương trình gh trên PATH; cài GitHub CLI hoặc để plugin dùng API công khai GitHub',
    );
  }
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new ReachError(UPSTREAM_BROKEN, 'phản hồi của gh vượt quá giới hạn bộ đệm của kênh');
  }
  if (error?.killed === true || typeof error?.signal === 'string') {
    return new ReachError(
      TIMEOUT,
      budget === undefined ? 'gh không kết thúc kịp' : 'gh không kết thúc trong ' + budget + 'ms',
    );
  }

  const text = String(stderr ?? '');
  const lowered = text.toLowerCase();
  const last = lastMeaningfulLine(text);

  if (lowered.includes('http 404') || lowered.includes('not found')) {
    return new ReachError(
      NOT_FOUND,
      'gh báo không tìm thấy nội dung' + (last === '' ? '' : ': ' + last),
    );
  }
  if (
    lowered.includes('gh auth login') ||
    lowered.includes('to get started with github cli') ||
    lowered.includes('authentication') ||
    lowered.includes('bad credentials') ||
    lowered.includes('http 401')
  ) {
    return new ReachError(
      NEED_SETUP,
      'gh chưa có thông tin đăng nhập dùng được nên chuyển sang API công khai GitHub' +
        (last === '' ? '' : ': ' + last),
    );
  }
  if (
    lowered.includes('rate limit') ||
    lowered.includes('secondary rate') ||
    lowered.includes('http 429')
  ) {
    return new ReachError(
      RATE_LIMITED,
      'gh báo giới hạn tần suất: ' + (last || 'không rõ chi tiết'),
      'Hạn mức công khai của GitHub là 60 lượt/giờ khi không có token. Chờ hạn mức đặt lại rồi thử lại; đặt GITHUB_TOKEN để nâng lên 5000 lượt/giờ.',
    );
  }
  return new ReachError(
    UPSTREAM_BROKEN,
    'gh thoát với mã ' + String(error?.code ?? 'không rõ') + ': ' + (last || 'không có thông báo lỗi'),
  );
}

/**
 * Chạy `gh` (chỉ đọc) và trả stdout.
 *
 * @param {string[]} args argv, không qua shell
 * @param {object} ctx ngữ cảnh hành động
 * @param {number|undefined} timeoutMs ngân sách riêng
 * @returns {Promise<string>}
 */
function runGh(args, ctx, timeoutMs) {
  throwIfAborted(ctx.signal);
  const budget = resolveTimeoutMs(ctx, timeoutMs);
  const maxBuffer = resolveMaxBuffer(ctx);
  const execOptions = {
    encoding: 'utf8',
    env: { ...process.env, ...GH_READ_ONLY_ENV },
    windowsHide: true,
    ...(budget === undefined ? {} : { timeout: budget }),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  return new Promise((resolve, reject) => {
    execFile('gh', args, execOptions, (error, stdout, stderr) => {
      if (error === null) {
        resolve(String(stdout ?? ''));
        return;
      }
      reject(ghFailure(error, stderr, ctx, budget));
    });
  });
}

/** Gọi `gh api` với header Accept cho trước, trả stdout thô. */
function ghApiGet(ctx, path, { accept = ACCEPT_JSON, timeoutMs } = {}) {
  return runGh(['api', '-H', 'Accept: ' + accept, path], ctx, timeoutMs);
}

/** Header của GitHub REST, kèm Bearer nếu profile có token. */
function apiHeaders(ctx, accept) {
  const headers = { Accept: accept };
  const token = githubToken(ctx);
  if (token !== '') headers.Authorization = 'Bearer ' + token;
  return headers;
}

/**
 * Dựng ReachError từ phản hồi HTTP không thành công của GitHub REST.
 *
 * Quy ước của hợp đồng: 404 → NOT_FOUND; 429 hoặc 403 kèm dấu hiệu hết hạn mức
 * → RATE_LIMITED; 403 khác → UPSTREAM_BROKEN.
 *
 * @returns {ReachError|null} null khi phản hồi thành công
 */
function apiFailure(response, ctx) {
  const status = Number(response.status);
  if (!Number.isFinite(status) || status < 400) return null;

  let detail = '';
  try {
    const parsed = JSON.parse(response.body);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.message === 'string') {
      detail = clipped(parsed.message, 200);
    }
  } catch {
    // Phản hồi lỗi không phải JSON: chỉ còn mã trạng thái để nói.
  }
  const suffix = detail === '' ? '' : ': ' + detail;
  const remaining = response.headers?.get?.('x-ratelimit-remaining') ?? null;
  const retryAfter = response.headers?.get?.('retry-after') ?? null;
  const hasToken = githubToken(ctx) !== '';

  if (status === 404) {
    return new ReachError(NOT_FOUND, 'GitHub không tìm thấy nội dung (HTTP 404)' + suffix);
  }
  if (status === 429 || (status === 403 && (remaining === '0' || (retryAfter ?? '') !== ''))) {
    return new ReachError(
      RATE_LIMITED,
      'GitHub API báo giới hạn tần suất (HTTP ' +
        status +
        ')' +
        (hasToken ? '' : ' — hạn mức công khai là 60 lượt/giờ khi không có token') +
        suffix,
      'Chờ hạn mức đặt lại rồi thử lại; đặt GITHUB_TOKEN để nâng lên 5000 lượt/giờ. Không đổi backend.',
    );
  }
  if (status === 401) {
    return new ReachError(
      NEED_SETUP,
      'token GitHub không hợp lệ hoặc đã hết hạn (HTTP 401)' + suffix,
    );
  }
  if (status === 403) {
    return new ReachError(
      UPSTREAM_BROKEN,
      'GitHub API từ chối yêu cầu (HTTP 403, không có dấu hiệu giới hạn tần suất)' + suffix,
    );
  }
  if (status === 422) {
    return new ReachError(BAD_INPUT, 'GitHub API từ chối tham số truy vấn (HTTP 422)' + suffix);
  }
  return new ReachError(UPSTREAM_BROKEN, 'GitHub API trả về HTTP ' + status + suffix);
}

/**
 * Adapter đọc dữ liệu GitHub — hai hiện thực cùng một giao diện:
 * `raw(path, options)` trả văn bản thô, `json(path, options)` trả JSON đã parse.
 * `options.timeoutMs` cho phép chia ngân sách như bản Python.
 */
function ghAdapter(ctx) {
  const get = (path, options = {}) => ghApiGet(ctx, path, options);
  return {
    label: 'gh',
    raw: (path, options = {}) => get(path, { ...options, accept: ACCEPT_RAW }),
    async json(path, options = {}) {
      const text = await get(path, { ...options, accept: ACCEPT_JSON });
      return parseJson('gh', text);
    },
  };
}

function apiAdapter(ctx) {
  async function raw(path, options = {}) {
    const timeoutMs = options.timeoutMs;
    const response = await httpRequest(API_BASE + path, {
      headers: apiHeaders(ctx, options.accept ?? ACCEPT_RAW),
      http: ctx.http,
      signal: ctx.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const failure = apiFailure(response, ctx);
    if (failure !== null) throw failure;
    return response.body;
  }
  return {
    label: 'github-api',
    raw,
    async json(path, options = {}) {
      return parseJson('GitHub API', await raw(path, { ...options, accept: ACCEPT_JSON }));
    },
  };
}

/** Dựng item từ một repository của GitHub API, khớp `_repo_item` bản Python. */
function repoItem(repo, readmeText = null) {
  const raw = {};
  for (const key of [
    'description',
    'stargazers_count',
    'forks_count',
    'language',
    'topics',
    'pushed_at',
    'open_issues_count',
    'archived',
  ]) {
    raw[key] = repo?.[key] ?? null;
  }
  raw.license = repo?.license?.spdx_id ?? null;

  return makeItem({
    title: repo?.full_name ?? null,
    url: repo?.html_url ?? null,
    author: repo?.owner?.login ?? null,
    publishedAt: repo?.created_at ?? null,
    // Python dùng `readme or description`: README rỗng cũng rơi về description.
    text: readmeText || repo?.description || null,
    raw,
  });
}

/** Tìm repository, khớp `_search` bản Python. */
async function searchRepositories(adapter, ctx, { query, limit: rawLimit }) {
  throwIfAborted(ctx.signal);
  if (query === '') {
    throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "query"');
  }
  const limit = normaliseLimit(rawLimit);
  const params = new URLSearchParams({
    q: query,
    per_page: String(Math.min(limit, MAX_PER_PAGE)),
  });
  const data = await adapter.json('/search/repositories?' + params.toString());
  if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new ReachError(UPSTREAM_BROKEN, 'GitHub trả về kết quả tìm kiếm không có trường "items"');
  }
  const found = data.items.slice(0, limit);
  if (found.length === 0) {
    // runAction coi mảng rỗng là UPSTREAM_BROKEN; "không khớp gì" là kết luận
    // thật sự nên báo NOT_FOUND, mã dừng fallback để khỏi gọi lại vô ích.
    throw new ReachError(
      NOT_FOUND,
      'GitHub không có repository nào khớp truy vấn "' + clipped(query, 200) + '"',
    );
  }
  return found.map((repo) => repoItem(repo));
}

/** Đọc repository kèm README, hoặc issue/PR kèm bình luận; khớp `_read` Python. */
async function readGithub(adapter, ctx, { target }) {
  throwIfAborted(ctx.signal);
  if (target === '') {
    throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "target"');
  }
  const { owner, repo, number } = parseTarget(target);
  const half = halfTimeoutMs(ctx);
  const budget = half === undefined ? {} : { timeoutMs: half };

  if (number === null) {
    const info = await adapter.json(`/repos/${owner}/${repo}`, budget);
    let readmeText = null;
    try {
      const readme = await adapter.raw(`/repos/${owner}/${repo}/readme`, budget);
      readmeText = String(readme).slice(0, MAX_README_CHARS);
    } catch (error) {
      // Thiếu README không phải lỗi của repository; mọi lỗi khác vẫn nổi lên.
      if (!(error instanceof ReachError) || error.code !== NOT_FOUND) throw error;
      readmeText = null;
    }
    return [repoItem(info, readmeText)];
  }

  const issue = await adapter.json(`/repos/${owner}/${repo}/issues/${number}`, budget);
  const rawComments = await adapter.json(
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}`,
    budget,
  );
  const comments = Array.isArray(rawComments) ? rawComments.slice(0, MAX_COMMENTS) : [];

  const parts = [issue?.body ?? ''];
  for (const comment of comments) {
    parts.push('\n@' + (comment?.user?.login ?? '') + ': ' + (comment?.body ?? ''));
  }

  return [
    makeItem({
      title: issue?.title ?? null,
      url: issue?.html_url ?? null,
      author: issue?.user?.login ?? null,
      publishedAt: issue?.created_at ?? null,
      text: parts.join('\n').trim(),
      raw: {
        state: issue?.state ?? null,
        labels: Array.isArray(issue?.labels)
          ? issue.labels.map((label) => label?.name ?? null)
          : [],
        comments: issue?.comments ?? null,
        is_pull_request: Object.prototype.hasOwnProperty.call(issue ?? {}, 'pull_request'),
      },
    }),
  ];
}

/** Danh sách backend theo thứ tự ưu tiên: gh rồi github-api. */
function orderedBackends(ctx, run) {
  const gh = ghAdapter(ctx);
  const api = apiAdapter(ctx);
  return [
    {
      label: 'gh',
      async run() {
        return run(gh);
      },
    },
    {
      label: 'github-api',
      async run() {
        return run(api);
      },
    },
  ];
}

export const channel = {
  name: 'github',
  description:
    'Kho GitHub: tìm repository, đọc repo kèm README, đọc issue và pull request kèm bình luận',
  level: 'default',

  /** Mọi URL thuộc github.com do kênh này đọc. */
  canHandle(url) {
    return hostMatches(url, 'github.com');
  },

  actions: {
    search: {
      description: 'Tìm repository trên GitHub',
      params: {
        query: {
          type: 'string',
          required: true,
          description: 'nội dung cần tìm (từ khóa, tên repository, chủ đề…)',
        },
        limit: {
          type: 'integer',
          required: false,
          default: 5,
          description: 'số kết quả tối đa',
        },
      },
      backends(ctx) {
        const query = String(ctx.args?.query ?? '').trim();
        const limit = ctx.args?.limit;
        // Tham số bắt buộc được kiểm trong `run` để `runAction` vẫn dựng phong
        // bì lỗi BAD_INPUT thay vì để ngoại lệ thoát ra từ `backends`.
        return orderedBackends(ctx, (adapter) =>
          searchRepositories(adapter, ctx, { query, limit }),
        );
      },
    },

    read: {
      description:
        'Đọc một repository kèm README, hoặc một issue/pull request kèm tối đa 50 bình luận',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'owner/repo, hoặc liên kết repo/issue/pull request trên github.com',
        },
      },
      backends(ctx) {
        const target = String(ctx.args?.target ?? '').trim();
        // Hình dạng target được kiểm trong `readGithub` (tức trong `run`), nên
        // target sai vẫn đi qua `runAction` và người gọi nhận phong bì lỗi
        // BAD_INPUT thay vì một ngoại lệ thoát ra từ `backends`.
        return orderedBackends(ctx, (adapter) => readGithub(adapter, ctx, { target }));
      },
    },
  },
};
