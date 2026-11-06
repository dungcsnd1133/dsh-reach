# dsh-reach

Plugin chỉ-đọc đa nền tảng cho DeepSeek Harness: tìm kiếm web, đọc GitHub, V2EX,
YouTube và Bilibili ngay trong tiến trình DSH — không cần cài CLI Python bên ngoài.

Lấy cảm hứng và port hành vi từ [Agent Reach](https://github.com/Panniantong/Agent-Reach)
(MIT, tác giả Panniantong). Plugin này độc lập: nó không gọi `agent-reach`, không
đọc `~/.agent-reach`, và không cần Python.

## Vì sao có plugin này

Agent Reach là một CLI Python rất tốt nhưng phải cài ngoài (uv + nhiều binary
theo kênh) và agent phải gọi qua shell. `dsh-reach` đưa đúng những kênh ổn định
nhất vào trong DSH dưới dạng công cụ gốc, nên không cần shell, không cần
subprocess cho phần lớn kênh, và kết quả đi thẳng vào hội thoại.

## Bốn công cụ

| Công cụ | Việc nó làm |
|---|---|
| `reach_search` | Tìm trên một kênh: `web`, `github`, `v2ex`, `youtube`, `bilibili` |
| `reach_read` | Đọc một URL; tự chọn kênh theo tên miền, hoặc ép bằng tham số `channel` |
| `reach_run` | Gọi một hành động bất kỳ của một kênh (`hot`, `node`, `user`, `subtitle`, …) |
| `reach_channels` | Liệt kê kênh đang bật, hành động và tham số của từng kênh |

## Kênh và hành động

| Kênh | Hành động | Cần gì |
|---|---|---|
| `web` | `search`, `read` | Không. Exa MCP công khai + Jina Reader |
| `github` | `search`, `read` | Không. `gh` nếu có, không thì GitHub REST (60 lượt/giờ) |
| `v2ex` | `hot`, `node`, `read`, `user` | Không. API công khai |
| `youtube` | `search`, `read`, `subtitle` | `yt-dlp` trên PATH |
| `bilibili` | `search`, `read`, `hot`, `subtitle` | Không. API công khai |
| `xueqiu` | `quote`, `search` | Không. Giá cổ phiếu A/HK/US |
| `linkedin` | `jobs`, `read` | Không. jobs-guest API công khai |
| `reddit` | `subreddit`, `search`, `read` | Không. RSS công khai (rate limit chặt) |
| `twitter` | `profile`, `read` | Không. Syndication công khai; `profile` tự lùi sang `curl` khi bị chặn TLS fingerprint |

Cần token GitHub để nâng hạn mức lên 5000 lượt/giờ: đặt biến môi trường
`GITHUB_TOKEN` (hoặc đổi `githubTokenEnv` trong config). Token chỉ được đọc từ
môi trường — không ghi vào file cấu hình.

## Chỉ đọc

Đây là ràng buộc thiết kế, không phải tính năng tùy chọn:

- Không đăng bài, bình luận, thích, theo dõi, nhắn tin.
- Không đăng nhập thay người dùng, không hỏi mật khẩu, không lưu cookie.
- Mọi `fetch` đi qua một client duy nhất có giới hạn kích thước, timeout, và
  chặn đích không công khai (localhost, IP nội bộ, metadata cloud), kể cả sau
  khi chuyển hướng.

## Định dạng kết quả

Mọi lần gọi trả về một phong bì thống nhất:

```json
{
  "schema_version": 1,
  "ok": true,
  "channel": "v2ex",
  "action": "hot",
  "backend": "v2ex-api",
  "items": [
    {
      "title": "…",
      "url": "https://www.v2ex.com/t/…",
      "author": "…",
      "published_at": "2026-11-05T02:00:08Z",
      "text": "…",
      "raw": {}
    }
  ],
  "meta": { "elapsed_ms": 214, "attempts": [] },
  "error": null
}
```

Khi lỗi:

```json
{
  "ok": false,
  "items": [],
  "error": { "code": "RATE_LIMITED", "message": "…", "hint": "…" }
}
```

Mã lỗi: `NEED_SETUP`, `NEED_LOGIN`, `UPSTREAM_BROKEN`, `TIMEOUT`,
`RATE_LIMITED`, `PLATFORM_BLOCKED`, `NOT_FOUND`, `BAD_INPUT`, `BUSY`.

Một hành động có thể có nhiều backend; bộ điều phối thử theo thứ tự và dừng khi
gặp mã không thể cứu bằng cách đổi backend.

## Cấu hình

Dòng patch trong `cordis.patch.yml`:

```yaml
- insert:
    - id: reach
      name: 'dsh-reach'
      config:
        timeoutMs: 30000
        maxResponseBytes: 5242880
        githubTokenEnv: GITHUB_TOKEN
        channels:
          - web
          - github
          - v2ex
          - youtube
          - bilibili
```

Bỏ một kênh khỏi `channels` để không đăng ký nó. Kênh bị tắt vẫn trả lỗi
`NEED_SETUP` nếu bị gọi nhầm.

`textBudget` (mặc định 1500) cắt văn bản hiển thị cho mỗi kết quả để tiết kiệm
context; nội dung đầy đủ vẫn nằm trong `raw` của phong bì.

## Cài đặt

Plugin này cài qua Plugin Manager của DSH như mọi bundle khác:

```
plugin_manager({ action: 'install_bundle', target: '/data/dsh-022/reach-plugin' })
```

## Kênh không hỗ trợ

`xiaohongshu`, `facebook`, `instagram`, `boss`, `xiaoyuzhou` **không có** trong
plugin. Chúng bị chặn thật với HTTP ẩn danh, hoặc cần cookie/token tài khoản.
Bằng chứng chi tiết từng endpoint, gồm cả những hướng đã thử mà không được, nằm
ở [UNSUPPORTED.md](UNSUPPORTED.md).

## Giấy phép

MIT. Hành vi và giao diện kết quả port từ Agent Reach (MIT,
Copyright (c) 2025 Agent Eyes). Xem `THIRD_PARTY.md`.
