import { button, fetchPreview, message, showMessage } from './common.mjs';

export async function render(context) {
  const { host, item, signal, archiveEntry, fallback } = context;
  showMessage(host, archiveEntry ? 'Loading…' : 'Loading preview…');
  const response = await fetchPreview(context, fallback);
  const text = await response.text();
  signal.throwIfAborted();
  renderText(host, text, item, signal);
}

function renderText(host, text, item, signal) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.append(code);
  host.replaceChildren(pre);
  if (item.previewTruncated) host.append(message('Showing the first 128 KB.'));
  if (item.language) colorizeCode(code, item.language);
  if (!/\.(?:md|csv|tsv)$/i.test(item.name)) return;
  const markdown = /\.md$/i.test(item.name);
  const view = document.createElement('div');
  pre.replaceWith(view);
  view.append(pre);
  const tools = document.createElement('div');
  tools.className = 'preview-tools';
  const toggle = button('Source', showSource, 'text-button');
  tools.append(toggle);
  host.prepend(tools);
  let rich;
  toggle.disabled = true;

  function showSource() {
    const showRich = view.firstChild === pre;
    view.replaceChildren(showRich ? rich : pre);
    toggle.textContent = showRich ? 'Source' : markdown ? 'Rendered' : 'Table';
    if (!showRich && item.language) colorizeCode(code, item.language);
  }

  const formatted = markdown
    ? import('./markdown.mjs').then(({ renderMarkdown }) => renderMarkdown(text))
    : import('./delimited.mjs').then(({ renderDelimited }) => renderDelimited(text, /\.tsv$/i.test(item.name) ? '\t' : ','));
  formatted.then((result) => {
    if (signal.aborted || !view.isConnected) return;
    rich = result;
    view.replaceChildren(rich);
    toggle.disabled = false;
  }).catch(() => tools.remove());
}

async function colorizeCode(code, language) {
  try {
    const { default: highlighter } = await import('/vendor/highlight/highlight.min.js');
    if (!highlighter.getLanguage(language)) {
      const { default: grammar } = await import(`/vendor/highlight/languages/${encodeURIComponent(language)}.min.js`);
      highlighter.registerLanguage(language, grammar);
    }
    if (!code.isConnected || code.dataset.highlighted) return;
    code.className = `language-${language}`;
    highlighter.highlightElement(code);
  } catch {
    // Keep the plain text readable when a highlighting module cannot load.
  }
}
