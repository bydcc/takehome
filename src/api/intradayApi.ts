import { httpGet, httpGetJson } from './httpClient';
import { toEastMoneySecId, toTencentKlineCode } from './klineApi';

export interface IntradayPoint {
  time: string;
  price: number;
  avgPrice: number;
  volume: number;
  /** A 股 9:15–9:25 集合竞价 */
  isAuction: boolean;
}

export interface IntradayData {
  preClose: number;
  points: IntradayPoint[];
}

const EASTMONEY_TRENDS_URL = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
const TENCENT_MINUTE_URL = 'https://ifzq.gtimg.cn/appstock/app/minute/query';
const EASTMONEY_UTS = [
  'fa5fd1943c7b386f172d6893db079106',
  'fa5fd1943c7b386f172d6893dbfba10b',
  '7eea3edcaed734bea9cbfc24409ed989',
];

const EASTMONEY_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: 'application/json, text/plain, */*',
};

/** A 股 / 港股支持分时（含竞价时段，视数据源而定） */
export function supportsIntraday(code: string): boolean {
  const c = code.toLowerCase();
  return /^(sh|sz|bj)\d+/.test(c) || /^hk\d+/.test(c);
}

function isAShareAuction(time: string): boolean {
  const m = parseTimeMinutes(time);
  if (m === null) {
    return false;
  }
  // 9:15–9:25 集合竞价；9:25–9:30 显示撮合参考价
  return m >= 9 * 60 + 15 && m < 9 * 60 + 30;
}

