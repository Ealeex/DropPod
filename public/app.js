const app = document.querySelector('#app');
const announcement = document.querySelector('#announcement');
const icon = (name) => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const codePattern = /^[A-Z0-9]{6}$/;
const maxSize = 500 * 1024 * 1024;

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function announce(message) {
  announcement.textContent = message;
}

function ownerKey(code, key) {
  try {
    if (key) localStorage.setItem(`firesend:${code}`, key);
    return localStorage.getItem(`firesend:${code}`);
  } catch {
    return null;
  }
}

function openRoom(code) {
  location.assign(`/room/${code}`);
}

function joinForm() {
  return `<form id="join-form" class="join-form">
    <label class="sr-only" for="room-code">Room code</label>
    <input id="room-code" placeholder="Enter room code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
    <button class="button primary" aria-label="Join room" disabled>${icon('arrow')}</button>
  </form><p id="join-error" class="error" role="alert" hidden></p>`;
}

function bindJoin() {
  const form = document.querySelector('#join-form');
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  const error = document.querySelector('#join-error');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    button.disabled = !codePattern.test(input.value);
    error.hidden = true;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = input.value;
    if (!codePattern.test(code)) return;
    button.disabled = true;
    input.readOnly = true;
    error.hidden = true;
    try {
      await request(`/api/rooms/${code}`);
      openRoom(code);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      button.disabled = false;
      input.readOnly = false;
      input.focus();
    }
  });
}

function home() {
  app.innerHTML = `<header class="hero">
    <img class="brand-mark" src="/mark.svg" alt="" width="66" height="66">
    <h1>FireSend</h1>
    <p class="byline">File sharing across devices</p>
    <p class="hero-description">Share files with anyone who has your room code. No registration required.</p>
    <div class="hero-actions">
      <a class="button outline" href="/guide">${icon('book')} How It Works</a>
      <a class="button primary" href="#join">${icon('users')} Join a Room</a>
    </div>
    <div class="public-callout">
      <a class="button gold" href="/public-rooms">${icon('sparkles')} Browse Public Rooms ${icon('arrow')}</a>
      <p>Discover rooms shared by the community</p>
    </div>
  </header>
  <section class="create-section" aria-labelledby="create-title">
    <h2 id="create-title">Create a Room</h2>
    <p class="section-description">Start a quick share and send the room code to another device.</p>
    <div class="cards">
      <article class="card quick">
        <span class="orb cyan">${icon('bolt')}</span>
        <h3>Quick Share</h3>
        <p>24 hours</p><p class="small">500 MB per file</p>
        <span class="badge">Free</span>
        <button id="create-room" class="button cyan">Start Now</button>
      </article>
      <article class="card lifetime">
        <span class="orb orange">${icon('crown')}</span>
        <h3>Lifetime Room</h3>
        <p>Never expires</p><p class="small">1 GB per file on FireSend</p>
        <span class="badge">Original service</span>
        <a class="button orange" href="https://firesend.download/vip">View on FireSend</a>
      </article>
    </div>
    <p id="create-error" class="error" role="alert" hidden></p>
  </section>
  <section class="card join" id="join" aria-labelledby="join-title">
    <span class="orb blue">${icon('users')}</span>
    <h2 id="join-title">Join Room</h2>
    <p>Enter the six-character code for your room.</p>
    ${joinForm()}
  </section>
  <section class="card tv-card" aria-labelledby="tv-title">
    <span class="orb blue">${icon('tv')}</span>
    <h2 id="tv-title">FireSend for Fire TV &amp; Android TV</h2>
    <p>Open FireSend in your TV browser and enter a room code to find your shared files.</p>
    <a href="/tv" class="button outline">Open TV Mode ${icon('arrow')}</a>
  </section>`;
  bindJoin();
  const button = document.querySelector('#create-room');
  button.addEventListener('click', async () => {
    const error = document.querySelector('#create-error');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Creating room…';
    try {
      const room = await request('/api/rooms', { method: 'POST' });
      ownerKey(room.code, room.ownerKey);
      openRoom(room.code);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = 'Start Now';
    }
  });
}

