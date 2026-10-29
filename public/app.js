const authDot = document.querySelector('#authDot');
const authText = document.querySelector('#authText');
const authButton = document.querySelector('#authButton');
const form = document.querySelector('#transferForm');
const sourceUrl = document.querySelector('#sourceUrl');
const transferButton = document.querySelector('#transferButton');
const statusPanel = document.querySelector('#statusPanel');
const statusTitle = document.querySelector('#statusTitle');
const statusMessage = document.querySelector('#statusMessage');
const progressText = document.querySelector('#progressText');
const progressBar = document.querySelector('#progressBar');
const logList = document.querySelector('#logList');
const result = document.querySelector('#result');
const toast = document.querySelector('#toast');
const tabs = [...document.querySelectorAll('[role="tab"]')];
const transferPanel = document.querySelector('#transferPanel');

let authTimer;
let jobTimer;
let mode = 'publication';
let busy = false;
const urls = { publication: '', album: '' };

function setBusy(value) {
  busy = value;
  transferButton.disabled = value;
  tabs.forEach(tab => { tab.disabled = value; });
}

function selectTab(tab) {
  if (busy) return;
  urls[mode] = sourceUrl.value;
  mode = tab.dataset.mode;
  const album = mode === 'album';
  tabs.forEach(item => {
    item.setAttribute('aria-selected', String(item === tab));
    item.tabIndex = item === tab ? 0 : -1;
  });
  transferPanel.setAttribute('aria-labelledby', tab.id);
  document.querySelector('#transferStep').textContent = album ? 'Фотоальбом' : 'Новая публикация';
  document.querySelector('#transferDescription').textContent = album
    ? 'Вставьте ссылку на фотоальбом со старого сайта. Сервис проверит, существует ли он, и вернёт ссылку на альбом. Если альбома нет — создаст его и загрузит фотографии.'
    : 'Сервис перенесёт заголовок, дату, текст, главное изображение и фотогалерею на новый сайт.';
  document.querySelector('#sourceLabel').textContent = album ? 'Ссылка на фотоальбом с ddnmgn.ru' : 'Ссылка на материал с ddnmgn.ru';
  document.querySelector('#sourceHint').textContent = album ? 'Проверка и создание фотоальбома' : 'Новости, статьи и фотоальбомы';
  transferButton.querySelector('span').textContent = album ? 'Проверить и создать альбом' : 'Перенести на новый сайт';
  sourceUrl.placeholder = album ? 'https://ddnmgn.ru/…' : 'https://ddnmgn.ru/novosti/…';
  sourceUrl.value = urls[mode];
  statusPanel.hidden = true;
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next || busy) return;
    event.preventDefault();
    selectTab(next);
    next.focus();
  });
});

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

async function updateAuth() {
  try {
    const state = await jsonFetch('/api/status');
    authDot.classList.toggle('online', state.authenticated);
    authText.textContent = state.authRunning
      ? 'Ожидаем вход в браузере…'
      : state.authenticated ? 'EISRF подключён' : 'Требуется вход';
    authButton.textContent = state.authRunning
      ? 'Окно входа открыто'
      : state.authenticated ? 'Войти заново' : 'Войти в EISRF';
    authButton.disabled = state.authRunning;
  } catch {
    authText.textContent = 'Сервис недоступен';
  }
}

authButton.addEventListener('click', async () => {
  try {
    await jsonFetch('/api/auth', { method: 'POST' });
    notify('Войдите в EISRF в открывшемся окне Chromium');
    clearInterval(authTimer);
    authTimer = setInterval(async () => {
      await updateAuth();
      const state = await jsonFetch('/api/status');
      if (!state.authRunning) clearInterval(authTimer);
    }, 1200);
    await updateAuth();
  } catch (error) {
    notify(error.message);
  }
});

function renderJob(job) {
  statusPanel.hidden = false;
  progressBar.style.width = `${job.progress}%`;
  progressText.textContent = `${job.progress}%`;
  statusMessage.textContent = job.message;
  logList.replaceChildren(...job.logs.map(entry => {
    const li = document.createElement('li');
    li.textContent = entry.message;
    return li;
  }));

  if (job.status === 'completed') {
    clearInterval(jobTimer);
    setBusy(false);
    const album = job.result.kind === 'photo-album' && Boolean(job.result.albumUrl);
    statusTitle.textContent = album ? (job.result.existed ? 'Альбом существует' : 'Альбом создан') : 'Материал перенесён';
    result.hidden = false;
    const title = document.createElement('strong');
    title.textContent = job.result.title;
    const counts = document.createElement('span');
    counts.textContent = album
      ? (job.result.existed ? '' : `Фотографий: ${job.result.images} · `)
      : `Изображений: ${job.result.images} · Видео: ${job.result.videos || 0} · `;
    const link = document.createElement('a');
    link.href = album ? job.result.albumUrl : job.result.publicUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = album ? 'Открыть альбом в EISRF →' : 'Открыть на новом сайте →';
    result.replaceChildren(title, counts, link);
    if (album) {
      if (job.result.publicUrl) {
        const publicLink = document.createElement('a');
        publicLink.href = job.result.publicUrl;
        publicLink.target = '_blank';
        publicLink.rel = 'noreferrer';
        publicLink.textContent = 'Открыть альбом на сайте →';
        result.append(document.createElement('br'), publicLink);
      } else {
        const note = document.createElement('span');
        note.textContent = 'Страница альбома на сайте пока недоступна.';
        result.append(document.createElement('br'), note);
      }
    }
    if (album && job.result.existed) notify('Альбом существует');
  } else if (job.status === 'failed') {
    clearInterval(jobTimer);
    setBusy(false);
    statusTitle.textContent = 'Нужна проверка';
    statusMessage.textContent = job.error;
    notify(job.error);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearInterval(jobTimer);
  setBusy(true);
  result.hidden = true;
  statusTitle.textContent = mode === 'album' ? 'Проверяем фотоальбом' : 'Подготавливаем материал';
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  statusMessage.textContent = '';
  logList.replaceChildren();
  statusPanel.hidden = false;
  statusPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const { id } = await jsonFetch(mode === 'album' ? '/api/albums' : '/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: sourceUrl.value }),
    });
    jobTimer = setInterval(async () => {
      try {
        renderJob(await jsonFetch(`/api/jobs/${id}`));
      } catch (error) {
        notify(error.message);
      }
    }, 850);
  } catch (error) {
    setBusy(false);
    statusPanel.hidden = true;
    notify(error.message);
  }
});

updateAuth();
