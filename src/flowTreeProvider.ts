import * as vscode from 'vscode';
import { FlowBookmark, FlowGroup } from './types';
import { BookmarkManager } from './bookmarkManager';

const MIME_BOOKMARK = 'application/vnd.code.tree.codeFlowBookmark';
const MIME_GROUP = 'application/vnd.code.tree.codeFlowGroup';

/**
 * 两级树视图 — 分组 → 书签
 * 支持拖拽排序：书签组内/组间拖拽、分组排序
 */
export class FlowTreeProvider
  implements
    vscode.TreeDataProvider<FlowTreeItem>,
    vscode.TreeDragAndDropController<FlowTreeItem>
{
  dropMimeTypes = [MIME_BOOKMARK, MIME_GROUP];
  dragMimeTypes = [MIME_BOOKMARK, MIME_GROUP];

  private _onDidChangeTreeData = new vscode.EventEmitter<
    FlowTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private bookmarkManager: BookmarkManager) {
    bookmarkManager.onDidChangeBookmarks(() => this.refresh());
    bookmarkManager.onDidChangeCurrentIndex(() => this.refresh());
    bookmarkManager.onDidChangeGroups(() => this.refresh());
    bookmarkManager.onDidChangeActiveGroup(() => this.refresh());
  }

  // ─── TreeDataProvider ───────────────────────────

  getTreeItem(element: FlowTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FlowTreeItem): vscode.ProviderResult<FlowTreeItem[]> {
    if (!element) {
      // 根级别 — 顶级分组
      return this.createGroupItems(undefined);
    }
    if (element.group && !element.bookmark) {
      // 分组节点 — 子分组 + 书签
      const children: FlowTreeItem[] = [];
      // 子分组
      const childGroups = this.bookmarkManager.getChildGroups(element.group.id);
      children.push(...childGroups.map((g) => this.createGroupItem(g, vscode.TreeItemCollapsibleState.Collapsed)));
      // 书签
      children.push(...this.createBookmarkItems(element.group.id));
      return children;
    }
    return [];
  }

  getParent(element: FlowTreeItem): vscode.ProviderResult<FlowTreeItem> {
    if (element.bookmark) {
      const group = this.bookmarkManager.getGroup(element.bookmark.groupId);
      if (group) {
        return this.createGroupItem(group, vscode.TreeItemCollapsibleState.None);
      }
    }
    if (element.group?.parentId) {
      const parent = this.bookmarkManager.getGroup(element.group.parentId);
      if (parent) {
        return this.createGroupItem(parent, vscode.TreeItemCollapsibleState.None);
      }
    }
    return null;
  }

  // ─── Drag & Drop ────────────────────────────────

  async handleDrag(
    source: readonly FlowTreeItem[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    // 拖拽分组
    const groupItems = source.filter((item) => item.group && !item.bookmark);
    if (groupItems.length > 0) {
      dataTransfer.set(
        MIME_GROUP,
        new vscode.DataTransferItem(groupItems.map((i) => i.group!.id))
      );
      return;
    }

    // 拖拽书签
    const bookmarkItems = source.filter((item) => item.bookmark !== undefined);
    if (bookmarkItems.length > 0) {
      dataTransfer.set(
        MIME_BOOKMARK,
        new vscode.DataTransferItem(bookmarkItems.map((i) => i.bookmark!.id))
      );
    }
  }

  async handleDrop(
    target: FlowTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    // ── 拖放分组 → 排序分组 ──
    const groupTransfer = dataTransfer.get(MIME_GROUP);
    if (groupTransfer) {
      const groupIds: string[] = groupTransfer.value;
      if (!groupIds || groupIds.length === 0) return;

      if (target?.group && !target.bookmark) {
        // 放到目标分组之后
        for (const gid of groupIds) {
          this.bookmarkManager.moveGroupAfter(gid, target.group!.id);
        }
      }
      return;
    }

    // ── 拖放书签 ──
    const bookmarkTransfer = dataTransfer.get(MIME_BOOKMARK);
    if (!bookmarkTransfer) return;

    const ids: string[] = bookmarkTransfer.value;
    if (!ids || ids.length === 0) return;

    if (!target) return;

    // 拖放到分组 → 移动到该分组末尾
    if (target.group && !target.bookmark) {
      for (const id of ids) {
        this.bookmarkManager.moveToGroup(id, target.group.id);
      }
      return;
    }

    // 拖放到书签 → 插入到目标书签之后
    if (target.bookmark) {
      for (const id of ids) {
        const bookmark = this.bookmarkManager.findById(id);
        if (bookmark) {
          // 确保同组
          if (bookmark.groupId !== target.bookmark.groupId) {
            this.bookmarkManager.moveToGroup(id, target.bookmark.groupId);
          }
          // 插入到目标后面
          this.bookmarkManager.moveBookmarkAfter(id, target.bookmark.id);
        }
      }
    }
  }

  // ─── 创建树节点 ──────────────────────────────────

  private createGroupItems(parentId?: string): FlowTreeItem[] {
    const groups = parentId
      ? this.bookmarkManager.getChildGroups(parentId)
      : this.bookmarkManager.getTopLevelGroups();
    if (groups.length === 0 && !parentId) {
      return [this.createEmptyAllItem()];
    }
    return groups.map((g) => this.createGroupItem(g, vscode.TreeItemCollapsibleState.Collapsed));
  }

  private createGroupItem(
    group: FlowGroup,
    collapsible: vscode.TreeItemCollapsibleState
  ): FlowTreeItem {
    const isActive = group.id === this.bookmarkManager.getActiveGroupId();
    const bookmarkCount = this.bookmarkManager.getBookmarksByGroup(group.id).length;
    const activeMarker = isActive ? ' ⭐' : '';
    const hiddenMarker = group.hidden ? ' 👁‍🗨' : '';

    const label = group.name;
    const item = new FlowTreeItem(
      label,
      group,
      undefined,
      collapsible
    );

    const descParts = [`${bookmarkCount} 书签${activeMarker}${hiddenMarker}`];
    item.description = descParts.join(' · ');

    item.tooltip = this.buildGroupTooltip(group, isActive, bookmarkCount);

    item.iconPath = new vscode.ThemeIcon(
      group.hidden ? 'eye-closed' : (isActive ? 'folder-active' : 'folder'),
      group.color ? new vscode.ThemeColor(group.color) : undefined
    );

    if (isActive) {
      item.resourceUri = vscode.Uri.parse('codeflow:active');
    }

    // 上下文值：用于菜单 when 条件
    const contexts = ['flowGroup'];
    if (isActive) contexts.push('active');
    if (group.hidden) contexts.push('hidden');
    item.contextValue = contexts.join('|');
    item.id = `group:${group.id}`;

    return item;
  }

  private createBookmarkItems(groupId: string): FlowTreeItem[] {
    const bookmarks = this.bookmarkManager.getBookmarksByGroup(groupId);
    const currentBookmark = this.bookmarkManager.getCurrent();
    const isActiveGroup = groupId === this.bookmarkManager.getActiveGroupId();

    if (bookmarks.length === 0) {
      return [this.createEmptyBookmarkItem()];
    }

    return bookmarks.map((bm) => {
      const isCurrent =
        isActiveGroup &&
        currentBookmark !== undefined &&
        currentBookmark.id === bm.id;

      return this.createBookmarkItem(bm, isCurrent, isActiveGroup);
    });
  }

  private createBookmarkItem(
    bookmark: FlowBookmark,
    isCurrent: boolean,
    isActiveGroup: boolean
  ): FlowTreeItem {
    const stepNum = bookmark.order + 1;
    const fileName = bookmark.filePath.split('/').pop() || bookmark.filePath;
    const lineNum = bookmark.line + 1;

    // 标题：文件名:行号
    const displayLabel = `${stepNum}. ${fileName}:${lineNum}`;

    const item = new FlowTreeItem(
      displayLabel,
      undefined,
      bookmark,
      vscode.TreeItemCollapsibleState.None
    );

    // 描述：函数名（仅名称，不含参数） > 标签
    const descParts: string[] = [];
    if (bookmark.functionName) {
      // 去掉参数部分：handleLogin(params) -> handleLogin
      const shortName = bookmark.functionName.replace(/\(.*$/, '').trim();
      if (shortName) descParts.push(shortName);
    }
    if (bookmark.label) descParts.push(bookmark.label);
    item.description = descParts.join(' · ');
    item.tooltip = this.buildBookmarkTooltip(bookmark, isCurrent);

    if (isCurrent) {
      item.iconPath = new vscode.ThemeIcon(
        'debug-start',
        new vscode.ThemeColor('charts.yellow')
      );
    } else if (isActiveGroup) {
      item.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('charts.blue')
      );
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    // 单击跳转（自动激活所属分组）
    item.command = {
      command: 'codeFlow.jumpToBookmark',
      title: 'Jump to Bookmark',
      arguments: [bookmark],
    };

    item.contextValue = isActiveGroup
      ? 'flowBookmark|activeGroup'
      : 'flowBookmark';
    item.id = `bookmark:${bookmark.id}`;

    return item;
  }

  private createEmptyBookmarkItem(): FlowTreeItem {
    const item = new FlowTreeItem(
      '暂无书签',
      undefined,
      undefined,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = '使用 Alt+F9 添加';
    item.iconPath = new vscode.ThemeIcon('dash');
    item.contextValue = 'emptyBookmarks';
    return item;
  }

  private createEmptyAllItem(): FlowTreeItem {
    const item = new FlowTreeItem(
      '暂无分组',
      undefined,
      undefined,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = '使用命令创建分组';
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = 'empty';
    return item;
  }

  // ─── 工具提示 ──────────────────────────────────

  private buildGroupTooltip(
    group: FlowGroup,
    isActive: boolean,
    count: number
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    md.appendMarkdown(
      `### ${isActive ? '⭐ ' : ''}${group.name}\n\n`
      + `| 属性 | 值 |\n|------|----|\n`
      + `| 书签数 | ${count} |\n`
      + `| 状态 | ${isActive ? '当前活动分组' : '非活动分组'} |`
    );

    return md;
  }

  private buildBookmarkTooltip(
    bookmark: FlowBookmark,
    isCurrent: boolean
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    const status = isCurrent ? '📍 **当前流程位置**' : '';
    const label = bookmark.label ? `\`${bookmark.label}\`` : '未命名';
    const group = this.bookmarkManager.getGroup(bookmark.groupId);

    md.appendMarkdown(
      `### 步骤 ${bookmark.order + 1} ${status}\n\n`
      + `| 属性 | 值 |\n|------|----|\n`
      + `| 标签 | ${label} |\n`
      + `| 分组 | ${group?.name ?? '未知'} |\n`
      + `| 文件 | \`${bookmark.filePath}\` |\n`
      + `| 行号 | ${bookmark.line + 1} |\n`
      + `| 创建时间 | ${new Date(bookmark.createdAt).toLocaleString()} |`
    );

    return md;
  }

  // ─── 公开方法 ──────────────────────────────────

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getBookmarkForItem(item: FlowTreeItem): FlowBookmark | undefined {
    return item.bookmark;
  }
}

export class FlowTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly group: FlowGroup | undefined,
    public readonly bookmark: FlowBookmark | undefined,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}
