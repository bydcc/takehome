import {
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  workspace,
} from 'vscode';
import {
  fetchQuotes,
  formatAmount,
  formatPercent,
  formatPrice,
  formatPriceWithPercent,
  formatStockLabel,
  getMarketLabel,
} from '../api/stockApi';
import { SortOrder, StockGroup, StockItem, StockQuote, StockTreeContext } from '../models/types';
import { StockStorage } from '../storage/stockStorage';
import { getTrendIcon } from '../ui/trendIndicator';

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

export class StockTreeProvider implements TreeDataProvider<StockTreeItem> {
  private _onDidChangeTreeData = new EventEmitter<StockTreeItem | undefined>();
  readonly onDidChangeTreeData: Event<StockTreeItem | undefined> = this._onDidChangeTreeData.event;

  private quotes = new Map<string, StockQuote>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private sortOrder: SortOrder = 'none';

  constructor(
    private storage: StockStorage,
    private extensionUri: Uri
  ) {}

  getSortOrder(): SortOrder {
    return this.sortOrder;
  }

  getSortLabel(): string {
    switch (this.sortOrder) {
      case 'asc':
        return '涨跌幅升序';
      case 'desc':
        return '涨跌幅降序';
      default:
        return '默认顺序';
    }
  }

  setSortOrder(order: SortOrder): void {
    this.sortOrder = order;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const interval = workspace.getConfiguration('take-home').get<number>('refreshInterval', 5000);
    this.refreshTimer = setInterval(() => void this.refreshQuotes(), interval);
    void this.refreshQuotes();
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refreshQuotes(): Promise<void> {
    const codes = this.storage.getAllCodes();
    if (codes.length === 0) {
      this.quotes.clear();
      this.refresh();
      return;
    }

    try {
      const quotes = await fetchQuotes(codes);
      this.quotes = new Map(quotes.map((q) => [normalizeCode(q.code), q]));
      this.refresh();
    } catch {
      // 静默失败，保留上次数据
    }
  }

  async fetchQuotesForCodes(codes: string[]): Promise<void> {
    if (codes.length === 0) {
      return;
    }
    try {
      const quotes = await fetchQuotes(codes);
      for (const q of quotes) {
        this.quotes.set(normalizeCode(q.code), q);
      }
      this.refresh();
    } catch {
      // ignore
    }
  }

  getTreeItem(element: StockTreeItem): TreeItem {
    return element;
  }

  getChildren(element?: StockTreeItem): StockTreeItem[] {
    if (!element) {
      return this.storage.getRootGroups().map((g) => this.createGroupItem(g));
    }

    if (element.context.type === 'group' && element.context.groupId) {
      const groupId = element.context.groupId;
      const childGroups = this.storage.getChildGroups(groupId).map((g) => this.createGroupItem(g));
      const group = this.storage.findGroup(groupId);
      if (!group) {
        return childGroups;
      }
      const stocks = this.sortStocks(group.stocks).map((stock) =>
        this.createStockItem(stock, group.id)
      );
      return [...childGroups, ...stocks];
    }

    return [];
  }

  private sortStocks(stocks: StockItem[]): StockItem[] {
    if (this.sortOrder === 'none') {
      return stocks;
    }

    return [...stocks].sort((a, b) => {
      const pa = this.quotes.get(normalizeCode(a.code))?.percent ?? 0;
      const pb = this.quotes.get(normalizeCode(b.code))?.percent ?? 0;
      return this.sortOrder === 'asc' ? pa - pb : pb - pa;
    });
  }

  private createGroupItem(group: StockGroup): StockTreeItem {
    const childCount = this.storage.getChildGroups(group.id).length;
    const stockCount = group.stocks.length;
    const parts: string[] = [];
    if (stockCount > 0) {
      parts.push(`${stockCount} 股`);
    }
    if (childCount > 0) {
      parts.push(`${childCount} 组`);
    }
    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';

    const item = new StockTreeItem(
      `${group.name}${suffix}`,
      TreeItemCollapsibleState.Expanded,
      { type: 'group', groupId: group.id }
    );
    item.id = `group:${group.id}`;
    item.iconPath = new ThemeIcon('folder');
    item.contextValue = 'group';
    return item;
  }

  private createStockItem(stock: StockItem, groupId: string): StockTreeItem {
    const normalized = normalizeCode(stock.code);
    const quote = this.quotes.get(normalized);

    const displayName = formatStockLabel(stock.name, normalized);
    const item = new StockTreeItem(displayName, TreeItemCollapsibleState.None, {
      type: 'stock',
      groupId,
      stock: { code: normalized, name: stock.name, note: stock.note },
    });

    const noteSuffix = stock.note ? `  ${stock.note}` : '';

    if (quote && quote.price > 0) {
      const priceStr = formatPrice(quote.price, normalized);
      const percentStr = formatPercent(quote.percent);
      const amountStr = formatAmount(quote.amount);
      item.description = `${priceStr}  ${percentStr}  ${amountStr}${noteSuffix}`;
      item.iconPath = getTrendIcon(this.extensionUri, quote.percent);
    } else {
      item.description = stock.note ? `${normalized}  ${stock.note}` : normalized;
      item.iconPath = new ThemeIcon('graph');
    }

    item.id = `stock:${groupId}:${normalized}`;
    item.contextValue = 'stock';
    const marketLabel = getMarketLabel(normalized);
    const marketLine = marketLabel ? `\n市场: ${marketLabel}` : '';
    const noteLine = stock.note ? `\n备注: ${stock.note}` : '';
    item.tooltip = quote
      ? `${displayName} (${normalized})${marketLine}\n现价: ${formatPrice(quote.price, normalized)} (${formatPercent(quote.percent)})\n成交额: ${formatAmount(quote.amount)}\n今开: ${formatPrice(quote.open, normalized)}\n最高: ${formatPriceWithPercent(quote.high, quote.yestclose, normalized)}\n最低: ${formatPriceWithPercent(quote.low, quote.yestclose, normalized)}${noteLine}`
      : `${displayName} (${normalized})${marketLine}${noteLine}`;

    return item;
  }
}

export class StockTreeItem extends TreeItem {
  constructor(
    label: string,
    collapsibleState: TreeItemCollapsibleState,
    readonly context: StockTreeContext
  ) {
    super(label, collapsibleState);
  }
}
