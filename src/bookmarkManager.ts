import * as vscode from 'vscode';
import * as cp from 'child_process';
import { FlowBookmark, FlowGroup, BookmarksState } from './types';

/**
 * 书签管理器 — 支持多分组，每个分组内按流程顺序管理书签
 * 存储策略：workspaceState + 项目文件 + globalState（按 git remote 同步）
 */
export class BookmarkManager {
  private static readonly STATE_KEY = 'codeFlow.bookmarksState';

  private groups: FlowGroup[];
  private bookmarks: FlowBookmark[];
  private activeGroupId: string;
  private currentIndex: number;
  private nextOrder: number;
  private globalKey: string = '';

  private _onDidChangeBookmarks = new vscode.EventEmitter<FlowBookmark[]>();
  private _onDidChangeCurrentIndex = new vscode.EventEmitter<number>();
  private _onDidChangeGroups = new vscode.EventEmitter<FlowGroup[]>();
  private _onDidChangeActiveGroup = new vscode.EventEmitter<string>();

  readonly onDidChangeBookmarks = this._onDidChangeBookmarks.event;
  readonly onDidChangeCurrentIndex = this._onDidChangeCurrentIndex.event;
  readonly onDidChangeGroups = this._onDidChangeGroups.event;
  readonly onDidChangeActiveGroup = this._onDidChangeActiveGroup.event;

  constructor(private context: vscode.ExtensionContext) {
    // 先加载 workspaceState
    const saved = context.workspaceState.get<BookmarksState>(
      BookmarkManager.STATE_KEY
    );
    this.groups = saved?.groups ?? [];
    this.bookmarks = saved?.bookmarks ?? [];
    this.activeGroupId = saved?.activeGroupId ?? '';
    this.currentIndex = saved?.currentIndex ?? -1;
    this.nextOrder = saved?.nextOrder ?? 0;

    this.groups.sort((a, b) => a.order - b.order);
    this.bookmarks.sort((a, b) => a.order - b.order);

    if (this.groups.length === 0) {
      this.createDefaultGroup();
    }

    // 异步加载跨 clone 共享数据
    this.loadFromProjectFile();
    this.detectGitRemoteAndSync();
  }

  // ─── 默认分组 ──────────────────────────────────

  private createDefaultGroup(): void {
    const defaultGroup: FlowGroup = {
      id: this.generateId(),
      name: 'Default',
      color: '#29B6F6',
      order: 0,
      hidden: false,
      createdAt: Date.now(),
    };
    this.groups.push(defaultGroup);
    this.activeGroupId = defaultGroup.id;
    this.persist();
  }

  // ─── 分组 CRUD ──────────────────────────────────

  getAllGroups(): FlowGroup[] {
    return [...this.groups];
  }

  /** 获取顶级分组（无 parentId） */
  getTopLevelGroups(): FlowGroup[] {
    return this.groups
      .filter((g) => !g.parentId)
      .sort((a, b) => a.order - b.order);
  }

  /** 获取子分组 */
  getChildGroups(parentId: string): FlowGroup[] {
    return this.groups
      .filter((g) => g.parentId === parentId)
      .sort((a, b) => a.order - b.order);
  }

