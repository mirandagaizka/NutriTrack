// =============================================================================
//  Temple — auth.js
//  Gestión de autenticación con el backend propio
// =============================================================================

const API_URL = 'https://nutritrack-jj26.onrender.com';

// ─── TOKEN EN SESSION STORAGE ─────────────────────────────────────────────────

function getToken() {
  return sessionStorage.getItem('nt_token');
}

function setToken(token) {
  sessionStorage.setItem('nt_token', token);
}

function clearToken() {
  sessionStorage.removeItem('nt_token');
  sessionStorage.removeItem('nt_user');
}

function isLoggedIn() {
  return !!getToken();
}

function getUser() {
  const raw = sessionStorage.getItem('nt_user');
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────

async function login(email, password) {
  try {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { error: data.error || 'Credenciales incorrectas.' };
    }

    setToken(data.token);
    sessionStorage.setItem('nt_user', JSON.stringify(data.user));
    return { user: data.user };
  } catch (err) {
    console.error('[Auth] login error:', err);
    return { error: 'No se pudo conectar con el servidor.' };
  }
}

// ─── REGISTRO ─────────────────────────────────────────────────────────────────

async function register(email, password, inviteCode, nickname) {
  try {
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, inviteCode, nickname }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { error: data.error || 'No se pudo crear la cuenta.' };
    }

    setToken(data.token);
    sessionStorage.setItem('nt_user', JSON.stringify(data.user));
    return { user: data.user };
  } catch (err) {
    console.error('[Auth] register error:', err);
    return { error: 'No se pudo conectar con el servidor.' };
  }
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────

function logout() {
  clearToken();
  window.location.href = 'index.html';
}

// ─── GUARD: redirigir si no está autenticado ──────────────────────────────────

function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}
