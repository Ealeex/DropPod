import { grid } from './table.mjs';

let csv;

export async function renderDelimited(text, delimiter) {
  csv ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/preview/papaparse.js';
    script.onload = () => resolve(window.Papa);
    script.onerror = reject;
    document.head.append(script);
  });
  const parsed = (await csv).parse(text, { delimiter, preview: 501, skipEmptyLines: true });
  return grid(parsed.data, parsed.meta.truncated);
}
