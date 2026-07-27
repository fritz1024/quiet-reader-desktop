const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const iconv = require('iconv-lite');
const JSZip = require('jszip');

const APP_NAME = '静读阅读器';
const BOOK_EXTENSIONS = new Set(['.epub', '.txt', '.md', '.markdown', '.zip']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);
const SOURCE_BACKUP_KEEP_COUNT = 10;
const APP_DATA_ARCHIVE_KIND = 'quiet-reader-data';
const APP_DATA_ARCHIVE_VERSION = 1;
const MAX_APP_DATA_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_APP_DATA_STORAGE_BYTES = 32 * 1024 * 1024;
const MAX_APP_DATA_BACKUP_FILES = 5000;
const isDevelopment = !app.isPackaged || process.argv.includes('--dev');
const configuredUserDataPath = String(process.env.QUIET_READER_USER_DATA || '').trim();

if (configuredUserDataPath) app.setPath('userData', path.resolve(configuredUserDataPath));

app.setName(APP_NAME);

let mainWindow = null;
let pendingBookPaths = [];
const readableSources = new Map();
let storageWrite = Promise.resolve();
let allowWindowClose = false;
let rendererReady = false;
let closeRequestPending = false;
let updateSupported = false;
let updateAction = '';
let storageRecoveryNotice = '';
let updateStatus = {
  enabled: false,
  status: 'unsupported',
  version: app.getVersion(),
  message: '当前版本不支持应用内更新'
};

function sendUpdateStatus(status, payload = {}) {
  updateStatus = { ...updateStatus, status, ...payload };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reader:update-status', updateStatus);
  }
}

function getUpdateErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (/404|no published versions|cannot find latest version/i.test(message)) {
    return '暂未发布可用更新，请稍后再试';
  }
  if (/network|enotfound|econn|timeout|fetch/i.test(message)) {
    return '无法连接更新服务，请检查网络后重试';
  }
  return updateAction === 'download' ? '下载更新失败，请稍后重试' : '检查更新失败，请稍后重试';
}

function reportUpdateError(error) {
  sendUpdateStatus('error', { message: getUpdateErrorMessage(error), error: String(error?.message || error || '') });
}

async function hasNsisUninstaller() {
  try {
    const files = await fs.readdir(path.dirname(process.execPath));
    return files.some(file => /^uninstall .*\.exe$/i.test(file));
  } catch (_) {
    return false;
  }
}

async function configureAutoUpdater() {
  updateSupported = app.isPackaged
    && process.platform === 'win32'
    && !process.env.PORTABLE_EXECUTABLE_DIR
    && !process.env.QUIET_READER_DISABLE_UPDATES
    && await hasNsisUninstaller();

  if (!updateSupported) {
    sendUpdateStatus('unsupported', {
      enabled: false,
      version: app.getVersion(),
      message: app.isPackaged ? '便携版不支持应用内更新，请使用安装版' : '开发环境不检查更新'
    });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking', { enabled: true, version: app.getVersion(), message: '正在检查更新...' });
  });
  autoUpdater.on('update-available', info => {
    sendUpdateStatus('available', {
      enabled: true,
      version: app.getVersion(),
      availableVersion: info.version,
      releaseDate: info.releaseDate || '',
      message: `发现新版本 v${info.version}`
    });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus('not-available', {
      enabled: true,
      version: app.getVersion(),
      message: '当前已是最新版本'
    });
  });
  autoUpdater.on('download-progress', progress => {
    sendUpdateStatus('downloading', {
      enabled: true,
      version: app.getVersion(),
      percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
      message: '正在下载更新...'
    });
  });
  autoUpdater.on('update-downloaded', info => {
    updateAction = '';
    sendUpdateStatus('downloaded', {
      enabled: true,
      version: app.getVersion(),
      availableVersion: info.version,
      percent: 100,
      message: '新版本已下载，重启后即可安装'
    });
  });
  autoUpdater.on('error', error => {
    updateAction = '';
    reportUpdateError(error);
  });

  sendUpdateStatus('idle', {
    enabled: true,
    version: app.getVersion(),
    message: '可检查 GitHub Releases 中的最新版本'
  });
}

async function checkForUpdates() {
  if (!updateSupported) return { ok: false, reason: 'unsupported' };
  if (updateStatus.status === 'checking') return { ok: false, reason: 'busy' };
  updateAction = 'check';
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    updateAction = '';
    reportUpdateError(error);
    return { ok: false, reason: 'error' };
  }
}

