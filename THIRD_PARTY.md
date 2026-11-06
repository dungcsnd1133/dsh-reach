# Ghi công bên thứ ba

## Agent Reach

- Nguồn: https://github.com/Panniantong/Agent-Reach
- Phiên bản tham chiếu: 1.6.1
- Giấy phép: MIT, Copyright (c) 2025 Agent Eyes
- Phần được port: kiến trúc kênh/hành động/backend, phong bì kết quả thống
  nhất (`agent_reach/runtime/result.py`), hệ mã lỗi, hàm chuẩn hóa URL công
  khai (`agent_reach/utils/url.py`), và hành vi của các kênh `web`, `github`,
  `v2ex`, `youtube`, `bilibili`.

Bản port này viết lại bằng JavaScript/Node, không chứa mã Python và không phụ
thuộc gói `agent-reach` trên PyPI. Các phần cố tình không port: đăng nhập,
quản lý profile trình duyệt, cài đặt công cụ, và hành động `transcribe` (cần
Groq/OpenAI key).

### Giấy phép gốc

```
MIT License

Copyright (c) 2025 Agent Eyes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
