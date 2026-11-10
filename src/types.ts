import type {FeatureCollection, Geometry} from 'geojson';
import type {FramingOptions} from './framing/resolveViewport';
import type {SafeAreaResolution, SafePlatform} from './safearea/safeArea';

export type RankingDatum = {
  rank: number;
  provinceId: string;
  province?: string;
  provinceEn: string;
  provinceTh: string;
  value: number;
  valueLabel?: string;
  /** 每个府自己的单位，直接跟在读数第三行的数值后面；留空则不显示。 */
  unit?: string;
  narrationDuration?: number;
};

/**
 * One spoken block of the synthesized narration, in seconds.
 * `opening` is the welcome line; `ranking` maps back to a RankingDatum by rank.
 * `gapAfter` is the silence inserted after the block.
 *
 * A ranking line is deliberately two blocks — `part: 'rank'` is the rank
 * announcement (`อันดับ 3`) and `part: 'name'` is the province itself — so the
 * map can light the province the moment its name is voiced. Older props carry
 * neither block and no `part`, which means one whole line per province.
 */
export type AudioSegment = {
  type: 'opening' | 'ranking';
  rank?: number;
  part?: 'rank' | 'name';
  duration: number;
  gapAfter?: number;
};

export type ProjectData = {
  title: string;
  subtitle?: string;
  unit?: string;
  locale: 'en' | 'th' | 'zh';
  rankings: RankingDatum[];
  introDuration?: number;
  finalHoldDuration?: number;
  audioSrc?: string;
  fps?: number;
  width?: number;
  height?: number;
  /** When present, the video timeline follows the real audio timeline exactly. */
  audioSegments?: AudioSegment[];
  /**
   * Static map framing. Evaluated once per video from the complete ranking set,
   * then held for every frame (see `src/framing/resolveViewport.ts`).
   */
  framing?: FramingOptions;
  /** Publishing platform; TikTok and 抖音 carry their own safe-area numbers. */
  platform?: SafePlatform;
  /**
   * The **publish description** (captions + hashtags), not the on-video
   * narration. Only its length matters here: it selects the short / medium /
   * long safe-area tier.
   */
  publishDescription?: string;
  /**
   * Safe area, already resolved from the platform config + description tier.
   *
   * The server resolves it once per job and writes it into the render props, so
   * the MP4, the browser preview and the generation log all use the very same
   * rectangles. When it is missing the render falls back to the built-in
   * defaults (short / default platform) — never to "no safe area at all".
   */
  safeArea?: SafeAreaResolution;
  /**
   * 手动微调：预览图里把某个府的读数拖动后记下的像素位移，键是 provinceId
   * （大写）。叠加在自动落位之上；超出 `MAX_MANUAL_OFFSET_PX` 的输入会被
   * 丢弃并回落到自动落位，所以渲染永远拿到的是可用的偏移。
   */
  labelOffsets?: Record<string, {dx: number; dy: number}>;
  /**
   * Development-only switch for the safe-area overlay. It is **never** written
   * into the production render props, so an exported MP4 can never contain the
   * debug mask, borders or coordinate labels.
   */
  debugSafeArea?: boolean;
};

export type ProvinceProperties = {
  provinceId: string;
  provinceEn: string;
  provinceTh: string;
  centroid?: [number, number];
};

export type ThailandGeoJson = FeatureCollection<Geometry, ProvinceProperties>;
