// =============================================================================
//  NutriTrack — server.js
//  Express + Supabase + Gemini API
// =============================================================================

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();

// ─── VARIABLES DE ENTORNO ─────────────────────────────────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  PORT = 3000,
  FRONTEND_URL,
} = process.env;

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
  const { email, password, inviteCode } = req.body;

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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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

  return res.json({ today: todaySummary, weekly });
});

// ─── GET /api/profile ────────────────────────────────────────────────────────
app.get('/api/profile', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const { data, error } = await supabase
    .from('user_profiles')
    .select('target_calories, target_proteins')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[NutriTrack] GET /api/profile error:', error);
    return res.status(500).json({ error: 'Error al obtener el perfil.' });
  }

  // Si no existe perfil devolvemos los valores por defecto
  return res.json(data || { target_calories: 2000, target_proteins: 150 });
});

// ─── POST /api/profile ────────────────────────────────────────────────────────
app.post('/api/profile', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ error: 'No autorizado.' });

  const target_calories = parseInt(req.body.target_calories, 10);
  const target_proteins = parseInt(req.body.target_proteins, 10);

  if (isNaN(target_calories) || isNaN(target_proteins) || target_calories < 1 || target_proteins < 1) {
    return res.status(400).json({ error: 'Los objetivos deben ser números positivos.' });
  }

  const { error } = await supabase
    .from('user_profiles')
    .upsert(
      { user_id: user.id, target_calories, target_proteins, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );

  if (error) {
    console.error('[NutriTrack] POST /api/profile error:', error);
    return res.status(500).json({ error: 'Error al guardar el perfil.' });
  }

  return res.json({ target_calories, target_proteins });
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
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

// ─── HEALTHCHECK ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[NutriTrack] Servidor escuchando en puerto ${PORT}`);
});
