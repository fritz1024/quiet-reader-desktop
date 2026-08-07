// Split from index.html — maintain in separate files under js/
function normalizeFileItems(files, pattern = textFilePattern) {
  return Array.from(files)
    .filter(file => pattern.test(file.name))
    .map(file => {
      const relativePath = file.webkitRelativePath || file.name;
      return { file, relativePath, category: classifyFileCategory(relativePath) };
    })
    .sort((a, b) => naturalCompare(a.relativePath, b.relativePath));
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function getWordCount(text, isMarkdown = false) {
  const readable = isMarkdown ? markdownToPlainText(String(text || '')) : String(text || '');
  return readable.trim().replace(/\s+/g, '').length;
}

function getBookWordCount() {
  return state.chapters
    .filter(chapter => !chapter.isCover && chapter.category !== 'reference' && !chapter.isPdf && !chapter.isEpubFile)
    .reduce((total, chapter) => {
      if (typeof chapter.wordCount === 'number' && chapter.wordCount > 0) return total + chapter.wordCount;
      if (chapter.content === null) return total;
      const wc = getWordCount(getChapterBodyContent(chapter), chapter.isMarkdown);
      chapter.wordCount = wc;
      return total + wc;
    }, 0);
}

function markdownToPlainText(text) {
  return String(text || '')
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, '$1')
    .replace(/^[ \t]*#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[-+*]\s+/gm, '')
    .replace(/^[ \t]*\d+[.)]\s+/gm, '')
    .replace(/^[ \t]*>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .trim();
}

function isInsideUrl(text, index) {
  let start = index - 1;
  while (start >= 0 && !/\s/.test(text[start])) start -= 1;
  const token = text.slice(start + 1, index + 1).replace(/^[([<{"“‘]+/, '');
  return /^(?:(?:https?|ftp):\/{0,2}|www\.)/i.test(token);
}

function normalizePunctuation(text, options) {
  const source = String(text || '');
  let result = '';
  let changes = 0;
  let inCode = false;
  let doubleQuoteOpen = true;
  let singleQuoteOpen = true;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '`') inCode = !inCode;
    if (inCode || isInsideUrl(source, index)) { result += character; continue; }

    if (character === '"' && options.quotes) {
      result += doubleQuoteOpen ? '“' : '”';
      doubleQuoteOpen = !doubleQuoteOpen;
      changes += 1;
    } else if (character === "'" && options.quotes) {
      result += singleQuoteOpen ? '‘' : '’';
      singleQuoteOpen = !singleQuoteOpen;
      changes += 1;
    } else if (character === ',' && options.commas) {
      result += '，'; changes += 1;
    } else if (character === ':' && options.colons && source.slice(index, index + 3) !== '://') {
      result += '：'; changes += 1;
    } else if (character === '!' && options.exclaims) {
      result += '！'; changes += 1;
    } else if (character === '?' && options.questions) {
      result += '？'; changes += 1;
    } else if (character === '.' && options.ellipses && source[index + 1] === '.') {
      let dotCount = 0;
      while (index + dotCount < source.length && source[index + dotCount] === '.') dotCount += 1;
      result += '……';
      changes += 1;
      index += dotCount - 1;
    } else {
      result += character;
    }
  }
  return { text: result, changes };
}

function getPunctuationOptions() {
  return {
    quotes: $('replaceQuotes').checked,
    commas: $('replaceCommas').checked,
    colons: $('replaceColons').checked,
    exclaims: $('replaceExclaims').checked,
    questions: $('replaceQuestions').checked,
    ellipses: $('replaceEllipses').checked
  };
}

function setPunctuationOptions(options) {
  if (!options) return;
  $('replaceQuotes').checked = Boolean(options.quotes);
  $('replaceCommas').checked = Boolean(options.commas);
  $('replaceColons').checked = Boolean(options.colons);
  $('replaceExclaims').checked = Boolean(options.exclaims);
  $('replaceQuestions').checked = Boolean(options.questions);
  $('replaceEllipses').checked = Boolean(options.ellipses);
}

function getCustomRules() {
  return Array.isArray(state.customReplaceRules) ? state.customReplaceRules : [];
}

function renderCustomRules() {
  const list = $('customRulesList');
  if (!list) return;
  const rules = getCustomRules();
  if (!rules.length) {
    list.innerHTML = '<div class="custom-rules-empty">还没有自定义规则，在下方添加</div>';
    return;
  }
  list.innerHTML = rules.map((rule, idx) => {
    const fromEsc = escapeHtml(rule.from);
    const toEsc = escapeHtml(rule.to);
    return `<div class="custom-rule-item" data-rule-index="${idx}">`
      + `<input type="checkbox" class="rule-toggle" data-action="toggle" ${rule.enabled !== false ? "checked" : ""}>`
      + `<span class="rule-from" title="${fromEsc}">${fromEsc}</span>`
      + `<span class="rule-arrow"><i class="fa-solid fa-arrow-right"></i></span>`
      + `<span class="rule-to" title="${toEsc}">${toEsc}</span>`
      + `<button type="button" class="rule-delete" data-action="delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>`
      + `</div>`;
  }).join("");
}

function addCustomRule(from, to) {
  if (!from || from === to) return false;
  const rules = getCustomRules();
  if (rules.some(r => r.from === from)) return false;
  rules.push({ from, to, enabled: true });
  state.customReplaceRules = rules;
  saveSettings();
  renderCustomRules();
  return true;
}

function removeCustomRule(index) {
  const rules = getCustomRules();
  if (index < 0 || index >= rules.length) return;
  rules.splice(index, 1);
  state.customReplaceRules = rules;
  saveSettings();
  renderCustomRules();
}

function toggleCustomRule(index) {
  const rules = getCustomRules();
  if (index < 0 || index >= rules.length) return;
  rules[index].enabled = rules[index].enabled === false ? true : false;
  state.customReplaceRules = rules;
  saveSettings();
}

function applyCustomRules(text) {
  const rules = getCustomRules();
  if (!rules.length) return { text, changes: 0 };
  let result = text;
  let changes = 0;
  for (const rule of rules) {
    if (rule.enabled === false || !rule.from) continue;
    let idx = result.indexOf(rule.from);
    while (idx >= 0) {
      result = result.substring(0, idx) + rule.to + result.substring(idx + rule.from.length);
      changes += 1;
      idx = result.indexOf(rule.from, idx + rule.to.length);
    }
  }
  return { text: result, changes };
}
