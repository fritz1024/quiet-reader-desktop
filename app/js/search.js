// Split from index.html — maintain in separate files under js/
import { state, $, readerContainer, readerContent, exportPanel, isDesktop, desktopApi } from './state.js';
import { escapeHtml, formatNumber, saveMarks, getMarksStorageKey, saveLibrarySnapshot } from './storage.js';
import { renderChapter, renderChapterList } from './chapter-render.js';
import { showToast, selectChapter } from './loader.js';
import { getChapterKey } from './history.js';
import { getWordCount, markdownToPlainText } from './text-utils.js';
import { getEpubHtmlText, getChapterBodyContent } from './parser.js';
import { renderMarkdown } from './markdown.js';
import { getChapterSourceKey, canSaveChapterToSource, saveChapterToSource, saveChapterEdits } from './chapter.js';
import { getEditableChapterBody, getDirectEditContent, exitDirectEditing } from './editing.js';
import { openFloatingPanel } from './folder-io.js';

export function normalizeSearchQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function getSearchableChapterText(chapter) {
  const content = getChapterBodyContent(chapter);
  if (chapter?.isEpubHtml) {
    const documentNode = new DOMParser().parseFromString(chapter.htmlContent || content, 'text/html');
    return (documentNode.body?.textContent || '').replace(/^\uFEFF/, '');
  }
  if (chapter?.isMarkdown) {
    const documentNode = new DOMParser().parseFromString(renderMarkdown(content), 'text/html');
    return documentNode.body?.textContent || '';
  }
  return content.split(/\n+/).filter(line => line.trim()).map(line => line.trim()).join('');
}

export function getExportChapterContent(chapter, format) {
  const content = getChapterBodyContent(chapter);
  if (format === 'markdown' && chapter.isMarkdown) return content.trim();
  if (chapter.isEpubHtml) return getEpubHtmlText(chapter.htmlContent || content);
  return chapter.isMarkdown ? markdownToPlainText(content) : content.trim();
}

export function getExportContent(scope = state.exportScope, format = state.exportFormat) {
  const currentChapter = state.chapters[state.currentChapter];
  const chapters = scope === 'book'
    ? state.chapters.filter(chapter => !chapter.isCover && chapter.category !== 'reference')
    : (currentChapter && !currentChapter.isCover ? [currentChapter] : []);
  const separator = format === 'markdown' ? '\n\n' : '\n\n';
  return chapters.map((chapter, index) => {
    const body = getExportChapterContent(chapter, format);
    if (format === 'markdown') return `# ${chapter.title || `第 ${index + 1} 章`}\n\n${body}`.trim();
    return `${chapter.title || `第 ${index + 1} 章`}\n\n${body}`.trim();
  }).filter(Boolean).join(separator).trim();
}

export function getExportSuggestedName() {
  const chapter = state.chapters[state.currentChapter];
  const suffix = state.exportScope === 'book' ? '全文' : (chapter?.title || '当前章节');
  return `${state.bookTitle || '静读阅读器'}-${suffix}`;
}

export function updateExportControls() {
  document.querySelectorAll('[data-export-scope]').forEach(button => {
    button.classList.toggle('active', button.dataset.exportScope === state.exportScope);
  });
  document.querySelectorAll('[data-export-format]').forEach(button => {
    button.classList.toggle('active', button.dataset.exportFormat === state.exportFormat);
  });
  const chapters = state.exportScope === 'book'
    ? state.chapters.filter(chapter => !chapter.isCover)
    : (state.chapters[state.currentChapter]?.isCover ? [] : [state.chapters[state.currentChapter]].filter(Boolean));
  const label = state.exportScope === 'book' ? '整本书' : '当前章节';
  const format = state.exportFormat === 'markdown' ? 'Markdown' : 'TXT';
  const wordCount = chapters.reduce((total, chapter) => total + getWordCount(getExportChapterContent(chapter, state.exportFormat), state.exportFormat === 'markdown'), 0);
  $('exportSummary').textContent = chapters.length
    ? `${label} · ${format} · ${chapters.length} 章 · 正文 ${formatNumber(wordCount)} 字`
    : '当前没有可导出的正文。';
  $('confirmExportBtn').disabled = chapters.length === 0;
}

