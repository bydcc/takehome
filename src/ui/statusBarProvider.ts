import {
  Disposable,
  StatusBarAlignment,
  StatusBarItem,
  window,
  workspace,
} from 'vscode';
import { formatPercent, formatPrice, formatStockLabel } from '../api/stockApi';
import { StockQuote } from '../models/types';
import { QuoteScheduler } from '../service/quoteScheduler';

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

function getRiseColor(): string {
  return workspace.getConfiguration('take-home').get<string>('riseColor', '#f14c4c');
}

function getFallColor(): string {
  return workspace.getConfiguration('take-home').get<string>('fallColor', '#73c991');
}

function isStatusBarColorMode(): boolean {
  return workspace.getConfiguration('take-home').get<string>('statusBar.colorMode', 'color') === 'color';
}

export class StatusBarProvider implements Disposable {
  private item: StatusBarItem;
  private quotes: StockQuote[] = [];
  private disposables: Disposable[] = [];

  constructor(quoteScheduler: QuoteScheduler) {
    this.item = window.createStatusBarItem(StatusBarAlignment.Right, 50);
    this.item.command = 'take-home.configureStatusBar';
    this.item.tooltip = '赚钱离场 状态栏行情（点击配置）';

    this.disposables.push(
      quoteScheduler.registerCodeProvider(() => (this.isEnabled() ? this.getCodes() : [])),
      quoteScheduler.subscribe((quoteMap) => {
        const codes = this.getCodes();
        this.quotes = codes
          .map((code) => quoteMap.get(code))
          .filter((q): q is StockQuote => !!q);
        this.updateDisplay();
      })
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.item.dispose();
  }

  isEnabled(): boolean {
    return workspace.getConfiguration('take-home').get<boolean>('statusBar.enabled', false);
  }

  getCodes(): string[] {
    const codes = workspace.getConfiguration('take-home').get<string[]>('statusBar.codes', []);
    return codes.map(normalizeCode).filter(Boolean);
  }

  startAutoRefresh(): void {
    this.updateDisplay();
  }

  stopAutoRefresh(): void {
    // 刷新由 QuoteScheduler 统一管理
  }

  updateDisplay(): void {
    if (!this.isEnabled()) {
      this.item.hide();
      return;
    }

    const codes = this.getCodes();
    if (codes.length === 0) {
      this.item.text = '$(graph) 未设置行情';
      this.item.color = undefined;
      this.item.tooltip = '赚钱离场 状态栏行情（点击配置）';
      this.item.show();
      return;
    }

    const quoteMap = new Map(this.quotes.map((q) => [normalizeCode(q.code), q]));
    const segments: string[] = [];
    let overallPercent = 0;
    let validCount = 0;

    for (const code of codes) {
      const quote = quoteMap.get(code);
      if (!quote || quote.price <= 0) {
        segments.push(`${code} --`);
        continue;
      }

      const priceStr = formatPrice(quote.price, code);
      const percentStr = formatPercent(quote.percent);
      segments.push(`${formatStockLabel(quote.name, code)} ${priceStr} ${percentStr}`);
      overallPercent += quote.percent;
      validCount++;
    }

    this.item.text = `$(graph) ${segments.join('  |  ')}`;

    if (isStatusBarColorMode() && validCount > 0) {
      const percent = validCount === 1 ? overallPercent : overallPercent / validCount;
      this.item.color = percent > 0 ? getRiseColor() : percent < 0 ? getFallColor() : undefined;
    } else {
      this.item.color = undefined;
    }

    const tooltipLines = this.quotes
      .filter((q) => q.price > 0)
      .map(
        (q) =>
          `${formatStockLabel(q.name, q.code)} (${q.code})\n现价: ${formatPrice(q.price, q.code)} (${formatPercent(q.percent)})`
      );
    this.item.tooltip =
      tooltipLines.length > 0
        ? `${tooltipLines.join('\n\n')}\n\n点击配置状态栏行情`
        : '赚钱离场 状态栏行情（点击配置）';
    this.item.show();
  }
}
