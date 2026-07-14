# MGCE Inventario

PWA de inventario de bebidas para MGCE Catering (NYC). Fase 1: conteo de almacén offline-first.

**App:** https://pusher056.github.io/mgce-inventory/

## Qué hace

- Cuenta bebidas escaneando el código de barras (funciona 100 % sin internet — el motor de escaneo va incluido en la app).
- Cantidades en dos unidades: **cajas** y **botellas sueltas** (botellas por caja configurable: 6/12/24/otro).
- Sin señal, los escaneos y fotos se guardan en el teléfono; al recuperar señal se sincroniza todo con Supabase y se resuelven los nombres de producto (Open Food Facts / UPCitemdb) y las fotos (OpenAI vision).
- Exporta el conteo a PDF y Excel.
- Fotos de cada producto: miniatura en la lista, toca para ampliar.

## Arquitectura

| Capa | Tecnología |
| --- | --- |
| App | React + Vite + TypeScript, PWA (vite-plugin-pwa) |
| Datos locales | IndexedDB vía Dexie (fuente de verdad offline) |
| Sincronización | Cola outbox → Supabase (push cuando hay señal) |
| Backend | Supabase `mgce-inventory` (Postgres + Storage + Edge Functions) |
| Identificación | Edge function `identify`: barcode → Open Food Facts / UPCitemdb; foto → OpenAI |
| Escaneo | `barcode-detector` (zxing-wasm empaquetado, sin CDN) |

Diseñada para crecer: fase 2 añade login (Microsoft 365) y multi-usuario — el esquema ya tiene RLS activado con políticas abiertas a `anon` que se endurecerán entonces.

## Desarrollo

```bash
npm install
npm run dev      # servidor local
npm run build    # build de producción en dist/
```

Deploy: push a `main` reconstruye… (fase 1: push manual de `dist/` a la rama `gh-pages`).

## Configuración pendiente

- `OPENAI_API_KEY` como secreto de la edge function `identify` (Supabase Dashboard → Edge Functions → Secrets) para activar la identificación por foto.