  getGroup(id: string): FlowGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }

  getActiveGroup(): FlowGroup | undefined {
    return this.groups.find((g) => g.id === this.activeGroupId);
  }

  getActiveGroupId(): string {
    return this.activeGroupId;
  }

  createGroup(name: string, color?: string, mdPath?: string, parentId?: string): FlowGroup {
    const id = this.generateId();
    const group: FlowGroup = {
      id,
      name,
      color: color || this.getNextDefaultColor(),
      order: this.groups.length,
      hidden: false,
      mdPath,
      parentId,
      createdAt: Date.now(),
    };
    this.groups.push(group);

    // 新建分组自动激活
    this.activeGroupId = id;
    this.currentIndex = -1;

    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return group;
  }

  /**
   * 设置活动分组 — 切换分组时重置导航位置
   */
  setActiveGroup(groupId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) {
      return false;
    }
    this.activeGroupId = groupId;
    this.currentIndex = -1; // 切换分组时重置导航
    this.persist();
    this._onDidChangeActiveGroup.fire(groupId);
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
    this._onDidChangeBookmarks.fire(this.getAll());
    return true;
  }

  renameGroup(groupId: string, name: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) {
      return false;
    }
    group.name = name;
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  setGroupColor(groupId: string, color: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) {
      return false;
    }
    group.color = color;
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  /**
   * 从导入数据替换当前状态
   */
  importState(state: BookmarksState): void {
    this.groups = state.groups || [];
    this.bookmarks = state.bookmarks || [];
    this.activeGroupId = state.activeGroupId || '';
    this.currentIndex = state.currentIndex ?? -1;
    this.nextOrder = state.nextOrder ?? 0;
    this.groups.sort((a, b) => a.order - b.order);
    this.bookmarks.sort((a, b) => a.order - b.order);
    if (this.groups.length === 0) {
      this.createDefaultGroup();
    }
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    this._onDidChangeBookmarks.fire(this.getAll());
    this._onDidChangeActiveGroup.fire(this.activeGroupId);
  }

  /**
   * 设置分组的 Markdown 关联路径
   */
  setGroupMdPath(groupId: string, mdPath: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return false;
    group.mdPath = mdPath || undefined;
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  /**
   * 隐藏分组 — 一键隐藏该分组下所有书签
   */
  hideGroup(groupId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return false;
    group.hidden = true;
    // 如果隐藏的是活动分组，清除当前导航
    if (this.activeGroupId === groupId) {
      this.currentIndex = -1;
    }
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    this._onDidChangeBookmarks.fire(this.getAll());
    return true;
  }

  /**
   * 取消隐藏分组
   */
  unhideGroup(groupId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return false;
    group.hidden = false;
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  /**
   * 清除指定分组下的所有书签
   */
  clearGroupBookmarks(groupId: string): boolean {
    const group = this.groups.find((g) => g.id === groupId);
    if (!group) return false;

    const count = this.bookmarks.filter((b) => b.groupId === groupId).length;
    this.bookmarks = this.bookmarks.filter((b) => b.groupId !== groupId);

    if (this.activeGroupId === groupId) {
      this.currentIndex = -1;
    }

    this.renumber();
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    this._onDidChangeBookmarks.fire(this.getAll());
    if (this.activeGroupId === groupId) {
      this._onDidChangeCurrentIndex.fire(-1);
    }
    return true;
  }

  /**
   * 删除分组及其所有书签
   */
  deleteGroup(groupId: string): boolean {
    if (this.groups.length <= 1) {
      return false; // 至少保留一个分组
    }

    const idx = this.groups.findIndex((g) => g.id === groupId);
    if (idx === -1) {
      return false;
    }

    // 删除该书签
    this.bookmarks = this.bookmarks.filter((b) => b.groupId !== groupId);
    this.groups.splice(idx, 1);

    // 如果删除的是活动分组，切换到第一个
    if (this.activeGroupId === groupId) {
      this.activeGroupId = this.groups[0].id;
      this.currentIndex = -1;
    }

    this.renumber();
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    this._onDidChangeBookmarks.fire(this.getAll());
    this._onDidChangeActiveGroup.fire(this.activeGroupId);
    return true;
  }

  moveGroupUp(groupId: string): boolean {
    const idx = this.groups.findIndex((g) => g.id === groupId);
    if (idx <= 0) {
      return false;
    }
    [this.groups[idx], this.groups[idx - 1]] = [
      this.groups[idx - 1],
      this.groups[idx],
    ];
    this.renumberGroups();
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  moveGroupDown(groupId: string): boolean {
    const idx = this.groups.findIndex((g) => g.id === groupId);
    if (idx < 0 || idx >= this.groups.length - 1) {
      return false;
    }
    [this.groups[idx], this.groups[idx + 1]] = [
      this.groups[idx + 1],
      this.groups[idx],
    ];
    this.renumberGroups();
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  // ─── 书签 CRUD ──────────────────────────────────

  /** 获取所有书签 */
  getAll(): FlowBookmark[] {
    return [...this.bookmarks];
  }

  /** 获取活动分组内的书签（按流程顺序） */
  getActiveGroupBookmarks(): FlowBookmark[] {
    return this.bookmarks
      .filter((b) => b.groupId === this.activeGroupId)
      .sort((a, b) => a.order - b.order);
  }

  /** 获取指定分组内的书签 */
  getBookmarksByGroup(groupId: string): FlowBookmark[] {
    return this.bookmarks
      .filter((b) => b.groupId === groupId)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * 在当前书签之后插入新书签（Alt+Shift+F9）
   */
  addAfterCurrent(filePath: string, line: number, character: number, label?: string, lineText?: string, functionName?: string): FlowBookmark | null {
    const groupBookmarks = this.getBookmarksByGroup(this.activeGroupId);
    if (groupBookmarks.length === 0) {
      return this.add(filePath, line, character, label);
    }

    // 检查该位置是否已有书签
    const existing = this.findByLocation(filePath, line, this.activeGroupId);
    if (existing) {
      return null; // 已有书签，不重复添加
    }

    // 在当前书签之后插入（如果没有当前书签则插到末尾）
    const insertOrder = this.currentIndex >= 0
      ? this.currentIndex + 1
      : groupBookmarks.length;

    // 同组内 order >= insertOrder 的书签全部 +1
    for (const bm of this.bookmarks) {
      if (bm.groupId === this.activeGroupId && bm.order >= insertOrder) {
        bm.order++;
      }
    }

    const id = this.generateId();
    const bookmark: FlowBookmark = {
      id,
      groupId: this.activeGroupId,
      filePath,
      line,
      character,
      label,
      lineFingerprint: lineText?.trim() || undefined,
      functionName,
      order: insertOrder,
      createdAt: Date.now(),
    };
    this.bookmarks.push(bookmark);

    // 调整当前索引
    if (this.currentIndex >= insertOrder) {
      this.currentIndex++;
    }

    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    return bookmark;
  }

  /**
   * 切换书签 — 在活动分组中添加/移除
   */
  toggle(filePath: string, line: number, character: number, label?: string, lineText?: string, functionName?: string): FlowBookmark | null {
    const existing = this.findByLocation(filePath, line, this.activeGroupId);
    if (existing) {
      this.remove(existing.id);
      return null;
    }
    return this.add(filePath, line, character, label, lineText, functionName);
  }

  /**
   * 添加书签到活动分组末尾
   */
  add(filePath: string, line: number, character: number, label?: string, lineText?: string, functionName?: string): FlowBookmark {
    const groupBookmarks = this.getBookmarksByGroup(this.activeGroupId);
    const id = this.generateId();
    const bookmark: FlowBookmark = {
      id,
      groupId: this.activeGroupId,
      filePath,
      line,
      character,
      label,
      lineFingerprint: lineText?.trim() || undefined,
      functionName,
      order: groupBookmarks.length,
      createdAt: Date.now(),
    };
    this.bookmarks.push(bookmark);
    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    return bookmark;
  }

  /**
   * 移除书签
   */
  remove(id: string): boolean {
    const idx = this.bookmarks.findIndex((b) => b.id === id);
    if (idx === -1) {
      return false;
    }

    this.bookmarks.splice(idx, 1);
    this.renumber();

    // 调整当前索引
    if (this.currentIndex >= this.bookmarks.length) {
      this.currentIndex = this.bookmarks.length - 1;
    }
    if (idx < this.currentIndex) {
      this.currentIndex--;
    }
    if (this.currentIndex === idx && this.currentIndex >= this.bookmarks.length) {
      this.currentIndex = this.bookmarks.length > 0 ? idx - 1 : -1;
    }

    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
    return true;
  }

  /**
   * 重命名书签
   */
  rename(id: string, label: string): boolean {
    const bookmark = this.bookmarks.find((b) => b.id === id);
    if (!bookmark) {
      return false;
    }
    bookmark.label = label || undefined;
    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    return true;
  }

  /**
   * 将书签移动到另一个分组
   */
  moveToGroup(bookmarkId: string, targetGroupId: string): boolean {
    const bookmark = this.bookmarks.find((b) => b.id === bookmarkId);
    const targetGroup = this.groups.find((g) => g.id === targetGroupId);
    if (!bookmark || !targetGroup) {
      return false;
    }
    if (bookmark.groupId === targetGroupId) {
      return false;
    }

    bookmark.groupId = targetGroupId;
    this.renumber();
    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    return true;
  }

  /**
   * 清除活动分组内所有书签
   */
  clearActiveGroup(): void {
    this.bookmarks = this.bookmarks.filter(
      (b) => b.groupId !== this.activeGroupId
    );
    this.currentIndex = -1;
    this.renumber();
    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    this._onDidChangeCurrentIndex.fire(-1);
  }

  /**
   * 清除所有分组和书签
   */
  clearAll(): void {
    this.bookmarks = [];
    this.groups = [];
    this.currentIndex = -1;
    this.nextOrder = 0;
    this.createDefaultGroup();
    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    this._onDidChangeBookmarks.fire([]);
    this._onDidChangeCurrentIndex.fire(-1);
  }

  // ─── 排序 / 流程顺序 ──────────────────────────

  /**
   * 活动分组内书签上移
   */
  moveUp(id: string): boolean {
    const bookmarks = this.getActiveGroupBookmarks();
    const idx = bookmarks.findIndex((b) => b.id === id);
    if (idx <= 0) {
      return false;
    }
    const globalA = this.bookmarks.indexOf(bookmarks[idx]);
    const globalB = this.bookmarks.indexOf(bookmarks[idx - 1]);
    this.swap(globalA, globalB);
    return true;
  }

  /**
   * 活动分组内书签下移
   */
  moveDown(id: string): boolean {
    const bookmarks = this.getActiveGroupBookmarks();
    const idx = bookmarks.findIndex((b) => b.id === id);
    if (idx < 0 || idx >= bookmarks.length - 1) {
      return false;
    }
    const globalA = this.bookmarks.indexOf(bookmarks[idx]);
    const globalB = this.bookmarks.indexOf(bookmarks[idx + 1]);
    this.swap(globalA, globalB);
    return true;
  }

  /**
   * 将书签移动到指定位置（全局索引）
   */
  /**
   * 将书签移动到目标书签处（拖拽排序）
   * 向下拖 → 插入目标之后；向上拖 → 插入目标之前
   */
  moveBookmarkAfter(bookmarkId: string, targetId: string): boolean {
    if (bookmarkId === targetId) {
      return false;
    }

    const bookmark = this.findById(bookmarkId);
    const target = this.findById(targetId);
    if (!bookmark || !target || bookmark.groupId !== target.groupId) {
      return false;
    }

    const groupBookmarks = this.getBookmarksByGroup(bookmark.groupId);
    const draggedIdx = groupBookmarks.findIndex((b) => b.id === bookmarkId);
    const targetIdx = groupBookmarks.findIndex((b) => b.id === targetId);
    if (draggedIdx < 0 || targetIdx < 0) return false;

    // 判断拖拽方向
    const draggingDown = draggedIdx < targetIdx;

    // 在临时数组中计算新位置
    const reordered = [...groupBookmarks];
    const [moved] = reordered.splice(draggedIdx, 1);

    let insertIdx: number;
    if (draggingDown) {
      // 向下拖 → 插入到目标之后（目标位置不变，因为移除的项在目标之前）
      insertIdx = targetIdx; // 移除后目标索引 = targetIdx - 1，所以 "之后" = targetIdx
    } else {
      // 向上拖 → 插入到目标之前（目标位置不变，因为移除的项在目标之后）
      insertIdx = targetIdx;
    }

    reordered.splice(insertIdx, 0, moved);
    reordered.forEach((b, i) => {
      b.order = i;
    });

    // 调整 currentIndex
    const currentBm = this.getCurrent();
    if (currentBm && currentBm.groupId === bookmark.groupId) {
      this.currentIndex = reordered.findIndex((b) => b.id === currentBm.id);
    }

    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    return true;
  }

  /**
   * 将分组移动到目标分组之后（拖拽排序）
   */
  moveGroupAfter(groupId: string, targetId: string): boolean {
    if (groupId === targetId) return false;

    const idx = this.groups.findIndex((g) => g.id === groupId);
    const targetIdx = this.groups.findIndex((g) => g.id === targetId);
    if (idx < 0 || targetIdx < 0) return false;

    const [moved] = this.groups.splice(idx, 1);
    const newTargetIdx = this.groups.findIndex((g) => g.id === targetId);
    this.groups.splice(newTargetIdx + 1, 0, moved);
    this.renumberGroups();

    this.persist();
    this._onDidChangeGroups.fire(this.getAllGroups());
    return true;
  }

  private swap(i: number, j: number): void {
    [this.bookmarks[i], this.bookmarks[j]] = [
      this.bookmarks[j],
      this.bookmarks[i],
    ];
    this.renumber();

    if (this.currentIndex === i) {
      this.currentIndex = j;
    } else if (this.currentIndex === j) {
      this.currentIndex = i;
    }
    if (this.currentIndex >= this.bookmarks.length) {
      this.currentIndex = this.bookmarks.length - 1;
    }

    this.persist();
    this._onDidChangeBookmarks.fire(this.getAll());
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
  }

  private renumber(): void {
    // 按组独立编号：每个分组内的书签从 0 开始
    for (const group of this.groups) {
      const groupBookmarks = this.bookmarks
        .filter((b) => b.groupId === group.id)
        .sort((a, b) => a.order - b.order);
      groupBookmarks.forEach((b, i) => {
        b.order = i;
      });
    }
    this.nextOrder = this.bookmarks.length;
  }

  private renumberGroups(): void {
    this.groups.forEach((g, i) => {
      g.order = i;
    });
  }

  // ─── 导航（活动分组内）─────────────────────────

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getCurrent(): FlowBookmark | undefined {
    const active = this.getActiveGroupBookmarks();
    if (this.currentIndex < 0 || this.currentIndex >= active.length) {
      return undefined;
    }
    return active[this.currentIndex];
  }

  get count(): number {
    return this.getActiveGroupBookmarks().length;
  }

  get totalCount(): number {
    return this.bookmarks.length;
  }

  /**
   * 跳转到下一个（活动分组内循环）
   */
  next(): FlowBookmark | null {
    const active = this.getActiveGroupBookmarks();
    if (active.length === 0) {
      return null;
    }
    this.currentIndex = (this.currentIndex + 1) % active.length;
    this.persist();
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
    return active[this.currentIndex];
  }

  /**
   * 跳转到上一个（活动分组内循环）
   */
  previous(): FlowBookmark | null {
    const active = this.getActiveGroupBookmarks();
    if (active.length === 0) {
      return null;
    }
    this.currentIndex =
      this.currentIndex <= 0
        ? active.length - 1
        : this.currentIndex - 1;
    this.persist();
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
    return active[this.currentIndex];
  }

  /**
   * 跳转到指定书签
   */
  goTo(id: string): FlowBookmark | null {
    const active = this.getActiveGroupBookmarks();
    const idx = active.findIndex((b) => b.id === id);
    if (idx < 0) {
      return null;
    }
    this.currentIndex = idx;
    this.persist();
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
    return active[idx];
  }

  /**
   * 跳转到流程起点
   */
  goToStart(): FlowBookmark | null {
    const active = this.getActiveGroupBookmarks();
    if (active.length === 0) {
      return null;
    }
    this.currentIndex = 0;
    this.persist();
    this._onDidChangeCurrentIndex.fire(this.currentIndex);
    return active[0];
  }

  // ─── 查询 ──────────────────────────────────────

  findByLocation(filePath: string, line: number, groupId?: string): FlowBookmark | undefined {
    const gid = groupId ?? this.activeGroupId;
    return this.bookmarks.find(
      (b) => b.groupId === gid && b.filePath === filePath && b.line === line
    );
  }

  findById(id: string): FlowBookmark | undefined {
    return this.bookmarks.find((b) => b.id === id);
  }

  /**
   * 获取指定文件中活动分组的书签
   */
  getByFile(filePath: string): FlowBookmark[] {
    return this.bookmarks
      .filter((b) => b.groupId === this.activeGroupId && b.filePath === filePath)
      .sort((a, b) => a.order - b.order);
  }

  /**
   * 检查文件是否有活动分组的书签
   */
  hasBookmarksInFile(filePath: string): boolean {
    return this.bookmarks.some(
      (b) => b.groupId === this.activeGroupId && b.filePath === filePath
    );
  }

  /**
   * 文档变更时调整书签行号，实现书签跟随代码移动
   */
  onDocumentChanged(
    filePath: string,
    changeStartLine: number,    // 变更起始行（0-based）
    changeOldEndLine: number,   // 变更前的结束行（0-based）
    changeNewEndLine: number    // 变更后的结束行（0-based）
  ): void {
    const lineDelta = changeNewEndLine - changeOldEndLine;
    if (lineDelta === 0) {
      return; // 仅同行内修改，不影响行号
    }

    let changed = false;

    for (const bm of this.bookmarks) {
      if (bm.filePath !== filePath) {
        continue;
      }

      if (bm.line > changeOldEndLine) {
        // 书签在变更区域之下 → 行号偏移
        bm.line += lineDelta;
        if (bm.line < 0) bm.line = 0;
        changed = true;
      } else if (bm.line >= changeStartLine && bm.line <= changeOldEndLine) {
        // 书签在变更区域内 → 保持在变更后的起始位置
        bm.line = changeNewEndLine;
        changed = true;
      }
    }

    if (changed) {
      this.persist();
      this._onDidChangeBookmarks.fire(this.getAll());
    }
  }

  // ─── 持久化 ────────────────────────────────────

  private persist(): void {
    const state: BookmarksState = {
      groups: this.groups,
      bookmarks: this.bookmarks,
      activeGroupId: this.activeGroupId,
      currentIndex: this.currentIndex,
      nextOrder: this.nextOrder,
    };
    this.context.workspaceState.update(BookmarkManager.STATE_KEY, state);
    this.saveToProjectFile(state);
    this.saveToGlobalState(state);
  }

  private saveToGlobalState(state: BookmarksState): void {
    if (!this.globalKey) return;
    this.context.globalState.update(
      `${BookmarkManager.STATE_KEY}.${this.globalKey}`,
      state
    );
  }

  private async detectGitRemoteAndSync(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    try {
      const remote = await this.getGitRemote(folder.uri.fsPath);
      if (!remote) return;

      // 用 git remote URL 的简短形式作为 key
      this.globalKey = remote
        .replace(/^https?:\/\//, '')
        .replace(/\.git$/, '')
        .replace(/[\/\\:@]/g, '_');

      // 尝试从 globalState 加载（跨 clone 同步）
      const stateKey = `${BookmarkManager.STATE_KEY}.${this.globalKey}`;
      const globalSaved = this.context.globalState.get<BookmarksState>(stateKey);

      if (globalSaved && globalSaved.bookmarks?.length > 0) {
        // 只在本地没有数据时才从 global 恢复
        if (this.bookmarks.length === 0 && this.groups.length <= 1) {
          const defaultGroup = this.groups[0];
          this.groups = globalSaved.groups;
          this.bookmarks = globalSaved.bookmarks;
          this.activeGroupId = globalSaved.activeGroupId || '';
          this.currentIndex = globalSaved.currentIndex ?? -1;
          this.groups.sort((a, b) => a.order - b.order);
          this.bookmarks.sort((a, b) => a.order - b.order);
          if (this.groups.length === 0) {
            this.groups.push(defaultGroup);
            this.activeGroupId = defaultGroup.id;
          }
          this._onDidChangeGroups.fire(this.getAllGroups());
          this._onDidChangeBookmarks.fire(this.getAll());
          this._onDidChangeActiveGroup.fire(this.activeGroupId);
          this._onDidChangeCurrentIndex.fire(this.currentIndex);

          // 同步到本地 workspaceState
          this.persist();
        }
      } else if (this.bookmarks.length > 0) {
        // 本地有数据但 global 没有 → 把本地数据推送到 global
        this.saveToGlobalState({
          groups: this.groups,
          bookmarks: this.bookmarks,
          activeGroupId: this.activeGroupId,
          currentIndex: this.currentIndex,
          nextOrder: this.nextOrder,
        });
      }
    } catch {
      // 获取 git remote 失败，忽略
    }
  }

  private getGitRemote(cwd: string): Promise<string | null> {
    return new Promise((resolve) => {
      cp.exec('git remote get-url origin', { cwd, timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          resolve(stdout.trim() || null);
        }
      });
    });
  }

  private getStorageUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'code-flow-bookmarks.json');
  }

  private saveToProjectFile(state: BookmarksState): void {
    const uri = this.getStorageUri();
    if (!uri) return;
    try {
      const dir = vscode.Uri.joinPath(uri, '..');
      vscode.workspace.fs.createDirectory(dir).then(() => {
        const data = Buffer.from(JSON.stringify(state, null, 2), 'utf-8');
        vscode.workspace.fs.writeFile(uri, data);
      });
    } catch {
      // 静默失败
    }
  }

  private async loadFromProjectFile(): Promise<void> {
    const uri = this.getStorageUri();
    if (!uri) return;

    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const state: BookmarksState = JSON.parse(Buffer.from(data).toString('utf-8'));
      if (!state.groups || !state.bookmarks) return;

      // 只在当前 workspace 没有数据时才从文件加载
      if (this.bookmarks.length === 0 && this.groups.length <= 1) {
        const defaultGroup = this.groups[0];
        this.groups = state.groups;
        this.bookmarks = state.bookmarks;
        this.activeGroupId = state.activeGroupId || '';
        this.currentIndex = state.currentIndex ?? -1;
        this.nextOrder = state.nextOrder ?? 0;
        this.groups.sort((a, b) => a.order - b.order);
        this.bookmarks.sort((a, b) => a.order - b.order);

        if (this.groups.length === 0) {
          this.groups.push(defaultGroup);
          this.activeGroupId = defaultGroup.id;
        }

        this._onDidChangeGroups.fire(this.getAllGroups());
        this._onDidChangeBookmarks.fire(this.getAll());
        this._onDidChangeActiveGroup.fire(this.activeGroupId);
        this._onDidChangeCurrentIndex.fire(this.currentIndex);
      }
    } catch {
      // 文件不存在，正常
    }
  }

  // ─── 工具方法 ──────────────────────────────────

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private colorIndex = 0;
  private readonly defaultColors = [
    '#29B6F6', '#FF7043', '#AB47BC', '#66BB6A',
    '#FFA726', '#42A5F5', '#EF5350', '#26C6DA',
    '#7E57C2', '#EC407A', '#8D6E63', '#78909C',
  ];

  private getNextDefaultColor(): string {
    const color = this.defaultColors[this.colorIndex % this.defaultColors.length];
    this.colorIndex++;
    return color;
  }
}
