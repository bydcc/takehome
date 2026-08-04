import { Disposable, env, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import {
  formatAmount,
  formatPercent,
  formatPrice,
  formatPriceWithPercent,
  formatStockLabel,
  getMarketLabel,
} from '../api/stockApi';
import { formatSealLots } from '../api/limitBoard';
import { fetchIntraday, supportsIntraday } from '../api/intradayApi';
import {
  fetchKline,
  KlinePeriod,
  supportsKline,
} from '../api/klineApi';
import { getStockDetailUrl } from '../api/stockLinks';
import { analyzePatterns } from '../analysis/patternRecognition';
import { StockQuote } from '../models/types';
import { QuoteScheduler } from '../service/quoteScheduler';
import { StockStorage } from '../storage/stockStorage';

/** K 线分析用的 bar 数量（更长窗口利于形态识别） */
const KLINE_BARS_FOR_CHART = 150;

export type ChartPeriod = 'intraday' | KlinePeriod;

interface DetailContext {
  code: string;
  name: string;
  secid?: string;
  note?: string;
  alertAbove?: number;
  alertBelow?: number;
}

const INTRADAY_REFRESH_MS = 60000;

type DefaultChartPeriodSetting = 'intraday' | 'daily' | 'weekly';

function getPreferredChartPeriodSetting(): DefaultChartPeriodSetting {
  const value = workspace
    .getConfiguration('take-home')
    .get<string>('detail.defaultChartPeriod', 'intraday');
  if (value === 'daily' || value === 'weekly') {
    return value;
  }
  return 'intraday';
}

/** 按用户配置解析默认图表；不支持时降级为分时 → 日 K */
function resolveChartPeriod(
  code: string,
  secid: string | undefined,
  preferred: DefaultChartPeriodSetting
): ChartPeriod {
  const hasIntraday = supportsIntraday(code, secid);
  const hasKline = supportsKline(code, secid);

  if (preferred === 'intraday' && hasIntraday) {
    return 'intraday';
  }
  if (preferred === 'weekly' && hasKline) {
    return 'weekly';
  }
  if (preferred === 'daily' && hasKline) {
    return 'daily';
  }

  if (hasIntraday) {
    return 'intraday';
  }
  if (hasKline) {
    return 'daily';
  }
  return 'daily';
}

function defaultChartPeriod(code: string, secid?: string): ChartPeriod {
  return resolveChartPeriod(code, secid, getPreferredChartPeriodSetting());
}

function normalizeActivePeriod(
  activePeriod: ChartPeriod,
  hasIntraday: boolean,
  hasKline: boolean
): ChartPeriod {
  if (activePeriod === 'intraday') {
    return hasIntraday ? 'intraday' : hasKline ? 'daily' : 'daily';
  }
  if (activePeriod === 'weekly') {
    return hasKline ? 'weekly' : hasIntraday ? 'intraday' : 'daily';
  }
  return hasKline ? 'daily' : hasIntraday ? 'intraday' : 'daily';
}

function buildDetailContext(
  code: string,
  name: string,
  stockMeta?: { secid?: string; note?: string; alertAbove?: number; alertBelow?: number }
): DetailContext {
  return {
    code,
    name,
    secid: stockMeta?.secid,
    note: stockMeta?.note,
    alertAbove: stockMeta?.alertAbove,
    alertBelow: stockMeta?.alertBelow,
  };
}

/** 详情页：头部复用行情缓存；图表按需拉取 */
export class StockDetailPanel implements Disposable {
  private static current: StockDetailPanel | undefined;
  private panel: WebviewPanel;
  private context: DetailContext;
  private quoteSub: Disposable | undefined;
  private chartPeriod: ChartPeriod;
  private chartRequestId = 0;
  private shellLoaded = false;
  private intradayTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    panel: WebviewPanel,
    context: DetailContext,
    private quoteScheduler: QuoteScheduler
  ) {
    this.chartPeriod = defaultChartPeriod(context.code, context.secid);
    this.panel = panel;
    this.context = context;
    this.panel.onDidDispose(() => this.dispose(), null, []);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        void this.quoteScheduler.refresh();
        this.postQuoteUpdate();
        this.postChartRedraw();
        if (this.chartPeriod === 'intraday') {
          void this.loadChart();
        }
      }
      this.syncIntradayTimer(e.webviewPanel.visible);
    });
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'openBrowser') {
        const url = getStockDetailUrl(this.context.code);
        if (url) {
          void env.openExternal(Uri.parse(url));
        }
      }
      if (
        msg?.type === 'switchPeriod' &&
        (msg.period === 'intraday' || msg.period === 'daily' || msg.period === 'weekly')
      ) {
        this.chartPeriod = msg.period;
        this.syncIntradayTimer(this.panel.visible);
        void this.loadChart();
      }
    });

    this.quoteSub = quoteScheduler.subscribe(() => this.postQuoteUpdate());
    void quoteScheduler.refresh();
    this.loadShell();
  }

  static show(
    quoteScheduler: QuoteScheduler,
    storage: StockStorage,
    code: string,
    name: string,
    groupId?: string
  ): void {
    const normalized = code.toLowerCase();
    const stockMeta = findStockMeta(storage, normalized, groupId);

    if (StockDetailPanel.current) {
      const panel = StockDetailPanel.current;
      const sameStock = panel.context.code === normalized;
      panel.panel.reveal(ViewColumn.One);
      panel.context = buildDetailContext(normalized, name, stockMeta);
      panel.panel.title = name;
      void quoteScheduler.refresh();
      if (sameStock) {
        panel.context = buildDetailContext(normalized, name, stockMeta);
        panel.postQuoteUpdate();
        return;
      }
      panel.chartPeriod = defaultChartPeriod(normalized, stockMeta?.secid);
      panel.loadShell();
      return;
    }

    const webviewPanel = window.createWebviewPanel(
      'takeHomeStockDetail',
      name,
      ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    StockDetailPanel.current = new StockDetailPanel(
      webviewPanel,
      buildDetailContext(normalized, name, stockMeta),
      quoteScheduler
    );
  }

  dispose(): void {
    this.stopIntradayTimer();
    this.quoteSub?.dispose();
    if (StockDetailPanel.current === this) {
      StockDetailPanel.current = undefined;
    }
  }

  private loadShell(): void {
    this.shellLoaded = true;
    this.chartRequestId++;
    this.panel.title = this.context.name;
    this.panel.webview.html = buildShellHtml(this.context, this.chartPeriod);
    this.postQuoteUpdate();
    this.syncIntradayTimer(this.panel.visible);
    void this.loadChart();
  }

  private postQuoteUpdate(): void {
    if (!this.shellLoaded) {
      return;
    }
    const quote = this.quoteScheduler.getQuote(this.context.code);
    void this.panel.webview.postMessage({
      type: 'quote',
      payload: serializeQuote(this.context, quote),
      riseColor: workspace.getConfiguration('take-home').get<string>('riseColor', '#f14c4c'),
      fallColor: workspace.getConfiguration('take-home').get<string>('fallColor', '#73c991'),
    });
  }

  /** 面板重新可见时通知 webview 重绘 canvas，避免失焦后文字叠影 */
  private postChartRedraw(): void {
    if (!this.shellLoaded) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'chartRedraw' });
  }

  private syncIntradayTimer(visible: boolean): void {
    this.stopIntradayTimer();
    if (
      !visible ||
      this.chartPeriod !== 'intraday' ||
      !supportsIntraday(this.context.code, this.context.secid)
    ) {
      return;
    }
    this.intradayTimer = setInterval(() => {
      if (this.panel.visible && this.chartPeriod === 'intraday') {
        void this.loadChart();
      }
    }, INTRADAY_REFRESH_MS);
  }

  private stopIntradayTimer(): void {
    if (this.intradayTimer) {
      clearInterval(this.intradayTimer);
      this.intradayTimer = undefined;
    }
  }

  private async loadChart(): Promise<void> {
    if (this.chartPeriod === 'intraday') {
      await this.loadIntraday();
    } else {
      await this.loadKline(this.chartPeriod);
    }
  }

  private async loadIntraday(): Promise<void> {
    const requestId = ++this.chartRequestId;
    const period: ChartPeriod = 'intraday';

    if (!supportsIntraday(this.context.code, this.context.secid)) {
      void this.panel.webview.postMessage({
        type: 'chartStatus',
        period,
        status: 'unsupported',
        message: '该品种暂无分时图，请切换日 K 或使用浏览器查看',
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'chartStatus', period, status: 'loading' });

    try {
      const data = await fetchIntraday(this.context.code, this.context.secid);
      if (requestId !== this.chartRequestId) {
        return;
      }
      if (!data || data.points.length === 0) {
        void this.panel.webview.postMessage({
          type: 'chartStatus',
          period,
          status: 'error',
          message: '暂无分时数据',
        });
        return;
      }
      void this.panel.webview.postMessage({
        type: 'chartIntraday',
        period,
        preClose: data.preClose,
        points: data.points,
        priceDecimals: getPriceDecimals(this.context.code),
        riseColor: workspace.getConfiguration('take-home').get<string>('riseColor', '#f14c4c'),
        fallColor: workspace.getConfiguration('take-home').get<string>('fallColor', '#73c991'),
      });
    } catch {
      if (requestId !== this.chartRequestId) {
        return;
      }
      void this.panel.webview.postMessage({
        type: 'chartStatus',
        period,
        status: 'error',
        message: '分时图加载失败，请稍后重试',
      });
    }
  }

  private async loadKline(period: KlinePeriod): Promise<void> {
    const requestId = ++this.chartRequestId;

    if (!supportsKline(this.context.code, this.context.secid)) {
      void this.panel.webview.postMessage({
        type: 'chartStatus',
        period,
        status: 'unsupported',
        message: '该品种暂无 K 线，请使用浏览器查看完整页面',
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'chartStatus', period, status: 'loading' });

    try {
      const bars = await fetchKline(
        this.context.code,
        period,
        KLINE_BARS_FOR_CHART,
        this.context.secid
      );
      if (requestId !== this.chartRequestId) {
        return;
      }
      if (bars.length === 0) {
        void this.panel.webview.postMessage({
          type: 'chartStatus',
          period,
          status: 'error',
          message: '暂无 K 线数据',
        });
        return;
      }
      let analysis = null;
      try {
        analysis = analyzePatterns(bars, { period });
      } catch (err) {
        console.error('[take-home] pattern analysis failed', err);
        analysis = null;
      }
      void this.panel.webview.postMessage({
        type: 'chartKline',
        period,
        bars,
        analysis: analysis ?? undefined,
        priceDecimals: getPriceDecimals(this.context.code),
        riseColor: workspace.getConfiguration('take-home').get<string>('riseColor', '#f14c4c'),
        fallColor: workspace.getConfiguration('take-home').get<string>('fallColor', '#73c991'),
      });
    } catch {
      if (requestId !== this.chartRequestId) {
        return;
      }
      void this.panel.webview.postMessage({
        type: 'chartStatus',
        period,
        status: 'error',
        message: 'K 线加载失败（已尝试备用数据源）',
      });
    }
  }
}

function getPriceDecimals(code: string): number {
  const c = code.toLowerCase();
  if (c.startsWith('usr_')) {
    return 3;
  }
  if (c.startsWith('hf_si') || c.startsWith('hf_xag')) {
    return 3;
  }
  if (c.startsWith('nf_ag')) {
    return 0;
  }
  return 2;
}

function findStockMeta(storage: StockStorage, code: string, groupId?: string) {
  if (groupId) {
    return storage.findGroup(groupId)?.stocks.find((s) => s.code.toLowerCase() === code);
  }
  return storage.getGroups().flatMap((g) => g.stocks).find((s) => s.code.toLowerCase() === code);
}

function serializeQuote(ctx: DetailContext, quote: StockQuote | undefined) {
  const board = quote?.limitBoard;
  return {
    code: ctx.code,
    name: ctx.name,
    displayName: formatStockLabel(ctx.name, ctx.code),
    marketLabel: getMarketLabel(ctx.code),
    note: ctx.note,
    alertAbove: ctx.alertAbove,
    alertBelow: ctx.alertBelow,
    limitBoard: board
      ? {
          label: board.side === 'up' ? '涨停' : '跌停',
          sealLots: formatSealLots(board.sealLots),
          sealAmount: formatAmount(board.sealAmount),
          boardAmount:
            board.boardAmount && board.boardAmount > 0
              ? formatAmount(board.boardAmount)
              : undefined,
        }
      : undefined,
    quote: quote
      ? {
          price: formatPrice(quote.price, ctx.code),
          percent: formatPercent(quote.percent),
          change: formatPrice(quote.change, ctx.code),
          amount: formatAmount(quote.amount),
          yestclose: formatPrice(quote.yestclose, ctx.code),
          open: formatPriceWithPercent(quote.open, quote.yestclose, ctx.code),
          high: formatPriceWithPercent(quote.high, quote.yestclose, ctx.code),
          low: formatPriceWithPercent(quote.low, quote.yestclose, ctx.code),
          percentRaw: quote.percent,
          hasPrice: quote.price > 0,
        }
      : undefined,
  };
}

function buildShellHtml(ctx: DetailContext, activePeriod: ChartPeriod): string {
  const displayName = formatStockLabel(ctx.name, ctx.code);
  const marketLabel = getMarketLabel(ctx.code);
  const hasBrowser = !!getStockDetailUrl(ctx.code);
  const hasIntraday = supportsIntraday(ctx.code, ctx.secid);
  const hasKline = supportsKline(ctx.code, ctx.secid);
  const hasChart = hasIntraday || hasKline;
  const period = normalizeActivePeriod(activePeriod, hasIntraday, hasKline);

  const tab = (p: ChartPeriod, label: string) =>
    `<button class="tab${period === p ? ' active' : ''}" data-period="${p}">${label}</button>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px 24px 32px; margin: 0; line-height: 1.5; }
    h1 { font-size: 1.35em; margin: 0 0 4px; font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-bottom: 8px; }
    .price { font-size: 1.85em; font-weight: 700; margin: 8px 0 20px; font-variant-numeric: tabular-nums; }
    .price-sub { font-size: 0.55em; margin-left: 8px; font-weight: 500; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px 16px; max-width: 640px; margin-bottom: 24px; }
    .stat-label { color: var(--vscode-descriptionForeground); font-size: 0.82em; }
    .stat-value { font-variant-numeric: tabular-nums; font-size: 0.95em; }
    .stat-value.limit-up { color: #f14c4c; font-weight: 600; }
    .stat-value.limit-down { color: #73c991; font-weight: 600; }
    .chart-section { margin-top: 8px; }
    .chart-header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .chart-title { font-weight: 600; font-size: 0.95em; }
    .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .tab { padding: 4px 12px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); background: transparent; color: var(--vscode-foreground); cursor: pointer; font-family: inherit; font-size: 0.85em; border-radius: 2px; }
    .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .tab:hover:not(.active) { background: var(--vscode-toolbar-hoverBackground); }
    .legend { display: flex; gap: 14px; font-size: 0.78em; color: var(--vscode-descriptionForeground); margin-bottom: 6px; flex-wrap: wrap; }
    .legend i { display: inline-block; width: 18px; height: 2px; vertical-align: middle; margin-right: 4px; }
    .leg-price { background: #5eb8ff; }
    .leg-avg { background: #e6c84b; }
    .leg-pre { border-top: 1px dashed rgba(128,128,128,0.8); height: 0; width: 18px; }
    .leg-auction { background: #ff9f43; border-style: dashed; }
    .leg-sr-s { background: #00c97a; height: 3px; }
    .leg-sr-r { background: #ff5c5c; height: 3px; }
    .leg-trend { background: #14b8a6; height: 3px; }
    .chart-tools { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    .tool-btn {
      padding: 3px 10px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      background: transparent; color: var(--vscode-foreground); cursor: pointer;
      font-family: inherit; font-size: 0.78em; border-radius: 3px;
    }
    .tool-btn.active {
      background: color-mix(in srgb, var(--vscode-button-background) 85%, transparent);
      color: var(--vscode-button-foreground); border-color: transparent;
    }
    .tool-btn:hover:not(.active) { background: var(--vscode-toolbar-hoverBackground); }
    .tool-btn:disabled { opacity: 0.45; cursor: default; }
    .chart-wrap { position: relative; width: 100%; max-width: 900px; height: 320px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 4px; background: var(--vscode-editor-background); }
    canvas { display: block; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
    canvas.is-panning { cursor: grabbing; }
    .chart-tooltip { position: absolute; pointer-events: none; z-index: 10; padding: 8px 10px; font-size: 11px; line-height: 1.55; border-radius: 4px; background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.35)); color: var(--vscode-editorHoverWidget-foreground, #ccc); font-variant-numeric: tabular-nums; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
    .chart-tooltip.hidden { display: none; }
    .tip-ma5 { color: #f0c74a; } .tip-ma10 { color: #f472b6; } .tip-ma20 { color: #22d3ee; }
    .tip-auction { color: #ff9f43; }
    .chart-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-size: 0.9em; pointer-events: none; }
    .chart-status.hidden { display: none; }
    .analysis-panel {
      margin-top: 10px; max-width: 900px; display: none;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 4px; padding: 10px 12px 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
    }
    .analysis-panel.visible { display: block; }
    .analysis-summary {
      font-size: 0.88em; line-height: 1.55; margin-bottom: 8px;
      color: var(--vscode-foreground);
    }
    .regime-bar {
      display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
      font-size: 0.8em; margin-bottom: 10px; padding: 6px 8px;
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      border: 1px solid rgba(128,128,128,0.18);
    }
    .regime-badge {
      font-weight: 600; font-size: 0.85em; padding: 1px 8px; border-radius: 3px;
    }
    .regime-trend { background: rgba(20,184,166,0.18); color: #2dd4bf; }
    .regime-range { background: rgba(167,139,250,0.18); color: #a78bfa; }
    .regime-volatility { background: rgba(251,191,36,0.18); color: #fbbf24; }
    .regime-meta { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .analysis-summary .label {
      color: var(--vscode-descriptionForeground); font-size: 0.82em; margin-right: 6px;
    }
    .analysis-cols {
      display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px;
    }
    @media (max-width: 640px) { .analysis-cols { grid-template-columns: 1fr; } }
    .analysis-block h3 {
      margin: 0 0 6px; font-size: 0.78em; font-weight: 600;
      color: var(--vscode-descriptionForeground); text-transform: none; letter-spacing: 0.02em;
    }
    .analysis-list { list-style: none; margin: 0; padding: 0; font-size: 0.82em; }
    .analysis-list li {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 5px 0; border-top: 1px solid rgba(128,128,128,0.12);
      line-height: 1.45;
    }
    .analysis-list li:first-child { border-top: none; padding-top: 0; }
    .tag {
      flex-shrink: 0; font-size: 0.72em; font-weight: 600; padding: 1px 6px;
      border-radius: 3px; line-height: 1.5; margin-top: 1px;
    }
    .tag-bull { background: rgba(241,76,76,0.18); color: #f14c4c; }
    .tag-bear { background: rgba(115,201,145,0.2); color: #73c991; }
    .tag-neutral { background: rgba(128,128,128,0.18); color: var(--vscode-descriptionForeground); }
    .tag-sr-s { background: rgba(52,211,153,0.15); color: #34d399; }
    .tag-sr-r { background: rgba(248,113,113,0.15); color: #f87171; }
    .tag-sr-p { background: rgba(167,139,250,0.15); color: #a78bfa; }
    .pat-name { font-weight: 600; margin-right: 4px; }
    .pat-conf { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; font-size: 0.9em; }
    .pat-desc { color: var(--vscode-descriptionForeground); display: block; margin-top: 2px; font-size: 0.95em; }
    .empty-hint { color: var(--vscode-descriptionForeground); font-size: 0.82em; }
    .actions { margin-top: 20px; }
    .btn { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; font-family: inherit; font-size: 0.9em; border-radius: 2px; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .hint { margin-top: 16px; font-size: 0.82em; color: var(--vscode-descriptionForeground); max-width: 640px; }
    ${hasChart ? '' : '.tabs, .legend { display: none; }'}
  </style>
</head>
<body>
  <h1 id="title">${escapeHtml(displayName)}</h1>
  <div class="meta" id="meta">${escapeHtml(ctx.code)}${marketLabel ? ` · ${escapeHtml(marketLabel)}` : ''}</div>
  <div class="price" id="price">--</div>
  <div class="grid" id="stats"></div>
  <div class="chart-section">
    <div class="chart-header">
      <span class="chart-title">行情图</span>
      <div class="tabs">
        ${hasIntraday ? tab('intraday', '分时') : ''}
        ${hasKline ? tab('daily', '日 K') + tab('weekly', '周 K') : ''}
      </div>
      <div class="chart-tools" id="chartTools" style="display:${period === 'intraday' || !hasKline ? 'none' : 'flex'}">
        <button class="tool-btn active" id="togglePattern" type="button" title="在 K 线上叠加支撑/阻力、趋势线与图表形态">形态识别</button>
      </div>
    </div>
    <div class="legend" id="legend">
      <span><i class="leg-price"></i>现价</span>
      <span><i class="leg-avg"></i>均价</span>
      <span><i class="leg-pre"></i>昨收</span>
      <span id="legAuction" style="display:none"><i class="leg-auction"></i>盘前竞价</span>
    </div>
    <div class="legend" id="patternLegend" style="display:none">
      <span><i class="leg-sr-s"></i>支撑区</span>
      <span><i class="leg-sr-r"></i>阻力区</span>
      <span><i class="leg-trend"></i>趋势线</span>
      <span>◇ 形态</span>
      <span>△ 弱破 / ▲ 突破 / ◆ 强破</span>
    </div>
    <div class="chart-wrap">
      <canvas id="chart"></canvas>
      <div class="chart-tooltip hidden" id="chartTooltip"></div>
      <div class="chart-status" id="chartStatus">加载…</div>
    </div>
    <div class="analysis-panel" id="analysisPanel">
      <div class="analysis-summary" id="analysisSummary"></div>
      <div class="regime-bar" id="regimeBar" style="display:none"></div>
      <div class="analysis-cols">
        <div class="analysis-block">
          <h3>图表形态</h3>
          <ul class="analysis-list" id="patternList"></ul>
        </div>
        <div class="analysis-block">
          <h3>支撑 / 阻力</h3>
          <ul class="analysis-list" id="srList"></ul>
        </div>
        <div class="analysis-block">
          <h3>趋势线</h3>
          <ul class="analysis-list" id="tlList"></ul>
        </div>
        <div class="analysis-block">
          <h3>突破信号</h3>
          <ul class="analysis-list" id="boList"></ul>
        </div>
      </div>
    </div>
  </div>
  ${hasBrowser ? '<div class="actions"><button class="btn" id="openBrowser">在浏览器中打开完整页面</button></div>' : ''}
  <p class="hint">左键点击自选股可打开详情；现价随行情刷新；分时图含 9:15 起盘前竞价；行情图支持滚轮缩放、拖动平移、双击重置视图；日/周 K 可开启「形态识别」自动标注支撑阻力、趋势线与常见图表形态（基于规则识别，仅供参考）。停留时分时图每 60 秒更新。</p>
  <script>
    ${getChartScript(period)}
  </script>
</body>
</html>`;
}

function getChartScript(activePeriod: ChartPeriod): string {
  return `
    const vscode = acquireVsCodeApi();
    let activePeriod = '${activePeriod}';
    let chartMode = 'none';
    let currentBars = [];
    let currentIntraday = null;
    let currentAnalysis = null;
    let patternEnabled = true;
    let riseColor = '#f14c4c';
    let fallColor = '#73c991';
    let chartState = null;
    let priceDecimals = 2;
    /** 可见区间 [viewStart, viewEnd)，相对全量数据下标，支持小数以便平滑拖动 */
    let viewStart = 0;
    let viewEnd = 0;
    let isPanning = false;
    let panLastX = 0;
    let panMoved = false;
    const MA_COLORS = { ma5: '#f0c74a', ma10: '#f472b6', ma20: '#22d3ee' };
    const AUCTION_COLOR = '#ff9f43';
    const PRICE_COLOR = '#5eb8ff';
    const AVG_COLOR = '#e6c84b';
    const SR_SUPPORT = '#00c97a';
    const SR_RESIST = '#ff5c5c';
    const SR_PIVOT = '#b794f6';
    const TREND_SUPPORT = '#14b8a6';
    const TREND_RESIST = '#f43f5e';
    const PATTERN_MARK = '#fbbf24';
    const NECKLINE_COLOR = '#f59e0b';

    const canvas = document.getElementById('chart');
    const chartTooltip = document.getElementById('chartTooltip');
    const chartWrap = canvas.parentElement;
    const legAuction = document.getElementById('legAuction');
    const chartTools = document.getElementById('chartTools');
    const togglePattern = document.getElementById('togglePattern');
    const patternLegend = document.getElementById('patternLegend');
    const analysisPanel = document.getElementById('analysisPanel');

    canvas.addEventListener('mousemove', onChartHover);
    canvas.addEventListener('mouseleave', hideChartTooltip);
    canvas.addEventListener('wheel', onChartWheel, { passive: false });
    canvas.addEventListener('mousedown', onChartMouseDown);
    canvas.addEventListener('dblclick', onChartDblClick);
    window.addEventListener('mousemove', onChartPanMove);
    window.addEventListener('mouseup', onChartPanEnd);
    window.addEventListener('blur', onChartPanEnd);

    togglePattern.addEventListener('click', () => {
      patternEnabled = !patternEnabled;
      togglePattern.classList.toggle('active', patternEnabled);
      refreshPatternUi();
      redrawChart(null);
    });

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const period = btn.dataset.period;
        if (period === activePeriod) return;
        activePeriod = period;
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
        document.getElementById('legend').style.display = period === 'intraday' ? 'flex' : 'none';
        chartTools.style.display = period === 'intraday' ? 'none' : 'flex';
        if (period === 'intraday') {
          patternLegend.style.display = 'none';
          analysisPanel.classList.remove('visible');
        } else {
          refreshPatternUi();
        }
        resetViewRange(0);
        vscode.postMessage({ type: 'switchPeriod', period });
      });
    });

    document.getElementById('openBrowser')?.addEventListener('click', () => vscode.postMessage({ type: 'openBrowser' }));

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'quote') updateQuote(msg);
      if (msg.type === 'chartKline') updateKline(msg);
      if (msg.type === 'chartIntraday') updateIntraday(msg);
      if (msg.type === 'chartStatus') updateChartStatus(msg);
      if (msg.type === 'chartRedraw') redrawChart(null);
    });

    function onChartLayoutChange() {
      hideChartTooltip();
      redrawChart(null);
    }

    function dataLength() {
      if (chartMode === 'kline') return currentBars.length;
      if (chartMode === 'intraday' && currentIntraday) return currentIntraday.points.length;
      return 0;
    }

    function minViewCount(len) {
      if (chartMode === 'intraday') return Math.min(Math.max(len - 1, 1), 20);
      return Math.min(len, 8);
    }

    function domainEnd(len) {
      // K 线：半开区间 [0, n)；分时：闭区间 [0, n-1] 以对齐旧 slot=cw/(n-1)
      if (chartMode === 'intraday') return Math.max(len > 1 ? len - 1 : len, 0);
      return Math.max(len, 0);
    }

    function resetViewRange(len) {
      viewStart = 0;
      viewEnd = domainEnd(len);
    }

    function clampViewRange(len) {
      const maxEnd = domainEnd(len);
      if (maxEnd <= 0) {
        viewStart = 0;
        viewEnd = 0;
        return;
      }
      let count = viewEnd - viewStart;
      const minC = minViewCount(len);
      if (!Number.isFinite(count) || count <= 0) count = maxEnd;
      count = Math.min(maxEnd, Math.max(minC, count));
      if (viewStart < 0) {
        viewEnd -= viewStart;
        viewStart = 0;
      }
      if (viewEnd > maxEnd) {
        viewStart -= viewEnd - maxEnd;
        viewEnd = maxEnd;
      }
      if (viewStart < 0) viewStart = 0;
      viewEnd = viewStart + count;
      if (viewEnd > maxEnd) {
        viewEnd = maxEnd;
        viewStart = Math.max(0, viewEnd - count);
      }
    }

    function ensureViewRange(len, resetIfNeeded) {
      if (len <= 0) {
        viewStart = 0;
        viewEnd = 0;
        return;
      }
      const maxEnd = domainEnd(len);
      if (
        resetIfNeeded ||
        viewEnd <= viewStart ||
        viewEnd > maxEnd + 0.5 ||
        viewStart < -0.5
      ) {
        resetViewRange(len);
      }
      clampViewRange(len);
    }

    /** 索引 → 画布 x（K 线居中，分时点位对齐） */
    function indexToX(idx, pad, slot, mode) {
      if (mode === 'kline') return pad.left + (idx - viewStart) * slot + slot / 2;
      return pad.left + (idx - viewStart) * slot;
    }

    function onChartWheel(e) {
      if (!chartState) return;
      const len = dataLength();
      if (len < 2) return;
      e.preventDefault();
      e.stopPropagation();
      clampViewRange(len);
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const { pad, w } = chartState;
      const cw = w - pad.left - pad.right;
      if (cw <= 0) return;
      const rel = Math.min(1, Math.max(0, (mx - pad.left) / cw));
      const count = viewEnd - viewStart;
      const pivot = viewStart + rel * count;
      const zoomIn = e.deltaY < 0;
      const factor = zoomIn ? 0.82 : 1.22;
      let newCount = count * factor;
      const minC = minViewCount(len);
      const maxC = domainEnd(len);
      newCount = Math.min(maxC, Math.max(minC, newCount));
      viewStart = pivot - rel * newCount;
      viewEnd = viewStart + newCount;
      clampViewRange(len);
      hideChartTooltip();
      redrawChart(null);
    }

    function onChartMouseDown(e) {
      if (e.button !== 0 || !chartState) return;
      const len = dataLength();
      if (len < 2) return;
      isPanning = true;
      panMoved = false;
      panLastX = e.clientX;
      canvas.classList.add('is-panning');
      e.preventDefault();
    }

    function onChartPanMove(e) {
      if (!isPanning || !chartState) return;
      const len = dataLength();
      if (len < 2) return;
      const dx = e.clientX - panLastX;
      if (Math.abs(dx) > 1) panMoved = true;
      panLastX = e.clientX;
      const { pad, w } = chartState;
      const cw = w - pad.left - pad.right;
      if (cw <= 0) return;
      const count = viewEnd - viewStart;
      const shift = -(dx / cw) * count;
      viewStart += shift;
      viewEnd += shift;
      clampViewRange(len);
      hideChartTooltip();
      redrawChart(null);
    }

    function onChartPanEnd() {
      if (!isPanning) return;
      isPanning = false;
      canvas.classList.remove('is-panning');
    }

    function onChartDblClick(e) {
      if (e.button != null && e.button !== 0) return;
      const len = dataLength();
      if (len < 1) return;
      resetViewRange(len);
      hideChartTooltip();
      redrawChart(null);
    }

    window.addEventListener('resize', onChartLayoutChange);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        requestAnimationFrame(onChartLayoutChange);
      }
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => requestAnimationFrame(onChartLayoutChange)).observe(chartWrap);
    }

    function updateQuote(p) {
      if (p.riseColor) riseColor = p.riseColor;
      if (p.fallColor) fallColor = p.fallColor;
      const data = p.payload || p;
      document.getElementById('title').textContent = data.displayName;
      document.getElementById('meta').textContent = data.code + (data.marketLabel ? ' · ' + data.marketLabel : '');
      const priceEl = document.getElementById('price');
      if (data.quote && data.quote.hasPrice) {
        const color = data.quote.percentRaw > 0 ? riseColor : data.quote.percentRaw < 0 ? fallColor : '';
        priceEl.innerHTML = data.quote.price + '<span class="price-sub">' + data.quote.percent + '</span>';
        priceEl.style.color = color || 'var(--vscode-foreground)';
      } else {
        priceEl.textContent = '--';
        priceEl.style.color = 'var(--vscode-foreground)';
      }
      const stats = [];
      if (data.limitBoard) {
        const cls = data.limitBoard.label === '涨停' ? 'limit-up' : 'limit-down';
        stats.push(['板况', data.limitBoard.label + '封板', cls]);
        stats.push(['封单量', data.limitBoard.sealLots, cls]);
        stats.push(['封单金额', data.limitBoard.sealAmount, cls]);
        if (data.limitBoard.boardAmount) {
          stats.push(['板上成交额', data.limitBoard.boardAmount]);
        }
      }
      if (data.quote && data.quote.hasPrice) {
        stats.push(['涨跌额', data.quote.change], ['成交额', data.quote.amount], ['昨收', data.quote.yestclose]);
        stats.push(['今开', data.quote.open], ['最高', data.quote.high], ['最低', data.quote.low]);
      } else if (!data.limitBoard) stats.push(['现价', '等待行情刷新…']);
      if (data.note) stats.push(['备注', data.note]);
      if (data.alertAbove != null) stats.push(['提醒（上限）', '≥ ' + formatRaw(data.alertAbove, data.code)]);
      if (data.alertBelow != null) stats.push(['提醒（下限）', '≤ ' + formatRaw(data.alertBelow, data.code)]);
      document.getElementById('stats').innerHTML = stats.map((row) => {
        const l = row[0];
        const v = row[1];
        const cls = row[2] ? ' ' + row[2] : '';
        return '<div><div class="stat-label">' + esc(l) + '</div><div class="stat-value' + cls + '">' + esc(v) + '</div></div>';
      }).join('');
    }

    function formatRaw(n, code) { return Number(n).toFixed(code.startsWith('usr_') ? 3 : 2); }

    function updateChartStatus(msg) {
      if (msg.period !== activePeriod) return;
      const el = document.getElementById('chartStatus');
      if (msg.status === 'loading') {
        el.textContent = msg.period === 'intraday' ? '加载分时…' : '加载 K 线…';
        el.classList.remove('hidden');
        return;
      }
      if (msg.status === 'unsupported' || msg.status === 'error') {
        chartMode = 'none'; chartState = null; currentBars = []; currentIntraday = null; currentAnalysis = null;
        resetViewRange(0);
        clearChart(); hideChartTooltip();
        analysisPanel.classList.remove('visible');
        patternLegend.style.display = 'none';
        el.textContent = msg.message || '加载失败';
        el.classList.remove('hidden');
      }
    }

    function updateKline(msg) {
      if (msg.period !== activePeriod) return;
      const prevLen = currentBars.length;
      const prevMax = domainEnd(prevLen);
      const wasFull = prevLen > 0 && viewStart <= 0.5 && viewEnd >= prevMax - 0.5;
      chartMode = 'kline';
      riseColor = msg.riseColor || riseColor;
      fallColor = msg.fallColor || fallColor;
      currentBars = msg.bars || [];
      currentAnalysis = msg.analysis || null;
      currentIntraday = null;
      priceDecimals = msg.priceDecimals != null ? msg.priceDecimals : guessDecimals(currentBars);
      if (wasFull || prevLen === 0) resetViewRange(currentBars.length);
      else clampViewRange(currentBars.length);
      document.getElementById('chartStatus').classList.add('hidden');
      document.getElementById('legend').style.display = 'none';
      chartTools.style.display = 'flex';
      hideChartTooltip();
      refreshPatternUi();
      drawKlineChart(currentBars, riseColor, fallColor);
    }

    function updateIntraday(msg) {
      if (msg.period !== activePeriod) return;
      const prevLen = currentIntraday ? currentIntraday.points.length : 0;
      const prevMax = domainEnd(prevLen);
      const wasFull = prevLen > 0 && viewStart <= 0.5 && viewEnd >= prevMax - 0.5;
      chartMode = 'intraday';
      riseColor = msg.riseColor || riseColor;
      fallColor = msg.fallColor || fallColor;
      priceDecimals = msg.priceDecimals != null ? msg.priceDecimals : 2;
      currentIntraday = { preClose: msg.preClose, points: msg.points || [] };
      currentBars = [];
      currentAnalysis = null;
      if (wasFull || prevLen === 0) resetViewRange(currentIntraday.points.length);
      else clampViewRange(currentIntraday.points.length);
      document.getElementById('chartStatus').classList.add('hidden');
      document.getElementById('legend').style.display = 'flex';
      chartTools.style.display = 'none';
      patternLegend.style.display = 'none';
      analysisPanel.classList.remove('visible');
      const hasAuction = currentIntraday.points.some((p) => p.isAuction);
      legAuction.style.display = hasAuction ? 'inline' : 'none';
      hideChartTooltip();
      drawIntradayChart(currentIntraday, riseColor, fallColor);
    }

    function refreshPatternUi() {
      const show = patternEnabled && chartMode === 'kline' && currentAnalysis;
      patternLegend.style.display = show ? 'flex' : 'none';
      if (show) {
        try {
          renderAnalysisPanel(currentAnalysis);
          analysisPanel.classList.add('visible');
        } catch (e) {
          console.error('renderAnalysisPanel', e);
          analysisPanel.classList.remove('visible');
        }
      } else if (chartMode === 'kline') {
        analysisPanel.classList.remove('visible');
      }
    }

    function biasTag(bias) {
      if (bias === 'bullish') return '<span class="tag tag-bull">偏多</span>';
      if (bias === 'bearish') return '<span class="tag tag-bear">偏空</span>';
      return '<span class="tag tag-neutral">中性</span>';
    }

    function statusTag(status) {
      if (status === 'confirmed') return '<span class="tag tag-bull">已确认</span>';
      if (status === 'failed') return '<span class="tag tag-neutral">短期失败</span>';
      if (status === 'invalidated') return '<span class="tag tag-bear">结构失效</span>';
      return '<span class="tag tag-neutral">构筑中</span>';
    }

    function phaseTag(phase) {
      if (phase === 'continue') return '<span class="tag tag-bull">回踩延续</span>';
      if (phase === 'retest') return '<span class="tag tag-neutral">回踩中</span>';
      if (phase === 'break') return '<span class="tag tag-neutral">刚突破</span>';
      return '';
    }

    function srTag(type) {
      if (type === 'support') return '<span class="tag tag-sr-s">支撑</span>';
      if (type === 'resistance') return '<span class="tag tag-sr-r">阻力</span>';
      return '<span class="tag tag-sr-p">枢纽</span>';
    }

    function freshnessText(f) {
      if (f === 'recent') return '近期测试';
      if (f === 'mid') return '中期水位';
      return '历史水位';
    }

    function qualityTag(q) {
      if (q === 'strong') return '<span class="tag tag-bull">强突破</span>';
      if (q === 'normal') return '<span class="tag tag-bull">突破</span>';
      if (q === 'false') return '<span class="tag tag-neutral">假突破</span>';
      return '<span class="tag tag-neutral">弱突破</span>';
    }

    function renderAnalysisPanel(a) {
      const sumEl = document.getElementById('analysisSummary');
      sumEl.innerHTML = '<span class="label">形态速览</span>' + esc(a.summary || '—');

      const rb = document.getElementById('regimeBar');
      if (a.regime) {
        const r = a.regime;
        const cls = r.kind === 'trend' ? 'regime-trend' : r.kind === 'volatility' ? 'regime-volatility' : 'regime-range';
        const dirTxt = r.direction === 'up' ? '↑' : r.direction === 'down' ? '↓' : '·';
        const str = r.strength != null ? r.strength : Math.round((r.clarity || 0) * 100);
        const volPct = a.meta && a.meta.volPct != null ? (a.meta.volPct * 100).toFixed(2) + '%' : null;
        rb.style.display = 'flex';
        rb.innerHTML =
          '<span class="regime-badge ' + cls + '">' + esc(r.label || r.kind) + ' ' + dirTxt + '</span>' +
          '<span class="regime-meta">强度 ' + str +
          ' · ADX≈' + (r.adx != null ? r.adx.toFixed(0) : '--') +
          ' · ATR比 ' + (r.atrRatio != null ? r.atrRatio.toFixed(2) : '--') +
          (volPct ? ' · 波动 ' + volPct : '') +
          ' · 清晰度 ' + Math.round((r.clarity || 0) * 100) + '</span>' +
          '<span class="regime-meta">' + esc(r.focus || '') + '</span>';
      } else {
        rb.style.display = 'none';
        rb.innerHTML = '';
      }

      const pats = a.patterns || [];
      document.getElementById('patternList').innerHTML = pats.length
        ? pats.map((p) => {
            const sc = p.score != null ? p.score : p.confidence;
            const bd = p.breakdown;
            let confLine = '结构评分 ' + sc + '（非胜率）';
            if (bd) {
              confLine =
                '结构评分 ' + sc +
                ' = 几何' + bd.geometric +
                '·量' + bd.volume +
                '·位' + bd.location +
                '·态' + bd.lifecycle +
                ' ×' + (bd.regimeFactor != null ? Number(bd.regimeFactor).toFixed(2) : '1.00');
            }
            const reasons = bd && bd.reasons && bd.reasons.length
              ? '<span class="pat-desc">' + esc(bd.reasons.join(' · ')) + '</span>'
              : '';
            return '<li>' + biasTag(p.bias) + statusTag(p.status) +
            '<div><span class="pat-name">' + esc(p.name) + '</span>' +
            '<span class="pat-conf">' + confLine + '</span>' +
            '<span class="pat-desc">' + esc(p.description) + '</span>' +
            reasons +
            '</div></li>';
          }).join('')
        : '<li class="empty-hint">当前市态下未保留明确形态</li>';

      const srs = a.supportResistance || [];
      document.getElementById('srList').innerHTML = srs.length
        ? srs.map((lv) => {
            const dist = lv.distancePct;
            const distTxt = (dist >= 0 ? '+' : '') + dist.toFixed(1) + '%';
            const zone = (lv.lower != null && lv.upper != null)
              ? fmtPrice(lv.lower) + ' – ' + fmtPrice(lv.upper)
              : fmtPrice(lv.price);
            const fresh = freshnessText(lv.freshness);
            const dates = (lv.touchDates || []).slice(0, 3).join('、');
            return '<li>' + srTag(lv.type) +
              '<div><strong>' + zone + '</strong>　' + distTxt +
              '　' + fresh +
              (lv.volumeBoosted ? ' · 放量测试' : '') +
              '<span class="pat-desc">强度 ' + Math.round(lv.strength * 100) +
              ' · 触及 ' + lv.touchCount + ' 次' +
              (lv.lastTouchAge != null ? ' · ' + lv.lastTouchAge + ' 日前' : '') +
              (dates ? '<br>测试: ' + esc(dates) : '') +
              '</span></div></li>';
          }).join('')
        : '<li class="empty-hint">暂无明显价位区域</li>';

      const tls = a.trendLines || [];
      document.getElementById('tlList').innerHTML = tls.length
        ? tls.map((t) =>
            '<li>' +
            (t.type === 'support' ? '<span class="tag tag-sr-s">支撑线</span>' : '<span class="tag tag-sr-r">压力线</span>') +
            '<div>' + (t.broken ? '已突破' : '有效') +
            '　触点 ' + t.touches +
            (t.touches >= 3 ? '（多点确认）' : '') +
            '<span class="pat-desc">' + fmtPrice(t.startPrice) + ' → ' + fmtPrice(t.endPrice) +
            ' · 质量 ' + Math.round((t.strength || 0) * 100) +
            (t.coverage != null ? ' · 覆盖 ' + Math.round(t.coverage * 100) + '%' : '') +
            '</span></div></li>'
          ).join('')
        : '<li class="empty-hint">当前市态下无可靠趋势线</li>';

      const bos = a.breakouts || [];
      document.getElementById('boList').innerHTML = bos.length
        ? bos.map((b) =>
            '<li>' + qualityTag(b.quality) + phaseTag(b.phase) +
            (b.direction === 'up' ? '<span class="tag tag-bull">↑</span>' : '<span class="tag tag-bear">↓</span>') +
            '<div>' + esc(b.description) + '</div></li>'
          ).join('')
        : '<li class="empty-hint">近期无明显突破</li>';
    }

    function guessDecimals(bars) {
      if (!bars.length) return 2;
      const s = bars[bars.length - 1].close;
      return s >= 1000 ? 2 : s < 10 ? 3 : 2;
    }

    function computeMA(bars, period) {
      const result = new Array(bars.length).fill(null);
      let sum = 0;
      for (let i = 0; i < bars.length; i++) {
        sum += bars[i].close;
        if (i >= period) sum -= bars[i - period].close;
        if (i >= period - 1) result[i] = sum / period;
      }
      return result;
    }

    function fmtPrice(n) {
      if (n == null || !Number.isFinite(n)) return '--';
      return n.toFixed(priceDecimals);
    }

    function fmtPctFromPreClose(price, preClose) {
      if (!preClose || preClose <= 0 || price == null || !Number.isFinite(price)) return '--';
      const pct = ((price - preClose) / preClose) * 100;
      return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    }

    function fmtSigned(n) {
      if (n == null || !Number.isFinite(n)) return '--';
      return (n >= 0 ? '+' : '') + n.toFixed(priceDecimals);
    }

    function fmtSignedPct(n) {
      if (n == null || !Number.isFinite(n)) return '--';
      return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function pickIntradayTimeLabels(points) {
      const targets = ['09:15', '09:30', '11:30', '13:00', '15:00'];
      const picked = [];
      for (const t of targets) {
        const idx = points.findIndex((p) => p.time === t);
        if (idx >= 0) picked.push(idx);
      }
      if (picked.length >= 2) return picked;
      return [0, Math.floor(points.length / 2), points.length - 1];
    }

    function pickKlineIndex(mx, pad, slot, len) {
      const rel = mx - pad.left;
      const idx = Math.floor(viewStart + rel / slot);
      return Math.min(len - 1, Math.max(0, idx));
    }

    function pickIntradayIndex(mx, pad, slot, len) {
      const rel = mx - pad.left;
      const idx = Math.round(viewStart + rel / slot);
      return Math.min(len - 1, Math.max(0, idx));
    }

    function klineCrossX(idx, pad, slot) {
      return indexToX(idx, pad, slot, 'kline');
    }

    const VOL_RATIO = 0.24;
    const VOL_GAP = 4;

    function chartLayout(pad, w, h) {
      const plotH = h - pad.top - pad.bottom;
      const volH = Math.max(36, Math.floor(plotH * VOL_RATIO));
      const priceH = plotH - volH - VOL_GAP;
      return {
        cw: w - pad.left - pad.right,
        priceH,
        volH,
        priceBottom: pad.top + priceH,
        volTop: pad.top + priceH + VOL_GAP,
        volBottom: h - pad.bottom,
      };
    }

    function fmtVolume(v) {
      if (v == null || !Number.isFinite(v) || v <= 0) return '--';
      if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
      if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
      return String(Math.round(v));
    }

    function drawVolumeDivider(ctx, pad, layout, w) {
      const y = layout.priceBottom + VOL_GAP / 2;
      ctx.strokeStyle = 'rgba(128,128,128,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    function drawVolumeBars(ctx, items, pad, slot, layout, mode) {
      const maxVol = Math.max(...items.map((it) => it.volume), 1);
      const { volH, volBottom } = layout;
      const barW = mode === 'kline' ? Math.max(2, slot * 0.55) : Math.max(1, slot * 0.7);
      for (let i = 0; i < items.length; i++) {
        const vol = items[i].volume;
        if (vol <= 0) continue;
        const absIdx = items[i].index != null ? items[i].index : i;
        const bh = (vol / maxVol) * volH;
        const cx = indexToX(absIdx, pad, slot, mode);
        const x = cx - barW / 2;
        ctx.fillStyle = items[i].color;
        ctx.fillRect(x, volBottom - bh, barW, Math.max(1, bh));
      }
      ctx.font = '10px sans-serif';
      ctx.fillStyle = 'rgba(128,128,128,0.55)';
      ctx.textAlign = 'left';
      ctx.fillText(fmtVolume(maxVol), 4, layout.volTop + 10);
    }

    function priceFromY(state, py) {
      const { pad, priceH, priceBottom, yMin, yRange } = state;
      const clamped = Math.min(Math.max(py, pad.top), priceBottom);
      const t = (clamped - pad.top) / priceH;
      return yMin + yRange * (1 - t);
    }

    function onChartHover(e) {
      if (!chartState || isPanning) return;
      if (panMoved) {
        panMoved = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { pad, slot, w, h } = chartState;
      if (mx < pad.left || mx > w - pad.right || my < pad.top || my > h - pad.bottom) {
        hideChartTooltip();
        return;
      }
      let idx, crossX;
      if (chartState.mode === 'kline') {
        idx = pickKlineIndex(mx, pad, slot, chartState.len);
        crossX = klineCrossX(idx, pad, slot);
      } else {
        idx = pickIntradayIndex(mx, pad, slot, chartState.len);
        crossX = indexToX(idx, pad, slot, 'intraday');
      }
      redrawChart({ x: crossX, y: my, price: priceFromY(chartState, my) });
      showChartTooltip(idx, crossX, my);
    }

    function showChartTooltip(idx, localX, localY) {
      if (chartState.mode === 'intraday') {
        const p = chartState.points[idx];
        if (!p) return;
        const preClose = chartState.preClose || 0;
        let html = '<div><strong>' + esc(p.time) + '</strong></div>';
        html += '<div>价 ' + fmtPrice(p.price) + ' (' + fmtPctFromPreClose(p.price, preClose) + ')　均 ' + fmtPrice(p.avgPrice) + '</div>';
        if (p.volume > 0) html += '<div>量 ' + fmtVolume(p.volume) + '</div>';
        if (p.isAuction) html += '<div class="tip-auction">盘前竞价</div>';
        chartTooltip.innerHTML = html;
      } else {
        const { bars, ma5, ma10, ma20 } = chartState;
        const b = bars[idx];
        if (!b) return;
        const pl = activePeriod === 'weekly' ? '周' : '日';
        let html =
          '<div><strong>' + esc(b.date) + '</strong></div>' +
          '<div>开 ' + fmtPrice(b.open) + '　高 ' + fmtPrice(b.high) + '</div>' +
          '<div>低 ' + fmtPrice(b.low) + '　收 ' + fmtPrice(b.close) + '</div>' +
          '<div>涨跌 ' + fmtSigned(b.change) + ' (' + fmtSignedPct(b.percent) + ')</div>' +
          '<div class="tip-ma5">' + pl + '5: ' + fmtPrice(ma5[idx]) + '</div>' +
          '<div class="tip-ma10">' + pl + '10: ' + fmtPrice(ma10[idx]) + '</div>' +
          '<div class="tip-ma20">' + pl + '20: ' + fmtPrice(ma20[idx]) + '</div>' +
          (b.volume > 0 ? '<div>量 ' + fmtVolume(b.volume) + '</div>' : '');
        // 悬停靠近 S/R 区域时展示来源
        if (patternEnabled && currentAnalysis && chartState.yMin != null) {
          const hoverPrice = typeof localY === 'number' && chartState.priceH
            ? priceFromY(chartState, localY)
            : b.close;
          const nearLv = (currentAnalysis.supportResistance || []).find((lv) => {
            const lo = lv.lower != null ? lv.lower : lv.price * 0.998;
            const hi = lv.upper != null ? lv.upper : lv.price * 1.002;
            return hoverPrice >= lo && hoverPrice <= hi;
          });
          if (nearLv) {
            const t = nearLv.type === 'support' ? '支撑区' : nearLv.type === 'resistance' ? '阻力区' : '枢纽区';
            html += '<div style="margin-top:4px;border-top:1px solid rgba(128,128,128,0.25);padding-top:4px">' +
              '<strong>' + t + ' ' + fmtPrice(nearLv.lower) + '–' + fmtPrice(nearLv.upper) + '</strong>' +
              '<div>强度 ' + Math.round((nearLv.strength || 0) * 100) +
              ' · 触 ' + nearLv.touchCount +
              (nearLv.lastTouchAge != null ? ' · ' + nearLv.lastTouchAge + ' 日前' : '') + '</div>' +
              (nearLv.volumeBoosted ? '<div>含放量测试</div>' : '') +
              (nearLv.touchDates && nearLv.touchDates.length
                ? '<div>近触: ' + esc(nearLv.touchDates.slice(0, 3).join('、')) + '</div>'
                : '') +
              '</div>';
          }
        }
        chartTooltip.innerHTML = html;
      }
      chartTooltip.classList.remove('hidden');
      const tipW = chartTooltip.offsetWidth || 160;
      const tipH = chartTooltip.offsetHeight || 90;
      let left = localX + 14, top = localY - tipH - 10;
      if (left + tipW > chartWrap.clientWidth - 8) left = localX - tipW - 14;
      if (top < 8) top = localY + 14;
      chartTooltip.style.left = Math.max(8, left) + 'px';
      chartTooltip.style.top = Math.max(8, top) + 'px';
    }

    function hideChartTooltip() {
      chartTooltip.classList.add('hidden');
      if (chartState) redrawChart(null);
    }

    function redrawChart(crosshair) {
      if (chartMode === 'kline' && currentBars.length) drawKlineChart(currentBars, riseColor, fallColor, crosshair);
      if (chartMode === 'intraday' && currentIntraday) drawIntradayChart(currentIntraday, riseColor, fallColor, crosshair);
    }

    function drawCrosshair(ctx, crosshair, state, rise, fall) {
      const { x, y, price } = crosshair;
      const { pad, w, h, preClose, priceBottom } = state;
      ctx.save();
      ctx.strokeStyle = 'rgba(128,128,128,0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      if (y <= priceBottom) {
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (y > priceBottom) {
        ctx.restore();
        return;
      }

      const priceStr = fmtPrice(price);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      const labelW = Math.max(44, ctx.measureText(priceStr).width + 10);
      const labelH = 16;
      const labelY = Math.min(Math.max(y - labelH / 2, pad.top), priceBottom - labelH);
      ctx.fillStyle = 'var(--vscode-editorHoverWidget-background, #252526)';
      ctx.strokeStyle = 'rgba(128,128,128,0.45)';
      ctx.fillRect(2, labelY, labelW, labelH);
      ctx.strokeRect(2, labelY, labelW, labelH);
      ctx.fillStyle = 'var(--vscode-editorHoverWidget-foreground, #ccc)';
      ctx.fillText(priceStr, 6, labelY + 12);

      if (preClose > 0 && state.mode === 'intraday') {
        const pctStr = fmtPctFromPreClose(price, preClose);
        ctx.textAlign = 'right';
        ctx.fillStyle = price > preClose ? rise : price < preClose ? fall : 'rgba(128,128,128,0.75)';
        ctx.fillText(pctStr, w - 4, labelY + 12);
      }
      ctx.restore();
    }
    function clearChart() {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function setupCanvas() {
      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w < 1 || h < 1) return null;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      return { ctx, w, h };
    }

    function drawIntradayChart(data, rise, fall, crosshair) {
      const setup = setupCanvas();
      if (!setup) return;
      const { ctx, w, h } = setup;
      const points = data.points;
      if (!points.length) { chartState = null; return; }

      ensureViewRange(points.length, false);
      const pad = { top: 14, right: 48, bottom: 28, left: 52 };
      const layout = chartLayout(pad, w, h);
      const { cw, priceH, priceBottom } = layout;
      const preClose = data.preClose;
      const i0 = Math.max(0, Math.floor(viewStart));
      const i1 = Math.min(points.length, Math.floor(viewEnd) + 1);
      const viewCount = Math.max(viewEnd - viewStart, 1e-6);
      const slot = cw / viewCount;

      let minP = preClose, maxP = preClose;
      for (let i = i0; i < i1; i++) {
        const p = points[i];
        minP = Math.min(minP, p.price, p.avgPrice);
        maxP = Math.max(maxP, p.price, p.avgPrice);
      }
      if (i0 >= i1) {
        for (const p of points) {
          minP = Math.min(minP, p.price, p.avgPrice);
          maxP = Math.max(maxP, p.price, p.avgPrice);
        }
      }
      const padY = (maxP - minP) * 0.08 || preClose * 0.02 || 1;
      minP -= padY; maxP += padY;
      const range = maxP - minP || 1;
      const y = (pr) => pad.top + priceH - ((pr - minP) / range) * priceH;

      chartState = { mode: 'intraday', points, pad, slot, w, h, len: points.length, yMin: minP, yRange: range, priceH, priceBottom, preClose };

      ctx.font = '11px sans-serif';
      for (let i = 0; i <= 4; i++) {
        const pr = minP + (range * i) / 4;
        const yy = y(pr);
        ctx.fillStyle = 'rgba(128,128,128,0.55)';
        ctx.textAlign = 'left';
        ctx.fillText(pr.toFixed(priceDecimals), 4, yy + 4);
        if (preClose > 0) {
          const pct = ((pr - preClose) / preClose) * 100;
          const pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
          ctx.fillStyle = pct > 0 ? rise : pct < 0 ? fall : 'rgba(128,128,128,0.55)';
          ctx.textAlign = 'right';
          ctx.fillText(pctStr, w - 4, yy + 4);
        }
        ctx.strokeStyle = 'rgba(128,128,128,0.1)';
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
      }
      ctx.textAlign = 'left';

      if (preClose > 0) {
        const yy = y(preClose);
        ctx.strokeStyle = 'rgba(128,128,128,0.65)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(128,128,128,0.75)';
        ctx.fillText('昨收', pad.left + 4, yy - 4);
      }

      ctx.save();
      ctx.beginPath();
      // 含右侧价签栏，仅裁左缘外伸出画的线
      ctx.rect(pad.left, pad.top, w - pad.left - 1, h - pad.top - pad.bottom);
      ctx.clip();

      // 盘前竞价区域浅底色
      const auctionEnd = points.findIndex((p) => !p.isAuction);
      if (auctionEnd > 0) {
        const ax0 = indexToX(0, pad, slot, 'intraday');
        const ax1 = indexToX(auctionEnd, pad, slot, 'intraday');
        ctx.fillStyle = 'rgba(255, 159, 67, 0.06)';
        ctx.fillRect(Math.max(pad.left, ax0), pad.top, Math.max(0, ax1 - Math.max(pad.left, ax0)), priceH);
      }

      // 均价线
      ctx.strokeStyle = AVG_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let avgStarted = false;
      for (let i = i0; i < i1; i++) {
        const x = indexToX(i, pad, slot, 'intraday');
        const yy = y(points[i].avgPrice);
        if (!avgStarted) { ctx.moveTo(x, yy); avgStarted = true; } else ctx.lineTo(x, yy);
      }
      ctx.stroke();

      // 价格线：竞价橙色虚线，盘中统一蓝色实线
      const segStart = Math.max(1, i0);
      for (let i = segStart; i < i1; i++) {
        const a = points[i - 1], b = points[i];
        const isAuctionSeg = a.isAuction && b.isAuction;
        ctx.strokeStyle = isAuctionSeg ? AUCTION_COLOR : PRICE_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(isAuctionSeg ? [3, 2] : []);
        ctx.beginPath();
        ctx.moveTo(indexToX(i - 1, pad, slot, 'intraday'), y(a.price));
        ctx.lineTo(indexToX(i, pad, slot, 'intraday'), y(b.price));
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const volItems = [];
      for (let i = i0; i < i1; i++) {
        const p = points[i];
        const prev = i > 0 ? points[i - 1].price : preClose;
        volItems.push({ index: i, volume: p.volume, color: p.price >= prev ? rise : fall });
      }
      drawVolumeBars(ctx, volItems, pad, slot, layout, 'intraday');
      ctx.restore();

      drawVolumeDivider(ctx, pad, layout, w);

      const labels = pickIntradayTimeLabels(points).filter((i) => i >= viewStart - 1 && i <= viewEnd + 1);
      let labelIdxs = labels;
      if (labelIdxs.length < 2) {
        labelIdxs = [i0, Math.floor((i0 + i1 - 1) / 2), Math.max(i0, i1 - 1)];
      }
      ctx.fillStyle = 'rgba(128,128,128,0.75)';
      ctx.font = '10px sans-serif';
      for (const i of labelIdxs) {
        const p = points[i];
        if (!p) continue;
        const tx = indexToX(i, pad, slot, 'intraday') - 12;
        if (tx < pad.left - 20 || tx > w - pad.right) continue;
        ctx.fillText(p.time, Math.max(pad.left, tx), h - 8);
      }

      if (crosshair) drawCrosshair(ctx, crosshair, chartState, rise, fall);
    }

    function drawKlineChart(bars, rise, fall, crosshair) {
      const setup = setupCanvas();
      if (!setup) return;
      const { ctx, w, h } = setup;
      if (!bars.length) { chartState = null; return; }

      ensureViewRange(bars.length, false);
      const ma5 = computeMA(bars, 5), ma10 = computeMA(bars, 10), ma20 = computeMA(bars, 20);
      // 形态叠加时右侧留价签栏，避免标签压住 K 线
      const pad = {
        top: patternEnabled && currentAnalysis ? 22 : 12,
        right: patternEnabled && currentAnalysis ? 56 : 12,
        bottom: 28,
        left: 52,
      };
      const layout = chartLayout(pad, w, h);
      const { cw, priceH, priceBottom } = layout;
      const i0 = Math.max(0, Math.floor(viewStart));
      const i1 = Math.min(bars.length, Math.ceil(viewEnd));
      const viewCount = Math.max(viewEnd - viewStart, 1e-6);
      const slot = cw / viewCount;
      const bodyW = Math.max(2, slot * 0.55);

      let minL = Infinity, maxH = -Infinity;
      for (let i = i0; i < i1; i++) {
        const b = bars[i];
        minL = Math.min(minL, b.low);
        maxH = Math.max(maxH, b.high);
        if (ma5[i] != null) { minL = Math.min(minL, ma5[i]); maxH = Math.max(maxH, ma5[i]); }
        if (ma10[i] != null) { minL = Math.min(minL, ma10[i]); maxH = Math.max(maxH, ma10[i]); }
        if (ma20[i] != null) { minL = Math.min(minL, ma20[i]); maxH = Math.max(maxH, ma20[i]); }
      }
      if (!Number.isFinite(minL)) {
        for (const b of bars) { minL = Math.min(minL, b.low); maxH = Math.max(maxH, b.high); }
      }
      // 仅把「靠近可见区间」的少数 S/R 纳入量程，避免被远端价位压扁
      if (patternEnabled && currentAnalysis) {
        const mid = (minL + maxH) / 2;
        const span = (maxH - minL) || 1;
        const near = (price) => Math.abs(price - mid) <= span * 0.55;
        for (const lv of pickVisibleSrLevels(currentAnalysis.supportResistance || [], 4)) {
          if (near(lv.price)) { minL = Math.min(minL, lv.price); maxH = Math.max(maxH, lv.price); }
          if (lv.lower != null && near(lv.lower)) minL = Math.min(minL, lv.lower);
          if (lv.upper != null && near(lv.upper)) maxH = Math.max(maxH, lv.upper);
        }
        const topPat = (currentAnalysis.patterns || [])[0];
        if (topPat && topPat.neckline != null && near(topPat.neckline)) {
          minL = Math.min(minL, topPat.neckline);
          maxH = Math.max(maxH, topPat.neckline);
        }
      }
      const padY = (maxH - minL) * 0.06 || 1;
      minL -= padY; maxH += padY;
      const range = maxH - minL || 1;
      const y = (p) => pad.top + priceH - ((p - minL) / range) * priceH;

      chartState = { mode: 'kline', bars, pad, slot, w, h, len: bars.length, ma5, ma10, ma20, yMin: minL, yRange: range, priceH, priceBottom };

      ctx.font = '11px sans-serif';
      for (let i = 0; i <= 4; i++) {
        const p = minL + (range * i) / 4;
        const yy = y(p);
        ctx.fillStyle = 'rgba(128,128,128,0.55)';
        ctx.fillText(p.toFixed(priceDecimals), 4, yy + 4);
        ctx.strokeStyle = 'rgba(128,128,128,0.12)';
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
      }

      ctx.save();
      ctx.beginPath();
      // 含右侧形态价签栏，避免标签被裁掉
      ctx.rect(pad.left, pad.top, w - pad.left - 1, h - pad.top - pad.bottom);
      ctx.clip();

      if (patternEnabled && currentAnalysis) {
        drawPatternOverlays(ctx, currentAnalysis, bars, pad, slot, y, w, priceBottom);
      }

      for (let i = i0; i < i1; i++) {
        const b = bars[i];
        const x = indexToX(i, pad, slot, 'kline');
        const up = b.close >= b.open;
        const color = up ? rise : fall;
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y(b.high)); ctx.lineTo(x, y(b.low)); ctx.stroke();
        const oy = y(b.open), cy = y(b.close);
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, Math.min(oy, cy), bodyW, Math.max(1, Math.abs(cy - oy)));
      }

      drawMALine(ctx, ma5, MA_COLORS.ma5, pad, slot, y, bars.length, 1.2);
      drawMALine(ctx, ma10, MA_COLORS.ma10, pad, slot, y, bars.length, 1.4);
      drawMALine(ctx, ma20, MA_COLORS.ma20, pad, slot, y, bars.length, 1.6);

      if (patternEnabled && currentAnalysis) {
        drawPatternMarkers(ctx, currentAnalysis, bars, pad, slot, y, priceBottom);
      }

      const volItems = [];
      for (let i = i0; i < i1; i++) {
        const b = bars[i];
        volItems.push({ index: i, volume: b.volume, color: b.close >= b.open ? rise : fall });
      }
      drawVolumeBars(ctx, volItems, pad, slot, layout, 'kline');
      ctx.restore();

      drawVolumeDivider(ctx, pad, layout, w);

      const mid = Math.min(bars.length - 1, Math.max(i0, Math.floor((viewStart + viewEnd) / 2)));
      const idxs = [i0, mid, Math.max(i0, i1 - 1)];
      ctx.fillStyle = 'rgba(128,128,128,0.75)'; ctx.font = '10px sans-serif';
      for (const i of idxs) {
        const b = bars[i]; if (!b) continue;
        const tx = indexToX(i, pad, slot, 'kline') - 14;
        if (tx < pad.left - 24 || tx > w - pad.right) continue;
        ctx.fillText(b.date.slice(5), Math.max(pad.left, tx), h - 8);
      }

      if (crosshair) drawCrosshair(ctx, crosshair, chartState, rise, fall);
    }

    function xAt(idx, pad, slot) {
      return indexToX(idx, pad, slot, 'kline');
    }

    /** 取最强的若干条 S/R，并按 Y 间距去重，避免价签叠字 */
    function pickVisibleSrLevels(levels, maxN) {
      const sorted = (levels || []).slice().sort((a, b) => b.strength - a.strength);
      return sorted.slice(0, maxN);
    }

    function strokeContrastLine(ctx, x0, y0, x1, y1, color, width, dash) {
      // 深色描边垫底，亮色实线盖上，深浅主题都清楚
      ctx.save();
      ctx.lineCap = 'round';
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = width + 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    function drawChip(ctx, text, x, y, bg, fg, align) {
      ctx.font = 'bold 10px sans-serif';
      const tw = ctx.measureText(text).width;
      const padX = 5, h = 15;
      const w = tw + padX * 2;
      let left = x;
      if (align === 'right') left = x - w;
      else if (align === 'center') left = x - w / 2;
      const top = y - h / 2;
      ctx.fillStyle = bg;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      // 圆角矩形
      const r = 3;
      ctx.beginPath();
      ctx.moveTo(left + r, top);
      ctx.lineTo(left + w - r, top);
      ctx.quadraticCurveTo(left + w, top, left + w, top + r);
      ctx.lineTo(left + w, top + h - r);
      ctx.quadraticCurveTo(left + w, top + h, left + w - r, top + h);
      ctx.lineTo(left + r, top + h);
      ctx.quadraticCurveTo(left, top + h, left, top + h - r);
      ctx.lineTo(left, top + r);
      ctx.quadraticCurveTo(left, top, left + r, top);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + padX, top + h / 2 + 0.5);
      ctx.textBaseline = 'alphabetic';
    }

    function resolveLabelYs(items, minGap, yMin, yMax) {
      // 竖直避让：间距不够则略微推开，推不动则丢弃较弱项
      const ordered = items.slice().sort((a, b) => a.yy - b.yy);
      const placed = [];
      for (const it of ordered) {
        let yy = Math.min(yMax, Math.max(yMin, it.yy));
        if (placed.length) {
          const prev = placed[placed.length - 1];
          if (yy - prev.yy < minGap) {
            yy = prev.yy + minGap;
            if (yy > yMax) continue;
          }
        }
        placed.push({ ...it, yy });
      }
      return placed;
    }

    function drawPatternOverlays(ctx, analysis, bars, pad, slot, y, w, priceBottom) {
      ctx.save();
      const plotRight = w - pad.right;
      // 视觉优先级：弱 S/R 不画（strength 过低）
      const levels = pickVisibleSrLevels(
        (analysis.supportResistance || []).filter((lv) => (lv.strength || 0) >= 0.2),
        3
      );
      const labelCandidates = [];

      // 三级：先画 S/R 区域（淡色带 + 中心线）
      for (const lv of levels) {
        const yy = y(lv.price);
        if (yy < pad.top - 4 || yy > priceBottom + 4) continue;
        const color = lv.type === 'support' ? SR_SUPPORT : lv.type === 'resistance' ? SR_RESIST : SR_PIVOT;
        const tag = lv.type === 'support' ? 'S' : lv.type === 'resistance' ? 'R' : 'P';
        const alpha = 0.5 + (lv.strength || 0.5) * 0.5;
        const yHi = y(lv.upper != null ? lv.upper : lv.price + (lv.price * 0.002));
        const yLo = y(lv.lower != null ? lv.lower : lv.price - (lv.price * 0.002));
        const top = Math.min(yHi, yLo);
        const bot = Math.max(yHi, yLo);
        // 区域带（加亮，避免「有分析但看不见」）
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.14 + (lv.strength || 0.4) * 0.18;
        ctx.fillRect(pad.left, top, plotRight - pad.left, Math.max(3, bot - top));
        ctx.globalAlpha = alpha;
        strokeContrastLine(ctx, pad.left, yy, plotRight, yy, color, lv.freshness === 'recent' ? 2.2 : 1.7, [7, 4]);
        ctx.globalAlpha = 1;
        const zoneLbl = (lv.lower != null && lv.upper != null && Math.abs(lv.upper - lv.lower) > 1e-6)
          ? tag + ' ' + fmtPrice(lv.price)
          : tag + ' ' + fmtPrice(lv.price);
        labelCandidates.push({
          yy: yy,
          price: lv.price,
          color,
          text: zoneLbl,
          strength: lv.strength,
          alpha,
        });
      }

      // 二级：趋势线
      const lastIdx = bars.length - 1;
      for (const tl of analysis.trendLines || []) {
        if (tl.strength != null && tl.strength < 0.32) continue;
        const slope = (tl.endPrice - tl.startPrice) / Math.max(1, tl.endIndex - tl.startIndex);
        const i0 = tl.startIndex;
        const iAnchor = tl.endIndex;
        const p0 = tl.startPrice;
        const pAnchor = tl.endPrice;
        const color = tl.type === 'support' ? TREND_SUPPORT : TREND_RESIST;
        const alpha = 0.55 + (tl.strength || 0.5) * 0.45;
        ctx.globalAlpha = alpha;
        strokeContrastLine(
          ctx,
          xAt(i0, pad, slot), y(p0),
          xAt(iAnchor, pad, slot), y(pAnchor),
          color, 2.6, []
        );
        const i1 = tl.broken && tl.breakIndex != null ? tl.breakIndex : lastIdx;
        if (i1 > iAnchor) {
          const p1 = tl.startPrice + slope * (i1 - tl.startIndex);
          strokeContrastLine(
            ctx,
            xAt(iAnchor, pad, slot), y(pAnchor),
            xAt(i1, pad, slot), y(p1),
            color,
            tl.broken ? 1.5 : 2.0,
            tl.broken ? [5, 4] : [3, 3]
          );
        }
        ctx.globalAlpha = 1;
      }

      // 一级：主形态
      const topPat = (analysis.patterns || [])[0];
      if (topPat && topPat.neckline != null && Number.isFinite(topPat.neckline)) {
        const yy = y(topPat.neckline);
        if (yy >= pad.top && yy <= priceBottom) {
          const x0 = xAt(topPat.startIndex, pad, slot);
          const x1 = xAt(Math.min(lastIdx, Math.max(topPat.endIndex, topPat.startIndex + 8)), pad, slot);
          strokeContrastLine(ctx, x0, yy, x1, yy, NECKLINE_COLOR, 1.8, [5, 3]);
          const tooClose = labelCandidates.some((c) => Math.abs(c.yy - yy) < 16);
          if (!tooClose) {
            labelCandidates.push({
              yy,
              price: topPat.neckline,
              color: NECKLINE_COLOR,
              text: '颈 ' + fmtPrice(topPat.neckline),
              strength: 0.5,
              alpha: 0.9,
            });
          }
        }
      }

      if (topPat && topPat.keyPoints && topPat.keyPoints.length >= 2) {
        const id = topPat.id || '';
        const isClassic =
          id === 'double-top' || id === 'double-bottom' ||
          id === 'head-shoulders' || id === 'inv-head-shoulders';
        const isTriangle = id.indexOf('triangle') === 0;

        if (isClassic) {
          const pts = topPat.keyPoints.slice().sort((a, b) => a.index - b.index);
          drawPoly(ctx, pts, pad, slot, y, PATTERN_MARK);
        } else if (isTriangle && topPat.keyPoints.length >= 4) {
          const highs = topPat.keyPoints.slice(0, 2).sort((a, b) => a.index - b.index);
          const lows = topPat.keyPoints.slice(2, 4).sort((a, b) => a.index - b.index);
          if (highs.length === 2) {
            strokeContrastLine(
              ctx,
              xAt(highs[0].index, pad, slot), y(highs[0].price),
              xAt(highs[1].index, pad, slot), y(highs[1].price),
              PATTERN_MARK, 1.8, [4, 3]
            );
          }
          if (lows.length === 2) {
            strokeContrastLine(
              ctx,
              xAt(lows[0].index, pad, slot), y(lows[0].price),
              xAt(lows[1].index, pad, slot), y(lows[1].price),
              PATTERN_MARK, 1.8, [4, 3]
            );
          }
        }
      }

      const placed = resolveLabelYs(
        labelCandidates,
        17,
        pad.top + 8,
        priceBottom - 8
      );
      for (const lb of placed) {
        ctx.strokeStyle = lb.color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = (lb.alpha != null ? lb.alpha : 0.85) * 0.9;
        ctx.beginPath();
        ctx.moveTo(plotRight, lb.yy);
        const originY = y(lb.price);
        if (Math.abs(originY - lb.yy) > 1) {
          ctx.lineTo(plotRight + 4, originY);
          ctx.lineTo(plotRight + 8, lb.yy);
        } else {
          ctx.lineTo(plotRight + 8, lb.yy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        drawChip(ctx, lb.text, w - 4, lb.yy, 'rgba(20,20,20,0.78)', lb.color, 'right');
      }

      ctx.restore();
    }

    function drawPoly(ctx, pts, pad, slot, y, color) {
      if (!pts || pts.length < 2) return;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      pts.forEach((kp, i) => {
        const xx = xAt(kp.index, pad, slot);
        const yy = y(kp.price);
        if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      });
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      pts.forEach((kp, i) => {
        const xx = xAt(kp.index, pad, slot);
        const yy = y(kp.price);
        if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      });
      ctx.stroke();
      ctx.restore();
    }

    function drawPatternMarkers(ctx, analysis, bars, pad, slot, y, priceBottom) {
      ctx.save();
      const topPat = (analysis.patterns || [])[0];
      if (topPat) {
        // 关键点：仅圆点 + 描边，不写「左肩/右肩」等文字
        const seen = [];
        for (const kp of topPat.keyPoints || []) {
          const xx = xAt(kp.index, pad, slot);
          const yy = y(kp.price);
          // 跳过过近的重复点
          if (seen.some((s) => Math.hypot(s.x - xx, s.y - yy) < 10)) continue;
          seen.push({ x: xx, y: yy });
          ctx.beginPath();
          ctx.arc(xx, yy, 4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(xx, yy, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = PATTERN_MARK;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // 形态名固定左上角：结构评分（非胜率）
        const biasColor =
          topPat.bias === 'bullish' ? SR_RESIST :
          topPat.bias === 'bearish' ? SR_SUPPORT : SR_PIVOT;
        const sc = topPat.score != null ? topPat.score : topPat.confidence;
        const st = topPat.status === 'confirmed' ? '已确认'
          : topPat.status === 'failed' ? '短期失败'
          : topPat.status === 'invalidated' ? '结构失效'
          : '构筑中';
        const name = topPat.name + ' · ' + st + ' · 评分' + sc;
        drawChip(ctx, name, pad.left + 6, pad.top + 10, 'rgba(20,20,20,0.82)', biasColor, 'left');
      }

      // 突破标记：弱△ / 普▲ / 强实心+描边 / 假×
      const breakouts = (analysis.breakouts || []).slice(0, 3);
      for (const bo of breakouts) {
        const xx = xAt(bo.index, pad, slot);
        const b = bars[bo.index];
        if (!b) continue;
        let yy = bo.direction === 'up' ? y(b.high) - 10 : y(b.low) + 10;
        yy = Math.min(priceBottom - 6, Math.max(pad.top + 6, yy));
        const color = bo.quality === 'false'
          ? 'rgba(148,163,184,0.9)'
          : (bo.direction === 'up' ? SR_RESIST : SR_SUPPORT);
        const q = bo.quality || (bo.volumeConfirmed ? 'normal' : 'weak');

        if (q === 'false') {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(xx - 4, yy - 4); ctx.lineTo(xx + 4, yy + 4);
          ctx.moveTo(xx + 4, yy - 4); ctx.lineTo(xx - 4, yy + 4);
          ctx.stroke();
          continue;
        }

        const size = q === 'strong' ? 7 : q === 'normal' ? 6 : 5;
        ctx.beginPath();
        if (bo.direction === 'up') {
          ctx.moveTo(xx, yy - size);
          ctx.lineTo(xx - size, yy + size * 0.65);
          ctx.lineTo(xx + size, yy + size * 0.65);
        } else {
          ctx.moveTo(xx, yy + size);
          ctx.lineTo(xx - size, yy - size * 0.65);
          ctx.lineTo(xx + size, yy - size * 0.65);
        }
        ctx.closePath();
        if (q === 'weak') {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = q === 'strong' ? 1.6 : 1.2;
          ctx.stroke();
        }
        if (bo.retestIndex != null && bars[bo.retestIndex] && q !== 'false') {
          const rx = xAt(bo.retestIndex, pad, slot);
          const rbar = bars[bo.retestIndex];
          let ry = bo.direction === 'up' ? y(rbar.low) + 6 : y(rbar.high) - 6;
          ry = Math.min(priceBottom - 4, Math.max(pad.top + 4, ry));
          ctx.beginPath();
          ctx.arc(rx, ry, 3.2, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          if (bo.phase === 'continue') {
            ctx.fillStyle = color;
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    function drawMALine(ctx, ma, color, pad, slot, y, len, lineWidth) {
      ctx.strokeStyle = color; ctx.lineWidth = lineWidth || 1.2; ctx.beginPath();
      let started = false;
      for (let i = 0; i < len; i++) {
        if (ma[i] == null) continue;
        const x = indexToX(i, pad, slot, 'kline');
        const yy = y(ma[i]);
        if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    document.getElementById('legend').style.display = activePeriod === 'intraday' ? 'flex' : 'none';
    chartTools.style.display = activePeriod === 'intraday' ? 'none' : 'flex';
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showStockDetailByCode(
  quoteScheduler: QuoteScheduler,
  storage: StockStorage,
  code: string,
  name: string,
  groupId?: string
): void {
  StockDetailPanel.show(quoteScheduler, storage, code, name, groupId);
}
