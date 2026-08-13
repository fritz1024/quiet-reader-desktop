// Sidebar with two views: 文件 (source folder tree) and 大纲 (outline of the
// file currently open). Split from chapter-render.js, which now delegates here.
import { state, $, chapterList, readerContainer } from './state.js';
import { escapeHtml, formatNumber } from './storage.js';
import { getBookWordCount } from './text-utils.js';
import { getMarkdownHeadings, markdownHeadingId } from './markdown.js';
import { getChapterBodyContent } from './parser.js';
// Cycles with loader.js/epub-viewer.js, same shape chapter-render.js already
// uses: every call below runs from a click handler, long after evaluation.
import { selectChapter } from './loader.js';
import { epubGoToChapter } from './epub-viewer.js';

// 'files' | 'outline'
export let sidebarTab = 'files';
// Keyed by folder path ("正文", "资料/大纲"); true means collapsed.
export let collapsedFolders = {};
// Keyed by "<file path>\0<heading index>"; true means collapsed. Scoped by file
// so collapsing a heading in one document does not affect another.
export let collapsedHeadings = {};

export function setSidebarTab(tab) {
  sidebarTab = tab === 'outline' ? 'outline' : 'files';
}

export function setCollapsedFolders(value) {
  collapsedFolders = value && typeof value === 'object' ? value : {};
  collapsedHeadings = {};
}

export function switchSidebarTab(tab, { render = true } = {}) {
  setSidebarTab(tab);
  const isOutline = sidebarTab === 'outline';
  $('sidebarTabFiles').classList.toggle('active', !isOutline);
  $('sidebarTabOutline').classList.toggle('active', isOutline);
  $('sidebarTabFiles').setAttribute('aria-selected', String(!isOutline));
  $('sidebarTabOutline').setAttribute('aria-selected', String(isOutline));
  $('sidebarPanelFiles').classList.toggle('hidden', isOutline);
  $('sidebarPanelOutline').classList.toggle('hidden', !isOutline);
  if (render) renderSidebar();
}

export function renderSidebar() {
  $('sidebarBookName').textContent = state.bookTitle || '未命名书籍';
  const wordTotal = getBookWordCount();
  $('bookWordCount').textContent = wordTotal > 0 ? `正文 ${formatNumber(wordTotal)} 字` : '';
  renderFileTree();
  renderOutline();
}

// --- 文件: folder tree over chapter.filename ------------------------------

// One node per source file, in first-appearance order, remembering which
// chapter to open. A file holding several internal chapters yields one node.
export function collectFiles() {
  const files = new Map();
  state.chapters.forEach((chapter, index) => {
    const key = String(chapter.filename || chapter.title || '本地文件');
    if (!files.has(key)) {
      files.set(key, { path: key, chapterIndex: index, chapterCount: 0, chapter });
    }
    files.get(key).chapterCount += 1;
  });
  return [...files.values()];
}

// Nest the flat paths into folders. Files sitting at the root stay at the root.
// Exported for scripts/test-sidebar-tree.cjs.
export function buildTree(files) {
  const root = { folders: new Map(), files: [], total: 0 };
  for (const file of files) {
    const segments = file.path.split('/');
    const filename = segments.pop();
    let node = root;
    node.total += 1;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      if (!node.folders.has(segment)) {
        node.folders.set(segment, { name: segment, path: prefix, folders: new Map(), files: [], total: 0 });
      }
      node = node.folders.get(segment);
      node.total += 1;
    }
    node.files.push({ ...file, filename });
  }
  return root;
}

function fileIcon(chapter) {
  if (chapter.isPdf) return 'fa-file-pdf';
  if (chapter.isEpubFile) return 'fa-book-open';
  if (chapter.isMarkdown) return 'fa-file-lines';
  return 'fa-file-lines';
}

function renderFileNode(file, container) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  // A file is active when the chapter being read comes from it.
  const currentChapter = state.chapters[state.currentChapter];
  const isActive = currentChapter && String(currentChapter.filename || '') === file.path;
  button.className = `chapter-item ${isActive ? 'active' : ''}`;
  const label = file.chapter.isEpubFile
    ? `${(file.chapter.epubChapters || []).length} 章`
    : (file.chapterCount > 1 ? `${file.chapterCount} 节` : '');
  button.innerHTML = `<i class="fa-solid ${fileIcon(file.chapter)}" style="flex:0 0 16px;font-size:11px;opacity:.5;text-align:center;padding-top:2px"></i>`
    + `<span class="chapter-name" title="${escapeHtml(file.path)}">${escapeHtml(file.filename)}</span>`
    + (label ? `<span style="margin-left:auto;padding-left:6px;font-size:10px;color:var(--muted)">${label}</span>` : '');
  button.addEventListener('click', () => openFile(file));
  li.appendChild(button);
  container.appendChild(li);
}

