/**
 * Kênh `youtube` — tìm video, đọc thông tin video và lấy phụ đề, qua `yt-dlp`.
 *
 * Port từ `agent_reach/channels/youtube.py` (Agent Reach 1.6.1, MIT). Bản này
 * bỏ hành động `transcribe` của bản Python vì nó cần khoá Groq/OpenAI và gọi
 * model bên ngoài; ở đây chỉ còn ba hành động chỉ-đọc: `search`, `read`,
 * `subtitle`.
 *
 * Toàn bộ dữ liệu lấy từ tiến trình `yt-dlp` — ngoại lệ duy nhất được phép gọi
 * tiến trình ngoài. Không đăng nhập, không ghi gì lên YouTube, không dùng
 * cookie tài khoản.
 *
 * @module dsh-reach/channels/youtube
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  BAD_INPUT,
  NEED_SETUP,
  NOT_FOUND,
  PLATFORM_BLOCKED,
  RATE_LIMITED,
  ReachError,
  TIMEOUT,
  UPSTREAM_BROKEN,
  hostMatches,
  makeItem,
  normalizePublicHttpUrl,
  throwIfAborted,
} from '../runtime.js';

const execFileAsync = promisify(execFile);

/** Trần dữ liệu một lần gọi yt-dlp (JSON của video dài có thể vài trăm KB). */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Trần số ký tự văn bản phụ đề trả về, tránh nhồi cả video nhiều giờ vào context. */
const MAX_SUBTITLE_CHARS = 200000;

/** Số kết quả tối đa cho một lần tìm, chặn `limit` do người dùng nhập. */
const MAX_SEARCH_LIMIT = 50;

/** Mốc thời gian chờ dự phòng khi ngữ cảnh không khai báo. */
const FALLBACK_TIMEOUT_MS = 30000;

/** Các trường thô giữ lại trong `raw`, khớp `_RAW_KEYS` của bản Python. */
const RAW_KEYS = ['id', 'duration', 'view_count', 'like_count', 'channel_id', 'tags', 'categories'];

/** Nhận diện video id 11 ký tự của YouTube, khớp `_VIDEO_ID_RE` bản Python. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Dòng mốc thời gian WebVTT, khớp `_VTT_TIME_RE` bản Python. */
const VTT_TIME_RE = /^\d{2}:\d{2}(:\d{2})?\.\d{3} --> /;

/** Thẻ định dạng trong phụ đề (thay hết mọi lần xuất hiện), khớp `_TAG_RE` bản Python. */
const TAG_RE = /<[^>]+>/g;

/** Mã ngôn ngữ hợp lệ: chữ, số, gạch ngang, gạch dưới (vd: zh-Hans, en-orig). */
const LANG_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Giá trị mặc định của `lang`, khớp bản Python. */
const DEFAULT_LANGS = 'zh-Hans,zh,en,en-orig';

// ── tìm chương trình yt-dlp ────────────────────────────────────────────────

/** Đường dẫn yt-dlp đã tìm thấy; chỉ lưu kết quả dương tính. */
let cachedExecutable = null;

/** Đã thử `--js-runtimes` và yt-dlp trên máy không hỗ trợ tuỳ chọn đó hay chưa. */
let jsRuntimeOptionUnsupported = false;

/** Tên file thực thi theo hệ điều hành (Windows cần đuôi .exe). */
function binaryNames() {
  return process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'];
}

