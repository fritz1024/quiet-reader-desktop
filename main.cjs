const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_NAME = '静读阅读器';
const BOOK_EXTENSIONS = new Set(['.epub', '.txt', '.md', '.markdown', '.zip']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);

app.setName(APP_NAME);

let mainWindow = null;
let pendingBookPaths = [];
let storageWrite = Promise.resolve();
let updateSupported = false;
let updateAction = '';
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

async function readStorage() {
  try {
    const raw = await fs.readFile(getStoragePath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
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

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.epub') return 'application/epub+zip';
  if (extension === '.zip') return 'application/zip';
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  return 'text/plain';
}

async function readBookFile(filePath) {
  if (!isSupportedBookPath(filePath)) throw new Error('不支持的书籍格式');
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) throw new Error('指定的路径不是文件');
  return {
    path: resolvedPath,
    name: path.basename(resolvedPath),
    type: mimeTypeFor(resolvedPath),
    bytes: await fs.readFile(resolvedPath)
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
      items.push({
        name: entry.name,
        relativePath,
        type: mimeTypeFor(entry.name),
        bytes: await fs.readFile(fullPath)
      });
    }
  }
  return items;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: APP_NAME,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    flushBookPaths();
    mainWindow.webContents.send('reader:update-status', updateStatus);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
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
      return { path: resolvedPath, title: path.basename(resolvedPath), items: await collectFolderItems(resolvedPath) };
    });
    ipcMain.handle('reader:show-source', async (_event, sourcePath, isFolder) => {
      const resolvedPath = path.resolve(String(sourcePath || ''));
      const stat = await fs.stat(resolvedPath);
      if (isFolder || stat.isDirectory()) {
        const error = await shell.openPath(resolvedPath);
        if (error) throw new Error(error);
      } else {
        shell.showItemInFolder(resolvedPath);
      }
      return true;
    });
    ipcMain.handle('reader:take-open-book-paths', () => pendingBookPaths.splice(0));
    ipcMain.handle('reader:get-storage', () => readStorage());
    ipcMain.handle('reader:save-storage', async (_event, data) => { await writeStorage(data); return true; });
    ipcMain.handle('reader:get-update-info', () => updateStatus);
    ipcMain.handle('reader:check-for-updates', () => checkForUpdates());
    ipcMain.handle('reader:download-update', () => downloadUpdate());
    ipcMain.handle('reader:install-update', () => installUpdate());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
}
