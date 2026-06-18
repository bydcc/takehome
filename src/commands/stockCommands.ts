import { commands, Disposable, QuickPickItem, window } from 'vscode';
import { showStockSearchPicker } from './addStockPicker';
import { StockTreeItem, StockTreeProvider } from '../provider/stockTreeProvider';
import { MarketOverviewScheduler } from '../service/marketOverviewScheduler';
import { MaCacheService } from '../service/maCacheService';
import { QuoteScheduler } from '../service/quoteScheduler';
import { SortOrder } from '../models/types';
import { StockStorage } from '../storage/stockStorage';

export function registerCommands(
  storage: StockStorage,
  treeProvider: StockTreeProvider,
  quoteScheduler: QuoteScheduler,
  marketOverviewScheduler: MarketOverviewScheduler,
  maCacheService: MaCacheService
): Disposable[] {
  return [
    commands.registerCommand('take-home.refresh', async () => {
      await Promise.all([quoteScheduler.refresh(), marketOverviewScheduler.refresh()]);
    }),

    commands.registerCommand('take-home.toggleCollapseAll', () => {
      void commands.executeCommand('workbench.actions.treeView.take-home.stocks.collapseAll');
    }),

    commands.registerCommand('take-home.addStock', async (...commandArgs: unknown[]) => {
      const menuArgs = commandArgs.find(
        (arg): arg is { useDefaultGroup?: boolean } =>
          typeof arg === 'object' && arg !== null && 'useDefaultGroup' in arg
      );
      const item = commandArgs.find(
        (arg): arg is StockTreeItem =>
          typeof arg === 'object' && arg !== null && 'context' in arg && !('useDefaultGroup' in arg)
      );

      const selected = await showStockSearchPicker();
      if (!selected) {
        return;
      }

      const groupId = menuArgs?.useDefaultGroup
        ? storage.getDefaultGroupId()
        : item?.context?.type === 'group' && item.context.groupId
          ? item.context.groupId
          : storage.getDefaultGroupId();

      const result = await storage.addStock(groupId, {
        code: selected.code,
        name: selected.name,
        secid: selected.secid,
      });

      if (result === 'exists') {
        void window.showWarningMessage(`「${selected.name}」已在自选列表中`);
        return;
      }
      if (result === 'group_not_found') {
        void window.showErrorMessage('目标分组不存在，请刷新后重试');
        return;
      }

      treeProvider.refresh();
      maCacheService.prioritize(selected.code);
      void quoteScheduler.refresh();
      void window.showInformationMessage(`已添加 ${selected.name}`);
    }),

    commands.registerCommand('take-home.sort', async () => {
      const current = treeProvider.getSortOrder();
      const options = [
        { label: '涨跌幅降序', description: '从高到低', order: 'desc' as SortOrder },
        { label: '涨跌幅升序', description: '从低到高', order: 'asc' as SortOrder },
        { label: '取消排序', description: '恢复添加顺序', order: 'none' as SortOrder },
      ];

      const picked = await window.showQuickPick(options, {
        placeHolder: `当前：${treeProvider.getSortLabel()}`,
      });

      if (!picked || picked.order === current) {
        return;
      }

      treeProvider.setSortOrder(picked.order);
    }),

    commands.registerCommand('take-home.removeStock', async (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.groupId || !item.context.stock) {
        return;
      }

      const confirm = await window.showWarningMessage(
        `确定移除「${item.context.stock.name}」？`,
        { modal: true },
        '移除'
      );
      if (confirm !== '移除') {
        return;
      }

      const removed = await storage.removeStock(item.context.groupId, item.context.stock.code);
      if (!removed) {
        void window.showErrorMessage('移除失败，请刷新后重试');
        return;
      }

      treeProvider.refresh();
    }),

    commands.registerCommand('take-home.createGroup', async () => {
      const name = await window.showInputBox({
        prompt: '输入分组名称',
        placeHolder: '例如：A股、白酒',
      });
      if (!name?.trim()) {
        return;
      }

      try {
        await storage.createGroup(name.trim());
        treeProvider.refresh();
      } catch (e) {
        void window.showErrorMessage(e instanceof Error ? e.message : '创建分组失败');
      }
    }),

    commands.registerCommand('take-home.createSubGroup', async (item: StockTreeItem) => {
      if (item.context.type !== 'group' || !item.context.groupId) {
        return;
      }

      const parentId = item.context.groupId;
      if (!storage.findGroup(parentId)) {
        void window.showErrorMessage('父分组不存在');
        return;
      }

      const name = await window.showInputBox({
        prompt: '输入子分组名称',
        placeHolder: '例如：白酒、科技',
      });
      if (!name?.trim()) {
        return;
      }

      try {
        await storage.createGroup(name.trim(), parentId);
        treeProvider.refresh();
      } catch (e) {
        void window.showErrorMessage(e instanceof Error ? e.message : '创建子分组失败');
      }
    }),

    commands.registerCommand('take-home.renameGroup', async (item: StockTreeItem) => {
      if (item.context.type !== 'group' || !item.context.groupId) {
        return;
      }

      const group = storage.findGroup(item.context.groupId);
      if (!group) {
        return;
      }

      const name = await window.showInputBox({
        prompt: '输入新的分组名称',
        value: group.name,
      });
      if (!name?.trim()) {
        return;
      }

      if (!storage.findGroup(item.context.groupId)) {
        void window.showErrorMessage('分组不存在，请刷新后重试');
        return;
      }

      await storage.renameGroup(item.context.groupId, name.trim());
      treeProvider.refresh();
    }),

    commands.registerCommand('take-home.deleteGroup', async (item: StockTreeItem) => {
      if (item.context.type !== 'group' || !item.context.groupId) {
        return;
      }

      const group = storage.findGroup(item.context.groupId);
      if (!group) {
        return;
      }

      const stockCount = storage.countStocksInSubtree(item.context.groupId);
      const childCount = storage.getChildGroups(item.context.groupId).length;

      const confirm = await window.showWarningMessage(
        `确定删除分组「${group.name}」？将同时删除 ${childCount} 个子分组和 ${stockCount} 只股票。`,
        { modal: true },
        '删除'
      );
      if (confirm !== '删除') {
        return;
      }

      try {
        await storage.deleteGroup(item.context.groupId);
        treeProvider.refresh();
      } catch (e) {
        window.showErrorMessage(e instanceof Error ? e.message : '删除失败');
      }
    }),

    commands.registerCommand('take-home.moveStock', async (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.groupId || !item.context.stock) {
        return;
      }

      const fromGroupId = item.context.groupId;
      const groups = storage.listGroupsForPicker(fromGroupId);
      if (groups.length === 0) {
        window.showInformationMessage('没有其他分组可移动');
        return;
      }

      interface GroupPickItem extends QuickPickItem {
        groupId: string;
      }

      const selected = await window.showQuickPick<GroupPickItem>(
        groups.map((g) => ({
          label: g.path,
          description: `${g.stockCount} 股`,
          groupId: g.id,
        })),
        { placeHolder: '选择目标分组' }
      );
      if (!selected) {
        return;
      }

      const moved = await storage.moveStock(
        fromGroupId,
        selected.groupId,
        item.context.stock.code
      );

      if (!moved) {
        window.showErrorMessage('移动失败，请重试');
        return;
      }

      treeProvider.refresh();
      window.showInformationMessage(
        `已将「${item.context.stock.name}」移动到「${selected.label}」`
      );
    }),

    commands.registerCommand('take-home.editNote', async (item: StockTreeItem) => {
      if (item.context.type !== 'stock' || !item.context.groupId || !item.context.stock) {
        return;
      }

      const { groupId, stock } = item.context;
      const group = storage.findGroup(groupId);
      const current = group?.stocks.find((s) => s.code === stock.code)?.note ?? stock.note ?? '';

      const note = await window.showInputBox({
        prompt: `为「${stock.name}」添加备注（留空可清除）`,
        placeHolder: '例如：长期持有、目标价150',
        value: current,
      });
      if (note === undefined) {
        return;
      }

      const saved = await storage.setStockNote(groupId, stock.code, note);
      if (!saved) {
        window.showErrorMessage('备注保存失败');
        return;
      }

      treeProvider.refresh();
    }),
  ];
}
