import { Disposable, ExtensionContext, window, workspace } from 'vscode';
import { registerConfigCommands } from './commands/configCommands';
import { registerStatusBarCommands } from './commands/statusBarCommands';
import { registerCommands } from './commands/stockCommands';
import { StockDragAndDropController } from './provider/stockDragAndDrop';
import { StockTreeProvider } from './provider/stockTreeProvider';
import { StockStorage } from './storage/stockStorage';
import { StatusBarProvider } from './ui/statusBarProvider';

let activationDisposables: Disposable[] = [];

function disposeActivation(): void {
  for (const disposable of activationDisposables) {
    disposable.dispose();
  }
  activationDisposables = [];
}

export function activate(context: ExtensionContext): void {
  disposeActivation();

  try {
    const storage = new StockStorage(context);
    const treeProvider = new StockTreeProvider(storage, context.extensionUri);
    const statusBarProvider = new StatusBarProvider();

    const dragAndDropController = new StockDragAndDropController(storage, treeProvider);

    const treeView = window.createTreeView('take-home.stocks', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
      dragAndDropController,
    });

    treeProvider.startAutoRefresh();
    statusBarProvider.startAutoRefresh();

    activationDisposables = [
      treeView,
      statusBarProvider,
      ...registerCommands(storage, treeProvider),
      ...registerConfigCommands(storage, treeProvider),
      ...registerStatusBarCommands(statusBarProvider, storage),
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('take-home.refreshInterval')) {
          treeProvider.startAutoRefresh();
          statusBarProvider.startAutoRefresh();
        }
        if (
          e.affectsConfiguration('take-home.statusBar') ||
          e.affectsConfiguration('take-home.riseColor') ||
          e.affectsConfiguration('take-home.fallColor')
        ) {
          statusBarProvider.startAutoRefresh();
        }
      }),
      { dispose: () => treeProvider.stopAutoRefresh() },
      { dispose: () => statusBarProvider.stopAutoRefresh() },
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
