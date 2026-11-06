/**
 * dsh-reach — lõi dùng chung cho mọi kênh.
 *
 * Đây là hợp đồng cố định mà các module kênh phải code theo. Nó giữ những
 * phần không được phép lệch nhau giữa các kênh:
 *
 *   - phong bì kết quả thống nhất ({schema_version, ok, channel, action,
 *     backend, items, meta, error}) port từ `agent_reach/runtime/result.py`
 *     của Agent Reach, để model chỉ cần rẽ nhánh trên `ok` và `error.code`
 *     đúng như hợp đồng CLI hứa;
 *   - hệ thống mã lỗi và gợi ý mặc định (tiếng Việt);
 *   - HTTP client có giới hạn kích thước, chặn chuyển hướng về địa chỉ nội bộ;
 *   - tiện ích hủy tác vụ.
 *
 * Module này không gọi mạng lúc import và không ghi đĩa.
 *
 * @module dsh-reach/runtime
 */

import { Buffer } from 'node:buffer';

/** Phiên bản schema của phong bì kết quả; chỉ tăng khi thay đổi không tương thích. */
export const SCHEMA_VERSION = 1;

// ── mã lỗi ──────────────────────────────────────────────────────────────────

/** Thiếu công cụ/điều kiện cài đặt. */
export const NEED_SETUP = 'NEED_SETUP';
/** Cần người dùng tự đăng nhập. */
export const NEED_LOGIN = 'NEED_LOGIN';
/** Nền tảng đang lỗi tạm thời. */
export const UPSTREAM_BROKEN = 'UPSTREAM_BROKEN';
/** Quá thời gian chờ. */
export const TIMEOUT = 'TIMEOUT';
/** Nền tảng báo giới hạn tần suất. */
export const RATE_LIMITED = 'RATE_LIMITED';
/** Nền tảng yêu cầu xác minh (captcha/chống bot). */
export const PLATFORM_BLOCKED = 'PLATFORM_BLOCKED';
/** Nội dung không tồn tại. */
export const NOT_FOUND = 'NOT_FOUND';
/** Tham số không hợp lệ. */
export const BAD_INPUT = 'BAD_INPUT';
/** Tài nguyên dùng chung đang bận. */
export const BUSY = 'BUSY';

/**
 * Các mã mà thử backend khác cũng vô ích: bộ điều phối dừng ngay thay vì
 * chuyển sang backend kế tiếp.
 */
export const FINAL_CODES = new Set([
  NOT_FOUND,
  BAD_INPUT,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  NEED_LOGIN,
  BUSY,
]);

/** Gợi ý mặc định cho từng mã lỗi, dùng khi backend không tự đưa gợi ý. */
export const DEFAULT_HINTS = {
  [BUSY]:
    'Tài nguyên dùng chung vẫn đang bận. Thử lại sau; không đổi cấu hình hay backend.',
  [PLATFORM_BLOCKED]:
    'Dừng tự động hóa. Người dùng phải tự xử lý xác minh trên trang chính thức. Không đổi backend, không thử lại.',
  [NEED_SETUP]:
    'Backend này chưa sẵn sàng trên máy. Hãy nói rõ cho người dùng biết thiếu điều kiện gì.',
  [NEED_LOGIN]:
    'Phiên đăng nhập đã lưu không đủ quyền. Người dùng phải tự đăng nhập; tuyệt đối không hỏi mật khẩu.',
  [UPSTREAM_BROKEN]:
    'Kênh này tạm thời không hoạt động; `message` là nội dung nền tảng trả về. Hãy nói bằng lời thường nền tảng nào đang lỗi, không nêu tên công cụ; không thử lại vòng lặp.',
  [TIMEOUT]:
    'Tác vụ quá thời gian chờ. Kiểm tra trạng thái kênh và bước bị lỗi; không lặp lại yêu cầu.',
  [RATE_LIMITED]:
    'Nền tảng báo giới hạn tần suất. Tôn trọng retry_after_seconds và không đổi backend.',
  [NOT_FOUND]: 'Nội dung không tồn tại. Kiểm tra lại liên kết hoặc id.',
  [BAD_INPUT]: 'Tham số không hợp lệ cho hành động này; xem hướng dẫn của công cụ reach.',
};

