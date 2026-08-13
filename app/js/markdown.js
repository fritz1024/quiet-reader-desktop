// Split from index.html — maintain in separate files under js/
// A small CommonMark/GFM-flavoured renderer. It is hand written so the reader
// stays dependency free, but it covers what notes and converted books actually
// contain: tables, nested and task lists, fenced code with a language tag,
// images, footnotes, reference links, alerts and a safe subset of raw HTML.
import { escapeHtml } from './storage.js';

// Sentinels: TOKEN wraps already-rendered HTML so later passes cannot look
// inside it, HARD_BREAK marks an explicit line break. Both are stripped from
// the source first, so a file can never smuggle one in.
const TOKEN = '\ue000';
const HARD_BREAK = '\ue001';
const SENTINELS = /[\ue000\ue001]/g;
const TOKEN_PATTERN = new RegExp(`${TOKEN}(\\d+)${TOKEN}`, 'g');

// Chinese wraps mid-sentence, so joining two CJK lines with a space would open
// a visible gap. Only insert one when at least one side is not CJK.
const CJK_RANGE = '\\u2e80-\\u303e\\u3041-\\u33ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uff60\\uffe0-\\uffe6';
const CJK_TAIL = new RegExp(`[${CJK_RANGE}]$`);
const CJK_HEAD = new RegExp(`^[${CJK_RANGE}]`);

const escapeAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

// Outline labels are plain text, so drop the markup a heading may carry.
function headingPlainText(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\[([^\]]*)\](?:\[[^\]]*\])?/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*\*|___|\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*([^*]+)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_([^_]+)_(?![\w_])/g, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim();
}

// Tags kept when a file embeds raw HTML. Anything unknown is unwrapped (its
// text survives); DROP_TAGS are removed together with their content.
const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'noscript', 'template', 'svg', 'math', 'audio', 'video', 'canvas']);
const VOID_TAGS = new Set(['br', 'col', 'hr', 'img', 'wbr']);
const GLOBAL_ATTRS = ['title', 'dir', 'lang', 'align', 'style'];
const TAG_ATTRS = {
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  td: ['colspan', 'rowspan', 'headers', 'valign'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'valign'],
  ol: ['start', 'type', 'reversed'],
  col: ['span', 'width'], colgroup: ['span', 'width'],
  details: ['open'], time: ['datetime'], q: ['cite'], blockquote: ['cite'],
  del: ['datetime', 'cite'], ins: ['datetime', 'cite']
};
const SAFE_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'text-decoration', 'font-style', 'font-weight', 'font-size', 'font-family', 'width', 'height', 'max-width', 'min-width', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'border', 'border-radius', 'float', 'vertical-align', 'line-height', 'letter-spacing', 'white-space', 'display', 'opacity']);

// Local files may not resolve, but a javascript: url must never survive.
function safeUrl(url, { allowData = false } = {}) {
  const value = String(url || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!value) return '';
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return value;
  const name = scheme[1].toLowerCase();
  if (name === 'data') return allowData && /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);/i.test(value) ? value : '';
  return ['http', 'https', 'mailto', 'tel', 'ftp', 'file'].includes(name) ? value : '';
}

const isExternal = (url) => /^(?:https?|ftp|mailto|tel):/i.test(url);

