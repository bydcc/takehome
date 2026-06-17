import { QuickPickItem, window } from 'vscode';
import { getMarketLabel, searchStocks } from '../api/stockApi';
import { SearchResult } from '../models/types';

interface StockPickItem extends QuickPickItem {
  stock?: SearchResult;
}

const DEBOUNCE_MS = 300;

export async function showStockSearchPicker(): Promise<SearchResult | undefined> {
  const quickPick = window.createQuickPick<StockPickItem>();
  quickPick.placeholder = '输入代码、名称、拼音或环球品种（如 NKY、布伦特、A50）';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;

  quickPick.onDidChangeValue((value) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    const keyword = value.trim();
    if (!keyword) {
      quickPick.items = [];
      quickPick.busy = false;
      return;
    }

    quickPick.busy = true;
    debounceTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const results = await searchStocks(keyword);
        if (seq !== searchSeq) {
          return;
        }
        quickPick.items = results.slice(0, 30).map((r) => ({
          label: r.name,
          description: r.code,
          detail: getMarketLabel(r.code) || r.market.toUpperCase(),
          alwaysShow: true,
          stock: r,
        }));
      } catch {
        if (seq === searchSeq) {
          quickPick.items = [{ label: '搜索失败，请检查网络', alwaysShow: true }];
        }
      } finally {
        if (seq === searchSeq) {
          quickPick.busy = false;
        }
      }
    }, DEBOUNCE_MS);
  });

  return new Promise((resolve) => {
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0];
      if (item?.stock) {
        resolve(item.stock);
      } else {
        resolve(undefined);
      }
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(undefined);
    });
    quickPick.show();
  });
}
