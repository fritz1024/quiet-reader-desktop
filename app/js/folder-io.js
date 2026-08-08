// Split from index.html — maintain in separate files under js/
import { state, isDesktop, desktopApi, $, textFilePattern, pdfFilePattern, settingsPanel, importPanel, editorPanel, backupPanel, searchPanel, marksPanel, exportPanel, mobileMorePanel, readerContainer, classifyFileCategory } from './state.js';
import { getSavedFolder, saveFolderHandle } from './storage.js';
import { canSaveChapterToSource, getChapterSourceDocumentKey } from './chapter.js';
import { showToast, showLoading, loadFromFileItems, loadBookFile } from './loader.js';

export function setFolderSource(handle) {
  state.folderHandle = handle || null;
  const canUpdate = isDesktop ? state.sourceType === 'folder' && Boolean(state.sourcePath) : (Boolean(handle) || state.chapters.length > 0);
  $('updateFolderBtn').classList.toggle('show', !state.demo && canUpdate);
  const canReload = isDesktop && !state.demo && state.sourceType === 'book' && Boolean(state.sourcePath);
  $('reloadSourceBtn').classList.toggle('show', canReload);
  const canUseSource = isDesktop && !state.demo && Boolean(state.sourcePath);
  $('showSourceBtn').classList.toggle('show', canUseSource);
  $('sourceBackupBtn').classList.toggle('show', Boolean(getSourceBackupRequest()));
  syncMobileMoreActions();
}

export function syncMobileMoreActions() {
  const canUpdate = isDesktop
    ? state.sourceType === 'folder' && Boolean(state.sourcePath)
    : Boolean(state.folderHandle || state.chapters.length);
  const canReload = isDesktop && !state.demo && state.sourceType === 'book' && Boolean(state.sourcePath);
  const canUseSource = isDesktop && !state.demo && Boolean(state.sourcePath);
  const canRestoreBackups = Boolean(getSourceBackupRequest());
  $('mobileUpdateFolderBtn').hidden = state.demo || !canUpdate;
  $('mobileReloadSourceBtn').hidden = !canReload;
  $('mobileBackupsBtn').hidden = !canRestoreBackups;
  $('mobileShowSourceBtn').hidden = !canUseSource;
}

export function closeFloatingPanels(except = '') {
  const panels = {
    settings: settingsPanel,
    import: importPanel,
    editor: editorPanel,
    backup: backupPanel,
    search: searchPanel,
    marks: marksPanel,
    export: exportPanel,
    more: mobileMorePanel
  };
  Object.entries(panels).forEach(([name, panel]) => {
    if (name !== except) panel.classList.remove('show');
  });
  if (except !== 'import') $('openImportBtn').setAttribute('aria-expanded', 'false');
  if (except !== 'more') $('mobileMoreBtn').setAttribute('aria-expanded', 'false');
}

export function openFloatingPanel(name, focusTarget = null) {
  const panels = {
    settings: settingsPanel,
    import: importPanel,
    editor: editorPanel,
    backup: backupPanel,
    search: searchPanel,
    marks: marksPanel,
    export: exportPanel,
    more: mobileMorePanel
  };
  const panel = panels[name];
  if (!panel) return false;
  const show = !panel.classList.contains('show');
  closeFloatingPanels(show ? name : '');
  panel.classList.toggle('show', show);
  if (name === 'import') $('openImportBtn').setAttribute('aria-expanded', String(show));
  if (name === 'more') $('mobileMoreBtn').setAttribute('aria-expanded', String(show));
  if (show && focusTarget) requestAnimationFrame(() => focusTarget.focus());
  return show;
}

export function toggleMobileMorePanel(force) {
  const show = typeof force === 'boolean' ? force : !mobileMorePanel.classList.contains('show');
  if (show) {
    closeFloatingPanels('more');
    syncMobileMoreActions();
  }
  mobileMorePanel.classList.toggle('show', show);
  $('mobileMoreBtn').setAttribute('aria-expanded', String(show));
}

