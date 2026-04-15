// =============================================================================
//  NutriTrack — server.js
//  Express + Supabase + Gemini API
// =============================================================================

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import cron from 'node-cron';

const app = express();

// ─── VARIABLES DE ENTORNO ─────────────────────────────────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  PORT = 3000,
  FRONTEND_URL,
  INVITE_CODE,
  ADMIN_EMAIL,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
} = process.env;

// Configurar web-push si hay claves VAPID
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_SUBJECT || 'mailto:admin@nutritrack.app',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// Helper: generar código de grupo aleatorio
function generateGroupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  console.error('[NutriTrack] Faltan variables de entorno. Revisa .env');
  process.exit(1);
}

// ─── SUPABASE (service role para operaciones del servidor) ────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────
const allowedOrigins = FRONTEND_URL
  ? FRONTEND_URL.split(',').map((o) => o.trim())
  : [];

app.use(cors({
  origin: allowedOrigins.length > 0
    ? (origin, cb) => {
        // Permitir peticiones sin origin (ej. curl, Postman) y los orígenes configurados
        if (!origin || allowedOrigins.some((o) => origin.startsWith(o))) {
          cb(null, true);
        } else {
          cb(new Error(`CORS bloqueado para: ${origin}`));
        }
      }
    : '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json());

// ─── HELPER: verificar token y devolver user_id ───────────────────────────────
async function getUserFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);

  // Crear cliente con el token del usuario para verificarlo
  const userClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) return null;

  return data.user;
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, inviteCode, nickname } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
  }

  const validCode = process.env.INVITE_CODE;
  if (validCode && inviteCode !== validCode) {
    return res.status(403).json({ error: 'Código de invitación incorrecto.' });
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    const msg = error.message.includes('already registered')
      ? 'Este email ya está registrado.'
      : error.message;
    return res.status(400).json({ error: msg });
  }

  // Hacer login automático para obtener el token de sesión
  const { data: session, error: loginErr } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (loginErr) {
    return res.status(500).json({ error: 'Cuenta creada pero no se pudo iniciar sesión.' });
  }

  // Guardar nickname en el perfil
  if (nickname && nickname.trim()) {
    await supabase.from('user_profiles').upsert(
      { user_id: session.user.id, nickname: nickname.trim(), target_calories: 2000, target_proteins: 150 },
      { onConflict: 'user_id' }
    );
  }

  return res.json({
    token: session.session.access_token,
    user:  { id: session.user.id, email: session.user.email },
  });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }

  return res.json({
    token: data.session.access_token,
    user:  { id: data.user.id, email: data.user.email },
  });
});

