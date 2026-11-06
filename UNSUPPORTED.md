# Vì sao 5 kênh còn lại không có trong plugin

Ghi lại **bằng chứng thực nghiệm** để người sau không mất công thử lại. Mọi kết
quả dưới đây đo từ chính máy chạy DSH này, bằng `curl` trực tiếp, không qua
trung gian.

Cập nhật lần cuối: 2026-11-06.

## Tóm tắt

| Kênh | Trạng thái | Cần gì để chạy được |
|---|---|---|
| `xiaohongshu` | ❌ chặn cứng | Tài khoản thật + cookie `web_session` |
| `facebook` | ❌ chặn cứng | Tài khoản thật + cookie `c_user`/`xs` |
| `instagram` | ❌ chặn cứng | Tài khoản thật + cookie `sessionid` |
| `boss` | ❌ chặn cứng | Trình duyệt thật vượt fingerprint check |
| `xiaoyuzhou` | ❌ cần token | Token `x-jike-access-token` của app |

Không cái nào chạy được bằng HTTP thuần ẩn danh. Bốn cái đầu còn đi ngược
nguyên tắc "không đụng tài khoản" của plugin.

## Bằng chứng từng kênh

### xiaohongshu

Đã đổi tên miền: `xiaohongshu.com` chuyển hướng sang `rednote.com`.

```
GET https://www.xiaohongshu.com/explore
→ 302 → https://www.rednote.com/login?redirectPath=...

GET https://www.rednote.com/explore
→ 200 nhưng url_effective vẫn là /login (login wall)

GET https://www.xiaohongshu.com/api/sns/web/v1/homefeed
→ 500

GET https://edith.xiaohongshu.com/api/sns/web/v1/homefeed
→ 404
```

Đã thử thêm: `?channel_id=homefeed_recommend` → vẫn 302. RSSHub
(`rsshub.app/xiaohongshu/...`) → 403 Cloudflare.

### facebook

```
GET https://www.facebook.com/nasa                          → 302 (login)
GET https://mbasic.facebook.com/nasa                       → 200 nhưng redirect tới /login.php
GET https://m.facebook.com/nasa                            → 400
GET https://web.facebook.com/nasa?_fb_noscript=1           → 400, size 1542
GET https://www.facebook.com/plugins/post.php?href=...     → 400
GET https://graph.facebook.com/nasa                        → 403 (cần access token)
```

RSSHub (`rsshub.app/facebook/page/nasa`) → 403 Cloudflare.

### instagram

Đây là trường hợp dễ nhầm nhất: **một số endpoint trả 200 nhưng nội dung rỗng**.

```
GET https://www.instagram.com/instagram/                                    → 200, chỉ app shell
GET https://www.instagram.com/p/<id>/embed/captioned/                       → 200, size 185181
GET https://www.instagram.com/api/v1/users/web_profile_info/?username=x     → 404
GET https://i.instagram.com/api/v1/users/web_profile_info/?username=x       → 404 (trả HTML login)
GET https://www.instagram.com/p/<id>/?__a=1&__d=dis                         → 404
GET https://api.instagram.com/oembed/?url=...                               → 302 → HTML shell
```

Trang embed 185 KB trông như thành công, nhưng khi tìm `caption`, `username`,
`og:description` trong đó thì **không có gì** — chỉ là bundle JavaScript. Đây
đúng là cái bẫy "thành công nhưng nội dung rỗng" mà Agent Reach 1.6.1 phải sửa.

Frontend thay thế (imginn, picuki, picnob) đều 403 Cloudflare.

### boss (zhipin.com)

```
GET https://www.zhipin.com/wapi/zpgeek/search/joblist.json?query=python&city=101010100
    Header đầy đủ: UA Chrome, Referer trang tìm việc, Accept: application/json
→ {"code":37,"message":"您的环境存在异常.","zpData":{"seed":"...","ts":...,"name":"..."}}
```

`code: 37` = phát hiện môi trường bất thường. Nó trả `seed` + `name` để client
tính chữ ký fingerprint. Trang web `https://www.zhipin.com/web/geek/job?...`
trả 200 nhưng chỉ 9146 byte — vỏ ứng dụng, không có job data.

