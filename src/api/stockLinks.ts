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
  if (c.startsWith('b_') || c.startsWith('int_')) {
    return `https://finance.sina.com.cn/money/globalindex/${c}.shtml`;
  }
  if (c.startsWith('hf_') || c.startsWith('nf_')) {
    return `https://finance.sina.com.cn/futures/quotes/${c}.shtml`;
  }

  return undefined;
}
