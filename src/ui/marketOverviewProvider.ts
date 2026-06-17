import {
  Disposable,
  StatusBarAlignment,
  StatusBarItem,
  window,
  workspace,
} from 'vscode';
import {
  formatMarketAmount,
  formatPercent,
  formatPrice,
} from '../api/stockApi';
import { MarketOverview } from '../models/types';
import { MarketOverviewScheduler } from '../service/marketOverviewScheduler';

function getRiseColor(): string {
  return workspace.getConfiguration('take-home').get<string>('riseColor', '#f14c4c');
}

function getFallColor(): string {
  return workspace.getConfiguration('take-home').get<string>('fallColor', '#73c991');
}

export class MarketOverviewProvider implements Disposable {
  private item: StatusBarItem;
  private overview: MarketOverview | undefined;
  private disposables: Disposable[] = [];

  constructor(scheduler: MarketOverviewScheduler) {
    this.item = window.createStatusBarItem(StatusBarAlignment.Right, 48);
    this.item.command = 'take-home.configureMarketOverview';
    this.item.tooltip = 'A 股市场概览（点击配置）';

    this.disposables.push(
      scheduler.subscribe((overview) => {
        this.overview = overview;
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
    return workspace.getConfiguration('take-home').get<boolean>('marketOverview.enabled', true);
  }

  startAutoRefresh(): void {
    this.updateDisplay();
  }

  stopAutoRefresh(): void {
    // 刷新由 MarketOverviewScheduler 统一管理
  }

  updateDisplay(): void {
    if (!this.isEnabled()) {
      this.item.hide();
      return;
    }

    if (!this.overview) {
      this.item.text = '$(pulse) 市场概览 --';
      this.item.color = undefined;
      this.item.tooltip = 'A 股市场概览（加载中…）';
      this.item.show();
      return;
    }

    const { riseCount, fallCount, flatCount, totalAmount, shIndex, szIndex } = this.overview;
    this.item.text =
      `$(pulse) 涨${riseCount} 跌${fallCount} 平${flatCount}` +
      `  |  成交${formatMarketAmount(totalAmount)}`;

    if (riseCount > fallCount) {
      this.item.color = getRiseColor();
    } else if (fallCount > riseCount) {
      this.item.color = getFallColor();
    } else {
      this.item.color = undefined;
    }

    this.item.tooltip =
      `A 股市场概览\n` +
      `上涨: ${riseCount}  下跌: ${fallCount}  平盘: ${flatCount}\n` +
      `两市成交额: ${formatMarketAmount(totalAmount)}\n\n` +
      `${shIndex.name}: ${formatPrice(shIndex.price, 'sh000001')} (${formatPercent(shIndex.percent)})\n` +
      `沪市成交额: ${formatMarketAmount(shIndex.amount)}\n` +
      `${szIndex.name}: ${formatPrice(szIndex.price, 'sz399001')} (${formatPercent(szIndex.percent)})\n` +
      `深市成交额: ${formatMarketAmount(szIndex.amount)}\n\n` +
      `点击配置市场概览`;
    this.item.show();
  }
}