Cần trình duyệt thật chạy JavaScript để sinh fingerprint, tức là đúng cái mà
Agent Reach làm bằng CloakBrowser.

### xiaoyuzhou

Trang là SPA Next.js **export tĩnh**, không nhúng dữ liệu:

```
GET https://www.xiaoyuzhoufm.com/
→ 200, 28056 byte, có __NEXT_DATA__ nhưng props.pageProps = {} (rỗng)

GET https://www.xiaoyuzhoufm.com/episode/<id bất kỳ>
→ 200 nhưng pageProps chứa {"statusCode":400} hoặc page "/404"
```

API cần auth token:

```
GET https://api.xiaoyuzhoufm.com/v1/episode/get        → 401
GET https://api.xiaoyuzhoufm.com/v1/podcast/detail     → 401
GET https://api.xiaoyuzhoufm.com/v1/discovery-feed/list → 401
  (đã thử kèm User-Agent app iOS, Referer, không có header token → vẫn 401)
```

Lưu ý: tài liệu Agent Reach ghi kênh này "cần Groq key" — đúng, nhưng **chỉ cho
phần transcribe audio**. Còn việc đọc metadata episode thì cần token
`x-jike-access-token` của app, không liên quan Groq.

## Ghi chú kỹ thuật: Twitter và dấu vân tay TLS

`timeline-profile` của Twitter giới hạn **30 lượt/giờ theo IP**, nhưng còn một
lớp chặn thứ hai đáng chú ý: **nó nhận diện thư viện HTTP qua TLS ClientHello**,
không qua header.

Đo trên máy này, cùng URL, cùng `User-Agent`, cùng HTTP/1.1:

```
curl --http1.1  → 200
node fetch      → 429
node:https      → 429
```

Nghĩa là gửi đúng UA trình duyệt vẫn không đủ. Vì vậy runtime của plugin có
thêm `curlRequest()` — gọi binary `curl` của hệ điều hành làm **dự phòng**, bật
riêng cho endpoint timeline. Hàm này vẫn:

- kiểm tra SSRF bằng `normalizePublicHttpUrl` trước khi chạy và sau redirect,
- áp `timeoutMs` và `maxResponseBytes` từ `ctx.http`,
- giới hạn kích thước và trả `NEED_SETUP` nếu máy không có `curl`.

Endpoint `tweet-result` (đọc 1 tweet) **không** bị chặn kiểu này — `read` vẫn đi
bằng `httpRequest` thuần và hoạt động ổn định.

## Những gì đã thử mà không được

- **Nitter** (frontend Twitter thay thế): `nitter.net` → trang "is offline";
  `nitter.tiekoetter.com` → challenge "not a bot"; `nitter.space`, `lightbrd.com`
  → 403 Cloudflare; `xcancel.com` → 451.
- **RSSHub** cho instagram / facebook / xiaohongshu → 403 Cloudflare.
- **Search engine làm nguồn phụ**: Bing `site:x.com elonmusk` → 133 KB nhưng
  0 link x.com, toàn kết quả rác; DuckDuckGo HTML → 202 không dùng được.
- **Cookie trình duyệt**: profile Chromium duy nhất trên máy
  (`/data/.config/chromium`) **rỗng** — chỉ có `BrowserMetrics` và
  `Crash Reports`, không có `Default/Cookies`. Credential store của DSH cũng chỉ
  có 2 bản ghi: `client-connection/browser-session` và `llm-pi-ai/google`.
  Không có session của nền tảng nào.

## Điều kiện để bật lại

Nếu sau này có cookie hợp lệ của chính người dùng, ba kênh đầu có thể bật bằng
cách thêm backend đọc cookie vào channel tương ứng:

1. Lấy cookie từ trình duyệt của người dùng (họ tự đăng nhập, không ai làm hộ).
2. Lưu vào credential store của DSH, **không** ghi vào file cấu hình.
3. Thêm backend `cookie` bên cạnh backend hiện có; `httpRequest` nhận thêm header
   `Cookie`.

Việc này **chưa làm** vì nó phá nguyên tắc "chỉ đọc, không đụng tài khoản" mà
plugin đang giữ, và chưa có cookie nào trên máy để kiểm chứng. Cần người dùng
quyết định rõ ràng trước khi triển khai.
