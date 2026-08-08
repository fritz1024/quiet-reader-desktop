/* global JSZip */
// Split from index.html — maintain in separate files under js/
import { state, isDesktop, desktopApi, textFilePattern, maxBookFileBytes, maxTextFileBytes, maxZipEntries, maxZipUncompressedBytes, maxEmbeddedImageBytes, classifyFileCategory } from './state.js';
import { formatNumber, isMarkdownFile, getFilenameWithoutExtension } from './storage.js';
import { markdownToPlainText, normalizePunctuation, naturalCompare } from './text-utils.js';

export function readBinaryFile(file) {
  if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(event.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export function assertFileSize(file, maximumBytes, label) {
  const size = Number(file?.size || 0);
  if (size > maximumBytes) {
    throw new Error(`${label}超过 ${formatNumber(Math.round(maximumBytes / 1024 / 1024))} MB 的安全导入上限`);
  }
}

export function isPlausibleTextContent(content) {
  const visible = Array.from(String(content || '')).filter(character => !/\s/u.test(character));
  if (visible.length < 2) return true;
  const suspicious = visible.filter(character => /[\uE000-\uF8FF\uFB00-\uFDFF\uFE70-\uFEFF\uFFF0-\uFFFF]/u.test(character));
  return suspicious.length / visible.length < 0.8;
}

export function decodeTextBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const startsWith = (first, second) => bytes.length >= 2 && bytes[0] === first && bytes[1] === second;
  if (startsWith(0xFF, 0xFE)) {
    try {
      const content = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
      if (!isPlausibleTextContent(content)) throw new Error('implausible');
      return content;
    } catch (_) {
      throw new Error('UTF-16 文本文件已损坏');
    }
  }
  if (startsWith(0xFE, 0xFF)) {
    try {
      const content = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
      if (!isPlausibleTextContent(content)) throw new Error('implausible');
      return content;
    } catch (_) {
      throw new Error('UTF-16 文本文件已损坏');
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (_) {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch (_) {
      throw new Error('文本文件编码无法识别');
    }
  }
}

export async function readFile(file) {
  assertFileSize(file, maxTextFileBytes, '文本文件');
  return decodeTextBuffer(await readBinaryFile(file));
}

export function isReasonablePlainChapterTitle(title) {
  return String(title || '').trim().length <= 80;
}

export function parseInternalChapters(content, filename) {
  const pattern = /^\s*((?:第\s*[一二三四五六七八九十百千万零〇\d]+\s*[章节卷集回部篇].*|Chapter\s+\d+.*))\s*$/gim;
  const matches = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const headingStart = match.index + match[0].indexOf(match[1]);
    const title = match[1].trim();
    // A whole body paragraph can begin with "第一章"; chapter headings are compact by nature.
    if (!isReasonablePlainChapterTitle(title)) continue;
    matches.push({ index: headingStart, title });
  }
  if (matches.length <= 1) return [];
  return matches.map((item, index) => {
    const bodyStart = item.index + matchLineLength(content, item.index);
    const bodyEnd = index < matches.length - 1 ? matches[index + 1].index : content.length;
    return {
      title: item.title,
      content: content.slice(bodyStart, bodyEnd).trim(),
      filename,
      isMarkdown: false,
      sourceBodyStart: bodyStart,
      sourceBodyEnd: bodyEnd
    };
  });
}

export function matchLineLength(text, index) {
  const end = text.indexOf('\n', index);
  return end === -1 ? text.length - index : end - index + 1;
}

export function parseMarkdownChapters(content, filename) {
  const matches = [];
  const pattern = /^#\s+(.+?)\s*#*\s*$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) matches.push({ index: match.index, title: markdownToPlainText(match[1]) });
  if (matches.length <= 1) return [];
  return matches.map((item, index) => {
    const start = matchLineLength(content, item.index) + item.index;
    const end = index < matches.length - 1 ? matches[index + 1].index : content.length;
    return {
      title: item.title,
      content: content.slice(start, end).trim(),
      filename,
      isMarkdown: true,
      sourceBodyStart: start,
      sourceBodyEnd: end
    };
  });
}

export function extractLeadingPlainChapter(content) {
  const source = String(content || '').replace(/^\uFEFF/, '');
  const match = source.match(/^[ \t\r\n]*((?:第\s*[一二三四五六七八九十百千万零〇\d]+\s*[章节卷集回部篇][^\r\n]*|Chapter\s+\d+[^\r\n]*))[ \t]*(?:\r?\n|$)/i);
  if (!match || !isReasonablePlainChapterTitle(match[1])) return null;
  return { title: match[1].trim(), content: source.slice(match[0].length).trimStart() };
}

export function extractLeadingMarkdownChapter(content) {
  const source = String(content || '').replace(/^\uFEFF/, '');
  const match = source.match(/^[ \t\r\n]*#\s+(.+?)\s*#?[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  return { title: markdownToPlainText(match[1]), content: source.slice(match[0].length).trimStart() };
}

export function inferChapterTypes(chapters) {
  return (chapters || []).map(chapter => ({
    ...chapter,
    isMarkdown: chapter.isPdf ? false : Boolean(chapter.isMarkdown || isMarkdownFile(chapter.filename)),
    isPdf: Boolean(chapter.isPdf),
    isEpubFile: Boolean(chapter.isEpubFile)
  }));
}

export function getMarkdownTitle(content) {
  const match = content.match(/^\s*#\s+(.+?)\s*#*\s*$/m);
  return match ? markdownToPlainText(match[1]) : '';
}

export function chaptersFromTextContent(content, filename, relativePath = filename, category = 'content') {
  const displayFilename = String(filename || relativePath || '本地文件').split('/').pop();
  const isMarkdown = isMarkdownFile(displayFilename);
  const internal = isMarkdown ? parseMarkdownChapters(content, displayFilename) : parseInternalChapters(content, displayFilename);
  if ((!isMarkdown && internal.length > 0) || (isMarkdown && internal.length > 1)) {
    return internal.map((chapter, index) => ({
      ...chapter,
      filename: relativePath,
      sourceKey: `${relativePath}\u0000${chapter.title}\u0000${index}`,
      sourceDocumentKey: relativePath,
      category
    }));
  }
  const leadingChapter = isMarkdown ? extractLeadingMarkdownChapter(content) : extractLeadingPlainChapter(content);
  const title = leadingChapter?.title || (isMarkdown ? (getMarkdownTitle(content) || getFilenameWithoutExtension(displayFilename)) : getFilenameWithoutExtension(displayFilename));
  const bodyStart = leadingChapter ? String(content || '').length - String(leadingChapter.content || '').length : 0;
  return [{
    title,
    content: (leadingChapter?.content ?? String(content || '')).trim(),
    filename: relativePath,
    sourceKey: `${relativePath}\u0000${title}`,
    isMarkdown,
    sourceDocumentKey: relativePath,
    sourceBodyStart: bodyStart,
    sourceBodyEnd: String(content || '').length,
    category
  }];
}

export function normalizeZipPath(basePath, target) {
  let value = String(target || '').split(/[?#]/)[0].replace(/\\/g, '/');
  try { value = decodeURIComponent(value); } catch (_) { /* keep the original path */ }
  const combined = `${basePath ? `${basePath}/` : ''}${value}`.replace(/^\/+/, '');
  const parts = [];
  combined.split('/').forEach(part => {
    if (!part || part === '.') return;
    if (part === '..') { parts.pop(); return; }
    parts.push(part);
  });
  return parts.join('/');
}

export function getZipEntry(zip, path) {
  const normalized = normalizeZipPath('', path);
  const exact = zip.file(normalized);
  if (exact) return exact;
  const match = Object.values(zip.files).find(entry => !entry.dir && normalizeZipPath('', entry.name).toLowerCase() === normalized.toLowerCase());
  return match || null;
}

export function getZipEntryUncompressedSize(entry) {
  const size = Number(entry?._data?.uncompressedSize);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

export function getImportDiagnosticReason(error, fallback = '文件无法读取') {
  const message = String(error?.message || '').replace(/[\r\n]+/g, ' ').trim();
  return message || fallback;
}

export function formatImportDiagnostics(diagnostics) {
  const items = (diagnostics || []).filter(item => item?.path);
  if (!items.length) return '';
  const details = items.slice(0, 3).map(item => `${item.path}（${item.reason || '无法读取'}）`).join('、');
  return `跳过 ${items.length} 个无法解析的内部文件：${details}${items.length > 3 ? ' 等' : ''}`;
}

export async function loadZipWithLimits(buffer) {
  const byteLength = Number(buffer?.byteLength || buffer?.length || 0);
  if (byteLength > maxBookFileBytes) throw new Error(`压缩包超过 ${formatNumber(Math.round(maxBookFileBytes / 1024 / 1024))} MB 的安全导入上限`);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (_) {
    throw new Error('压缩包已损坏或不是有效的 ZIP 文件');
  }
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  if (entries.length > maxZipEntries) throw new Error(`压缩包中的文件数量超过 ${formatNumber(maxZipEntries)} 个，已停止解析`);
  const totalUncompressedBytes = entries.reduce((total, entry) => total + getZipEntryUncompressedSize(entry), 0);
  if (totalUncompressedBytes > maxZipUncompressedBytes) {
    throw new Error(`压缩包解压后超过 ${formatNumber(Math.round(maxZipUncompressedBytes / 1024 / 1024))} MB 的安全上限`);
  }
  return { zip, entries };
}

export function getXmlTextByLocalName(xml, localName) {
  const node = Array.from(xml.getElementsByTagName('*')).find(item => item.localName === localName || item.nodeName === localName);
  return node ? node.textContent.trim() : '';
}

export function getEpubHtmlText(html) {
  const documentNode = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return (documentNode.body?.innerText || documentNode.body?.textContent || '').replace(/^\uFEFF/, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeEpubHtml(html) {
  const documentNode = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const body = documentNode.body || documentNode.documentElement;
  body.querySelectorAll('script,style,link,meta,base,title,noscript,template,svg,math,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,option,audio,video,source,track,canvas').forEach(node => node.remove());
  body.querySelectorAll('*').forEach(node => {
    Array.from(node.attributes).forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const tagName = node.tagName.toLowerCase();
      const allowed = (
        name === 'class' || name === 'title' || name === 'role' || name.startsWith('aria-') ||
        (tagName === 'img' && ['src', 'alt', 'width', 'height'].includes(name)) ||
        (['td', 'th'].includes(tagName) && ['colspan', 'rowspan'].includes(name))
      );
      if (!allowed || name.startsWith('on') || name === 'style') node.removeAttribute(attribute.name);
      if (name === 'src' && tagName === 'img' && !/^data:image\//i.test(value)) node.removeAttribute(attribute.name);
    });
    if (node.tagName.toLowerCase() === 'img' && !node.getAttribute('src')) node.remove();
  });
  return body.innerHTML.trim();
}

export function normalizeHtmlPunctuation(html, options) {
  const documentNode = new DOMParser().parseFromString(sanitizeEpubHtml(html), 'text/html');
  const walker = documentNode.createTreeWalker(documentNode.body, NodeFilter.SHOW_TEXT);
  let changes = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('pre,code')) continue;
    const result = normalizePunctuation(node.nodeValue, options);
    node.nodeValue = result.text;
    changes += result.changes;
  }
  return { html: documentNode.body.innerHTML, changes };
}

export function getEpubAssetMimeType(path) {
  const extension = String(path || '').split('.').pop().toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', svgz: 'image/svg+xml', ico: 'image/x-icon'
  }[extension] || 'application/octet-stream';
}

export async function getEpubAssetDataUrl(zip, path, mediaType = '') {
  const entry = getZipEntry(zip, path);
  if (!entry) return '';
  const mimeType = mediaType || getEpubAssetMimeType(path);
  if (!/^image\//i.test(mimeType)) return '';
  if (getZipEntryUncompressedSize(entry) > maxEmbeddedImageBytes) return '';
  return `data:${mimeType};base64,${await entry.async('base64')}`;
}

export async function embedEpubImages(body, htmlPath, zip, manifestByPath) {
  const basePath = htmlPath.includes('/') ? htmlPath.slice(0, htmlPath.lastIndexOf('/')) : '';
  const images = Array.from(body.querySelectorAll('img[src]'));
  for (const image of images) {
    const source = image.getAttribute('src') || '';
    if (/^data:image\//i.test(source)) continue;
    const assetPath = normalizeZipPath(basePath, source);
    const asset = manifestByPath.get(assetPath.toLowerCase());
    try {
      const dataUrl = await getEpubAssetDataUrl(zip, assetPath, asset?.mediaType || '');
      if (dataUrl) image.setAttribute('src', dataUrl);
      else image.remove();
    } catch (_) {
      image.remove();
    }
  }
}

export async function chapterFromEpubHtmlDocument(html, htmlPath, sourceName, zip, manifestByPath, options = {}) {
  const documentNode = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const body = documentNode.body || documentNode.documentElement;
  const heading = body.querySelector('h1,h2,h3,h4');
  const headingTitle = heading?.textContent.replace(/\s+/g, ' ').trim() || '';
  const documentTitle = documentNode.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim() || '';
  const title = headingTitle || documentTitle || getFilenameWithoutExtension(htmlPath.split('/').pop() || htmlPath);
  await embedEpubImages(body, htmlPath, zip, manifestByPath);
  if (!options.isCover && heading && headingTitle === title) heading.remove();
  const htmlContent = sanitizeEpubHtml(body.innerHTML);
  return {
    title,
    content: getEpubHtmlText(htmlContent),
    htmlContent,
    filename: htmlPath.split('/').pop() || htmlPath,
    sourceKey: `${sourceName}\u0000${htmlPath}`,
    isMarkdown: false,
    isEpubHtml: true,
    isCover: Boolean(options.isCover)
  };
}

export async function parseEpubBuffer(buffer, sourceName = 'book.epub') {
  if (typeof JSZip === 'undefined') throw new Error('EPUB/ZIP解析库未加载');
  const { zip } = await loadZipWithLimits(buffer);
  const containerEntry = getZipEntry(zip, 'META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB缺少目录文件');
  const containerXml = new DOMParser().parseFromString(await containerEntry.async('string'), 'application/xml');
  if (containerXml.querySelector('parsererror')) throw new Error('EPUB 的 META-INF/container.xml 损坏');
  const rootfile = Array.from(containerXml.getElementsByTagName('*')).find(node => node.localName === 'rootfile' && node.getAttribute('full-path'));
  const opfPath = normalizeZipPath('', rootfile?.getAttribute('full-path') || '');
  const opfEntry = opfPath ? getZipEntry(zip, opfPath) : null;
  if (!opfEntry) throw new Error('EPUB缺少书籍目录');

  const opfXml = new DOMParser().parseFromString(await opfEntry.async('string'), 'application/xml');
  if (opfXml.querySelector('parsererror')) throw new Error('EPUB 书籍目录 OPF 损坏');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const manifest = new Map();
  Array.from(opfXml.getElementsByTagName('*')).filter(node => node.localName === 'item').forEach(item => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, {
      id,
      href: normalizeZipPath(opfDir, href),
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || ''
    });
  });
  const manifestByPath = new Map(Array.from(manifest.values()).map(item => [item.href.toLowerCase(), item]));
  const coverMeta = Array.from(opfXml.getElementsByTagName('*')).find(node => node.localName === 'meta' && String(node.getAttribute('name') || '').toLowerCase() === 'cover');
  const coverImageItem = manifest.get(coverMeta?.getAttribute('content') || '') || Array.from(manifest.values()).find(item => /\bcover-image\b/i.test(item.properties));
  const guideCoverPaths = Array.from(opfXml.getElementsByTagName('*'))
    .filter(node => node.localName === 'reference' && /cover|封面/i.test(`${node.getAttribute('type') || ''} ${node.getAttribute('title') || ''}`))
    .map(node => normalizeZipPath(opfDir, node.getAttribute('href') || ''))
    .filter(Boolean);

  const diagnostics = [];
  const spine = Array.from(opfXml.getElementsByTagName('*')).find(node => node.localName === 'spine');
  const itemRefs = spine
    ? Array.from(spine.getElementsByTagName('*')).filter(node => node.localName === 'itemref')
    : [];
  const orderedIds = itemRefs.map(item => item.getAttribute('idref')).filter(Boolean);
  orderedIds.forEach(id => {
    if (!manifest.has(id)) diagnostics.push({ path: `OPF spine: ${id}`, reason: '书籍目录引用的章节不存在' });
  });
  let orderedItems = (orderedIds.length ? orderedIds.map(id => manifest.get(id)).filter(Boolean) : Array.from(manifest.values()).sort((a, b) => naturalCompare(a.href, b.href)))
    .filter(item => /(?:xhtml|html|htm)$/i.test(item.href) || /html/i.test(item.mediaType))
    .filter(item => !/\bnav\b/i.test(item.properties));
  const guideCoverItems = guideCoverPaths.map(path => manifestByPath.get(path.toLowerCase())).filter(item => item && /(?:xhtml|html|htm)$/i.test(item.href));
  guideCoverItems.reverse().forEach(item => {
    if (!orderedItems.some(existing => existing.href === item.href)) orderedItems.unshift(item);
  });

  const chapters = [];
  for (let index = 0; index < orderedItems.length; index += 1) {
    const item = orderedItems[index];
    const entry = getZipEntry(zip, item.href);
    if (!entry) {
      diagnostics.push({ path: item.href, reason: '书籍目录引用的文件不存在' });
      continue;
    }
    const isCover = guideCoverPaths.some(path => path.toLowerCase() === item.href.toLowerCase()) || /(?:^|[/_.-])(cover|封面)(?:$|[/_.-])/i.test(item.href);
    try {
      chapters.push(await chapterFromEpubHtmlDocument(await entry.async('string'), item.href, sourceName, zip, manifestByPath, { isCover }));
    } catch (error) {
      console.warn('Unable to read EPUB chapter:', item.href, error);
      diagnostics.push({ path: item.href, reason: getImportDiagnosticReason(error, '章节内容无法解析') });
    }
  }
  if (!chapters.some(chapter => chapter.isCover) && coverImageItem) {
    try {
      const imageDataUrl = await getEpubAssetDataUrl(zip, coverImageItem.href, coverImageItem.mediaType);
      if (imageDataUrl) {
        const htmlContent = `<img src="${imageDataUrl}" alt="封面">`;
        chapters.unshift({
          title: '封面', content: '', htmlContent, filename: coverImageItem.href.split('/').pop() || 'cover',
          sourceKey: `${sourceName}\u0000${coverImageItem.href}\u0000cover`, isMarkdown: false, isEpubHtml: true, isCover: true
        });
      } else {
        diagnostics.push({ path: coverImageItem.href, reason: '封面图片无法读取' });
      }
    } catch (error) {
      console.warn('Unable to read EPUB cover:', coverImageItem.href, error);
      diagnostics.push({ path: coverImageItem.href, reason: getImportDiagnosticReason(error, '封面图片无法读取') });
    }
  }
  if (!chapters.length) {
    const detail = formatImportDiagnostics(diagnostics);
    throw new Error(`EPUB中没有可阅读的章节${detail ? `；${detail}` : ''}`);
  }
  const fallbackTitle = getFilenameWithoutExtension(String(sourceName).split('/').pop() || sourceName);
  return { title: getXmlTextByLocalName(opfXml, 'title') || fallbackTitle, chapters, diagnostics };
}

export async function parseEpubFile(file) {
  return parseEpubBuffer(await readBinaryFile(file), file.name);
}

export async function parseZipFile(file) {
  if (typeof JSZip === 'undefined') throw new Error('EPUB/ZIP解析库未加载');
  const { zip, entries } = await loadZipWithLimits(await readBinaryFile(file));
  const nestedEpub = entries.find(entry => /\.epub$/i.test(entry.name));
  if (nestedEpub) {
    if (getZipEntryUncompressedSize(nestedEpub) > maxBookFileBytes) throw new Error('压缩包内的 EPUB 超过安全导入上限');
    return parseEpubBuffer(await nestedEpub.async('arraybuffer'), nestedEpub.name);
  }

  const textEntries = entries.filter(entry => textFilePattern.test(entry.name)).sort((a, b) => naturalCompare(a.name, b.name));
  const chapters = [];
  const failedEntries = [];
  for (const entry of textEntries) {
    try {
      const bytes = await entry.async('uint8array');
      const content = decodeTextBuffer(bytes);
      chapters.push(...chaptersFromTextContent(content, entry.name, entry.name, classifyFileCategory(entry.name)));
    } catch (error) {
      console.warn('Unable to read ZIP text entry:', entry.name, error);
      failedEntries.push({ path: entry.name, reason: getImportDiagnosticReason(error, '文本文件无法读取') });
    }
  }
  if (!chapters.length) {
    const detail = formatImportDiagnostics(failedEntries);
    throw new Error(`压缩包中没有找到可读取的 TXT 或 Markdown 文件${detail}`);
  }
  return { title: getFilenameWithoutExtension(file.name), chapters, diagnostics: failedEntries };
}

export async function parseBookFile(file, relativePath = file.name) {
  const extension = (file.name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  if (extension !== 'pdf') assertFileSize(file, ['epub', 'zip'].includes(extension) ? maxBookFileBytes : maxTextFileBytes, ['epub', 'zip'].includes(extension) ? '书籍文件' : '文本文件');
  if (extension === 'pdf') {
  assertFileSize(file, maxBookFileBytes, 'PDF 文件');
  const buffer = await readBinaryFile(file);
  return {
    title: getFilenameWithoutExtension(file.name),
    chapters: [{
      title: getFilenameWithoutExtension(file.name),
      content: '',
      filename: relativePath,
      sourceKey: `${relativePath}\u0000pdf`,
      isMarkdown: false,
      isEpubHtml: false,
      isPdf: true,
      pdfBuffer: buffer,
      category: 'content'
    }]
  };
}
if (extension === 'epub') {
    const parsed = await parseEpubFile(file);
    return {
      ...parsed,
      chapters: parsed.chapters.map((chapter, index) => ({ ...chapter, filename: relativePath, sourceKey: `${relativePath}\u0000${chapter.title}\u0000${index}` }))
    };
  }
  if (extension === 'zip') {
    const parsed = await parseZipFile(file);
    return {
      ...parsed,
      chapters: parsed.chapters.map((chapter, index) => ({ ...chapter, sourceKey: `${relativePath}\u0000${chapter.sourceKey || chapter.title}\u0000${index}` }))
    };
  }
  const content = await readFile(file);
  return {
    title: getFilenameWithoutExtension(file.name),
    chapters: chaptersFromTextContent(content, file.name, relativePath),
    sourceDocuments: { [relativePath]: { content, encoding: file.readerEncoding || '', bom: Boolean(file.readerBom) } }
  };
}

export function getChapterBodyContent(chapter) {
  if (chapter.isPdf || chapter.isEpubFile) return '';
  if (chapter.content === null) return '（正在加载…）';
  let content = (chapter.content || '').replace(/^\uFEFF/, '');
  if (chapter.isMarkdown) return content.replace(/^(?:[ \t]*\r?\n)*[ \t]*#\s+.*?[ \t]*#?[ \t]*(?:\r?\n|$)/, '').trimStart();
  const heading = content.match(/^\s*((?:第\s*[一二三四五六七八九十百千万零〇\d]+\s*[章节卷集回部篇][^\r\n]*|Chapter\s+\d+[^\r\n]*))[ \t]*(?:\r?\n|$)/i);
  const headingMatchesTitle = heading && String(heading[1]).trim() === String(chapter.title || '').trim();
  return (headingMatchesTitle && isReasonablePlainChapterTitle(heading[1]) ? content.slice(heading[0].length) : content).trimStart();
}
