#!/usr/bin/env node
/**
 * Portada de un artículo: OpenAI → WebP → Cloudflare R2.
 *
 *   node scripts/portada.mjs --slug como-cotizar-un-flete \
 *        --prompt "camión rampla cargando pallets en un centro de distribución de Santiago al amanecer"
 *
 * Qué hace:
 *   1. Si R2 ya tiene la portada de ese slug, no hace nada (no gasta crédito
 *      de OpenAI). Para cambiarla: --reemplazar.
 *   2. Genera la imagen con la API de imágenes de OpenAI (o toma --desde
 *      <archivo>, por ejemplo una imagen hecha en ChatGPT).
 *   3. La recorta a 1200×630 (proporción de Open Graph) y la convierte a
 *      WebP en tres anchos: 1200, 800 y 480. Sin metadatos, calidad ajustada
 *      para que la grande quede bajo ~200 KB.
 *   4. Sube los tres a R2:
 *        imagenes-chiletransportistas / ChileTransportistas-assets/Blog/{slug}.webp
 *                                                                  {slug}-800.webp
 *                                                                  {slug}-480.webp
 *   5. Imprime un JSON con las URLs del CDN, el srcset y las dimensiones.
 *
 * Opciones:
 *   --slug <slug>        obligatorio: minúsculas, números y guiones
 *   --prompt "<escena>"  la escena concreta; el estilo lo agrega el script
 *   --desde <archivo>    usa esta imagen en vez de generar una (png/jpg/webp)
 *   --reemplazar         pisa la portada que ya existe en R2 (y genera de nuevo)
 *   --calidad <q>        low | medium | high (OpenAI). Por defecto: medium
 *   --sin-subir          deja los .webp en .cache/portadas/ y no toca R2
 *
 * Variables (entorno o archivo .env en la raíz del repo, que no se versiona):
 *   OPENAI_API_KEY
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   opcionales: R2_BUCKET (imagenes-chiletransportistas),
 *               R2_PREFIX (ChileTransportistas-assets/Blog/),
 *               CDN_BASE  (https://cdn.chiletransportistas.com),
 *               OPENAI_IMAGE_MODEL (gpt-image-1), OPENAI_BASE_URL, R2_ENDPOINT
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { R2 } from "./lib/r2.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(RAIZ, ".cache", "portadas");

const ANCHO = 1200;
const ALTO = 630;
const VARIANTES = [
  { sufijo: "", ancho: 1200 },
  { sufijo: "-800", ancho: 800 },
  { sufijo: "-480", ancho: 480 },
];
const PESO_OBJETIVO = 200 * 1024;
const CACHE_CONTROL = "public, max-age=31536000";

// El estilo va aquí para que cada prompt solo describa la escena.
const ESTILO =
  "Fotografía editorial realista, luz natural, colores sobrios, composición horizontal " +
  "con el sujeto principal centrado y aire alrededor (la imagen se recorta a 1200x630). " +
  "Contexto: transporte de carga por carretera en Chile. " +
  "Sin texto, sin letras, sin números, sin logos, sin marcas comerciales, sin marcas de agua, " +
  "sin patentes legibles, sin personas mirando a cámara.";

function log(...a) {
  console.error(...a);
}

function cargarDotenv() {
  const ruta = join(RAIZ, ".env");
  if (!existsSync(ruta)) return;
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(linea);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function opciones() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      prompt: { type: "string" },
      desde: { type: "string" },
      reemplazar: { type: "boolean", default: false },
      calidad: { type: "string", default: "medium" },
      "sin-subir": { type: "boolean", default: false },
      ayuda: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.ayuda) {
    log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    process.exit(0);
  }
  if (!values.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug)) {
    throw new Error("--slug es obligatorio: minúsculas, números y guiones (sin tildes ni ñ)");
  }
  if (!["low", "medium", "high"].includes(values.calidad)) {
    throw new Error("--calidad debe ser low, medium o high");
  }
  return values;
}

async function generarConOpenAI(prompt, calidad) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Falta OPENAI_API_KEY (o usa --desde <archivo>)");
  const modelo = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const esDalle = modelo.startsWith("dall-e");

  const cuerpo = esDalle
    ? { model: modelo, prompt: `${ESTILO}\n\nEscena: ${prompt}`, size: "1792x1024", quality: calidad === "high" ? "hd" : "standard", response_format: "b64_json", n: 1 }
    : { model: modelo, prompt: `${ESTILO}\n\nEscena: ${prompt}`, size: "1536x1024", quality: calidad, output_format: "png", n: 1 };

  log(`→ Generando con ${modelo} (${calidad}). Suele tardar entre 20 y 90 s…`);
  const api = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const r = await fetch(`${api}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(240_000),
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = datos.error || {};
    const pista =
      err.code === "moderation_blocked"
        ? "\nLa moderación bloqueó el prompt: reescribe la escena (no reintentes el mismo)."
        : "";
    throw new Error(`OpenAI ${r.status}: ${err.message || JSON.stringify(datos).slice(0, 300)}${pista}`);
  }
  const b64 = datos.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI no devolvió la imagen (data[0].b64_json vacío)");
  return Buffer.from(b64, "base64");
}

async function aWebp(original) {
  const { default: sharp } = await import("sharp").catch(() => {
    throw new Error("Falta sharp. Corre una vez:  npm --prefix scripts install");
  });

  // Un solo recorte para las tres variantes: la chica es la grande reducida,
  // no otro encuadre. "attention" busca la zona con más detalle.
  const base = await sharp(original)
    .rotate()
    .resize(ANCHO, ALTO, { fit: "cover", position: sharp.strategy.attention })
    .png()
    .toBuffer();

  const salida = [];
  for (const v of VARIANTES) {
    let calidad = 80;
    let buf;
    for (;;) {
      buf = await sharp(base)
        .resize(v.ancho, Math.round((v.ancho * ALTO) / ANCHO))
        .webp({ quality: calidad, effort: 6, smartSubsample: true })
        .toBuffer();
      const tope = (PESO_OBJETIVO * v.ancho) / ANCHO;
      if (buf.length <= tope || calidad <= 60) break;
      calidad -= 6;
    }
    salida.push({ ...v, alto: Math.round((v.ancho * ALTO) / ANCHO), buf, calidad });
  }
  return salida;
}

async function main() {
  cargarDotenv();
  const o = opciones();
  const slug = o.slug;

  const bucket = process.env.R2_BUCKET || "imagenes-chiletransportistas";
  const prefijo = (process.env.R2_PREFIX || "ChileTransportistas-assets/Blog/").replace(/^\/+/, "");
  const cdn = (process.env.CDN_BASE || "https://cdn.chiletransportistas.com").replace(/\/+$/, "");
  const clave = (sufijo) => `${prefijo}${slug}${sufijo}.webp`;
  const url = (sufijo) => `${cdn}/${clave(sufijo)}`;

  await mkdir(CACHE, { recursive: true });

  let r2 = null;
  let yaExiste = false;
  if (!o["sin-subir"]) {
    r2 = new R2({
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      endpoint: process.env.R2_ENDPOINT,
      bucket,
    });
    yaExiste = await r2.existe(clave(""));
    if (yaExiste && !o.reemplazar) {
      log(`✓ R2 ya tiene ${clave("")}: se reutiliza (usa --reemplazar para cambiarla).`);
      return resumen({ slug, url, estado: "reutilizada" });
    }
  }

  // Fuente: --desde, o el PNG guardado de una corrida anterior (si la subida
  // falló no se vuelve a pagar la generación), o OpenAI.
  const pngCache = join(CACHE, `${slug}.png`);
  let original;
  if (o.desde) {
    original = await readFile(resolve(o.desde));
    log(`→ Usando ${o.desde}`);
  } else if (!o.reemplazar && (await access(pngCache).then(() => true, () => false))) {
    original = await readFile(pngCache);
    log(`→ Reutilizando la imagen generada antes: ${pngCache}`);
  } else {
    if (!o.prompt) throw new Error("--prompt es obligatorio para generar la imagen (o usa --desde)");
    original = await generarConOpenAI(o.prompt, o.calidad);
    await writeFile(pngCache, original);
    log(`  original guardado en ${pngCache}`);
  }

  const variantes = await aWebp(original);
  for (const v of variantes) {
    await writeFile(join(CACHE, `${slug}${v.sufijo}.webp`), v.buf);
    log(`  ${slug}${v.sufijo}.webp  ${v.ancho}×${v.alto}  ${(v.buf.length / 1024).toFixed(0)} KB  (q${v.calidad})`);
  }

  if (o["sin-subir"]) {
    log(`✓ WebP en ${CACHE} (sin subir a R2).`);
    return resumen({ slug, url, estado: "local", variantes });
  }

  for (const v of variantes) {
    await r2.subir(clave(v.sufijo), v.buf, { contentType: "image/webp", cacheControl: CACHE_CONTROL });
    log(`  ↑ r2://${bucket}/${clave(v.sufijo)}`);
  }
  if (yaExiste) {
    log("\n⚠ Reemplazaste una portada publicada. El CDN puede seguir sirviendo la anterior:");
    log("  Cloudflare → Caching → Configuration → Purge Cache → Custom Purge, con estas URLs:");
    for (const v of variantes) log(`  ${url(v.sufijo)}`);
  }
  return resumen({ slug, url, estado: yaExiste ? "reemplazada" : "creada", variantes });
}

function resumen({ slug, url, estado, variantes }) {
  const out = {
    slug,
    estado,
    url: url(""),
    url_800: url("-800"),
    url_480: url("-480"),
    srcset: `${url("-480")} 480w, ${url("-800")} 800w, ${url("")} 1200w`,
    width: ANCHO,
    height: ALTO,
  };
  if (variantes) out.kb = Object.fromEntries(variantes.map((v) => [v.ancho, Math.round(v.buf.length / 1024)]));
  console.log(JSON.stringify(out, null, 2));
  return out;
}

main().catch((err) => {
  log(`✗ ${err.message}`);
  process.exit(1);
});
