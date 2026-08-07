// Split from index.html — maintain in separate files under js/
function normalizeChapters(chapters, options) {
  if (!options || !Object.values(options).some(Boolean)) return chapters;
  return chapters.map(chapter => {
    const titleResult = canSaveChapterToSource(chapter)
      ? { text: chapter.title, changes: 0 }
      : normalizePunctuation(chapter.title, options);
    const htmlResult = chapter.isEpubHtml ? normalizeHtmlPunctuation(chapter.htmlContent, options) : null;
    const contentResult = chapter.isEpubHtml
      ? { text: getEpubHtmlText(htmlResult.html), changes: 0 }
      : normalizePunctuation(chapter.content, options);
    return {
      ...chapter,
      title: titleResult.text,
      content: contentResult.text,
      htmlContent: htmlResult?.html ?? chapter.htmlContent
    };
  });
}

function cloneChapters(chapters) {
  return chapters.map(chapter => ({ ...chapter }));
}

function getChapterSourceKey(chapter) {
  return chapter.sourceKey || `${chapter.filename || ''}\u0000${chapter.title || ''}`;
}

function loadChapterEdits(bookTitle, snapshot = state) {
  if (!bookTitle) return {};
  const saved = getStoredJson(getChapterEditsStorageKey(snapshot), null);
  if (saved && typeof saved === 'object') return saved;

  const legacy = getStoredJson(`reader_edits_${bookTitle}`, null);
  if (!legacy || typeof legacy !== 'object') return {};
  setStoredJson(getChapterEditsStorageKey(snapshot), legacy, { immediate: true });
  return legacy;
}

function saveChapterEdits() {
  if (!state.bookTitle || state.demo) return;
  setStoredJson(getChapterEditsStorageKey(), state.chapterEdits);
}

function applyChapterEdits(chapters) {
  return chapters.map(chapter => {
    const editedContent = state.chapterEdits[getChapterSourceKey(chapter)];
    if (typeof editedContent === 'string') return { ...chapter, content: editedContent };
    if (editedContent && typeof editedContent === 'object') {
      return {
        ...chapter,
        content: typeof editedContent.content === 'string' ? editedContent.content : chapter.content,
        htmlContent: typeof editedContent.htmlContent === 'string' ? sanitizeEpubHtml(editedContent.htmlContent) : chapter.htmlContent
      };
    }
    return chapter;
  });
}

function syncEditedChapterEdits() {
  state.chapters.forEach(chapter => {
    const key = getChapterSourceKey(chapter);
    if (Object.prototype.hasOwnProperty.call(state.chapterEdits, key)) {
      state.chapterEdits[key] = chapter.isEpubHtml
        ? { content: chapter.content, htmlContent: chapter.htmlContent }
        : chapter.content;
    }
  });
}

function getSourceWriteTargets() {
  const documents = new Map();
  state.chapters.forEach(chapter => {
    if (!canSaveChapterToSource(chapter)) return;
    const sourceKey = getChapterSourceDocumentKey(chapter);
    const sourceDocument = state.sourceDocuments[sourceKey];
    if (!sourceDocument || documents.has(sourceKey)) return;
    documents.set(sourceKey, { relativePath: sourceKey, sourceDocument });
  });
  return Array.from(documents.values()).map(({ relativePath, sourceDocument }) => ({
    relativePath,
    content: sourceDocument.content,
    encoding: sourceDocument.encoding || '',
    bom: Boolean(sourceDocument.bom)
  }));
}

async function saveAllSourceDocuments(onlyKeys = null) {
  const allowed = onlyKeys ? new Set(onlyKeys) : null;
  const files = getSourceWriteTargets().filter(file => !allowed || allowed.has(file.relativePath));
  if (!files.length) return 0;
  await desktopApi.writeSourceFiles({ sourcePath: state.sourcePath, sourceType: state.sourceType, files });
  return files.length;
}

function getChapterSourceDocumentKey(chapter) {
  return String(chapter?.sourceDocumentKey || chapter?.filename || '');
}

function canSaveChapterToSource(chapter) {
  if (!isDesktop || !desktopApi?.writeSourceFiles || !chapter || chapter.isEpubHtml) return false;
  if (!['book', 'folder'].includes(state.sourceType) || !state.sourcePath || !textFilePattern.test(chapter.filename || '')) return false;
  const sourceKey = getChapterSourceDocumentKey(chapter);
  const sourceDocument = state.sourceDocuments[sourceKey];
  return Boolean(sourceDocument && typeof sourceDocument.content === 'string' && Number.isInteger(chapter.sourceBodyStart) && Number.isInteger(chapter.sourceBodyEnd));
}

function getSourceSaveNotice(chapter) {
  if (chapter?.isEpubHtml || /\.(epub|zip)$/i.test(chapter?.filename || state.sourcePath || '')) return 'EPUB 和 ZIP 为避免破坏原排版，仅保存到阅读器本地副本。';
  if (isDesktop && state.sourcePath) return '未找到原文件的可写正文范围，仅保存到阅读器本地副本。';
  return '当前环境不支持覆盖原文件，已保存到阅读器本地副本。';
}

function buildSourceDocumentUpdate(chapter, content) {
  const sourceKey = getChapterSourceDocumentKey(chapter);
  const sourceDocument = state.sourceDocuments[sourceKey];
  const bodyStart = Number(chapter.sourceBodyStart);
  const bodyEnd = Number(chapter.sourceBodyEnd);
  if (!sourceDocument || !Number.isInteger(bodyStart) || !Number.isInteger(bodyEnd) || bodyStart < 0 || bodyEnd < bodyStart || bodyEnd > sourceDocument.content.length) {
    throw new Error('无法定位本章在原文件中的正文范围，请重新载入原文件后再保存');
  }

  const previousBody = sourceDocument.content.slice(bodyStart, bodyEnd);
  const leadingSpace = previousBody.match(/^\s*/)?.[0] || '';
  const trailingSpace = previousBody.match(/\s*$/)?.[0] || '';
  const replacement = `${leadingSpace}${content}${trailingSpace}`;
  return {
    sourceKey,
    sourceDocument,
    bodyStart,
    bodyEnd,
    replacement,
    content: `${sourceDocument.content.slice(0, bodyStart)}${replacement}${sourceDocument.content.slice(bodyEnd)}`
  };
}

function applySourceDocumentUpdate(chapter, content, update) {
  const previousEnd = update.bodyEnd;
  const delta = update.replacement.length - (update.bodyEnd - update.bodyStart);
  update.sourceDocument.content = update.content;
  state.chapters.forEach(item => {
    if (getChapterSourceDocumentKey(item) !== update.sourceKey) return;
    if (item === chapter) {
      item.content = content;
      item.sourceBodyEnd = update.bodyStart + update.replacement.length;
      return;
    }
    if (Number.isInteger(item.sourceBodyStart) && item.sourceBodyStart >= previousEnd) item.sourceBodyStart += delta;
    if (Number.isInteger(item.sourceBodyEnd) && item.sourceBodyEnd >= previousEnd) item.sourceBodyEnd += delta;
  });
}

async function saveChapterToSource(chapter, content) {
  const update = buildSourceDocumentUpdate(chapter, content);
  await desktopApi.writeSourceFiles({
    sourcePath: state.sourcePath,
    sourceType: state.sourceType,
    files: [{ relativePath: update.sourceKey, content: update.content, encoding: update.sourceDocument.encoding || '', bom: Boolean(update.sourceDocument.bom) }]
  });
  applySourceDocumentUpdate(chapter, content, update);
}
