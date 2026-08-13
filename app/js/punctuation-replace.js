// Split from index.html — maintain in separate files under js/
import { state, $, readerContainer } from './state.js';
import { formatNumber, saveLibrarySnapshot } from './storage.js';
import { renderChapter } from './chapter-render.js';
import { showToast } from './loader.js';
import { getPunctuationOptions, setPunctuationOptions, getCustomRules, applyCustomRules, renderCustomRules, normalizePunctuation } from './text-utils.js';
import { getChapterSourceKey, cloneChapters, canSaveChapterToSource, getChapterSourceDocumentKey, buildSourceDocumentUpdate, applySourceDocumentUpdate, saveAllSourceDocuments, syncEditedChapterEdits, saveChapterEdits } from './chapter.js';
import { normalizeHtmlPunctuation, getEpubHtmlText, getChapterBodyContent } from './parser.js';
import { getDirectEditSnapshot, saveDirectEdit, updateEditorResult, getCurrentFileChapters, getCurrentFileLabel } from './editing.js';

export async function replacePunctuation(scope = 'all') {
  if (!state.chapters.length || state.demo) { updateEditorResult('请先导入真实书籍，再进行文本编辑。'); return; }
  const options = getPunctuationOptions();
  const hasCustomRules = getCustomRules().some(r => r.enabled !== false && r.from);
  if (!Object.values(options).some(Boolean) && !hasCustomRules) { updateEditorResult('请至少选择一种标点或添加自定义规则。'); return; }
  if (state.directEditing && getDirectEditSnapshot() !== state.directEditOriginalText && !(await saveDirectEdit(false))) return;

  const currentOnly = scope === 'current';
  // 全局替换只作用于正文（category === 'content'）。设定、大纲、人物库等
  // reference 文件不属于「全局」范围，绝不能被批量改写。
  const targets = currentOnly
    ? getCurrentFileChapters()
    : state.chapters.filter(chapter => chapter.category !== 'reference' && !chapter.isCover);
  if (!targets.length) {
    updateEditorResult(currentOnly ? '没有找到当前文件对应的章节。' : '没有找到可替换的正文章节。');
    return;
  }
  const targetChapters = new Set(targets);
  const targetSourceKeys = new Set(targets.map(chapter => getChapterSourceDocumentKey(chapter)).filter(Boolean));

  const previousScroll = readerContainer.scrollTop;
  const snapshot = {
    chapters: cloneChapters(state.chapters),
    options: state.punctuationOptions ? { ...state.punctuationOptions } : null,
    sourceDocuments: Object.fromEntries(Object.entries(state.sourceDocuments).map(([key, value]) => [key, { ...value }])),
    savedKeys: null
  };
  let totalChanges = 0;
  state.chapters = state.chapters.map(chapter => {
    if (!targetChapters.has(chapter)) return chapter;
    const titleResult = canSaveChapterToSource(chapter)
      ? { text: chapter.title, changes: 0 }
      : normalizePunctuation(chapter.title, options);
    const htmlResult = chapter.isEpubHtml ? normalizeHtmlPunctuation(chapter.htmlContent, options) : null;
    const contentResult = chapter.isEpubHtml
      ? { text: getEpubHtmlText(htmlResult.html), changes: 0 }
      : normalizePunctuation(chapter.content, options);
    const customTitle = canSaveChapterToSource(chapter)
      ? { text: chapter.title, changes: 0 }
      : applyCustomRules(titleResult.text);
    const customContent = chapter.isEpubHtml
      ? { text: contentResult.text, changes: 0 }
      : applyCustomRules(contentResult.text);
    // Count both passes: punctuation normalization and custom rules. For EPUB
    // the punctuation count lives in htmlResult (contentResult.changes is 0),
    // so these five terms never overlap.
    totalChanges += titleResult.changes + contentResult.changes + (htmlResult?.changes || 0)
      + customTitle.changes + customContent.changes;
    return { ...chapter, title: customTitle.text, content: customContent.text, htmlContent: htmlResult?.html ?? chapter.htmlContent, wordCount: 0 };
  });

  state.punctuationHistory = snapshot;
  if (!currentOnly) state.punctuationOptions = options;
  let savedSourceFiles = 0;
  try {
    const writtenKeys = new Set();
    for (const chapter of state.chapters) {
      if (!canSaveChapterToSource(chapter)) continue;
      const sourceKey = getChapterSourceDocumentKey(chapter);
      // Always gate on the in-scope source keys. Previously this only applied
      // when currentOnly, so 全局替换 rewrote every writable file on disk --
      // including reference files that were never in targets.
      if (!targetSourceKeys.has(sourceKey)) continue;
      const normalizedBody = getChapterBodyContent(chapter);
      const update = buildSourceDocumentUpdate(chapter, normalizedBody);
      applySourceDocumentUpdate(chapter, normalizedBody, update);
      writtenKeys.add(sourceKey);
    }
    // Always record the exact keys written. Passing null means "every writable
    // file" in saveAllSourceDocuments, which would overwrite (and back up)
    // out-of-scope files such as 设定/大纲 even though their content is unchanged.
    snapshot.savedKeys = Array.from(writtenKeys);
    savedSourceFiles = await saveAllSourceDocuments(snapshot.savedKeys);
  } catch (error) {
    console.error(error);
    state.chapters = snapshot.chapters;
    state.sourceDocuments = snapshot.sourceDocuments;
    state.punctuationHistory = null;
    state.punctuationOptions = snapshot.options;
    setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
    renderChapter(state.currentChapter);
    requestAnimationFrame(() => { readerContainer.scrollTop = previousScroll; });
    updateEditorResult(error?.message || '标点替换未能保存到原文件。');
    showToast('标点替换失败，内容未改动');
    return;
  }
  syncEditedChapterEdits();
  saveChapterEdits();
  $('punctuationUndoBtn').disabled = false;
  renderChapter(state.currentChapter);
  if (state.directEditing) state.directEditOriginalText = getDirectEditSnapshot();
  requestAnimationFrame(() => { readerContainer.scrollTop = previousScroll; });
  await saveLibrarySnapshot();
  const scopeLabel = currentOnly ? `当前文件《${getCurrentFileLabel()}》` : '全书';
  updateEditorResult(totalChanges
    ? `已在${scopeLabel}替换 ${formatNumber(totalChanges)} 处标点${savedSourceFiles ? `，并已写回 ${savedSourceFiles} 个原文件` : ''}。`
    : `${scopeLabel}没有发现需要替换的英文标点。`);
  showToast(totalChanges ? `已规范 ${formatNumber(totalChanges)} 处标点` : '没有需要替换的标点');
}

