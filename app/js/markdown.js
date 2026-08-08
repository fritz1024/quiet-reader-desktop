// Split from index.html — maintain in separate files under js/
import { escapeHtml } from './storage.js';

export function renderMarkdownInline(text) {
  const protectedTokens = [];
  const protect = (html) => { const token = `@@TOKEN_${protectedTokens.length}@@`; protectedTokens.push(html); return token; };
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_, code) => protect(`<code>${code}</code>`));
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
  return html.replace(/@@TOKEN_(\d+)@@/g, (_, index) => protectedTokens[Number(index)]);
}

export function renderMarkdown(content) {
  const lines = content.replace(/\r/g, '').split('\n');
  const output = []; let paragraph = []; let quote = []; let list = []; let listType = ''; let code = []; let inCode = false;
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${renderMarkdownInline(paragraph.join(' ').trim())}</p>`); paragraph = []; } };
  const flushQuote = () => { if (quote.length) { output.push(`<blockquote>${quote.map(line => `<p>${renderMarkdownInline(line)}</p>`).join('')}</blockquote>`); quote = []; } };
  const flushList = () => { if (list.length) { output.push(`<${listType}>${list.map(item => `<li>${renderMarkdownInline(item)}</li>`).join('')}</${listType}>`); list = []; listType = ''; } };
  const flushCode = () => { if (code.length || inCode) { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; inCode = false; } };
  lines.forEach((line, index) => {
    if (inCode) { if (/^\s*```/.test(line)) flushCode(); else code.push(line); return; }
    if (/^\s*```/.test(line)) { flushParagraph(); flushQuote(); flushList(); inCode = true; return; }
    const heading = line.match(/^\s*(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); flushQuote(); flushList(); const level = Math.max(2, heading[1].length); output.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`); return; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); flushQuote(); flushList(); output.push('<hr>'); return; }
    const quoteLine = line.match(/^\s*>\s?(.*)$/); if (quoteLine) { flushParagraph(); flushList(); quote.push(quoteLine[1]); return; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/); const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (ordered || unordered) { flushParagraph(); flushQuote(); const nextType = ordered ? 'ol' : 'ul'; if (listType && listType !== nextType) flushList(); listType = nextType; list.push((ordered || unordered)[1]); return; }
    if (!line.trim()) { flushParagraph(); flushQuote(); flushList(); return; }
    flushQuote(); flushList(); paragraph.push(line.trim());
    if (index === lines.length - 1) flushParagraph();
  });
  flushParagraph(); flushQuote(); flushList(); flushCode(); return output.join('');
}
