// Split from index.html — maintain in separate files under js/
import { state, $, readerContainer, readerContent, readerDialog, readerDialogTitle, readerDialogMessage, dialogKeepEditingBtn, dialogDiscardBtn, dialogSaveBtn, pendingReaderDialogResolve, setPendingReaderDialogResolve, closeRequestInProgress, setCloseRequestInProgress, desktopApi, isDesktop } from './state.js';
import { getChapterSourceKey, saveChapterEdits, canSaveChapterToSource, getChapterSourceDocumentKey, saveChapterToSource, getSourceSaveNotice } from './chapter.js';
import { sanitizeEpubHtml, getChapterBodyContent } from './parser.js';
import { renderChapter, renderChapterList } from './chapter-render.js';
import { getSourceBackupRequest, reloadSource } from './folder-io.js';
import { showToast } from './loader.js';
import { renderMarks, refreshSearchIndex } from './search.js';
import { saveLibrarySnapshot } from './storage.js';

export function getEditableChapterBody() {
  return readerContent.querySelector('.chapter-body');
}

export function updateEditorButton() {
  const button = $('editorBtn');
  const label = button.querySelector('span');
  const icon = button.querySelector('i');
  const editing = state.directEditing;
  label.textContent = editing ? '退出编辑' : '编辑正文';
  button.title = editing ? '退出编辑' : '直接编辑正文';
  button.setAttribute('aria-label', editing ? '退出编辑' : '直接编辑正文');
  icon.className = editing
    ? 'fa-solid fa-arrow-right-from-bracket text-[12px]'
    : 'fa-solid fa-pen-to-square text-[12px]';
}

export function getViewportTopAnchorText(body) {
  if (!body) return '';
  const containerTop = readerContainer.getBoundingClientRect().top;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const rect = node.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > containerTop + 4) {
      const text = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (text) return text;
    }
    node = walker.nextNode();
  }
  return '';
}

export function scrollRawMarkdownToAnchor(body, anchorText) {
  if (!anchorText) return false;
  const raw = body.textContent || '';
  const needle = anchorText.replace(/\s+/g, ' ');
  const flat = raw.replace(/\s+/g, ' ');
  const flatIndex = flat.indexOf(needle);
  if (flatIndex < 0) return false;
  let rawIndex = 0;
  let flatCount = 0;
  while (rawIndex < raw.length && flatCount < flatIndex) {
    const ch = raw[rawIndex];
    const isSpace = /\s/.test(ch);
    if (!isSpace) { flatCount += 1; rawIndex += 1; continue; }
    while (rawIndex < raw.length && /\s/.test(raw[rawIndex])) rawIndex += 1;
    flatCount += 1;
  }
  const range = document.createRange();
  const textNode = body.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false;
  const offset = Math.min(rawIndex, textNode.length);
  try {
    range.setStart(textNode, offset);
    range.setEnd(textNode, Math.min(offset + 1, textNode.length));
    const rect = range.getBoundingClientRect();
    const containerTop = readerContainer.getBoundingClientRect().top;
    readerContainer.scrollTop += rect.top - containerTop;
    return true;
  } catch {
    return false;
  }
}

export function setDirectEditing(enabled) {
  const body = getEditableChapterBody();
  if (!body) return;
  const chapter = state.chapters[state.currentChapter];
  const previousScroll = readerContainer.scrollTop;
  const anchorText = enabled && chapter?.isMarkdown && !chapter.isEpubHtml
    ? getViewportTopAnchorText(body)
    : '';
  state.directEditing = enabled;
  body.contentEditable = enabled ? 'true' : 'false';
  body.classList.toggle('direct-editing', enabled);
  body.classList.remove('raw-markdown');
  body.style.fontSize = '';
  body.style.lineHeight = '';
  updateEditorButton();
  if (enabled) {
    if (chapter?.isMarkdown && !chapter.isEpubHtml) {
      body.textContent = getChapterBodyContent(chapter);
      body.classList.add('raw-markdown');
      body.style.fontSize = `${state.fontSize}px`;
      body.style.lineHeight = state.lineHeight;
    }
    state.directEditOriginalText = getDirectEditSnapshot();
    try {
      body.focus({ preventScroll: true });
    } catch {
      body.focus();
    }
    requestAnimationFrame(() => {
      readerContainer.scrollTop = previousScroll;
      if (anchorText) scrollRawMarkdownToAnchor(body, anchorText);
    });
    updateEditorResult(canSaveChapterToSource(state.chapters[state.currentChapter])
      ? '正文已进入编辑模式，保存后会直接覆盖原文件。'
      : getSourceSaveNotice(state.chapters[state.currentChapter]));
    showToast('已进入正文编辑模式');
  } else {
    updateEditorResult('');
  }
}