function parseTimeMinutes(time: string): number | null {
  const normalized = time.replace(/^(\d{4})$/, (_, t: string) => `${t.slice(0, 2)}:${t.slice(2)}`);
  const match = normalized.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeTime(time: string): string {
  const trimmed = time.trim();
  if (/^\d{4}$/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}:${trimmed.slice(2)}`;
  }
  const match = trimmed.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  return trimmed;
}

export async function fetchIntraday(code: string): Promise<IntradayData | null> {
  const normalized = code.toLowerCase();
  if (!supportsIntraday(normalized)) {
    return null;
  }

  const isAshare = /^(sh|sz|bj)\d+/.test(normalized);

  try {
    const em = await fetchEastMoneyIntraday(normalized);
    if (em && em.points.length > 0) {
      return em;
    }
  } catch {
    // fallback
  }

  try {
    const tencent = await fetchTencentIntraday(normalized);
    if (!tencent || tencent.points.length === 0) {
      return null;
    }

    if (isAshare) {
      const auction = await fetchEastMoneyAuctionPoints(normalized, tencent.preClose);
      if (auction.length > 0) {
        tencent.points = mergeAuctionAndTrading(auction, tencent.points);
      }
    }

    return tencent;
  } catch {
    return null;
  }
}

async function fetchEastMoneyTrends(
  code: string,
  iscr: boolean
): Promise<{ preClose: number; trends: string[] } | null> {
  const secid = toEastMoneySecId(code);
  if (!secid) {
    return null;
  }

  for (const ut of EASTMONEY_UTS) {
    try {
      const target = new URL(EASTMONEY_TRENDS_URL);
      target.searchParams.set('secid', secid);
      target.searchParams.set('ut', ut);
      target.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13');
      target.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58');
      target.searchParams.set('iscr', iscr ? '1' : '0');
      if (iscr) {
        target.searchParams.set('iscca', '0');
      }
      target.searchParams.set('ndays', '1');

      const body = await httpGetJson<{
        rc?: number;
        data?: {
          preClose?: number;
          prePrice?: number;
          trends?: string[];
        };
      }>(target.toString(), { headers: EASTMONEY_HEADERS, timeoutMs: 12000 });

      if (body.rc !== undefined && body.rc !== 0) {
        continue;
      }
      const trends = body.data?.trends ?? [];
      if (trends.length === 0) {
        continue;
      }
      return {
        preClose: body.data?.preClose ?? body.data?.prePrice ?? 0,
        trends,
      };
    } catch {
      // try next token
    }
  }

  return null;
}

async function fetchEastMoneyIntraday(code: string): Promise<IntradayData | null> {
  const isAshare = /^(sh|sz|bj)\d+/.test(code);
  const withPreMarket = isAshare;
  const em = await fetchEastMoneyTrends(code, withPreMarket);
  if (!em) {
    return null;
  }

  const { preClose, trends } = em;
  const points: IntradayPoint[] = [];
  let cumVolume = 0;
  let cumAmount = 0;

  for (const row of trends) {
    const parsed = parseEastMoneyTrendRow(row, isAshare, preClose);
    if (!parsed) {
      continue;
    }
    cumVolume += parsed.volume;
    cumAmount += parsed.amount;

    let avgPrice = parsed.emAvg;
    if (!isPlausiblePriceRef(avgPrice, parsed.price, preClose)) {
      avgPrice = computeVwap(cumAmount, cumVolume, parsed.price, preClose);
    }

    points.push({
      time: parsed.time,
      price: parsed.price,
      avgPrice,
      volume: parsed.volume,
      isAuction: parsed.isAuction,
    });
  }

  if (points.length === 0) {
    return null;
  }

  return { preClose: preClose > 0 ? preClose : points[0].price, points };
}

/** 仅拉取 9:15–9:29 集合竞价，用于补齐腾讯分时 */
async function fetchEastMoneyAuctionPoints(
  code: string,
  preClose: number
): Promise<IntradayPoint[]> {
  const em = await fetchEastMoneyTrends(code, true);
  if (!em) {
    return [];
  }

  const refPreClose = em.preClose > 0 ? em.preClose : preClose;
  const points: IntradayPoint[] = [];

  for (const row of em.trends) {
    const parsed = parseEastMoneyTrendRow(row, true, refPreClose);
    if (!parsed || !parsed.isAuction) {
      continue;
    }
    const avgPrice = isPlausiblePriceRef(parsed.emAvg, parsed.price, refPreClose)
      ? parsed.emAvg
      : parsed.price;
    points.push({
      time: parsed.time,
      price: parsed.price,
      avgPrice,
      volume: parsed.volume,
      isAuction: true,
    });
  }

  return points;
}

function mergeAuctionAndTrading(
  auction: IntradayPoint[],
  trading: IntradayPoint[]
): IntradayPoint[] {
  const openMinutes = 9 * 60 + 30;
  const auctionOnly = auction.filter((p) => {
    const m = parseTimeMinutes(p.time);
    return m !== null && m < openMinutes;
  });
  if (auctionOnly.length === 0) {
    return trading;
  }
  return [...auctionOnly, ...trading];
}

interface ParsedTrendRow {
  time: string;
  price: number;
  volume: number;
  amount: number;
  emAvg: number;
  isAuction: boolean;
}

/** 均价/现价应与昨收或当前价同量级 */
function isPlausiblePriceRef(value: number, price: number, preClose: number): boolean {
  if (!Number.isFinite(value) || value <= 0) {
    return false;
  }
  const ref = price > 0 ? price : preClose;
  if (ref <= 0) {
    return value < 100000;
  }
  return value >= ref * 0.5 && value <= ref * 1.5;
}

/** 累计成交额 / 累计成交量 → 均价（自动识别「手」或「股」） */
function computeVwap(
  cumAmount: number,
  cumVolume: number,
  price: number,
  preClose: number
): number {
  if (cumAmount <= 0 || cumVolume <= 0) {
    return price;
  }
  const byShares = cumAmount / cumVolume;
  if (isPlausiblePriceRef(byShares, price, preClose)) {
    return byShares;
  }
  const byLots = cumAmount / (cumVolume * 100);
  if (isPlausiblePriceRef(byLots, price, preClose)) {
    return byLots;
  }
  return price;
}

function parseTrendTime(parts: string[]): string {
  let timeRaw = parts[0];
  if (timeRaw.includes(' ')) {
    timeRaw = timeRaw.split(' ').pop() ?? timeRaw;
  }
  return normalizeTime(timeRaw);
}

/** 东方财富分时：时间, 开, 收, 高, 低, 成交量, 成交额, 最新价(均价线) */
function parseEastMoneyTrendRow(
  row: string,
  isAshare: boolean,
  preClose: number
): ParsedTrendRow | null {
  const parts = row.split(',');
  if (parts.length < 3) {
    return null;
  }

  const time = parseTrendTime(parts);
  const open = parseFloat(parts[1]);
  const close = parseFloat(parts[2]);
  const latest = parts.length >= 8 ? parseFloat(parts[7]) : NaN;
  const volume = parts.length >= 6 ? parseFloat(parts[5]) || 0 : 0;
  const amount = parts.length >= 7 ? parseFloat(parts[6]) || 0 : 0;
  const isAuction = isAshare && isAShareAuction(time);

  let price: number;
  if (Number.isFinite(close) && close > 0) {
    price = close;
  } else if (Number.isFinite(open) && open > 0) {
    price = open;
  } else if (Number.isFinite(latest) && latest > 0) {
    price = latest;
  } else {
    return null;
  }

  return {
    time,
    price,
    volume,
    amount,
    emAvg: Number.isFinite(latest) && latest > 0 ? latest : NaN,
    isAuction,
  };
}

async function fetchTencentIntraday(code: string): Promise<IntradayData | null> {
  const tencentCode = toTencentKlineCode(code);
  if (!tencentCode) {
    return null;
  }

  const target = new URL(TENCENT_MINUTE_URL);
  target.searchParams.set('code', tencentCode);

  const payload = await httpGetJson<{
    code?: number;
    data?: Record<
      string,
      {
        data?: { data?: string[]; date?: string };
        qt?: Record<string, string[]>;
      }
    >;
  }>(target.toString(), {
    headers: {
      Referer: 'https://finance.qq.com/',
    },
  });

  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(`Tencent minute code=${payload.code}`);
  }

  const block = payload.data?.[tencentCode] ?? payload.data?.[code];
  const rows = block?.data?.data ?? [];
  const qtRow = block?.qt?.[tencentCode] ?? block?.qt?.[code];
  const preClose = qtRow ? parseFloat(qtRow[4]) || parseFloat(qtRow[3]) || 0 : 0;

  const isAshare = /^(sh|sz|bj)\d+/.test(code);
  const points: IntradayPoint[] = [];
  let prevCumVolume = 0;
  let prevCumAmount = 0;

  for (const row of rows) {
    const point = parseTencentMinuteRow(row, isAshare, preClose, prevCumVolume, prevCumAmount);
    if (!point) {
      continue;
    }
    prevCumVolume = point.cumVolume;
    prevCumAmount = point.cumAmount;
    points.push({
      time: point.time,
      price: point.price,
      avgPrice: point.avgPrice,
      volume: point.volume,
      isAuction: point.isAuction,
    });
  }

  if (points.length === 0) {
    return null;
  }

  return { preClose: preClose > 0 ? preClose : points[0].price, points };
}

/** 腾讯分时："HHMM 价格 累计成交量(手) 累计成交额(元)" */
function parseTencentMinuteRow(
  row: string,
  isAshare: boolean,
  preClose: number,
  prevCumVolume: number,
  prevCumAmount: number
): (IntradayPoint & { cumVolume: number; cumAmount: number }) | null {
  const parts = row.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const time = normalizeTime(parts[0]);
  const price = parseFloat(parts[1]);
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  // 四段式：累计量额 → 自行计算均价
  if (parts.length >= 4) {
    const cumVolume = parseFloat(parts[2]) || 0;
    const cumAmount = parseFloat(parts[3]) || 0;
    const avgPrice =
      cumVolume > 0 ? cumAmount / (cumVolume * 100) : price;
    const incrementalVolume = Math.max(0, cumVolume - prevCumVolume);

    return {
      time,
      price,
      avgPrice: isPlausiblePriceRef(avgPrice, price, preClose) ? avgPrice : price,
      volume: incrementalVolume,
      isAuction: isAshare && isAShareAuction(time),
      cumVolume,
      cumAmount,
    };
  }

  // 三段式兼容："HHMM 价格 均价"
  const avgPrice = parseFloat(parts[2]) || price;
  return {
    time,
    price,
    avgPrice: isPlausiblePriceRef(avgPrice, price, preClose) ? avgPrice : price,
    volume: 0,
    isAuction: isAshare && isAShareAuction(time),
    cumVolume: prevCumVolume,
    cumAmount: prevCumAmount,
  };
}

// East Money + Tencent minute fallback for intraday