function backLink() {
  return `<a href="/" class="back">${icon('back')} Back to FireSend</a>`;
}

function failurePage(message) {
  app.innerHTML = `<div class="page">${backLink()}<div class="card message"><h1>Room unavailable</h1><p id="failure-message"></p></div></div>`;
  document.querySelector('#failure-message').textContent = message;
}

function bytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

function renderFiles(code, files) {
  const list = document.querySelector('#files');
  document.querySelector('#file-count').textContent = files.length;
  document.querySelector('#empty-files').hidden = files.length !== 0;
  const rows = files.map((file) => {
    const row = document.createElement('li');
    row.className = 'file-row';
    row.innerHTML = `<span class="file-icon">${icon('file')}</span><div class="file-detail"><strong></strong><span></span></div>
      <a class="button outline" download>${icon('download')} Download</a>`;
    row.querySelector('strong').textContent = file.name;
    row.querySelector('.file-detail span').textContent = bytes(file.size);
    const link = row.querySelector('a');
    link.href = `/api/rooms/${code}/files/${encodeURIComponent(file.id)}`;
    link.setAttribute('aria-label', `Download ${file.name}`);
    return row;
  });
  list.replaceChildren(...rows);
}

function sendFile(code, file, progress) {
  return new Promise((resolve, reject) => {
    const upload = new XMLHttpRequest();
    const body = new FormData();
    body.append('file', file);
    upload.open('POST', `/api/rooms/${code}/files`);
    upload.responseType = 'json';
    upload.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress.value = event.loaded / event.total;
    });
    upload.addEventListener('load', () => {
      if (upload.status === 201) resolve(upload.response);
      else reject(new Error(upload.response?.error || 'The upload failed.'));
    });
    upload.addEventListener('error', () => reject(new Error('Connection lost during upload.')));
    upload.send(body);
  });
}

async function copy(value, label, field) {
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(value);
    else {
      field.focus();
      field.select();
      if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
    }
    announce(`${label} copied`);
    return true;
  } catch {
    field.focus();
    field.select();
    announce(`Select and copy the ${label.toLowerCase()}.`);
    return false;
  }
}

