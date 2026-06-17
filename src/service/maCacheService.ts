import { Disposable, ExtensionContext, workspace } from 'vscode';
import { fetchLatestMA, supportsKline } from '../api/klineApi';
import { getBeijingDateString } from '../utils/marketHours';

const STORAGE_KEY = 'take-home.maCache';
const DEFAULT_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

export interface MaSnapshot {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  /** 计算时的北京时间日期 YYYY-MM-DD */
  date: string;
  updatedAt: number;
}

interface PersistedMaCache {
  version: 1;
  entries: Record<string, MaSnapshot>;
}

/** 仅悬停 tooltip 时按需拉 MA，不做后台轮询，避免与现价抢网络 */
export class MaCacheService implements Disposable {
  private cache = new Map<string, MaSnapshot>();
  private fetching = new Set<string>();
  private retryAfter = new Map<string, number>();
  private failureCounts = new Map<string, number>();
  private persistDebounce: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private context: ExtensionContext,
    private onUpdated: (code?: string) => void
  ) {
    this.loadFromDisk();
  }

  dispose(): void {
    if (this.persistDebounce) {
      clearTimeout(this.persistDebounce);
      void this.flushToDisk();
    }
    this.cache.clear();
    this.fetching.clear();
    this.retryAfter.clear();
    this.failureCounts.clear();
  }

  isEnabled(): boolean {
    return workspace.getConfiguration('take-home').get<boolean>('tooltip.maEnabled', true);
  }

  get(code: string): MaSnapshot | undefined {
    const snap = this.cache.get(code.toLowerCase());
    if (snap && this.isValidForToday(snap)) {
      return snap;
    }
    return undefined;
  }

  /** 兼容旧调用，不再后台排队 */
  start(): void {}

  stop(): void {}

  syncCodes(_codes: string[]): void {}

  /** 悬停 tooltip 时触发，仅缺失且当日未缓存时才请求 */
  ensure(code: string): void {
    const normalized = code.toLowerCase();
    if (!this.isEnabled() || !supportsKline(normalized)) {
      return;
    }
    if (this.isValidForToday(this.cache.get(normalized))) {
      return;
    }
    if (this.isInBackoff(normalized) || this.fetching.has(normalized)) {
      return;
    }
    this.fetching.add(normalized);
    void this.fetchOne(normalized);
  }

  prioritize(code: string): void {
    this.ensure(code);
  }

  invalidate(code: string): void {
    const normalized = code.toLowerCase();
    this.cache.delete(normalized);
    this.retryAfter.delete(normalized);
    this.failureCounts.delete(normalized);
    void this.schedulePersist();
  }

  private loadFromDisk(): void {
    const raw = this.context.globalState.get<PersistedMaCache>(STORAGE_KEY);
    if (!raw?.entries) {
      return;
    }

    const today = getBeijingDateString();
    for (const [code, snap] of Object.entries(raw.entries)) {
      if (snap.date === today) {
        this.cache.set(code.toLowerCase(), snap);
      }
    }
  }

  private isValidForToday(snap: MaSnapshot | undefined): boolean {
    return !!snap && snap.date === getBeijingDateString();
  }

  private isInBackoff(code: string): boolean {
    const until = this.retryAfter.get(code);
    return until !== undefined && Date.now() < until;
  }

  private markFailure(code: string): void {
    const count = (this.failureCounts.get(code) ?? 0) + 1;
    this.failureCounts.set(code, count);
    const backoff = Math.min(DEFAULT_FAILURE_BACKOFF_MS * count, MAX_FAILURE_BACKOFF_MS);
    this.retryAfter.set(code, Date.now() + backoff);
  }

  private markSuccess(code: string): void {
    this.retryAfter.delete(code);
    this.failureCounts.delete(code);
  }

  private async fetchOne(code: string): Promise<void> {
    try {
      const ma = await fetchLatestMA(code);
      if (ma) {
        const snap: MaSnapshot = {
          ...ma,
          date: getBeijingDateString(),
          updatedAt: Date.now(),
        };
        this.cache.set(code, snap);
        this.markSuccess(code);
        this.schedulePersist();
        this.onUpdated(code);
      } else {
        this.markFailure(code);
      }
    } catch {
      this.markFailure(code);
    } finally {
      this.fetching.delete(code);
    }
  }

  private schedulePersist(): void {
    if (this.persistDebounce) {
      clearTimeout(this.persistDebounce);
    }
    this.persistDebounce = setTimeout(() => {
      this.persistDebounce = undefined;
      void this.flushToDisk();
    }, 500);
  }

  private async flushToDisk(): Promise<void> {
    const today = getBeijingDateString();
    const entries: Record<string, MaSnapshot> = {};
    for (const [code, snap] of this.cache) {
      if (snap.date === today) {
        entries[code] = snap;
      }
    }
    await this.context.globalState.update(STORAGE_KEY, {
      version: 1,
      entries,
    } satisfies PersistedMaCache);
  }
}
