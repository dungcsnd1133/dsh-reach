# Hợp đồng kênh — dsh-reach

Tài liệu này là **nguồn sự thật duy nhất** cho việc viết một module kênh. Đọc kỹ
trước khi code. Không sửa `lib/runtime.js` hay `lib/channels/index.js` — chúng đã
chốt; nếu bạn thấy cần đổi contract, báo lại Lead thay vì tự sửa.

Nguồn tham chiếu: `/tmp/reach-src/agent_reach/channels/*.py` (Agent Reach 1.6.1,
giấy phép MIT). Port hành vi sang JavaScript/Node thuần, **không** gọi Python.

## 1. Hình dạng module

Mỗi kênh là một file `lib/channels/<tên>.js`, export đúng một object tên `channel`:

```js
export const channel = {
  name: 'github',                    // khóa trong CHANNELS, trùng tên file
  description: '…tiếng Việt…',       // hiện trong reach_channels
  level: 'default',                  // 'default' | 'optional' | 'experimental'

  canHandle(url) { /* true/false */ },   // bỏ trống nếu không nhận URL

  actions: {
    search: {
      description: '…tiếng Việt…',
      params: {
        query: { type: 'string', required: true, description: 'nội dung cần tìm' },
        limit: { type: 'integer', required: false, default: 5, description: 'số kết quả tối đa' },
      },
      backends(ctx) {
        return [{ label: 'github-api', async run() { /* → Array<item> */ } }];
      },
    },
  },
};
```

## 2. `ctx` truyền vào `backends(ctx)`

| Trường | Kiểu | Ý nghĩa |
|---|---|---|
| `ctx.args` | object | tham số đã qua `validateArgs` (đã điền default, số đã ép int) |
| `ctx.http` | object | `{timeoutMs, maxResponseBytes, userAgent, githubToken}` |
| `ctx.signal` | AbortSignal \| undefined | tín hiệu hủy của bước gọi |
| `ctx.channel` | string | tên kênh |
| `ctx.action` | string | tên hành động |

`backends` trả về **mảng có thứ tự**; phần tử đầu là ưu tiên cao nhất. Mỗi phần
tử: `{ label: string, run: async () => Array<item> }`.

## 3. Quy tắc bắt buộc

1. **Chỉ đọc.** Không POST ghi dữ liệu, không đăng nhập, không đòi mật khẩu.
2. **Không tự dựng phong bì kết quả.** Trả `Array<item>`; `runAction` lo phần
   còn lại. Trả mảng rỗng bị coi là lỗi `UPSTREAM_BROKEN` — nếu thật sự không có
   kết quả, hãy ném `ReachError` có mã phù hợp.
3. **Lỗi phải là `ReachError`** với mã đúng nghĩa. Dùng `classify()` chỉ khi bắt
   lỗi hệ thống. Không ném `Error` trơn cho tình huống đã hiểu.
4. **Mọi `fetch` đi qua `httpRequest`/`getJson`** trong `../runtime.js`, không
   dùng `fetch` toàn cục trực tiếp — như vậy mới có giới hạn byte, timeout và
   chặn SSRF. Truyền `http: ctx.http, signal: ctx.signal`.
5. **URL do người dùng nhập** phải qua `normalizePublicHttpUrl` trước khi fetch.
6. **Không ghi đĩa**, không tạo file tạm, không đọc `~/.agent-reach`.
7. **Tiếng Việt** cho mọi `description` và mọi thông điệp `ReachError`. Thuật ngữ
   kỹ thuật giữ nguyên (ví dụ "pull request", "node", "phụ đề").
8. **Không import package ngoài.** Chỉ `node:*` và các module trong repo.
9. `Object.values(channel.actions)` phải có `description` và `params` (params có
   thể là `{}` nhưng phải tồn tại).

## 4. Item

`makeItem` từ `../runtime.js` tạo:

```js
{ title, url, author, published_at, text, raw }
```