export async function undoPunctuation() {
  if (!state.punctuationHistory) return;
  const previousScroll = readerContainer.scrollTop;
  const snapshot = state.punctuationHistory;
  const currentChapters = cloneChapters(state.chapters);
  const currentSourceDocuments = Object.fromEntries(Object.entries(state.sourceDocuments).map(([key, value]) => [key, { ...value }]));
  state.chapters = Array.isArray(snapshot) ? snapshot : snapshot.chapters;
  state.punctuationOptions = Array.isArray(snapshot) ? null : snapshot.options;
  state.sourceDocuments = Array.isArray(snapshot) ? state.sourceDocuments : snapshot.sourceDocuments;
  setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
  try {
    await saveAllSourceDocuments(Array.isArray(snapshot) ? null : snapshot.savedKeys);
  } catch (error) {
    console.error(error);
    state.chapters = currentChapters;
    state.sourceDocuments = currentSourceDocuments;
    state.punctuationOptions = snapshot.options;
    setPunctuationOptions(state.punctuationOptions);
  renderCustomRules();
    renderChapter(state.currentChapter);
    requestAnimationFrame(() => { readerContainer.scrollTop = previousScroll; });
    updateEditorResult(error?.message || '无法将撤销结果保存到原文件。');
    showToast('撤销失败，当前替换结果仍保留');
    return;
  }
  syncEditedChapterEdits();
  saveChapterEdits();
  state.punctuationHistory = null;
  $('punctuationUndoBtn').disabled = true;
  renderChapter(state.currentChapter);
  if (state.directEditing) state.directEditOriginalText = getDirectEditSnapshot();
  requestAnimationFrame(() => { readerContainer.scrollTop = previousScroll; });
  await saveLibrarySnapshot();
  updateEditorResult('已撤销上次标点替换。');
  showToast('已撤销标点替换');
}
