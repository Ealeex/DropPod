export function button(label, action, className = 'text-button') {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = className;
  control.textContent = label;
  control.addEventListener('click', action);
  return control;
}

export function toolbar(...controls) {
  const element = document.createElement('div');
  element.className = 'preview-tools';
  element.append(...controls);
  return element;
}

export function message(text) {
  const element = document.createElement('p');
  element.className = 'preview-message';
  element.textContent = text;
  return element;
}


export function showMessage(host, text) {
  host.replaceChildren(message(text));
}

export async function fetchPreview({ url, signal, onUnauthorized }, errorMessage, useServerError = false) {
  const response = await fetch(url, { signal });
  signal.throwIfAborted();
  if (response.status === 401 && await onUnauthorized(response)) {
    throw new DOMException('Authentication required.', 'AbortError');
  }
  if (!response.ok) {
    const data = useServerError ? await response.json().catch(() => ({})) : {};
    throw new Error(data.error || errorMessage);
  }
  return response;
}
