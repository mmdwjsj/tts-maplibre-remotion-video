import type {FeatureCollection, Geometry} from 'geojson';
import type {FramingOptions} from './framing/resolveViewport';

export type RankingDatum = {
  rank: number;
  provinceId: string;
  province?: string;
  provinceEn: string;
  provinceTh: string;
  value: number;
  valueLabel?: string;
  narrationDuration?: number;
};

/**
 * One spoken block of the synthesized narration, in seconds.
 * `opening` is the welcome line; `ranking` maps back to a RankingDatum by rank.
 * `gapAfter` is the silence inserted after the block.
 */
export type AudioSegment = {
  type: 'opening' | 'ranking';
  rank?: number;
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
};

export type ProvinceProperties = {
  provinceId: string;
  provinceEn: string;
  provinceTh: string;
  centroid?: [number, number];
};

export type ThailandGeoJson = FeatureCollection<Geometry, ProvinceProperties>;