const MAX_MESSAGE_CHARS = 500;

/** Lỗi mang một mã thống nhất; văn bản gốc của nền tảng được giữ nguyên. */
export class ReachError extends Error {
  /**
   * @param {string} code một trong các mã đã export
   * @param {string} message nội dung nền tảng trả về
   * @param {string} [hint] bước tiếp theo; mặc định theo mã
   */
  constructor(code, message, hint) {
    super(message);
    this.name = 'ReachError';
    this.code = code;
    this.hint = hint;
  }
}

/** Xóa thông tin đăng nhập nhúng trong URL, rồi cắt theo hạn mức thông điệp. */
export function scrubUrlCredentials(text) {
  return String(text).replace(
    /\b(https?:\/\/)([^/\s@]+)@/gi,
    (_m, scheme) => scheme + '***@',
  );
}

function clean(text) {
  return scrubUrlCredentials(text).trim().slice(0, MAX_MESSAGE_CHARS);
}

/** Ánh xạ mọi giá trị bị ném sang ReachError, giữ nguyên mã nếu đã có. */
export function classify(error) {
  if (error instanceof ReachError) return error;
  const name = error?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ReachError(TIMEOUT, 'máy chủ không phản hồi kịp thời gian chờ');
  }
  const cause = error?.cause;
  const code = cause?.code ?? error?.code ?? '';
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return new ReachError(
      UPSTREAM_BROKEN,
      'lỗi mạng: ' + clean(cause?.message ?? error?.message ?? code),
    );
  }
  if (code === 'ENOENT') {
    return new ReachError(NEED_SETUP, 'thiếu chương trình: ' + clean(error?.message ?? code));
  }
  return new ReachError(UPSTREAM_BROKEN, name + ': ' + clean(error?.message ?? error));
}

/** Một mục đã chuẩn hóa; trường nào không có thì là null. */
export function makeItem({
  title = null,
  url = null,
  author = null,
  publishedAt = null,
  text = null,
  raw = null,
} = {}) {
  return {
    title: title || null,
    url: url || null,
    author: author || null,
    published_at: publishedAt || null,
    text: text || null,
    raw: raw ?? null,
  };
}

/** Đổi mốc thời gian unix (giây) sang ISO 8601 UTC, hoặc null. */
export function unixToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Dựng đối tượng kết quả thống nhất. Tương đương `envelope()` của Agent Reach.
 *
 * @param {object} spec
 * @param {string|null} spec.channel
 * @param {string|null} spec.action
 * @param {string|null} [spec.backend]
 * @param {Array} [spec.items]
 * @param {number} [spec.elapsedMs]
 * @param {Array} [spec.attempts]
 * @param {ReachError|null} [spec.error]
 */
export function envelope({
  channel = null,
  action = null,
  backend = null,
  items = [],
  elapsedMs = 0,
  attempts = [],
  error = null,
} = {}) {
  const ok = error === null;
  return {
    schema_version: SCHEMA_VERSION,
    ok,
    channel,
    action,
    backend: ok ? backend : null,
    items: ok ? list(items) : [],
    meta: { elapsed_ms: Math.max(0, Math.round(elapsedMs)), attempts: list(attempts) },
    error: ok
      ? null
      : {
          code: error.code,
          message: error.message,
          hint: error.hint || DEFAULT_HINTS[error.code] || '',
        },
  };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// ── hủy tác vụ ──────────────────────────────────────────────────────────────

/** Ném lý do hủy khi tín hiệu đã kích hoạt. */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) {
    throw signal.reason ?? new ReachError(TIMEOUT, 'tác vụ đã bị hủy');
  }
}