async function roomPage(code) {
  if (!codePattern.test(code)) return failurePage('Check the room code and try again.');
  let room;
  try {
    room = await request(`/api/rooms/${code}`);
  } catch (error) {
    return failurePage(error.message);
  }

  const key = ownerKey(code);
  app.innerHTML = `<div class="page">${backLink()}
    <header class="room-header">
      <span class="orb cyan">${icon('bolt')}</span>
      <h1>Quick Share Room</h1>
      <p class="expiry">${icon('clock')} Expires <time id="expires"></time></p>
    </header>
    <section class="card room-share" aria-labelledby="share-title">
      <div>
        <h2 id="share-title">Share this room</h2>
        <p>Enter the code on another device or scan the QR code.</p>
        <div class="share-actions"><input id="share-code" aria-label="Room code" readonly value="${code}">
        <button id="copy-code" class="button outline">${icon('copy')} Copy Code</button></div>
        <label class="sr-only" for="share-link">Room link</label>
        <div class="share-actions"><input id="share-link" readonly>
        <button id="copy-link" class="button outline">${icon('copy')} Copy Link</button></div>
        <label id="network-choice" hidden>Network address <select id="network"></select></label>
      </div>
      <img id="qr" alt="QR code for this room" width="128" height="128">
    </section>
    <section class="card transfer" aria-labelledby="transfer-title">
      <h2 id="transfer-title">Upload Files</h2>
      <button id="drop" class="dropzone" type="button">
        <span class="orb cyan">${icon('upload')}</span>
        <strong>Drop files here or click to browse</strong><span>Up to 500 MB per file</span>
      </button>
      <input type="file" id="picker" multiple hidden>
      <div id="upload-progress" hidden><label for="progress">Uploading <span id="upload-name"></span></label><progress id="progress" max="1"></progress></div>
      <p id="upload-error" class="error" role="alert" hidden></p>
    </section>
    <section class="card transfer" aria-labelledby="files-title">
      <h2 id="files-title">Shared Files <span class="count" id="file-count">0</span></h2>
      <p id="empty-files" class="empty">Files added to the room will appear here.</p>
      <ul id="files" class="file-list"></ul>
    </section>
    ${key ? `<section class="card visibility"><div><h2>Room visibility</h2><p>Public rooms can be discovered by anyone who can reach this FireSend server.</p></div>
    <label><input type="checkbox" id="public-toggle"> List publicly</label><p id="visibility-error" class="error" role="alert" hidden></p></section>` : ''}
  </div>`;

  const expires = document.querySelector('#expires');
  const expiryDate = new Date(room.expiresAt);
  expires.dateTime = expiryDate.toISOString();
  expires.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(expiryDate);
  const linkField = document.querySelector('#share-link');
  const qr = document.querySelector('#qr');
  function setShareHost(host) {
    linkField.value = `${location.protocol}//${host}/room/${code}`;
    qr.src = `/api/rooms/${code}/qr?host=${encodeURIComponent(host)}`;
  }
  setShareHost(location.host);
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    request('/api/network').then((addresses) => {
      if (!addresses.length) return;
      const select = document.querySelector('#network');
      if (!select) return;
      for (const address of addresses) {
        select.add(new Option(address, `${address}:${location.port || 3001}`));
      }
      document.querySelector('#network-choice').hidden = false;
      select.addEventListener('change', () => setShareHost(select.value));
      setShareHost(select.value);
    }).catch(() => {});
  }
  for (const [target, field, label] of [['#copy-code', '#share-code', 'Code'], ['#copy-link', '#share-link', 'Link']]) {
    const button = document.querySelector(target);
    const input = document.querySelector(field);
    button.addEventListener('click', async () => {
      if (await copy(input.value, label, input)) {
        button.innerHTML = `${icon('check')} Copied`;
        setTimeout(() => { button.innerHTML = `${icon('copy')} Copy ${label}`; }, 1600);
      }
    });
  }

  renderFiles(code, room.files);
  let fileVersion = JSON.stringify(room.files);
  let updating = false;
  async function refresh() {
    if (updating) return;
    updating = true;
    try {
      const latest = await request(`/api/rooms/${code}`);
      const version = JSON.stringify(latest.files);
      if (version !== fileVersion) {
        renderFiles(code, latest.files);
        fileVersion = version;
      }
    } catch (error) {
      if (Date.now() >= room.expiresAt) {
        clearInterval(timer);
        failurePage('This room has expired.');
      }
    } finally {
      updating = false;
    }
  }
  const timer = setInterval(refresh, 3000);

  if (key) {
    const toggle = document.querySelector('#public-toggle');
    const error = document.querySelector('#visibility-error');
    toggle.checked = room.public;
    toggle.addEventListener('change', async () => {
      error.hidden = true;
      toggle.disabled = true;
      try {
        room = await request(`/api/rooms/${code}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Room-Key': key },
          body: JSON.stringify({ public: toggle.checked }),
        });
        announce(room.public ? 'Room is now public.' : 'Room is now unlisted.');
      } catch (failure) {
        toggle.checked = room.public;
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        toggle.disabled = false;
      }
    });
  }

  const drop = document.querySelector('#drop');
  const picker = document.querySelector('#picker');
  const progress = document.querySelector('#progress');
  const progressBox = document.querySelector('#upload-progress');
  const uploadName = document.querySelector('#upload-name');
  const errorBox = document.querySelector('#upload-error');
  let uploading = false;
  async function uploadFiles(files) {
    if (uploading || files.length === 0) return;
    uploading = true;
    drop.disabled = true;
    errorBox.hidden = true;
    const errors = [];
    for (const file of files) {
      if (file.size > maxSize) {
        errors.push(`${file.name} exceeds 500 MB.`);
        continue;
      }
      progress.value = 0;
      uploadName.textContent = file.name;
      progressBox.hidden = false;
      try {
        await sendFile(code, file, progress);
        announce(`${file.name} uploaded.`);
      } catch (error) {
        errors.push(`${file.name} — ${error.message}`);
      }
    }
    if (errors.length) {
      errorBox.textContent = errors.join(' ');
      errorBox.hidden = false;
    }
    progressBox.hidden = true;
    uploading = false;
    drop.disabled = false;
    await refresh();
  }

  drop.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';
    uploadFiles(files);
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!uploading) drop.classList.add('drag-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('drag-over');
    uploadFiles([...event.dataTransfer.files]);
  });
}

async function publicRooms() {
  app.innerHTML = `<div class="page">${backLink()}<header class="room-header">
    <span class="orb orange">${icon('sparkles')}</span><h1>Public Rooms</h1>
    <p>Browse rooms their creators have listed on this server.</p>
    </header><section class="card transfer"><p id="public-message" class="empty">Loading rooms…</p>
    <ul id="public-list" class="file-list"></ul></section></div>`;
  const message = document.querySelector('#public-message');
  try {
    const rooms = await request('/api/public-rooms');
    if (!rooms.length) {
      message.textContent = 'There are no public rooms yet.';
      return;
    }
    message.hidden = true;
    const list = document.querySelector('#public-list');
    for (const room of rooms) {
      if (!codePattern.test(room.code)) continue;
      const item = document.createElement('li');
      item.className = 'file-row';
      item.innerHTML = `<span class="file-icon">${icon('users')}</span><div class="file-detail"><strong></strong><span></span></div>
        <a class="button outline" href="/room/${room.code}">Open Room ${icon('arrow')}</a>`;
      item.querySelector('strong').textContent = room.code;
      item.querySelector('.file-detail span').textContent = `${room.fileCount} ${room.fileCount === 1 ? 'file' : 'files'}`;
      list.append(item);
    }
  } catch (error) {
    message.textContent = error.message;
  }
}

function guide() {
  app.innerHTML = `<div class="page">${backLink()}<header class="room-header">
    <span class="orb blue">${icon('book')}</span><h1>How FireSend Works</h1>
    <p>Send files from your browser to another device on your network.</p></header>
    <ol class="guide-steps">
      <li class="card"><h2>Create a room</h2><p>Choose Start Now on the homepage to generate a six-character code. The room lasts 24 hours.</p></li>
      <li class="card"><h2>Add your files</h2><p>Drag files into the upload area or click to select them. Each file can be up to 500 MB.</p></li>
      <li class="card"><h2>Open the room on another device</h2><p>Scan the room’s QR code, open its link, or enter the code in Join Room on the same FireSend server.</p></li>
      <li class="card"><h2>Download what you need</h2><p>Select Download beside a file to save it on your device.</p></li>
    </ol><a href="/" class="button primary">Go to FireSend ${icon('arrow')}</a></div>`;
}

function tv() {
  app.innerHTML = `<div class="page tv-page">${backLink()}<header class="room-header">
    <span class="orb blue">${icon('tv')}</span><h1>FireSend TV</h1>
    <p>Enter a room code to see files shared with your TV.</p></header>
    <section class="card join"><h2>Join Room</h2>${joinForm()}</section></div>`;
  bindJoin();
  document.querySelector('#room-code').focus();
}

const currentPath = location.pathname.replace(/\/$/, '') || '/';
if (currentPath.startsWith('/room/')) roomPage(currentPath.slice(6).toUpperCase());
else if (currentPath === '/public-rooms') publicRooms();
else if (currentPath === '/guide') guide();
else if (currentPath === '/tv') tv();
else home();
