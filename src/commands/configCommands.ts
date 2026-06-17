import { commands, Disposable, Uri, window, workspace } from 'vscode';
import { StockTreeProvider } from '../provider/stockTreeProvider';
import { QuoteScheduler } from '../service/quoteScheduler';
import { MaCacheService } from '../service/maCacheService';
import { StockStorage } from '../storage/stockStorage';

function formatExportFilename(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `take-home-stocks-${date}.json`;
}

function getDefaultExportUri(): Uri {
  const folders = workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return Uri.joinPath(folders[0].uri, formatExportFilename());
  }
  return Uri.file(formatExportFilename());
}

export function registerConfigCommands(
  storage: StockStorage,
  treeProvider: StockTreeProvider,
  quoteScheduler: QuoteScheduler,
  maCacheService: MaCacheService
): Disposable[] {
  return [
    commands.registerCommand('take-home.exportConfig', async () => {
      const uri = await window.showSaveDialog({
        defaultUri: getDefaultExportUri(),
        filters: { JSON: ['json'] },
        saveLabel: '导出',
        title: '导出自选股配置',
      });
      if (!uri) {
        return;
      }

      try {
        const payload = storage.buildExportFile();
        const content = JSON.stringify(payload, null, 2);
        await workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

        const { groupCount, stockCount } = storage.getConfigSummary();
        void window.showInformationMessage(
          `已导出 ${groupCount} 个分组、${stockCount} 只股票到 ${uri.fsPath}`
        );
      } catch (e) {
        void window.showErrorMessage(e instanceof Error ? e.message : '导出失败');
      }
    }),

    commands.registerCommand('take-home.importConfig', async () => {
      const uris = await window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        openLabel: '导入',
        title: '导入自选股配置',
      });
      if (!uris || uris.length === 0) {
        return;
      }

      try {
        const raw = await workspace.fs.readFile(uris[0]);
        const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
        const config = StockStorage.parseImportFile(parsed);

        const groupCount = config.groups.length;
        const stockCount = config.groups.reduce((sum, g) => sum + g.stocks.length, 0);
        const current = storage.getConfigSummary();

        const confirm = await window.showWarningMessage(
          `将用导入文件替换当前配置（${current.groupCount} 个分组、${current.stockCount} 只股票 → ${groupCount} 个分组、${stockCount} 只股票）。此操作不可撤销。`,
          { modal: true },
          '导入'
        );
        if (confirm !== '导入') {
          return;
        }

        await storage.replaceConfig(config);
        treeProvider.refresh();
        maCacheService.syncCodes(storage.getAllCodes());
        void quoteScheduler.refresh();
        void window.showInformationMessage(`已导入 ${groupCount} 个分组、${stockCount} 只股票`);
      } catch (e) {
        void window.showErrorMessage(e instanceof Error ? e.message : '导入失败');
      }
    }),
  ];
}
