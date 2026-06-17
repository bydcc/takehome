import { Disposable, env, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import {
  formatAmount,
  formatPercent,
  formatPrice,
  formatPriceWithPercent,
  formatStockLabel,
  getMarketLabel,
} from '../api/stockApi';
import { fetchIntraday, supportsIntraday } from '../api/intradayApi';
import {
  fetchKline,
  KlinePeriod,
  supportsKline,
} from '../api/klineApi';
import { getStockDetailUrl } from '../api/stockLinks';
import { StockQuote } from '../models/types';
import { QuoteScheduler } from '../service/quoteScheduler';
import { StockStorage } from '../storage/stockStorage';

export type ChartPeriod = 'intraday' | KlinePeriod;

interface DetailContext {
  code: string;
  name: string;
  note?: string;
  alertAbove?: number;
  alertBelow?: number;
}

const INTRADAY_REFRESH_MS = 60000;

function defaultChartPeriod(code: string): ChartPeriod {
  if (supportsIntraday(code)) {
    return 'intraday';
  }
  return 'daily';
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
    this.chartPeriod = defaultChartPeriod(context.code);
    this.panel = panel;
    this.context = context;
    this.panel.onDidDispose(() => this.dispose(), null, []);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        void this.quoteScheduler.refresh();
        this.postQuoteUpdate();
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
      panel.context = {
        code: normalized,
        name,
        note: stockMeta?.note,
        alertAbove: stockMeta?.alertAbove,
        alertBelow: stockMeta?.alertBelow,
      };
      panel.panel.title = name;
      void quoteScheduler.refresh();
      if (sameStock) {
        panel.postQuoteUpdate();
        return;
      }
      panel.chartPeriod = defaultChartPeriod(normalized);
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
      {
        code: normalized,
        name,
        note: stockMeta?.note,
        alertAbove: stockMeta?.alertAbove,
        alertBelow: stockMeta?.alertBelow,
      },
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

  private syncIntradayTimer(visible: boolean): void {
    this.stopIntradayTimer();
    if (!visible || this.chartPeriod !== 'intraday' || !supportsIntraday(this.context.code)) {
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

    if (!supportsIntraday(this.context.code)) {
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
      const data = await fetchIntraday(this.context.code);
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

    if (!supportsKline(this.context.code)) {
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
      const bars = await fetchKline(this.context.code, period);
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
      void this.panel.webview.postMessage({
        type: 'chartKline',
        period,
        bars,
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
  return {
    code: ctx.code,
    name: ctx.name,
    displayName: formatStockLabel(ctx.name, ctx.code),
    marketLabel: getMarketLabel(ctx.code),
    note: ctx.note,
    alertAbove: ctx.alertAbove,
    alertBelow: ctx.alertBelow,
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
  const hasIntraday = supportsIntraday(ctx.code);
  const hasKline = supportsKline(ctx.code);
  const hasChart = hasIntraday || hasKline;
  const period = activePeriod === 'intraday' && !hasIntraday ? 'daily' : activePeriod;

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
    .chart-wrap { position: relative; width: 100%; max-width: 900px; height: 320px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 4px; background: var(--vscode-editor-background); }
    canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
    .chart-tooltip { position: absolute; pointer-events: none; z-index: 10; padding: 8px 10px; font-size: 11px; line-height: 1.55; border-radius: 4px; background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.35)); color: var(--vscode-editorHoverWidget-foreground, #ccc); font-variant-numeric: tabular-nums; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
    .chart-tooltip.hidden { display: none; }
    .tip-ma5 { color: #e6c84b; } .tip-ma10 { color: #b87aff; } .tip-ma20 { color: #5eb8ff; }
    .tip-auction { color: #ff9f43; }
    .chart-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-size: 0.9em; pointer-events: none; }
    .chart-status.hidden { display: none; }
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
    </div>
    <div class="legend" id="legend">
      <span><i class="leg-price"></i>现价</span>
      <span><i class="leg-avg"></i>均价</span>
      <span><i class="leg-pre"></i>昨收</span>
      <span id="legAuction" style="display:none"><i class="leg-auction"></i>盘前竞价</span>
    </div>
    <div class="chart-wrap">
      <canvas id="chart"></canvas>
      <div class="chart-tooltip hidden" id="chartTooltip"></div>
      <div class="chart-status" id="chartStatus">加载…</div>
    </div>
  </div>
  ${hasBrowser ? '<div class="actions"><button class="btn" id="openBrowser">在浏览器中打开完整页面</button></div>' : ''}
  <p class="hint">左键点击自选股可打开详情；现价随行情刷新；分时图含 9:15 起盘前竞价，坐标轴显示相对昨收的涨跌幅；停留时分时图每 60 秒更新。</p>
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
    let riseColor = '#f14c4c';
    let fallColor = '#73c991';
    let chartState = null;
    let priceDecimals = 2;
    const MA_COLORS = { ma5: '#e6c84b', ma10: '#b87aff', ma20: '#5eb8ff' };
    const AUCTION_COLOR = '#ff9f43';
    const PRICE_COLOR = '#5eb8ff';
    const AVG_COLOR = '#e6c84b';

    const canvas = document.getElementById('chart');
    const chartTooltip = document.getElementById('chartTooltip');
    const chartWrap = canvas.parentElement;
    const legAuction = document.getElementById('legAuction');

    canvas.addEventListener('mousemove', onChartHover);
    canvas.addEventListener('mouseleave', hideChartTooltip);

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const period = btn.dataset.period;
        if (period === activePeriod) return;
        activePeriod = period;
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
        document.getElementById('legend').style.display = period === 'intraday' ? 'flex' : (period === 'daily' || period === 'weekly' ? 'none' : 'flex');
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
    });

    window.addEventListener('resize', () => {
      if (chartMode === 'kline' && currentBars.length) drawKlineChart(currentBars, riseColor, fallColor);
      if (chartMode === 'intraday' && currentIntraday) drawIntradayChart(currentIntraday, riseColor, fallColor);
      hideChartTooltip();
    });

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
      if (data.quote && data.quote.hasPrice) {
        stats.push(['涨跌额', data.quote.change], ['成交额', data.quote.amount], ['昨收', data.quote.yestclose]);
        stats.push(['今开', data.quote.open], ['最高', data.quote.high], ['最低', data.quote.low]);
      } else stats.push(['现价', '等待行情刷新…']);
      if (data.note) stats.push(['备注', data.note]);
      if (data.alertAbove != null) stats.push(['提醒（上限）', '≥ ' + formatRaw(data.alertAbove, data.code)]);
      if (data.alertBelow != null) stats.push(['提醒（下限）', '≤ ' + formatRaw(data.alertBelow, data.code)]);
      document.getElementById('stats').innerHTML = stats.map(([l,v]) =>
        '<div><div class="stat-label">' + esc(l) + '</div><div class="stat-value">' + esc(v) + '</div></div>').join('');
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
        chartMode = 'none'; chartState = null; currentBars = []; currentIntraday = null;
        clearChart(); hideChartTooltip();
        el.textContent = msg.message || '加载失败';
        el.classList.remove('hidden');
      }
    }

    function updateKline(msg) {
      if (msg.period !== activePeriod) return;
      chartMode = 'kline';
      riseColor = msg.riseColor || riseColor;
      fallColor = msg.fallColor || fallColor;
      currentBars = msg.bars || [];
      currentIntraday = null;
      priceDecimals = msg.priceDecimals != null ? msg.priceDecimals : guessDecimals(currentBars);
      document.getElementById('chartStatus').classList.add('hidden');
      document.getElementById('legend').style.display = 'none';
      hideChartTooltip();
      drawKlineChart(currentBars, riseColor, fallColor);
    }

    function updateIntraday(msg) {
      if (msg.period !== activePeriod) return;
      chartMode = 'intraday';
      riseColor = msg.riseColor || riseColor;
      fallColor = msg.fallColor || fallColor;
      priceDecimals = msg.priceDecimals != null ? msg.priceDecimals : 2;
      currentIntraday = { preClose: msg.preClose, points: msg.points || [] };
      currentBars = [];
      document.getElementById('chartStatus').classList.add('hidden');
      document.getElementById('legend').style.display = 'flex';
      const hasAuction = currentIntraday.points.some((p) => p.isAuction);
      legAuction.style.display = hasAuction ? 'inline' : 'none';
      hideChartTooltip();
      drawIntradayChart(currentIntraday, riseColor, fallColor);
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
      return Math.min(len - 1, Math.max(0, Math.round(rel / slot - 0.5)));
    }

    function pickIntradayIndex(mx, pad, slot, len) {
      const rel = mx - pad.left;
      return Math.min(len - 1, Math.max(0, Math.round(rel / slot)));
    }

    function klineCrossX(idx, pad, slot) {
      return pad.left + idx * slot + slot / 2;
    }

    function priceFromY(state, py) {
      const { pad, ch, yMin, yRange } = state;
      const t = (py - pad.top) / ch;
      return yMin + yRange * (1 - t);
    }

    function onChartHover(e) {
      if (!chartState) return;
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
        crossX = pad.left + idx * slot;
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
        if (p.volume > 0) html += '<div>量 ' + p.volume + '</div>';
        if (p.isAuction) html += '<div class="tip-auction">盘前竞价</div>';
        chartTooltip.innerHTML = html;
      } else {
        const { bars, ma5, ma10, ma20 } = chartState;
        const b = bars[idx];
        if (!b) return;
        const pl = activePeriod === 'weekly' ? '周' : '日';
        chartTooltip.innerHTML =
          '<div><strong>' + esc(b.date) + '</strong></div>' +
          '<div>开 ' + fmtPrice(b.open) + '　高 ' + fmtPrice(b.high) + '</div>' +
          '<div>低 ' + fmtPrice(b.low) + '　收 ' + fmtPrice(b.close) + '</div>' +
          '<div class="tip-ma5">' + pl + '5: ' + fmtPrice(ma5[idx]) + '</div>' +
          '<div class="tip-ma10">' + pl + '10: ' + fmtPrice(ma10[idx]) + '</div>' +
          '<div class="tip-ma20">' + pl + '20: ' + fmtPrice(ma20[idx]) + '</div>';
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
      const { pad, w, h, preClose } = state;
      ctx.save();
      ctx.strokeStyle = 'rgba(128,128,128,0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      const priceStr = fmtPrice(price);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      const labelW = Math.max(44, ctx.measureText(priceStr).width + 10);
      const labelH = 16;
      const labelY = Math.min(Math.max(y - labelH / 2, pad.top), h - pad.bottom - labelH);
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
    function clearChart() { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }

    function setupCanvas() {
      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth, h = wrap.clientHeight;
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
      const { ctx, w, h } = setupCanvas();
      const points = data.points;
      if (!points.length) { chartState = null; return; }

      const pad = { top: 14, right: 48, bottom: 28, left: 52 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;
      const preClose = data.preClose;

      let minP = preClose, maxP = preClose;
      for (const p of points) {
        minP = Math.min(minP, p.price, p.avgPrice);
        maxP = Math.max(maxP, p.price, p.avgPrice);
      }
      const padY = (maxP - minP) * 0.08 || preClose * 0.02 || 1;
      minP -= padY; maxP += padY;
      const range = maxP - minP || 1;
      const y = (pr) => pad.top + ch - ((pr - minP) / range) * ch;
      const slot = cw / Math.max(points.length - 1, 1);

      chartState = { mode: 'intraday', points, pad, slot, w, h, len: points.length, yMin: minP, yRange: range, ch, preClose };

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

      // 盘前竞价区域浅底色
      const auctionEnd = points.findIndex((p) => !p.isAuction);
      if (auctionEnd > 0) {
        ctx.fillStyle = 'rgba(255, 159, 67, 0.06)';
        ctx.fillRect(pad.left, pad.top, auctionEnd * slot, ch);
      }

      // 均价线
      ctx.strokeStyle = AVG_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = pad.left + i * slot;
        const yy = y(p.avgPrice);
        if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      });
      ctx.stroke();

      // 价格线：竞价橙色虚线，盘中统一蓝色实线
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const isAuctionSeg = a.isAuction && b.isAuction;
        ctx.strokeStyle = isAuctionSeg ? AUCTION_COLOR : PRICE_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash(isAuctionSeg ? [3, 2] : []);
        ctx.beginPath();
        ctx.moveTo(pad.left + (i - 1) * slot, y(a.price));
        ctx.lineTo(pad.left + i * slot, y(b.price));
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const labels = pickIntradayTimeLabels(points);
      ctx.fillStyle = 'rgba(128,128,128,0.75)';
      ctx.font = '10px sans-serif';
      for (const i of labels) {
        const p = points[i];
        if (!p) continue;
        const tx = pad.left + i * slot - 12;
        ctx.fillText(p.time, Math.max(pad.left, tx), h - 8);
      }

      if (crosshair) drawCrosshair(ctx, crosshair, chartState, rise, fall);
    }

    function drawKlineChart(bars, rise, fall, crosshair) {
      const { ctx, w, h } = setupCanvas();
      if (!bars.length) { chartState = null; return; }

      const ma5 = computeMA(bars, 5), ma10 = computeMA(bars, 10), ma20 = computeMA(bars, 20);
      const pad = { top: 12, right: 12, bottom: 28, left: 52 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      let minL = Infinity, maxH = -Infinity;
      for (const b of bars) { minL = Math.min(minL, b.low); maxH = Math.max(maxH, b.high); }
      for (const ma of [...ma5, ...ma10, ...ma20]) {
        if (ma != null) { minL = Math.min(minL, ma); maxH = Math.max(maxH, ma); }
      }
      const padY = (maxH - minL) * 0.06 || 1;
      minL -= padY; maxH += padY;
      const range = maxH - minL || 1;
      const y = (p) => pad.top + ch - ((p - minL) / range) * ch;
      const slot = cw / bars.length;
      const bodyW = Math.max(2, slot * 0.55);

      chartState = { mode: 'kline', bars, pad, slot, w, h, len: bars.length, ma5, ma10, ma20, yMin: minL, yRange: range, ch };

      ctx.font = '11px sans-serif';
      for (let i = 0; i <= 4; i++) {
        const p = minL + (range * i) / 4;
        const yy = y(p);
        ctx.fillStyle = 'rgba(128,128,128,0.55)';
        ctx.fillText(p.toFixed(priceDecimals), 4, yy + 4);
        ctx.strokeStyle = 'rgba(128,128,128,0.12)';
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
      }

      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const x = pad.left + i * slot + slot / 2;
        const up = b.close >= b.open;
        const color = up ? rise : fall;
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y(b.high)); ctx.lineTo(x, y(b.low)); ctx.stroke();
        const oy = y(b.open), cy = y(b.close);
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, Math.min(oy, cy), bodyW, Math.max(1, Math.abs(cy - oy)));
      }

      drawMALine(ctx, ma5, MA_COLORS.ma5, pad, slot, y, bars.length);
      drawMALine(ctx, ma10, MA_COLORS.ma10, pad, slot, y, bars.length);
      drawMALine(ctx, ma20, MA_COLORS.ma20, pad, slot, y, bars.length);

      const idxs = [0, Math.floor(bars.length / 2), bars.length - 1];
      ctx.fillStyle = 'rgba(128,128,128,0.75)'; ctx.font = '10px sans-serif';
      for (const i of idxs) {
        const b = bars[i]; if (!b) continue;
        ctx.fillText(b.date.slice(5), pad.left + i * slot + slot / 2 - 14, h - 8);
      }

      if (crosshair) drawCrosshair(ctx, crosshair, chartState, rise, fall);
    }

    function drawMALine(ctx, ma, color, pad, slot, y, len) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
      let started = false;
      for (let i = 0; i < len; i++) {
        if (ma[i] == null) continue;
        const x = pad.left + i * slot + slot / 2;
        const yy = y(ma[i]);
        if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    document.getElementById('legend').style.display = activePeriod === 'intraday' ? 'flex' : 'none';
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
