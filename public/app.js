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

let authTimer;
let jobTimer;

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

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

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
    transferButton.disabled = false;
    statusTitle.textContent = 'Материал перенесён';
    result.hidden = false;
    result.innerHTML = `<strong>${escapeHtml(job.result.title)}</strong><span>Изображений: ${job.result.images} · Видео: ${job.result.videos || 0} · </span><a href="${job.result.publicUrl}" target="_blank" rel="noreferrer">Открыть на новом сайте →</a>`;
  } else if (job.status === 'failed') {
    clearInterval(jobTimer);
    transferButton.disabled = false;
    statusTitle.textContent = 'Нужна проверка';
    statusMessage.textContent = job.error;
    notify(job.error);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  clearInterval(jobTimer);
  transferButton.disabled = true;
  result.hidden = true;
  statusTitle.textContent = 'Подготавливаем материал';
  statusPanel.hidden = false;
  statusPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const { id } = await jsonFetch('/api/transfers', {
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
    transferButton.disabled = false;
    statusPanel.hidden = true;
    notify(error.message);
  }
});

updateAuth();