Trường thiếu để `null` (hàm đã xử lý). `text` nên là nội dung đã ghép, ví dụ với
`read` của issue thì là thân bài + các bình luận dạng `\n@user: nội dung`.

Dùng `unixToIso(giây)` để đổi mốc thời gian unix sang ISO 8601 UTC.

## 5. Giới hạn chung

- Mặc định 30s timeout, 5 MiB/phản hồi — lấy từ `ctx.http`, không hardcode.
- Cắt bớt văn bản dài một cách có ý thức (ví dụ README tối đa 50 000 ký tự).
- Mỗi kênh chỉ nên có 1–4 hành động; đừng thêm hành động ngoài danh sách dưới.

## 6. Hành động theo kênh (chốt)

### `github.js` — level `default`
- `search`: `query` (bắt buộc), `limit` (mặc định 5). Tìm repository.
- `read`: `target` (bắt buộc) — `owner/repo` hoặc link repo/issue/PR.
- Backend: `gh` nếu có, fallback `github-api` (60 lượt/giờ, hoặc 5000 nếu có
  `ctx.http.githubToken`).
- Port từ `github.py`: `_parse_target`, `_repo_item`, `_search`, `_read`.

### `v2ex.js` — level `default`
- `hot`: `limit` (mặc định 10).
- `node`: `node_name` (bắt buộc), `limit` (mặc định 10).
- `read`: `target` (bắt buộc) — link topic hoặc id.
- `user`: `username` (bắt buộc).
- Backend duy nhất `v2ex-api`, base `https://www.v2ex.com/api/`.
- Port từ `v2ex.py`: `_parse_topic_id`, `_topic_item`.

### `youtube.js` — level `default`
- `search`: `query` (bắt buộc), `limit` (mặc định 5).
- `read`: `target` (bắt buộc) — link video hoặc video id 11 ký tự.
- `subtitle`: `target` (bắt buộc), `lang` (mặc định `zh-Hans,zh,en,en-orig`).
- **KHÔNG** port `transcribe` (cần Groq/OpenAI key + gọi model ngoài).
- Backend `yt-dlp` nếu có trên PATH; không có thì ném `NEED_SETUP` nói rõ cần
  cài `yt-dlp`. Port từ `youtube.py`: `_video_url`, `_VIDEO_ID_RE`,
  parser VTT (`_VTT_TIME_RE`, `_TAG_RE`).

### `bilibili.js` — level `default`
- `search`: `query` (bắt buộc), `limit` (mặc định 5).
- `read`: `target` (bắt buộc) — BV id hoặc link video/b23.tv.
- `hot`: `limit` (mặc định 10).
- Dùng API công khai `https://api.bilibili.com` với header `Referer` +
  `User-Agent` của trình duyệt, như `_bili_api` trong `bilibili.py`.
- `subtitle` cần đăng nhập → ném `NEED_LOGIN`, không cố lách.
- Không phụ thuộc `bili-cli`.

## 7. Kiểm tra trước khi báo xong

```bash
node --check lib/channels/<tên>.js
node -e "import('./lib/channels/<tên>.js').then(m => {
  const c = m.channel;
  console.log(c.name, Object.keys(c.actions));
})"
```

Và một lần gọi thật, ví dụ với v2ex:

```bash
node -e "
import('./lib/channels/v2ex.js').then(async (m) => {
  const c = m.channel;
  const { runAction } = await import('./lib/runtime.js');
  const ctx = { args: { limit: 2 }, http: (await import('./lib/runtime.js')).DEFAULT_HTTP };
  const b = c.actions.hot.backends(ctx);
  console.log(JSON.stringify(await runAction(c.name, 'hot', b), null, 1).slice(0, 800));
});"
```

Báo cáo lại: file đã tạo, hành động đã kiểm, kết quả gọi thật (tối đa 5 dòng),
và bất kỳ khác biệt nào so với bản Python.
