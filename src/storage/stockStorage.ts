import { ExtensionContext } from 'vscode';
import { TakeHomeExportFile, StockConfig, StockGroup, StockItem } from '../models/types';

const STORAGE_KEY = 'take-home.stockConfig';

const DEFAULT_GROUP: StockGroup = {
  id: 'default',
  name: '默认分组',
  stocks: [],
};

function migrateStockCode(code: string): string {
  const c = code.toLowerCase();
  if (/^(sh|sz|bj|hk|usr_)/.test(c)) {
    return c;
  }
  if (/^6/.test(c)) {
    return `sh${c}`;
  }
  if (/^[03]/.test(c)) {
    return `sz${c}`;
  }
  if (/^[48]/.test(c)) {
    return `bj${c}`;
  }
  return c;
}

export class StockStorage {
  private config: StockConfig;

  constructor(private context: ExtensionContext) {
    const saved = context.globalState.get<StockConfig>(STORAGE_KEY);
    if (saved) {
      this.config = saved;
      this.migrateCodes();
    } else {
      this.config = {
        groups: [{ ...DEFAULT_GROUP, stocks: [] }],
      };
    }
  }

  private migrateCodes(): void {
    for (const group of this.config.groups) {
      for (const stock of group.stocks) {
        stock.code = migrateStockCode(stock.code);
      }
    }
  }

  getGroups(): StockGroup[] {
    return this.config.groups;
  }

  getRootGroups(): StockGroup[] {
    return this.config.groups.filter((g) => !g.parentId);
  }

  getChildGroups(parentId: string): StockGroup[] {
    return this.config.groups.filter((g) => g.parentId === parentId);
  }

  getAllCodes(): string[] {
    return this.config.groups.flatMap((g) => g.stocks.map((s) => s.code));
  }

  getGroupPath(groupId: string): string {
    const parts: string[] = [];
    let current = this.findGroup(groupId);
    while (current) {
      parts.unshift(current.name);
      current = current.parentId ? this.findGroup(current.parentId) : undefined;
    }
    return parts.join(' / ');
  }

  countStocksInSubtree(groupId: string): number {
    let count = this.findGroup(groupId)?.stocks.length ?? 0;
    for (const child of this.getChildGroups(groupId)) {
      count += this.countStocksInSubtree(child.id);
    }
    return count;
  }

