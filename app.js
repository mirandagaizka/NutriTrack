// =============================================================================
//  NutriTrack — app.js
//  Arquitectura: Frontend → Backend propio (Railway) + Supabase Auth
// =============================================================================

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
// API_URL viene definido en auth.js (mismo origen)

// ─── OBJETIVOS DIARIOS (se cargan desde /api/profile) ────────────────────────
let GOALS = {
  calories: 2000,
  proteins: 150,
};

let isAdmin    = false;
let inviteCode = '';
let nickname   = '';

// Estado grupos
let userGroups       = [];
let activeGroupId    = null;
let activeRankingTab = 'week';
let rankingData      = [];

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let state = {
  today:  { calories: 0, proteins: 0, carbs: 0, fats: 0 },
  weekly: [],
};
let macroChart   = null;
let weeklyChart  = null;
let weightChart  = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`,
  };
}

// ─── PUNTO DE ENTRADA ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (!requireAuth()) return;

  renderDate();
  initCharts();
  initNavigation();
  initForm();
  initSettingsModal();

  // Primero cargar el perfil para tener GOALS actualizados antes de pintar
  await loadProfile();
  await Promise.all([loadData(), loadEntriesToday(), loadWeight(), loadGroups()]);
  initChat();
  initInvite();
  initWeightForm();
  initGroupsForms();
  initNotifToggle();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
});

// ─── FECHA ────────────────────────────────────────────────────────────────────
function renderDate() {
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  $('current-date').textContent = new Date().toLocaleDateString('es-ES', opts);
}

// ─── NAVEGACIÓN ───────────────────────────────────────────────────────────────
function initNavigation() {
  const TABS = [
    { navId: 'nav-today',  contentId: 'tab-today'  },
    { navId: 'nav-week',   contentId: 'tab-week'   },
    { navId: 'nav-groups', contentId: 'tab-groups' },
  ];

  TABS.forEach(({ navId, contentId }) => {
    $(navId).addEventListener('click', () => {
      TABS.forEach(({ navId: n, contentId: c }) => {
        $(c).classList.add('hidden');
        $(n).setAttribute('data-active', 'false');
      });
      $(contentId).classList.remove('hidden');
      $(navId).setAttribute('data-active', 'true');

      if (contentId === 'tab-week') {
        if (weeklyChart) setTimeout(() => weeklyChart.resize(), 50);
        if (weightChart) setTimeout(() => weightChart.resize(), 50);
      }
    });
  });
}

// ─── FORMULARIO ───────────────────────────────────────────────────────────────
function initForm() {
  $('add-btn').addEventListener('click', handleSubmit);
  $('food-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSubmit();
  });
}

// ─── PERFIL / OBJETIVOS ───────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const res = await fetch(`${API_URL}/api/profile`, {
      headers: authHeaders(),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const profile = await res.json();
    GOALS.calories = profile.target_calories || 2000;
    GOALS.proteins = profile.target_proteins || 150;
    isAdmin    = !!profile.isAdmin;
    inviteCode = profile.inviteCode || '';
    nickname   = profile.nickname || '';
    updateGoalLabels();
  } catch (err) {
    console.error('[NutriTrack] GET /api/profile error:', err);
    updateGoalLabels(); // usar defaults igualmente
  }
}

function updateGoalLabels() {
  $('header-goal').textContent    = `${GOALS.calories.toLocaleString('es-ES')} kcal`;
  $('cal-goal-label').textContent  = GOALS.calories.toLocaleString('es-ES');
  $('prot-goal-label').textContent = GOALS.proteins;
  $('week-goal-label').textContent = GOALS.calories.toLocaleString('es-ES');
}

// ─── MODAL DE AJUSTES ─────────────────────────────────────────────────────────
function initSettingsModal() {
  const modal    = $('settings-modal');
  const backdrop = $('modal-backdrop');

  $('settings-btn').addEventListener('click', openSettingsModal);
  $('modal-close').addEventListener('click', closeSettingsModal);
  backdrop.addEventListener('click', closeSettingsModal);
  $('save-goals-btn').addEventListener('click', handleSaveGoals);

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeSettingsModal();
    }
  });
}

function openSettingsModal() {
  $('goal-calories').value = GOALS.calories;
  $('goal-proteins').value = GOALS.proteins;
  $('modal-status').classList.add('hidden');
  $('settings-modal').classList.remove('hidden');
  // Forzar reflow para la animación del backdrop
  requestAnimationFrame(() => $('goal-calories').focus());
}

function closeSettingsModal() {
  $('settings-modal').classList.add('hidden');
}

async function handleSaveGoals() {
  const calories = parseInt($('goal-calories').value, 10);
  const proteins = parseInt($('goal-proteins').value, 10);

  if (!calories || !proteins || calories < 500 || proteins < 10) {
    showModalStatus('Introduce valores válidos (mín. 500 kcal y 10g prot).', 'error');
    return;
  }

  setSaveLoading(true);

  try {
    const res = await fetch(`${API_URL}/api/profile`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ target_calories: calories, target_proteins: proteins }),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    GOALS.calories = calories;
    GOALS.proteins = proteins;
    updateGoalLabels();
    renderProgress(state.today || {});

    showModalStatus('¡Objetivos guardados!', 'success');
    setTimeout(closeSettingsModal, 1200);
  } catch (err) {
    console.error('[NutriTrack] POST /api/profile error:', err);
    showModalStatus('Error al guardar. Inténtalo de nuevo.', 'error');
  } finally {
    setSaveLoading(false);
  }
}

function setSaveLoading(active) {
  const btn = $('save-goals-btn');
  btn.disabled = active;
  $('save-icon').classList.toggle('hidden', active);
  $('save-spinner').classList.toggle('hidden', !active);
  $('save-text').textContent = active ? 'Guardando…' : 'Guardar objetivos';
}

function showModalStatus(msg, type) {
  const el = $('modal-status');
  const styles = { success: 'text-emerald-400', error: 'text-rose-400' };
  el.textContent = msg;
  el.className   = `text-xs mt-3 ${styles[type] || 'text-slate-400'}`;
  el.classList.remove('hidden');
}

async function handleSubmit() {
  const input = $('food-input');
  const food  = input.value.trim();

  if (!food) {
    showStatus('Escribe el nombre del alimento primero.', 'warn');
    input.focus();
    return;
  }

  setLoading(true);

  try {
    const res = await fetch(`${API_URL}/api/food`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ food }),
    });

    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    input.value = '';
    setLoading(false);
    showStatus('¡Registrado!', 'success');

    // Recargar datos tras registro
    await Promise.all([loadData(), loadEntriesToday()]);
  } catch (err) {
    setLoading(false);
    showStatus('Error al registrar el alimento. Inténtalo de nuevo.', 'error');
    console.error('[NutriTrack] POST /api/food error:', err);
  }
}

function setLoading(active) {
  const btn     = $('add-btn');
  const text    = $('btn-text');
  const spinner = $('btn-spinner');

  btn.disabled = active;
  text.textContent = active ? 'Analizando…' : 'Añadir';
  spinner.classList.toggle('hidden', !active);
}

function showStatus(msg, type) {
  const el = $('form-status');
  const styles = {
    info:    'text-amber-400',
    success: 'text-emerald-400',
    warn:    'text-orange-400',
    error:   'text-rose-400',
  };
  el.textContent = msg;
  el.className   = `text-xs mt-2 transition-opacity ${styles[type] || 'text-slate-400'}`;
  el.classList.remove('hidden', 'opacity-0');

  if (type === 'success' || type === 'error' || type === 'warn') {
    setTimeout(() => el.classList.add('hidden'), 5000);
  }
}

// ─── CARGA DE DATOS (resumen + gráficos) ─────────────────────────────────────
async function loadData() {
  try {
    const res = await fetch(`${API_URL}/api/data`, {
      headers: authHeaders(),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    state = data;
    renderUI(data);
  } catch (err) {
    console.error('[NutriTrack] GET /api/data error:', err);
    renderUI(state);
  }
}

// ─── LISTA DE ALIMENTOS DE HOY ────────────────────────────────────────────────
async function loadEntriesToday() {
  try {
    const res = await fetch(`${API_URL}/api/entries/today`, {
      headers: authHeaders(),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const entries = await res.json();
    renderEntries(entries);
  } catch (err) {
    console.error('[NutriTrack] GET /api/entries/today error:', err);
  }
}

function renderEntries(entries) {
  const card = $('entries-card');
  const list = $('entries-list');

  if (!entries || entries.length === 0) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  list.innerHTML = entries.map((e) => `
    <li class="flex items-center justify-between gap-2 py-2 border-b border-slate-800 last:border-0">
      <div class="flex-1 min-w-0">
        <p class="text-sm text-slate-200 truncate">${escapeHtml(e.food_name)}</p>
        <p class="text-xs text-slate-500">${Math.round(e.calories)} kcal
          · ${Math.round(e.proteins)}g prot
          · ${Math.round(e.carbs)}g carbs
          · ${Math.round(e.fats)}g grasas
        </p>
      </div>
      <button
        onclick="deleteEntry('${e.id}')"
        class="w-7 h-7 rounded-lg bg-slate-800 hover:bg-rose-500/20 hover:text-rose-400
               flex items-center justify-center transition-all shrink-0"
        title="Eliminar"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd"/>
        </svg>
      </button>
    </li>
  `).join('');
}

async function deleteEntry(id) {
  try {
    const res = await fetch(`${API_URL}/api/entries/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    await Promise.all([loadData(), loadEntriesToday()]);
  } catch (err) {
    console.error('[NutriTrack] DELETE /api/entries/:id error:', err);
    showStatus('Error al eliminar la entrada.', 'error');
  }
}

