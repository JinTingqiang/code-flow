import * as vscode from 'vscode';
import { BookmarkManager } from './bookmarkManager';
import { DecorationManager } from './decorationManager';
import { FlowTreeProvider, FlowTreeItem } from './flowTreeProvider';
import { FlowBookmark, FlowGroup } from './types';

/**
 * 获取某一行所在的函数/方法名
 */
async function getFunctionName(
  uri: vscode.Uri,
  line: number
): Promise<string | undefined> {
  try {
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >('vscode.executeDocumentSymbolProvider', uri);
    if (!symbols || symbols.length === 0) return undefined;

    // 递归查找包含该行的最内层函数/方法/类
    function findEnclosing(
      syms: vscode.DocumentSymbol[],
      targetLine: number
    ): string | undefined {
      for (const sym of syms) {
        const start = sym.range.start.line;
        const end = sym.range.end.line;
        if (targetLine >= start && targetLine <= end) {
          // 优先找更内层的
          const inner = findEnclosing(sym.children, targetLine);
          if (inner) return inner;
          // 只返回函数/方法/类
          const kind = sym.kind;
          if (
            kind === vscode.SymbolKind.Function ||
            kind === vscode.SymbolKind.Method ||
            kind === vscode.SymbolKind.Class ||
            kind === vscode.SymbolKind.Constructor
          ) {
            return sym.name;
          }
        }
      }
      return undefined;
    }

    return findEnclosing(symbols, line);
  } catch {
    return undefined;
  }
}

/**
 * 获取书签行的上下各 3 行作为内容指纹
 */
function captureContextFingerprint(
  editor: vscode.TextEditor,
  line: number
): string {
  const doc = editor.document;
  const contextLines: string[] = [];
  for (let i = line - 3; i <= line + 3; i++) {
    if (i >= 0 && i < doc.lineCount) {
      contextLines.push(doc.lineAt(i).text);
    } else {
      contextLines.push(''); // 空行占位
    }
  }
  return JSON.stringify(contextLines);
}

/**
 * 从命令参数中提取 FlowGroup。
 * 树视图右键菜单传过来的是 FlowTreeItem，需要从中解出 group。
 */
function extractGroup(arg: unknown): FlowGroup | undefined {
  if (!arg) return undefined;
  // FlowTreeItem 包装了 group
  if (arg instanceof FlowTreeItem) {
    return arg.group;
  }
  // 直接就是 FlowGroup（从 QuickPick 等来源）
  const maybe = arg as FlowGroup;
  if (maybe.id && maybe.name && typeof maybe.order === 'number') {
    return maybe;
  }
  return undefined;
}

/**
 * 从命令参数中提取 FlowBookmark。
 * 树视图右键菜单传过来的是 FlowTreeItem，需要从中解出 bookmark。
 */
