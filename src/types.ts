import type {FeatureCollection, Geometry} from 'geojson';

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
};

export type ProvinceProperties = {
  provinceId: string;
  provinceEn: string;
  provinceTh: string;
  centroid?: [number, number];
};

export type ThailandGeoJson = FeatureCollection<Geometry, ProvinceProperties>;
