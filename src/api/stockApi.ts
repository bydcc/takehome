import { SearchResult, StockQuote } from '../models/types';

const SEARCH_URL = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get';
const SINA_URL = 'https://hq.sinajs.cn/list=';
const TENCENT_URL = 'https://qt.gtimg.cn/q=';
const TIMEOUT_MS = 8000;

async function httpGet(
  url: string,
  options?: {
    params?: Record<string, string>;
    headers?: Record<string, string>;
    encoding?: 'utf8' | 'gb18030' | 'gbk';
  }
): Promise<string> {
  const target = new URL(url);
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      target.searchParams.set(key, value);
    }
  }

  const resp = await fetch(target.toString(), {
    headers: options?.headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (options?.encoding === 'gb18030' || options?.encoding === 'gbk') {
    return new TextDecoder(options.encoding).decode(buffer);
  }
  return buffer.toString('utf8');
}

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
    default:
      return `${m}${code}`;
  }
}

function isHKCode(code: string): boolean {
  return code.startsWith('hk');
}

function isUSCode(code: string): boolean {
  return code.startsWith('usr_');
}

export async function searchStocks(keyword: string): Promise<SearchResult[]> {
  if (!keyword.trim()) {
    return [];
  }

  const body = await httpGet(SEARCH_URL, { params: { q: keyword } });
  const data = JSON.parse(body) as { data?: { stock?: string[][] } };
  const stockList = data.data?.stock ?? [];

  return stockList.map((item) => ({
    market: item[0],
    code: formatStockCode(item[0], item[1]),
    name: item[2],
  }));
}

export async function fetchQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  const hkCodes = codes.filter(isHKCode);
  const otherCodes = codes.filter((c) => !isHKCode(c));

  const [hkQuotes, otherQuotes] = await Promise.all([
    fetchHKQuotes(hkCodes),
    fetchSinaQuotes(otherCodes),
  ]);

  const quoteMap = new Map<string, StockQuote>();
  for (const q of [...hkQuotes, ...otherQuotes]) {
    quoteMap.set(q.code, q);
  }

  return codes.map((code) => quoteMap.get(normalizeCode(code))).filter((q): q is StockQuote => !!q);
}

async function fetchSinaQuotes(codes: string[]): Promise<StockQuote[]> {
  if (codes.length === 0) {
    return [];
  }

  const url = SINA_URL + codes.map((c) => c.replace('.', '$')).join(',');
  const body = await httpGet(url, {
    headers: {
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0',
    },
    encoding: 'gb18030',
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
    code = normalizeCode(code);

    const params = line.split('="')[1].split(',');
    if (params.length < 4 || !params[0]) {
      continue;
    }

    const quote = parseSinaQuote(code, params);
    if (quote) {
      quotes.push(quote);
    }
  }

  return quotes;
}

function parseSinaQuote(code: string, params: string[]): StockQuote | null {
  const name = params[0];

  if (/^(sh|sz|bj)/.test(code)) {
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
    const price = parseFloat(params[1]) || 0;
    const open = parseFloat(params[5]) || 0;
    const high = parseFloat(params[6]) || 0;
    const low = parseFloat(params[7]) || 0;
    const yestclose = parseFloat(params[26]) || price;
    const change = price - yestclose;
    const percent = yestclose ? (change / yestclose) * 100 : 0;

    return { code, name, price, yestclose, open, high, low, change, percent, amount: 0 };
  }

  return null;
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

    const price = parseFloat(data[3]) || 0;
    const yestclose = parseFloat(data[4]) || 0;
    const open = parseFloat(data[5]) || 0;
    const high = parseFloat(data[33]) || 0;
    const low = parseFloat(data[34]) || 0;
    const change = price - yestclose;
    const percent = yestclose ? (change / yestclose) * 100 : 0;
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
  const decimals = isUSCode(code) ? 3 : 2;
  return price.toFixed(decimals);
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
