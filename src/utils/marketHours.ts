import { workspace } from 'vscode';

/** 北京时间当前日期，格式 YYYY-MM-DD */
export function getBeijingDateString(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

interface TradingSession {
  timeZone: string;
  /** 当地时区 Mon–Fri 的交易时段（分钟，含起止） */
  ranges: ReadonlyArray<[number, number]>;
}

const MARKET_SESSIONS: Record<string, TradingSession> = {
  cn: {
    timeZone: 'Asia/Shanghai',
    ranges: [
      [9 * 60 + 15, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ],
  },
  hk: {
    timeZone: 'Asia/Hong_Kong',
    ranges: [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60],
    ],
  },
  jp: {
    timeZone: 'Asia/Tokyo',
    ranges: [
      [9 * 60, 11 * 60 + 30],
      [12 * 60 + 30, 15 * 60],
    ],
  },
  kr: {
    timeZone: 'Asia/Seoul',
    ranges: [[9 * 60, 15 * 60 + 30]],
  },
  us: {
    timeZone: 'America/New_York',
    ranges: [[9 * 60 + 30, 16 * 60]],
  },
  uk: {
    timeZone: 'Europe/London',
    ranges: [[8 * 60, 16 * 60 + 30]],
  },
};

function getLocalWeekdayAndMinutes(timeZone: string, now: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { weekday, minutes: hour * 60 + minute };
}

function isSessionOpen(session: TradingSession, now: Date): boolean {
  const { weekday, minutes } = getLocalWeekdayAndMinutes(session.timeZone, now);
  if (['Sat', 'Sun'].includes(weekday)) {
    return false;
  }
  return session.ranges.some(([start, end]) => minutes >= start && minutes <= end);
}

/** 北京时间当前时刻是否在 A 股常规交易时段（含集合竞价） */
export function isAShareTradingHours(now = new Date()): boolean {
  return isSessionOpen(MARKET_SESSIONS.cn, now);
}

/** 根据代码推断所属市场；期货/贵金属按近 24h 品种处理 */
export function resolveMarketKey(code: string): string | 'always' | null {
  const c = code.toLowerCase();
  if (/^(sh|sz|bj)/.test(c)) {
    return 'cn';
  }
  if (c.startsWith('hk') || c === 'b_hsi') {
    return 'hk';
  }
  if (c === 'b_nky') {
    return 'jp';
  }
  if (c === 'b_kospi') {
    return 'kr';
  }
  if (c.startsWith('usr_') || c === 'b_spx' || c === 'int_dji' || c === 'int_nasdaq') {
    return 'us';
  }
  if (c === 'int_ftse') {
    return 'uk';
  }
  if (/^(hf_|nf_)/.test(c)) {
    return 'always';
  }
  if (/^(b_|int_)/.test(c)) {
    return 'us';
  }
  return null;
}

/** 自选股中是否有任一品种所在市场处于交易时段 */
export function isAnyWatchlistMarketOpen(codes: string[], now = new Date()): boolean {
  if (codes.length === 0) {
    return isAShareTradingHours(now);
  }

  let hasRecognized = false;
  for (const code of codes) {
    const key = resolveMarketKey(code);
    if (key === 'always') {
      return true;
    }
    if (key === null) {
      continue;
    }
    hasRecognized = true;
    const session = MARKET_SESSIONS[key];
    if (session && isSessionOpen(session, now)) {
      return true;
    }
  }

  return hasRecognized ? false : isAShareTradingHours(now);
}

/**
 * 根据交易时段返回实际刷新间隔。
 * 传入自选股代码时，会按各市场开收盘判断；任一市场开盘则保持高频刷新。
 */
export function getEffectiveRefreshInterval(
  baseIntervalMs: number,
  now = new Date(),
  codes?: readonly string[]
): number {
  const config = workspace.getConfiguration('take-home');
  const offHoursEnabled = config.get<boolean>('offHoursRefresh.enabled', true);
  const marketsOpen =
    codes !== undefined ? isAnyWatchlistMarketOpen([...codes], now) : isAShareTradingHours(now);

  if (!offHoursEnabled || marketsOpen) {
    return baseIntervalMs;
  }

  const offHoursInterval = config.get<number>('offHoursRefresh.interval', 60000);
  return Math.max(baseIntervalMs, offHoursInterval);
}
