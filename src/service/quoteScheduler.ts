import { Disposable, workspace } from 'vscode';
import { fetchGlobalInstrumentQuotes, fetchQuotes, isGlobalInstrumentCode } from '../api/stockApi';
import { StockQuote } from '../models/types';
import { logError, logWarn, showLog } from '../utils/log';
import { getEffectiveRefreshInterval } from '../utils/marketHours';

export type QuoteListener = (quotes: ReadonlyMap<string, StockQuote>) => void;

/** 环球品种固定最快 3 秒一轮，不受 A 股休市降频影响 */
const GLOBAL_REFRESH_MS = 3000;

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

/** 合并自选股与状态栏代码，单次批量请求，避免重复拉取 */
export class QuoteScheduler implements Disposable {
  private quotes = new Map<string, StockQuote>();
  private listeners = new Set<QuoteListener>();
  private codeProviders = new Set<() => string[]>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private globalInterval: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private globalRefreshing = false;
  private pendingRefresh = false;
  private pendingGlobalRefresh = false;

  dispose(): void {
    this.stopAutoRefresh();
    this.listeners.clear();
    this.codeProviders.clear();
  }

  registerCodeProvider(provider: () => string[]): Disposable {
    this.codeProviders.add(provider);
    return { dispose: () => this.codeProviders.delete(provider) };
  }

  subscribe(listener: QuoteListener): Disposable {
    this.listeners.add(listener);
    listener(this.quotes);
    return { dispose: () => this.listeners.delete(listener) };
  }

  getQuote(code: string): StockQuote | undefined {
    return this.quotes.get(normalizeCode(code));
  }

  getQuotes(): ReadonlyMap<string, StockQuote> {
    return this.quotes;
  }

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    void this.refreshGlobalQuotes();
    void this.refresh();
    this.scheduleNext();
    this.globalInterval = setInterval(() => {
      void this.refreshGlobalQuotes();
    }, GLOBAL_REFRESH_MS);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.globalInterval) {
      clearInterval(this.globalInterval);
      this.globalInterval = undefined;
    }
  }

  private scheduleNext(): void {
    const baseInterval = workspace.getConfiguration('take-home').get<number>('refreshInterval', 5000);
    const domesticCodes = this.collectDomesticCodes();
    const interval = getEffectiveRefreshInterval(baseInterval, new Date(), domesticCodes);
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
      this.scheduleNext();
    }, interval);
  }

  collectCodes(): string[] {
    const seen = new Set<string>();
    const codes: string[] = [];
    for (const provider of this.codeProviders) {
      for (const code of provider()) {
        const normalized = normalizeCode(code);
        if (!normalized || seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        codes.push(normalized);
      }
    }
    return codes;
  }

  private collectGlobalCodes(): string[] {
    return this.collectCodes().filter(isGlobalInstrumentCode);
  }

  private collectDomesticCodes(): string[] {
    return this.collectCodes().filter((c) => !isGlobalInstrumentCode(c));
  }

  async refreshGlobalQuotes(): Promise<void> {
    if (this.globalRefreshing) {
      this.pendingGlobalRefresh = true;
      return;
    }

    const codes = this.collectGlobalCodes();
    if (codes.length === 0) {
      return;
    }

    this.globalRefreshing = true;
    try {
      const quotes = await fetchGlobalInstrumentQuotes(codes);
      if (quotes.length === 0) {
        logWarn(`环球行情返回为空（${codes.join(', ')}），请检查网络`);
        return;
      }

      const next = new Map(this.quotes);
      for (const q of quotes) {
        next.set(normalizeCode(q.code), q);
      }
      this.quotes = next;
      this.notify();
    } catch (err) {
      logError('环球行情刷新失败', err);
    } finally {
      this.globalRefreshing = false;
      if (this.pendingGlobalRefresh) {
        this.pendingGlobalRefresh = false;
        void this.refreshGlobalQuotes();
      }
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }

    const allCodes = this.collectCodes();
    if (allCodes.length === 0) {
      this.quotes.clear();
      this.notify();
      return;
    }

    const domesticCodes = this.collectDomesticCodes();
    if (domesticCodes.length === 0) {
      return;
    }

    this.refreshing = true;
    try {
      const quotes = await fetchQuotes(domesticCodes);
      if (quotes.length === 0 && domesticCodes.length > 0) {
        logWarn(`A 股/港股行情返回为空（共 ${domesticCodes.length} 只），请检查网络连接`);
        showLog();
        this.notify();
        return;
      }

      const codeSet = new Set(allCodes.map(normalizeCode));
      const next = new Map(this.quotes);
      for (const key of next.keys()) {
        if (!codeSet.has(key)) {
          next.delete(key);
        }
      }
      for (const q of quotes) {
        next.set(normalizeCode(q.code), q);
      }
      this.quotes = next;
      this.notify();
    } catch (err) {
      logError('行情刷新失败', err);
      this.notify();
    } finally {
      this.refreshing = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        void this.refresh();
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.quotes);
    }
  }
}
