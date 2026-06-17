import { Disposable, ExtensionContext, window, workspace } from 'vscode';
import { registerConfigCommands } from './commands/configCommands';
import { registerDetailCommands } from './commands/detailCommands';
import { registerMarketOverviewCommands } from './commands/marketOverviewCommands';
import { registerStatusBarCommands } from './commands/statusBarCommands';
import { registerCommands } from './commands/stockCommands';
import { StockDragAndDropController } from './provider/stockDragAndDrop';
import { StockTreeProvider } from './provider/stockTreeProvider';
import { MarketOverviewScheduler } from './service/marketOverviewScheduler';
import { MaCacheService } from './service/maCacheService';
import { PriceAlertService } from './service/priceAlertService';
import { QuoteScheduler } from './service/quoteScheduler';
import { StockStorage } from './storage/stockStorage';
import { MarketOverviewProvider } from './ui/marketOverviewProvider';
import { showStockDetailByCode } from './ui/stockDetailPanel';
import { StatusBarProvider } from './ui/statusBarProvider';

let activationDisposables: Disposable[] = [];

function disposeActivation(): void {
  for (const disposable of activationDisposables) {
    disposable.dispose();
  }
  activationDisposables = [];
}

function restartSchedulers(
  quoteScheduler: QuoteScheduler,
  marketOverviewScheduler: MarketOverviewScheduler
): void {
  quoteScheduler.startAutoRefresh();
  marketOverviewScheduler.startAutoRefresh();
}

export function activate(context: ExtensionContext): void {
  disposeActivation();

  try {
    const storage = new StockStorage(context);
    const quoteScheduler = new QuoteScheduler();
    const marketOverviewScheduler = new MarketOverviewScheduler();
    const priceAlertService = new PriceAlertService((code, name) => {
      showStockDetailByCode(quoteScheduler, storage, code, name);
    });

    let treeProvider!: StockTreeProvider;
    const maCacheService = new MaCacheService(context, (code) => {
      if (code) {
        treeProvider.refreshStockTooltip(code);
      }
    });
    treeProvider = new StockTreeProvider(
      storage,
      context.extensionUri,
      quoteScheduler,
      maCacheService
    );
    const statusBarProvider = new StatusBarProvider(quoteScheduler);
    const marketOverviewProvider = new MarketOverviewProvider(marketOverviewScheduler);

    const dragAndDropController = new StockDragAndDropController(storage, treeProvider);

    const treeView = window.createTreeView('take-home.stocks', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
      dragAndDropController,
    });

    restartSchedulers(quoteScheduler, marketOverviewScheduler);
    statusBarProvider.startAutoRefresh();
    marketOverviewProvider.startAutoRefresh();
    treeProvider.refresh();

    activationDisposables = [
      treeView,
      treeView.onDidChangeVisibility((e) => {
        if (!e.visible) {
          return;
        }
        treeProvider.refresh();
        if (quoteScheduler.collectCodes().length > 0) {
          void quoteScheduler.refresh();
        }
      }),
      treeProvider,
      quoteScheduler,
      marketOverviewScheduler,
      priceAlertService,
      maCacheService,
      statusBarProvider,
      marketOverviewProvider,
      quoteScheduler.subscribe((quotes) => {
        priceAlertService.checkAlerts(storage, quotes);
      }),
      ...registerCommands(storage, treeProvider, quoteScheduler, marketOverviewScheduler, maCacheService),
      ...registerConfigCommands(storage, treeProvider, quoteScheduler, maCacheService),
      ...registerStatusBarCommands(statusBarProvider, storage, quoteScheduler),
      ...registerMarketOverviewCommands(marketOverviewProvider, marketOverviewScheduler),
      ...registerDetailCommands(storage, quoteScheduler, priceAlertService),
      workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('take-home.refreshInterval') ||
          e.affectsConfiguration('take-home.offHoursRefresh')
        ) {
          restartSchedulers(quoteScheduler, marketOverviewScheduler);
        }
        if (
          e.affectsConfiguration('take-home.statusBar') ||
          e.affectsConfiguration('take-home.riseColor') ||
          e.affectsConfiguration('take-home.fallColor')
        ) {
          statusBarProvider.startAutoRefresh();
          void quoteScheduler.refresh();
        }
        if (
          e.affectsConfiguration('take-home.marketOverview') ||
          e.affectsConfiguration('take-home.riseColor') ||
          e.affectsConfiguration('take-home.fallColor')
        ) {
          marketOverviewProvider.startAutoRefresh();
          void marketOverviewScheduler.refresh();
        }
        if (e.affectsConfiguration('take-home.tooltip')) {
          maCacheService.stop();
        }
      }),
      { dispose: () => quoteScheduler.stopAutoRefresh() },
      { dispose: () => marketOverviewScheduler.stopAutoRefresh() },
      { dispose: () => maCacheService.stop() },
    ];
    context.subscriptions.push(...activationDisposables);
  } catch (err) {
    disposeActivation();
    const message = err instanceof Error ? err.message : String(err);
    void window.showErrorMessage(`赚钱离场 扩展激活失败: ${message}`);
    throw err;
  }
}

export function deactivate(): void {
  disposeActivation();
}