// ─── INVITAR ──────────────────────────────────────────────────────────────────
function initInvite() {
  if (!isAdmin || !inviteCode) return;

  const btn = $('invite-btn');
  btn.classList.remove('hidden');
  btn.classList.add('flex');

  btn.addEventListener('click', async () => {
    const appUrl  = window.location.origin + window.location.pathname.replace('app.html', '');
    const message = `¡Te invito a NutriTrack! 🥗\nLleva el control de tu alimentación diaria.\n\n📲 Descárgala aquí: ${appUrl}\n\nUsa el código de invitación: ${inviteCode}`;

    if (navigator.share) {
      try {
        await navigator.share({ text: message });
      } catch (err) {
        if (err.name !== 'AbortError') console.error('[NutriTrack] share error:', err);
      }
    } else {
      // Fallback: copiar al portapapeles en desktop
      await navigator.clipboard.writeText(message);
      showStatus('Mensaje copiado al portapapeles.', 'success');
    }
  });
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
let chatHistory = [];

function initChat() {
  $('chat-fab').addEventListener('click', openChat);
  $('chat-close').addEventListener('click', closeChat);
  $('chat-send').addEventListener('click', handleChatSend);
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleChatSend();
  });
}

function openChat() {
  $('chat-panel').classList.remove('hidden');
  setTimeout(() => $('chat-input').focus(), 150);
}

