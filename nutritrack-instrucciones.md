# NutriTrack — Añadir sistema de usuarios

## Contexto

Tengo una PWA de seguimiento nutricional que actualmente funciona así:
- Frontend: HTML + Tailwind CDN + Chart.js (index.html, app.js, sw.js, manifest.json)
- Backend: Google Apps Script (GET datos) + n8n webhook (POST alimento) + Google Sheets como BD
- n8n llama a Gemini para calcular macros y las escribe en la hoja

Quiero migrar a una arquitectura con usuarios, eliminando Google Sheets y n8n.

## Objetivo

Transformar el proyecto actual para:
1. Añadir login/registro de usuarios (email + contraseña)
2. Que cada usuario tenga sus propios datos
3. Reemplazar Google Sheets por Supabase (PostgreSQL)
4. Reemplazar n8n por un backend propio que llame a Gemini
5. Mantener el diseño visual actual exactamente igual

## Stack

- **Frontend:** HTML + Tailwind CSS CDN + Chart.js (mantener el diseño actual)
- **Backend:** Node.js + Express
- **BD:** Supabase (PostgreSQL)
- **IA:** Google Gemini API (gemini-2.0-flash)
- **Auth:** Supabase Auth
- **Deploy:** Railway (backend) + GitHub Pages (frontend)

## Estructura actual del proyecto

```
nutritrack/
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── app.js              ← lógica principal del dashboard
├── icon.svg
├── index.html          ← dashboard (única página)
├── manifest.json
└── sw.js
```

## Estructura objetivo

```
nutritrack/
├── frontend/           ← se despliega en GitHub Pages
│   ├── icons/
│   ├── index.html      ← pantalla de login/registro
│   ├── app.html        ← dashboard (mover el index.html actual aquí)
│   ├── app.js          ← lógica del dashboard (modificada)
│   ├── auth.js         ← lógica de login/registro/logout
│   ├── icon.svg
│   ├── manifest.json
│   └── sw.js
├── backend/            ← se despliega en Railway
│   ├── package.json
│   ├── server.js
│   └── .env
└── README.md
```

## Tablas en Supabase

### profiles
```sql
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  calorie_goal INTEGER DEFAULT 2300,
  protein_goal INTEGER DEFAULT 200,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

### food_entries
```sql
CREATE TABLE food_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) NOT NULL,
  food_name TEXT NOT NULL,
  calories REAL DEFAULT 0,
  proteins REAL DEFAULT 0,
  carbs REAL DEFAULT 0,
  fats REAL DEFAULT 0,
  fiber REAL DEFAULT 0,
  date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE food_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own entries" ON food_entries
  FOR ALL USING (auth.uid() = user_id);
```

## Backend (server.js)

Un solo archivo server.js con Express que expone:

### POST /api/auth/register
- Body: `{ "email": "...", "password": "..." }`
- Usa Supabase Auth para registrar
- Devuelve: `{ "token": "...", "user": { "id", "email" } }`

### POST /api/auth/login
- Body: `{ "email": "...", "password": "..." }`
- Devuelve: `{ "token": "...", "user": { "id", "email" } }`

### POST /api/food (requiere Authorization: Bearer token)
- Body: `{ "food": "150g de pechuga a la plancha" }`
- El backend:
  1. Verifica el token con Supabase
  2. Llama a Gemini con prompt: "Calcula los valores nutricionales para: {food}. Responde ÚNICAMENTE con JSON: {\"calories\": X, \"proteins\": X, \"carbs\": X, \"fats\": X, \"fiber\": X}. Solo números."
  3. Parsea la respuesta
  4. Inserta en food_entries con el user_id
  5. Devuelve las macros calculadas directamente
- **IMPORTANTE:** La respuesta es síncrona — no hace falta polling. El frontend espera la respuesta y ya tiene las macros.

### GET /api/data (requiere Authorization: Bearer token)
- Consulta food_entries del usuario
- Devuelve:
```json
{
  "today": { "calories": 1200, "proteins": 85, "carbs": 150, "fats": 40 },
  "weekly": [
    { "date": "07/04", "calories": 2100 },
    { "date": "08/04", "calories": 1900 }
  ]
}
```
- "today": suma de todas las entradas de hoy
- "weekly": suma de calorías por día de los últimos 7 días

### GET /api/entries/today (requiere token)
- Devuelve lista de entradas del día actual:
```json
[
  { "id": "...", "food_name": "Café con leche", "calories": 120, "proteins": 6, ... },
  ...
]
```

### DELETE /api/entries/:id (requiere token)
- Elimina una entrada (solo si pertenece al usuario)

### Variables de entorno (.env)
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
GEMINI_API_KEY=AIzaSy...
PORT=3000
FRONTEND_URL=https://mirandagaizka.github.io
```

### CORS
Permitir peticiones desde FRONTEND_URL.

### Dependencias
```json
{
  "dependencies": {
    "express": "^4",
    "cors": "^2",
    "@supabase/supabase-js": "^2"
  }
}
```

Para Gemini, usar fetch nativo de Node.js (no necesita librería). Endpoint:
`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=GEMINI_API_KEY`

## Frontend — Login (index.html)

Nueva página con el mismo estilo visual (bg-slate-950, emerald accent, rounded-2xl cards):

- Logo NutriTrack arriba
- Dos tabs: "Iniciar sesión" / "Crear cuenta"
- Login: campos email + contraseña + botón "Entrar"
- Registro: campos email + contraseña + confirmar contraseña + botón "Crear cuenta"
- Mensajes de error inline
- Al hacer login/registro exitoso → guardar token en sessionStorage y redirigir a app.html

### auth.js
- Funciones: login(), register(), logout(), getToken(), isLoggedIn()
- Guardar token en sessionStorage
- getToken() devuelve el token para incluir en headers
- Si no hay token al cargar app.html, redirigir a index.html

## Frontend — Dashboard (app.html)

Mover el index.html actual a app.html. Modificaciones:

1. **Header:** Añadir botón de logout (icono puerta/salir) junto al objetivo
2. **Eliminar polling:** Ya no hace falta. POST /api/food devuelve las macros directamente
3. **handleSubmit modificado:**
   - POST a `${API_URL}/api/food` con header Authorization
   - Esperar respuesta (que ya trae las macros)
   - Recargar datos con GET /api/data
   - Mostrar "¡Registrado!" al terminar
4. **loadData modificado:**
   - GET a `${API_URL}/api/data` con header Authorization
5. **Añadir lista de alimentos de hoy:**
   - Debajo del formulario, mostrar las entradas del día
   - Cada entrada: nombre + calorías + botón eliminar
   - Al eliminar: DELETE /api/entries/:id y recargar datos
6. **API_URL:** Cambiar a la URL del backend en Railway
7. **Eliminar WEBHOOK_URL:** Ya no se usa

## Diseño visual — NO cambiar

- bg-slate-950, cards bg-slate-900, border-slate-800
- Accent emerald-500
- Tailwind CDN
- Chart.js CDN
- Mismo layout, mismos gráficos, mismas animaciones
- Mobile-first, max-w-md centrado

## PWA

- Actualizar sw.js para que deje pasar peticiones al nuevo backend (hostname del Railway)
- Cambiar CACHE_NAME a 'nutritrack-v3'
- Añadir auth.js y app.html al APP_SHELL

## Notas

- No usar Google Sheets, Google Apps Script, ni n8n
- Gemini se llama desde el backend, nunca desde el frontend
- El token se envía como header Authorization: Bearer <token>
- Implementar manejo de errores en todas las peticiones
- Si Gemini falla, devolver error 500 con mensaje claro