function extractBookmark(arg: unknown): FlowBookmark | undefined {
  if (!arg) return undefined;
  if (arg instanceof FlowTreeItem) {
    return arg.bookmark;
  }
  const maybe = arg as FlowBookmark;
  if (maybe.id && maybe.filePath && typeof maybe.line === 'number') {
    return maybe;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  // ─── 初始化核心组件 ──────────────────────────────

  const bookmarkManager = new BookmarkManager(context);
  const decorationManager = new DecorationManager(bookmarkManager);
  const flowTreeProvider = new FlowTreeProvider(bookmarkManager);

  // ─── 注册树视图 ─────────────────────────────────

  const treeView = vscode.window.createTreeView('codeFlow.flowTree', {
    treeDataProvider: flowTreeProvider,
    dragAndDropController: flowTreeProvider,
    canSelectMany: false,
  });

  // ─── 状态栏 ─────────────────────────────────────

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'codeFlow.nextInFlow';
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = () => {
    const activeGroup = bookmarkManager.getActiveGroup();
    const total = bookmarkManager.count;
    if (total === 0) {
      statusBarItem.text = `$(bookmark) Flow: ${activeGroup?.name ?? ''} - 无书签`;
      statusBarItem.tooltip = '使用 Alt+F9 添加书签';
    } else {
      const idx = bookmarkManager.getCurrentIndex();
      const current = bookmarkManager.getCurrent();
      statusBarItem.text = `$(debug-step-over) ${activeGroup?.name ?? ''}: ${idx + 1}/${total}`;
      if (current?.label) {
        statusBarItem.text += ` - ${current.label}`;
      }
      statusBarItem.tooltip = `分组: ${activeGroup?.name ?? ''} — 步骤 ${idx + 1}/${total} — 点击跳转下一个 (F9)`;
    }
  };

  bookmarkManager.onDidChangeBookmarks(() => updateStatusBar());
  bookmarkManager.onDidChangeCurrentIndex(() => updateStatusBar());
  bookmarkManager.onDidChangeActiveGroup(() => updateStatusBar());
  bookmarkManager.onDidChangeGroups(() => updateStatusBar());
  updateStatusBar();
  statusBarItem.show();

  // ─── 命令：书签操作 ─────────────────────────────

  // Add After Current — 在当前书签之后插入 (Alt+Shift+F9)
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.addAfterCurrent', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const line = editor.selection.active.line;
      const character = editor.selection.active.character;
      const lineText = captureContextFingerprint(editor, line);
      const funcName = await getFunctionName(editor.document.uri, line);

      const result = bookmarkManager.addAfterCurrent(filePath, line, character, undefined, lineText, funcName);
      const activeGroup = bookmarkManager.getActiveGroup();
      if (result) {
        // 刷新所有可见编辑器的装饰（序号变化需要反映在所有编辑器中）
        for (const ed of vscode.window.visibleTextEditors) {
          decorationManager.updateEditorDecorations(ed);
        }
        // 跳转到新添加的书签
        bookmarkManager.goTo(result.id);
        navigateToBookmark(result, bookmarkManager, decorationManager);
        vscode.window.showInformationMessage(
          `✅ [${activeGroup?.name}] 书签 #${result.order + 1} 已插入`
        );
      } else {
        vscode.window.showInformationMessage(
          `⚠️ [${activeGroup?.name}] 该位置已有书签`
        );
      }
      decorationManager.updateEditorDecorations(editor);
    })
  );

  // Toggle Bookmark
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.toggleBookmark', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const line = editor.selection.active.line;
      const character = editor.selection.active.character;
      const lineText = captureContextFingerprint(editor, line);
      const funcName = await getFunctionName(editor.document.uri, line);

      const result = bookmarkManager.toggle(filePath, line, character, undefined, lineText, funcName);
      const activeGroup = bookmarkManager.getActiveGroup();
      if (result) {
        vscode.window.showInformationMessage(
          `✅ [${activeGroup?.name}] 流程书签 #${result.order + 1} 已添加`
        );
      } else {
        vscode.window.showInformationMessage(
          `🗑️ [${activeGroup?.name}] 书签已移除`
        );
      }
      decorationManager.updateEditorDecorations(editor);
    })
  );

  // Toggle Bookmark with Label
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.toggleBookmarkWithLabel',
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }

        const label = await vscode.window.showInputBox({
          prompt: '输入书签标签（描述此步骤）',
          placeHolder: '例如：用户登录验证',
          validateInput: (value) =>
            value.length > 100 ? '标签不能超过100个字符' : null,
        });

        if (label === undefined) {
          return;
        }

        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const line = editor.selection.active.line;
        const character = editor.selection.active.character;
        const lineText = captureContextFingerprint(editor, line);
        const funcName = await getFunctionName(editor.document.uri, line);

        const existing = bookmarkManager.findByLocation(filePath, line);
        if (existing) {
          bookmarkManager.rename(existing.id, label);
          vscode.window.showInformationMessage(`🏷️ 书签已重命名为: ${label}`);
        } else {
          bookmarkManager.add(filePath, line, character, label, lineText, funcName);
          vscode.window.showInformationMessage(`✅ 流程书签 "${label}" 已添加`);
        }
        decorationManager.updateEditorDecorations(editor);
      }
    )
  );

  // Next in Flow
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.nextInFlow', async () => {
      const bookmark = bookmarkManager.next();
      if (!bookmark) {
        const group = bookmarkManager.getActiveGroup();
        vscode.window.showInformationMessage(
          `[${group?.name}] 没有流程书签。使用 Alt+F9 添加。`
        );
        return;
      }
      await navigateToBookmark(bookmark, bookmarkManager, decorationManager);
    })
  );

  // Previous in Flow
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.previousInFlow', async () => {
      const bookmark = bookmarkManager.previous();
      if (!bookmark) {
        const group = bookmarkManager.getActiveGroup();
        vscode.window.showInformationMessage(
          `[${group?.name}] 没有流程书签。使用 Alt+F9 添加。`
        );
        return;
      }
      await navigateToBookmark(bookmark, bookmarkManager, decorationManager);
    })
  );

  // Jump to Bookmark (from tree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.jumpToBookmark',
      async (bookmark: FlowBookmark) => {
        if (!bookmark) {
          return;
        }
        // 确保该书签所属分组是活动分组
        if (bookmark.groupId !== bookmarkManager.getActiveGroupId()) {
          bookmarkManager.setActiveGroup(bookmark.groupId);
        }
        bookmarkManager.goTo(bookmark.id);
        await navigateToBookmark(bookmark, bookmarkManager, decorationManager);
      }
    )
  );

  // Go to Flow Start
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.goToFlowStart', async () => {
      const bookmark = bookmarkManager.goToStart();
      if (!bookmark) {
        vscode.window.showInformationMessage('没有流程书签。');
        return;
      }
      await navigateToBookmark(bookmark, bookmarkManager, decorationManager);
    })
  );

  // Remove Bookmark
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.removeBookmark',
      async (arg: unknown) => {
        const bookmark = extractBookmark(arg);
        if (!bookmark) {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            return;
          }
          const filePath = vscode.workspace.asRelativePath(editor.document.uri);
          const line = editor.selection.active.line;
          const existing = bookmarkManager.findByLocation(filePath, line);
          if (existing) {
            bookmarkManager.remove(existing.id);
            decorationManager.updateEditorDecorations(editor);
            vscode.window.showInformationMessage('🗑️ 书签已删除');
          }
          return;
        }
        bookmarkManager.remove(bookmark.id);
        decorationManager.updateDecorations();
        vscode.window.showInformationMessage('🗑️ 书签已删除');
      }
    )
  );

  // Clear All Bookmarks in Active Group
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.clearAllBookmarks', async () => {
      const group = bookmarkManager.getActiveGroup();
      if (bookmarkManager.count === 0) {
        vscode.window.showInformationMessage(
          `[${group?.name}] 没有书签需要清除。`
        );
        return;
      }

      const config = vscode.workspace.getConfiguration('codeFlow');
      const confirmBeforeClear = config.get<boolean>('confirmBeforeClear', true);

      if (confirmBeforeClear) {
        const answer = await vscode.window.showWarningMessage(
          `确定要清除 [${group?.name}] 中的所有 ${bookmarkManager.count} 个书签吗？`,
          { modal: true },
          '确定清除'
        );
        if (answer !== '确定清除') {
          return;
        }
      }

      bookmarkManager.clearActiveGroup();
      decorationManager.updateDecorations();
      vscode.window.showInformationMessage(
        `🗑️ [${group?.name}] 所有书签已清除`
      );
    })
  );

  // Rename Bookmark
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.renameBookmark',
      async (arg: unknown) => {
        const bookmark = extractBookmark(arg);
        if (!bookmark) {
          return;
        }

        const newLabel = await vscode.window.showInputBox({
          prompt: '输入新标签',
          placeHolder: '描述此步骤',
          value: bookmark.label || '',
        });

        if (newLabel !== undefined) {
          bookmarkManager.rename(bookmark.id, newLabel);
          vscode.window.showInformationMessage(
            `🏷️ 书签已重命名为: ${newLabel || '(未命名)'}`
          );
        }
      }
    )
  );

  // Move Up / Down
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.moveBookmarkUp',
      (arg: unknown) => {
        const bookmark = extractBookmark(arg);
        if (bookmark) {
          bookmarkManager.moveUp(bookmark.id);
          decorationManager.updateDecorations();
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.moveBookmarkDown',
      (arg: unknown) => {
        const bookmark = extractBookmark(arg);
        if (bookmark) {
          bookmarkManager.moveDown(bookmark.id);
          decorationManager.updateDecorations();
        }
      }
    )
  );

  // ─── 命令：分组操作 ─────────────────────────────

  // Create Group
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.createGroup', async () => {
      const name = await vscode.window.showInputBox({
        prompt: '输入分组名称',
        placeHolder: '例如：用户注册流程',
        validateInput: (value) => {
          if (!value.trim()) {
            return '分组名称不能为空';
          }
          if (value.length > 50) {
            return '名称不能超过50个字符';
          }
          return null;
        },
      });

      if (!name) {
        return;
      }

      const colors = [
        { label: '🔵 蓝色', color: '#29B6F6' },
        { label: '🔴 红色', color: '#FF7043' },
        { label: '🟣 紫色', color: '#AB47BC' },
        { label: '🟢 绿色', color: '#66BB6A' },
        { label: '🟠 橙色', color: '#FFA726' },
        { label: '🔷 深蓝', color: '#42A5F5' },
        { label: '🔻 深红', color: '#EF5350' },
        { label: '🩵 青色', color: '#26C6DA' },
      ];

      const colorPick = await vscode.window.showQuickPick(
        colors.map((c) => ({
          label: c.label,
          description: c.color,
        })),
        { placeHolder: '选择分组颜色（可选，ESC 跳过）' }
      );

      const color = colorPick
        ? colors.find((c) => c.label === colorPick.label)?.color
        : undefined;

      bookmarkManager.createGroup(name.trim(), color);
      vscode.window.showInformationMessage(`📁 分组 "${name}" 已创建`);
    })
  );

  // Create Sub-group
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.createSubGroup', async (arg: unknown) => {
      const parentGroup = extractGroup(arg);
      const parentId = parentGroup?.id;

      const name = await vscode.window.showInputBox({
        prompt: parentGroup
          ? `为 "${parentGroup.name}" 创建子分组`
          : '输入子分组名称',
        placeHolder: '例如：用户验证子流程',
        validateInput: (value) => {
          if (!value.trim()) return '分组名称不能为空';
          if (value.length > 50) return '名称不能超过50个字符';
          return null;
        },
      });
      if (!name) return;

      bookmarkManager.createGroup(name.trim(), undefined, undefined, parentId);
      vscode.window.showInformationMessage(
        `📁 子分组 "${name}" 已创建${parentGroup ? '在 "' + parentGroup.name + '" 中' : ''}`
      );
    })
  );

  // Set Active Group
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.setActiveGroup', async () => {
      const groups = bookmarkManager.getAllGroups();
      if (groups.length === 0) {
        vscode.window.showInformationMessage('没有分组。请先创建分组。');
        return;
      }

      const activeId = bookmarkManager.getActiveGroupId();
      const items = groups.map((g) => ({
        label: g.id === activeId ? `⭐ ${g.name}` : g.name,
        description: `${
          bookmarkManager.getBookmarksByGroup(g.id).length
        } 书签`,
        detail: g.id === activeId ? '当前活动分组' : '',
        groupId: g.id,
      }));

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要激活的分组',
      });

      if (pick) {
        bookmarkManager.setActiveGroup(pick.groupId);
        decorationManager.updateDecorations();
        const group = bookmarkManager.getActiveGroup();
        vscode.window.showInformationMessage(
          `⭐ 已切换到分组: ${group?.name}`
        );
      }
    })
  );

  // Rename Group
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.renameGroup',
      async (arg: unknown) => {
        let group = extractGroup(arg);
        if (!group) {
          const groups = bookmarkManager.getAllGroups();
          const pick = await vscode.window.showQuickPick(
            groups.map((g) => ({ label: g.name, groupId: g.id })),
            { placeHolder: '选择要重命名的分组' }
          );
          if (!pick) {
            return;
          }
          group = bookmarkManager.getGroup(pick.groupId)!;
        }

        const newName = await vscode.window.showInputBox({
          prompt: '输入新分组名称',
          value: group.name,
          validateInput: (value) =>
            !value.trim() ? '名称不能为空' : null,
        });

        if (newName) {
          bookmarkManager.renameGroup(group.id, newName.trim());
          vscode.window.showInformationMessage(
            `📁 分组已重命名为: ${newName}`
          );
        }
      }
    )
  );

  // Set Group Color
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.setGroupColor',
      async (arg: unknown) => {
        let group = extractGroup(arg);
        if (!group) {
          const groups = bookmarkManager.getAllGroups();
          const pick = await vscode.window.showQuickPick(
            groups.map((g) => ({ label: g.name, groupId: g.id })),
            { placeHolder: '选择要设置颜色的分组' }
          );
          if (!pick) {
            return;
          }
          group = bookmarkManager.getGroup(pick.groupId)!;
        }

        const colors = [
          { label: '🔵 蓝色', color: '#29B6F6' },
          { label: '🔴 红色', color: '#FF7043' },
          { label: '🟣 紫色', color: '#AB47BC' },
          { label: '🟢 绿色', color: '#66BB6A' },
          { label: '🟠 橙色', color: '#FFA726' },
          { label: '🔷 深蓝', color: '#42A5F5' },
          { label: '🔻 深红', color: '#EF5350' },
          { label: '🩵 青色', color: '#26C6DA' },
          { label: '🟪 深紫', color: '#7E57C2' },
          { label: '💗 粉色', color: '#EC407A' },
          { label: '🟤 棕色', color: '#8D6E63' },
          { label: '⚪ 灰色', color: '#78909C' },
        ];

        const pick = await vscode.window.showQuickPick(colors, {
          placeHolder: `为 "${group.name}" 选择颜色`,
        });

        if (pick) {
          bookmarkManager.setGroupColor(group.id, pick.color);
          decorationManager.updateDecorations();
          vscode.window.showInformationMessage(
            `🎨 分组 "${group.name}" 颜色已更新`
          );
        }
      }
    )
  );

  // Delete Group
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.deleteGroup',
      async (arg: unknown) => {
        let group = extractGroup(arg);
        if (!group) {
          const groups = bookmarkManager.getAllGroups();
          if (groups.length <= 1) {
            vscode.window.showWarningMessage('至少需要保留一个分组。');
            return;
          }
          const pick = await vscode.window.showQuickPick(
            groups.map((g) => ({
              label: g.name,
              description: `${
                bookmarkManager.getBookmarksByGroup(g.id).length
              } 书签`,
              groupId: g.id,
            })),
            { placeHolder: '选择要删除的分组' }
          );
          if (!pick) {
            return;
          }
          group = bookmarkManager.getGroup(pick.groupId)!;
        }

        const bookmarkCount = bookmarkManager.getBookmarksByGroup(
          group.id
        ).length;

        const confirmMsg =
          bookmarkCount > 0
            ? `确定要删除分组 "${group.name}" 及其 ${bookmarkCount} 个书签吗？此操作不可撤销。`
            : `确定要删除分组 "${group.name}" 吗？`;

        const answer = await vscode.window.showWarningMessage(
          confirmMsg,
          { modal: true },
          '确定删除'
        );

        if (answer === '确定删除') {
          bookmarkManager.deleteGroup(group.id);
          decorationManager.updateDecorations();
          vscode.window.showInformationMessage(
            `🗑️ 分组 "${group.name}" 已删除`
          );
        }
      }
    )
  );

  // Move Group Up / Down
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.moveGroupUp',
      (arg: unknown) => {
        const group = extractGroup(arg);
        if (group) {
          bookmarkManager.moveGroupUp(group.id);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.moveGroupDown',
      (arg: unknown) => {
        const group = extractGroup(arg);
        if (group) {
          bookmarkManager.moveGroupDown(group.id);
        }
      }
    )
  );

  // Hide / Unhide Group
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.hideGroup',
      (arg: unknown) => {
        const group = extractGroup(arg);
        if (group) {
          bookmarkManager.hideGroup(group.id);
          decorationManager.updateDecorations();
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.unhideGroup',
      (arg: unknown) => {
        const group = extractGroup(arg);
        if (group) {
          bookmarkManager.unhideGroup(group.id);
          decorationManager.updateDecorations();
        }
      }
    )
  );

  // Open Associated Markdown（按分组关联/打开 md 文件）
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.importFlowMD',
      async (arg: unknown) => {
        const targetGroup = extractGroup(arg);
        if (!targetGroup) {
          vscode.window.showErrorMessage('请从分组的按钮触发');
          return;
        }

        let mdPath = targetGroup.mdPath;

        // 如果没有关联 md 文件，引导用户选择
        if (!mdPath) {
          const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { Markdown: ['md'] },
            openLabel: `为 "${targetGroup.name}" 选择 Markdown 文件`,
          });
          if (!files || files.length === 0) return;

          const relativePath = vscode.workspace.asRelativePath(files[0], false);
          mdPath = relativePath === files[0].fsPath
            ? files[0].fsPath
            : relativePath;
          bookmarkManager.setGroupMdPath(targetGroup.id, mdPath);
        }

        // 打开 md 文件
        let mdUri: vscode.Uri;
        if (/^[a-zA-Z]:[\\/]/.test(mdPath) || mdPath.startsWith('/')) {
          mdUri = vscode.Uri.file(mdPath);
        } else {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开工作区');
            return;
          }
          mdUri = vscode.Uri.joinPath(workspaceFolder.uri, mdPath);
        }

        try {
          const doc = await vscode.workspace.openTextDocument(mdUri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch {
          bookmarkManager.setGroupMdPath(targetGroup.id, '');
          vscode.window.showErrorMessage(
            `无法打开: ${mdPath}，请重新选择文件`
          );
        }
      }
    )
  );

  // Export / Import Bookmarks
  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.exportBookmarks', async () => {
      const groups = bookmarkManager.getAllGroups();
      const bookmarks = bookmarkManager.getAll();
      const state = {
        version: 1,
        exportedAt: new Date().toISOString(),
        groups,
        bookmarks,
        activeGroupId: bookmarkManager.getActiveGroupId(),
      };

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('code-flow-bookmarks.json'),
        filters: { 'JSON Files': ['json'] },
        saveLabel: '导出书签',
      });
      if (!uri) return;

      const data = Buffer.from(JSON.stringify(state, null, 2), 'utf-8');
      await vscode.workspace.fs.writeFile(uri, data);
      vscode.window.showInformationMessage(
        `✅ 已导出 ${groups.length} 个分组、${bookmarks.length} 个书签`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.importBookmarks', async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'JSON Files': ['json'] },
        openLabel: '导入书签',
      });
      if (!files || files.length === 0) return;

      try {
        const data = await vscode.workspace.fs.readFile(files[0]);
        const state = JSON.parse(Buffer.from(data).toString('utf-8'));

        if (!state.groups || !state.bookmarks) {
          vscode.window.showErrorMessage('无效的书签文件格式');
          return;
        }

        const answer = await vscode.window.showWarningMessage(
          `将导入 ${state.groups.length} 个分组、${state.bookmarks.length} 个书签，当前数据将被替换。确认？`,
          { modal: true },
          '确认导入'
        );
        if (answer !== '确认导入') return;

        // 直接替换内部数据
        bookmarkManager.importState(state);
        decorationManager.refreshDecorationTypes();
        vscode.window.showInformationMessage(
          `✅ 已导入 ${state.groups.length} 个分组、${state.bookmarks.length} 个书签`
        );
      } catch {
        vscode.window.showErrorMessage('无法读取或解析文件');
      }
    })
  );

  // Clear Group Bookmarks
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeFlow.clearGroupBookmarks',
      (arg: unknown) => {
        const group = extractGroup(arg);
        if (group) {
          const count = bookmarkManager.getBookmarksByGroup(group.id).length;
          if (count === 0) {
            vscode.window.showInformationMessage(`"${group.name}" 中没有书签`);
            return;
          }
          bookmarkManager.clearGroupBookmarks(group.id);
          decorationManager.updateDecorations();
          vscode.window.showInformationMessage(
            `🗑️ 已清除 "${group.name}" 中的 ${count} 个书签`
          );
        }
      }
    )
  );

  // ─── 命令：设置菜单 ─────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('codeFlow.openSettingsMenu', async () => {
      const activeGroup = bookmarkManager.getActiveGroup();
      const options: vscode.QuickPickItem[] = [
        {
          label: '$(color-mode) 高亮样式',
          description: `当前: ${getConfig('lineHighlightStyle')}`,
          detail: '设置书签行的高亮样式',
        },
        {
          label: '$(symbol-color) 高亮颜色',
          description: '书签颜色、活动位置颜色、透明度',
          detail: '打开设置页面',
        },
        {
          label: '$(lightbulb) 闪烁高亮',
          description: `当前: ${getConfig('flashHighlight') ? '开启' : '关闭'}`,
          detail: '跳转时短暂高亮目标行',
        },
        {
          label: '$(file) 跨文件跳转',
          description: `当前: ${getConfig('allowCrossFileJump') ? '允许' : '禁止'}`,
          detail: '允许流程跳转时跨越文件',
        },
        {
          label: '$(list-ordered) 显示序号',
          description: `当前: ${getConfig('showLineNumbers') ? '显示' : '隐藏'}`,
          detail: '在装订线图标中显示流程序号',
        },
        {
          label: '$(folder) 当前分组',
          description: `活动分组: ${activeGroup?.name ?? '无'}`,
          detail: '切换活动分组',
        },
      ];

      const pick = await vscode.window.showQuickPick(options, {
        placeHolder: '选择要修改的设置...',
        matchOnDescription: true,
      });

      if (!pick) {
        return;
      }

      if (pick.label.includes('高亮样式')) {
        const styles: vscode.QuickPickItem[] = [
          { label: 'background', description: '背景色高亮' },
          { label: 'left-border', description: '左侧边框高亮' },
          { label: 'underline', description: '下划线高亮' },
          { label: 'outline', description: '轮廓高亮' },
        ];
        const style = await vscode.window.showQuickPick(styles, {
          placeHolder: '选择高亮样式',
        });
        if (style) {
          await setConfig('lineHighlightStyle', style.label);
          decorationManager.refreshDecorationTypes();
        }
      } else if (pick.label.includes('高亮颜色')) {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'codeFlow.highlightColor'
        );
      } else if (pick.label.includes('闪烁高亮')) {
        const current = vscode.workspace
          .getConfiguration('codeFlow')
          .get<boolean>('flashHighlight', true);
        await setConfig('flashHighlight', !current);
        vscode.window.showInformationMessage(
          `闪烁高亮已${!current ? '开启' : '关闭'}`
        );
      } else if (pick.label.includes('跨文件跳转')) {
        const current = vscode.workspace
          .getConfiguration('codeFlow')
          .get<boolean>('allowCrossFileJump', true);
        await setConfig('allowCrossFileJump', !current);
        vscode.window.showInformationMessage(
          `跨文件跳转已${!current ? '允许' : '禁止'}`
        );
      } else if (pick.label.includes('显示序号')) {
        const current = vscode.workspace
          .getConfiguration('codeFlow')
          .get<boolean>('showLineNumbers', true);
        await setConfig('showLineNumbers', !current);
        decorationManager.refreshDecorationTypes();
        decorationManager.updateDecorations();
        vscode.window.showInformationMessage(
          `装订线序号已${!current ? '显示' : '隐藏'}`
        );
      } else if (pick.label.includes('当前分组')) {
        await vscode.commands.executeCommand('codeFlow.setActiveGroup');
      }
    })
  );

  // ─── 事件监听 ───────────────────────────────────

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        decorationManager.updateEditorDecorations(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const filePath = vscode.workspace.asRelativePath(event.document.uri);

      // 追踪行号变化，让书签跟随代码移动
      for (const change of event.contentChanges) {
        const oldEndLine = change.range.end.line;
        const newLineCount = change.text.split('\n').length - 1;
        const newEndLine = change.range.start.line + newLineCount;

        bookmarkManager.onDocumentChanged(
          filePath,
          change.range.start.line,
          oldEndLine,
          newEndLine
        );
      }

      const editor = vscode.window.activeTextEditor;
      if (
        editor &&
        event.document.uri.toString() === editor.document.uri.toString()
      ) {
        decorationManager.updateEditorDecorations(editor);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeFlow')) {
        decorationManager.refreshDecorationTypes();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      decorationManager.updateEditorDecorations(event.textEditor);
    })
  );

  // ─── 初始状态 ───────────────────────────────────

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    decorationManager.updateEditorDecorations(activeEditor);
  }

  // ─── 清理 ───────────────────────────────────────

  context.subscriptions.push({
    dispose: () => {
      decorationManager.dispose();
      statusBarItem.dispose();
    },
  });

  const activeGroup = bookmarkManager.getActiveGroup();
  vscode.window.showInformationMessage(
    `🚀 Code Flow 已激活 — 分组: ${activeGroup?.name} | Alt+F9 添加书签, F9 流程跳转`
  );
}