function closeChat() {
  $('chat-panel').classList.add('hidden');
}

async function handleChatSend() {
  const input = $('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  appendChatMessage('user', message);
  setChatLoading(true);

  try {
    const res = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        message,
        history: chatHistory.slice(-10),
        context: {
          calories:     state.today?.calories  || 0,
          proteins:     state.today?.proteins  || 0,
          carbs:        state.today?.carbs     || 0,
          fats:         state.today?.fats      || 0,
          goalCalories: GOALS.calories,
          goalProteins: GOALS.proteins,
        },
      }),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { reply } = await res.json();
    appendChatMessage('model', reply);
  } catch (err) {
    console.error('[NutriTrack] POST /api/chat error:', err);
    appendChatMessage('model', 'Lo siento, ha ocurrido un error. Inténtalo de nuevo.');
  } finally {
    setChatLoading(false);
  }
}

function appendChatMessage(role, text) {
  chatHistory.push({ role, text });

  const messages = $('chat-messages');
  const div = document.createElement('div');

  const safeText = escapeHtml(text).replace(/\n/g, '<br>');

  if (role === 'user') {
    div.className = 'flex justify-end';
    div.innerHTML = `
      <div class="bg-emerald-500/20 border border-emerald-500/20 rounded-2xl rounded-tr-sm px-3.5 py-2.5 max-w-[85%]">
        <p class="text-sm text-slate-200">${safeText}</p>
      </div>`;
  } else {
    div.className = 'flex gap-2.5';
    div.innerHTML = `
      <div class="w-7 h-7 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0 mt-0.5">
        <svg class="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="bg-slate-800 rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[85%]">
        <p class="text-sm text-slate-200">${safeText}</p>
      </div>`;
  }

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function setChatLoading(active) {
  const btn     = $('chat-send');
  const icon    = $('chat-send-icon');
  const spinner = $('chat-send-spinner');
  const input   = $('chat-input');

  btn.disabled   = active;
  input.disabled = active;
  icon.classList.toggle('hidden', active);
  spinner.classList.toggle('hidden', !active);

  if (active) {
    const messages = $('chat-messages');
    const typing = document.createElement('div');
    typing.id = 'chat-typing';
    typing.className = 'flex gap-2.5';
    typing.innerHTML = `
      <div class="w-7 h-7 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0 mt-0.5">
        <svg class="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="bg-slate-800 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
        <div class="flex gap-1 items-center h-5">
          <span class="typing-dot w-1.5 h-1.5 bg-slate-400 rounded-full"></span>
          <span class="typing-dot w-1.5 h-1.5 bg-slate-400 rounded-full"></span>
          <span class="typing-dot w-1.5 h-1.5 bg-slate-400 rounded-full"></span>
        </div>
      </div>`;
    messages.appendChild(typing);
    messages.scrollTop = messages.scrollHeight;
  } else {
    document.getElementById('chat-typing')?.remove();
    $('chat-input').focus();
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── GRUPOS ───────────────────────────────────────────────────────────────────
function initGroupsForms() {
  $('btn-create-group').addEventListener('click', () => {
    $('form-create-group').classList.toggle('hidden');
    $('form-join-group').classList.add('hidden');
  });
  $('btn-join-group').addEventListener('click', () => {
    $('form-join-group').classList.toggle('hidden');
    $('form-create-group').classList.add('hidden');
  });
  $('btn-create-group-cancel').addEventListener('click', () => $('form-create-group').classList.add('hidden'));
  $('btn-join-group-cancel').addEventListener('click',   () => $('form-join-group').classList.add('hidden'));
  $('btn-create-group-confirm').addEventListener('click', handleCreateGroup);
  $('btn-join-group-confirm').addEventListener('click',   handleJoinGroup);
  $('group-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

async function loadGroups() {
  try {
    const res = await fetch(`${API_URL}/api/groups`, { headers: authHeaders() });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error();
    userGroups = await res.json();
    renderGroupsList();
  } catch (err) {
    console.error('[NutriTrack] GET /api/groups error:', err);
  }
}

function renderGroupsList() {
  const container = $('groups-list');
  if (!userGroups.length) {
    container.innerHTML = `<p class="text-sm text-slate-500 text-center py-4">Aún no perteneces a ningún grupo.<br>Crea uno o únete con un código.</p>`;
    return;
  }

  container.innerHTML = userGroups.map(g => `
    <div class="bg-slate-900 rounded-2xl p-4 border border-slate-800 cursor-pointer hover:border-emerald-500/40 transition-all"
         onclick="selectGroup('${g.id}')">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-semibold text-white">${escapeHtml(g.name)}</p>
          ${g.isOwner ? `<p class="text-xs text-slate-500 mt-0.5">Código: <span class="text-emerald-400 font-mono font-semibold">${g.code}</span></p>` : '<p class="text-xs text-slate-500 mt-0.5">Miembro</p>'}
        </div>
        <svg class="w-4 h-4 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    </div>
  `).join('');
}

async function selectGroup(groupId) {
  activeGroupId = groupId;
  $('ranking-panel').classList.remove('hidden');
  $('ranking-list').innerHTML = `<p class="text-xs text-slate-500 text-center py-4">Cargando ranking…</p>`;
  $('ranking-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const res = await fetch(`${API_URL}/api/groups/${groupId}/ranking`, { headers: authHeaders() });
    if (!res.ok) throw new Error();
    rankingData = await res.json();
    renderRanking();
  } catch (err) {
    console.error('[NutriTrack] GET ranking error:', err);
    $('ranking-list').innerHTML = `<p class="text-xs text-rose-400 text-center py-4">Error al cargar el ranking.</p>`;
  }
}

function switchRankTab(tab) {
  activeRankingTab = tab;
  $('rank-tab-week').className  = tab === 'week'
    ? 'flex-1 py-3 text-xs font-semibold text-emerald-400 border-b-2 border-emerald-500'
    : 'flex-1 py-3 text-xs font-semibold text-slate-500 border-b-2 border-transparent';
  $('rank-tab-total').className = tab === 'total'
    ? 'flex-1 py-3 text-xs font-semibold text-emerald-400 border-b-2 border-emerald-500'
    : 'flex-1 py-3 text-xs font-semibold text-slate-500 border-b-2 border-transparent';
  renderRanking();
}

function renderRanking() {
  const scoreKey = activeRankingTab === 'week' ? 'weeklyScore' : 'totalScore';
  const sorted   = [...rankingData].sort((a, b) => b[scoreKey] - a[scoreKey]);
  const medals   = ['🥇', '🥈', '🥉'];

  $('ranking-list').innerHTML = sorted.map((member, i) => `
    <div class="flex items-center gap-3 py-2 ${member.isYou ? 'bg-emerald-500/5 -mx-4 px-4 rounded-xl' : ''}">
      <span class="text-base w-6 text-center">${medals[i] || `${i + 1}`}</span>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-slate-200 truncate">${escapeHtml(member.name)} ${member.isYou ? '<span class="text-xs text-emerald-400">(tú)</span>' : ''}</p>
      </div>
      <span class="text-sm font-bold text-white">${member[scoreKey]} <span class="text-xs font-normal text-slate-500">pts</span></span>
    </div>
  `).join('');
}

async function handleCreateGroup() {
  const name     = $('group-name-input').value.trim();
  const statusEl = $('create-group-status');
  if (!name) {
    statusEl.textContent = 'Escribe un nombre para el grupo.';
    statusEl.className   = 'text-xs mt-2 text-rose-400';
    statusEl.classList.remove('hidden');
    return;
  }

  const btn = $('btn-create-group-confirm');
  btn.disabled = true; btn.textContent = 'Creando…';

  try {
    const res = await fetch(`${API_URL}/api/groups`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Error');
    const group = await res.json();
    $('group-name-input').value = '';
    $('form-create-group').classList.add('hidden');
    await loadGroups();
    statusEl.textContent = `Grupo creado. Código: ${group.code}`;
    statusEl.className   = 'text-xs mt-2 text-emerald-400';
    statusEl.classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className   = 'text-xs mt-2 text-rose-400';
    statusEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Crear';
  }
}

async function handleJoinGroup() {
  const code     = $('group-code-input').value.trim().toUpperCase();
  const statusEl = $('join-group-status');
  if (!code) {
    statusEl.textContent = 'Introduce el código del grupo.';
    statusEl.className   = 'text-xs mt-2 text-rose-400';
    statusEl.classList.remove('hidden');
    return;
  }

  const btn = $('btn-join-group-confirm');
  btn.disabled = true; btn.textContent = 'Uniéndome…';

  try {
    const res = await fetch(`${API_URL}/api/groups/join`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Error');
    $('group-code-input').value = '';
    $('form-join-group').classList.add('hidden');
    await loadGroups();
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className   = 'text-xs mt-2 text-rose-400';
    statusEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = 'Unirme';
  }
}

// ─── NOTIFICACIONES PUSH ──────────────────────────────────────────────────────
function initNotifToggle() {
  const isSubscribed = localStorage.getItem('nt_push') === '1';
  updateNotifToggleUI(isSubscribed);
}

function updateNotifToggleUI(active) {
  const toggle = $('notif-toggle');
  const dot    = $('notif-dot');
  if (!toggle) return;
  toggle.className = `relative w-11 h-6 rounded-full transition-colors ${active ? 'bg-emerald-500' : 'bg-slate-700'}`;
  dot.style.transform = active ? 'translateX(20px)' : 'translateX(0)';
}

async function toggleNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showModalStatus('Tu navegador no soporta notificaciones push.', 'error');
    return;
  }

  const isSubscribed = localStorage.getItem('nt_push') === '1';

  if (isSubscribed) {
    // Desuscribirse
    try {
      const reg  = await navigator.serviceWorker.ready;
      const sub  = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await fetch(`${API_URL}/api/push/unsubscribe`, { method: 'DELETE', headers: authHeaders() });
      localStorage.removeItem('nt_push');
      updateNotifToggleUI(false);
      showModalStatus('Recordatorios desactivados.', 'success');
    } catch (err) {
      console.error('[NutriTrack] unsubscribe error:', err);
    }
  } else {
    // Suscribirse
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showModalStatus('Permiso de notificaciones denegado.', 'error');
      return;
    }

    try {
      // Obtener VAPID public key del backend
      const keyRes = await fetch(`${API_URL}/api/push/vapid-key`);
      if (!keyRes.ok) { showModalStatus('Push no configurado aún.', 'error'); return; }
      const { publicKey } = await keyRes.json();

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      await fetch(`${API_URL}/api/push/subscribe`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ subscription: sub }),
      });

      localStorage.setItem('nt_push', '1');
      updateNotifToggleUI(true);
      showModalStatus('¡Recordatorios activados!', 'success');
    } catch (err) {
      console.error('[NutriTrack] subscribe error:', err);
      showModalStatus('Error al activar notificaciones.', 'error');
    }
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ─── RACHA ────────────────────────────────────────────────────────────────────
function renderStreak(streak) {
  $('streak-value').textContent = streak;

  const label = $('streak-label');
  if (streak === 0) {
    label.textContent = 'Registra alimentos para empezar tu racha';
  } else if (streak === 1) {
    label.textContent = '¡Primer día! Vuelve mañana para seguir la racha';
  } else if (streak < 7) {
    label.textContent = `¡Vas bien! Llevas ${streak} días seguidos`;
  } else if (streak < 30) {
    label.textContent = `¡Increíble! ${streak} días consecutivos 🔥`;
  } else {
    label.textContent = `¡Leyenda! ${streak} días sin parar 🏆`;
  }
}

// ─── PESO ─────────────────────────────────────────────────────────────────────
function initWeightForm() {
  $('weight-save-btn').addEventListener('click', saveWeight);
  $('weight-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveWeight();
  });
}

async function loadWeight() {
  try {
    const res = await fetch(`${API_URL}/api/weight`, { headers: authHeaders() });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();
    renderWeightChart(entries);
  } catch (err) {
    console.error('[NutriTrack] GET /api/weight error:', err);
  }
}

async function saveWeight() {
  const input  = $('weight-input');
  const weight = parseFloat(input.value);
  const status = $('weight-status');

  if (isNaN(weight) || weight < 20 || weight > 500) {
    status.textContent = 'Introduce un peso válido.';
    status.className   = 'text-xs mt-2 text-rose-400';
    status.classList.remove('hidden');
    return;
  }

  const btn = $('weight-save-btn');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const res = await fetch(`${API_URL}/api/weight`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ weight }),
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    input.value = '';
    status.textContent = '¡Peso guardado!';
    status.className   = 'text-xs mt-2 text-emerald-400';
    status.classList.remove('hidden');
    setTimeout(() => status.classList.add('hidden'), 3000);

    await loadWeight();
  } catch (err) {
    console.error('[NutriTrack] POST /api/weight error:', err);
    status.textContent = 'Error al guardar. Inténtalo de nuevo.';
    status.className   = 'text-xs mt-2 text-rose-400';
    status.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar';
  }
}

