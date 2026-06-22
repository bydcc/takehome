/** 新浪环球指数行情页 slug（去掉 b_/int_ 前缀后的大写代码） */
const SINA_US_INDEX_URL: Record<string, string> = {
  int_dji: 'https://stock.finance.sina.com.cn/usstock/quotes/.DJI.html',
  int_nasdaq: 'https://stock.finance.sina.com.cn/usstock/quotes/.IXIC.html',
};

/** 生成可在浏览器中打开的详情页链接，不产生额外 API 请求 */
export function getStockDetailUrl(code: string): string | undefined {
  const c = code.toLowerCase();

  if (/^(sh|sz|bj)\d+/.test(c)) {
    return `https://quote.eastmoney.com/${c}.html`;
  }
  if (/^hk\d+/.test(c)) {
    return `https://quote.eastmoney.com/hk/${c.slice(2)}.html`;
  }
  if (c.startsWith('usr_')) {
    return `https://finance.sina.com.cn/stock/usstock/${c.slice(4)}.html`;
  }
  if (c.startsWith('b_')) {
    const slug = c.slice(2).toUpperCase();
    return `https://finance.sina.com.cn/stock/globalindex/quotes/${slug}`;
  }
  const usIndexUrl = SINA_US_INDEX_URL[c];
  if (usIndexUrl) {
    return usIndexUrl;
  }
  if (c.startsWith('int_')) {
    const slug = c.slice(4).toUpperCase();
    return `https://finance.sina.com.cn/stock/globalindex/quotes/${slug}`;
  }
  if (c.startsWith('hf_') || c.startsWith('nf_')) {
    const slug = c.slice(3).toUpperCase();
    return `https://finance.sina.com.cn/futures/quotes/${slug}.shtml`;
  }

  return undefined;
}
