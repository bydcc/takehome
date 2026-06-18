import { MarketOverview, SearchResult, StockQuote } from '../models/types';
import { httpGet } from './httpClient';
import { searchEastMoneyInstruments } from './eastMoneySearchApi';
import {
  isSinaGlobalCode,
  mapSearchToSinaCode,
  normalizeInstrumentCode,
  resolveSinaCode,
  searchLocalInstruments,
  toSinaQuoteCode,
} from './instruments';

const SEARCH_URL = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get';
const SINA_URL = 'https://hq.sinajs.cn/list=';
const TENCENT_URL = 'https://qt.gtimg.cn/q=';

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

/** 根据股票代码返回市场/板块标识 */
export function getMarketLabel(code: string): string {
  const c = normalizeCode(code);

  if (c.startsWith('hk')) {
    return '港';
  }
  if (c.startsWith('usr_')) {
    return '美';
  }
  if (c.startsWith('bj')) {
    return '北';
  }
  if (c.startsWith('sh')) {
    const num = c.slice(2);
    if (num.startsWith('688') || num.startsWith('689')) {
      return '科创';
    }
    return '沪';
  }
  if (c.startsWith('sz')) {
    const num = c.slice(2);
    if (num.startsWith('300') || num.startsWith('301')) {
      return '创业';
    }
    return '深';
  }
  if (c.startsWith('b_') || c.startsWith('int_')) {
    return '指';
  }
  if (c.startsWith('hf_')) {
    if (/oil|_cl/.test(c)) {
      return '油';
    }
    if (/xau|_gc/.test(c)) {
      return '金';
    }
    if (/xag|_si/.test(c)) {
      return '银';
    }
    return '期';
  }
  if (c.startsWith('nf_')) {
    if (/au/.test(c)) {
      return '金';
    }
    if (/ag/.test(c)) {
      return '银';
    }
    return '期';
  }

  return '';
}

/** 股票名称后附加市场标识，如「贵州茅台 [沪]」 */
export function formatStockLabel(name: string, code: string): string {
  const label = getMarketLabel(code);
  return label ? `${name} [${label}]` : name;
}

/** 将搜索 API 返回的市场 + 代码转为行情 API 可用格式 */
export function formatStockCode(market: string, rawCode: string): string {
  const m = market.toLowerCase();
  const code = rawCode.toLowerCase();

  if (/^(sh|sz|bj|hk)/.test(code)) {
    return code;
  }
  if (code.startsWith('usr_')) {
    return code;
  }

  switch (m) {
    case 'sh':
    case 'sz':
    case 'bj':
    case 'hk':
      return `${m}${code}`;
    case 'us':
      return `usr_${code.split('.')[0]}`;
    case 'fu':
    case 'ft': {
      const mapped = mapSearchToSinaCode(m, rawCode);
      if (mapped) {
        return mapped;
      }
      break;
    }
    default:
      break;
  }

  if (isSinaGlobalCode(code)) {
    return code;
  }

  return `${m}${code}`;
}

function isHKCode(code: string): boolean {
  return code.startsWith('hk');
}

function isUSCode(code: string): boolean {
  return code.startsWith('usr_');
}

function isAShareCode(code: string): boolean {
  return /^(sh|sz|bj)/.test(normalizeCode(code));
}

/** 非交易时段现价可能为 0，用买一价或昨收兜底，避免列表空白 */
function resolveASharePrice(price: number, bid1: number, yestclose: number): number {
  if (price > 0) {
    return price;
  }
  if (bid1 > 0) {
    return bid1;
  }
  return yestclose;
}

export async function searchStocks(keyword: string): Promise<SearchResult[]> {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return [];
  }

  const localResults = searchLocalInstruments(trimmed);

  const [remoteResults, emResults] = await Promise.all([
    fetchTencentSearch(trimmed).catch(() => [] as SearchResult[]),
    searchEastMoneyInstruments(trimmed).catch(() => [] as SearchResult[]),
  ]);

  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  const push = (item: SearchResult) => {
    const code = resolveSinaCode(item.code);
    if (seen.has(code)) {
      const existing = merged.find((r) => r.code === code);
      if (existing && !existing.secid && item.secid) {
        existing.secid = item.secid;
      }
      return;
    }
    seen.add(code);
    merged.push({ ...item, code });
  };

  for (const item of [...localResults, ...emResults, ...remoteResults]) {
    push(item);
  }

  return merged;
}

async function fetchTencentSearch(keyword: string): Promise<SearchResult[]> {
  const body = await httpGet(SEARCH_URL, { params: { q: keyword } });
  const data = JSON.parse(body) as { data?: { stock?: string[][] } };
  const stockList = data.data?.stock ?? [];

  return stockList.map((item) => ({
    market: item[0],
    code: resolveSinaCode(formatStockCode(item[0], item[1])),
    name: item[2],
  }));
}