// ─── POST /api/food ───────────────────────────────────────────────────────────
app.post('/api/food', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { food } = req.body;
  if (!food || typeof food !== 'string' || !food.trim()) {
    return res.status(400).json({ error: 'El campo "food" es obligatorio.' });
  }

  // Llamar a Gemini para calcular macros
  let macros;
  let retries = 3;
  let success = false;

  while (retries > 0 && !success) {
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Calcula los valores nutricionales para: ${food.trim()}. Responde ÚNICAMENTE con JSON: {"calories": X, "proteins": X, "carbs": X, "fats": X, "fiber": X}. Solo números, sin unidades, sin texto extra.`,
              }],
            }],
          }),
        }
      );

      if (geminiRes.status === 429) {
        console.error('[NutriTrack] Gemini: cuota agotada (429). No se reintenta.');
        return res.status(503).json({ error: 'Cuota de IA agotada. Vuelve a intentarlo mañana.' });
      }

      if (!geminiRes.ok) {
        throw new Error(`Gemini HTTP ${geminiRes.status}`);
      }

      const geminiData = await geminiRes.json();
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) throw new Error('Gemini no devolvió JSON válido');

      macros = JSON.parse(jsonMatch[0]);

      const required = ['calories', 'proteins', 'carbs', 'fats', 'fiber'];
      for (const field of required) {
        if (typeof macros[field] !== 'number') macros[field] = 0;
      }

      success = true; // Si llega aquí, todo ha ido bien, salimos del bucle

    } catch (err) {
      console.error(`[NutriTrack] Intento fallido (${4 - retries}/3):`, err.message);
      retries--;

      if (retries === 0) {
        console.error('[NutriTrack] Gemini falló tras 3 intentos.');
        return res.status(500).json({ error: 'Servidores de IA saturados. Inténtalo en unos minutos.' });
      }

      // Esperar 5 segundos exactos antes del siguiente intento
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Insertar en Supabase
  const { error: insertErr } = await supabase.from('food_entries').insert({
    user_id:   user.id,
    food_name: food.trim(),
    calories:  macros.calories,
    proteins:  macros.proteins,
    carbs:     macros.carbs,
    fats:      macros.fats,
    fiber:     macros.fiber,
  });

  if (insertErr) {
    console.error('[NutriTrack] Insert error:', insertErr);
    return res.status(500).json({ error: 'Error al guardar el alimento.' });
  }

  return res.json(macros);
});

// ─── GET /api/data ────────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Calorías de hoy
  const { data: todayRows, error: todayErr } = await supabase
    .from('food_entries')
    .select('calories, proteins, carbs, fats')
    .eq('user_id', user.id)
    .eq('date', today);

  if (todayErr) {
    console.error('[NutriTrack] /api/data today error:', todayErr);
    return res.status(500).json({ error: 'Error al obtener datos de hoy.' });
  }

  const todaySummary = (todayRows || []).reduce(
    (acc, row) => ({
      calories: acc.calories + (row.calories || 0),
      proteins: acc.proteins + (row.proteins || 0),
      carbs:    acc.carbs    + (row.carbs    || 0),
      fats:     acc.fats     + (row.fats     || 0),
    }),
    { calories: 0, proteins: 0, carbs: 0, fats: 0 }
  );

  // Últimos 7 días
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  const fromDate = sevenDaysAgo.toISOString().slice(0, 10);

  const { data: weekRows, error: weekErr } = await supabase
    .from('food_entries')
    .select('date, calories')
    .eq('user_id', user.id)
    .gte('date', fromDate)
    .lte('date', today)
    .order('date', { ascending: true });

  if (weekErr) {
    console.error('[NutriTrack] /api/data week error:', weekErr);
    return res.status(500).json({ error: 'Error al obtener datos semanales.' });
  }

  // Agrupar por día y generar array de 7 entradas
  const byDate = {};
  for (const row of weekRows || []) {
    byDate[row.date] = (byDate[row.date] || 0) + (row.calories || 0);
  }

  const weekly = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr  = d.toISOString().slice(0, 10);
    const label    = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
    weekly.push({ date: label, calories: Math.round(byDate[dateStr] || 0) });
  }

  // Calcular racha de días consecutivos
  const { data: streakRows } = await supabase
    .from('food_entries')
    .select('date')
    .eq('user_id', user.id)
    .order('date', { ascending: false });

  const uniqueDates = [...new Set((streakRows || []).map(r => r.date))];
  let streak = 0;
  const cur = new Date();
  if (!uniqueDates.includes(today)) cur.setDate(cur.getDate() - 1);
  while (true) {
    const d = cur.toISOString().slice(0, 10);
    if (uniqueDates.includes(d)) { streak++; cur.setDate(cur.getDate() - 1); }
    else break;
  }

  return res.json({ today: todaySummary, weekly, streak });
});

// ─── GET /api/profile ────────────────────────────────────────────────────────
app.get('/api/profile', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { data, error } = await supabase
    .from('user_profiles')
    .select('target_calories, target_proteins, nickname')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[NutriTrack] GET /api/profile error:', error);
    return res.status(500).json({ error: 'Error al obtener el perfil.' });
  }

  const profile = data || { target_calories: 2000, target_proteins: 150 };
  const isAdmin = ADMIN_EMAIL && user.email === ADMIN_EMAIL;

  return res.json({
    ...profile,
    isAdmin: !!isAdmin,
    ...(isAdmin && INVITE_CODE ? { inviteCode: INVITE_CODE } : {}),
  });
});

// ─── POST /api/profile ────────────────────────────────────────────────────────
app.post('/api/profile', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const target_calories = parseInt(req.body.target_calories, 10);
  const target_proteins = parseInt(req.body.target_proteins, 10);
  const nickname        = req.body.nickname ? String(req.body.nickname).trim().slice(0, 30) : undefined;

  if (isNaN(target_calories) || isNaN(target_proteins) || target_calories < 1 || target_proteins < 1) {
    return res.status(400).json({ error: 'Los objetivos deben ser números positivos.' });
  }

  const { error } = await supabase
    .from('user_profiles')
    .upsert(
      { user_id: user.id, target_calories, target_proteins, ...(nickname ? { nickname } : {}), updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

  if (error) {
    console.error('[NutriTrack] POST /api/profile error:', error);
    return res.status(500).json({ error: 'Error al guardar el perfil.' });
  }

  return res.json({ target_calories, target_proteins, ...(nickname ? { nickname } : {}) });
});

// ─── GET /api/entries/today ───────────────────────────────────────────────────
app.get('/api/entries/today', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('food_entries')
    .select('id, food_name, calories, proteins, carbs, fats, fiber')
    .eq('user_id', user.id)
    .eq('date', today)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[NutriTrack] /api/entries/today error:', error);
    return res.status(500).json({ error: 'Error al obtener las entradas de hoy.' });
  }

  return res.json(data || []);
});

// ─── DELETE /api/entries/:id ──────────────────────────────────────────────────
app.delete('/api/entries/:id', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { id } = req.params;

  // Solo eliminar si pertenece al usuario (RLS también lo protege)
  const { error } = await supabase
    .from('food_entries')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.error('[NutriTrack] DELETE entry error:', error);
    return res.status(500).json({ error: 'Error al eliminar la entrada.' });
  }

  return res.status(204).send();
});

// ─── POST /api/chat ───────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { message, history = [], context = {} } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'El campo "message" es obligatorio.' });
  }

  const remaining = Math.max(0, (context.goalCalories || 2000) - (context.calories || 0));

  const systemPrompt = `Eres un asistente nutricional personal experto, amigable y conciso. Respondes siempre en español.

Datos del usuario de hoy:
- Calorías: ${context.calories || 0} kcal consumidas de ${context.goalCalories || 2000} kcal objetivo (quedan ${remaining} kcal)
- Proteínas: ${context.proteins || 0}g de ${context.goalProteins || 150}g objetivo
- Carbohidratos: ${context.carbs || 0}g
- Grasas: ${context.fats || 0}g

Cuando sugieras comidas sé específico con porciones y menciona valores nutricionales aproximados. Respuestas concisas y prácticas.`;

  const contents = [];
  for (const msg of history) {
    contents.push({ role: msg.role, parts: [{ text: msg.text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message.trim() }] });

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
        }),
      }
    );

    if (!geminiRes.ok) throw new Error(`Gemini HTTP ${geminiRes.status}`);

    const geminiData = await geminiRes.json();
    const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || 'No he podido generar una respuesta.';

    return res.json({ reply });
  } catch (err) {
    console.error('[NutriTrack] /api/chat error:', err.message);
    return res.status(500).json({ error: 'Error al conectar con el asistente.' });
  }
});

// ─── POST /api/weight ────────────────────────────────────────────────────────
app.post('/api/weight', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const weight = parseFloat(req.body.weight);
  if (isNaN(weight) || weight < 20 || weight > 500) {
    return res.status(400).json({ error: 'Peso no válido.' });
  }

  const today = new Date().toISOString().slice(0, 10);

  const { error } = await supabase
    .from('weight_entries')
    .upsert(
      { user_id: user.id, weight, date: today },
      { onConflict: 'user_id,date' }
    );

  if (error) {
    console.error('[NutriTrack] POST /api/weight error:', error);
    return res.status(500).json({ error: 'Error al guardar el peso.' });
  }

  return res.json({ weight, date: today });
});

// ─── GET /api/weight ──────────────────────────────────────────────────────────
app.get('/api/weight', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
  const fromDate = thirtyDaysAgo.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('weight_entries')
    .select('date, weight')
    .eq('user_id', user.id)
    .gte('date', fromDate)
    .order('date', { ascending: true });

  if (error) {
    console.error('[NutriTrack] GET /api/weight error:', error);
    return res.status(500).json({ error: 'Error al obtener el peso.' });
  }

  return res.json(data || []);
});

// ─── GET /api/push/vapid-key ──────────────────────────────────────────────────
app.get('/api/push/vapid-key', (_, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push no configurado.' });
  return res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ─── POST /api/push/subscribe ─────────────────────────────────────────────────
app.post('/api/push/subscribe', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Suscripción requerida.' });

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({ user_id: user.id, subscription }, { onConflict: 'user_id' });

  if (error) {
    console.error('[NutriTrack] push subscribe error:', error);
    return res.status(500).json({ error: 'Error al guardar la suscripción.' });
  }
  return res.json({ ok: true });
});

// ─── DELETE /api/push/unsubscribe ─────────────────────────────────────────────
app.delete('/api/push/unsubscribe', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  await supabase.from('push_subscriptions').delete().eq('user_id', user.id);
  return res.json({ ok: true });
});

// ─── POST /api/groups ─────────────────────────────────────────────────────────
app.post('/api/groups', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });

  // Generar código único
  let code, exists = true;
  while (exists) {
    code = generateGroupCode();
    const { data } = await supabase.from('competition_groups').select('id').eq('code', code).maybeSingle();
    exists = !!data;
  }

  const { data: group, error } = await supabase
    .from('competition_groups')
    .insert({ name: name.trim(), code, created_by: user.id })
    .select()
    .single();

  if (error) {
    console.error('[NutriTrack] create group error:', error);
    return res.status(500).json({ error: 'Error al crear el grupo.' });
  }

  // Añadir creador como miembro
  await supabase.from('group_members').insert({ group_id: group.id, user_id: user.id });

  return res.json(group);
});

// ─── POST /api/groups/join ────────────────────────────────────────────────────
app.post('/api/groups/join', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido.' });

  const { data: group, error } = await supabase
    .from('competition_groups')
    .select('*')
    .eq('code', code.toUpperCase())
    .maybeSingle();

  if (error || !group) return res.status(404).json({ error: 'Grupo no encontrado. Revisa el código.' });

  const { error: memberError } = await supabase
    .from('group_members')
    .upsert({ group_id: group.id, user_id: user.id }, { onConflict: 'group_id,user_id' });

  if (memberError) {
    console.error('[NutriTrack] join group error:', memberError);
    return res.status(500).json({ error: 'Error al unirte al grupo.' });
  }

  return res.json(group);
});

// ─── GET /api/groups ──────────────────────────────────────────────────────────
app.get('/api/groups', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { data, error } = await supabase
    .from('group_members')
    .select('competition_groups(id, name, code, created_by)')
    .eq('user_id', user.id);

  if (error) {
    console.error('[NutriTrack] get groups error:', error);
    return res.status(500).json({ error: 'Error al obtener los grupos.' });
  }

  const groups = (data || []).map(row => ({
    ...row.competition_groups,
    isOwner: row.competition_groups.created_by === user.id,
  }));

  return res.json(groups);
});

// ─── GET /api/groups/:id/ranking ─────────────────────────────────────────────
app.get('/api/groups/:id/ranking', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { id: groupId } = req.params;

  const { data: membership } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) return res.status(403).json({ error: 'No perteneces a este grupo.' });

  const { data: members } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId);

  // Lunes de la semana actual
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  const weekStart = monday.toISOString().slice(0, 10);

  const calcScore = (entries, goal) => {
    const byDate = {};
    for (const e of entries) byDate[e.date] = (byDate[e.date] || 0) + e.calories;
    let days = 0, onGoal = 0;
    for (const cals of Object.values(byDate)) {
      days++;
      const ratio = cals / goal;
      if (ratio >= 0.8 && ratio <= 1.15) onGoal++;
    }
    return days * 10 + onGoal * 5;
  };

  const ranking = await Promise.all((members || []).map(async ({ user_id }) => {
    const [profileRes, entriesRes, authRes] = await Promise.all([
      supabase.from('user_profiles').select('nickname, target_calories').eq('user_id', user_id).maybeSingle(),
      supabase.from('food_entries').select('date, calories').eq('user_id', user_id),
      supabase.auth.admin.getUserById(user_id),
    ]);

    const goal       = profileRes.data?.target_calories || 2000;
    const name       = profileRes.data?.nickname || authRes.data?.user?.email?.split('@')[0] || 'Usuario';
    const allEntries = entriesRes.data || [];
    const weekEntries = allEntries.filter(e => e.date >= weekStart);

    return {
      userId:      user_id,
      name,
      weeklyScore: calcScore(weekEntries, goal),
      totalScore:  calcScore(allEntries, goal),
      isYou:       user_id === user.id,
    };
  }));

  return res.json(ranking);
});

// ─── CRON: notificaciones push ────────────────────────────────────────────────
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  cron.schedule('0 7-23 * * *', async () => {
    console.log('[NutriTrack] Comprobando notificaciones push...');
    const { data: subs } = await supabase.from('push_subscriptions').select('*');
    const now = new Date();
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000);

    for (const sub of subs || []) {
      if (sub.last_notified_at && new Date(sub.last_notified_at) > sixHoursAgo) continue;

      const { data: recent } = await supabase
        .from('food_entries')
        .select('id')
        .eq('user_id', sub.user_id)
        .gte('created_at', sixHoursAgo.toISOString())
        .limit(1);

      if (recent && recent.length > 0) continue;

      try {
        await webpush.sendNotification(
          sub.subscription,
          JSON.stringify({ title: 'NutriTrack 🥗', body: '¿Has registrado lo que has comido? ¡Mantén tu racha!' })
        );
        await supabase.from('push_subscriptions').update({ last_notified_at: now.toISOString() }).eq('id', sub.id);
      } catch (err) {
        if (err.statusCode === 410) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      }
    }
  });
}

// ─── GYM PARTNER: helper ─────────────────────────────────────────────────────
async function getAcceptedPartnership(userId) {
  const { data } = await supabase
    .from('gym_partnerships')
    .select('*')
    .or(`inviter_id.eq.${userId},partner_id.eq.${userId}`)
    .eq('status', 'accepted')
    .maybeSingle();
  return data;
}

// ─── GYM PARTNER: POST /api/gym/partner/invite ───────────────────────────────
app.post('/api/gym/partner/invite', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const existing = await getAcceptedPartnership(user.id);
  if (existing) return res.status(400).json({ error: 'Ya tienes un compañero vinculado.' });

  // Borrar invitaciones pendientes previas del usuario
  await supabase.from('gym_partnerships').delete().eq('inviter_id', user.id).eq('status', 'pending');

  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const { data, error } = await supabase
    .from('gym_partnerships')
    .insert({ inviter_id: user.id, invite_code: code })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Error al generar el código.' });
  return res.json({ code: data.invite_code });
});

// ─── GYM PARTNER: POST /api/gym/partner/join ─────────────────────────────────
app.post('/api/gym/partner/join', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido.' });

  const existing = await getAcceptedPartnership(user.id);
  if (existing) return res.status(400).json({ error: 'Ya tienes un compañero vinculado.' });

  const { data: partnership } = await supabase
    .from('gym_partnerships')
    .select('*')
    .eq('invite_code', code.toUpperCase())
    .eq('status', 'pending')
    .maybeSingle();

  if (!partnership) return res.status(404).json({ error: 'Código no válido o ya usado.' });
  if (partnership.inviter_id === user.id) return res.status(400).json({ error: 'No puedes vincularte contigo mismo.' });

  const { error } = await supabase
    .from('gym_partnerships')
    .update({ partner_id: user.id, status: 'accepted' })
    .eq('id', partnership.id);

  if (error) return res.status(500).json({ error: 'Error al aceptar la invitación.' });
  return res.json({ ok: true });
});

// ─── GYM PARTNER: GET /api/gym/partner ───────────────────────────────────────
app.get('/api/gym/partner', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const partnership = await getAcceptedPartnership(user.id);
  if (!partnership) return res.json({ partner: null });

  const partnerId = partnership.inviter_id === user.id
    ? partnership.partner_id
    : partnership.inviter_id;

  // Perfil del compañero
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('nickname')
    .eq('user_id', partnerId)
    .maybeSingle();

  // Ejercicios del compañero
  const { data: exercises } = await supabase
    .from('gym_exercises')
    .select('id, name, muscle_group')
    .eq('user_id', partnerId)
    .order('muscle_group').order('name');

  // Series del compañero (para calcular PRs)
  const { data: partnerSets } = await supabase
    .from('gym_sets')
    .select('exercise_id, weight, reps')
    .eq('user_id', partnerId);

  // PR por ejercicio del compañero
  const partnerPRs = {};
  (partnerSets || []).forEach(s => {
    const rm = Math.round(s.weight * (1 + s.reps / 30) * 10) / 10;
    if (!partnerPRs[s.exercise_id] || rm > partnerPRs[s.exercise_id]) partnerPRs[s.exercise_id] = rm;
  });

  // Reto semanal: volumen total (peso × reps) desde el lunes
  const now  = new Date();
  const day  = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const weekStart = monday.toISOString().slice(0, 10);

  const [{ data: mySets }, { data: theirSets }] = await Promise.all([
    supabase.from('gym_sets').select('weight, reps').eq('user_id', user.id).gte('date', weekStart),
    supabase.from('gym_sets').select('weight, reps').eq('user_id', partnerId).gte('date', weekStart),
  ]);

  const myVolume    = Math.round((mySets    || []).reduce((s, r) => s + r.weight * r.reps, 0));
  const theirVolume = Math.round((theirSets || []).reduce((s, r) => s + r.weight * r.reps, 0));

  return res.json({
    partner: {
      id:            partnerId,
      nickname:      profile?.nickname || 'Compañero',
      exercises:     (exercises || []).map(e => ({ ...e, pr: partnerPRs[e.id] || null })),
      weeklyVolume:  theirVolume,
    },
    myWeeklyVolume: myVolume,
  });
});

// ─── GYM PARTNER: DELETE /api/gym/partner ────────────────────────────────────
app.delete('/api/gym/partner', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  await supabase
    .from('gym_partnerships')
    .delete()
    .or(`inviter_id.eq.${user.id},partner_id.eq.${user.id}`);

  return res.json({ ok: true });
});

// ─── GYM: GET /api/gym/exercises ─────────────────────────────────────────────
app.get('/api/gym/exercises', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { data, error } = await supabase
    .from('gym_exercises')
    .select('id, name, muscle_group')
    .eq('user_id', user.id)
    .order('muscle_group')
    .order('name');

  if (error) return res.status(500).json({ error: 'Error al obtener ejercicios.' });
  return res.json(data || []);
});

// ─── GYM: POST /api/gym/exercises ────────────────────────────────────────────
app.post('/api/gym/exercises', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const MUSCLES = ['Pecho', 'Hombro', 'Tríceps', 'Espalda', 'Bíceps', 'Pierna'];
  const { name, muscle_group } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
  if (!MUSCLES.includes(muscle_group)) return res.status(400).json({ error: 'Músculo no válido.' });

  const { data, error } = await supabase
    .from('gym_exercises')
    .insert({ user_id: user.id, name: name.trim(), muscle_group })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Error al crear el ejercicio.' });
  return res.json(data);
});

// ─── GYM: DELETE /api/gym/exercises/:id ──────────────────────────────────────
app.delete('/api/gym/exercises/:id', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { error } = await supabase
    .from('gym_exercises')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', user.id);

  if (error) return res.status(500).json({ error: 'Error al eliminar el ejercicio.' });
  return res.status(204).send();
});

// ─── GYM: POST /api/gym/sets ─────────────────────────────────────────────────
app.post('/api/gym/sets', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { exercise_id, weight, reps } = req.body;
  const weightNum = parseFloat(weight);
  const repsNum   = parseInt(reps, 10);

  if (!exercise_id) return res.status(400).json({ error: 'exercise_id requerido.' });
  if (isNaN(weightNum) || weightNum <= 0) return res.status(400).json({ error: 'Peso no válido.' });
  if (isNaN(repsNum)   || repsNum <= 0)   return res.status(400).json({ error: 'Repeticiones no válidas.' });

  const { data: ex } = await supabase
    .from('gym_exercises')
    .select('id')
    .eq('id', exercise_id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!ex) return res.status(403).json({ error: 'Ejercicio no encontrado.' });

  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('gym_sets')
    .insert({ user_id: user.id, exercise_id, weight: weightNum, reps: repsNum, date: today })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Error al guardar la serie.' });
  return res.json(data);
});

// ─── GYM: GET /api/gym/sets/:exerciseId ──────────────────────────────────────
app.get('/api/gym/sets/:exerciseId', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { data, error } = await supabase
    .from('gym_sets')
    .select('id, weight, reps, date')
    .eq('exercise_id', req.params.exerciseId)
    .eq('user_id', user.id)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'Error al obtener series.' });
  return res.json(data || []);
});

// ─── GYM: DELETE /api/gym/sets/:id ───────────────────────────────────────────
app.delete('/api/gym/sets/:id', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { error } = await supabase
    .from('gym_sets')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', user.id);

  if (error) return res.status(500).json({ error: 'Error al eliminar la serie.' });
  return res.status(204).send();
});

// ─── HEALTHCHECK ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[NutriTrack] Servidor escuchando en puerto ${PORT}`);
});
