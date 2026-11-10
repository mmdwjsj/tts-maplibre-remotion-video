/**
 * 视觉主题 —— B8「亮蓝海 + 白色陆地 + 单一橙色名次梯度」配色。
 *
 * 注意这是一套**浅色**主题：视频背景即「海」，未上榜府接近纯白，
 * 因此正文与角标用深墨绿 #203027，面板改为浅色半透明卡片。
 */
export const theme = {
  /* 海（= 视频背景 + 中央光晕） */
  background: '#2FA9E1',
  backgroundGlow: '#43B4E8',

  /* 陆地：未上榜府 + 府界 */
  provinceBase: '#FFFFFF',
  provinceBorder: '#8C9BA5',

  /* 上榜府：单一橙色系的名次梯度，**名次越靠前越深**（1 最深 → 5 最浅）。
     同一色相（约 h=20°）只走明度，所以五个府看起来是同一套颜色的深浅，
     而不是两种色系分组；最深一档刻意压到砖橙，浅端停在 #F7A35F —— 再浅
     就和白色陆地区分不开了。 */
  rankFill: ['#A8400A', '#C5570F', '#E06E17', '#F08838', '#F7A35F'],
  /** 名次超出色阶长度时的兜底色（= 最浅一档，保证仍与前三档有区分）。 */
  rankFallbackFill: '#F7A35F',
  /** 上榜府描边：白色细线，把相邻橙/绿府分开。 */
  provinceEdge: '#FFFFFF',

  /* 文字与强调色 */
  text: '#203027',
  mutedText: '#5E6E78',
  accent: '#E0661A',
  /** 强调色的文字版（在浅色面板上对比更足）。 */
  accentInk: '#C9520F',

  /**
   * 排名读数是府正上方的三行纯文字（2026-11-08 起不再有玻璃卡片），可读性
   * 由白色描边 halo 保证（见 `ThailandMap` 的 `HALO`），这里不再需要面板底色。
   */
};

export const animation = {
  fps: 30,
  introDuration: 2.4,
  defaultSegmentDuration: 3.2,
  highlightDuration: 0.55,
  labelDuration: 0.45,
  // 片尾一起展示全部读数的停留秒数（离线/Studio 兜底值；服务端按府数用
  // `finaleHoldSeconds` 计算，5 个府 = 4.5s，最多 8s）。
  finalHoldDuration: 4.5,
};