export async function fetchQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  const hkCodes = codes.filter(isHKCode);
  const aShareCodes = codes.filter((c) => !isHKCode(c) && isAShareCode(c));
  const sinaCodes = codes.filter((c) => !isHKCode(c) && !isAShareCode(c));

  const [hkQuotes, aShareQuotes, sinaQuotes] = await Promise.all([
    fetchHKQuotes(hkCodes),
    fetchAShareQuotes(aShareCodes),
    fetchSinaQuotesSafe(sinaCodes),
  ]);

  const quoteMap = new Map<string, StockQuote>();
  for (const q of [...hkQuotes, ...aShareQuotes, ...sinaQuotes]) {
    quoteMap.set(normalizeInstrumentCode(q.code), q);
  }

  return codes.map((code) => quoteMap.get(normalizeInstrumentCode(code))).filter((q): q is StockQuote => !!q);
}

/** 新浪环球指数 / 期货 / 贵金属等非 A 股、非港股代码 */
export function isGlobalInstrumentCode(code: string): boolean {
  const c = normalizeCode(code);
  return !isHKCode(c) && !isAShareCode(c);
}

/** 仅拉取环球品种（日经、KOSPI、原油、贵金属等），请求体小、响应快 */
export async function fetchGlobalInstrumentQuotes(codes: string[]): Promise<StockQuote[]> {
  const globalCodes = codes.filter(isGlobalInstrumentCode);
  return fetchSinaQuotesSafe(globalCodes);
}

/** A 股优先走腾讯（无需 Referer），新浪作兜底 */
async function fetchAShareQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  let quotes: StockQuote[] = [];
  try {
    quotes = await fetchTencentAShareQuotes(codes);
  } catch {
    quotes = [];
  }

  const got = new Set(quotes.map((q) => normalizeInstrumentCode(q.code)));
  const missing = codes.filter((c) => !got.has(normalizeInstrumentCode(c)));
  if (missing.length > 0) {
    try {
      quotes.push(...(await fetchSinaQuotes(missing)));
    } catch {
      // 腾讯、新浪均失败时保留已拿到的部分
    }
  }

  return quotes;
}

async function fetchSinaQuotesSafe(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }
  try {
    return await fetchSinaQuotes(codes);
  } catch {
    return [];
  }
}

async function fetchSinaQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  const url = SINA_URL + codes.map((c) => toSinaQuoteCode(c).replace('.', '$')).join(',');
  const body = await httpGet(url, {
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0',
    },
    encoding: 'gb18030',
    noCache: true,
    noCacheQueryParam: false,
  });

  const lines = body.split(/";\r?\n|";\s*$/);
  const quotes: StockQuote[] = [];

  for (const line of lines) {
    if (!line.includes('="')) {
      continue;
    }
    let code = line.split('="')[0].replace('var hq_str_', '');
    if (code.includes('$')) {
      code = code.replace('$', '.');
    }
    code = normalizeInstrumentCode(code);

    const eqMark = '="';
    const params = line.split(eqMark)[1]?.split(',') ?? [];
    if (params.length < 2) {
      continue;
    }

    const quote = parseSinaQuote(code, params);
    if (quote) {
      quotes.push({ ...quote, code: normalizeInstrumentCode(quote.code) });
    }
  }

  return quotes;
}

function parseSinaQuote(code: string, params: string[]): StockQuote | null {
  if (/^(sh|sz|bj)/.test(code)) {
    const name = params[0];
    if (!name) {
      return null;
    }
    const open = parseFloat(params[1]) || 0;
    const yestclose = parseFloat(params[2]) || 0;
    let price = parseFloat(params[3]) || 0;
    const high = parseFloat(params[4]) || 0;
    const low = parseFloat(params[5]) || 0;

    if (price === 0) {
      const buy1 = parseFloat(params[6]) || 0;
      price = buy1 || yestclose;
    }

    const change = price - yestclose;
    const percent = yestclose ? (change / yestclose) * 100 : 0;
    const amount = parseFloat(params[9]) || 0;

    return { code, name, price, yestclose, open, high, low, change, percent, amount };
  }

  if (isUSCode(code)) {
    const name = params[0];
    if (!name) {
      return null;
    }
    const price = parseFloat(params[1]) || 0;
    const open = parseFloat(params[5]) || 0;
    const high = parseFloat(params[6]) || 0;
    const low = parseFloat(params[7]) || 0;
    const yestclose = parseFloat(params[26]) || price;
    const change = price - yestclose;
    const percent = yestclose ? (change / yestclose) * 100 : 0;

    return { code, name, price, yestclose, open, high, low, change, percent, amount: 0 };
  }

  if (code.startsWith('b_') || code.startsWith('int_')) {
    return parseSinaGlobalIndex(code, params);
  }

  if (code.startsWith('hf_')) {
    return parseSinaIntlFutures(code, params);
  }

  if (code.startsWith('nf_')) {
    return parseSinaDomesticFutures(code, params);
  }

  return null;
}

