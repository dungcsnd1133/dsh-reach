/**
 * Sổ đăng ký kênh.
 *
 * Một module kênh export một object thuần, không phải class:
 *
 *   export const channel = {
 *     name: 'github',
 *     description: 'Kho GitHub, issue và pull request',
 *     urlHosts: ['github.com'],            // dùng để định tuyến URL của reach_read
 *     actions: {
 *       search: { params: {...}, run(ctx, args) { ... } },
 *       read:   { params: {...}, run(ctx, args) { ... } },
 *     },
 *   }
 *
 * Mỗi `run` trả về `Array<item>` (xem `makeItem`) hoặc ném `ReachError`.
 * Điều phối, fallback, đo thời gian và phong bì kết quả nằm ở `runAction`,
 * nên kênh không tự dựng phong bì và không tự quyết định fallback.
 *
 * `params` dùng đúng DSL nhỏ mà dataclass `Param` của Agent Reach diễn đạt:
 * `{type, required, description, default}` với type 'string' | 'integer'.
 *
 * @module dsh-reach/channels
 */

import { channel as web } from './web.js';
import { channel as github } from './github.js';
import { channel as v2ex } from './v2ex.js';
import { channel as youtube } from './youtube.js';
import { channel as bilibili } from './bilibili.js';
import { channel as xueqiu } from './xueqiu.js';
import { channel as linkedin } from './linkedin.js';
import { channel as reddit } from './reddit.js';
import { channel as twitter } from './twitter.js';

/** Mọi kênh bản dựng này cung cấp, khóa theo tên. */
export const CHANNELS = {
  [web.name]: web,
  [github.name]: github,
  [v2ex.name]: v2ex,
  [youtube.name]: youtube,
  [bilibili.name]: bilibili,
  [xueqiu.name]: xueqiu,
  [linkedin.name]: linkedin,
  [reddit.name]: reddit,
  [twitter.name]: twitter,
};

/** Tra một kênh theo tên, hoặc ném lỗi nêu các tên hợp lệ. */
export function getChannel(name) {
  const channel = CHANNELS[name];
  if (channel === undefined) {
    throw new Error(
      'kênh không tồn tại: "' +
        String(name) +
        '"; các kênh có sẵn: ' +
        Object.keys(CHANNELS).join(', '),
    );
  }
  return channel;
}

/**
 * Xác định kênh nào sở hữu một URL, tương đương định tuyến `read <url>` của
 * Agent Reach. Mặc định rơi về kênh `web`, vốn nhận mọi URL công khai.
 *
 * @param {string} url
 * @returns {object} kênh nên đọc URL này
 */
export function channelForUrl(url) {
  for (const channel of Object.values(CHANNELS)) {
    if (channel.name === 'web') continue;
    if (typeof channel.canHandle !== 'function') continue;
    if (channel.canHandle(url) === true) return channel;
  }
  return CHANNELS.web;
}

/**
 * Nhóm các kênh theo mức ổn định, để `reach_channels` giải thích được vì sao
 * một kênh có thể lúc chạy lúc không.
 *
 * - `default`: API/nguồn công khai ổn định.
 * - `optional`: chạy được nhưng phụ thuộc ngân sách chia sẻ theo IP (rate limit).
 * - `experimental`: endpoint không chính thức, có thể đổi hoặc chặn bất cứ lúc nào.
 */
export const LEVEL_NOTES = {
  default: 'nguồn công khai ổn định',
  optional: 'chạy được, nhưng có thể bị giới hạn tần suất theo IP',
  experimental: 'endpoint không chính thức, có thể đổi hoặc chặn bất cứ lúc nào',
};

/** Mọi hành động của mọi kênh, dùng cho enum tham số của công cụ. */
export function actionCatalog() {
  const catalog = {};
  for (const channel of Object.values(CHANNELS)) {
    catalog[channel.name] = Object.keys(channel.actions);
  }
  return catalog;
}