function safeStyle(value) {
  return String(value || '').split(';')
    .map(part => part.trim()).filter(Boolean)
    .filter(part => {
      const [prop, ...rest] = part.split(':');
      const body = rest.join(':');
      return body.trim() && SAFE_STYLE_PROPS.has(prop.trim().toLowerCase())
        && !/url\s*\(|expression|javascript:|@import/i.test(body);
    })
    .join('; ');
}

// Rebuild an attribute list from the allowlist, dropping id/class so embedded
// HTML cannot collide with heading ids or restyle the reader.
function safeAttributes(tag, read) {
  const allowed = [...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] || [])];
  const out = [];
  allowed.forEach(name => {
    let value = read(name);
    if (value === null || value === undefined) return;
    value = String(value);
    if (name === 'style') { value = safeStyle(value); if (!value) return; }
    if (name === 'href' || name === 'src' || name === 'cite') {
      value = safeUrl(value, { allowData: name === 'src' });
      if (!value) return;
    }
    if (name === 'target' && value !== '_blank') return;
    out.push(`${name}="${escapeAttr(value)}"`);
  });
  if (tag === 'a') {
    const href = read('href') ? safeUrl(read('href')) : '';
    if (href && isExternal(href) && !out.some(a => a.startsWith('target='))) out.push('target="_blank"', 'rel="noopener noreferrer"');
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

// One raw tag from an inline run. Unknown or dropped tags are escaped so the
// reader shows the text instead of silently swallowing it.
function sanitizeTag(raw) {
  const match = raw.match(/^<\s*(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>$/);
  if (!match) return escapeHtml(raw);
  const [, closing, rawName, attrText, selfClose] = match;
  const tag = rawName.toLowerCase();
  if (DROP_TAGS.has(tag) || !ALLOWED_TAGS.has(tag)) return escapeHtml(raw);
  if (closing) return `</${tag}>`;
  const attrs = {};
  attrText.replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    (_, name, dq, sq, bare) => { attrs[name.toLowerCase()] = dq ?? sq ?? bare ?? ''; return ''; });
  const rendered = `<${tag}${safeAttributes(tag, name => (name in attrs ? attrs[name] : null))}`;
  return VOID_TAGS.has(tag) ? `${rendered}>` : `${rendered}${selfClose ? ' /' : ''}>`;
}

// Tag names opened and not closed within one HTML block. A blank line ends an
// HTML block, so `<details>` … markdown … `</details>` arrives here in three
// pieces and the outer pieces are each unbalanced on their own.
function unbalancedTags(html) {
  const open = [];
  html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g, (whole, closing, name, attrs, selfClose) => {
    const tag = name.toLowerCase();
    if (VOID_TAGS.has(tag) || selfClose) return '';
    if (!closing) { open.push(tag); return ''; }
    const at = open.lastIndexOf(tag);
    if (at === -1) return `${tag}`; // a closer with no opener is unbalanced too
    open.splice(at, 1);
    return '';
  });
  return open;
}