/** File tồn tại và chạy được (trên POSIX phải có quyền thực thi). */
function isRunnableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Dò `yt-dlp` trong các thư mục của PATH, đúng thứ tự PATH. */
function findOnPath() {
  const raw = process.env.PATH ?? '';
  for (const dir of raw.split(path.delimiter)) {
    if (dir === '') continue;
    for (const name of binaryNames()) {
      const candidate = path.join(dir, name);
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Dò thêm vài vị trí cài đặt phổ biến, dựng từ thư mục nhà của người dùng.
 *
 * DSH thường không đưa `~/.local/bin` vào PATH, nên nếu chỉ dò PATH thì bản
 * cài bằng `uv tool install` hay `pipx install` sẽ bị bỏ sót. Mọi ứng viên ở
 * đây đều suy ra lúc chạy từ `homedir()`/biến môi trường, không hardcode đường
 * dẫn tuyệt đối của máy nào.
 */
function findInCommonLocations() {
  const roots = [];
  const xdgBin = process.env.XDG_BIN_HOME;
  if (typeof xdgBin === 'string' && xdgBin !== '') roots.push(xdgBin);
  const home = homedir();
  roots.push(
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    // uv tool: ~/.local/share/uv/tools/<tên>/bin/<tên>
    path.join(home, '.local', 'share', 'uv', 'tools', 'yt-dlp', 'bin'),
    // pipx: ~/.local/pipx/venvs/<tên>/bin/<tên>
    path.join(home, '.local', 'pipx', 'venvs', 'yt-dlp', 'bin'),
  );
  for (const root of roots) {
    for (const name of binaryNames()) {
      const candidate = path.join(root, name);
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Trả đường dẫn yt-dlp, hoặc null khi máy chưa cài. */
function resolveYtDlp() {
  if (cachedExecutable !== null) return cachedExecutable;
  const found = findOnPath() ?? findInCommonLocations();
  if (found !== null) cachedExecutable = found;
  return found;
}

/** Lỗi cấu hình khi thiếu yt-dlp, kèm cách cài bằng tiếng Việt. */
function needSetupError() {
  return new ReachError(
    NEED_SETUP,
    'chưa tìm thấy chương trình yt-dlp trên máy nên kênh YouTube chưa dùng được',
    'Cài yt-dlp rồi thử lại: `uv tool install yt-dlp` hoặc `pipx install yt-dlp` '
      + '(hoặc `python -m pip install --user yt-dlp`), sau đó bảo đảm lệnh `yt-dlp` nằm trên PATH.',
  );
}

// ── gọi tiến trình yt-dlp ──────────────────────────────────────────────────

/** Ngân sách thời gian một lần gọi, lấy từ `ctx.http.timeoutMs`. */
function timeoutFrom(ctx) {
  const value = Number(ctx?.http?.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : FALLBACK_TIMEOUT_MS;
}

/**
 * Tham số giúp yt-dlp giải thử thách JS của YouTube bằng chính Node đang chạy
 * DSH, thay vì đòi cài thêm deno. Bản Python cũng thêm `--js-runtimes node`
 * khi máy không có deno.
 */
function jsRuntimeArgs() {
  if (jsRuntimeOptionUnsupported) return [];
  const nodeBinary = process.execPath;
  if (typeof nodeBinary !== 'string' || nodeBinary === '') return [];
  return ['--js-runtimes', 'node:' + nodeBinary];
}

/** yt-dlp cũ không biết tuỳ chọn `--js-runtimes`; nhận ra để gọi lại không kèm nó. */
function isUnsupportedJsRuntimeOption(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const lower = stderr.toLowerCase();
  return lower.includes('no such option') && lower.includes('js-runtimes');
}

/** last dòng stderr có nội dung, dùng làm nội dung lỗi gốc của nền tảng. */
function lastStderrLine(stderr) {
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/** Chạy một lệnh yt-dlp và trả stdout; mọi lỗi được ánh xạ sang ReachError. */
function classifyYtdlpError(error) {
  if (error instanceof ReachError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new ReachError(TIMEOUT, 'tác vụ đã bị hủy trong khi chờ yt-dlp');
  }
  if (resolveYtDlp() === null || error?.code === 'ENOENT') return needSetupError();
  if (
    error?.killed === true
    || error?.code === 'ETIMEDOUT'
    || (error?.signal !== null && error?.signal !== undefined)
  ) {
    return new ReachError(
      TIMEOUT,
      'yt-dlp không chạy xong trong thời gian chờ',
      'Video hoặc danh sách phụ đề quá lớn, hoặc mạng chậm. Thử lại sau; không lặp lại liên tục.',
    );
  }
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new ReachError(UPSTREAM_BROKEN, 'yt-dlp trả về nhiều dữ liệu hơn mức cho phép');
  }

  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const lower = stderr.toLowerCase();
  const detail = lastStderrLine(stderr) || String(error?.message ?? error);

  if (
    ['video unavailable', 'private video', 'has been removed', 'does not exist',
      'this video is unavailable', 'removed by the uploader'].some((needle) => lower.includes(needle))
  ) {
    return new ReachError(
      NOT_FOUND,
      'không tìm thấy video YouTube (có thể đã bị gỡ, để riêng tư hoặc không tồn tại): ' + detail,
      'Kiểm tra lại liên kết hoặc video id, hoặc thử video công khai khác.',
    );
  }
  if (lower.includes('sign in to confirm') || lower.includes('not a bot')) {
    return new ReachError(
      PLATFORM_BLOCKED,
      'YouTube yêu cầu xác minh chống bot nên chưa đọc được video công khai này: ' + detail,
      'Dừng yêu cầu này; điều đó không chứng minh video công khai cần đăng nhập. '
        + 'Người dùng phải tự xử lý xác minh trên trình duyệt rồi thử lại sau.',
    );
  }
  if (lower.includes('429') || lower.includes('too many requests')) {
    return new ReachError(
      RATE_LIMITED,
      'YouTube báo giới hạn tần suất khi yt-dlp lấy dữ liệu: ' + detail,
    );
  }

  const exitCode = typeof error?.code === 'number' ? error.code : (error?.code ?? 'không rõ');
  return new ReachError(UPSTREAM_BROKEN, 'yt-dlp thoát với mã ' + exitCode + ': ' + detail);
}

/** Một lần execFile có timeout, trần bộ đệm và tín hiệu hủy. */
async function executeYtDlp(executable, argv, { cwd, timeoutMs, signal }) {
  const options = {
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  };
  if (cwd !== undefined) options.cwd = cwd;
  if (signal !== undefined) options.signal = signal;
  const { stdout } = await execFileAsync(executable, argv, options);
  return String(stdout ?? '');
}

/**
 * Chạy yt-dlp với các tham số hành động và trả stdout.
 *
 * @param {string[]} args tham số riêng của hành động
 * @param {object} ctx ngữ cảnh backend
 * @param {{cwd?: string}} [extra] thư mục làm việc riêng (dùng cho phụ đề)
 * @returns {Promise<string>}
 */
async function runYtDlp(args, ctx, extra = {}) {
  throwIfAborted(ctx?.signal);
  const executable = resolveYtDlp();
  if (executable === null) throw needSetupError();
  const timeoutMs = timeoutFrom(ctx);
  const base = ['--no-warnings', ...jsRuntimeArgs()];

  try {
    return await executeYtDlp(executable, [...base, ...args], {
      cwd: extra.cwd,
      timeoutMs,
      signal: ctx?.signal,
    });
  } catch (error) {
    if (isUnsupportedJsRuntimeOption(error) && !jsRuntimeOptionUnsupported) {
      // Bản yt-dlp quá cũ: thử lại một lần, không kèm --js-runtimes.
      jsRuntimeOptionUnsupported = true;
      try {
        return await executeYtDlp(executable, ['--no-warnings', ...args], {
          cwd: extra.cwd,
          timeoutMs,
          signal: ctx?.signal,
        });
      } catch (retryError) {
        throw classifyYtdlpError(retryError);
      }
    }
    throw classifyYtdlpError(error);
  }
}

// ── tiện ích dữ liệu ──────────────────────────────────────────────────────

/** Đọc JSON do yt-dlp in ra; thử cả dòng cuối để chịu được cảnh báo lẫn vào. */
function parseJsonOutput(stdout, purpose) {
  const text = String(stdout ?? '').trim();
  if (text !== '') {
    try {
      return JSON.parse(text);
    } catch {
      // Thử dòng cuối; `--dump-json` cũ in mỗi dòng một JSON.
    }
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length > 0) {
      try {
        return JSON.parse(lines[lines.length - 1]);
      } catch {
        // rơi xuống lỗi bên dưới
      }
    }
  }
  throw new ReachError(UPSTREAM_BROKEN, 'yt-dlp trả về dữ liệu ' + purpose + ' không đọc được');
}

/** Chuẩn hóa `limit`: số nguyên 1..MAX_SEARCH_LIMIT, mặc định 5. */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return 5;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.trunc(numeric) < 1) {
    throw new ReachError(
      BAD_INPUT,
      'tham số "limit" phải là số nguyên dương',
      'Truyền limit là số nguyên từ 1 đến ' + MAX_SEARCH_LIMIT + ', ví dụ 5.',
    );
  }
  return Math.min(Math.trunc(numeric), MAX_SEARCH_LIMIT);
}

/** Đổi ngày `YYYYMMDD` của YouTube sang ISO 8601, khớp `_iso_date` bản Python. */
function isoDate(yyyymmdd) {
  const text = String(yyyymmdd ?? '');
  return /^\d{8}$/.test(text) ? text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8) : null;
}

/** Giữ các trường thô quen thuộc của một object info yt-dlp. */
function pickRaw(info) {
  const raw = {};
  for (const key of RAW_KEYS) raw[key] = info?.[key] ?? null;
  return raw;
}

/**
 * Chuyển `target` của người dùng thành URL video YouTube.
 *
 * Nhận video id 11 ký tự hoặc liên kết youtube.com/youtu.be; mọi đích khác bị
 * từ chối để yt-dlp không bị dụ sang máy chủ khác.
 *
 * @param {unknown} target
 * @returns {string} URL https của video
 * @throws {ReachError} BAD_INPUT khi không nhận dạng được
 */
function videoUrl(target) {
  const text = String(target ?? '').trim();
  if (VIDEO_ID_RE.test(text)) return 'https://www.youtube.com/watch?v=' + text;
  if (text === '') {
    throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "target"');
  }
  const candidate = text.includes('://') ? text : 'https://' + text;
  if (!hostMatches(candidate, 'youtube.com', 'youtu.be')) {
    throw new ReachError(
      BAD_INPUT,
      'target phải là liên kết YouTube (youtube.com hoặc youtu.be) hoặc video id 11 ký tự',
      'Ví dụ: https://www.youtube.com/watch?v=jNQXAC9IVRw hoặc jNQXAC9IVRw.',
    );
  }
  // Chỉ đích công khai HTTP(S) mới được đưa cho yt-dlp tải.
  return normalizePublicHttpUrl(candidate);
}

/** Tách danh sách ngôn ngữ, bỏ mục rỗng và từ chối mã lạ. */
function parseLangs(lang) {
  const raw = String(lang ?? '').trim() === '' ? DEFAULT_LANGS : String(lang);
  const wanted = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (wanted.length === 0) {
    throw new ReachError(BAD_INPUT, 'tham số "lang" rỗng', 'Ví dụ: zh-Hans,zh,en,en-orig.');
  }
  for (const code of wanted) {
    if (!LANG_CODE_RE.test(code)) {
      throw new ReachError(
        BAD_INPUT,
        'mã ngôn ngữ không hợp lệ trong tham số "lang": ' + code,
        'Chỉ dùng mã ngôn ngữ như zh-Hans, zh, en, en-orig, phân tách bằng dấu phẩy.',
      );
    }
  }
  return wanted;
}

/** Giải các thực thể HTML cơ bản, tương đương `html.unescape` cho phụ đề. */
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return fromCodePoint(parseInt(body.slice(2), 16), match);
    }
    if (body.startsWith('#')) return fromCodePoint(parseInt(body.slice(1), 10), match);
    const value = named[body.toLowerCase()];
    return value === undefined ? match : value;
  });
}

