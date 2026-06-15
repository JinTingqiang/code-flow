import * as vscode from 'vscode';

/**
 * 流程分组 — 一个业务流程 = 一个分组
 */
export interface FlowGroup {
  /** 唯一标识符 */
  id: string;
  /** 分组名称 */
  name: string;
  /** 父分组 ID（空 = 顶级分组） */
  parentId?: string;
  /** 分组颜色 */
  color?: string;
  /** 分组排序 */
  order: number;
  /** 是否隐藏 */
  hidden: boolean;
  /** 关联的 Markdown 文件路径 */
  mdPath?: string;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 流程书签 — 属于某个分组，在分组内有序
 */
export interface FlowBookmark {
  /** 唯一标识符 */
  id: string;
  /** 所属分组 ID */
  groupId: string;
  /** 工作区相对文件路径 */
  filePath: string;
  /** 0-based 行号 */
  line: number;
  /** 0-based 字符位置 */
  character: number;
  /** 行内容指纹（用于跨会话恢复定位） */
  lineFingerprint?: string;
  /** 所在函数/方法名（自动检测） */
  functionName?: string;
  /** 可选的自定义标签 */
  label?: string;
  /** 在分组内的流程顺序（从0开始） */
  order: number;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 书签管理器持久化状态
 */
export interface BookmarksState {
  /** 所有分组 */
  groups: FlowGroup[];
  /** 所有书签 */
  bookmarks: FlowBookmark[];
  /** 当前活动分组 ID（空字符串表示无分组） */
  activeGroupId: string;
  /** 当前导航到的书签 ID（-1 表示未开始） */
  currentIndex: number;
  /** 全局书签顺序号 */
  nextOrder: number;
}

/**
 * 装饰类型枚举
 */
export enum BookmarkDecorationType {
  Normal = 'normal',
  Active = 'active',
  Flash = 'flash',
}

/**
 * 行高亮样式
 */
export type HighlightStyle = 'background' | 'left-border' | 'underline' | 'outline';

/**
 * 滚动动画模式
 */
export type ScrollAnimation = 'none' | 'sameFileOnly' | 'all';

/**
 * 图标大小
 */
export type GutterIconSize = 'small' | 'medium' | 'large';