export async function requestFolderPermission(handle, allowRequest) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  try {
    let permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted' && allowRequest && typeof handle.requestPermission === 'function') {
      permission = await handle.requestPermission({ mode: 'read' });
    }
    return permission === 'granted';
  } catch (_) {
    return false;
  }
}

export async function collectDirectoryFiles(handle, prefix = '') {
  const files = [];
  for await (const entry of handle.values()) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'file') {
      if (textFilePattern.test(entry.name)) files.push({ file: await entry.getFile(), relativePath, category: classifyFileCategory(relativePath) });
      else if (pdfFilePattern.test(entry.name)) files.push({ file: await entry.getFile(), relativePath, category: classifyFileCategory(relativePath), isPdf: true });
      else if (/.epub$/i.test(entry.name)) files.push({ file: await entry.getFile(), relativePath, category: classifyFileCategory(relativePath), isEpub: true });
    } else if (entry.kind === 'directory') {
      files.push(...await collectDirectoryFiles(entry, relativePath));
    }
  }
  return files;
}

export async function chooseFolder() {
  if (isDesktop) {
    try {
      const folderPath = await desktopApi.chooseFolder();
      if (!folderPath) return;
      await loadFromDesktopFolder(folderPath);
    } catch (error) {
      console.error(error);
      showToast('打开章节文件夹失败，请重试');
    }
    return;
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    folderInput.click();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    if (!(await requestFolderPermission(handle, true))) { showToast('没有获得文件夹读取权限'); return; }
    await saveFolderHandle(handle);
    const loaded = await loadFromDirectory(handle);
    if (loaded) showToast(`已导入 ${state.chapters.length} 个章节`);
  } catch (error) {
    if (error?.name !== 'AbortError') { console.error(error); showToast('打开文件夹失败，请重试'); }
  }
}

export function toggleImportPanel(force) {
  const show = typeof force === 'boolean' ? force : !importPanel.classList.contains('show');
  if (show) {
    closeFloatingPanels('import');
  }
  importPanel.classList.toggle('show', show);
  $('openImportBtn').setAttribute('aria-expanded', String(show));
}

export async function updateFolder() {
  if (isDesktop) {
    if (!state.sourcePath || state.sourceType !== 'folder') { chooseFolder(); return; }
    await loadFromDesktopFolder(state.sourcePath, { isUpdate: true });
    return;
  }
  let handle = state.folderHandle;
  if (!handle) {
    const saved = await getSavedFolder();
    handle = saved?.handle || null;
  }
  if (!handle) { chooseFolder(); return; }
  if (!(await requestFolderPermission(handle, true))) {
    showToast('请允许读取原来的文件夹');
    return;
  }
  await saveFolderHandle(handle);
  await loadFromDirectory(handle, { isUpdate: true });
}

export async function loadFromDirectory(handle, options = {}) {
  showLoading(true);
  try {
    const items = await collectDirectoryFiles(handle);
    const loaded = await loadFromFileItems(items, handle.name, handle, options);
    if (loaded && options.isUpdate) showToast(`已更新，共 ${state.chapters.length} 个章节`);
    return loaded;
  } catch (error) {
    console.error(error); showToast('读取文件夹失败，请重试');
    return false;
  } finally {
    showLoading(false);
  }
}

export function nativeFileFromResult(result) {
  if (!result || !result.name) throw new Error('无法读取所选文件');
  if (!result.bytes) return null;
  const file = new File([result.bytes], result.name, { type: result.type || 'application/octet-stream' });
  file.readerEncoding = result.encoding || '';
  file.readerBom = Boolean(result.bom);
  return file;
}

export async function loadDesktopBookPath(filePath, options = {}) {
  if (!isDesktop || !filePath) return false;
  try {
    const result = await desktopApi.readBook(filePath);
    return await loadBookFile(nativeFileFromResult(result), {
      ...options,
      sourcePath: result.path || filePath,
      sourceType: 'book'
    });
  } catch (error) {
    console.error(error);
    showToast(error?.message || '读取书籍失败，请检查文件是否仍然存在');
    return false;
  }
}