async function downloadUpdate() {
  if (!updateSupported || updateStatus.status !== 'available') return { ok: false, reason: 'unavailable' };
  updateAction = 'download';
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    updateAction = '';
    reportUpdateError(error);
    return { ok: false, reason: 'error' };
  }
}

function installUpdate() {
  if (!updateSupported || updateStatus.status !== 'downloaded') return { ok: false, reason: 'unavailable' };
  sendUpdateStatus('installing', { message: '正在重启并安装更新...' });
  allowWindowClose = true;
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
}

function isSupportedBookPath(filePath) {
  return BOOK_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function collectBookPaths(values) {
  return values.filter(value => typeof value === 'string' && isSupportedBookPath(value));
}

function queueBookPaths(paths) {
  const uniquePaths = collectBookPaths(paths).filter(filePath => !pendingBookPaths.includes(filePath));
  if (!uniquePaths.length) return;
  pendingBookPaths.push(...uniquePaths);
  flushBookPaths();
}

function flushBookPaths() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading() || !pendingBookPaths.length) return;
  const paths = pendingBookPaths.splice(0);
  mainWindow.webContents.send('reader:open-book', paths);
}

function getStoragePath() {
  return path.join(app.getPath('userData'), 'reader-data.json');
}

function getSourceBackupsRoot() {
  return path.join(app.getPath('userData'), 'source-backups');
}

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relation = path.relative(parent, candidate);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
}

async function quarantineUnreadableStorage(storagePath) {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.dirname(storagePath), `reader-data.corrupt-${suffix}.json`);
  try {
    await fs.rename(storagePath, backupPath);
    return backupPath;
  } catch (_) {
    return '';
  }
}

async function readStorage() {
  try {
    const raw = await fs.readFile(getStoragePath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const backupPath = await quarantineUnreadableStorage(getStoragePath());
      await writeStorage({}).catch(() => undefined);
      storageRecoveryNotice = backupPath
        ? '本地阅读记录无法读取，已保留损坏副本并创建新的记录。'
        : '本地阅读记录无法读取，已创建新的记录。';
    }
    return {};
  }
}

function writeStorage(data) {
  const payload = data && typeof data === 'object' ? data : {};
  storageWrite = storageWrite.catch(() => undefined).then(async () => {
    const storagePath = getStoragePath();
    const tempPath = `${storagePath}.tmp`;
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');
    await fs.rename(tempPath, storagePath);
  });
  return storageWrite;
}

function getArchiveTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function normalizeArchivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return '';
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return '';
  return parts.join('/');
}

async function listRegularFiles(rootPath, relativePath = '') {
  const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRegularFiles(fullPath, nextRelativePath));
    } else if (entry.isFile()) {
      files.push({ path: fullPath, relativePath: nextRelativePath.replace(/\\/g, '/') });
    }
  }
  return files;
}

async function getAppDataArchiveEntries() {
  const storagePath = getStoragePath();
  const storageBytes = await fs.readFile(storagePath).catch(error => {
    if (error?.code === 'ENOENT') return Buffer.from('{}', 'utf8');
    throw error;
  });
  if (storageBytes.length > MAX_APP_DATA_STORAGE_BYTES) {
    throw new Error('本地阅读数据过大，无法创建迁移备份');
  }
  try {
    const parsed = JSON.parse(storageBytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
  } catch (_) {
    throw new Error('本地阅读数据无法解析，请先在应用内修复后再导出');
  }

  const backupsRoot = getSourceBackupsRoot();
  const backupFiles = await listRegularFiles(backupsRoot);
  if (backupFiles.length > MAX_APP_DATA_BACKUP_FILES) {
    throw new Error(`原文件备份数量超过 ${MAX_APP_DATA_BACKUP_FILES} 个，无法创建迁移备份`);
  }
  let totalBytes = storageBytes.length;
  const files = [];
  for (const file of backupFiles) {
    const stat = await fs.stat(file.path);
    totalBytes += stat.size;
    if (totalBytes > MAX_APP_DATA_ARCHIVE_BYTES) {
      throw new Error(`迁移数据超过 ${Math.round(MAX_APP_DATA_ARCHIVE_BYTES / 1024 / 1024)} MB，无法创建归档`);
    }
    files.push({ ...file, size: stat.size });
  }
  return { storageBytes, backupFiles: files, totalBytes };
}

async function exportAppDataArchive() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出应用数据',
    defaultPath: `静读阅读器数据-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: '静读阅读器数据备份', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  const { storageBytes, backupFiles, totalBytes } = await getAppDataArchiveEntries();
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    kind: APP_DATA_ARCHIVE_KIND,
    version: APP_DATA_ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    backupFiles: backupFiles.length,
    uncompressedBytes: totalBytes
  }));
  zip.file('reader-data.json', storageBytes);
  for (const file of backupFiles) {
    const archivePath = `source-backups/${normalizeArchivePath(file.relativePath)}`;
    zip.file(archivePath, await fs.readFile(file.path));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const outputPath = path.resolve(result.filePath);
  const tempPath = `${outputPath}.quiet-reader-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tempPath, buffer, { flag: 'w' });
  await fs.rename(tempPath, outputPath);
  return { canceled: false, path: outputPath, backupFiles: backupFiles.length, size: buffer.length };
}

