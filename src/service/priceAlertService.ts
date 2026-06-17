import { Disposable, window } from 'vscode';
import { formatPrice } from '../api/stockApi';
import { StockQuote } from '../models/types';
import { StockStorage } from '../storage/stockStorage';

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

interface AlertState {
  aboveArmed: boolean;
  belowArmed: boolean;
}

/** 在已有行情刷新结果上检测价格穿越，不发起额外请求 */
export class PriceAlertService implements Disposable {
  private states = new Map<string, AlertState>();

  constructor(private onViewDetail?: (code: string, name: string) => void) {}

  dispose(): void {
    this.states.clear();
  }

  checkAlerts(storage: StockStorage, quotes: ReadonlyMap<string, StockQuote>): void {
    for (const group of storage.getGroups()) {
      for (const stock of group.stocks) {
        const code = normalizeCode(stock.code);
        const quote = quotes.get(code);
        if (!quote || quote.price <= 0) {
          continue;
        }

        const hasAbove = stock.alertAbove !== undefined && stock.alertAbove > 0;
        const hasBelow = stock.alertBelow !== undefined && stock.alertBelow > 0;
        if (!hasAbove && !hasBelow) {
          this.states.delete(code);
          continue;
        }

        let state = this.states.get(code);
        if (!state) {
          state = {
            aboveArmed: hasAbove ? quote.price < (stock.alertAbove ?? 0) : false,
            belowArmed: hasBelow ? quote.price > (stock.alertBelow ?? 0) : false,
          };
          this.states.set(code, state);
          continue;
        }

        if (hasAbove && state.aboveArmed && quote.price >= (stock.alertAbove ?? 0)) {
          state.aboveArmed = false;
          void window
            .showInformationMessage(
              `价格提醒：${stock.name} 已涨至 ${formatPrice(quote.price, code)}（≥ ${formatPrice(stock.alertAbove!, code)}）`,
              '查看详情'
            )
            .then((action) => {
              if (action === '查看详情') {
                this.onViewDetail?.(code, stock.name);
              }
            });
        } else if (hasAbove && !state.aboveArmed && quote.price < (stock.alertAbove ?? 0)) {
          state.aboveArmed = true;
        }

        if (hasBelow && state.belowArmed && quote.price <= (stock.alertBelow ?? 0)) {
          state.belowArmed = false;
          void window
            .showInformationMessage(
              `价格提醒：${stock.name} 已跌至 ${formatPrice(quote.price, code)}（≤ ${formatPrice(stock.alertBelow!, code)}）`,
              '查看详情'
            )
            .then((action) => {
              if (action === '查看详情') {
                this.onViewDetail?.(code, stock.name);
              }
            });
        } else if (hasBelow && !state.belowArmed && quote.price > (stock.alertBelow ?? 0)) {
          state.belowArmed = true;
        }
      }
    }
  }

  resetCode(code: string): void {
    this.states.delete(normalizeCode(code));
  }
}
