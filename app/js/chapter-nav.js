// Split from index.html — maintain in separate files under js/
import { state, $ } from './state.js';

export function getChapterGroupInfo(chapterIndex) {
  const ch = state.chapters[chapterIndex];
  if (!ch) return { groupIndex: chapterIndex, groupTotal: state.chapters.length, groupLabel: '章节' };
  const cat = ch.category || 'content';
  let groupKey;
  if (cat === 'reference') groupKey = 'reference';
  else if (ch.isPdf) groupKey = 'manga';
  else if (ch.isEpubHtml) groupKey = 'ebooks';
  else groupKey = 'chapters';
  const groupLabels = { chapters: '章节', manga: '漫画', ebooks: '电子书', reference: '设定' };
  let groupIndex = 0;
  let groupTotal = 0;
  for (let i = 0; i < state.chapters.length; i++) {
    const c = state.chapters[i];
    const cc = c.category || 'content';
    let gk;
    if (cc === 'reference') gk = 'reference';
    else if (c.isPdf) gk = 'manga';
    else if (c.isEpubHtml) gk = 'ebooks';
    else gk = 'chapters';
    if (gk === groupKey) {
      groupTotal++;
      if (i <= chapterIndex) groupIndex++;
    }
  }
  return { groupIndex: groupIndex - 1, groupTotal, groupLabel: groupLabels[groupKey] || '章节' };
}

export function updateNavButtonLabels() {
  const ch = state.chapters[state.currentChapter];
  const prevSpan = $('prevPageBtn')?.querySelector('span');
  const nextSpan = $('nextPageBtn')?.querySelector('span');
  if (!prevSpan || !nextSpan) return;
  if (ch?.isPdf) {
    prevSpan.textContent = '上一页';
    nextSpan.textContent = '下一页';
  } else if (ch?.isEpubFile) {
    prevSpan.textContent = '上一节';
    nextSpan.textContent = '下一节';
  } else {
    prevSpan.textContent = '上一章';
    nextSpan.textContent = '下一章';
  }
}

export function updateNavButtonStates() {
  const ch = state.chapters[state.currentChapter];
  if (!ch) return;
  if (ch.isPdf) {
    const atFirst = state.pdfViewer.currentPage <= 1 && state.currentChapter === 0;
    const atLast = state.pdfViewer.currentPage >= (state.pdfViewer.pageCount || 1) && state.currentChapter >= state.chapters.length - 1;
    $('prevPageBtn').disabled = atFirst;
    $('nextPageBtn').disabled = atLast;
  } else if (ch.isEpubFile) {
    const epubChs = ch.epubChapters || [];
    const idx = state.epubViewer.currentEpubChapter || 0;
    const atFirst = idx <= 0 && state.currentChapter === 0;
    const atLast = idx >= epubChs.length - 1 && state.currentChapter >= state.chapters.length - 1;
    $('prevPageBtn').disabled = atFirst;
    $('nextPageBtn').disabled = atLast;
  } else {
    $('prevPageBtn').disabled = state.currentChapter === 0;
    $('nextPageBtn').disabled = state.currentChapter >= state.chapters.length - 1;
  }
}