export function getDirectEditContent() {
  const body = getEditableChapterBody();
  const chapter = state.chapters[state.currentChapter];
  if (!body) return '';
  const text = body.innerText.replace(/^\uFEFF/, '');
  return chapter?.isMarkdown ? text.replace(/\s+$/, '') : text.trim();
}

export function getDirectEditSnapshot() {
  const chapter = state.chapters[state.currentChapter];
  const body = getEditableChapterBody();
  if (!body) return '';
  return chapter?.isEpubHtml ? body.innerHTML : getDirectEditContent();
}

export function closeReaderDialog(result = 'keep') {
  if (!pendingReaderDialogResolve) return;
  const resolve = pendingReaderDialogResolve;
  setPendingReaderDialogResolve(null);
  readerDialog.classList.remove('show');
  readerDialog.setAttribute('aria-hidden', 'true');
  resolve(result);
}

export function askUnsavedAction(context = 'exit') {
  const isExit = context === 'exit';
  readerDialogTitle.textContent = '正文有未保存的修改';
  readerDialogMessage.textContent = isExit
    ? '退出编辑前要如何处理当前修改？'
    : '切换内容前要如何处理当前修改？';
  dialogSaveBtn.querySelector('span').textContent = isExit ? '保存并退出' : '保存并继续';
  dialogDiscardBtn.textContent = isExit ? '放弃修改' : '放弃并继续';
  dialogKeepEditingBtn.hidden = false;
  dialogKeepEditingBtn.textContent = '继续编辑';
  dialogDiscardBtn.hidden = false;
  readerDialog.classList.add('show');
  readerDialog.setAttribute('aria-hidden', 'false');
  dialogSaveBtn.focus();
  return new Promise(resolve => { setPendingReaderDialogResolve(resolve); });
}

export function askSourceBackupRestore() {
  readerDialogTitle.textContent = '恢复原文件备份';
  readerDialogMessage.textContent = '将用选中的备份覆盖当前原文件。恢复前，当前版本会先自动备份。';
  dialogKeepEditingBtn.hidden = false;
  dialogKeepEditingBtn.textContent = '取消';
  dialogDiscardBtn.hidden = true;
  dialogSaveBtn.querySelector('span').textContent = '恢复备份';
  readerDialog.classList.add('show');
  readerDialog.setAttribute('aria-hidden', 'false');
  dialogSaveBtn.focus();
  return new Promise(resolve => { setPendingReaderDialogResolve(resolve); });
}

export function askAppDataImport() {
  readerDialogTitle.textContent = '导入应用数据';
  readerDialogMessage.textContent = '导入后会覆盖当前阅读设置、阅读历史、本地编辑内容和原文件备份。';
  dialogKeepEditingBtn.hidden = true;
  dialogDiscardBtn.hidden = false;
  dialogDiscardBtn.textContent = '取消';
  dialogSaveBtn.querySelector('span').textContent = '选择备份并导入';
  readerDialog.classList.add('show');
  readerDialog.setAttribute('aria-hidden', 'false');
  dialogSaveBtn.focus();
  return new Promise(resolve => { setPendingReaderDialogResolve(resolve); });
}

export async function restoreSourceBackup(backup) {
  const request = getSourceBackupRequest();
  if (!request || !desktopApi?.restoreSourceBackup) { showToast('当前内容无法恢复原文件备份'); return; }
  if (hasUnsavedDirectEdit()) {
    const action = await askUnsavedAction('switch');
    if (action === 'keep') return;
    if (action === 'save' && !(await saveDirectEdit(false))) return;
    setDirectEditing(false);
    renderChapter(state.currentChapter);
  }
  const action = await askSourceBackupRestore();
  if (action !== 'save') return;
  try {
    await desktopApi.restoreSourceBackup({ ...request, backupFile: backup.backupFile });
    backupPanel.classList.remove('show');
    const reloaded = await reloadSource();
    if (reloaded !== false) showToast('已恢复原文件备份，并自动重新载入');
  } catch (error) {
    console.error(error);
    showToast(error?.message || '恢复原文件备份失败');
  }
}