// A multi-line raw HTML block. DOMParser normalises unbalanced markup so a
// stray <div> cannot swallow the rest of the chapter, but it would also close
// the opening half of a <details> wrapper and drop the closing half, so those
// are sanitised tag by tag and left for the page to pair up.
function sanitizeHtmlBlock(html) {
  const perTag = () => html.replace(/<[^>]*>/g, tag => sanitizeTag(tag));
  if (typeof DOMParser === 'undefined') return perTag();
  // A lone closer, or an opener whose content continues past this block.
  if (/^\s*<\/[a-zA-Z]/.test(html) || unbalancedTags(html).length) return perTag();
  const doc = new DOMParser().parseFromString(`<div id="md-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('md-root');
  if (!root) return escapeHtml(html);
  root.querySelectorAll('*').forEach(node => {
    const tag = node.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) { node.remove(); return; }
    if (!ALLOWED_TAGS.has(tag)) { node.replaceWith(...node.childNodes); return; }
    const read = (name) => (node.hasAttribute(name) ? node.getAttribute(name) : null);
    const attrs = safeAttributes(tag, read);
    [...node.attributes].forEach(attr => node.removeAttribute(attr.name));
    if (attrs) {
      const holder = doc.createElement('div');
      holder.innerHTML = `<span${attrs}></span>`;
      [...holder.firstChild.attributes].forEach(attr => node.setAttribute(attr.name, attr.value));
    }
  });
  return root.innerHTML;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(={2,}|-{3,})[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^(\s*)(?:([-+*])|(\d{1,9})[.)])(?:[ \t]+(.*)|)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const HTML_OPEN = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>/]|$)/;
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const LINK_DEF = /^ {0,3}\[([^\]^]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO|ABSTRACT|SUMMARY|QUESTION|SUCCESS|FAILURE|DANGER|BUG|EXAMPLE|QUOTE)\][ \t]*(.*)$/i;
// Guard for lazy continuation: a line that starts a different block must not be
// pulled into the paragraph above it.
const isBlockStart = (line) => !line.trim() || FENCE.test(line) || ATX.test(line) || THEMATIC.test(line)
  || QUOTE.test(line) || ITEM.test(line) || HTML_OPEN.test(line);
const indentOf = (line) => (line.match(/^ */) || [''])[0].length;
const dedent = (line, amount) => line.slice(Math.min(indentOf(line), amount));

// Leading tabs become spaces so indentation maths works; sentinels are removed
// so no file can forge one.
function prepare(content) {
  return String(content ?? '').replace(/\r\n?/g, '\n').replace(SENTINELS, '')
    .split('\n').map(line => line.replace(/^[ \t]+/, run => run.replace(/\t/g, '    ')));
}

// Front matter is metadata, not prose — drop it rather than render `---` plus a
// wall of key: value lines.
function stripFrontMatter(lines) {
  if (!/^---[ \t]*$/.test(lines[0] || '')) return lines;
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)[ \t]*$/.test(line));
  return end === -1 ? lines : lines.slice(end + 1);
}

// Footnote and link-reference definitions can sit anywhere and be used earlier,
// so collect them (and remove them) before parsing blocks. Fences are skipped
// so a definition inside a code sample stays visible.
function extractDefinitions(lines) {
  const refs = new Map(); const notes = new Map(); const rest = [];
  let fence = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE);
    if (fence) { rest.push(line); if (fenceMatch && fenceMatch[1].startsWith(fence[0]) && fenceMatch[1].length >= fence.length) fence = ''; continue; }
    if (fenceMatch) { fence = fenceMatch[1]; rest.push(line); continue; }
    const note = line.match(FOOTNOTE_DEF);
    if (note) {
      // A definition continues over plainly indented lines, and across a single
      // blank line when an indented line follows it.
      const body = [note[2]];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (/^ {2,}\S/.test(next)) { i += 1; body.push(next.trim()); continue; }
        if (!next.trim() && /^ {2,}\S/.test(lines[i + 2] || '')) { i += 2; body.push('', lines[i].trim()); continue; }
        break;
      }
      notes.set(note[1].toLowerCase(), { label: note[1], body: body.join('\n').trim(), index: 0 });
      continue;
    }
    const ref = line.match(LINK_DEF);
    if (ref && /^(?:<|[a-z][a-z0-9+.-]*:|[./#?])/i.test(ref[2])) {
      refs.set(ref[1].trim().toLowerCase(), { url: ref[2].replace(/^<|>$/g, ''), title: ref[3] || ref[4] || ref[5] || '' });
      continue;
    }
    rest.push(line);
  }
  return { lines: rest, refs, notes };
}

// Join the physical lines of one paragraph. Two trailing spaces or a trailing
// backslash mean an explicit break.
function joinParagraph(lines) {
  return lines.reduce((text, raw, index) => {
    const hardBreak = /(?: {2,}|\\)$/.test(raw);
    const line = raw.replace(/(?: {2,}|\\)$/, '').trim();
    if (!index) return line + (hardBreak ? HARD_BREAK : '');
    const glue = text.endsWith(HARD_BREAK) ? '' : (CJK_TAIL.test(text) && CJK_HEAD.test(line) ? '' : ' ');
    return text + glue + line + (hardBreak ? HARD_BREAK : '');
  }, '');
}

function pushHeading(context, level, text) {
  const index = context.headings.length;
  context.headings.push({ level, text: headingPlainText(text), index });
  return { type: 'heading', level, text, index };
}

// Parse a run of lines into block nodes. Called recursively for list items and
// blockquotes so nesting works at any depth.
function parseBlocks(lines, context) {
  const blocks = []; let paragraph = [];
  const flush = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', text: joinParagraph(paragraph) }); paragraph = []; } };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!line.trim()) { flush(); continue; }

    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const [, marker, info] = fence;
      const body = []; let closed = false;
      const baseIndent = indentOf(line);
      for (i += 1; i < lines.length; i += 1) {
        const close = lines[i].match(FENCE);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length && !close[2].trim()) { closed = true; break; }
        body.push(dedent(lines[i], baseIndent));
      }
      // An unterminated fence runs to the end of the block, so trailing blank
      // lines there are the document's, not the sample's.
      if (!closed) { i = lines.length; while (body.length && !body[body.length - 1].trim()) body.pop(); }
      blocks.push({ type: 'code', lang: (info || '').trim().split(/\s+/)[0] || '', text: body.join('\n') });
      continue;
    }

    const atx = line.match(ATX);
    if (atx) {
      flush();
      const text = (atx[2] || '').replace(/\s+#+\s*$/, '').trim();
      blocks.push(pushHeading(context, atx[1].length, text));
      continue;
    }

    // `Title` + `===` (or `---`) is a setext heading. `---` only counts under a
    // one-line paragraph, otherwise a divider after prose would swallow it.
    const setext = line.match(SETEXT);
    if (setext && paragraph.length && (setext[1][0] === '=' || paragraph.length === 1)) {
      const text = joinParagraph(paragraph); paragraph = [];
      blocks.push(pushHeading(context, setext[1][0] === '=' ? 1 : 2, text));
      continue;
    }

    if (THEMATIC.test(line)) { flush(); blocks.push({ type: 'hr' }); continue; }

    if (QUOTE.test(line)) {
      flush();
      const inner = [];
      for (; i < lines.length; i += 1) {
        const quote = lines[i].match(QUOTE);
        if (quote) { inner.push(quote[1]); continue; }
        if (!isBlockStart(lines[i]) && inner.length) { inner.push(lines[i]); continue; } // lazy continuation
        break;
      }
      i -= 1;
      const alert = (inner[0] || '').match(ALERT);
      if (alert) {
        const rest = alert[2].trim() ? [alert[2], ...inner.slice(1)] : inner.slice(1);
        blocks.push({ type: 'quote', alert: alert[1].toUpperCase(), children: parseBlocks(rest, context) });
      } else {
        blocks.push({ type: 'quote', alert: '', children: parseBlocks(inner, context) });
      }
      continue;
    }

    if (ITEM.test(line)) { flush(); i = parseList(lines, i, blocks, context); continue; }

    // GFM table: a header row plus a delimiter row of dashes and colons.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      const header = splitRow(line);
      const delimiters = splitRow(lines[i + 1]);
      if (delimiters.length > 1 || header.length === 1) {
        flush();
        i = parseTable(lines, i, header, delimiters, blocks, context);
        continue;
      }
    }

    if (!paragraph.length && HTML_OPEN.test(line)) {
      const tag = line.match(HTML_OPEN)[1].toLowerCase();
      const html = [];
      let depth = 0;
      for (; i < lines.length; i += 1) {
        html.push(lines[i]);
        const opens = (lines[i].match(new RegExp(`<${tag}(?=[\\s>/]|$)`, 'gi')) || []).length;
        const closes = (lines[i].match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length;
        depth += opens - closes;
        if (depth <= 0 && (closes || VOID_TAGS.has(tag) || /\/>\s*$/.test(lines[i]))) break;
        if (!lines[i].trim()) break;
        if (i + 1 < lines.length && !lines[i + 1].trim() && depth <= 0) break;
      }
      blocks.push({ type: 'html', text: html.join('\n') });
      continue;
    }

    paragraph.push(line);
  }
  flush();
  return blocks;
}

// One list, from the item at `start` to the first line that leaves it. Each
// item's own lines are re-parsed, so nested lists, quotes and fences all work.
// Returns the index of the last consumed line.
function parseList(lines, start, blocks, context) {
  const first = lines[start].match(ITEM);
  const baseIndent = first[1].length;
  const ordered = Boolean(first[3]);
  // Changing the bullet character starts a new list, per GFM, so `- a` then
  // `* b` renders as two lists rather than one.
  const bullet = first[2] || '';
  const items = [];
  let current = null; let contentIndent = 0; let loose = false; let blanks = 0; let index = start;

  const closeItem = () => { if (current) { items.push(current); current = null; } };

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) { blanks += 1; if (current) current.lines.push(''); continue; }
    const item = line.match(ITEM);
    const indent = indentOf(line);

    if (item && item[1].length <= baseIndent + 1) {
      // Sibling item — a different marker starts a new list instead.
      if (Boolean(item[3]) !== ordered || (!ordered && item[2] !== bullet)) break;
      if (blanks) loose = true;
      closeItem();
      const marker = item[2] || `${item[3]}.`;
      contentIndent = item[1].length + marker.length + 1;
      current = { lines: [item[4] || ''], number: item[3] ? Number(item[3]) : null };
      blanks = 0;
      continue;
    }
    if (!current) break;
    // A blank line then unindented text ends the list rather than continuing it.
    if (blanks && indent < Math.min(contentIndent, baseIndent + 2)) break;
    if (!blanks && indent <= baseIndent && isBlockStart(line) && !item) break;
    current.lines.push(dedent(line, contentIndent));
    blanks = 0;
  }
  closeItem();
  // Trailing blanks belong to whatever follows, not to the last item.
  items.forEach(item => { while (item.lines.length && !item.lines[item.lines.length - 1].trim()) item.lines.pop(); });
  // A blank line inside an item makes the whole list loose (item content gets <p>).
  if (items.some(item => item.lines.some((line, at) => !line.trim() && at < item.lines.length - 1))) loose = true;

  const parsed = items.map(item => {
    const task = item.lines[0] ? item.lines[0].match(TASK) : null;
    const body = task ? [task[2], ...item.lines.slice(1)] : item.lines;
    return {
      checked: task ? task[1].toLowerCase() === 'x' : null,
      number: item.number,
      children: parseBlocks(body, context)
    };
  });
  blocks.push({ type: 'list', ordered, loose, start: ordered && parsed[0] ? parsed[0].number : 1, items: parsed });
  return index - 1;
}

// Split a table row on unescaped pipes.
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = []; let cell = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '\\' && trimmed[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (char === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseTable(lines, start, header, delimiters, blocks, context) {
  const align = delimiters.map(cell => {
    const left = cell.startsWith(':'); const right = cell.endsWith(':');
    return left && right ? 'center' : (right ? 'right' : (left ? 'left' : ''));
  });
  const columns = header.length;
  const rows = []; let index = start + 2;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || !line.includes('|') || isBlockStart(line)) break;
    const cells = splitRow(line);
    while (cells.length < columns) cells.push('');
    rows.push(cells.slice(0, columns));
  }
  blocks.push({ type: 'table', header, align, rows });
  return index - 1;
}

// Inline pass. Anything already turned into HTML is parked in `tokens` so later
// rules (escaping, emphasis, bare urls) cannot reach inside it.
export function renderMarkdownInline(text, context = {}) {
  const tokens = [];
  const park = (html) => { tokens.push(html); return `${TOKEN}${tokens.length - 1}${TOKEN}`; };
  const refs = context.refs instanceof Map ? context.refs : new Map();
  const notes = context.notes instanceof Map ? context.notes : new Map();
  // Only TOKEN is stripped: HARD_BREAK at this point was put there by
  // joinParagraph, and the source was already cleaned in prepare().
  let html = String(text ?? '').split(TOKEN).join('');

  // Code spans first: their content is literal.
  html = html.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (whole, ticks, code) => {
    const body = code.replace(/\n/g, ' ');
    const trimmed = /^ .* $/.test(body) && body.trim() ? body.slice(1, -1) : body;
    return park(`<code>${escapeHtml(trimmed)}</code>`);
  });
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Autolinks before raw tags, or <https://x> would look like a <https> tag.
  html = html.replace(/<((?:https?|ftp|mailto):[^\s<>]+)>/gi, (whole, url) => {
    const safe = safeUrl(url);
    return safe ? park(`<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : park(escapeHtml(whole));
  });
  html = html.replace(/<([^\s<>@]+@[^\s<>@.]+\.[^\s<>@]+)>/g, (_, mail) => park(`<a href="mailto:${escapeAttr(mail)}">${escapeHtml(mail)}</a>`));
  // Raw tags: park what survives sanitising, park the escaped form otherwise so
  // the final escapeHtml pass cannot double-escape it.
  html = html.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?=[\s>/])(?:"[^"]*"|'[^']*'|[^>])*>|<\/?[a-zA-Z][a-zA-Z0-9-]*>/g, tag => park(sanitizeTag(tag)));
  // Backslash escapes: park the literal so it cannot act as markup.
  html = html.replace(/\\([!-\/:-@\[-`{-~])/g, (_, char) => park(escapeHtml(char)));

  // alt/title are plain text, and tokens are restored after this point, so fold
  // each token down to its text before escaping. Without this a parked `\"`
  // would restore a raw quote inside the attribute and break out of it.
  const attrValue = (value) => escapeAttr(value).replace(TOKEN_PATTERN, (whole, index) =>
    String(tokens[Number(index)] ?? '').replace(/<[^>]*>/g, '').replace(/"/g, '&quot;'));
  const linkTitle = (title) => (title ? ` title="${attrValue(title)}"` : '');
  // A destination is <…>, or unspaced text that may hold one level of balanced
  // parens — Wikipedia's "Foo_(bar)" style links depend on that.
  const DEST = '(<[^>]*>|(?:[^\\s()]|\\((?:[^\\s()])*\\))*)';
  const TITLE = '(?:\\s+(?:"([^"]*)"|\'([^\']*)\'|\\(([^()]*)\\)))?';
  // ![alt](src "title")
  html = html.replace(new RegExp(`!\\[([^\\]]*)\\]\\(\\s*${DEST}${TITLE}\\s*\\)`, 'g'), (whole, alt, rawUrl, dq, sq, pq) => {
    const title = dq || sq || pq || '';
    const src = safeUrl(rawUrl.replace(/^<|>$/g, ''), { allowData: true });
    if (!src) return escapeHtml(alt);
    return park(`<img src="${escapeAttr(src)}" alt="${attrValue(alt)}" loading="lazy"${linkTitle(title)}>`);
  });
  // ![alt][ref]
  html = html.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (whole, alt, label) => {
    const ref = refs.get((label || alt).trim().toLowerCase());
    if (!ref) return whole;
    const src = safeUrl(ref.url, { allowData: true });
    return src ? park(`<img src="${escapeAttr(src)}" alt="${attrValue(alt)}" loading="lazy"${linkTitle(ref.title)}>`) : escapeHtml(alt);
  });
  // [^1] — numbered by first use so the list at the end reads in order.
  html = html.replace(/\[\^([^\]\s]+)\]/g, (whole, label) => {
    const note = notes.get(label.toLowerCase());
    if (!note) return whole;
    if (!note.index) { note.index = context.noteOrder.length + 1; context.noteOrder.push(note); }
    const ref = context.footnoteRefs.get(note) || 0;
    context.footnoteRefs.set(note, ref + 1);
    const backId = `md-fnref-${note.index}${ref ? `-${ref}` : ''}`;
    return park(`<sup class="md-footnote-ref"><a id="${backId}" href="#md-fn-${note.index}">[${note.index}]</a></sup>`);
  });
  // [text](url "title") — the label stays in the stream so it keeps formatting.
  html = html.replace(new RegExp(`\\[([^\\][]*(?:\\[[^\\]]*\\][^\\][]*)*)\\]\\(\\s*${DEST}${TITLE}\\s*\\)`, 'g'), (whole, label, rawUrl, dq, sq, pq) => {
    const title = dq || sq || pq || '';
    const url = safeUrl(rawUrl.replace(/^<|>$/g, ''));
    if (!url) return label;
    const attrs = isExternal(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `${park(`<a href="${escapeAttr(url)}"${linkTitle(title)}${attrs}>`)}${label}${park('</a>')}`;
  });
  // [text][ref] and [ref][]
  html = html.replace(/\[([^\][]+)\](?:\[([^\]]*)\])?/g, (whole, label, key) => {
    const ref = refs.get((key || label).trim().toLowerCase());
    if (!ref) return whole;
    const url = safeUrl(ref.url);
    if (!url) return label;
    const attrs = isExternal(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `${park(`<a href="${escapeAttr(url)}"${linkTitle(ref.title)}${attrs}>`)}${label}${park('</a>')}`;
  });
  // Bare urls, once every bracketed form is out of the way.
  html = html.replace(/(^|[\s(【（<])((?:https?:\/\/|www\.)[^\s<>【】（）]+)/g, (whole, lead, rawUrl) => {
    let url = rawUrl.replace(/[.,;:!?、。，；：！？'"]+$/, '');
    while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
    const href = safeUrl(url.startsWith('www.') ? `https://${url}` : url);
    if (!href) return whole;
    return lead + park(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) + rawUrl.slice(url.length);
  });

  html = escapeHtml(html);
  html = html.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '<strong><em>$2</em></strong>');
  html = html.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
  html = html.replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>');
  html = html.replace(/\*(\S)\*/g, '<em>$1</em>');
  html = html.replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  html = html.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  html = html.replace(/~(?=[^\s~])([^~]*?[^\s~])~/g, '<sub>$1</sub>');
  html = html.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
  html = html.replace(new RegExp(HARD_BREAK, 'g'), '<br>');

  // Restore parked HTML; loop because a link label can itself hold a token.
  for (let pass = 0; pass < 5 && html.includes(TOKEN); pass += 1) {
    html = html.replace(TOKEN_PATTERN, (whole, index) => tokens[Number(index)] ?? '');
  }
  return html;
}

const ALERTS = {
  NOTE: ['提示', 'fa-circle-info'], INFO: ['说明', 'fa-circle-info'],
  TIP: ['技巧', 'fa-lightbulb'], SUCCESS: ['完成', 'fa-circle-check'],
  IMPORTANT: ['重要', 'fa-circle-exclamation'], WARNING: ['注意', 'fa-triangle-exclamation'],
  CAUTION: ['警告', 'fa-circle-exclamation'], DANGER: ['危险', 'fa-circle-exclamation'],
  FAILURE: ['失败', 'fa-circle-xmark'], BUG: ['缺陷', 'fa-bug'],
  QUESTION: ['疑问', 'fa-circle-question'], EXAMPLE: ['示例', 'fa-list-check'],
  ABSTRACT: ['摘要', 'fa-note-sticky'], SUMMARY: ['摘要', 'fa-note-sticky'],
  QUOTE: ['引用', 'fa-quote-left']
};

function renderList(node, context) {
  const tag = node.ordered ? 'ol' : 'ul';
  const start = node.ordered && node.start > 1 ? ` start="${node.start}"` : '';
  const isTask = node.items.some(item => item.checked !== null);
  const items = node.items.map(item => {
    const box = item.checked === null ? ''
      : `<input type="checkbox" class="md-task-check" disabled${item.checked ? ' checked' : ''}> `;
    const [head, ...tail] = item.children;
    // A tight item drops the <p> around its first block so lines stay compact.
    const headHtml = head && head.type === 'paragraph' && !node.loose
      ? renderMarkdownInline(head.text, context)
      : (head ? renderBlock(head, context) : '');
    const body = tail.map(child => renderBlock(child, context)).join('');
    return `<li${item.checked === null ? '' : ' class="md-task-item"'}>${box}${headHtml}${body}</li>`;
  }).join('');
  return `<${tag}${start}${isTask ? ' class="md-task-list"' : ''}>${items}</${tag}>`;
}

function renderTable(node, context) {
  const cell = (tag, text, index) => {
    const align = node.align[index] ? ` style="text-align: ${node.align[index]}"` : '';
    return `<${tag}${align}>${renderMarkdownInline(text, context)}</${tag}>`;
  };
  const head = `<thead><tr>${node.header.map((text, index) => cell('th', text, index)).join('')}</tr></thead>`;
  const body = node.rows.length
    ? `<tbody>${node.rows.map(row => `<tr>${row.map((text, index) => cell('td', text, index)).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<div class="md-table-wrap"><table>${head}${body}</table></div>`;
}

function renderBlock(node, context) {
  switch (node.type) {
    case 'heading': {
      // h1 is the chapter title, so body headings start at h2 and stop at h6.
      const level = Math.min(6, Math.max(2, node.level));
      return `<h${level} id="${markdownHeadingId(node.index)}">${renderMarkdownInline(node.text, context)}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${renderMarkdownInline(node.text, context)}</p>`;
    case 'code': {
      const lang = node.lang ? ` class="language-${escapeAttr(node.lang.toLowerCase())}"` : '';
      const label = node.lang ? ` data-lang="${escapeAttr(node.lang)}"` : '';
      return `<pre${label}><code${lang}>${escapeHtml(node.text)}</code></pre>`;
    }
    case 'quote': {
      const inner = node.children.map(child => renderBlock(child, context)).join('');
      if (!node.alert) return `<blockquote>${inner}</blockquote>`;
      const [label, icon] = ALERTS[node.alert] || ['提示', 'fa-circle-info'];
      return `<blockquote class="md-alert md-alert-${node.alert.toLowerCase()}">`
        + `<p class="md-alert-title"><i class="fa-solid ${icon}"></i>${label}</p>${inner}</blockquote>`;
    }
    case 'list': return renderList(node, context);
    case 'table': return renderTable(node, context);
    case 'hr': return '<hr>';
    case 'html': return sanitizeHtmlBlock(node.text);
    default: return '';
  }
}

// Only the footnotes actually referenced are listed, in reference order.
function renderFootnotes(context) {
  if (!context.noteOrder.length) return '';
  const items = context.noteOrder.map(note => {
    const body = note.body.split(/\n{2,}/).filter(Boolean)
      .map(part => `<p>${renderMarkdownInline(part, context)}</p>`).join('') || '<p></p>';
    return `<li id="md-fn-${note.index}">${body}<a class="md-footnote-back" href="#md-fnref-${note.index}" title="返回正文">↩</a></li>`;
  }).join('');
  return `<section class="md-footnotes"><hr><ol>${items}</ol></section>`;
}

// Parsing a chapter twice per render (body + outline) is wasteful, so keep the
// last few results. Keys are the chapter strings already held in state.
const parseCache = new Map();
const CACHE_LIMIT = 8;

function parseMarkdown(content) {
  const key = String(content ?? '');
  if (parseCache.has(key)) return parseCache.get(key);
  const context = { headings: [] };
  const { lines, refs, notes } = extractDefinitions(stripFrontMatter(prepare(key)));
  const result = { blocks: parseBlocks(lines, context), headings: context.headings, refs, notes };
  parseCache.set(key, result);
  if (parseCache.size > CACHE_LIMIT) parseCache.delete(parseCache.keys().next().value);
  return result;
}

// Heading id shared by renderMarkdown and the sidebar outline. Both read the
// same parse, so the nth heading gets the same id in both places.
export const markdownHeadingId = (index) => `md-heading-${index}`;

// Source-order headings with their raw level (1-6), used to build the outline.
export function getMarkdownHeadings(content) {
  return parseMarkdown(content).headings;
}

export function renderMarkdown(content) {
  const parsed = parseMarkdown(content);
  // Footnote numbering is per render, so it must not live in the cached parse.
  parsed.notes.forEach(note => { note.index = 0; });
  const context = { refs: parsed.refs, notes: parsed.notes, noteOrder: [], footnoteRefs: new Map() };
  const html = parsed.blocks.map(node => renderBlock(node, context)).join('');
  return html + renderFootnotes(context);
}