function renderFolderNode(folder, container) {
  const isCollapsed = collapsedFolders[folder.path] === true;

  const headerLi = document.createElement('li');
  const headerBtn = document.createElement('button');
  headerBtn.type = 'button';
  headerBtn.className = 'tree-folder';
  headerBtn.setAttribute('aria-expanded', String(!isCollapsed));
  headerBtn.innerHTML = `<i class="fa-solid fa-chevron-down tree-chevron ${isCollapsed ? 'collapsed' : ''}"></i>`
    + `<i class="fa-solid ${isCollapsed ? 'fa-folder' : 'fa-folder-open'}" style="flex:0 0 12px;font-size:11px;opacity:.55"></i>`
    + `<span class="tree-folder-name" title="${escapeHtml(folder.path)}">${escapeHtml(folder.name)}</span>`
    + `<span class="tree-count">${folder.total}</span>`;
  headerBtn.addEventListener('click', () => {
    collapsedFolders[folder.path] = !collapsedFolders[folder.path];
    renderFileTree();
  });
  headerLi.appendChild(headerBtn);
  container.appendChild(headerLi);

  const childLi = document.createElement('li');
  const childUl = document.createElement('ul');
  childUl.className = `tree-children tree-indent ${isCollapsed ? 'collapsed' : ''}`;
  renderTreeLevel(folder, childUl);
  childLi.appendChild(childUl);
  container.appendChild(childLi);
}

function renderTreeLevel(node, container) {
  for (const folder of node.folders.values()) renderFolderNode(folder, container);
  for (const file of node.files) renderFileNode(file, container);
}

export function renderFileTree() {
  chapterList.innerHTML = '';
  $('emptyChapterList').classList.toggle('hidden', state.chapters.length > 0);
  const files = collectFiles();
  updateSidebarCount(files);
  if (!files.length) return;
  renderTreeLevel(buildTree(files), chapterList);
}

// Only 正文 files are counted here. Reference files (设定/大纲/资料…) still show
// up in the tree, they just do not contribute to the header number.
function updateSidebarCount(files) {
  let content = 0;
  for (const file of files) {
    if ((file.chapter.category || 'content') !== 'reference') content += 1;
  }
  $('chapterCount').textContent = `${content} 篇`;
}

function openFile(file) {
  selectChapter(file.chapterIndex);
}

// --- 大纲: outline of the file currently open ------------------------------

// Chapters that came from the same source file as the one being read.
function siblingChapters() {
  const current = state.chapters[state.currentChapter];
  if (!current) return [];
  const key = String(current.filename || '');
  return state.chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(entry => String(entry.chapter.filename || '') === key);
}

export function renderOutline() {
  const list = $('outlineList');
  const empty = $('emptyOutline');
  const currentLabel = $('outlineCurrentFile');
  list.innerHTML = '';

  const chapter = state.chapters[state.currentChapter];
  if (!chapter) {
    currentLabel.textContent = '';
    empty.textContent = '导入书籍后，这里会显示当前文件的大纲';
    empty.classList.remove('hidden');
    return;
  }

  const filename = String(chapter.filename || '').split('/').pop() || chapter.title || '当前文件';
  currentLabel.innerHTML = `当前：<strong>${escapeHtml(filename)}</strong>`;

  const entries = applyOutlineHierarchy(buildOutlineEntries(chapter));
  if (!entries.length) {
    empty.textContent = chapter.isPdf
      ? 'PDF 没有可用的大纲'
      : '当前文件没有可用的大纲（未找到标题或内部章节）';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const entry of entries) {
    if (entry.hidden) continue;

    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = `outline-row ${entry.level > 1 ? `outline-level-${Math.min(entry.level, 4)}` : ''}`;

    // Separate toggle so collapsing a heading never navigates to it.
    if (entry.hasChildren) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'outline-toggle';
      toggle.setAttribute('aria-expanded', String(!entry.collapsed));
      toggle.setAttribute('aria-label', `${entry.collapsed ? '展开' : '折叠'}${entry.text}`);
      toggle.innerHTML = `<i class="fa-solid fa-chevron-down outline-chevron ${entry.collapsed ? 'collapsed' : ''}"></i>`;
      toggle.addEventListener('click', () => {
        collapsedHeadings[entry.collapseKey] = !collapsedHeadings[entry.collapseKey];
        renderOutline();
      });
      row.appendChild(toggle);
    } else {
      // Keep leaf text aligned with siblings that do have a chevron.
      const spacer = document.createElement('span');
      spacer.className = 'outline-toggle-spacer';
      row.appendChild(spacer);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `outline-item ${entry.active ? 'active' : ''}`;
    button.innerHTML = entry.prefix
      ? `<span style="flex:0 0 auto;font-size:11px;font-weight:700;opacity:.6">${escapeHtml(entry.prefix)}</span><span class="outline-text" title="${escapeHtml(entry.text)}">${escapeHtml(entry.text)}</span>`
      : `<span class="outline-text" title="${escapeHtml(entry.text)}">${escapeHtml(entry.text)}</span>`;
    button.addEventListener('click', entry.onClick);
    row.appendChild(button);

    li.appendChild(row);
    list.appendChild(li);
  }
}

