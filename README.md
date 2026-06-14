# Code Flow Bookmarks 🚀

为**梳理代码流程**而生的 VSCode 插件。像打断点一样在代码行上打书签，按**自定义顺序**逐个跳转，帮你追踪和理解代码执行流程。

---

## ✨ 核心功能

### 📁 流程分组

每个**业务流程**对应一个分组，分组之间互不干扰：

- 创建分组并自定义颜色（12 色可选）
- ⭐ 活动分组标识，F9 导航仅在活动分组内进行
- 分组拖拽排序，👁 一键隐藏分组下所有书签
- 每个分组可关联一个 Markdown 文件（📥 一键打开）

### 🎯 流程书签

- `Alt+F9` 添加/移除书签，`Alt+Shift+F9` 在当前步骤后插入
- 装订线显示带序号的圆形图标（不挤占代码布局）
- 当前流程步骤金色高亮，跳转时闪烁目标行
- 支持自定义标签命名

### ⏭️ 流程跳转

- `F9` 下一站 / `Shift+F9` 上一站，按自定义顺序逐个跳转
- `Ctrl+F9` 跳到流程起点
- 跨文件自动跳转，滚动动画可配置

### 📋 侧边栏树视图

- 两级树：分组 → 书签
- 拖拽排序（组内书签 + 分组之间）
- 每个分组行内联按钮：📥 关联 md / ✕ 清除书签 / 👁 隐藏
- 右键菜单：跳转、重命名、上移、下移、删除、颜色

### 🔍 智能追踪

- **实时行号追踪** — 编辑代码时书签自动跟随
- **内容指纹恢复** — 即使关闭 VSCode 后代码被 git pull 修改，导航时自动通过上下文（上下各 3 行）找回书签位置

---

## ⌨️ 快捷键

| 快捷键 | 命令 |
|--------|------|
| `Alt+F9` | 切换书签（添加/移除） |
| `Alt+Shift+F9` | 在当前步骤之后插入书签 |
| `F9` | 下一个流程步骤 |
| `Shift+F9` | 上一个流程步骤 |
| `Ctrl+F9` | 跳到流程起点 |
| `Ctrl+Alt+F9` | 添加带标签的书签 |
| `Ctrl+Shift+F9` | 清除活动分组所有书签 |

---

## 🎮 使用场景

```
1. 阅读代码，找到流程入口 → Alt+F9 打书签 #1
2. F9 跳到下一步 → Alt+Shift+F9 在 #1 后面插入 #2
3. 继续梳理 → 书签 #3, #4, #5...
4. 侧边栏拖拽微调顺序
5. 换个业务流程 → 创建新分组，自动切换
6. 给分组关联 md 笔记 → 📥 一键打开参考文档
```

---

## ⚙️ 配置项

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `codeFlow.lineHighlight` | `true` | 是否高亮书签行 |
| `codeFlow.lineHighlightStyle` | `background` | 高亮样式：background / left-border / underline / outline |
| `codeFlow.highlightColor` | `#FFB300` | 当前流程位置的高亮颜色 |
| `codeFlow.bookmarkColor` | `#29B6F6` | 普通书签颜色 |
| `codeFlow.opacity` | `0.3` | 高亮透明度 |
| `codeFlow.flashHighlight` | `true` | 跳转时闪烁高亮 |
| `codeFlow.flashDuration` | `600` | 闪烁时长（毫秒） |
| `codeFlow.scrollAnimation` | `all` | 滚动动画：none / sameFileOnly / all |
| `codeFlow.allowCrossFileJump` | `true` | 允许跨文件跳转 |
| `codeFlow.showLineNumbers` | `true` | 装订线图标中显示序号 |
| `codeFlow.gutterIconSize` | `medium` | 图标大小：small / medium / large |
| `codeFlow.confirmBeforeClear` | `true` | 清除书签前确认 |

---

## 📁 项目结构

```
code-flow-bookmarks/
├── src/
│   ├── extension.ts           # 扩展入口：命令注册、事件监听
│   ├── types.ts               # 类型定义
│   ├── bookmarkManager.ts     # 书签管理器：CRUD、排序、持久化、行号追踪
│   ├── decorationManager.ts   # 装饰管理器：装订线图标、行高亮
│   └── flowTreeProvider.ts    # 树视图：两级树、拖拽排序
├── package.json               # 扩展清单
├── tsconfig.json              # TypeScript 配置
└── .vscode/                   # 调试配置
```

## 🔧 开发

```bash
npm install        # 安装依赖
npm run compile    # 编译
npm run watch      # 监听模式
npx vsce package   # 打包 .vsix
```

## 📄 License

MIT
