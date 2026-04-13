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

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
let state = {
  today:  { calories: 0, proteins: 0, carbs: 0, fats: 0 },
  weekly: [],
};
let macroChart  = null;
let weeklyChart = null;

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
  await Promise.all([loadData(), loadEntriesToday()]);

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
    { navId: 'nav-today', contentId: 'tab-today' },
    { navId: 'nav-week',  contentId: 'tab-week'  },
  ];

  TABS.forEach(({ navId, contentId }) => {
    $(navId).addEventListener('click', () => {
      TABS.forEach(({ navId: n, contentId: c }) => {
        $(c).classList.add('hidden');
        $(n).setAttribute('data-active', 'false');
      });
      $(contentId).classList.remove('hidden');
      $(navId).setAttribute('data-active', 'true');

      if (contentId === 'tab-week' && weeklyChart) {
        setTimeout(() => weeklyChart.resize(), 50);
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── RENDERIZADO PRINCIPAL ────────────────────────────────────────────────────
function renderUI(data) {
  renderProgress(data.today  || {});
  renderMacroChart(data.today  || {});
  renderWeeklyChart(data.weekly || []);
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
