import * as vscode from 'vscode';
import { FlowBookmark, HighlightStyle, GutterIconSize } from './types';
import { BookmarkManager } from './bookmarkManager';

/**
 * 装饰管理器 — 每个书签独立 decoration type，使用 gutterIconPath 在断点区域显示图标
 */
export class DecorationManager {
  private flashDecorationType: vscode.TextEditorDecorationType;
  private flashTimeout: ReturnType<typeof setTimeout> | null = null;
  /** 每个书签 ID 对应一个独立的装饰类型（用于在装订线显示不同序号图标） */
  private decorationTypeMap: Map<string, vscode.TextEditorDecorationType> = new Map();

  constructor(private bookmarkManager: BookmarkManager) {
    this.flashDecorationType = this.createFlashDecoration();

    // 书签变化时（增删、拖拽排序）刷新装饰
    bookmarkManager.onDidChangeBookmarks(() => {
      this.clearDecorationTypeCache();
      this.updateDecorations();
    });
  }

  // ─── 获取 / 创建装饰类型 ────────────────────────

  private clearDecorationTypeCache(): void {
    for (const type of this.decorationTypeMap.values()) {
      type.dispose();
    }
    this.decorationTypeMap.clear();
  }

  private getOrCreateDecorationType(
    bookmark: FlowBookmark,
    isCurrent: boolean,
    groupColor?: string
  ): vscode.TextEditorDecorationType {
    const key = bookmark.id;
    if (this.decorationTypeMap.has(key)) {
      return this.decorationTypeMap.get(key)!;
    }

    const gutterIcon = this.generateGutterIcon(
      bookmark.order,
      isCurrent,
      groupColor
    );

    const config = vscode.workspace.getConfiguration('codeFlow');
    const style = config.get<HighlightStyle>('lineHighlightStyle', 'background');
    const color = isCurrent
      ? config.get<string>('highlightColor', '#FFB300')
      : groupColor || config.get<string>('bookmarkColor', '#29B6F6');
    const opacity = config.get<number>('opacity', 0.3);
    const effectiveOpacity = isCurrent ? Math.min(opacity + 0.15, 1) : opacity;

    const type = vscode.window.createTextEditorDecorationType({
      ...this.getHighlightOptions(style, color, effectiveOpacity),
      gutterIconPath: gutterIcon,
      gutterIconSize: 'contain',
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.decorationTypeMap.set(key, type);
    return type;
  }

  // ─── 创建装饰类型 ──────────────────────────────

  private createFlashDecoration(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 179, 0, 0.5)',
      isWholeLine: true,
      borderRadius: '2px',
    });
  }

  private getHighlightOptions(
    style: HighlightStyle,
    color: string,
    opacity: number
  ): vscode.DecorationRenderOptions {
    const rgba = this.hexToRgba(color, opacity);

    switch (style) {
      case 'background':
        return {
          backgroundColor: rgba,
          isWholeLine: true,
        };
      case 'left-border':
        return {
          borderColor: color,
          borderStyle: 'solid',
          borderWidth: '0 0 0 3px',
          isWholeLine: true,
        };
      case 'underline':
        return {
          borderColor: color,
          borderStyle: 'solid',
          borderWidth: '0 0 2px 0',
          isWholeLine: true,
        };
      case 'outline':
        return {
          backgroundColor: rgba,
          borderColor: color,
          borderStyle: 'solid',
          borderWidth: '1px',
          borderRadius: '3px',
          isWholeLine: true,
        };
    }
  }

  // ─── 生成装订线图标 ────────────────────────────

  private generateGutterIcon(
    order: number,
    isCurrent: boolean,
    groupColor?: string
  ): vscode.Uri {
    const config = vscode.workspace.getConfiguration('codeFlow');
    const size = config.get<GutterIconSize>('gutterIconSize', 'medium');
    const showNumbers = config.get<boolean>('showLineNumbers', true);

    const sizes: Record<GutterIconSize, number> = {
      small: 14,
      medium: 16,
      large: 20,
    };
    const dim = sizes[size];
    const fontSize = dim * 0.55;
    const numStr = String(order + 1);

    const activeColor = config.get<string>('highlightColor', '#FFB300');
    const defaultColor = config.get<string>('bookmarkColor', '#29B6F6');

    const bgColor = isCurrent
      ? activeColor
      : (groupColor || defaultColor);
    const textColor = '#ffffff';

    let svg = '';
    svg += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}">`;

    // 背景圆
    svg += `<circle cx="${dim / 2}" cy="${dim / 2}" r="${dim / 2 - 1.5}" fill="${bgColor}" />`;

    if (showNumbers) {
      svg += `<text x="${dim / 2}" y="${dim / 2}" text-anchor="middle" `
        + `dominant-baseline="central" fill="${textColor}" `
        + `font-size="${fontSize}px" font-family="system-ui, -apple-system, sans-serif" `
        + `font-weight="bold">${numStr}</text>`;
    } else {
      svg += `<path d="M${dim * 0.35} ${dim * 0.2} L${dim * 0.35} ${dim * 0.8} `
        + `L${dim * 0.5} ${dim * 0.65} L${dim * 0.65} ${dim * 0.8} `
        + `L${dim * 0.65} ${dim * 0.2} Z" fill="${textColor}" />`;
    }

    svg += '</svg>';

    return this.svgToUri(svg);
  }

  private svgToUri(svg: string): vscode.Uri {
    const encoded = btoa(svg);
    return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
  }

  // ─── 应用装饰 ──────────────────────────────────

  updateDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    this.updateEditorDecorations(editor);
  }

  updateEditorDecorations(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const filePath = vscode.workspace.asRelativePath(doc.uri);

    const bookmarks = this.bookmarkManager.getByFile(filePath);
    const currentBookmark = this.bookmarkManager.getCurrent();
    const activeGroup = this.bookmarkManager.getActiveGroup();

    // 收集当前文件的所有书签 ID，用于清理旧的 decoration type
    const currentBookmarkIds = new Set(bookmarks.map((b) => b.id));

    // 为每个书签创建/获取独立的 decoration type 并应用
    for (const bookmark of bookmarks) {
      if (bookmark.line < 0 || bookmark.line >= doc.lineCount) {
        continue;
      }

      // 跳过隐藏分组中的书签
      const bmGroup = this.bookmarkManager.getGroup(bookmark.groupId);
      if (bmGroup?.hidden) {
        continue;
      }

      const isCurrent =
        currentBookmark !== undefined && currentBookmark.id === bookmark.id;

      const decorationType = this.getOrCreateDecorationType(
        bookmark,
        isCurrent,
        activeGroup?.color
      );

      const range = new vscode.Range(bookmark.line, 0, bookmark.line, 0);
      const options: vscode.DecorationOptions = {
        range,
        hoverMessage: this.buildHoverMessage(bookmark, isCurrent),
      };

      editor.setDecorations(decorationType, [options]);
    }

    // 清理不再存在的书签对应的 decoration type
    for (const [id, type] of this.decorationTypeMap) {
      if (!currentBookmarkIds.has(id)) {
        type.dispose();
        this.decorationTypeMap.delete(id);
      }
    }
  }

  flashHighlight(editor: vscode.TextEditor, line: number): void {
    const config = vscode.workspace.getConfiguration('codeFlow');
    if (!config.get<boolean>('flashHighlight', true)) {
      return;
    }

    const duration = config.get<number>('flashDuration', 600);

    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
      editor.setDecorations(this.flashDecorationType, []);
    }

    const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
    editor.setDecorations(this.flashDecorationType, [range]);

    this.flashTimeout = setTimeout(() => {
      editor.setDecorations(this.flashDecorationType, []);
      this.flashTimeout = null;
    }, duration);
  }

  // ─── 悬停消息 ──────────────────────────────────

  private buildHoverMessage(
    bookmark: FlowBookmark,
    isCurrent: boolean
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    const status = isCurrent ? '📍 **当前流程位置**' : '';
    const label = bookmark.label ? `\`${bookmark.label}\`` : '未命名';
    const group = this.bookmarkManager.getGroup(bookmark.groupId);
    const displayOrder = bookmark.order + 1;

    md.appendMarkdown(
      `### 步骤 ${displayOrder} ${status}\n\n`
      + `| 属性 | 值 |\n|------|----|\n`
      + `| 标签 | ${label} |\n`
      + `| 分组 | ${group?.name ?? '未知'} |\n`
      + `| 文件 | \`${bookmark.filePath}\` |\n`
      + `| 行号 | ${bookmark.line + 1} |\n`
      + `| 流程顺序 | ${displayOrder}/${this.bookmarkManager.count} |`
    );

    return md;
  }

  // ─── 配置刷新 ──────────────────────────────────

  refreshDecorationTypes(): void {
    // 清除所有旧的 decoration type
    for (const type of this.decorationTypeMap.values()) {
      type.dispose();
    }
    this.decorationTypeMap.clear();
    this.flashDecorationType.dispose();
    this.flashDecorationType = this.createFlashDecoration();
    this.updateDecorations();
  }

  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  dispose(): void {
    if (this.flashTimeout) {
      clearTimeout(this.flashTimeout);
    }
    this.flashDecorationType.dispose();
    for (const type of this.decorationTypeMap.values()) {
      type.dispose();
    }
    this.decorationTypeMap.clear();
  }
}
