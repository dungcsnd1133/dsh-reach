/**
 * Kiểm thử tích hợp dsh-reach: đăng ký công cụ qua apply() với ctx giả, rồi
 * gọi thật từng kênh. Chạy: node test/integration.mjs
 *
 * Không phải unit test của từng kênh (teammate đã kiểm riêng); mục đích là xác
 * nhận bề mặt công cụ, validation và điều phối hoạt động cùng nhau.
 */

import { apply } from '../index.js';
import { CHANNELS } from '../lib/channels/index.js';
import { DEFAULT_HTTP as DEFAULT_HTTP_FOR_TEST } from '../lib/runtime.js';

const results = [];
let failures = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  results.push({ label, ok, detail: detail ?? '' });
  if (!ok) failures += 1;
}

/** ctx.tools giả: ghi lại mọi định nghĩa được đăng ký. */
function fakeContext() {
  const registered = new Map();
  return {
    registered,
    ctx: {
      tools: {
        register(definition) {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      },
    },
  };
}

async function main() {
  const { ctx, registered } = fakeContext();
  const dispose = apply(ctx, {});
  check('đăng ký 4 công cụ', registered.size === 4, [...registered.keys()].join(', '));
  check('có reach_search', registered.has('reach_search'));
  check('có reach_read', registered.has('reach_read'));
  check('có reach_channels', registered.has('reach_channels'));
  check('có reach_run', registered.has('reach_run'));

  // ── reach_channels ──
  const channels = await registered.get('reach_channels').execute({}, {});
  const names = channels.channels.map((item) => item.name);
  const shipped = Object.keys(CHANNELS);
  check(
    'reach_channels trả đủ ' + shipped.length + ' kênh',
    names.length === shipped.length && shipped.every((name) => names.includes(name)),
    names.join(','),
  );
  check(
    'mọi kênh có ít nhất 1 hành động',
    channels.channels.every((item) => item.actions.length > 0),
  );
  check(
    'mọi kênh có level',
    channels.channels.every((item) => typeof item.level === 'string' && item.level !== ''),
  );
  check(
    'mọi hành động có description',
    channels.channels.every((item) =>
      Object.values(item.action_help).every((help) => help.description !== ''),
    ),
  );

  // ── validation ──
  let threw = false;
  try {
    await registered.get('reach_search').execute({ channel: 'v2ex' }, {});
  } catch (error) {
    threw = error.code === 'BAD_INPUT' || error.message.includes('thiếu tham số');
  }
  check('thiếu query -> BAD_INPUT', threw);

  threw = false;
  try {
    await registered.get('reach_search').execute({ channel: 'khong-ton-tai', query: 'x' }, {});
  } catch (error) {
    threw = String(error.message).includes('không tồn tại');
  }
  check('kênh không tồn tại -> lỗi rõ ràng', threw);

  // ── gọi thật song song các kênh ổn định ──
  // V2EX chỉ có hot/node/read/user (không có search) nên gọi hot cho đúng.
  const v2ex = channels.channels.find((item) => item.name === 'v2ex');
  check(
    'v2ex không có search (đúng thiết kế)',
    v2ex !== undefined && !v2ex.actions.includes('search'),
    v2ex === undefined ? 'không thấy kênh' : v2ex.actions.join(','),
  );

  const live = await Promise.allSettled([
    registered.get('reach_run').execute({ channel: 'v2ex', action: 'hot', args: { limit: 2 } }, {}),
    registered.get('reach_search').execute({ channel: 'web', query: 'DeepSeek', limit: 2 }, {}),
    registered.get('reach_search').execute({ channel: 'github', query: 'yt-dlp', limit: 2 }, {}),
    registered.get('reach_search').execute({ channel: 'bilibili', query: 'Python', limit: 2 }, {}),
  ]);

  const labels = ['v2ex.hot', 'web.search', 'github.search', 'bilibili.search'];
  live.forEach((settled, index) => {
    const label = labels[index];
    if (settled.status === 'rejected') {
      check(label + ' không ném', false, String(settled.reason?.message ?? settled.reason));
      return;
    }
    const value = settled.value;
    check(
      label + ' trả phong bì hợp lệ',
      typeof value.ok === 'boolean' && Array.isArray(value.items),
      'ok=' + value.ok + ' items=' + value.items.length,
    );
    if (value.ok) {
      check(
        label + ' có ít nhất 1 item',
        value.items.length > 0,
        value.items[0]?.title ?? '',
      );
      check(
        label + ' item có shape chuẩn',
        value.items.every(
          (item) =>
            'title' in item &&
            'url' in item &&
            'author' in item &&
            'published_at' in item &&
            'text' in item &&
            'raw' in item,
        ),
      );
    }
  });

  // ── reach_read tự định tuyến theo URL ──
  const readRoute = await Promise.allSettled([
    registered.get('reach_read').execute({ target: 'https://www.v2ex.com/t/1254622' }, {}),
    registered.get('reach_read').execute({ target: 'owner/repo-khong-ton-tai-xyz/abc' }, {}),
  ]);
  if (readRoute[0].status === 'fulfilled') {
    check(
      'reach_read định tuyến v2ex',
      readRoute[0].value.channel === 'v2ex',
      readRoute[0].value.channel,
    );
  } else {
    check('reach_read định tuyến v2ex', false, String(readRoute[0].reason?.message));
  }

  // ── curlRequest: dự phòng TLS fingerprint ──
  const { curlRequest, normalizePublicHttpUrl } = await import('../lib/runtime.js');
  const viaCurl = await curlRequest('https://example.com', { http: DEFAULT_HTTP_FOR_TEST });
  check('curlRequest trả 200', viaCurl.status === 200, 'status ' + viaCurl.status);
  check('curlRequest lấy được body', viaCurl.body.includes('Example Domain'));
  check('curlRequest báo via=curl', viaCurl.via === 'curl');
  let ssrfBlocked = false;
  try {
    await curlRequest('http://127.0.0.1/', { http: DEFAULT_HTTP_FOR_TEST });
  } catch (error) {
    ssrfBlocked = error.code === 'BAD_INPUT';
  }
  check('curlRequest vẫn chặn SSRF', ssrfBlocked);

  // ── định tuyến target không phải URL ──
  let bare = null;
  try {
    await registered.get('reach_read').execute({ target: '4465379983' }, {});
  } catch (error) {
    bare = error;
  }
  check('id trần không tự chọn kênh -> BAD_INPUT kèm gợi ý', bare?.code === 'BAD_INPUT' && String(bare.message).includes('channel'));

  const ownerRepo = await registered.get('reach_read').execute({ target: 'yt-dlp/yt-dlp' }, {});
  check('owner/repo tự định tuyến github', ownerRepo.channel === 'github', ownerRepo.channel);

  // ── textBudget ──
  const { ctx: ctxB, registered: regB } = fakeContext();
  apply(ctxB, { textBudget: 120 });
  const bigRun = await regB.get('reach_run').execute(
    { channel: 'v2ex', action: 'read', args: { target: '1254622' } },
    {},
  );
  const rendered = regB.get('reach_run').output.render({}, bigRun)[0].text;
  check('textBudget cắt văn bản', rendered.length < 1200, 'độ dài ' + rendered.length);
  check('textBudget ghi chú phần bị cắt', rendered.includes('đã cắt bớt'));

  // ── config: tắt một kênh ──
  const { ctx: ctx2, registered: reg2 } = fakeContext();
  apply(ctx2, { channels: ['web', 'v2ex'] });
  const channels2 = await reg2.get('reach_channels').execute({}, {});
  check(
    'config channels lọc đúng',
    channels2.channels.length === 2,
    channels2.channels.map((item) => item.name).join(','),
  );
  threw = false;
  try {
    await reg2.get('reach_search').execute({ channel: 'github', query: 'x' }, {});
  } catch (error) {
    threw = error.code === 'NEED_SETUP';
  }
  check('kênh bị tắt -> NEED_SETUP', threw);

  // ── config: giá trị rác bị bỏ qua ──
  const { ctx: ctx3, registered: reg3 } = fakeContext();
  apply(ctx3, { timeoutMs: -5, maxResponseBytes: 'x', channels: ['web', 3] });
  const channels3 = await reg3.get('reach_channels').execute({}, {});
  check('config bỏ giá trị rác', channels3.channels.length === 1, channels3.channels.map((c) => c.name).join(','));
  const { ctx: ctx4, registered: reg4 } = fakeContext();
  apply(ctx4, undefined);
  const channels4 = await reg4.get('reach_channels').execute({}, {});
  check(
    'config mặc định đủ ' + shipped.length + ' kênh',
    channels4.channels.length === shipped.length,
    channels4.channels.map((c) => c.name).join(','),
  );

  dispose();
  check('dispose gỡ hết công cụ', registered.size === 0, String(registered.size));

  // ── báo cáo ──
  for (const row of results) {
    console.log((row.ok ? 'PASS ' : 'FAIL ') + row.label + (row.detail ? '  [' + row.detail + ']' : ''));
  }
  console.log('\n' + (results.length - failures) + '/' + results.length + ' kiểm tra đạt');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('LỖI KHÔNG BẮT ĐƯỢC:', error);
  process.exit(1);
});