function getZipUncompressedSize(entry) {
  const size = Number(entry?._data?.uncompressedSize);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

async function readAppDataArchive(archivePath) {
  const resolvedPath = path.resolve(String(archivePath || ''));
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) throw new Error('选择的应用数据归档不是文件');
  if (stat.size > MAX_APP_DATA_ARCHIVE_BYTES) {
    throw new Error(`应用数据归档超过 ${Math.round(MAX_APP_DATA_ARCHIVE_BYTES / 1024 / 1024)} MB 的安全上限`);
  }
  const zip = await JSZip.loadAsync(await fs.readFile(resolvedPath));
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  if (entries.length > MAX_APP_DATA_BACKUP_FILES + 2) throw new Error('应用数据归档中的文件数量超出安全上限');

  let totalBytes = 0;
  for (const entry of entries) {
    const safePath = normalizeArchivePath(entry.name);
    if (!safePath || safePath !== entry.name.replace(/\\/g, '/')) throw new Error('应用数据归档包含无效的文件路径');
    totalBytes += getZipUncompressedSize(entry);
    if (totalBytes > MAX_APP_DATA_ARCHIVE_BYTES) {
      throw new Error(`应用数据归档解压后超过 ${Math.round(MAX_APP_DATA_ARCHIVE_BYTES / 1024 / 1024)} MB 的安全上限`);
    }
  }

  const manifestEntry = zip.file('manifest.json');
  const storageEntry = zip.file('reader-data.json');
  if (!manifestEntry || !storageEntry) throw new Error('这不是有效的静读阅读器数据归档');
  let manifest;
  let storage;
  try {
    manifest = JSON.parse(await manifestEntry.async('string'));
    storage = JSON.parse(await storageEntry.async('string'));
  } catch (_) {
    throw new Error('应用数据归档中的配置文件已损坏');
  }
  if (manifest?.kind !== APP_DATA_ARCHIVE_KIND || manifest.version !== APP_DATA_ARCHIVE_VERSION) {
    throw new Error('应用数据归档版本不受支持');
  }
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) throw new Error('应用数据归档中的阅读数据无效');

  const storageBytes = Buffer.from(JSON.stringify(storage), 'utf8');
  if (storageBytes.length > MAX_APP_DATA_STORAGE_BYTES) throw new Error('应用数据归档中的阅读数据过大');
  const backupEntries = entries.filter(entry => entry.name.startsWith('source-backups/'));
  if (backupEntries.length > MAX_APP_DATA_BACKUP_FILES) throw new Error('应用数据归档中的原文件备份数量过多');
  for (const entry of entries) {
    if (entry.name === 'manifest.json' || entry.name === 'reader-data.json' || entry.name.startsWith('source-backups/')) continue;
    throw new Error('应用数据归档包含不支持的文件');
  }
  return { storage, backupEntries, zip };
}

