import { LimitBoardInfo } from '../models/types';

const EM_STOCK_URL = 'https://push2.eastmoney.com/api/qt/stock/get';
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

export function roundAShareLimitPrice(price: number): number {
  return Math.round(price * 100) / 100;
}

/** 根据昨收估算涨跌停价（新浪兜底无涨停价字段时使用） */
export function calcAShareLimitPrices(
  code: string,
  yestclose: number,
  name: string
): { up: number; down: number } {
  if (yestclose <= 0) {
    return { up: 0, down: 0 };
  }

  const c = code.toLowerCase();
  const num = c.slice(2);
  let pct = 0.1;

  if (c.startsWith('bj')) {
    pct = 0.3;
  } else if (c.startsWith('sz') && (num.startsWith('300') || num.startsWith('301'))) {
    pct = 0.2;
  } else if (c.startsWith('sh') && (num.startsWith('688') || num.startsWith('689'))) {
    pct = 0.2;
  }

  if (/ST/i.test(name)) {
    pct = 0.05;
  }

  return {
    up: roundAShareLimitPrice(yestclose * (1 + pct)),
    down: roundAShareLimitPrice(yestclose * (1 - pct)),
  };
}

function priceTolerance(price: number): number {
  return price >= 1000 ? 0.015 : 0.005;
}

export function isPriceAtLimit(price: number, limit: number): boolean {
  if (price <= 0 || limit <= 0) {
    return false;
  }
  return Math.abs(price - limit) <= priceTolerance(price);
}

interface OrderBookInput {
  code: string;
  name: string;
  rawPrice: number;
  limitUp: number;
  limitDown: number;
  bid1Price: number;
  bid1Lots: number;
  ask1Price: number;
  ask1Lots: number;
}

/** 根据盘口与涨跌停价判断封板状态 */
export function detectLimitBoard(input: OrderBookInput): LimitBoardInfo | undefined {
  const { rawPrice, limitUp, limitDown, bid1Price, bid1Lots, ask1Price, ask1Lots } = input;

  if (rawPrice <= 0) {
    return undefined;
  }

  const atUp = limitUp > 0 && isPriceAtLimit(rawPrice, limitUp);
  const atDown = limitDown > 0 && isPriceAtLimit(rawPrice, limitDown);

  if (atUp && bid1Lots > 0 && (bid1Price <= 0 || isPriceAtLimit(bid1Price, limitUp))) {
    const sealPrice = bid1Price > 0 ? bid1Price : limitUp;
    return {
      side: 'up',
      sealLots: bid1Lots,
      sealAmount: bid1Lots * 100 * sealPrice,
    };
  }

  if (atDown && ask1Lots > 0 && (ask1Price <= 0 || isPriceAtLimit(ask1Price, limitDown))) {
    const sealPrice = ask1Price > 0 ? ask1Price : limitDown;
    return {
      side: 'down',
      sealLots: ask1Lots,
      sealAmount: ask1Lots * 100 * sealPrice,
    };
  }

  return undefined;
}

export function formatSealLots(lots: number): string {
  if (lots <= 0) {
    return '--';
  }
  if (lots >= 10000) {
    return `${(lots / 10000).toFixed(2)}万手`;
  }
  return `${Math.round(lots)}手`;
}

function parseEmNumber(value: unknown): number | undefined {
  if (value === '-' || value === null || value === undefined) {
    return undefined;
  }
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 为涨跌停个股补充东财板上成交额（f294） */
export async function enrichLimitBoardAmounts(
  quotes: Array<{ code: string; limitBoard?: LimitBoardInfo }>,
  fetchJson: (url: string, params: Record<string, string>) => Promise<string>,
  toSecid: (code: string) => string | undefined
): Promise<void> {
  const targets = quotes.filter((q) => q.limitBoard);
  if (targets.length === 0) {
    return;
  }

  await Promise.all(
    targets.map(async (quote) => {
      const secid = toSecid(quote.code);
      if (!secid || !quote.limitBoard) {
        return;
      }

      try {
        const body = await fetchJson(EM_STOCK_URL, {
          ut: EM_UT,
          invt: '2',
          fltt: '2',
          secid,
          fields: 'f294',
        });
        const payload = JSON.parse(body) as { data?: { f294?: unknown } };
        const boardAmount = parseEmNumber(payload.data?.f294);
        if (boardAmount) {
          quote.limitBoard.boardAmount = boardAmount;
        }
      } catch {
        // 板上成交额为增强字段，失败时保留封单数据
      }
    })
  );
}
