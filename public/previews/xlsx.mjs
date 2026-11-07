import { button, fetchPreview, message, showMessage, toolbar } from './common.mjs';
import { grid } from './table.mjs';

export async function render(context) {
  const { item, host, signal } = context;
  showMessage(host, 'Loading workbook…');
  if (item.size > 32 * 1024 * 1024) throw new Error('Workbook previews are limited to 32 MiB.');
  const response = await fetchPreview(context, 'This Office file could not be opened.', true);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  return createSpreadsheet(host, bytes);
}

function createSpreadsheet(host, bytes) {
  const worker = new Worker(new URL('./spreadsheet-preview-worker.mjs', import.meta.url), { type: 'module' });
  const tabs = toolbar();
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Worksheet');
  const content = document.createElement('div');
  content.replaceChildren(message('Reading workbook…'));
  host.replaceChildren(tabs, content);
  let selected = 0;
  let timer = setTimeout(failed, 15_000);

  function failed() {
    clearTimeout(timer);
    worker.terminate();
    content.replaceChildren(message('This workbook could not be read.'));
  }

  worker.onerror = failed;
  worker.onmessage = ({ data }) => {
    if (data.error) return failed();
    if (data.names) {
      tabs.replaceChildren(...data.names.map((name, index) => button(name, () => select(index))));
      select(0);
    } else if (selected === data.index) {
      clearTimeout(timer);
      content.replaceChildren(grid(data.rows, data.truncated));
    }
  };

  function select(index) {
    selected = index;
    [...tabs.children].forEach((tab, i) => tab.setAttribute('aria-pressed', String(i === selected)));
    content.replaceChildren(message('Reading worksheet…'));
    clearTimeout(timer);
    timer = setTimeout(failed, 15_000);
    worker.postMessage({ index });
  }

  worker.postMessage({ bytes }, [bytes]);
  return () => {
    clearTimeout(timer);
    worker.terminate();
  };
}