/** Từ chối sau `ms` bằng ReachError TIMEOUT, trừ khi `signal` hủy trước. */
export function timeoutAfter(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return { promise: Promise.resolve(), cancel() {} };
  let timer;
  let onAbort;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new ReachError(TIMEOUT, 'tác vụ vượt quá ' + ms + 'ms')),
      ms,
    );
    timer.unref?.();
    if (signal !== undefined) {
      onAbort = () => reject(signal.reason ?? new ReachError(TIMEOUT, 'tác vụ đã bị hủy'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const cancel = () => {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener?.('abort', onAbort);
  };
  promise.catch(() => {}).finally(cancel);
  return { promise, cancel };
}

// ── an toàn URL ─────────────────────────────────────────────────────────────

const BLOCKED_HOSTS = new Set([
  'home.arpa',
  'instance-data',
  'internal',
  'ip6-localhost',
  'ip6-loopback',
  'lan',
  'local',
  'localdomain',
  'localhost',
  'metadata.google.internal',
]);

const BLOCKED_SUFFIXES = [
  '.home.arpa',
  '.internal',
  '.lan',
  '.local',
  '.localdomain',
  '.localhost',
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv4(host) {
  const match = IPV4_RE.exec(host);
  if (match === null) return false;
  const [a, b] = match.slice(1).map(Number);
  if (a > 255 || b > 255) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(host) {
  const inner = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return (
    inner === '::' ||
    inner === '::1' ||
    inner.startsWith('fe80') ||
    inner.startsWith('fc') ||
    inner.startsWith('fd') ||
    inner.startsWith('::ffff:')
  );
}

/**
 * Chuẩn hóa URL không tin cậy hoặc từ chối, port hàm
 * `normalize_public_http_url` của Agent Reach: chỉ đích công khai HTTP(S) đi qua.
 *
 * @param {unknown} input
 * @returns {string} URL tuyệt đối đã chuẩn hóa
 * @throws {ReachError} BAD_INPUT khi đích không rõ ràng là HTTP(S) công khai
 */
export function normalizePublicHttpUrl(input) {
  let candidate = String(input ?? '').trim();
  const reject = () => {
    throw new ReachError(BAD_INPUT, 'đích phải là URL http(s) công khai');
  };
  if (!candidate || candidate.includes('\\')) reject();
  for (const character of candidate) {
    const code = character.codePointAt(0);
    if (/\s/.test(character) || code < 0x20 || code === 0x7f) reject();
  }
  if (!candidate.includes('://')) candidate = 'https://' + candidate;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    reject();
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const bracketed = parsed.hostname.startsWith('[');
  if (scheme !== 'http:' && scheme !== 'https:') reject();
  if (!host) reject();
  if (parsed.username !== '' || parsed.password !== '') reject();
  if (host.includes('%')) reject();
  if (BLOCKED_HOSTS.has(host)) reject();
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) reject();

  const literal = bracketed || IPV4_RE.test(host) || host.includes(':');
  if (!host.includes('.') && !literal) reject();
  if (literal && (isPrivateIpv4(host) || isPrivateIpv6(host))) reject();

  return parsed.href;
}

/** URL có host thuộc `domains` (khớp chính xác hoặc subdomain thật) hay không. */
export function hostMatches(url, ...domains) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return domains.some((domain) => {
    const allowed = String(domain).toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    return host === allowed || host.endsWith('.' + allowed);
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** Giá trị mặc định; `apply(ctx, config)` thay thế theo từng profile. */
export const DEFAULT_HTTP = {
  timeoutMs: 30000,
  maxResponseBytes: 5 * 1024 * 1024,
  userAgent: 'dsh-reach/1.0 (+https://github.com/Panniantong/Agent-Reach)',
  githubToken: '',
};

/**
 * Một yêu cầu HTTP có giới hạn. Chỉ đi theo chuyển hướng tới đích công khai,
 * nên một chuyển hướng độc hại không thể biến client này thành công cụ đọc
 * mạng nội bộ.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {'GET'|'POST'|'HEAD'} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string|Uint8Array} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @param {typeof DEFAULT_HTTP} [options.http] giới hạn theo profile
 * @returns {Promise<{url: string, status: number, headers: Headers, body: string}>}
 */
export async function httpRequest(url, options = {}) {
  const http = options.http ?? DEFAULT_HTTP;
  const timeoutMs = options.timeoutMs ?? http.timeoutMs;
  const maxBytes = options.maxBytes ?? http.maxResponseBytes;
  const method = options.method ?? 'GET';
  const headers = {
    'User-Agent': http.userAgent,
    Accept: '*/*',
    ...(options.headers ?? {}),
  };

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal !== undefined) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const budget = timeoutAfter(timeoutMs, controller.signal);
  budget.promise.catch(() => controller.abort(new ReachError(TIMEOUT, 'yêu cầu quá thời gian chờ')));

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    // Kiểm tra cả URL cuối: chuyển hướng có thể đã dẫn tới vùng riêng tư.
    normalizePublicHttpUrl(response.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ReachError(
        UPSTREAM_BROKEN,
        'phản hồi vượt quá ' + maxBytes + ' byte',
      );
    }
    return {
      url: response.url,
      status: response.status,
      headers: response.headers,
      body: buffer.toString('utf8'),
    };
  } finally {
    budget.cancel();
    options.signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * GET JSON bằng client có giới hạn, ánh xạ lỗi truyền tải sang ReachError.
 *
 * @returns {Promise<{json: any, status: number, headers: Headers, url: string}>}
 */
export async function getJson(url, options = {}) {
  const response = await httpRequest(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  let json;
  try {
    json = JSON.parse(response.body);
  } catch {
    throw new ReachError(
      UPSTREAM_BROKEN,
      'phản hồi không phải JSON (HTTP ' + response.status + ')',
    );
  }
  return { json, status: response.status, headers: response.headers, url: response.url };
}

// ── dự phòng qua curl ───────────────────────────────────────────────────────

/**
 * Một yêu cầu HTTP qua binary `curl` của hệ điều hành, dùng khi `fetch` bị
 * chặn vì dấu vân tay TLS.
 *
 * Vì sao cần: một số cổng chặn bot (Cloudflare, Twitter syndication) nhận diện
 * thư viện HTTP qua *TLS ClientHello* chứ không qua header. Node/undici có
 * ClientHello rất đặc trưng nên bị từ chối bằng 429/403 ngay cả khi header
 * giống hệt trình duyệt; `curl` với OpenSSL có ClientHello khác nên đi được.
 * Đo trên máy này: cùng URL, cùng UA, cùng HTTP/1.1 — `fetch` 429, `curl` 200.
 *
 * Hàm chỉ dùng cho trường hợp đã xác định là cần (kênh tự bật), không thay thế
 * `httpRequest`: nó khởi tạo tiến trình nên đắt hơn và không dùng lại được kết
 * nối. URL vẫn phải qua `normalizePublicHttpUrl` ở phía gọi.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @param {typeof DEFAULT_HTTP} [options.http]
 * @returns {Promise<{url:string,status:number,headers:Headers,body:string,via:string}>}
 * @throws {ReachError} NEED_SETUP khi máy không có curl
 */
export async function curlRequest(url, options = {}) {
  const http = options.http ?? DEFAULT_HTTP;
  const timeoutMs = options.timeoutMs ?? http.timeoutMs;
  const maxBytes = options.maxBytes ?? http.maxResponseBytes;
  const target = normalizePublicHttpUrl(url);

  // `-w` in mã trạng thái ra sau body, để một lần chạy vẫn biết status thật.
  const argv = [
    '--silent',
    '--show-error',
    '--location',
    '--http1.1',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '--max-filesize',
    String(maxBytes),
    '--user-agent',
    http.userAgent,
    '--write-out',
    '\n%{http_code}\n%{url_effective}',
  ];
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    argv.push('--header', name + ': ' + value);
  }
  argv.push('--url', target);

  const { spawn } = await import('node:child_process');
  const { promise: timeoutPromise, cancel } = timeoutAfter(timeoutMs + 1000, options.signal);
  const stdout = [];
  const stderr = [];
  let child;
  try {
    timeoutPromise.catch(() => child?.kill('SIGKILL'));
    child = spawn('curl', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    cancel();
    throw classify(error);
  }

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        reject(new ReachError(NEED_SETUP, 'máy không có lệnh curl để dự phòng'));
        return;
      }
      reject(classify(error));
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code) => resolve(code));
    if (options.signal !== undefined) {
      const onAbort = () => child.kill('SIGKILL');
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }).catch((error) => {
    cancel();
    throw error;
  });
  cancel();
  if (child.exitCode === null) child.kill('SIGKILL');

  const raw = Buffer.concat(stdout).toString('utf8');
  if (raw.length > maxBytes) {
    throw new ReachError(UPSTREAM_BROKEN, 'phản hồi vượt quá ' + maxBytes + ' byte');
  }
  // Ba dòng cuối do --write-out sinh: body, mã trạng thái, URL cuối.
  const marker = raw.lastIndexOf('\n');
  const beforeUrl = marker === -1 ? raw : raw.slice(0, marker);
  const effectiveUrl = marker === -1 ? target : raw.slice(marker + 1).trim();
  const statusMarker = beforeUrl.lastIndexOf('\n');
  const body = statusMarker === -1 ? beforeUrl : beforeUrl.slice(0, statusMarker);
  const status = Number((statusMarker === -1 ? beforeUrl : beforeUrl.slice(statusMarker + 1)).trim());
  if (!Number.isFinite(status) || status <= 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 300);
    throw new ReachError(UPSTREAM_BROKEN, 'curl không trả về mã trạng thái' + (detail ? ': ' + detail : ''));
  }
  // Kiểm tra cả URL cuối: chuyển hướng có thể đã dẫn tới vùng riêng tư.
  normalizePublicHttpUrl(effectiveUrl);
  if (exitCode !== 0 && status === 0) {
    throw new ReachError(UPSTREAM_BROKEN, 'curl thoát với mã ' + String(exitCode));
  }
  return { url: effectiveUrl, status, headers: new Headers(), body, via: 'curl' };
}

// ── điều phối ───────────────────────────────────────────────────────────────

/**
 * Chạy các backend có thứ tự của một hành động, kèm fallback.
 *
 * Backend là `{label, run()}`; lỗi bị ném sẽ được phân loại, ghi vào `attempts`,
 * và backend kế tiếp được thử trừ khi mã là "cuối" (FINAL_CODES).
 *
 * @param {string} channel
 * @param {string} action
 * @param {Array<{label: string, run: () => Promise<Array>}>} backends
 * @returns {Promise<object>} phong bì kết quả thống nhất
 */
export async function runAction(channel, action, backends) {
  const started = Date.now();
  const attempts = [];
  let lastError = null;
  for (const backend of backends) {
    try {
      const items = await backend.run();
      if (!Array.isArray(items) || items.length === 0) {
        throw new ReachError(
          UPSTREAM_BROKEN,
          'backend không trả về kết quả nào nhận dạng được',
        );
      }
      return envelope({
        channel,
        action,
        backend: backend.label,
        items,
        elapsedMs: Date.now() - started,
        attempts,
      });
    } catch (error) {
      const failure = classify(error);
      lastError = failure;
      attempts.push({
        backend: backend.label,
        result: failure.code,
        message: clean(failure.message),
      });
      if (FINAL_CODES.has(failure.code)) break;
    }
  }
  return envelope({
    channel,
    action,
    elapsedMs: Date.now() - started,
    attempts,
    error: lastError ?? new ReachError(UPSTREAM_BROKEN, 'không backend nào cho ra kết quả'),
  });
}