function renderWeightChart(entries) {
  const empty   = $('weight-empty');
  const wrapper = $('weight-chart-wrapper');
  const stats   = $('weight-stats');

  if (!entries || entries.length === 0) {
    empty.classList.remove('hidden');
    wrapper.classList.add('hidden');
    stats.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  wrapper.classList.remove('hidden');
  stats.classList.remove('hidden');

  // Stats: último peso y variación
  const last = entries[entries.length - 1].weight;
  $('weight-current').textContent = last.toFixed(1);
  if (entries.length >= 2) {
    const prev   = entries[entries.length - 2].weight;
    const diff   = last - prev;
    const sign   = diff > 0 ? '+' : '';
    const el     = $('weight-change');
    el.textContent = `${sign}${diff.toFixed(1)} kg`;
    el.className   = `text-lg font-bold ${diff > 0 ? 'text-rose-400' : diff < 0 ? 'text-emerald-400' : 'text-slate-400'}`;
  } else {
    $('weight-change').textContent = '—';
  }

  const labels = entries.map(e => {
    const d = new Date(e.date + 'T00:00:00');
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  });
  const values = entries.map(e => e.weight);

  if (weightChart) {
    weightChart.data.labels              = labels;
    weightChart.data.datasets[0].data    = values;
    weightChart.update('active');
  } else {
    weightChart = new Chart($('weight-chart').getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data:            values,
          borderColor:     '#10b981',
          backgroundColor: 'rgba(16,185,129,0.08)',
          borderWidth:     2,
          pointRadius:     3,
          pointBackgroundColor: '#10b981',
          tension:         0.3,
          fill:            true,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           { duration: 600 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            borderColor:     '#334155',
            borderWidth:     1,
            padding:         10,
            callbacks: { label: (ctx) => ` ${ctx.raw} kg` },
          },
        },
        scales: {
          x: {
            grid:   { display: false },
            border: { display: false },
            ticks:  { font: { size: 10 }, maxTicksLimit: 6 },
          },
          y: {
            grid:   { color: '#1e293b' },
            border: { display: false },
            ticks:  { font: { size: 11 }, callback: (v) => `${v} kg` },
          },
        },
      },
    });
  }
}

