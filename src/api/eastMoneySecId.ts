/** 新浪环球代码 → 东方财富 secid（QuoteID），用于 K 线/分时与旧数据迁移 */
export const SINA_TO_EM_SECID: Record<string, string> = {
  b_nky: '100.N225',
  b_kospi: '100.KS11',
  b_hsi: '100.HSI',
  b_spx: '100.SPX',
  int_dji: '100.DJIA',
  int_nasdaq: '100.NDX',
  int_ftse: '100.FTSE',
  hf_cha50cfd: '100.XIN9',
  hf_oil: '112.B00Y',
  hf_cl: '113.ZNA0',
  hf_xau: '122.XAU',
  hf_xag: '122.XAG',
  hf_gc: '113.GC00',
  hf_si: '113.SI00',
  nf_au0: '113.AU0',
  nf_ag0: '113.AG0',
};

/** 东财 QuoteID → 新浪代码（含连续合约等非 1:1 名称映射） */
export const EM_QUOTE_ID_TO_SINA: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(SINA_TO_EM_SECID).map(([sina, em]) => [em.toUpperCase(), sina])
  ),
  '112.B00Y': 'hf_oil',
};

const EM_SECID_PATTERN = /^\d+\.[A-Za-z0-9.-]+$/;

/** A 股 / 港股 / 美股代码 → 东财 secid */
export function toEastMoneySecId(code: string): string | undefined {
  const c = code.toLowerCase();
  if (/^sh\d+/.test(c)) {
    return `1.${c.slice(2)}`;
  }
  if (/^(sz|bj)\d+/.test(c)) {
    return `0.${c.slice(2)}`;
  }
  if (/^hk\d+/.test(c)) {
    return `116.${c.slice(2)}`;
  }
  if (c.startsWith('usr_')) {
    return `105.${c.slice(4).toUpperCase()}`;
  }
  return undefined;
}

export function normalizeEmSecId(secid: string): string {
  const trimmed = secid.trim();
  const dot = trimmed.indexOf('.');
  if (dot <= 0) {
    return trimmed;
  }
  return `${trimmed.slice(0, dot)}.${trimmed.slice(dot + 1).toUpperCase()}`;
}

/** 解析 K 线/分时用的东财 secid：优先显式 secid，其次新浪映射，最后 A/H/美转换 */
export function resolveEastMoneySecId(code: string, secid?: string): string | undefined {
  if (secid && EM_SECID_PATTERN.test(secid.trim())) {
    return normalizeEmSecId(secid);
  }
  const c = code.toLowerCase();
  return SINA_TO_EM_SECID[c] ?? toEastMoneySecId(c);
}

export function getEmSecidForSinaCode(code: string): string | undefined {
  return SINA_TO_EM_SECID[code.toLowerCase()];
}

export function sinaCodeFromEmQuoteId(quoteId: string): string | undefined {
  return EM_QUOTE_ID_TO_SINA[normalizeEmSecId(quoteId)];
}

/** 是否可走东财 K 线 */
export function supportsEastMoneyKline(code: string, secid?: string): boolean {
  return resolveEastMoneySecId(code, secid) !== undefined;
}

/** 环球指数/期货等：有 secid 即可走东财分时（A 股/港股仍走原腾讯+东财混合逻辑） */
export function supportsEastMoneyIntradayOnly(code: string, secid?: string): boolean {
  const c = code.toLowerCase();
  if (/^(sh|sz|bj)\d+/.test(c) || /^hk\d+/.test(c)) {
    return false;
  }
  return resolveEastMoneySecId(code, secid) !== undefined;
}
