export interface StockItem {
  code: string;
  name: string;
  note?: string;
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