// ─── RENDERIZADO PRINCIPAL ────────────────────────────────────────────────────
function renderUI(data) {
  renderProgress(data.today   || {});
  renderMacroChart(data.today  || {});
  renderWeeklyChart(data.weekly || []);
  renderStreak(data.streak ?? 0);
}

// ─── BARRAS DE PROGRESO ───────────────────────────────────────────────────────
function renderProgress(today) {
  const cal  = today.calories || 0;
  const prot = today.proteins || 0;

  const calPct  = Math.min((cal  / GOALS.calories) * 100, 100);
  const protPct = Math.min((prot / GOALS.proteins) * 100, 100);

  $('cal-current').textContent  = Math.round(cal);
  $('prot-current').textContent = Math.round(prot);
  $('cal-pct').textContent      = `${Math.round(calPct)}%`;
  $('prot-pct').textContent     = `${Math.round(protPct)}%`;

  requestAnimationFrame(() => {
    $('cal-bar').style.width  = `${calPct}%`;
    $('prot-bar').style.width = `${protPct}%`;
  });

  const calOverGoal = cal > GOALS.calories;
  $('cal-bar').className = [
    'h-full rounded-full progress-bar-fill',
    calOverGoal
      ? 'bg-gradient-to-r from-rose-500 to-rose-400'
      : 'bg-gradient-to-r from-emerald-500 to-emerald-400',
  ].join(' ');

  $('cal-pct').className = `text-sm font-semibold ${calOverGoal ? 'text-rose-400' : 'text-emerald-400'}`;
}