export async function loadFromDesktopFolder(folderPath, options = {}) {
  if (!isDesktop || !folderPath) return false;
  showLoading(true);
  try {
    const result = await desktopApi.readFolder(folderPath);
    const resolvedPath = result.path || folderPath;
    const items = (result.items || []).map(item => {
      const file = nativeFileFromResult(item);
      return {
        file,
        relativePath: item.relativePath || item.name,
        category: item.category || 'content',
        lazyLoad: Boolean(item.lazyLoad),
        lazyFileName: item.name,
        folderPath: resolvedPath,
        wordCount: typeof item.wordCount === 'number' ? item.wordCount : 0
      };
    });
    setFolderSource(null);
    const loaded = await loadFromFileItems(items, result.title || '我的小说', null, {
      ...options,
      sourcePath: resolvedPath,
      sourceType: 'folder',
      folderPath: resolvedPath
    });
    if (loaded && !options.isUpdate) showToast(`已导入 ${state.chapters.length} 个章节`);
    return loaded;
  } catch (error) {
    console.error(error);
    showToast(error?.message || '读取章节文件夹失败，请重试');
    return false;
  } finally {
    showLoading(false);
  }
}

export async function reloadSource() {
  if (!isDesktop || !state.sourcePath) return;
  if (state.sourceType === 'folder') {
    await loadFromDesktopFolder(state.sourcePath, { isUpdate: true });
  } else {
    await loadDesktopBookPath(state.sourcePath);
  }
}

export async function showSourceInExplorer() {
  if (!isDesktop || !state.sourcePath) return;
  try {
    await desktopApi.showSource(state.sourcePath, state.sourceType === 'folder');
  } catch (error) {
    console.error(error);
    showToast('无法打开原始文件的位置');
  }
}

export function getSourceBackupRequest() {
  const chapter = state.chapters[state.currentChapter];
  if (!isDesktop || !desktopApi?.listSourceBackups || !canSaveChapterToSource(chapter)) return null;
  const request = { sourcePath: state.sourcePath, sourceType: state.sourceType };
  if (state.sourceType === 'folder') request.relativePath = getChapterSourceDocumentKey(chapter);
  return request;
}

export function formatBackupSize(size) {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatBackupTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

export async function openSourceBackups() {
  const request = getSourceBackupRequest();
  if (!request) { showToast('当前内容没有可恢复的原文件备份'); return; }
  closeFloatingPanels('backup');
  backupPanel.classList.add('show');
  $('backupSourceName').textContent = state.sourceType === 'folder'
    ? `当前文件：${request.relativePath}`
    : `当前文件：${state.sourcePath.split(/[\\/]/).pop() || state.bookTitle}`;
  const list = $('backupList');
  const empty = $('backupEmpty');
  list.replaceChildren();
  empty.hidden = false;
  empty.textContent = '正在读取可恢复的原文件备份...';
  try {
    const backups = await desktopApi.listSourceBackups(request);
    list.replaceChildren();
    empty.hidden = backups.length > 0;
    empty.textContent = '还没有可恢复的原文件备份。';
    backups.forEach(backup => {
      const item = document.createElement('article');
      item.className = 'backup-item';
      const details = document.createElement('div');
      details.className = 'min-w-0';
      const time = document.createElement('div');
      time.className = 'backup-item-time';
      time.textContent = formatBackupTime(backup.createdAt);
      const meta = document.createElement('div');
      meta.className = 'backup-item-meta';
      meta.textContent = `${formatBackupSize(backup.size)}${backup.encoding ? ` · ${backup.encoding.toUpperCase()}` : ''}`;
      details.append(time, meta);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'secondary-button';
      restore.textContent = '恢复';
      restore.addEventListener('click', () => restoreSourceBackup(backup));
      item.append(details, restore);
      list.appendChild(item);
    });
  } catch (error) {
    console.error(error);
    empty.hidden = false;
    empty.textContent = error?.message || '读取原文件备份失败。';
  }
}