  async save(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, this.config);
  }

  async createGroup(name: string, parentId?: string): Promise<StockGroup> {
    if (parentId && !this.findGroup(parentId)) {
      throw new Error('父分组不存在');
    }

    const group: StockGroup = {
      id: `group_${Date.now()}`,
      name,
      parentId,
      stocks: [],
    };
    this.config.groups.push(group);
    await this.save();
    return group;
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    const group = this.findGroup(groupId);
    if (group) {
      group.name = name;
      await this.save();
    }
  }

  async deleteGroup(groupId: string): Promise<void> {
    const group = this.findGroup(groupId);
    if (!group) {
      return;
    }

    if (!group.parentId && this.getRootGroups().length <= 1) {
      throw new Error('至少保留一个顶级分组');
    }

    const idsToDelete = this.collectDescendantIds(groupId);
    this.config.groups = this.config.groups.filter((g) => !idsToDelete.has(g.id));
    await this.save();
  }

  async moveGroup(groupId: string, newParentId?: string): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group) {
      return false;
    }

    if (newParentId === groupId) {
      return false;
    }

    if (newParentId) {
      if (!this.findGroup(newParentId)) {
        return false;
      }
      if (this.isDescendantOf(newParentId, groupId)) {
        return false;
      }
    }

    if ((group.parentId ?? undefined) === (newParentId ?? undefined)) {
      return false;
    }

    group.parentId = newParentId;
    if (!newParentId) {
      delete group.parentId;
    }

    this.insertGroupInSiblingOrder(groupId);
    await this.save();
    return true;
  }

  /** 将嵌套分组提升到顶级（与默认分组并列） */
  async moveGroupToRoot(groupId: string): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group?.parentId) {
      return false;
    }

    delete group.parentId;
    this.insertGroupInSiblingOrder(groupId);
    await this.save();
    return true;
  }

  /** 将嵌套分组提升到顶级，并排在目标顶级分组之前 */
  async promoteGroupToRootBefore(dragGroupId: string, targetRootGroupId: string): Promise<boolean> {
    const dragGroup = this.findGroup(dragGroupId);
    const targetGroup = this.findGroup(targetRootGroupId);
    if (!dragGroup || !targetGroup || targetGroup.parentId) {
      return false;
    }

    delete dragGroup.parentId;
    this.insertGroupInSiblingOrder(dragGroupId, targetRootGroupId);
    await this.save();
    return true;
  }

  async addStock(
    groupId: string,
    stock: StockItem
  ): Promise<'added' | 'exists' | 'group_not_found'> {
    const group = this.findGroup(groupId);
    if (!group) {
      return 'group_not_found';
    }

    const normalizedCode = migrateStockCode(stock.code);
    if (this.isStockExists(normalizedCode)) {
      return 'exists';
    }

    group.stocks.push({ ...stock, code: normalizedCode });
    await this.save();
    return 'added';
  }

  async removeStock(groupId: string, code: string): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group) {
      return false;
    }

    const normalized = migrateStockCode(code);
    const before = group.stocks.length;
    group.stocks = group.stocks.filter((s) => migrateStockCode(s.code) !== normalized);
    if (group.stocks.length === before) {
      return false;
    }

    await this.save();
    return true;
  }

  async setPriceAlert(
    groupId: string,
    code: string,
    alertAbove?: number,
    alertBelow?: number
  ): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group) {
      return false;
    }

    const normalized = migrateStockCode(code);
    const stock = group.stocks.find((s) => migrateStockCode(s.code) === normalized);
    if (!stock) {
      return false;
    }

    if (alertAbove !== undefined) {
      stock.alertAbove = alertAbove;
    } else {
      delete stock.alertAbove;
    }
    if (alertBelow !== undefined) {
      stock.alertBelow = alertBelow;
    } else {
      delete stock.alertBelow;
    }

    await this.save();
    return true;
  }

  async setStockNote(groupId: string, code: string, note: string): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group) {
      return false;
    }

    const normalized = migrateStockCode(code);
    const stock = group.stocks.find((s) => migrateStockCode(s.code) === normalized);
    if (!stock) {
      return false;
    }

    const trimmed = note.trim();
    if (trimmed) {
      stock.note = trimmed;
    } else {
      delete stock.note;
    }
    await this.save();
    return true;
  }

  async moveStock(
    fromGroupId: string,
    toGroupId: string,
    code: string,
    insertBeforeCode?: string
  ): Promise<boolean> {
    const fromGroup = this.findGroup(fromGroupId);
    const toGroup = this.findGroup(toGroupId);
    if (!fromGroup || !toGroup) {
      return false;
    }

    const normalized = migrateStockCode(code);
    const stock = fromGroup.stocks.find((s) => migrateStockCode(s.code) === normalized);
    if (!stock) {
      return false;
    }

    if (fromGroupId !== toGroupId && toGroup.stocks.some((s) => migrateStockCode(s.code) === normalized)) {
      return false;
    }

    fromGroup.stocks = fromGroup.stocks.filter((s) => migrateStockCode(s.code) !== normalized);

    if (insertBeforeCode) {
      const beforeIdx = toGroup.stocks.findIndex(
        (s) => migrateStockCode(s.code) === migrateStockCode(insertBeforeCode)
      );
      if (beforeIdx >= 0) {
        toGroup.stocks.splice(beforeIdx, 0, stock);
      } else {
        toGroup.stocks.push(stock);
      }
    } else {
      toGroup.stocks.push(stock);
    }

    await this.save();
    return true;
  }

  async reorderStockBefore(groupId: string, dragCode: string, targetCode: string): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group) {
      return false;
    }

    const dragNorm = migrateStockCode(dragCode);
    const targetNorm = migrateStockCode(targetCode);
    const dragIdx = group.stocks.findIndex((s) => migrateStockCode(s.code) === dragNorm);
    const targetIdx = group.stocks.findIndex((s) => migrateStockCode(s.code) === targetNorm);
    if (dragIdx === -1 || targetIdx === -1 || dragIdx === targetIdx) {
      return false;
    }

    const [removed] = group.stocks.splice(dragIdx, 1);
    const newTargetIdx = group.stocks.findIndex((s) => migrateStockCode(s.code) === targetNorm);
    group.stocks.splice(newTargetIdx, 0, removed);
    await this.save();
    return true;
  }

  async reorderStockToEnd(groupId: string, dragCode: string): Promise<boolean> {
    const group = this.findGroup(groupId);
    if (!group) {
      return false;
    }

    const dragNorm = migrateStockCode(dragCode);
    const dragIdx = group.stocks.findIndex((s) => migrateStockCode(s.code) === dragNorm);
    if (dragIdx === -1 || dragIdx === group.stocks.length - 1) {
      return false;
    }

    const [removed] = group.stocks.splice(dragIdx, 1);
    group.stocks.push(removed);
    await this.save();
    return true;
  }

  async reorderGroupBefore(dragGroupId: string, targetGroupId: string): Promise<boolean> {
    const dragGroup = this.findGroup(dragGroupId);
    const targetGroup = this.findGroup(targetGroupId);
    if (!dragGroup || !targetGroup || dragGroupId === targetGroupId) {
      return false;
    }

    if ((dragGroup.parentId ?? undefined) !== (targetGroup.parentId ?? undefined)) {
      return false;
    }

    this.insertGroupInSiblingOrder(dragGroupId, targetGroupId);
    await this.save();
    return true;
  }

  private insertGroupInSiblingOrder(groupId: string, insertBeforeId?: string): void {
    const groupIndex = this.config.groups.findIndex((g) => g.id === groupId);
    if (groupIndex === -1) {
      return;
    }

    const [group] = this.config.groups.splice(groupIndex, 1);

    if (insertBeforeId) {
      const beforeIndex = this.config.groups.findIndex((g) => g.id === insertBeforeId);
      if (beforeIndex >= 0) {
        this.config.groups.splice(beforeIndex, 0, group);
        return;
      }
    }

    const parentId = group.parentId;
    let insertIndex = this.config.groups.length;

    for (let i = this.config.groups.length - 1; i >= 0; i--) {
      const sibling = this.config.groups[i];
      if ((sibling.parentId ?? undefined) === (parentId ?? undefined)) {
        insertIndex = i + 1;
        break;
      }
    }

    if (insertIndex === this.config.groups.length && parentId) {
      const parentIndex = this.config.groups.findIndex((g) => g.id === parentId);
      if (parentIndex >= 0) {
        insertIndex = parentIndex + 1;
      }
    }

    this.config.groups.splice(insertIndex, 0, group);
  }

  getGroupParentId(groupId: string): string | undefined {
    return this.findGroup(groupId)?.parentId;
  }

  findGroup(groupId: string): StockGroup | undefined {
    return this.config.groups.find((g) => g.id === groupId);
  }

  getDefaultGroupId(): string {
    return this.getRootGroups()[0]?.id ?? DEFAULT_GROUP.id;
  }

  buildExportFile(): TakeHomeExportFile {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      groups: JSON.parse(JSON.stringify(this.config.groups)) as StockGroup[],
    };
  }

  getConfigSummary(): { groupCount: number; stockCount: number } {
    return {
      groupCount: this.config.groups.length,
      stockCount: this.getAllCodes().length,
    };
  }

  static parseImportFile(raw: unknown): StockConfig {
    if (!raw || typeof raw !== 'object') {
      throw new Error('配置文件格式无效');
    }

    const data = raw as Record<string, unknown>;
    const groups = data.groups;
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new Error('配置文件缺少分组数据');
    }

    StockStorage.validateGroups(groups);
    return { groups: groups as StockGroup[] };
  }

  async replaceConfig(config: StockConfig): Promise<void> {
    StockStorage.validateGroups(config.groups);
    this.config = JSON.parse(JSON.stringify(config)) as StockConfig;
    this.migrateCodes();
    await this.save();
  }

  private static validateGroups(groups: unknown[]): void {
    const ids = new Set<string>();

    for (const group of groups) {
      if (!group || typeof group !== 'object') {
        throw new Error('分组数据格式无效');
      }

      const g = group as Record<string, unknown>;
      if (typeof g.id !== 'string' || !g.id.trim()) {
        throw new Error('分组缺少有效的 id');
      }
      if (typeof g.name !== 'string' || !g.name.trim()) {
        throw new Error(`分组「${g.id}」缺少名称`);
      }
      if (!Array.isArray(g.stocks)) {
        throw new Error(`分组「${g.name}」的股票列表格式无效`);
      }
      if (g.parentId !== undefined && typeof g.parentId !== 'string') {
        throw new Error(`分组「${g.name}」的 parentId 格式无效`);
      }

      if (ids.has(g.id)) {
        throw new Error(`存在重复的分组 id：${g.id}`);
      }
      ids.add(g.id);

      for (const stock of g.stocks) {
        if (!stock || typeof stock !== 'object') {
          throw new Error(`分组「${g.name}」包含无效的股票数据`);
        }
        const s = stock as Record<string, unknown>;
        if (typeof s.code !== 'string' || !s.code.trim()) {
          throw new Error(`分组「${g.name}」包含缺少代码的股票`);
        }
        if (typeof s.name !== 'string' || !s.name.trim()) {
          throw new Error(`分组「${g.name}」中股票「${s.code}」缺少名称`);
        }
        if (s.note !== undefined && typeof s.note !== 'string') {
          throw new Error(`分组「${g.name}」中股票「${s.code}」备注格式无效`);
        }
        if (s.alertAbove !== undefined && typeof s.alertAbove !== 'number') {
          throw new Error(`分组「${g.name}」中股票「${s.code}」价格提醒格式无效`);
        }
        if (s.alertBelow !== undefined && typeof s.alertBelow !== 'number') {
          throw new Error(`分组「${g.name}」中股票「${s.code}」价格提醒格式无效`);
        }
      }
    }

    for (const group of groups) {
      const g = group as StockGroup;
      if (g.parentId && !ids.has(g.parentId)) {
        throw new Error(`分组「${g.name}」引用了不存在的父分组`);
      }
    }

    const hasRoot = groups.some((group) => !(group as StockGroup).parentId);
    if (!hasRoot) {
      throw new Error('配置至少需要一个顶级分组');
    }

    for (const group of groups) {
      const g = group as StockGroup;
      if (g.parentId && StockStorage.isGroupCycle(g.id, g.parentId, groups as StockGroup[])) {
        throw new Error(`分组「${g.name}」存在循环嵌套`);
      }
    }
  }

  private static isGroupCycle(groupId: string, parentId: string, groups: StockGroup[]): boolean {
    const parentMap = new Map(groups.map((g) => [g.id, g.parentId]));
    let current: string | undefined = parentId;
    while (current) {
      if (current === groupId) {
        return true;
      }
      current = parentMap.get(current);
    }
    return false;
  }

  /** 列出所有可移动到的分组（含层级路径） */
  listGroupsForPicker(excludeGroupId?: string): Array<{ id: string; path: string; stockCount: number }> {
    const items: Array<{ id: string; path: string; stockCount: number }> = [];

    const walk = (parentId: string | undefined, prefix: string) => {
      const groups = parentId ? this.getChildGroups(parentId) : this.getRootGroups();
      for (const group of groups) {
        if (group.id === excludeGroupId) {
          continue;
        }
        const path = prefix ? `${prefix} / ${group.name}` : group.name;
        items.push({ id: group.id, path, stockCount: group.stocks.length });
        walk(group.id, path);
      }
    };

    walk(undefined, '');
    return items;
  }

  private collectDescendantIds(groupId: string): Set<string> {
    const ids = new Set<string>([groupId]);
    for (const child of this.getChildGroups(groupId)) {
      for (const id of this.collectDescendantIds(child.id)) {
        ids.add(id);
      }
    }
    return ids;
  }

  private isDescendantOf(groupId: string, ancestorId: string): boolean {
    let current = this.findGroup(groupId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = this.findGroup(current.parentId);
    }
    return false;
  }

  private isStockExists(code: string, excludeGroupId?: string): boolean {
    const normalized = migrateStockCode(code);
    return this.config.groups.some(
      (g) =>
        g.id !== excludeGroupId &&
        g.stocks.some((s) => migrateStockCode(s.code) === normalized)
    );
  }
}
