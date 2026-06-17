import {
  CancellationToken,
  Disposable,
  Event,
  EventEmitter,
  ProviderResult,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
} from 'vscode';
import {
  formatAmount,
  formatPercent,
  formatPrice,
  formatPriceWithPercent,
  formatStockLabel,
  getMarketLabel,
} from '../api/stockApi';
import { SortOrder, StockGroup, StockItem, StockQuote, StockTreeContext } from '../models/types';
import { MaCacheService } from '../service/maCacheService';
import { QuoteScheduler } from '../service/quoteScheduler';
import { StockStorage } from '../storage/stockStorage';
import { getTrendIcon } from '../ui/trendIndicator';

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

export class StockTreeProvider implements TreeDataProvider<StockTreeItem>, Disposable {
  private _onDidChangeTreeData = new EventEmitter<StockTreeItem | undefined>();
  readonly onDidChangeTreeData: Event<StockTreeItem | undefined> = this._onDidChangeTreeData.event;

  private quotes = new Map<string, StockQuote>();
  private sortOrder: SortOrder = 'none';
  private disposables: Disposable[] = [];
  /** VS Code TreeView 的增量刷新依赖元素实例稳定，按 id 复用节点对象 */
  private itemCache = new Map<string, StockTreeItem>();
  /** 记录每行展示指纹，仅变化时才刷新对应节点，避免悬浮 tooltip 被整树重绘打断 */
  private displayFingerprints = new Map<string, string>();
  /** MA 更新后仅刷新 tooltip，不重绘行内价格 */
  private tooltipFingerprints = new Map<string, string>();
  /** 是否已收到过可展示的行情（用于首次加载后强制整树刷新） */
  private hasDisplayableQuotes = false;