// ─── GRÁFICO DOUGHNUT ─────────────────────────────────────────────────────────
function renderMacroChart(today) {
  const { proteins = 0, carbs = 0, fats = 0, calories = 0 } = today;
  const total = proteins + carbs + fats;

  $('legend-prot').textContent  = `${Math.round(proteins)}g`;
  $('legend-carbs').textContent = `${Math.round(carbs)}g`;
  $('legend-fats').textContent  = `${Math.round(fats)}g`;
  $('donut-center-val').textContent = Math.round(calories);

  const isEmpty = total === 0;
  macroChart.data.datasets[0].data = isEmpty ? [1, 1, 1] : [proteins, carbs, fats];
  macroChart.data.datasets[0].backgroundColor = isEmpty
    ? ['#1e293b', '#1e293b', '#1e293b']
    : ['#60a5fa', '#fbbf24', '#fb7185'];

  macroChart.update('active');
}

// ─── GRÁFICO BARRAS SEMANAL ───────────────────────────────────────────────────
function renderWeeklyChart(weekly) {
  if (!weekly || weekly.length === 0) return;

  const labels  = weekly.map((d) => d.date || d.day || '');
  const values  = weekly.map((d) => d.calories || 0);
  const lastIdx = values.length - 1;

  const bgColors     = values.map((_, i) => (i === lastIdx ? '#10b981' : '#1e293b'));
  const borderColors = values.map((_, i) => (i === lastIdx ? '#34d399' : '#334155'));

  weeklyChart.data.labels                        = labels;
  weeklyChart.data.datasets[0].data              = values;
  weeklyChart.data.datasets[0].backgroundColor   = bgColors;
  weeklyChart.data.datasets[0].borderColor       = borderColors;
  weeklyChart.update('active');

  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const max = Math.max(...values);
  $('week-avg').textContent = avg.toLocaleString('es-ES');
  $('week-max').textContent = max.toLocaleString('es-ES');
}

