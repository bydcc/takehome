import { commands, Disposable, TreeView, window } from 'vscode';
import { StockTreeItem } from '../provider/stockTreeProvider';
import { QuoteScheduler } from '../service/quoteScheduler';
import { StockItem } from '../models/types';
import { StockStorage } from '../storage/stockStorage';
import { CompareStock, showStockCompare } from '../ui/stockComparePanel';

const MAX_COMPARE = 5;
const MIN_COMPARE = 2;

function isStockTreeItem(value: unknown): value is StockTreeItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'context' in value &&
    typeof (value as StockTreeItem).context === 'object'
  );
}

function dedupeStocks(stocks: CompareStock[]): CompareStock[] {
  const seen = new Set<string>();
  const result: CompareStock[] = [];
  for (const s of stocks) {
    const code = s.code.toLowerCase();
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    result.push({ ...s, code });
  }
  return result;
}

function stocksFromTreeItems(items: StockTreeItem[]): CompareStock[] {
  const stocks: CompareStock[] = [];
  for (const item of items) {
    if (item.context.type !== 'stock' || !item.context.stock) {
      continue;
    }
    const { code, name, secid } = item.context.stock;
    stocks.push({ code: code.toLowerCase(), name, secid });
  }
  return dedupeStocks(stocks);
}

function allWatchlistStocks(storage: StockStorage): StockItem[] {
  return dedupeStocks(
    storage.getGroups().flatMap((g) =>
      g.stocks.map((s) => ({
        code: s.code.toLowerCase(),
        name: s.name,
        secid: s.secid,
      }))
    )
  );
}

async function pickStocksFromWatchlist(storage: StockStorage): Promise<CompareStock[] | undefined> {
  const candidates = allWatchlistStocks(storage);
  if (candidates.length < MIN_COMPARE) {
    void window.showWarningMessage('自选股不足 2 只，无法对比走势');
    return undefined;
  }

  type PickItem = { label: string; description: string; stock: CompareStock };
  const picked = await window.showQuickPick<PickItem>(
    candidates.map((s) => ({
      label: s.name,
      description: s.code,
      stock: s,
    })),
    {
      canPickMany: true,
      placeHolder: `选择 ${MIN_COMPARE}～${MAX_COMPARE} 只股票对比走势（归一化涨跌幅）`,
      matchOnDescription: true,
    }
  );

  if (!picked || picked.length < MIN_COMPARE) {
    if (picked && picked.length === 1) {
      void window.showWarningMessage('请至少选择 2 只股票');
    }
    return undefined;
  }

  return picked.slice(0, MAX_COMPARE).map((p) => p.stock);
}

export function registerCompareCommands(
  storage: StockStorage,
  quoteScheduler: QuoteScheduler,
  treeView: TreeView<StockTreeItem>
): Disposable[] {
  return [
    commands.registerCommand('take-home.compareStocks', async (...args: unknown[]) => {
      let stocks = stocksFromTreeItems(args.filter(isStockTreeItem));

      if (stocks.length === 0) {
        stocks = stocksFromTreeItems([...treeView.selection]);
      }

      if (stocks.length < MIN_COMPARE) {
        const picked = await pickStocksFromWatchlist(storage);
        if (!picked) {
          return;
        }
        stocks = picked;
      }

      if (stocks.length > MAX_COMPARE) {
        void window.showInformationMessage(
          `最多对比 ${MAX_COMPARE} 只股票，已取前 ${MAX_COMPARE} 只`
        );
        stocks = stocks.slice(0, MAX_COMPARE);
      }

      showStockCompare(quoteScheduler, stocks);
    }),
  ];
}
