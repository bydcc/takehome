import { httpGet, httpGetJson } from './httpClient';
import {
  resolveEastMoneySecId,
  supportsEastMoneyKline,
  toEastMoneySecId,
} from './eastMoneySecId';

export interface KlineBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  change?: number;
  percent?: number;
}

export type KlinePeriod = 'daily' | 'weekly';

const EASTMONEY_KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TENCENT_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

const KLT: Record<KlinePeriod, number> = {
  daily: 101,
  weekly: 102,
};

const TENCENT_PERIOD: Record<KlinePeriod, string> = {
  daily: 'day',
  weekly: 'week',
};

/** 当日 K 线内存缓存，MA 与详情页共用，避免重复请求 */
const klineSessionCache = new Map<string, { date: string; period: KlinePeriod; bars: KlineBar[] }>();

/** 是否支持 K 线（A 股 / 港股 / 美股 / 带 secid 或新浪映射的环球品种） */
export function supportsKline(code: string, secid?: string): boolean {
  return supportsEastMoneyKline(code, secid);
}

/** 转为东方财富 secid */
export function toEastMoneySecIdFromCode(code: string): string | undefined {
  return toEastMoneySecId(code);
}

export { resolveEastMoneySecId, toEastMoneySecId };

export function toTencentKlineCode(code: string): string | undefined {
  const c = code.toLowerCase();
  if (/^(sh|sz|bj|hk)\d+/.test(c)) {
    return c;
  }
  if (c.startsWith('usr_')) {
    return `us${c.slice(4).toUpperCase()}.OQ`;
  }
  return undefined;
}

function getBeijingDateString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function cacheKey(code: string, period: KlinePeriod, secid?: string): string {
  const id = resolveEastMoneySecId(code, secid) ?? code.toLowerCase();
  return `${id}:${period}`;
}

function readSessionCache(
  code: string,
  period: KlinePeriod,
  limit: number,
  secid?: string
): KlineBar[] | undefined {
  const hit = klineSessionCache.get(cacheKey(code, period, secid));
  if (!hit || hit.date !== getBeijingDateString()) {
    return undefined;
  }
  if (hit.bars.length < limit) {
    return undefined;
  }
  return hit.bars.slice(-limit);
}

function writeSessionCache(
  code: string,
  period: KlinePeriod,
  bars: KlineBar[],
  secid?: string
): void {
  klineSessionCache.set(cacheKey(code, period, secid), {
    date: getBeijingDateString(),
    period,
    bars,
  });
}

const EASTMONEY_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: 'application/json, text/plain, */*',
};