export async function exportCurrentContent() {
  if (!state.chapters.length || state.demo) { showToast('请先导入一本书'); return; }
  if (state.directEditing && !(await exitDirectEditing())) return;
  const content = getExportContent();
  if (!content) { showToast('当前没有可导出的正文'); return; }
  const format = state.exportFormat;
  try {
    let result;
    if (isDesktop && desktopApi?.exportTextContent) {
      result = await desktopApi.exportTextContent({ content, format, suggestedName: getExportSuggestedName() });
    } else {
      const blob = new Blob([content], { type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${getExportSuggestedName()}.${format === 'markdown' ? 'md' : 'txt'}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      result = { canceled: false };
    }
    if (result?.canceled) return;
    exportPanel.classList.remove('show');
    showToast('正文已导出');
  } catch (error) {
    console.error(error);
    showToast(error?.message || '导出正文失败，请重试');
  }
}

export function getSearchSnippet(text, start, end) {
  const left = Math.max(0, start - 34);
  const right = Math.min(text.length, end + 58);
  return `${left > 0 ? '...' : ''}${text.slice(left, right)}${right < text.length ? '...' : ''}`;
}

export function buildBookSearch(query, scope = state.search.scope) {
  const needle = normalizeSearchQuery(query);
  if (!needle) return [];
  const lowerNeedle = needle.toLocaleLowerCase('zh-CN');
  const matches = [];
  state.chapters.forEach((chapter, chapterIndex) => {
    if (chapter.isCover || (scope === 'chapter' && chapterIndex !== state.currentChapter)) return;
    const text = getSearchableChapterText(chapter);
    const lowerText = text.toLocaleLowerCase('zh-CN');
    let from = 0;
    while (from < lowerText.length) {
      const start = lowerText.indexOf(lowerNeedle, from);
      if (start < 0) break;
      const end = start + needle.length;
      matches.push({
        chapterIndex,
        chapterKey: getChapterKey(chapter),
        start,
        end,
        quote: text.slice(start, end),
        snippet: getSearchSnippet(text, start, end),
        text
      });
      from = Math.max(end, start + 1);
      if (matches.length >= 2000) return;
    }
  });
  return matches;
}

export function renderSearchResults() {
  const summary = $('searchSummary');
  const results = $('searchResults');
  const query = normalizeSearchQuery(state.search.query);
  const previousButton = $('searchPreviousBtn');
  const nextButton = $('searchNextBtn');
  const scopeLabel = state.search.scope === 'book' ? '全局' : '本章';
  results.innerHTML = '';
  document.querySelectorAll('[data-search-scope]').forEach(button => {
    const active = button.dataset.searchScope === state.search.scope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  previousButton.disabled = !state.search.matches.length;
  nextButton.disabled = !state.search.matches.length;
  if (!query) {
    summary.textContent = `输入文字后在${scopeLabel}搜索。`;
    return;
  }
  const count = state.search.matches.length;
  summary.textContent = count
    ? `${scopeLabel}找到 ${formatNumber(count)} 处${state.search.currentIndex >= 0 ? `，当前第 ${state.search.currentIndex + 1} 处` : ''}。`
    : `${scopeLabel}没有找到匹配的正文。`;
  state.search.matches.slice(0, 300).forEach((match, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `search-result${index === state.search.currentIndex ? ' active' : ''}`;
    const chapter = state.chapters[match.chapterIndex];
    const startInSnippet = match.snippet.indexOf(match.text.slice(match.start, match.end));
    const quote = match.text.slice(match.start, match.end);
    const beforeMatch = match.snippet.slice(0, startInSnippet);
    const afterMatch = match.snippet.slice(startInSnippet + quote.length);
    const highlightedSnippet = startInSnippet >= 0
      ? `${escapeHtml(beforeMatch)}<mark class="search-snippet-match">${escapeHtml(quote)}</mark>${escapeHtml(afterMatch)}`
      : escapeHtml(match.snippet);
    const chapterLabel = state.search.scope === 'book'
      ? `<span class="search-result-chapter">第 ${match.chapterIndex + 1} 章 · ${escapeHtml(chapter?.title || '未命名章节')}</span>`
      : '';
    button.innerHTML = `${chapterLabel}<span class="search-result-snippet">${highlightedSnippet}</span>`;
    button.addEventListener('click', () => goToSearchMatch(index));
    results.appendChild(button);
  });
  if (count > 300) {
    const more = document.createElement('div');
    more.className = 'panel-empty';
    more.textContent = `结果较多，仅显示前 300 项。可用上一个、下一个继续定位。`;
    results.appendChild(more);
  }
}

export async function updateSearch(query = $('searchInput').value) {
  const hadRenderedSearchMarks = Boolean(readerContent.querySelector('.search-match'));
  const previousScroll = readerContainer.scrollTop;
  refreshSearchIndex(query);
  const currentChapterHasActiveMatch = state.search.matches.length
    && state.search.matches[state.search.currentIndex]?.chapterIndex === state.currentChapter;
  if (!state.directEditing && (hadRenderedSearchMarks || currentChapterHasActiveMatch)) {
    renderChapter(state.currentChapter, { saveProgress: false, refreshChapterSearch: false });
    readerContainer.scrollTop = previousScroll;
    if (currentChapterHasActiveMatch) scrollToCurrentSearchMatch();
  }
}

export function refreshSearchIndex(query = state.search.query) {
  const normalized = normalizeSearchQuery(query);
  const scope = state.search.scope === 'book' ? 'book' : 'chapter';
  state.search = { query: normalized, scope, matches: buildBookSearch(normalized, scope), currentIndex: -1 };
  if (state.search.matches.length) {
    const current = state.search.matches.findIndex(match => match.chapterIndex === state.currentChapter);
    state.search.currentIndex = current >= 0 ? current : 0;
  }
  renderSearchResults();
}

export async function setSearchScope(scope) {
  const nextScope = scope === 'book' ? 'book' : 'chapter';
  if (state.search.scope === nextScope) return;
  const hadRenderedSearchMarks = Boolean(readerContent.querySelector('.search-match'));
  const previousScroll = readerContainer.scrollTop;
  state.search.scope = nextScope;
  refreshSearchIndex();
  if (!state.directEditing && hadRenderedSearchMarks) {
    renderChapter(state.currentChapter, { saveProgress: false, refreshChapterSearch: false });
    readerContainer.scrollTop = previousScroll;
  }
}

export async function goToSearchMatch(index) {
  const matches = state.search.matches;
  if (!matches.length) return;
  const next = (index + matches.length) % matches.length;
  const match = matches[next];
  state.search.currentIndex = next;
  if (state.directEditing && !(await exitDirectEditing())) return;
  if (match.chapterIndex !== state.currentChapter) {
    if (!(await selectChapter(match.chapterIndex))) return;
  } else {
    renderChapter(state.currentChapter, { saveProgress: false, refreshChapterSearch: false });
  }
  renderSearchResults();
  scrollToCurrentSearchMatch();
}

export function scrollToCurrentSearchMatch() {
  requestAnimationFrame(() => {
    const active = readerContent.querySelector('.search-match.active');
    if (!active) return;
    const offset = active.getBoundingClientRect().top - readerContainer.getBoundingClientRect().top;
    readerContainer.scrollTo({ top: Math.max(0, readerContainer.scrollTop + offset - 140), behavior: 'smooth' });
  });
}

export function findTextRangeInBody(body, targetStart, targetEnd, fallbackQuote = '') {
  const text = body?.textContent || '';
  let start = Math.max(0, Number(targetStart) || 0);
  let end = Math.max(start, Number(targetEnd) || start);
  if (fallbackQuote && text.slice(start, end) !== fallbackQuote) {
    const located = text.indexOf(fallbackQuote);
    if (located >= 0) { start = located; end = located + fallbackQuote.length; }
  }
  if (!body || end <= start || end > text.length) return null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node;
  let offset = 0;
  let startPoint = null;
  let endPoint = null;
  while ((node = walker.nextNode())) {
    const nodeEnd = offset + node.nodeValue.length;
    if (!startPoint && start >= offset && start <= nodeEnd) startPoint = { node, offset: start - offset };
    if (end >= offset && end <= nodeEnd) { endPoint = { node, offset: end - offset }; break; }
    offset = nodeEnd;
  }
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function applyTextMarks() {
  if (state.directEditing) return;
  const body = getEditableChapterBody();
  const chapter = state.chapters[state.currentChapter];
  if (!body || !chapter || chapter.isCover) return;
  const chapterKey = getChapterKey(chapter);
  const activeSearch = state.search.matches[state.search.currentIndex];
  const ranges = new Map();
  const addRange = (item, type) => {
    const key = `${Number(item.start) || 0}:${Number(item.end) || 0}:${item.quote || ''}`;
    if (!ranges.has(key)) ranges.set(key, { ...item, searches: [], annotations: [] });
    ranges.get(key)[type].push(item);
  };
  state.search.matches
    .filter(match => match.chapterKey === chapterKey)
    .forEach(match => addRange({ ...match, active: match === activeSearch }, 'searches'));
  state.marks
    .filter(mark => mark.kind === 'annotation' && mark.chapterKey === chapterKey && mark.quote)
    .forEach(mark => addRange(mark, 'annotations'));
  [...ranges.values()]
    .sort((a, b) => Number(b.start) - Number(a.start) || Number(b.end) - Number(a.end))
    .forEach(mark => {
      const range = findTextRangeInBody(body, mark.start, mark.end, mark.quote || '');
      if (!range || range.collapsed) return;
      const hasSearch = mark.searches.length > 0;
      const wrapper = document.createElement(hasSearch ? 'mark' : 'span');
      wrapper.className = [
        hasSearch ? 'search-match' : '',
        mark.searches.some(search => search.active) ? 'active' : '',
        mark.annotations.length ? 'annotation-mark' : ''
      ].filter(Boolean).join(' ');
      if (mark.annotations.length) {
        wrapper.dataset.markIds = mark.annotations.map(annotation => annotation.id).join(' ');
        const note = mark.annotations.map(annotation => annotation.note).find(Boolean);
        if (note) wrapper.title = note;
      }
      try { range.surroundContents(wrapper); } catch (_) { /* Partially overlapping rich-text ranges remain available through the mark list. */ }
    });
}

export function getSelectionInChapter() {
  const body = getEditableChapterBody();
  const selection = window.getSelection();
  if (!body || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return null;
  const quote = String(selection.toString() || '');
  if (!quote) return null;
  const before = range.cloneRange();
  before.selectNodeContents(body);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { start, end: start + quote.length, quote };
}

export function renderMarks() {
  const list = $('markList');
  const empty = $('markEmpty');
  if (!list || !empty) return;
  list.innerHTML = '';
  empty.hidden = state.marks.length > 0;
  state.marks.forEach(mark => {
    const chapterIndex = state.chapters.findIndex(chapter => getChapterKey(chapter) === mark.chapterKey);
    const chapter = state.chapters[chapterIndex];
    const item = document.createElement('article');
    item.className = 'mark-item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mark-open';
    open.innerHTML = `<span class="mark-title"><i class="fa-solid ${mark.kind === 'bookmark' ? 'fa-bookmark' : 'fa-highlighter'} mr-1 text-[var(--accent)]"></i>${escapeHtml(chapter ? `第 ${chapterIndex + 1} 章 · ${chapter.title}` : '原章节已不存在')}</span>${mark.quote ? `<span class="mark-quote">${escapeHtml(mark.quote)}</span>` : ''}${mark.note ? `<span class="mark-note">${escapeHtml(mark.note)}</span>` : ''}`;
    open.disabled = chapterIndex < 0;
    open.addEventListener('click', () => openMark(mark));
    const actions = document.createElement('div');
    actions.className = 'mark-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mark-action delete';
    remove.title = '删除标记';
    remove.setAttribute('aria-label', '删除标记');
    remove.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    remove.addEventListener('click', () => deleteMark(mark.id));
    actions.appendChild(remove);
    item.append(open, actions);
    list.appendChild(item);
  });
}

export async function addBookmark() {
  const chapter = state.chapters[state.currentChapter];
  if (!chapter || state.demo) { showToast('请先导入一本书'); return; }
  if (state.directEditing) { showToast('请先退出正文编辑，再添加书签或批注'); return; }
  const mark = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: 'bookmark',
    chapterKey: getChapterKey(chapter),
    scroll: readerContainer.scrollTop,
    start: 0,
    end: 0,
    quote: '',
    note: String($('markNoteInput').value || '').trim(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.marks.unshift(mark);
  await saveMarks();
  $('markNoteInput').value = '';
  renderMarks();
  showToast('已添加书签');
}

export async function addAnnotation() {
  const chapter = state.chapters[state.currentChapter];
  if (!chapter || state.demo) { showToast('请先导入一本书'); return; }
  if (state.directEditing) { showToast('请先退出正文编辑，再添加书签或批注'); return; }
  const selection = getSelectionInChapter();
  if (!selection) { showToast('请先在正文中选中一段文字'); return; }
  const mark = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: 'annotation',
    chapterKey: getChapterKey(chapter),
    scroll: readerContainer.scrollTop,
    start: selection.start,
    end: selection.end,
    quote: selection.quote,
    note: String($('markNoteInput').value || '').trim(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.marks.unshift(mark);
  await saveMarks();
  $('markNoteInput').value = '';
  window.getSelection()?.removeAllRanges();
  renderMarks();
  renderChapter(state.currentChapter, { saveProgress: false });
  showToast('已添加文本批注');
}

export async function openMark(mark) {
  const chapterIndex = state.chapters.findIndex(chapter => getChapterKey(chapter) === mark.chapterKey);
  if (chapterIndex < 0) { showToast('原章节已不存在'); return; }
  if (!(await selectChapter(chapterIndex))) return;
  requestAnimationFrame(() => {
    const escapedId = window.CSS?.escape ? window.CSS.escape(mark.id) : String(mark.id).replace(/["\\]/g, '\\$&');
    const annotation = readerContent.querySelector(`.annotation-mark[data-mark-ids~="${escapedId}"]`);
    if (annotation && mark.kind === 'annotation') {
      const offset = annotation.getBoundingClientRect().top - readerContainer.getBoundingClientRect().top;
      readerContainer.scrollTo({ top: Math.max(0, readerContainer.scrollTop + offset - 140), behavior: 'smooth' });
    } else {
      readerContainer.scrollTo({ top: Math.max(0, Number(mark.scroll) || 0), behavior: 'smooth' });
    }
  });
}

export async function deleteMark(id) {
  state.marks = state.marks.filter(mark => mark.id !== id);
  await saveMarks();
  renderMarks();
  renderChapter(state.currentChapter, { saveProgress: false });
  showToast('已删除标记');
}

export const contextMenu = document.getElementById('readerContextMenu');
export let contextMenuImageSrc = '';

export function setContextMenuImageSrc(val) { contextMenuImageSrc = val; }

export function hideContextMenu() {
  if (!contextMenu.classList.contains('show')) return;
  contextMenu.classList.remove('show');
  contextMenuImageSrc = '';
}

export function showContextMenu(x, y, { hasSelection, isImage }) {
  contextMenu.querySelectorAll('[data-menu]').forEach(item => {
    const kind = item.dataset.menu;
    const show = (kind === 'copy' && hasSelection)
      || (kind === 'search' && hasSelection)
      || (kind === 'replace' && hasSelection)
      || (kind === 'sep-1' && hasSelection)
      || (kind === 'bookmark' && !state.demo && state.chapters.length)
      || (kind === 'sep-2' && isImage)
      || (kind === 'save-image' && isImage);
    item.hidden = !show;
  });
  contextMenu.style.visibility = 'hidden';
  contextMenu.classList.add('show');
  const rect = contextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - 8;
  const maxTop = window.innerHeight - rect.height - 8;
  contextMenu.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
  contextMenu.style.top = `${Math.max(8, Math.min(y, maxTop))}px`;
  contextMenu.style.visibility = '';
}

export async function copySelectionText() {
  const text = String(window.getSelection()?.toString() || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制选中文字');
  } catch {
    showToast('复制失败');
  }
}

export function searchSelectionText() {
  const text = String(window.getSelection()?.toString() || '').trim();
  if (!text) return;
  openFloatingPanel('search', $('searchInput'));
  $('searchInput').value = text;
  updateSearch(text);
}

export let _replaceSavedSelection = null;

export function replaceSelectionText() {
  const selection = window.getSelection();
  const text = String(selection?.toString() || '');
  if (!text) return;
  if (selection.rangeCount) _replaceSavedSelection = selection.getRangeAt(0).cloneRange();
  else _replaceSavedSelection = null;
  const dialog = $('replaceDialog');
  const textarea = $('replaceTextarea');
  textarea.value = text;
  dialog.classList.add('show');
  dialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => { textarea.focus(); textarea.select(); });
}

export function closeReplaceDialog() {
  const dialog = $('replaceDialog');
  dialog.classList.remove('show');
  dialog.setAttribute('aria-hidden', 'true');
  _replaceSavedSelection = null;
}

export async function applyReplaceDialog() {
  const textarea = $('replaceTextarea');
  const newText = textarea.value;
  const originalText = _replaceSavedSelection ? _replaceSavedSelection.toString() : '';
  closeReplaceDialog();
  if (newText === originalText || !originalText) return;
  const chapter = state.chapters[state.currentChapter];
  if (!chapter) return;
  if (state.directEditing) {
    const body = getEditableChapterBody();
    if (!body) return;
    const sel = window.getSelection();
    if (sel && _replaceSavedSelection) {
      try {
        sel.removeAllRanges();
        sel.addRange(_replaceSavedSelection);
        if (document.execCommand('insertText', false, newText)) {
          showToast('已替换选中文字');
          return;
        }
      } catch {}
    }
    const content = getDirectEditContent();
    const idx = content.indexOf(originalText);
    if (idx < 0) { showToast('未找到原始选中文本'); return; }
    const newContent = content.substring(0, idx) + newText + content.substring(idx + originalText.length);
    if (chapter.isMarkdown && !chapter.isEpubHtml) {
      body.textContent = newContent;
    } else {
      body.innerText = newContent;
    }
    showToast('已替换选中文字');
    return;
  }
  const fullContent = chapter.content || '';
  const bodyContent = getChapterBodyContent(chapter);
  let newFullContent;
  const fullIdx = fullContent.indexOf(originalText);
  if (fullIdx >= 0) {
    newFullContent = fullContent.substring(0, fullIdx) + newText + fullContent.substring(fullIdx + originalText.length);
  } else {
    const bodyIdx = bodyContent.indexOf(originalText);
    if (bodyIdx < 0) { showToast('未找到原始选中文本'); return; }
    const newBodyContent = bodyContent.substring(0, bodyIdx) + newText + bodyContent.substring(bodyIdx + originalText.length);
    const prefixLen = fullContent.length - bodyContent.length;
    const prefix = prefixLen > 0 ? fullContent.substring(0, prefixLen) : '';
    newFullContent = prefix + newBodyContent;
  }
  chapter.content = newFullContent;
  const bodyForSave = getChapterBodyContent(chapter);
  if (canSaveChapterToSource(chapter)) {
    try {
      await saveChapterToSource(chapter, bodyForSave);
      delete state.chapterEdits[getChapterSourceKey(chapter)];
    } catch (error) {
      console.error(error);
      showToast('原文件保存失败，已保存到阅读器本地副本');
      state.chapterEdits[getChapterSourceKey(chapter)] = chapter.content;
    }
  } else {
    state.chapterEdits[getChapterSourceKey(chapter)] = chapter.content;
  }
  saveChapterEdits();
  const currentScroll = readerContainer.scrollTop;
  renderChapter(state.currentChapter, { saveProgress: false });
  requestAnimationFrame(() => { readerContainer.scrollTop = currentScroll; });
  renderChapterList();
  if (state.search.query) refreshSearchIndex(state.search.query);
  await saveLibrarySnapshot();
  showToast('已替换选中文字');
}

export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

export function guessImageExtension(src) {
  const match = /^data:image\/([a-zA-Z0-9+.-]+)[;,]/.exec(src);
  if (!match) return 'png';
  const type = match[1].toLowerCase();
  if (type === 'jpeg') return 'jpg';
  if (type === 'svg+xml') return 'svg';
  return type.replace(/[^a-z0-9]/g, '') || 'png';
}

export async function saveContextMenuImage() {
  const src = contextMenuImageSrc;
  if (!src) return;
  try {
    let blob;
    if (/^data:/.test(src)) blob = dataUrlToBlob(src);
    else blob = await (await fetch(src)).blob();
    if (!blob) { showToast('无法读取图片数据'); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `image-${Date.now()}.${guessImageExtension(src)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error(error);
    showToast('保存图片失败');
  }
}
