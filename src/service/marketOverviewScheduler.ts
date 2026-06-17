import { Disposable, workspace } from 'vscode';
import { fetchMarketOverview } from '../api/stockApi';
import { MarketOverview } from '../models/types';
import { getEffectiveRefreshInterval } from '../utils/marketHours';

export type MarketOverviewListener = (overview: MarketOverview | undefined) => void;

/** 市场概览独立拉取（与行情接口不同），共用降频策略 */
export class MarketOverviewScheduler implements Disposable {
  private overview: MarketOverview | undefined;
  private listeners = new Set<MarketOverviewListener>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;

  dispose(): void {
    this.stopAutoRefresh();
    this.listeners.clear();
  }

  subscribe(listener: MarketOverviewListener): Disposable {
    this.listeners.add(listener);
    listener(this.overview);
    return { dispose: () => this.listeners.delete(listener) };
  }

  getOverview(): MarketOverview | undefined {
    return this.overview;
  }

  isEnabled(): boolean {
    return workspace.getConfiguration('take-home').get<boolean>('marketOverview.enabled', true);
  }

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    void this.refresh();
    this.scheduleNext();
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refresh(): Promise<void> {
    if (!this.isEnabled()) {
      this.overview = undefined;
      this.notify();
      return;
    }

    if (this.refreshing) {
      return;
    }

    this.refreshing = true;
    try {
      this.overview = await fetchMarketOverview();
      this.notify();
    } catch {
      this.notify();
    } finally {
      this.refreshing = false;
    }
  }

  private scheduleNext(): void {
    const baseInterval = workspace.getConfiguration('take-home').get<number>('refreshInterval', 5000);
    const interval = getEffectiveRefreshInterval(baseInterval);
    this.refreshTimer = setTimeout(() => {
      void this.refresh().then(() => this.scheduleNext());
    }, interval);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.overview);
    }
  }
}