// ─── 导航辅助函数 ─────────────────────────────────

async function navigateToBookmark(
  bookmark: FlowBookmark,
  bookmarkManager: BookmarkManager,
  decorationManager: DecorationManager
): Promise<void> {
  const config = vscode.workspace.getConfiguration('codeFlow');
  const allowCrossFile = config.get<boolean>('allowCrossFileJump', true);
  const scrollAnimation = config.get<string>('scrollAnimation', 'all');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('没有打开的工作区');
    return;
  }

  const fileUri = vscode.Uri.joinPath(
    workspaceFolders[0].uri,
    bookmark.filePath
  );

  const currentEditor = vscode.window.activeTextEditor;
  const isSameFile =
    currentEditor &&
    currentEditor.document.uri.toString() === fileUri.toString();

  if (!isSameFile && !allowCrossFile) {
    vscode.window.showInformationMessage(
      `跨文件跳转已禁用。书签在: ${bookmark.filePath}:${bookmark.line + 1}`
    );
    return;
  }

  let editor: vscode.TextEditor;

  if (isSameFile && currentEditor) {
    editor = currentEditor;
  } else {
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      });
    } catch {
      vscode.window.showErrorMessage(`无法打开文件: ${bookmark.filePath}`);
      return;
    }
  }

  // 多行上下文指纹恢复：通过上下各3行定位书签
  const docLineCount = editor.document.lineCount;
  let actualLine = bookmark.line;

  if (bookmark.lineFingerprint) {
    try {
      const ctxLines: string[] = JSON.parse(bookmark.lineFingerprint);
      const keyLine = (ctxLines[3] || '').trim(); // 书签行在索引3

      if (keyLine) {
        const currentLine = editor.document.lineAt(
          Math.min(bookmark.line, docLineCount - 1)
        ).text.trim();

        if (currentLine !== keyLine) {
          // 搜索附近 50 行，用多行上下文评分
          const searchStart = Math.max(0, bookmark.line - 25);
          const searchEnd = Math.min(docLineCount - 1, bookmark.line + 25);
          let bestScore = 0;
          let bestLine = bookmark.line;

          for (let i = searchStart; i <= searchEnd; i++) {
            if (editor.document.lineAt(i).text.trim() === keyLine) {
              // 找到关键行，计算上下文匹配分数
              let score = 1;
              for (let j = 0; j < 7; j++) {
                if (j === 3) continue; // 跳过关键行（已匹配）
                const ctxLine = (ctxLines[j] || '').trim();
                const actualCtxLine = (() => {
                  const idx = i + (j - 3);
                  if (idx >= 0 && idx < docLineCount) {
                    return editor.document.lineAt(idx).text.trim();
                  }
                  return '';
                })();
                if (ctxLine && ctxLine === actualCtxLine) {
                  score++;
                }
              }
              if (score > bestScore) {
                bestScore = score;
                bestLine = i;
              }
              // 完美匹配则直接采用
              if (score >= 5) break;
            }
          }

          if (bestScore > 1) {
            actualLine = bestLine;
            bookmark.line = actualLine;
          } else if (actualLine !== bookmark.line) {
            // 没找到好的匹配，保持原位置
          } else {
            vscode.window.showWarningMessage(
              `⚠️ 书签 "${bookmark.label || '未命名'}" 所在代码已变更，在附近未找到匹配`
            );
          }
        }
      }
    } catch {
      // 指纹解析失败，使用原行号
    }
  }

  if (actualLine < 0 || actualLine >= docLineCount) {
    vscode.window.showWarningMessage(
      `书签行号 ${bookmark.line + 1} 不再有效（文件可能已修改）`
    );
    return;
  }

  const range = new vscode.Range(actualLine, 0, actualLine, 0);
  editor.selection = new vscode.Selection(range.start, range.start);

  if (scrollAnimation !== 'none') {
    if (
      scrollAnimation === 'all' ||
      (scrollAnimation === 'sameFileOnly' && isSameFile)
    ) {
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } else {
      editor.revealRange(range, vscode.TextEditorRevealType.Default);
    }
  }

  decorationManager.flashHighlight(editor, bookmark.line);
  decorationManager.updateEditorDecorations(editor);

  const idx = bookmarkManager.getCurrentIndex();
  const total = bookmarkManager.count;
  const group = bookmarkManager.getActiveGroup();
  vscode.window.showInformationMessage(
    `📍 [${group?.name}] 步骤 ${idx + 1}/${total}${
      bookmark.label ? `: ${bookmark.label}` : ''
    } — ${bookmark.filePath}:${bookmark.line + 1}`
  );
}

// ─── 配置辅助函数 ─────────────────────────────────

async function setConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration('codeFlow')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

function getConfig(key: string): string {
  return String(vscode.workspace.getConfiguration('codeFlow').get(key, ''));
}

export function deactivate(): void {
  // 清理
}