/** Đổi mã điểm mã sang ký tự; mã sai thì giữ nguyên chuỗi gốc. */
function fromCodePoint(code, fallback) {
  if (!Number.isFinite(code)) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/** Cắt văn bản dài một cách có ý thức, kèm dấu hiệu đã cắt. */
function clampText(text) {
  if (text.length <= MAX_SUBTITLE_CHARS) return text;
  return text.slice(0, MAX_SUBTITLE_CHARS) + '\n…(đã cắt bớt)';
}

/**
 * Chuyển WebVTT thành văn bản sạch.
 *
 * Bỏ tiêu đề WEBVTT, dòng Kind/Language/NOTE/STYLE, mốc thời gian, số thứ tự và
 * thẻ định dạng; gộp các dòng lặp liền nhau của phụ đề tự động. Tương đương
 * `vtt_to_text` của bản Python.
 *
 * @param {string} vtt nội dung tệp .vtt
 * @returns {string} văn bản phụ đề đã ghép
 */
function vttToText(vtt) {
  const out = [];
  for (const line of String(vtt ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed === ''
      || trimmed === 'WEBVTT'
      || /^(Kind:|Language:|NOTE|STYLE)/.test(trimmed)
      || VTT_TIME_RE.test(trimmed)
      || /^\d+$/.test(trimmed)
    ) {
      continue;
    }
    const cleaned = decodeEntities(trimmed.replace(TAG_RE, '')).trim();
    if (cleaned !== '' && (out.length === 0 || out[out.length - 1] !== cleaned)) out.push(cleaned);
  }
  return out.join('\n');
}

/** Mã ngôn ngữ suy ra từ tên tệp `<id>.<lang>.vtt`, khớp bản Python. */
function langFromFilename(name) {
  const parts = String(name).split('.');
  return parts.length >= 3 ? parts[parts.length - 2] : '';
}

// ── hành động ─────────────────────────────────────────────────────────────

/** Tìm video theo từ khóa bằng playlist tổng hợp `ytsearchN:query`. */
async function searchVideos(query, limit, ctx) {
  const stdout = await runYtDlp(
    ['--dump-single-json', '--flat-playlist', 'ytsearch' + limit + ':' + query],
    ctx,
  );
  const payload = parseJsonOutput(stdout, 'tìm kiếm');
  if (!Array.isArray(payload?.entries)) {
    throw new ReachError(UPSTREAM_BROKEN, 'yt-dlp không trả về danh sách kết quả tìm kiếm');
  }
  const items = [];
  for (const entry of payload.entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : null;
    items.push(
      makeItem({
        title: entry.title ?? null,
        url: typeof entry.url === 'string' && entry.url !== ''
          ? entry.url
          : (id === null ? null : 'https://www.youtube.com/watch?v=' + id),
        author: entry.channel ?? entry.uploader ?? null,
        text: entry.description ?? null,
        raw: pickRaw(entry),
      }),
    );
  }
  if (items.length === 0) {
    throw new ReachError(
      NOT_FOUND,
      'không tìm thấy video YouTube nào cho truy vấn "' + query + '"',
      'Thử từ khóa khác hoặc kiểm tra lại kết nối mạng.',
    );
  }
  return items.slice(0, limit);
}

/** Đọc thông tin một video: tiêu đề, kênh, ngày đăng, mô tả. */
async function readVideo(url, ctx) {
  const stdout = await runYtDlp(['--dump-single-json', '--no-playlist', url], ctx);
  const info = parseJsonOutput(stdout, 'video');
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    throw new ReachError(UPSTREAM_BROKEN, 'yt-dlp không trả về thông tin video nhận dạng được');
  }
  return [
    makeItem({
      title: info.title ?? null,
      url: info.webpage_url ?? url,
      author: info.uploader ?? info.channel ?? null,
      publishedAt: isoDate(info.upload_date),
      text: info.description ?? null,
      raw: pickRaw(info),
    }),
  ];
}

