import { button, toolbar } from './common.mjs';
import { renderMedia } from './media.mjs';

export function render(context) {
  const image = document.createElement('img');
  image.alt = context.item.name;
  return renderMedia(context, image, createImagePreview(image));
}

function createImagePreview(image) {
  const viewport = document.createElement('div');
  viewport.className = 'preview-image-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Pan image');
  const stage = document.createElement('div');
  stage.className = 'preview-image-stage';
  viewport.append(stage);
  stage.append(image);
  image.draggable = false;

  let zoom = 1;
  let angle = 0;
  let pointer;
  const out = button('−', () => setZoom(zoom / 1.5));
  out.setAttribute('aria-label', 'Zoom out');
  const inwards = button('+', () => setZoom(zoom * 1.5));
  inwards.setAttribute('aria-label', 'Zoom in');
  const tools = toolbar(
    out, inwards,
    button('Rotate', () => { angle = (angle + 90) % 360; layout(); }),
    button('Fit', () => setZoom(1)),
  );
  const element = document.createElement('div');
  element.className = 'preview-image';
  element.append(tools, viewport);

  function setZoom(value) {
    zoom = Math.min(8, Math.max(1, value));
    layout();
  }

  function layout() {
    const { naturalWidth, naturalHeight } = image;
    if (!naturalWidth || !naturalHeight) return;
    const swapped = angle % 180 !== 0;
    const width = swapped ? naturalHeight : naturalWidth;
    const height = swapped ? naturalWidth : naturalHeight;
    const fit = Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1);
    const scale = fit * zoom;
    stage.style.width = Math.ceil(width * scale) + 'px';
    stage.style.height = Math.ceil(height * scale) + 'px';
    image.style.width = naturalWidth * scale + 'px';
    image.style.height = naturalHeight * scale + 'px';
    image.style.transform = 'translate(-50%, -50%) rotate(' + angle + 'deg)';
    out.disabled = zoom <= 1;
    inwards.disabled = zoom >= 8;
    viewport.classList.toggle('is-zoomed', zoom > 1);
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || zoom === 1) return;
    viewport.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  });
  viewport.addEventListener('pointermove', (event) => {
    if (pointer?.id !== event.pointerId) return;
    viewport.scrollLeft = pointer.left + pointer.x - event.clientX;
    viewport.scrollTop = pointer.top + pointer.y - event.clientY;
  });
  viewport.addEventListener('lostpointercapture', () => { pointer = null; });
  const observer = new ResizeObserver(layout);
  observer.observe(viewport);
  image.addEventListener('load', layout);
  return { element, dispose: () => observer.disconnect() };
}
