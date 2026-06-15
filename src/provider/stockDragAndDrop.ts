import {
  CancellationToken,
  DataTransfer,
  DataTransferItem,
  TreeDragAndDropController,
  window,
} from 'vscode';
import { StockTreeItem, StockTreeProvider } from './stockTreeProvider';
import { StockStorage } from '../storage/stockStorage';

const STOCK_MIME = 'application/vnd.take-home.stock';
const GROUP_MIME = 'application/vnd.take-home.group';

interface StockDragPayload {
  code: string;
  fromGroupId: string;
}

interface GroupDragPayload {
  groupId: string;
}

export class StockDragAndDropController implements TreeDragAndDropController<StockTreeItem> {
  readonly dragMimeTypes = [STOCK_MIME, GROUP_MIME];
  readonly dropMimeTypes = [STOCK_MIME, GROUP_MIME];

  constructor(
    private storage: StockStorage,
    private treeProvider: StockTreeProvider
  ) {}

  handleDrag(source: readonly StockTreeItem[], dataTransfer: DataTransfer): void {
    const stockPayloads: StockDragPayload[] = source
      .filter((item) => item.context.type === 'stock' && item.context.groupId && item.context.stock)
      .map((item) => ({
        code: item.context.stock!.code,
        fromGroupId: item.context.groupId!,
      }));

    const groupPayloads: GroupDragPayload[] = source
      .filter((item) => item.context.type === 'group' && item.context.groupId)
      .map((item) => ({ groupId: item.context.groupId! }));

    if (stockPayloads.length > 0) {
      dataTransfer.set(STOCK_MIME, new DataTransferItem(JSON.stringify(stockPayloads)));
    }
    if (groupPayloads.length > 0) {
      dataTransfer.set(GROUP_MIME, new DataTransferItem(JSON.stringify(groupPayloads)));
    }
  }

  async handleDrop(
    target: StockTreeItem | undefined,
    dataTransfer: DataTransfer,
    _token: CancellationToken
  ): Promise<void> {
    let changed = false;

    const groupTransfer = dataTransfer.get(GROUP_MIME);
    if (!target && groupTransfer) {
      try {
        const payloads = JSON.parse(groupTransfer.value) as GroupDragPayload[];
        for (const payload of payloads) {
          if (payload.groupId && (await this.storage.moveGroupToRoot(payload.groupId))) {
            changed = true;
          }
        }
      } catch {
        // ignore
      }
      if (changed) {
        this.treeProvider.refresh();
      }
      return;
    }

    if (!target) {
      return;
    }

    let sortBlockedShown = false;

    const showSortBlocked = () => {
      if (!sortBlockedShown) {
        sortBlockedShown = true;
        void window.showWarningMessage(
          '当前为涨跌幅排序模式，无法在本分组内调整顺序。可拖到其他分组，或先取消排序。'
        );
      }
    };

    const stockTransfer = dataTransfer.get(STOCK_MIME);
    if (stockTransfer) {
      try {
        const payloads = JSON.parse(stockTransfer.value) as StockDragPayload[];
        for (const payload of payloads) {
          if (!payload.code || !payload.fromGroupId) {
            continue;
          }

          if (target.context.type === 'stock' && target.context.groupId && target.context.stock) {
            const result = await this.handleStockDropOnStock(
              payload,
              target.context.groupId,
              target.context.stock.code,
              showSortBlocked
            );
            if (result) {
              changed = true;
            }
          } else if (target.context.type === 'group' && target.context.groupId) {
            const result = await this.handleStockDropOnGroup(
              payload,
              target.context.groupId,
              showSortBlocked
            );
            if (result) {
              changed = true;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (groupTransfer) {
      try {
        const payloads = JSON.parse(groupTransfer.value) as GroupDragPayload[];
        for (const payload of payloads) {
          if (!payload.groupId) {
            continue;
          }

          if (target.context.type === 'group' && target.context.groupId) {
            const result = await this.handleGroupDropOnGroup(payload.groupId, target.context.groupId);
            if (result) {
              changed = true;
            }
          } else if (target.context.type === 'stock' && target.context.groupId) {
            const result = await this.handleGroupDropOnGroup(payload.groupId, target.context.groupId);
            if (result) {
              changed = true;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (changed) {
      this.treeProvider.refresh();
    }
  }

  private isManualSortBlocked(showSortBlocked: () => void): boolean {
    if (this.treeProvider.getSortOrder() === 'none') {
      return false;
    }
    showSortBlocked();
    return true;
  }

  private async handleStockDropOnStock(
    payload: StockDragPayload,
    targetGroupId: string,
    targetCode: string,
    showSortBlocked: () => void
  ): Promise<boolean> {
    if (payload.fromGroupId === targetGroupId) {
      if (this.isManualSortBlocked(showSortBlocked)) {
        return false;
      }
      return this.storage.reorderStockBefore(targetGroupId, payload.code, targetCode);
    }
    return this.storage.moveStock(
      payload.fromGroupId,
      targetGroupId,
      payload.code,
      targetCode
    );
  }

  private async handleStockDropOnGroup(
    payload: StockDragPayload,
    targetGroupId: string,
    showSortBlocked: () => void
  ): Promise<boolean> {
    if (payload.fromGroupId === targetGroupId) {
      if (this.isManualSortBlocked(showSortBlocked)) {
        return false;
      }
      return this.storage.reorderStockToEnd(targetGroupId, payload.code);
    }
    return this.storage.moveStock(payload.fromGroupId, targetGroupId, payload.code);
  }

  private async handleGroupDropOnGroup(
    dragGroupId: string,
    targetGroupId: string
  ): Promise<boolean> {
    if (dragGroupId === targetGroupId) {
      return false;
    }

    const dragParent = this.storage.getGroupParentId(dragGroupId);
    let targetParent = this.storage.getGroupParentId(targetGroupId);

    // 拖到子文件夹上，但拖拽项与目标父级同级 → 移入父级（展开后常只能落到子项上）
    if (targetParent && dragGroupId !== targetParent) {
      const targetGrandParent = this.storage.getGroupParentId(targetParent);
      if ((dragParent ?? undefined) === (targetGrandParent ?? undefined)) {
        targetGroupId = targetParent;
        targetParent = targetGrandParent;
      }
    }

    const targetHasChildGroups = this.storage.getChildGroups(targetGroupId).length > 0;

    // 目标分组已有子文件夹时，视为移入该分组（而非同级排序或提升到顶级）
    if (targetHasChildGroups) {
      return this.storage.moveGroup(dragGroupId, targetGroupId);
    }

    // 嵌套分组拖到顶级分组上 → 提升到最外层并列，而非移入子级
    if (dragParent && !targetParent) {
      return this.storage.promoteGroupToRootBefore(dragGroupId, targetGroupId);
    }

    // 同级分组 → 调整顺序
    if ((dragParent ?? undefined) === (targetParent ?? undefined)) {
      return this.storage.reorderGroupBefore(dragGroupId, targetGroupId);
    }

    // 跨层级 → 移入目标分组
    return this.storage.moveGroup(dragGroupId, targetGroupId);
  }
}