/** Tải phụ đề về thư mục tạm, ghép thành văn bản, rồi dọn thư mục tạm. */
async function fetchSubtitle(url, wanted, ctx) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'dsh-reach-subs-'));
  try {
    const stdout = await runYtDlp(
      [
        '--ignore-errors',
        '--skip-download',
        '--no-simulate',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        wanted.join(','),
        '--sub-format',
        'vtt',
        '--print',
        '%(title)s',
        '-o',
        '%(id)s.%(ext)s',
        url,
      ],
      ctx,
      { cwd: workDir },
    );

    const files = (await readdir(workDir)).filter((name) => name.endsWith('.vtt')).sort();
    if (files.length === 0) {
      throw new ReachError(
        NOT_FOUND,
        'video này không có phụ đề ở các ngôn ngữ đã yêu cầu: ' + wanted.join(', '),
        'Thử lại với ngôn ngữ khác trong tham số "lang", ví dụ "en" hoặc "vi".',
      );
    }

    // Ưu tiên tệp phụ đề theo đúng thứ tự ngôn ngữ người dùng mong muốn.
    const rank = (name) => {
      const code = langFromFilename(name);
      const index = wanted.indexOf(code);
      return index === -1 ? wanted.length : index;
    };
    const best = files.reduce((chosen, name) => (rank(name) < rank(chosen) ? name : chosen), files[0]);
    const raw = await readFile(path.join(workDir, best), 'utf8');
    const text = clampText(vttToText(raw));
    if (text.trim() === '') {
      throw new ReachError(
        UPSTREAM_BROKEN,
        'tệp phụ đề tải về không có nội dung đọc được',
      );
    }
    const title = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? null;
    return [makeItem({ title, url, text, raw: { lang: langFromFilename(best) || null } })];
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const channel = {
  name: 'youtube',
  description: 'YouTube: tìm video, đọc thông tin video và lấy phụ đề (qua yt-dlp, chỉ đọc)',
  level: 'default',

  /** Kênh nhận URL thuộc youtube.com hoặc youtu.be. */
  canHandle(url) {
    return hostMatches(url, 'youtube.com', 'youtu.be');
  },

  actions: {
    search: {
      description: 'Tìm video trên YouTube theo từ khóa (qua yt-dlp)',
      params: {
        query: { type: 'string', required: true, description: 'từ khóa cần tìm' },
        limit: {
          type: 'integer',
          required: false,
          default: 5,
          description: 'số video tối đa',
        },
      },
      backends(ctx) {
        const query = String(ctx.args.query ?? '').trim();
        if (query === '') {
          throw new ReachError(BAD_INPUT, 'thiếu tham số bắt buộc "query"');
        }
        const limit = normalizeLimit(ctx.args.limit);
        return [
          {
            label: 'yt-dlp',
            async run() {
              return searchVideos(query, limit, ctx);
            },
          },
        ];
      },
    },

    read: {
      description: 'Đọc tiêu đề, kênh, ngày đăng và mô tả của một video YouTube',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'liên kết video YouTube hoặc video id 11 ký tự',
        },
      },
      backends(ctx) {
        const url = videoUrl(ctx.args.target);
        return [
          {
            label: 'yt-dlp',
            async run() {
              return readVideo(url, ctx);
            },
          },
        ];
      },
    },

    subtitle: {
      description: 'Lấy toàn bộ văn bản phụ đề của một video (phụ đề tay hoặc tự động)',
      params: {
        target: {
          type: 'string',
          required: true,
          description: 'liên kết video YouTube hoặc video id 11 ký tự',
        },
        lang: {
          type: 'string',
          required: false,
          default: DEFAULT_LANGS,
          description: 'ngôn ngữ ưu tiên, phân tách bằng dấu phẩy',
        },
      },
      backends(ctx) {
        const url = videoUrl(ctx.args.target);
        const wanted = parseLangs(ctx.args.lang);
        return [
          {
            label: 'yt-dlp',
            async run() {
              return fetchSubtitle(url, wanted, ctx);
            },
          },
        ];
      },
    },
  },
};
