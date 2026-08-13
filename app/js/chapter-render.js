// Split from index.html — maintain in separate files under js/
import { state, $, readerContent, readerContainer, progressFill } from './state.js';
import { escapeHtml, formatNumber } from './storage.js';
import { getWordCount } from './text-utils.js';
import { renderMarkdown } from './markdown.js';
import { renderPdfViewer } from './pdf-viewer.js';
import { renderEpubViewer } from './epub-viewer.js';
import { getChapterGroupInfo, updateNavButtonLabels, updateNavButtonStates } from './chapter-nav.js';
import { getEditableChapterBody } from './editing.js';
import { getSourceBackupRequest, syncMobileMoreActions } from './folder-io.js';
import { applyReadingSettings, saveProgress } from './loader.js';
import { getChapterBodyContent } from './parser.js';
import { applyTextMarks, refreshSearchIndex } from './search.js';
import { renderSidebar } from './sidebar.js';

// The sidebar itself lives in sidebar.js (文件 tree + 大纲 outline). This name is
// kept because renderChapter and several other modules already call it.
export function renderChapterList() {
  renderSidebar();
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
