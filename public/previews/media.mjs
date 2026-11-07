import { message, showMessage } from './common.mjs';

export function renderPlayer(context, tag) {
  const media = document.createElement(tag);
  media.controls = true;
  media.preload = 'metadata';
  media.setAttribute('aria-label', context.item.name);
  return renderMedia(context, media);
}

export function renderMedia(context, media, { element = media, dispose } = {}) {
  const { item, url, host, signal, archiveEntry, fallback } = context;
  let converted = Boolean(item.convertPreview);
  let loading;

  function showConversion() {
    loading = message('Preparing a compatible preview…');
    loading.setAttribute('role', 'status');
    host.append(loading);
  }

  media.addEventListener(media instanceof HTMLImageElement ? 'load' : 'loadedmetadata',
    () => loading?.remove(), { signal });
  media.addEventListener('error', () => {
    if (!archiveEntry && !converted) {
      converted = true;
      showConversion();
      media.src = url + '?compatible=1';
      return;
    }
    dispose?.();
    dispose = undefined;
    showMessage(host, fallback);
  }, { signal });
  host.replaceChildren(element);
  if (converted) showConversion();
  media.src = url;
  return () => {
    dispose?.();
    media.removeAttribute('src');
    if (media instanceof HTMLMediaElement) media.load();
  };
}
