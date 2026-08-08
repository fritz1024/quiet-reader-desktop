// Split from index.html — maintain in separate files under js/
import { state, $, chapterList, chapterCount, readerContent, readerContainer, progressFill } from './state.js';
import { escapeHtml, formatNumber } from './storage.js';
import { getWordCount, getBookWordCount } from './text-utils.js';
import { renderMarkdown } from './markdown.js';
import { renderPdfViewer } from './pdf-viewer.js';
import { renderEpubViewer } from './epub-viewer.js';
import { getChapterGroupInfo, updateNavButtonLabels, updateNavButtonStates } from './chapter-nav.js';
import { getEditableChapterBody } from './editing.js';
import { getSourceBackupRequest, syncMobileMoreActions } from './folder-io.js';
import { applyReadingSettings, saveProgress, toggleSidebar, selectChapter } from './loader.js';
import { getChapterBodyContent } from './parser.js';
import { applyTextMarks, refreshSearchIndex } from './search.js';

export let sidebarCollapsedGroups = {};

export function setSidebarCollapsedGroups(val) { sidebarCollapsedGroups = val; }

export function renderChapterList() {
  chapterList.innerHTML = '';
  $('sidebarBookName').textContent = state.bookTitle || '未命名书籍';
  $('emptyChapterList').classList.toggle('hidden', state.chapters.length > 0);

  // Classify chapters into typed groups
  const groupDefs = {
    chapters: { label: '章节', icon: 'fa-feather-pointed', items: [] },
    manga:    { label: '漫画', icon: 'fa-images',          items: [] },
    ebooks:   { label: '电子书', icon: 'fa-book-open',     items: [] },
    reference:{ label: '设定', icon: 'fa-book-bookmark',   items: [] }
  };

  state.chapters.forEach((chapter, index) => {
    const cat = chapter.category || 'content';
    let groupKey;
    if (cat === 'reference') {
      groupKey = 'reference';
    } else if (chapter.isPdf) {
      groupKey = 'manga';
    } else if (chapter.isEpubHtml) {
      groupKey = 'ebooks';
    } else {
      groupKey = 'chapters';
    }
    groupDefs[groupKey].items.push({ chapter, index });
  });

  // Build ordered list of non-empty groups
  const activeGroups = [];
  for (const key of ['chapters', 'ebooks', 'manga', 'reference']) {
    if (groupDefs[key].items.length > 0) activeGroups.push({ key, ...groupDefs[key] });
  }

  const showHeaders = activeGroups.length > 1;

  // Update chapter count display
  const parts = [];
  if (groupDefs.chapters.items.length) parts.push(`${groupDefs.chapters.items.length} 章`);
  if (groupDefs.ebooks.items.length) parts.push(`${groupDefs.ebooks.items.length} 章`);
  if (groupDefs.manga.items.length) parts.push(`${groupDefs.manga.items.length} 册`);
  if (groupDefs.reference.items.length) parts.push(`${groupDefs.reference.items.length} 设定`);
  chapterCount.textContent = parts.join(' · ') || '0 章';
  const wordTotal = getBookWordCount();
  $('bookWordCount').textContent = wordTotal > 0 ? `正文 ${formatNumber(wordTotal)} 字` : '';

  for (const group of activeGroups) {
    const { key, label, icon, items } = group;
    const isCollapsed = sidebarCollapsedGroups[key] === true;
    const isRef = key === 'reference';
    const isManga = key === 'manga';
    const isEbook = key === 'ebooks';

    // Group header (hidden when only one group)
    if (showHeaders) {
      const headerLi = document.createElement('li');
      const headerBtn = document.createElement('button');
      headerBtn.type = 'button';
      headerBtn.className = 'chapter-group-header';
      headerBtn.innerHTML = `<i class="fa-solid ${icon} group-icon" style="font-size:11px;opacity:0.5"></i><span>${label}</span><span class="group-count">${items.length}</span><i class="fa-solid fa-chevron-down group-chevron ${isCollapsed ? 'collapsed' : ''}"></i>`;
      headerBtn.addEventListener('click', () => {
        sidebarCollapsedGroups[key] = !sidebarCollapsedGroups[key];
        renderChapterList();
      });
      headerLi.appendChild(headerBtn);
      chapterList.appendChild(headerLi);
    }

    // Group list
    const listLi = document.createElement('li');
    const groupUl = document.createElement('ul');
    groupUl.className = `chapter-group-list ${isCollapsed ? 'collapsed' : ''}`;
    groupUl.style.listStyle = 'none';

    items.forEach(({ chapter, index }, groupIndex) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chapter-item ${index === state.currentChapter ? 'active' : ''}`;
      if (isRef) {
        button.innerHTML = `<i class="fa-solid fa-file-lines" style="flex:0 0 16px;font-size:11px;opacity:0.5;text-align:center;padding-top:2px"></i><span class="chapter-name" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}</span>`;
      } else if (isManga) {
        button.innerHTML = `<i class="fa-solid fa-images" style="flex:0 0 16px;font-size:11px;opacity:0.5;text-align:center;padding-top:2px"></i><span class="chapter-name" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}</span>`;
      } else if (isEbook) {
        button.innerHTML = `<i class="fa-solid fa-book-open" style="flex:0 0 16px;font-size:11px;opacity:0.5;text-align:center;padding-top:2px"></i><span class="chapter-name" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}</span><span class="chapter-epub-count" style="font-size:10px;color:var(--muted);margin-left:4px">${(chapter.epubChapters || []).length}章</span>`;
      } else {
        button.innerHTML = `<span class="chapter-number">${String(groupIndex + 1).padStart(2, '0')}</span><span class="chapter-name" title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title)}</span>`;
      }
      button.addEventListener('click', () => selectChapter(index));
      li.appendChild(button);
      groupUl.appendChild(li);
    });

    listLi.appendChild(groupUl);
    chapterList.appendChild(listLi);
  }
}

export function renderChapter(index, { saveProgress: shouldSaveProgress = true, refreshChapterSearch = true } = {}) {
  const chapter = state.chapters[index]; if (!chapter) return;
  state.currentChapter = index;
  if (refreshChapterSearch && state.search.scope === 'chapter' && state.search.query) refreshSearchIndex();
  if (chapter.isEpubFile) {
    renderEpubViewer(chapter, index);
    applyReadingSettings();
    renderChapterList();
    $('sourceBackupBtn').classList.toggle('show', false);
    syncMobileMoreActions();
    updateNavButtonLabels();
    updateNavButtonStates();
    readerContainer.scrollTop = 0;
    progressFill.style.width = '0%';
    if (shouldSaveProgress) saveProgress();
    return;
  }
  if (chapter.isPdf) {
    renderPdfViewer(chapter, index);
    applyReadingSettings();
    renderChapterList();
    $('sourceBackupBtn').classList.toggle('show', false);
    syncMobileMoreActions();
    updateNavButtonLabels();
    updateNavButtonStates();
    readerContainer.scrollTop = 0;
    progressFill.style.width = '0%';
    if (shouldSaveProgress) saveProgress();
    return;
  }
  const content = getChapterBodyContent(chapter);
  const bodyHtml = chapter.isEpubHtml
    ? (chapter.htmlContent || '')
    : (chapter.isMarkdown ? renderMarkdown(content) : content.split(/\n+/).filter(line => line.trim()).map(line => `<p>${escapeHtml(line.trim())}</p>`).join(''));
  const groupInfo = getChapterGroupInfo(index);
  const headerHtml = chapter.isCover ? '' : `
    <header class="mb-11 text-center">
      <div class="mb-4 text-[10px] font-bold uppercase tracking-[.17em] text-[var(--accent)]">Chapter ${String(groupInfo.groupIndex + 1).padStart(2, '0')}</div>
      <h1 class="chapter-title">${escapeHtml(chapter.title)}</h1>
      <div class="chapter-divider"></div>
      <div class="chapter-meta"><span>第 ${groupInfo.groupIndex + 1} / ${groupInfo.groupTotal} 章</span><span class="meta-dot"></span><span class="meta-accent">${formatNumber(getWordCount(content, chapter.isMarkdown))} 字</span><span class="meta-dot"></span><span>${escapeHtml(chapter.filename || '本地文件')}</span></div>
    </header>`;
  const endHtml = chapter.isCover ? '' : '<div class="chapter-end"><i class="fa-solid fa-feather-pointed mr-2 text-[var(--accent)]"></i>本章完</div>';
  readerContent.innerHTML = `
    ${headerHtml}
    <div class="chapter-body${chapter.isEpubHtml ? ' epub-html' : ''}${chapter.isCover ? ' epub-cover' : ''}">${bodyHtml || '<p>本章暂无正文。</p>'}</div>
    ${endHtml}`;
  applyReadingSettings();
  applyTextMarks();
  renderChapterList();
  if (state.directEditing) {
    const body = getEditableChapterBody();
    if (body) {
      body.contentEditable = 'true';
      body.classList.add('direct-editing');
      if (chapter.isMarkdown && !chapter.isEpubHtml) {
        body.textContent = getChapterBodyContent(chapter);
        body.classList.add('raw-markdown');
        body.style.fontSize = `${state.fontSize}px`;
        body.style.lineHeight = state.lineHeight;
      }
    }
  }
  $('sourceBackupBtn').classList.toggle('show', Boolean(getSourceBackupRequest()));
  syncMobileMoreActions();
  updateNavButtonLabels();
  $('prevPageBtn').disabled = index === 0;
  $('nextPageBtn').disabled = index === state.chapters.length - 1;
  readerContainer.scrollTop = 0;
  progressFill.style.width = '0%';
  if (shouldSaveProgress) saveProgress();
}