async function replaceAppDataFromArchive() {
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: '导入应用数据',
    properties: ['openFile'],
    filters: [{ name: '静读阅读器数据备份', extensions: ['zip'] }]
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };

  const { storage, backupEntries, zip } = await readAppDataArchive(selected.filePaths[0]);
  const userDataRoot = path.resolve(app.getPath('userData'));
  const backupsRoot = getSourceBackupsRoot();
  if (!isPathInside(userDataRoot, backupsRoot)) throw new Error('本地备份目录无效');
  const stamp = getArchiveTimestamp();
  const stagingRoot = path.join(userDataRoot, `source-backups.import-${stamp}-${process.pid}`);
  const previousRoot = path.join(userDataRoot, `source-backups.before-import-${stamp}`);
  const storagePath = getStoragePath();
  const previousStoragePath = path.join(userDataRoot, `reader-data.before-import-${stamp}.json`);
  if (!isPathInside(userDataRoot, stagingRoot) || !isPathInside(userDataRoot, previousRoot) || !isPathInside(userDataRoot, previousStoragePath)) {
    throw new Error('本地数据目录无效');
  }

  let oldStorageExists = false;
  let previousStorageCreated = false;
  let oldBackupsMoved = false;
  let stagedBackupsActivated = false;
  try {
    await fs.mkdir(stagingRoot, { recursive: true });
    for (const entry of backupEntries) {
      const relativePath = normalizeArchivePath(entry.name.slice('source-backups/'.length));
      if (!relativePath) throw new Error('应用数据归档包含无效的备份路径');
      const outputPath = path.resolve(stagingRoot, relativePath);
      if (!isPathInside(stagingRoot, outputPath)) throw new Error('应用数据归档包含越界的备份路径');
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, await entry.async('nodebuffer'), { flag: 'wx' });
    }

    await storageWrite.catch(() => undefined);
    oldStorageExists = await fs.access(storagePath).then(() => true).catch(() => false);
    if (oldStorageExists) {
      await fs.copyFile(storagePath, previousStoragePath, fs.constants.COPYFILE_EXCL);
      previousStorageCreated = true;
    }
    const oldBackupsExists = await fs.access(backupsRoot).then(() => true).catch(() => false);
    if (oldBackupsExists) {
      await fs.rename(backupsRoot, previousRoot);
      oldBackupsMoved = true;
    }
    await fs.rename(stagingRoot, backupsRoot);
    stagedBackupsActivated = true;
    await writeStorage(storage);
    await fs.rm(previousRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(previousStoragePath, { force: true }).catch(() => undefined);
    return { canceled: false, backupFiles: backupEntries.length };
  } catch (error) {
    if (stagedBackupsActivated) await fs.rm(backupsRoot, { recursive: true, force: true }).catch(() => undefined);
    let previousBackupsRestored = !oldBackupsMoved;
    if (oldBackupsMoved) {
      try {
        await fs.rename(previousRoot, backupsRoot);
        previousBackupsRestored = true;
      } catch (_) {
        // Keep the previous backup directory intact for manual recovery if the rollback cannot finish.
      }
    }
    let previousStorageRestored = !previousStorageCreated;
    if (previousStorageCreated) {
      const restoreTempPath = `${storagePath}.restore-${process.pid}-${Date.now()}.tmp`;
      try {
        await fs.copyFile(previousStoragePath, restoreTempPath);
        await fs.rename(restoreTempPath, storagePath);
        previousStorageRestored = true;
      } catch (_) {
        // Preserve the copied storage file for manual recovery if the rollback cannot finish.
      }
      await fs.rm(restoreTempPath, { force: true }).catch(() => undefined);
    } else if (!oldStorageExists) {
      await fs.rm(storagePath, { force: true }).catch(() => undefined);
    }
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (previousBackupsRestored) await fs.rm(previousRoot, { recursive: true, force: true }).catch(() => undefined);
    if (previousStorageRestored) await fs.rm(previousStoragePath, { force: true }).catch(() => undefined);
    await fs.rm(`${storagePath}.tmp`, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exportTextContent(request) {
  const content = typeof request?.content === 'string' ? request.content : '';
  const format = request?.format === 'markdown' ? 'markdown' : 'text';
  const extension = format === 'markdown' ? 'md' : 'txt';
  if (!content.trim()) throw new Error('没有可导出的正文内容');
  if (Buffer.byteLength(content, 'utf8') > MAX_APP_DATA_STORAGE_BYTES) throw new Error('导出内容过大');
  const suggestedName = String(request?.suggestedName || '静读阅读器导出').replace(/[\\/:*?"<>|]+/g, '-').trim() || '静读阅读器导出';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出正文',
    defaultPath: `${suggestedName}.${extension}`,
    filters: format === 'markdown'
      ? [{ name: 'Markdown 文件', extensions: ['md', 'markdown'] }]
      : [{ name: 'TXT 文本', extensions: ['txt'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const outputPath = path.resolve(result.filePath);
  const tempPath = `${outputPath}.quiet-reader-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, outputPath);
  return { canceled: false, path: outputPath, size: Buffer.byteLength(content, 'utf8') };
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.epub') return 'application/epub+zip';
  if (extension === '.zip') return 'application/zip';
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  return 'text/plain';
}

function isTextPath(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function isPlausibleTextContent(content) {
  const visible = Array.from(String(content || '')).filter(character => !/\s/u.test(character));
  if (visible.length < 2) return true;
  const suspicious = visible.filter(character => /[\uE000-\uF8FF\uFB00-\uFDFF\uFE70-\uFEFF\uFFF0-\uFFFF]/u.test(character));
  return suspicious.length / visible.length < 0.8;
}

function decodeTextFile(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 2).equals(Buffer.from([0xFF, 0xFE]))) {
    try {
      const content = new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
      if (!isPlausibleTextContent(content)) throw new Error('implausible');
    } catch (_) {
      throw new Error('UTF-16 文本文件已损坏');
    }
    return { encoding: 'utf16le', bom: true };
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xFE, 0xFF]))) {
    try {
      const content = new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
      if (!isPlausibleTextContent(content)) throw new Error('implausible');
    } catch (_) {
      throw new Error('UTF-16 文本文件已损坏');
    }
    return { encoding: 'utf16be', bom: true };
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return { encoding: 'utf8', bom: buffer.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])) };
  }
  const gb18030 = iconv.decode(buffer, 'gb18030');
  if (gb18030.includes('\uFFFD')) throw new Error('文本文件编码无法识别');
  return { encoding: 'gb18030', bom: false };
}

async function readBookFile(filePath) {
  if (!isSupportedBookPath(filePath)) throw new Error('不支持的书籍格式');
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) throw new Error('指定的路径不是文件');
  readableSources.set(resolvedPath, 'book');
  const bytes = await fs.readFile(resolvedPath);
  const textInfo = isTextPath(resolvedPath) ? decodeTextFile(bytes) : null;
  return {
    path: resolvedPath,
    name: path.basename(resolvedPath),
    type: mimeTypeFor(resolvedPath),
    bytes,
    encoding: textInfo?.encoding || '',
    bom: Boolean(textInfo?.bom)
  };
}

async function collectFolderItems(folderPath, prefix = '') {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      items.push(...await collectFolderItems(fullPath, relativePath));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const bytes = await fs.readFile(fullPath);
      const textInfo = decodeTextFile(bytes);
      items.push({
        name: entry.name,
        relativePath,
        type: mimeTypeFor(entry.name),
        bytes,
        encoding: textInfo.encoding,
        bom: textInfo.bom
      });
    }
  }
  return items;
}

function resolveFolderTextPath(folderPath, relativePath) {
  const rootPath = path.resolve(String(folderPath || ''));
  const requestedPath = String(relativePath || '');
  if (!requestedPath || path.isAbsolute(requestedPath)) throw new Error('无效的章节文件路径');

  const normalizedPath = path.normalize(requestedPath);
  if (normalizedPath === '..' || normalizedPath.startsWith(`..${path.sep}`)) {
    throw new Error('章节文件路径不能超出导入文件夹');
  }

  const targetPath = path.resolve(rootPath, normalizedPath);
  const relation = path.relative(rootPath, targetPath);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error('章节文件路径不能超出导入文件夹');
  }
  if (!TEXT_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) throw new Error('只能保存 TXT 或 Markdown 文件');
  return targetPath;
}

function getSourceBackupDirectory(filePath) {
  const hash = crypto.createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 20);
  return path.join(app.getPath('userData'), 'source-backups', hash);
}

function pathsMatch(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function getReadableTextSource(request) {
  const sourcePath = path.resolve(String(request?.sourcePath || ''));
  const sourceType = request?.sourceType;
  if (!['book', 'folder'].includes(sourceType) || readableSources.get(sourcePath) !== sourceType) {
    throw new Error('当前原文件未在本次运行中导入，无法访问备份');
  }

  if (sourceType === 'book') {
    if (!TEXT_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      throw new Error('只有 TXT 或 Markdown 原文件支持备份恢复');
    }
    return sourcePath;
  }

  return resolveFolderTextPath(sourcePath, request?.relativePath);
}

function isSafeBackupFileName(value) {
  return typeof value === 'string' && value === path.basename(value) && !value.includes(path.sep) && !value.includes('/');
}

async function readSourceBackupMetadata(sourceFilePath, backupFile) {
  if (!isSafeBackupFileName(backupFile)) throw new Error('备份标识无效');
  const backupDirectory = getSourceBackupDirectory(sourceFilePath);
  const backupPath = path.join(backupDirectory, backupFile);
  const metadataPath = `${backupPath}.json`;
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  if (
    metadata?.kind !== 'quiet-reader-source-backup'
    || metadata.backupFile !== backupFile
    || typeof metadata.sourcePath !== 'string'
    || !pathsMatch(metadata.sourcePath, sourceFilePath)
  ) {
    throw new Error('备份信息无效');
  }
  await fs.access(backupPath);
  return { backupDirectory, backupPath, metadata };
}

async function listSourceBackups(request) {
  const sourceFilePath = getReadableTextSource(request);
  const backupDirectory = getSourceBackupDirectory(sourceFilePath);
  const entries = await fs.readdir(backupDirectory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const backups = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const metadataPath = path.join(backupDirectory, entry.name);
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      if (
        metadata?.kind !== 'quiet-reader-source-backup'
        || !isSafeBackupFileName(metadata.backupFile)
        || typeof metadata.sourcePath !== 'string'
        || !pathsMatch(metadata.sourcePath, sourceFilePath)
      ) continue;
      const backupPath = path.join(backupDirectory, metadata.backupFile);
      const stat = await fs.stat(backupPath);
      if (!stat.isFile()) continue;
      backups.push({
        backupFile: metadata.backupFile,
        createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : '',
        size: Number.isFinite(Number(metadata.size)) ? Number(metadata.size) : stat.size,
        encoding: typeof metadata.encoding === 'string' ? metadata.encoding : '',
        bom: Boolean(metadata.bom)
      });
    } catch (_) {
      // Ignore a stale or manually modified backup entry and keep the rest usable.
    }
  }

  return backups.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function restoreSourceBackup(request) {
  const sourceFilePath = getReadableTextSource(request);
  const stat = await fs.stat(sourceFilePath);
  if (!stat.isFile()) throw new Error('原文件不存在，无法恢复备份');
  const { backupPath, metadata } = await readSourceBackupMetadata(sourceFilePath, request?.backupFile);
  const contents = await fs.readFile(backupPath);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempPath = `${sourceFilePath}.quiet-reader-restore-${nonce}.tmp`;
  const rollbackPath = `${sourceFilePath}.quiet-reader-restore-${nonce}.bak`;

  try {
    await fs.writeFile(tempPath, contents, { flag: 'wx' });
    await createSourceBackups([{ path: sourceFilePath, encoding: metadata.encoding || 'utf8', bom: Boolean(metadata.bom) }], nonce);
    await fs.rename(sourceFilePath, rollbackPath);
    try {
      await fs.rename(tempPath, sourceFilePath);
    } catch (error) {
      await fs.rm(sourceFilePath, { force: true }).catch(() => undefined);
      await fs.rename(rollbackPath, sourceFilePath).catch(() => undefined);
      throw error;
    }
    await fs.rm(rollbackPath, { force: true }).catch(() => undefined);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    const sourceExists = await fs.access(sourceFilePath).then(() => true).catch(() => false);
    const rollbackExists = await fs.access(rollbackPath).then(() => true).catch(() => false);
    if (!sourceExists && rollbackExists) await fs.rename(rollbackPath, sourceFilePath).catch(() => undefined);
    throw new Error(`恢复原文件备份失败：${error?.message || '请检查文件是否被其他程序占用'}`);
  }

  return { restored: true, size: contents.length };
}

async function trimSourceBackups(backupDirectory) {
  const entries = await fs.readdir(backupDirectory, { withFileTypes: true }).catch(() => []);
  const metadata = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const metadataPath = path.join(backupDirectory, entry.name);
    try {
      const value = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      if (value?.kind !== 'quiet-reader-source-backup' || typeof value.backupFile !== 'string') continue;
      metadata.push({ metadataPath, ...value });
    } catch (_) {
      // Keep malformed metadata untouched. It may belong to a manually recovered file.
    }
  }

  metadata.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  await Promise.all(metadata.slice(SOURCE_BACKUP_KEEP_COUNT).map(async backup => {
    const backupPath = path.resolve(backupDirectory, backup.backupFile);
    const relativePath = path.relative(backupDirectory, backupPath);
    if (relativePath && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
      await fs.rm(backupPath, { force: true }).catch(() => undefined);
    }
    await fs.rm(backup.metadataPath, { force: true }).catch(() => undefined);
  }));
}

async function createSourceBackups(targets, nonce) {
  const touchedDirectories = new Set();
  const createdAt = new Date().toISOString();
  for (const [index, target] of targets.entries()) {
    const backupDirectory = getSourceBackupDirectory(target.path);
    const backupFile = `${createdAt.replace(/[:.]/g, '-')}-${nonce}-${index}${path.extname(target.path) || '.txt'}`;
    const backupPath = path.join(backupDirectory, backupFile);
    const metadataPath = `${backupPath}.json`;
    const [contents, stat] = await Promise.all([fs.readFile(target.path), fs.stat(target.path)]);
    await fs.mkdir(backupDirectory, { recursive: true });
    await fs.writeFile(backupPath, contents, { flag: 'wx' });
    await fs.writeFile(metadataPath, JSON.stringify({
      kind: 'quiet-reader-source-backup',
      backupFile,
      sourcePath: target.path,
      createdAt,
      size: stat.size,
      encoding: target.encoding || 'utf8',
      bom: Boolean(target.bom)
    }), 'utf8');
    touchedDirectories.add(backupDirectory);
  }
  await Promise.all([...touchedDirectories].map(trimSourceBackups));
  return targets.length;
}

async function writeTextFilesAtomically(request) {
  const sourcePath = path.resolve(String(request?.sourcePath || ''));
  const sourceType = request?.sourceType;
  const files = Array.isArray(request?.files) ? request.files : [];
  if (!files.length) throw new Error('没有需要保存的正文文件');
  if (!['book', 'folder'].includes(sourceType) || readableSources.get(sourcePath) !== sourceType) {
    throw new Error('当前原文件未在本次运行中导入，无法覆盖');
  }

  let targets;
  if (sourceType === 'book') {
    if (files.length !== 1 || !TEXT_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      throw new Error('当前书籍格式不能直接覆盖源文件');
    }
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) throw new Error('指定的源文件不存在');
    targets = [{ path: sourcePath, content: files[0]?.content, encoding: files[0]?.encoding, bom: files[0]?.bom }];
  } else if (sourceType === 'folder') {
    const stat = await fs.stat(sourcePath);
    if (!stat.isDirectory()) throw new Error('指定的章节文件夹不存在');
    targets = await Promise.all(files.map(async file => {
      const targetPath = resolveFolderTextPath(sourcePath, file?.relativePath);
      const targetStat = await fs.stat(targetPath);
      if (!targetStat.isFile()) throw new Error('指定的章节文件不存在');
      return { path: targetPath, content: file?.content, encoding: file?.encoding, bom: file?.bom };
    }));
  } else {
    throw new Error('当前内容没有可覆盖的源文件');
  }

  const uniquePaths = new Set();
  targets.forEach(target => {
    if (typeof target.content !== 'string') throw new Error('正文内容格式无效');
    if (target.encoding && !['utf8', 'gb18030', 'utf16le', 'utf16be'].includes(target.encoding)) throw new Error('正文文件编码无效');
    if (target.bom && target.encoding && !['utf8', 'utf16le', 'utf16be'].includes(target.encoding)) throw new Error('当前文件编码不支持 BOM');
    const key = target.path.toLowerCase();
    if (uniquePaths.has(key)) throw new Error('同一源文件不能重复保存');
    uniquePaths.add(key);
  });

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = targets.map((target, index) => ({
    ...target,
    tempPath: `${target.path}.quiet-reader-${nonce}-${index}.tmp`,
    backupPath: `${target.path}.quiet-reader-${nonce}-${index}.bak`
  }));
  try {
    await Promise.all(staged.map(target => fs.writeFile(target.tempPath, iconv.encode(`${target.bom ? '\uFEFF' : ''}${target.content}`, target.encoding || 'utf8'))));
    await createSourceBackups(staged, nonce);
    await Promise.all(staged.map(target => fs.rename(target.path, target.backupPath)));
    try {
      for (const target of staged) await fs.rename(target.tempPath, target.path);
    } catch (error) {
      await Promise.all(staged.map(async target => {
        const backupExists = await fs.access(target.backupPath).then(() => true).catch(() => false);
        if (!backupExists) return;
        await fs.rm(target.path, { force: true }).catch(() => undefined);
        await fs.rename(target.backupPath, target.path).catch(() => undefined);
      }));
      throw error;
    }
    await Promise.all(staged.map(target => fs.rm(target.backupPath, { force: true }).catch(() => undefined)));
  } catch (error) {
    await Promise.all(staged.map(async target => {
      await fs.rm(target.tempPath, { force: true }).catch(() => undefined);
      const targetExists = await fs.access(target.path).then(() => true).catch(() => false);
      const backupExists = await fs.access(target.backupPath).then(() => true).catch(() => false);
      if (!targetExists && backupExists) await fs.rename(target.backupPath, target.path).catch(() => undefined);
    }));
    throw new Error(`保存原文件失败：${error?.message || '请检查文件是否被其他程序占用'}`);
  }
  return { count: targets.length, backups: targets.length };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: isDevelopment ? `${APP_NAME} 开发版` : APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => undefined);
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.on('close', event => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (rendererReady) mainWindow.webContents.send('reader:close-requested');
    else closeRequestPending = true;
  });
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  if (isDevelopment) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || (input.control && input.shift && key === 'i')) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      } else if ((input.control && key === 'r') || input.key === 'F5') {
        mainWindow.webContents.reloadIgnoringCache();
        event.preventDefault();
      }
    });
  }
  mainWindow.webContents.once('did-finish-load', () => {
    rendererReady = true;
    flushBookPaths();
    mainWindow.webContents.send('reader:update-status', updateStatus);
    if (closeRequestPending) {
      closeRequestPending = false;
      mainWindow.webContents.send('reader:close-requested');
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; allowWindowClose = false; closeRequestPending = false; });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  queueBookPaths(process.argv);

  app.on('second-instance', (_event, commandLine) => {
    queueBookPaths(commandLine);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueBookPaths([filePath]);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.fritz.quietreader');
    createWindow();
    configureAutoUpdater().then(() => {
      if (updateSupported) setTimeout(() => { checkForUpdates(); }, 5000);
    });

    ipcMain.handle('reader:choose-book', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入书籍',
        properties: ['openFile'],
        filters: [{ name: '书籍文件', extensions: ['epub', 'txt', 'md', 'markdown', 'zip'] }]
      });
      return result.canceled ? null : result.filePaths[0] || null;
    });

    ipcMain.handle('reader:choose-folder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入章节文件夹',
        properties: ['openDirectory']
      });
      return result.canceled ? null : result.filePaths[0] || null;
    });

    ipcMain.handle('reader:read-book', (_event, filePath) => readBookFile(filePath));
    ipcMain.handle('reader:read-folder', async (_event, folderPath) => {
      const resolvedPath = path.resolve(String(folderPath || ''));
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) throw new Error('指定的路径不是文件夹');
      readableSources.set(resolvedPath, 'folder');
      return { path: resolvedPath, title: path.basename(resolvedPath), items: await collectFolderItems(resolvedPath) };
    });
    ipcMain.handle('reader:write-source-files', async (_event, request) => writeTextFilesAtomically(request));
    ipcMain.handle('reader:list-source-backups', async (_event, request) => listSourceBackups(request));
    ipcMain.handle('reader:restore-source-backup', async (_event, request) => restoreSourceBackup(request));
    ipcMain.handle('reader:export-text-content', async (_event, request) => exportTextContent(request));
    ipcMain.handle('reader:export-app-data', () => exportAppDataArchive());
    ipcMain.handle('reader:import-app-data', () => replaceAppDataFromArchive());
    ipcMain.handle('reader:show-source', async (_event, sourcePath, isFolder) => {
      const resolvedPath = path.resolve(String(sourcePath || ''));
      const sourceType = isFolder ? 'folder' : 'book';
      if (readableSources.get(resolvedPath) !== sourceType) {
        throw new Error('当前原文件未在本次运行中导入，无法打开');
      }
      const stat = await fs.stat(resolvedPath);
      if (sourceType === 'folder') {
        if (!stat.isDirectory()) throw new Error('指定的原文件夹不存在');
        const error = await shell.openPath(resolvedPath);
        if (error) throw new Error(error);
      } else {
        if (!stat.isFile()) throw new Error('指定的原文件不存在');
        shell.showItemInFolder(resolvedPath);
      }
      return true;
    });
    ipcMain.handle('reader:take-open-book-paths', () => pendingBookPaths.splice(0));
    ipcMain.handle('reader:get-storage', async () => {
      const data = await readStorage();
      const recoveryMessage = storageRecoveryNotice;
      storageRecoveryNotice = '';
      return { data, recoveryMessage };
    });
    ipcMain.handle('reader:save-storage', async (_event, data) => { await writeStorage(data); return true; });
    ipcMain.handle('reader:get-update-info', () => updateStatus);
    ipcMain.handle('reader:check-for-updates', () => checkForUpdates());
    ipcMain.handle('reader:download-update', () => downloadUpdate());
    ipcMain.handle('reader:install-update', () => installUpdate());
    ipcMain.on('reader:confirm-close', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      allowWindowClose = true;
      mainWindow.close();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
}
