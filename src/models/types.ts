export interface StockItem {
  code: string;
  name: string;
  /** 东方财富 QuoteID（如 100.N225），K 线/分时优先使用 */
  secid?: string;
  note?: string;
  /** 价格高于此值时提醒（复用行情刷新检测，无额外请求） */
  alertAbove?: number;
  /** 价格低于此值时提醒 */
  alertBelow?: number;
}

export interface StockGroup {
  id: string;
  name: string;
  parentId?: string;
  stocks: StockItem[];
}

export interface StockConfig {
  groups: StockGroup[];
}

export interface TakeHomeExportFile {
  version: 1;
  exportedAt: string;
  groups: StockGroup[];
}

export interface StockQuote {
  code: string;
  name: string;
  price: number;
  yestclose: number;
  open: number;
  high: number;
  low: number;
  percent: number;
  change: number;
  amount: number;
}

export interface SearchResult {
  code: string;
  name: string;
  market: string;
  /** 东方财富 QuoteID，搜索添加时写入 */
  secid?: string;
}

export interface MarketIndexSnapshot {
  name: string;
  price: number;
  percent: number;
  amount: number;
}

export interface MarketOverview {
  riseCount: number;
  fallCount: number;
  flatCount: number;
  totalAmount: number;
  shIndex: MarketIndexSnapshot;
  szIndex: MarketIndexSnapshot;
}

export type SortOrder = 'none' | 'asc' | 'desc';

export type TreeItemType = 'group' | 'stock';

export interface SortOption {
  order: SortOrder;
  label: string;
}

export interface StockTreeContext {
  type: TreeItemType;
  groupId?: string;
  stock?: StockItem;
}
