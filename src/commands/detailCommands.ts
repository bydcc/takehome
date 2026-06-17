import { commands, env, Uri, window } from 'vscode';
import { formatPrice } from '../api/stockApi';
import { getStockDetailUrl } from '../api/stockLinks';
import { StockTreeItem } from '../provider/stockTreeProvider';
import { PriceAlertService } from '../service/priceAlertService';
import { QuoteScheduler } from '../service/quoteScheduler';
import { StockStorage } from '../storage/stockStorage';
import { showStockDetailByCode } from '../ui/stockDetailPanel';

export function registerDetailCommands(
  storage: StockStorage,
  quoteScheduler: QuoteScheduler,
  priceAlertService: PriceAlertService
): import('vscode').Disposable[] {
  return [
    commands.registerCommand('take-home.viewStockDetail', (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.stock) {
        return;
      }
      const { code, name } = item.context.stock;
      showStockDetailByCode(quoteScheduler, storage, code, name, item.context.groupId);
    }),

    commands.registerCommand('take-home.openInBrowser', async (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.stock) {
        return;
      }
      const url = getStockDetailUrl(item.context.stock.code);
      if (!url) {
        void window.showWarningMessage('暂不支持在浏览器中打开该品种');
        return;
      }
      await env.openExternal(Uri.parse(url));
    }),

    commands.registerCommand('take-home.setPriceAlert', async (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.groupId || !item.context.stock) {
        return;
      }

      const { groupId, stock } = item.context;
      const group = storage.findGroup(groupId);
      const current = group?.stocks.find((s) => s.code === stock.code);
      const quote = quoteScheduler.getQuote(stock.code);
      const priceHint =
        quote && quote.price > 0 ? `当前价 ${formatPrice(quote.price, stock.code)}` : '暂无现价';

      const aboveStr = await window.showInputBox({
        prompt: `高于此价格时提醒（留空清除）— ${priceHint}`,
        placeHolder: '例如：1500',
        value: current?.alertAbove !== undefined ? String(current.alertAbove) : '',
      });
      if (aboveStr === undefined) {
        return;
      }

      const belowStr = await window.showInputBox({
        prompt: `低于此价格时提醒（留空清除）— ${priceHint}`,
        placeHolder: '例如：1200',
        value: current?.alertBelow !== undefined ? String(current.alertBelow) : '',
      });
      if (belowStr === undefined) {
        return;
      }

      const alertAbove = parseAlertValue(aboveStr);
      const alertBelow = parseAlertValue(belowStr);
      if (aboveStr.trim() && alertAbove === undefined) {
        void window.showErrorMessage('上限价格格式无效');
        return;
      }
      if (belowStr.trim() && alertBelow === undefined) {
        void window.showErrorMessage('下限价格格式无效');
        return;
      }
      if (alertAbove !== undefined && alertBelow !== undefined && alertAbove <= alertBelow) {
        void window.showErrorMessage('上限价格应高于下限价格');
        return;
      }

      const saved = await storage.setPriceAlert(groupId, stock.code, alertAbove, alertBelow);
      if (!saved) {
        void window.showErrorMessage('价格提醒保存失败');
        return;
      }

      priceAlertService.resetCode(stock.code);

      const parts: string[] = [];
      if (alertAbove !== undefined) {
        parts.push(`≥ ${formatPrice(alertAbove, stock.code)}`);
      }
      if (alertBelow !== undefined) {
        parts.push(`≤ ${formatPrice(alertBelow, stock.code)}`);
      }

      void window.showInformationMessage(
        parts.length > 0 ? `已设置 ${stock.name} 价格提醒：${parts.join('，')}` : `已清除 ${stock.name} 的价格提醒`
      );
    }),
  ];
}

function parseAlertValue(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}
