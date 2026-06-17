import { SearchResult } from '../models/types';

export interface SinaInstrument {
  /** 新浪行情 API 代码（大小写敏感） */
  code: string;
  name: string;
  keywords: string[];
}

/** 新浪环球指数 / 期货 / 贵金属，搜索 API 无法覆盖的品种 */
export const SINA_INSTRUMENTS: SinaInstrument[] = [
  { code: 'b_NKY', name: '日经225指数', keywords: ['nky', 'hq.nky', 'hq_nky', 'b_nky', '日经225', '日经', 'nikkei', 'rj225'] },
  { code: 'b_KOSPI', name: '韩国KOSPI指数', keywords: ['kospi', 'b_kospi', '首尔综合', '韩国综合', '韩指'] },
  { code: 'b_HSI', name: '恒生指数', keywords: ['hsi', 'b_hsi', '恒生指数', '恒指'] },
  { code: 'b_SPX', name: '标普500指数', keywords: ['spx', 'b_spx', '标普500', '标普'] },
  { code: 'int_dji', name: '道琼斯指数', keywords: ['dji', '道琼斯', '道指'] },
  { code: 'int_nasdaq', name: '纳斯达克指数', keywords: ['nasdaq', 'ixic', '纳斯达克'] },
  { code: 'int_ftse', name: '伦敦富时100指数', keywords: ['ftse', '富时100', '伦敦指数'] },
  { code: 'hf_CHA50CFD', name: '富时中国A50期货', keywords: ['a50', 'cha50', 'hf_cha50cfd', '富时a50', '富时中国a50', 'xin9'] },
  { code: 'hf_OIL', name: '布伦特原油', keywords: ['oil', 'hf_oil', '布伦特', '布伦特原油', 'brent'] },
  { code: 'hf_CL', name: '纽约原油', keywords: ['cl', 'hf_cl', 'wti', '纽约原油', '美原油'] },
  { code: 'hf_XAU', name: '伦敦金（现货）', keywords: ['xau', 'hf_xau', '伦敦金', '现货黄金', '国际金'] },
  { code: 'hf_XAG', name: '伦敦银（现货）', keywords: ['xag', 'hf_xag', '伦敦银', '现货白银', '国际银'] },
  { code: 'hf_GC', name: '纽约黄金', keywords: ['gc', 'hf_gc', '纽约黄金', 'comex黄金', '美黄金'] },
  { code: 'hf_SI', name: '纽约白银', keywords: ['si', 'hf_si', '纽约白银', 'comex白银', '美白银'] },
  { code: 'nf_AU0', name: '沪金主连', keywords: ['au0', 'nf_au0', '沪金', '沪金主连', '黄金期货'] },
  { code: 'nf_AG0', name: '沪银主连', keywords: ['ag0', 'nf_ag0', '沪银', '沪银主连', '白银期货'] },
];

const INSTRUMENT_BY_CODE = new Map(
  SINA_INSTRUMENTS.map((item) => [item.code.toLowerCase(), item])
);

/** 腾讯搜索 market+code → 新浪行情代码 */
const MARKET_CODE_MAP: Record<string, string> = {
  'fu:cn': 'hf_CHA50CFD',
  'ft:xin9': 'hf_CHA50CFD',
};

export function isSinaGlobalCode(code: string): boolean {
  const c = code.toLowerCase();
  return /^(b_|int_|hf_|nf_)/.test(c);
}

/** 内部统一小写代码 */
export function normalizeInstrumentCode(code: string): string {
  return code.toLowerCase();
}

/** 新浪 API 请求代码（大小写敏感） */
export function toSinaQuoteCode(code: string): string {
  const known = INSTRUMENT_BY_CODE.get(code.toLowerCase());
  if (known) {
    return known.code;
  }
  return code;
}

export function resolveSinaCode(code: string): string {
  const c = code.toLowerCase();
  const known = INSTRUMENT_BY_CODE.get(c);
  if (known) {
    return normalizeInstrumentCode(known.code);
  }
  const mapped = MARKET_CODE_MAP[c.replace(/^sina:/, '')];
  if (mapped) {
    return normalizeInstrumentCode(mapped);
  }
  if (isSinaGlobalCode(c)) {
    return c;
  }
  return c;
}

export function mapSearchToSinaCode(market: string, rawCode: string): string | undefined {
  const key = `${market.toLowerCase()}:${rawCode.toLowerCase()}`;
  return MARKET_CODE_MAP[key];
}

function matchScore(keyword: string, instrument: SinaInstrument): number {
  const kw = keyword.toLowerCase();
  const code = instrument.code.toLowerCase();
  if (code === kw) {
    return 100;
  }
  if (instrument.keywords.some((k) => k.toLowerCase() === kw)) {
    return 95;
  }
  if (instrument.name.toLowerCase() === kw) {
    return 90;
  }
  if (instrument.name.toLowerCase().includes(kw)) {
    return 80;
  }
  if (instrument.keywords.some((k) => k.toLowerCase().includes(kw))) {
    return 70;
  }
  if (instrument.keywords.some((k) => kw.includes(k.toLowerCase()) && k.length >= 2)) {
    return 60;
  }
  if (code.includes(kw)) {
    return 50;
  }
  return 0;
}

export function searchLocalInstruments(keyword: string): SearchResult[] {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return [];
  }

  return SINA_INSTRUMENTS.map((instrument) => ({
    instrument,
    score: matchScore(trimmed, instrument),
  }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ instrument }) => ({
      code: normalizeInstrumentCode(instrument.code),
      name: instrument.name,
      market: 'sina',
    }));
}
