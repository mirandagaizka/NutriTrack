# NutriTrack

PWA de seguimiento nutricional con sistema de usuarios.

## Stack

- **Frontend:** HTML + Tailwind CDN + Chart.js → GitHub Pages
- **Backend:** Node.js + Express → Railway
- **Base de datos:** Supabase (PostgreSQL + Auth)
- **IA:** Google Gemini 2.0 Flash

## Estructura

```
nutritrack/
├── frontend/        → GitHub Pages (rama gh-pages o /docs)
│   ├── index.html   → Login / Registro
│   ├── app.html     → Dashboard
│   ├── app.js       → Lógica del dashboard
│   ├── auth.js      → Login, registro, logout, token
│   ├── sw.js        → Service Worker (PWA)
│   ├── manifest.json
│   ├── icon.svg
│   └── icons/
├── backend/         → Railway
│   ├── server.js
│   ├── package.json
│   └── .env         → NO subir a git
└── README.md
```

## Configuración

### 1. Supabase

Crea un proyecto en [supabase.com](https://supabase.com) y ejecuta el SQL del archivo `nutritrack-instrucciones.md` para crear las tablas `profiles` y `food_entries`.

### 2. Backend (Railway)

1. Conecta el repositorio en Railway y selecciona el directorio `backend/`
2. Añade las variables de entorno:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY`
   - `FRONTEND_URL` → URL de GitHub Pages
3. Railway detecta `package.json` y arranca con `npm start`

### 3. Frontend (GitHub Pages)

1. En `frontend/auth.js`, cambia `API_URL` por la URL de tu backend en Railway
2. Despliega la carpeta `frontend/` en GitHub Pages

## Endpoints del backend

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Registrar usuario |
| POST | `/api/auth/login` | No | Iniciar sesión |
| POST | `/api/food` | Sí | Registrar alimento (Gemini calcula macros) |
| GET | `/api/data` | Sí | Resumen de hoy + gráfico semanal |
| GET | `/api/entries/today` | Sí | Lista de entradas del día |
| DELETE | `/api/entries/:id` | Sí | Eliminar una entrada |
| GET | `/health` | No | Healthcheck |