export function hasUnsavedDirectEdit() {
  return state.directEditing && getDirectEditSnapshot() !== state.directEditOriginalText;
}

export async function handleCloseRequest() {
  if (closeRequestInProgress || pendingReaderDialogResolve) return true;
  if (!hasUnsavedDirectEdit()) {
    setCloseRequestInProgress(true);
    desktopApi?.confirmClose?.();
    return true;
  }
  const action = await askUnsavedAction('exit');
  if (action === 'keep') return true;
  if (action === 'save' && !(await saveDirectEdit(false))) return true;
  setCloseRequestInProgress(true);
  desktopApi?.confirmClose?.();
  return true;
}

export async function saveDirectEdit(showMessage = true) {
  const chapter = state.chapters[state.currentChapter];
  if (!chapter) return false;
  const content = getDirectEditContent();
  const canSaveToSource = canSaveChapterToSource(chapter);
  if (canSaveToSource) {
    try {
      await saveChapterToSource(chapter, content);
      delete state.chapterEdits[getChapterSourceKey(chapter)];
    } catch (error) {
      console.error(error);
      updateEditorResult(error?.message || '保存原文件失败，请检查文件是否被其他程序占用。');
      showToast('原文件保存失败，正文仍保持编辑状态');
      return false;
    }
  } else {
    chapter.content = content;
  }
  chapter.wordCount = 0;
  if (chapter.isEpubHtml) {
    chapter.htmlContent = sanitizeEpubHtml(getEditableChapterBody()?.innerHTML || '');
    state.chapterEdits[getChapterSourceKey(chapter)] = { content, htmlContent: chapter.htmlContent };
  } else if (!canSaveToSource) {
    state.chapterEdits[getChapterSourceKey(chapter)] = content;
  }
  state.directEditOriginalText = getDirectEditSnapshot();
  saveChapterEdits();
  renderChapterList();
  if (state.search.query) refreshSearchIndex(state.search.query);
  renderMarks();
  await saveLibrarySnapshot();
  if (showMessage) showToast(canSaveToSource ? '正文已保存到原文件' : getSourceSaveNotice(chapter));
  return true;
}

export async function saveAndExitDirectEditing() {
  if (!state.directEditing || !(await saveDirectEdit(false))) return false;
  const currentScroll = readerContainer.scrollTop;
  setDirectEditing(false);
  renderChapter(state.currentChapter, { saveProgress: false });
  requestAnimationFrame(() => { readerContainer.scrollTop = currentScroll; });
  showToast('正文已保存并退出编辑');
  return true;
}

export async function exitDirectEditing() {
  if (!state.directEditing) return true;
  const currentSnapshot = getDirectEditSnapshot();
  const hasChanges = currentSnapshot !== state.directEditOriginalText;
  let action = 'discard';
  if (hasChanges) {
    action = await askUnsavedAction('exit');
    if (action === 'keep') return false;
    if (action === 'save' && !(await saveDirectEdit(false))) return false;
  }
  const currentScroll = readerContainer.scrollTop;
  setDirectEditing(false);
  renderChapter(state.currentChapter);
  requestAnimationFrame(() => { readerContainer.scrollTop = currentScroll; });
  showToast(hasChanges && action === 'save' ? '正文修改已保存' : (hasChanges ? '已退出编辑，未保存修改已丢弃' : '已退出正文编辑模式'));
  return true;
}

export function updateEditorResult(message) {
  $('editorResult').textContent = message;
}

export function getCurrentFileChapters() {
  const current = state.chapters[state.currentChapter];
  if (!current) return [];
  if (current.isEpubHtml) return [current];
  const key = getChapterSourceDocumentKey(current);
  if (!key) return [current];
  return state.chapters.filter(chapter => !chapter.isEpubHtml && getChapterSourceDocumentKey(chapter) === key);
}

export function getCurrentFileLabel() {
  const current = state.chapters[state.currentChapter];
  const path = current?.sourceDocumentKey || current?.filename || '';
  return String(path).split('/').pop() || current?.title || '当前文件';
}