export async function fetchKline(
  code: string,
  period: KlinePeriod,
  limit = 120,
  secid?: string
): Promise<KlineBar[]> {
  const normalized = code.toLowerCase();
  if (!supportsKline(normalized, secid)) {
    return [];
  }

  const cached = readSessionCache(normalized, period, limit, secid);
  if (cached && cached.length > 0) {
    return cached;
  }

  let bars: KlineBar[] = [];
  let lastError: unknown;
  const sourceLimit = limit + 1;

  // A 股优先腾讯 K 线（扩展宿主内更稳定），其余品种走东方财富
  if (/^(sh|sz|bj)\d+/.test(normalized)) {
    try {
      bars = await fetchTencentKline(normalized, period, sourceLimit);
    } catch (err) {
      lastError = err;
    }
    if (bars.length === 0) {
      try {
        bars = await fetchEastMoneyKline(normalized, period, sourceLimit, secid);
      } catch (err) {
        lastError = err;
      }
    }
  } else {
    try {
      bars = await fetchEastMoneyKline(normalized, period, sourceLimit, secid);
    } catch (err) {
      lastError = err;
    }
    if (bars.length === 0) {
      try {
        bars = await fetchTencentKline(normalized, period, sourceLimit);
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (bars.length === 0 && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (bars.length > 0) {
    bars = withKlineChange(bars).slice(-limit);
    writeSessionCache(normalized, period, bars, secid);
  }

  return bars;
}

function withKlineChange(bars: KlineBar[]): KlineBar[] {
  return bars.map((bar, index) => {
    const prevClose = index > 0 ? bars[index - 1].close : 0;
    if (!Number.isFinite(prevClose) || prevClose <= 0) {
      return bar;
    }
    const change = bar.close - prevClose;
    return {
      ...bar,
      change,
      percent: (change / prevClose) * 100,
    };
  });
}

async function fetchEastMoneyKline(
  code: string,
  period: KlinePeriod,
  limit: number,
  secid?: string
): Promise<KlineBar[]> {
  const resolvedSecid = resolveEastMoneySecId(code, secid);
  if (!resolvedSecid) {
    return [];
  }

  const target = new URL(EASTMONEY_KLINE_URL);
  target.searchParams.set('secid', resolvedSecid);
  target.searchParams.set('ut', 'fa5fd1943c7b386f172d6893db079106');
  target.searchParams.set('klt', String(KLT[period]));
  target.searchParams.set('fqt', '1');
  target.searchParams.set('lmt', String(limit));
  target.searchParams.set('end', '20500101');
  target.searchParams.set('fields1', 'f1');
  target.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57');

  const body = await httpGetJson<{
    rc?: number;
    data?: { klines?: string[] };
  }>(target.toString(), { headers: EASTMONEY_HEADERS });

  if (body.rc !== undefined && body.rc !== 0) {
    throw new Error(`EastMoney rc=${body.rc}`);
  }

  return (body.data?.klines ?? [])
    .map(parseEastMoneyRow)
    .filter((bar): bar is KlineBar => bar !== null);
}

async function fetchTencentKline(
  code: string,
  period: KlinePeriod,
  limit: number
): Promise<KlineBar[]> {
  const tencentCode = toTencentKlineCode(code);
  if (!tencentCode) {
    return [];
  }

  const target = new URL(TENCENT_KLINE_URL);
  target.searchParams.set(
    'param',
    `${tencentCode},${TENCENT_PERIOD[period]},,,${Math.min(limit, 640)},qfq`
  );

  const text = await httpGet(target.toString(), {
    headers: {
      Referer: 'https://finance.qq.com/',
    },
  });
  const jsonText = text.includes('=') ? text.slice(text.indexOf('=') + 1) : text;
  const payload = JSON.parse(jsonText) as {
    code?: number;
    data?: Record<string, Record<string, string[][]>>;
  };

  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(`Tencent code=${payload.code}`);
  }

  const stockData = payload.data?.[tencentCode] ?? payload.data?.[code];
  if (!stockData) {
    return [];
  }

  const periodKey = TENCENT_PERIOD[period];
  const rows =
    stockData[periodKey] ??
    stockData[`qfq${periodKey}`] ??
    stockData[`${periodKey}qfq`] ??
    [];

  return rows
    .map(parseTencentRow)
    .filter((bar): bar is KlineBar => bar !== null)
    .slice(-limit);
}

function parseEastMoneyRow(row: string): KlineBar | null {
  const parts = row.split(',');
  if (parts.length < 7) {
    return null;
  }

  const open = parseFloat(parts[1]);
  const close = parseFloat(parts[2]);
  const high = parseFloat(parts[3]);
  const low = parseFloat(parts[4]);
  if (![open, close, high, low].every((n) => Number.isFinite(n) && n > 0)) {
    return null;
  }

  return {
    date: parts[0],
    open,
    close,
    high,
    low,
    volume: parseFloat(parts[5]) || 0,
    amount: parseFloat(parts[6]) || 0,
  };
}

/** 腾讯日 K 行：日期, 开, 收, 高, 低, 量 */
function parseTencentRow(row: string[]): KlineBar | null {
  if (row.length < 6) {
    return null;
  }

  const open = parseFloat(row[1]);
  const close = parseFloat(row[2]);
  const high = parseFloat(row[3]);
  const low = parseFloat(row[4]);
  if (![open, close, high, low].every((n) => Number.isFinite(n) && n > 0)) {
    return null;
  }

  return {
    date: row[0],
    open,
    close,
    high,
    low,
    volume: parseFloat(row[5]) || 0,
    amount: 0,
  };
}

export interface MaValues {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
}

function computeMAAt(bars: KlineBar[], period: number): number | null {
  if (bars.length < period) {
    return null;
  }
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    sum += bars[i].close;
  }
  return sum / period;
}

/** 拉取最近 25 根日 K，本地计算 MA5/10/20 */
export async function fetchLatestMA(code: string, secid?: string): Promise<MaValues | null> {
  if (!supportsKline(code, secid)) {
    return null;
  }
  const bars = await fetchKline(code, 'daily', 25, secid);
  if (bars.length < 5) {
    return null;
  }
  return {
    ma5: computeMAAt(bars, 5),
    ma10: computeMAAt(bars, 10),
    ma20: computeMAAt(bars, 20),
  };
}

export function klinePeriodLabel(period: KlinePeriod): string {
  return period === 'daily' ? '日 K' : '周 K';
}
