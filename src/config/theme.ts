/**
 * 视觉主题 —— B8「亮蓝海 + 白色陆地 + 前3橙/4-5绿」配色。
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

  /* 上榜府：前 3 名橙色渐层，第 4-5 名绿色（与参考图同语义） */
  rankFill: ['#E0661A', '#F28C28', '#F7AE6A', '#3F7A4E', '#6FA377'],
  /** 名次超出色阶长度时的兜底色（正常情况下用不到）。 */
  rankFallbackFill: '#6FA377',
  /** 上榜府描边：白色细线，把相邻橙/绿府分开。 */
  provinceEdge: '#FFFFFF',

  /* 文字与强调色 */
  text: '#203027',
  mutedText: '#5E6E78',
  accent: '#E0661A',
  /** 强调色的文字版（在浅色面板上对比更足）。 */
  accentInk: '#C9520F',

  /* 浮动名次面板：浅色卡片（旧值，保留兼容） */
  panel: 'rgba(255, 255, 255, 0.94)',
  panelBorder: 'rgba(32, 48, 39, 0.18)',

  /**
   * 浮动名次面板：玻璃卡片。
   *
   * 面板会落在海面或陆地上，所以不再用不透明白底——半透明让下面的府、海岸线
   * 和颜色透出来，观感上像贴在画面上的磨砂玻璃，而不是盖住地图的一块瓷砖。
   * 高光边 + 内侧细描边负责让它在浅色海面和白色陆地上都能定住轮廓。
   */
  panelGlass: 'rgba(255, 255, 255, 0.58)',
  panelGlassEdge: 'rgba(255, 255, 255, 0.92)',
  panelGlassInnerEdge: 'rgba(28, 60, 76, 0.16)',
  panelShadow: 'rgba(11, 45, 66, 0.22)',

  /** 兼容旧引用：单色高亮 = 第 2 名色。 */
  provinceActive: '#F28C28',
};

export const animation = {
  fps: 30,
  introDuration: 2.4,
  defaultSegmentDuration: 3.2,
  highlightDuration: 0.55,
  labelDuration: 0.45,
  finalHoldDuration: 4,
};