// ─── INICIALIZACIÓN DE CHARTS ─────────────────────────────────────────────────
function initCharts() {
  Chart.defaults.color       = '#94a3b8';
  Chart.defaults.font.family = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
  Chart.defaults.font.size   = 12;

  // Doughnut (macros)
  macroChart = new Chart($('macro-chart').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Proteínas', 'Carbohidratos', 'Grasas'],
      datasets: [{
        data:            [1, 1, 1],
        backgroundColor: ['#1e293b', '#1e293b', '#1e293b'],
        borderColor:     'transparent',
        borderWidth:     0,
        hoverOffset:     6,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      cutout:              '74%',
      animation:           { duration: 800, easing: 'easeInOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor:     '#334155',
          borderWidth:     1,
          padding:         10,
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${Math.round(ctx.raw)}g`,
          },
        },
      },
    },
  });

  // Barras (calorías semanales)
  weeklyChart = new Chart($('weekly-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels:   Array(7).fill(''),
      datasets: [{
        label:           'Calorías',
        data:            Array(7).fill(0),
        backgroundColor: Array(7).fill('#1e293b'),
        borderColor:     Array(7).fill('#334155'),
        borderWidth:     1,
        borderRadius:    8,
        borderSkipped:   false,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 800, easing: 'easeInOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor:     '#334155',
          borderWidth:     1,
          padding:         10,
          callbacks: {
            label: (ctx) => ` ${Math.round(ctx.raw).toLocaleString('es-ES')} kcal`,
          },
        },
      },
      scales: {
        x: {
          grid:   { display: false },
          border: { display: false },
          ticks:  { font: { size: 11 } },
        },
        y: {
          grid:   { color: '#1e293b', drawBorder: false },
          border: { display: false },
          ticks: {
            font:     { size: 11 },
            callback: (v) => (v >= 1000 ? `${v / 1000}k` : v),
          },
        },
      },
    },
  });
}