function parseSinaGlobalIndex(code: string, params: string[]): StockQuote | null {
  const name = params[0];
  const price = parseFloat(params[1]) || 0;
  const change = parseFloat(params[2]) || 0;
  const percent = parseFloat(params[3]) || 0;
  if (!name || price <= 0) {
    return null;
  }

  const yestclose = parseFloat(params[9]) || (change ? price - change : price);
  const high = parseFloat(params[10]) || 0;
  const low = parseFloat(params[11]) || 0;

  return { code, name, price, yestclose, open: 0, high, low, change, percent, amount: 0 };
}

function parseSinaIntlFutures(code: string, params: string[]): StockQuote | null {
  const price = parseFloat(params[0]) || parseFloat(params[2]) || 0;
  const open = parseFloat(params[3]) || parseFloat(params[8]) || 0;
  const high = parseFloat(params[4]) || 0;
  const low = parseFloat(params[5]) || 0;
  const yestclose = parseFloat(params[7]) || 0;
  const name = params[13] || code;
  if (price <= 0) {
    return null;
  }

  const change = yestclose ? price - yestclose : 0;
  const percent = yestclose ? (change / yestclose) * 100 : 0;

  return { code, name, price, yestclose, open, high, low, change, percent, amount: 0 };
}

function parseSinaDomesticFutures(code: string, params: string[]): StockQuote | null {
  const name = params[0];
  const price = parseFloat(params[2]) || parseFloat(params[8]) || 0;
  const high = parseFloat(params[3]) || 0;
  const low = parseFloat(params[4]) || 0;
  const yestclose = parseFloat(params[10]) || 0;
  const open = parseFloat(params[6]) || 0;
  const amount = parseFloat(params[13]) || 0;
  if (!name || price <= 0) {
    return null;
  }

  const change = yestclose ? price - yestclose : 0;
  const percent = yestclose ? (change / yestclose) * 100 : 0;

  return { code, name, price, yestclose, open, high, low, change, percent, amount };
}

async function fetchTencentAShareQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  const body = await httpGet(TENCENT_URL, {
    params: { q: codes.map((c) => normalizeCode(c)).join(',') },
    encoding: 'gbk',
    noCache: true,
  });

  const quotes: StockQuote[] = [];
  for (const line of body.split(/;\r?\n|;\s*$/)) {
    if (!line.includes('="') || line.includes('pv_none_match')) {
      continue;
    }

    const code = normalizeInstrumentCode(line.split('="')[0].replace(/^v_/, ''));
    const fields = line.split('="')[1]?.replace(/";?$/, '').split('~') ?? [];
    if (fields.length < 35) {
      continue;
    }

    const name = fields[1] || code;
    const rawPrice = parseFloat(fields[3]) || 0;
    const yestclose = parseFloat(fields[4]) || 0;
    const open = parseFloat(fields[5]) || 0;
    const high = parseFloat(fields[33]) || 0;
    const low = parseFloat(fields[34]) || 0;
    const bid1 = parseFloat(fields[9]) || 0;
    const price = resolveASharePrice(rawPrice, bid1, yestclose);
    if (price <= 0) {
      continue;
    }

    const change =
      rawPrice > 0
        ? parseFloat(fields[31]) || price - yestclose
        : 0;
    const percent =
      rawPrice > 0
        ? parseFloat(fields[32]) || (yestclose ? ((price - yestclose) / yestclose) * 100 : 0)
        : 0;
    const amount = (parseFloat(fields[37]) || 0) * 10000;

    quotes.push({ code, name, price, yestclose, open, high, low, change, percent, amount });
  }

  return quotes;
}

async function fetchHKQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  const body = await httpGet(TENCENT_URL, {
    params: {
      q: codes.map((c) => `r_${c}`).join(','),
      fmt: 'json',
    },
    encoding: 'gbk',
    noCache: true,
  });
  const payload = JSON.parse(body) as Record<string, string[]>;

  return codes.map((code) => {
    const normalized = normalizeCode(code);
    const data = payload[`r_${normalized}`];
    if (!data) {
      return {
        code: normalized,
        name: '无数据',
        price: 0,
        yestclose: 0,
        open: 0,
        high: 0,
        low: 0,
        change: 0,
        percent: 0,
        amount: 0,
      };
    }

    const rawPrice = parseFloat(data[3]) || 0;
    const yestclose = parseFloat(data[4]) || 0;
    const open = parseFloat(data[5]) || 0;
    const high = parseFloat(data[33]) || 0;
    const low = parseFloat(data[34]) || 0;
    const bid1 = parseFloat(data[9]) || 0;
    const price = resolveASharePrice(rawPrice, bid1, yestclose);
    const change = rawPrice > 0 ? price - yestclose : 0;
    const percent = rawPrice > 0 && yestclose ? (change / yestclose) * 100 : 0;
    const amount = parseFloat(data[37]) || 0;

    return {
      code: normalized,
      name: data[1],
      price,
      yestclose,
      open,
      high,
      low,
      change,
      percent,
      amount,
    };
  });
}

