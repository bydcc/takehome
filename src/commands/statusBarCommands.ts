import { commands, ConfigurationTarget, Disposable, QuickPickItem, window, workspace } from 'vscode';
import { showStockSearchPicker } from './addStockPicker';
import { StockTreeItem } from '../provider/stockTreeProvider';
import { StatusBarProvider } from '../ui/statusBarProvider';
import { StockStorage } from '../storage/stockStorage';

const MAX_STATUS_BAR_CODES = 5;

function normalizeCode(code: string): string {
  return code.toLowerCase();
}

type StatusBarColorMode = 'color' | 'monochrome';

async function updateStatusBarConfig(
  patch: { enabled?: boolean; codes?: string[]; colorMode?: StatusBarColorMode }
): Promise<void> {
  const config = workspace.getConfiguration('take-home');
  if (patch.enabled !== undefined) {
    await config.update('statusBar.enabled', patch.enabled, ConfigurationTarget.Global);
  }
  if (patch.codes !== undefined) {
    await config.update('statusBar.codes', patch.codes, ConfigurationTarget.Global);
  }
  if (patch.colorMode !== undefined) {
    await config.update('statusBar.colorMode', patch.colorMode, ConfigurationTarget.Global);
  }
}

async function addStatusBarCode(code: string): Promise<void> {
  const normalized = normalizeCode(code);
  const config = workspace.getConfiguration('take-home');
  const current = (config.get<string[]>('statusBar.codes', []) ?? []).map(normalizeCode);
  if (current.includes(normalized)) {
    await updateStatusBarConfig({ enabled: true });
    return;
  }

  const next = [...current, normalized].slice(-MAX_STATUS_BAR_CODES);
  await updateStatusBarConfig({ enabled: true, codes: next });
}

export function registerStatusBarCommands(
  statusBarProvider: StatusBarProvider,
  storage: StockStorage
): Disposable[] {
  return [
    commands.registerCommand('take-home.configureStatusBar', async () => {
      interface ActionItem extends QuickPickItem {
        action: 'search' | 'watchlist' | 'clear' | 'toggle' | 'toggleColorMode';
      }

      const enabled = statusBarProvider.isEnabled();
      const codes = statusBarProvider.getCodes();
      const colorMode = workspace
        .getConfiguration('take-home')
        .get<StatusBarColorMode>('statusBar.colorMode', 'color');
      const statusHint =
        codes.length > 0 ? `当前：${codes.join(', ')}` : '当前：未设置';
      const colorHint = colorMode === 'color' ? '彩色' : '黑白';

      const picked = await window.showQuickPick<ActionItem>(
        [
          { label: '$(search) 搜索添加', description: '如：上证指数、sh000001', action: 'search' },
          { label: '$(list-unordered) 从自选股选择', description: '从已订阅股票中添加', action: 'watchlist' },
          {
            label:
              colorMode === 'color'
                ? '$(symbol-color) 切换为黑白显示'
                : '$(symbol-color) 切换为彩色显示',
            description: `当前：${colorHint}`,
            action: 'toggleColorMode',
          },
          { label: enabled ? '$(eye-closed) 关闭状态栏显示' : '$(eye) 开启状态栏显示', action: 'toggle' },
          { label: '$(clear-all) 清除全部', description: '移除状态栏中的所有股票', action: 'clear' },
        ],
        { placeHolder: `配置状态栏行情 — ${statusHint} · ${colorHint}` }
      );

      if (!picked) {
        return;
      }

      switch (picked.action) {
        case 'search': {
          const selected = await showStockSearchPicker();
          if (!selected) {
            return;
          }
          await addStatusBarCode(selected.code);
          void statusBarProvider.refreshQuotes();
          void window.showInformationMessage(`状态栏已添加 ${selected.name}`);
          break;
        }
        case 'watchlist': {
          const allStocks = storage.getGroups().flatMap((g) => g.stocks);
          const unique = new Map(allStocks.map((s) => [normalizeCode(s.code), s]));
          if (unique.size === 0) {
            void window.showInformationMessage('自选股为空，请先添加股票');
            return;
          }

          interface StockPickItem extends QuickPickItem {
            code: string;
          }

          const selected = await window.showQuickPick<StockPickItem>(
            [...unique.values()].map((s) => ({
              label: s.name,
              description: s.code,
              code: s.code,
            })),
            { placeHolder: '选择要在状态栏显示的股票' }
          );
          if (!selected) {
            return;
          }
          await addStatusBarCode(selected.code);
          void statusBarProvider.refreshQuotes();
          void window.showInformationMessage(`状态栏已添加 ${selected.label}`);
          break;
        }
        case 'toggleColorMode': {
          const next: StatusBarColorMode = colorMode === 'color' ? 'monochrome' : 'color';
          await updateStatusBarConfig({ colorMode: next });
          statusBarProvider.startAutoRefresh();
          void window.showInformationMessage(
            next === 'color' ? '状态栏已切换为彩色显示' : '状态栏已切换为黑白显示'
          );
          break;
        }
        case 'toggle':
          await updateStatusBarConfig({ enabled: !enabled });
          statusBarProvider.startAutoRefresh();
          break;
        case 'clear':
          await updateStatusBarConfig({ codes: [] });
          statusBarProvider.startAutoRefresh();
          void window.showInformationMessage('已清除状态栏行情');
          break;
      }
    }),

    commands.registerCommand('take-home.showInStatusBar', async (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.stock) {
        return;
      }

      const { code, name } = item.context.stock;
      await addStatusBarCode(code);
      statusBarProvider.startAutoRefresh();
      void window.showInformationMessage(`状态栏已显示 ${name}`);
    }),
  ];
}