  constructor(
    private storage: StockStorage,
    private extensionUri: Uri,
    quoteScheduler: QuoteScheduler,
    private maCache: MaCacheService
  ) {
    this.disposables.push(
      quoteScheduler.registerCodeProvider(() => this.storage.getAllCodes()),
      quoteScheduler.subscribe((quotes) => {
        this.onQuotesUpdated(quotes);
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

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
    this.displayFingerprints.clear();
    this.tooltipFingerprints.clear();
    this.refresh();
  }

  /** 结构变化（增删分组/排序等）时全量刷新 */
  refresh(): void {
    this.displayFingerprints.clear();
    this.tooltipFingerprints.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** MA 就绪后只刷新该股票 tooltip，不碰行内价格 */
  refreshStockTooltip(code: string): void {
    const normalized = normalizeCode(code);
    for (const group of this.storage.getGroups()) {
      const stock = group.stocks.find((s) => normalizeCode(s.code) === normalized);
      if (!stock) {
        continue;
      }
      const id = `stock:${group.id}:${normalized}`;
      const fp = this.buildTooltipFingerprint(stock, normalized);
      if (this.tooltipFingerprints.get(id) === fp) {
        return;
      }
      this.tooltipFingerprints.set(id, fp);
      this.fireItem(id, { type: 'stock', groupId: group.id, stock });
      return;
    }
  }

  getQuote(code: string): StockQuote | undefined {
    return this.quotes.get(normalizeCode(code));
  }

  getTreeItem(element: StockTreeItem): TreeItem {
    return this.buildItem(element);
  }

  resolveTreeItem(
    item: TreeItem,
    element: StockTreeItem,
    _token: CancellationToken
  ): ProviderResult<StockTreeItem> {
    const built = this.buildItem(element);
    if (built.context.type === 'stock' && built.context.groupId && built.context.stock) {
      const code = normalizeCode(built.context.stock.code);
      this.maCache.ensure(code);
      built.tooltip = this.buildStockTooltip(built.context.stock, built.context.groupId);
    }
    return built;
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

  private onQuotesUpdated(quotes: ReadonlyMap<string, StockQuote>): void {
    this.quotes = new Map(quotes);
    const hasDisplayable = [...quotes.values()].some((q) => q.price > 0);
    if (hasDisplayable && !this.hasDisplayableQuotes) {
      this.hasDisplayableQuotes = true;
      this.displayFingerprints.clear();
      this.tooltipFingerprints.clear();
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const changedGroupIds = new Set<string>();

    for (const group of this.storage.getGroups()) {
      for (const stock of group.stocks) {
        const normalized = normalizeCode(stock.code);
        const id = `stock:${group.id}:${normalized}`;
        const fp = this.stockRowFingerprint(stock, normalized);
        if (this.displayFingerprints.get(id) === fp) {
          continue;
        }
        this.displayFingerprints.set(id, fp);
        this.fireItem(id, { type: 'stock', groupId: group.id, stock });
        changedGroupIds.add(group.id);
      }
    }

    for (const groupId of changedGroupIds) {
      this.refreshGroupChain(groupId);
    }
  }

  private refreshGroupChain(groupId: string): void {
    let current: string | undefined = groupId;
    while (current) {
      const group = this.storage.findGroup(current);
      if (!group) {
        break;
      }
      const id = `group:${current}`;
      const fp = this.groupRowFingerprint(group);
      if (this.displayFingerprints.get(id) !== fp) {
        this.displayFingerprints.set(id, fp);
        this.fireItem(id, { type: 'group', groupId: current });
      }
      current = this.storage.getGroupParentId(current);
    }
  }

  private fireItem(id: string, context: StockTreeContext): void {
    const item = this.itemCache.get(id);
    if (!item) {
      this._onDidChangeTreeData.fire(undefined);
      return;
    }
    item.context = context;
    this._onDidChangeTreeData.fire(item);
  }

  private getOrCreateItem(
    id: string,
    label: string,
    collapsibleState: TreeItemCollapsibleState,
    context: StockTreeContext
  ): StockTreeItem {
    const cached = this.itemCache.get(id);
    if (cached) {
      cached.label = label;
      cached.collapsibleState = collapsibleState;
      cached.context = context;
      cached.description = undefined;
      cached.tooltip = undefined;
      cached.iconPath = undefined;
      cached.contextValue = undefined;
      cached.command = undefined;
      return cached;
    }

    const item = new StockTreeItem(label, collapsibleState, context);
    item.id = id;
    this.itemCache.set(id, item);
    return item;
  }

  private buildItem(element: StockTreeItem): StockTreeItem {
    if (element.context.type === 'group' && element.context.groupId) {
      const group = this.storage.findGroup(element.context.groupId);
      if (group) {
        return this.createGroupItem(group);
      }
    }
    if (element.context.type === 'stock' && element.context.groupId && element.context.stock) {
      return this.createStockItem(element.context.stock, element.context.groupId);
    }
    return element;
  }

  private stockRowFingerprint(stock: StockItem, code: string): string {
    const quote = this.quotes.get(code);
    const noteSuffix = stock.note ? `  ${stock.note}` : '';
    const alertSuffix =
      stock.alertAbove !== undefined || stock.alertBelow !== undefined ? '  $(bell)' : '';
    if (quote && quote.price > 0) {
      return `${quote.price}|${quote.change}|${quote.percent}|${formatPrice(quote.price, code)}|${formatPercent(quote.percent)}|${formatAmount(quote.amount)}${noteSuffix}${alertSuffix}`;
    }
    return `pending|${code}${noteSuffix}`;
  }

  private buildTooltipFingerprint(stock: StockItem, code: string): string {
    const quote = this.quotes.get(code);
    const ma = this.maCache.get(code);
    const maKey = ma ? `${ma.ma5}|${ma.ma10}|${ma.ma20}` : 'none';
    const qKey = quote
      ? `${quote.price}|${quote.percent}|${quote.amount}|${quote.yestclose}|${quote.open}|${quote.high}|${quote.low}`
      : 'none';
    return `${qKey}|${maKey}|${stock.note ?? ''}|${stock.alertAbove ?? ''}|${stock.alertBelow ?? ''}`;
  }

  private groupRowFingerprint(group: StockGroup): string {
    const childCount = this.storage.getChildGroups(group.id).length;
    const stockCount = group.stocks.length;
    const subtreeStockCount = this.storage.countStocksInSubtree(group.id);
    const stats = subtreeStockCount > 0 ? this.calcGroupStats(group.id) : undefined;
    const quotedCount = stats ? this.countQuotedInSubtree(group.id) : 0;
    return `${stockCount}|${childCount}|${quotedCount}|${stats?.rise ?? 0}|${stats?.fall ?? 0}|${stats?.avgPercent ?? 0}`;
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

  private calcGroupStats(groupId: string): { rise: number; fall: number; avgPercent: number } {
    let rise = 0;
    let fall = 0;
    let sum = 0;
    let count = 0;

    const walk = (id: string) => {
      const group = this.storage.findGroup(id);
      if (!group) {
        return;
      }
      for (const stock of group.stocks) {
        const quote = this.quotes.get(normalizeCode(stock.code));
        if (!quote || quote.price <= 0) {
          continue;
        }
        count++;
        sum += quote.percent;
        if (quote.percent > 0) {
          rise++;
        } else if (quote.percent < 0) {
          fall++;
        }
      }
      for (const child of this.storage.getChildGroups(id)) {
        walk(child.id);
      }
    };

    walk(groupId);
    return { rise, fall, avgPercent: count > 0 ? sum / count : 0 };
  }

  private createGroupItem(group: StockGroup): StockTreeItem {
    const childCount = this.storage.getChildGroups(group.id).length;
    const stockCount = group.stocks.length;
    const subtreeStockCount = this.storage.countStocksInSubtree(group.id);
    const parts: string[] = [];
    if (stockCount > 0) {
      parts.push(`${stockCount} 股`);
    }
    if (childCount > 0) {
      parts.push(`${childCount} 组`);
    }

    const stats = subtreeStockCount > 0 ? this.calcGroupStats(group.id) : undefined;
    const quotedCount = stats ? this.countQuotedInSubtree(group.id) : 0;
    if (stats && quotedCount > 0) {
      parts.push(`涨${stats.rise}跌${stats.fall}`);
    }

    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';

    const id = `group:${group.id}`;
    const item = this.getOrCreateItem(id, `${group.name}${suffix}`, TreeItemCollapsibleState.Expanded, {
      type: 'group',
      groupId: group.id,
    });
    item.iconPath = new ThemeIcon('folder');
    item.contextValue = 'group';

    if (stats && quotedCount > 0) {
      item.tooltip = `${group.name}\n涨 ${stats.rise} · 跌 ${stats.fall} · 均涨跌幅 ${formatPercent(stats.avgPercent)}`;
    }

    return item;
  }

  private countQuotedInSubtree(groupId: string): number {
    let count = 0;
    const walk = (id: string) => {
      const group = this.storage.findGroup(id);
      if (!group) {
        return;
      }
      for (const stock of group.stocks) {
        const quote = this.quotes.get(normalizeCode(stock.code));
        if (quote && quote.price > 0) {
          count++;
        }
      }
      for (const child of this.storage.getChildGroups(id)) {
        walk(child.id);
      }
    };
    walk(groupId);
    return count;
  }

  private createStockItem(stock: StockItem, groupId: string): StockTreeItem {
    const normalized = normalizeCode(stock.code);
    const quote = this.quotes.get(normalized);

    const displayName = formatStockLabel(stock.name, normalized);
    const id = `stock:${groupId}:${normalized}`;
    const item = this.getOrCreateItem(id, displayName, TreeItemCollapsibleState.None, {
      type: 'stock',
      groupId,
      stock,
    });

    const noteSuffix = stock.note ? `  ${stock.note}` : '';
    const alertSuffix =
      stock.alertAbove !== undefined || stock.alertBelow !== undefined ? '  $(bell)' : '';

    if (quote && quote.price > 0) {
      const priceStr = formatPrice(quote.price, normalized);
      const percentStr = formatPercent(quote.percent);
      const amountStr = formatAmount(quote.amount);
      item.description = `${priceStr}  ${percentStr}  ${amountStr}${noteSuffix}${alertSuffix}`;
      item.iconPath = getTrendIcon(this.extensionUri, quote.percent);
    } else {
      item.description = stock.note ? `${normalized}  ${stock.note}` : normalized;
      item.iconPath = new ThemeIcon('graph');
    }

    item.contextValue = 'stock';
    item.command = {
      command: 'take-home.viewStockDetail',
      title: '查看详情',
      arguments: [item],
    };
    // tooltip 由 resolveTreeItem 在悬停时注入，避免行情刷新时反复重置悬浮窗

    return item;
  }

  private buildStockTooltip(stock: StockItem, groupId: string): string {
    const normalized = normalizeCode(stock.code);
    const quote = this.quotes.get(normalized);
    const displayName = formatStockLabel(stock.name, normalized);
    const marketLabel = getMarketLabel(normalized);
    const marketLine = marketLabel ? `\n市场: ${marketLabel}` : '';
    const noteLine = stock.note ? `\n备注: ${stock.note}` : '';
    const alertLines: string[] = [];
    if (stock.alertAbove !== undefined) {
      alertLines.push(`价格提醒（上限）: ≥ ${formatPrice(stock.alertAbove, normalized)}`);
    }
    if (stock.alertBelow !== undefined) {
      alertLines.push(`价格提醒（下限）: ≤ ${formatPrice(stock.alertBelow, normalized)}`);
    }
    const alertLine = alertLines.length > 0 ? `\n${alertLines.join('\n')}` : '';
    const maLine = this.formatMaTooltip(normalized);

    return quote
      ? `${displayName} (${normalized})${marketLine}\n现价: ${formatPrice(quote.price, normalized)} (${formatPercent(quote.percent)})\n成交额: ${formatAmount(quote.amount)}\n昨收: ${formatPrice(quote.yestclose, normalized)}\n今开: ${formatPriceWithPercent(quote.open, quote.yestclose, normalized)}\n最高: ${formatPriceWithPercent(quote.high, quote.yestclose, normalized)}\n最低: ${formatPriceWithPercent(quote.low, quote.yestclose, normalized)}${maLine}${noteLine}${alertLine}`
      : `${displayName} (${normalized})${marketLine}${maLine}${noteLine}${alertLine}`;
  }

  private formatMaTooltip(code: string): string {
    if (!this.maCache.isEnabled()) {
      return '';
    }
    const ma = this.maCache.get(code);
    if (!ma) {
      return '';
    }
    const lines: string[] = [];
    if (ma.ma5 !== null) {
      lines.push(`MA5: ${formatPrice(ma.ma5, code)}`);
    }
    if (ma.ma10 !== null) {
      lines.push(`MA10: ${formatPrice(ma.ma10, code)}`);
    }
    if (ma.ma20 !== null) {
      lines.push(`MA20: ${formatPrice(ma.ma20, code)}`);
    }
    return lines.length > 0 ? `\n${lines.join('\n')}` : '';
  }
}

export class StockTreeItem extends TreeItem {
  constructor(
    label: string,
    collapsibleState: TreeItemCollapsibleState,
    public context: StockTreeContext
  ) {
    super(label, collapsibleState);
  }
}