export function formatPrice(price: number, code: string): string {
  const c = code.toLowerCase();
  if (isUSCode(c)) {
    return price.toFixed(3);
  }
  if (c.startsWith('hf_si') || c.startsWith('hf_xag')) {
    return price.toFixed(3);
  }
  if (c.startsWith('nf_ag')) {
    return price.toFixed(0);
  }
  return price.toFixed(2);
}

export function formatPercent(percent: number): string {
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(2)}%`;
}

export function calcPercent(price: number, yestclose: number): number {
  if (!yestclose) {
    return 0;
  }
  return ((price - yestclose) / yestclose) * 100;
}

/** 价格 + 相对昨收的涨跌幅，如 1282.88 (+0.55%) */
export function formatPriceWithPercent(price: number, yestclose: number, code: string): string {
  if (price <= 0) {
    return '--';
  }
  const priceStr = formatPrice(price, code);
  if (yestclose <= 0) {
    return priceStr;
  }
  return `${priceStr} (${formatPercent(calcPercent(price, yestclose))})`;
}

/** 格式化成交额（元），输出如 168.55亿、3520.12万 */
export function formatAmount(amount: number): string {
  if (amount <= 0) {
    return '--';
  }
  if (amount >= 100000000) {
    return `${(amount / 100000000).toFixed(2)}亿`;
  }
  if (amount >= 10000) {
    return `${(amount / 10000).toFixed(2)}万`;
  }
  return amount.toFixed(0);
}

/** 格式化两市总成交额（元），输出如 2.40万亿、8650.32亿 */
export function formatMarketAmount(amount: number): string {
  if (amount <= 0) {
    return '--';
  }
  if (amount >= 1_0000_0000_0000) {
    return `${(amount / 1_0000_0000_0000).toFixed(2)}万亿`;
  }
  return formatAmount(amount);
}

const MARKET_FENBU_URL = 'https://push2ex.eastmoney.com/getTopicZDFenBu';
const MARKET_INDEX_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';

export async function fetchMarketOverview(): Promise<MarketOverview> {
  const [fenbuBody, indexBody] = await Promise.all([
    httpGet(MARKET_FENBU_URL, {
      params: {
        ut: '7eea3edcaed734bea9cbfc24409ed989',
        dpt: 'wz.ztzt',
      },
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }),
    httpGet(MARKET_INDEX_URL, {
      params: {
        fltt: '2',
        secids: '1.000001,0.399001',
        fields: 'f2,f3,f6,f12,f14',
      },
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }),
  ]);

  const fenbuData = JSON.parse(fenbuBody) as {
    data?: { fenbu?: Array<Record<string, number>> };
  };
  let riseCount = 0;
  let fallCount = 0;
  let flatCount = 0;

  for (const bucket of fenbuData.data?.fenbu ?? []) {
    for (const [key, count] of Object.entries(bucket)) {
      const change = Number(key);
      if (change > 0) {
        riseCount += count;
      } else if (change < 0) {
        fallCount += count;
      } else {
        flatCount = count;
      }
    }
  }

  const indexData = JSON.parse(indexBody) as {
    data?: {
      diff?: Array<{ f2: number; f3: number; f6: number; f12: string; f14: string }>;
    };
  };
  const indexMap = new Map(
    (indexData.data?.diff ?? []).map((item) => [item.f12, item])
  );
  const shRaw = indexMap.get('000001');
  const szRaw = indexMap.get('399001');

  const shIndex = {
    name: shRaw?.f14 ?? '上证指数',
    price: shRaw?.f2 ?? 0,
    percent: shRaw?.f3 ?? 0,
    amount: shRaw?.f6 ?? 0,
  };
  const szIndex = {
    name: szRaw?.f14 ?? '深证成指',
    price: szRaw?.f2 ?? 0,
    percent: szRaw?.f3 ?? 0,
    amount: szRaw?.f6 ?? 0,
  };

  return {
    riseCount,
    fallCount,
    flatCount,
    totalAmount: shIndex.amount + szIndex.amount,
    shIndex,
    szIndex,
  };
}
