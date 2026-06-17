import { commands, ConfigurationTarget, Disposable, window, workspace } from 'vscode';
import { MarketOverviewScheduler } from '../service/marketOverviewScheduler';
import { MarketOverviewProvider } from '../ui/marketOverviewProvider';

export function registerMarketOverviewCommands(
  marketOverviewProvider: MarketOverviewProvider,
  marketOverviewScheduler: MarketOverviewScheduler
): Disposable[] {
  return [
    commands.registerCommand('take-home.configureMarketOverview', async () => {
      const enabled = marketOverviewProvider.isEnabled();
      const picked = await window.showQuickPick(
        [
          {
            label: enabled ? '$(eye-closed) 关闭市场概览' : '$(eye) 开启市场概览',
            description: enabled ? '隐藏状态栏市场统计' : '显示涨跌家数与成交额',
            action: 'toggle' as const,
          },
          {
            label: '$(refresh) 立即刷新',
            description: '重新拉取市场概览数据',
            action: 'refresh' as const,
          },
        ],
        { placeHolder: `市场概览 — ${enabled ? '已开启' : '已关闭'}` }
      );

      if (!picked) {
        return;
      }

      if (picked.action === 'toggle') {
        const config = workspace.getConfiguration('take-home');
        await config.update('marketOverview.enabled', !enabled, ConfigurationTarget.Global);
        marketOverviewProvider.startAutoRefresh();
        marketOverviewScheduler.startAutoRefresh();
        void window.showInformationMessage(
          enabled ? '已关闭状态栏市场概览' : '已开启状态栏市场概览'
        );
        return;
      }

      await marketOverviewScheduler.refresh();
      void window.showInformationMessage('市场概览已刷新');
    }),
  ];
}