// Derive parent/child structure from the level sequence, then mark entries
// hidden when any ancestor is collapsed. Flat outlines (EPUB, internal
// chapters) are all level 1, so nothing gets a chevron and nothing hides.
export function applyOutlineHierarchy(entries) {
  // An entry has children when the next one is deeper.
  const withChildren = entries.map((entry, index) => ({
    ...entry,
    hasChildren: Boolean(entries[index + 1] && entries[index + 1].level > entry.level),
    collapsed: entry.collapseKey ? collapsedHeadings[entry.collapseKey] === true : false
  }));

  // Stack of levels whose subtree is being hidden by a collapsed ancestor.
  const collapsedAncestors = [];
  return withChildren.map(entry => {
    while (collapsedAncestors.length && entry.level <= collapsedAncestors[collapsedAncestors.length - 1]) {
      collapsedAncestors.pop();
    }
    const hidden = collapsedAncestors.length > 0;
    // Only a visible collapsed heading starts hiding its own subtree; a hidden
    // one is already covered by the ancestor that hid it.
    if (!hidden && entry.collapsed && entry.hasChildren) collapsedAncestors.push(entry.level);
    return { ...entry, hidden };
  });
}

function buildOutlineEntries(chapter) {
  if (chapter.isPdf) return [];

  // EPUB: its own chapter list is the outline.
  if (chapter.isEpubFile) {
    const epubChapters = chapter.epubChapters || [];
    const current = state.epubViewer.currentEpubChapter || 0;
    return epubChapters.map((epubChapter, index) => ({
      level: 1,
      prefix: String(index + 1).padStart(2, '0'),
      text: epubChapter.title || `第 ${index + 1} 章`,
      active: index === current,
      onClick: () => epubGoToChapter(index)
    }));
  }

  // A file split into several internal chapters: list them.
  const siblings = siblingChapters();
  if (siblings.length > 1) {
    return siblings.map((entry, index) => ({
      level: 1,
      prefix: String(index + 1).padStart(2, '0'),
      text: entry.chapter.title || `第 ${index + 1} 节`,
      active: entry.index === state.currentChapter,
      onClick: () => selectChapter(entry.index)
    }));
  }

  // Single-chapter markdown: its headings are the outline.
  if (chapter.isMarkdown) {
    const headings = getMarkdownHeadings(getChapterBodyContent(chapter));
    const minLevel = headings.reduce((min, h) => Math.min(min, h.level), 6);
    const fileKey = String(chapter.filename || chapter.title || '');
    return headings.map(heading => ({
      // Normalize so the shallowest heading sits flush left.
      level: heading.level - minLevel + 1,
      prefix: '',
      text: heading.text,
      active: false,
      collapseKey: `${fileKey}\u0000${heading.index}`,
      onClick: () => scrollToHeading(heading.index)
    }));
  }

  return [];
}

function scrollToHeading(headingIndex) {
  const target = document.getElementById(markdownHeadingId(headingIndex));
  if (!target) return;
  // Offset by the sticky toolbar so the heading is not hidden behind it.
  const top = target.getBoundingClientRect().top - readerContainer.getBoundingClientRect().top
    + readerContainer.scrollTop - 24;
  readerContainer.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
