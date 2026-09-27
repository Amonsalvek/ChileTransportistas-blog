/**
 * chtr-blog-router — Cloudflare Worker
 *
 * www.chiletransportistas.com lo sirve Unicorn. Este Worker toma las rutas
 * del blog y se las pide al droplet; todo lo demás sigue de largo a Unicorn.
 *
 *   /blog                      301 → /blog/
 *   /blog/                     portada del blog (droplet) + lista de los
 *                              artículos que siguen en Unicorn
 *   /blog/assets/…             CSS y JS del blog (droplet)
 *   /blog/{slug}/              artículos viejos de Unicorn (pasan de largo)
 *   /transportistas…           pista de transportistas (droplet)
 *   /contratar-transporte…     pista de quien contrata transporte (droplet)
 *   /sitemap-blog.xml          sitemap del blog (droplet)
 *
 * Al droplet se llega por blog.chiletransportistas.com, que ya tiene DNS y
 * certificado, con la cabecera "X-Chtr-Proxy: worker". Sin esa cabecera el
 * droplet responde 301 a www: así el subdominio deja de existir para Google
 * y para las visitas, y sigue sirviendo de origen.
 *
 * Si el droplet responde 404 en una ruta HTML, se le pregunta a Unicorn:
 * nada que Unicorn tuviera bajo esas rutas se rompe, y el 404 que ve la
 * visita es el del sitio.
 *
 * Rutas del Worker (wrangler.toml):
 *   www.chiletransportistas.com/blog*
 *   www.chiletransportistas.com/transportistas*
 *   www.chiletransportistas.com/contratar-transporte*
 *   www.chiletransportistas.com/sitemap-blog.xml
 *   y lo mismo sin www, que solo redirige a www.
 */

const WWW = "www.chiletransportistas.com";
const APEX = "chiletransportistas.com";
const HOST_ORIGEN = "blog.chiletransportistas.com";
const CABECERA_PROXY = "X-Chtr-Proxy";
const CABECERA_INTERNA = "X-Chtr-Interno";

// Cuánto se guarda la lista de artículos de Unicorn antes de volver a leerla.
const TTL_LISTA_UNICORN = 3600;
const TTL_LISTA_VACIA = 300;
const TIMEOUT_UNICORN_MS = 2500;
const MAX_ARTICULOS_UNICORN = 40;

// Cabeceras de la visita que vale la pena reenviar al droplet.
const CABECERAS_REENVIADAS = [
  "accept",
  "accept-language",
  "user-agent",
  "referer",
  "if-none-match",
  "if-modified-since",
  "range",
];

const PISTAS = /^\/(?:transportistas|contratar-transporte)(?:\/|$)/;

/** ¿Esta ruta la sirve el droplet? */
export function esRutaDelBlog(pathname) {
  return (
    pathname === "/blog/" ||
    pathname.startsWith("/blog/assets/") ||
    pathname === "/sitemap-blog.xml" ||
    PISTAS.test(pathname)
  );
}

/** Rutas donde un 404 del droplet se le pregunta a Unicorn. */
function admiteRespaldoUnicorn(pathname) {
  return !pathname.startsWith("/blog/assets/") && pathname !== "/sitemap-blog.xml";
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await enrutar(request, ctx);
    } catch (err) {
      // Ante cualquier error propio, que responda Unicorn: mejor su página
      // que un error del Worker.
      console.error("chtr-blog-router:", err && err.stack ? err.stack : err);
      return fetch(request);
    }
  },
};

async function enrutar(request, ctx) {
  // Subpeticiones del propio Worker (lectura del índice de Unicorn): directo
  // al origen, sin volver a enrutar.
  if (request.headers.get(CABECERA_INTERNA)) return fetch(request);

  const url = new URL(request.url);

  if (url.hostname === APEX) {
    url.hostname = WWW;
    return Response.redirect(url.toString(), 301);
  }

  if (url.pathname === "/blog") {
    url.pathname = "/blog/";
    return Response.redirect(url.toString(), 301);
  }

  if (!esRutaDelBlog(url.pathname)) return fetch(request);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Método no permitido", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  let resp;
  try {
    resp = await pedirAlDroplet(request, url);
  } catch (err) {
    console.error("droplet sin respuesta:", err);
    resp = null;
  }

  // Droplet caído en la portada: que Unicorn muestre la suya.
  if ((!resp || resp.status >= 500) && url.pathname === "/blog/") return fetch(request);
  if (!resp) return new Response("Blog no disponible", { status: 502 });

  if (resp.status === 404 && admiteRespaldoUnicorn(url.pathname)) return fetch(request);

  if (url.pathname === "/blog/" && resp.status === 200 && esHtml(resp) && request.method === "GET") {
    const lista = await articulosUnicorn(request, ctx);
    return inyectarArticulosUnicorn(resp, lista);
  }

  return resp;
}

function esHtml(resp) {
  return (resp.headers.get("Content-Type") || "").includes("text/html");
}

async function pedirAlDroplet(request, url) {
  const destino = new URL(url.pathname + url.search, `https://${HOST_ORIGEN}`);

  const headers = new Headers();
  for (const nombre of CABECERAS_REENVIADAS) {
    const valor = request.headers.get(nombre);
    if (valor) headers.set(nombre, valor);
  }
  headers.set(CABECERA_PROXY, "worker");
  headers.set("X-Forwarded-Host", WWW);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Chtr-Visitante", ip);

  const r = await fetch(destino.toString(), {
    method: request.method,
    headers,
    redirect: "manual",
  });

  const resp = new Response(r.body, r);
  resp.headers.set("X-Chtr-Origen", "droplet");

  const location = r.headers.get("Location");
  if (location) {
    const abs = new URL(location, destino);
    if (abs.hostname === HOST_ORIGEN) abs.hostname = WWW;

    // El droplet mandó a la misma URL pública: no reconoció la cabecera del
    // Worker (o una caché devolvió el 301 de una visita directa). Devolverlo
    // tal cual sería un bucle infinito en el navegador.
    if (abs.hostname === WWW && abs.pathname === url.pathname && abs.search === url.search) {
      return new Response(
        "El origen del blog no reconoció la cabecera X-Chtr-Proxy. " +
          "Revisa que nginx tenga deploy/nginx-blog.conf y que Cloudflare no " +
          "esté cacheando HTML de blog.chiletransportistas.com.",
        { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
    resp.headers.set("Location", abs.toString());
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Artículos que siguen en Unicorn
// ---------------------------------------------------------------------------

// /blog/{slug} o /blog/{slug}/ ; nada de categorías, paginación ni assets.
const RUTA_ARTICULO_UNICORN = /^\/blog\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/?$/;
const SLUGS_NO_ARTICULO = new Set([
  "assets", "page", "pagina", "category", "categoria", "categorias",
  "tag", "tags", "etiqueta", "author", "autor", "feed", "rss", "search", "buscar",
]);

/** Devuelve { slug, ruta } si el href apunta a un artículo de Unicorn. */
export function articuloUnicornDesdeHref(href) {
  if (!href) return null;
  let u;
  try {
    u = new URL(href, `https://${WWW}/blog/`);
  } catch {
    return null;
  }
  if (u.hostname !== WWW && u.hostname !== APEX) return null;
  const m = RUTA_ARTICULO_UNICORN.exec(u.pathname);
  if (!m || SLUGS_NO_ARTICULO.has(m[1])) return null;
  return { slug: m[1], ruta: u.pathname };
}

const ENTIDADES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", iquest: "¿", iexcl: "¡",
  laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  ndash: "–", mdash: "—", hellip: "…",
};

export function decodificarEntidades(texto) {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (todo, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : todo;
    }
    return ENTIDADES[e] ?? todo;
  });
}

function escaparHtml(texto) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tituloDesdeSlug(slug) {
  const t = slug.replace(/-/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Lee el índice de Unicorn y devuelve [{ ruta, titulo }] en su orden. */
export async function extraerArticulosUnicorn(respuesta) {
  const porSlug = new Map();
  let actual = null;

  const rw = new HTMLRewriter().on("a[href]", {
    element(el) {
      const art = articuloUnicornDesdeHref(el.getAttribute("href"));
      if (!art) {
        actual = null;
        return;
      }
      const este = { ...art, texto: "" };
      actual = este;
      el.onEndTag(() => {
        const texto = decodificarEntidades(este.texto).replace(/\s+/g, " ").trim();
        const previo = porSlug.get(este.slug);
        if (!previo) {
          porSlug.set(este.slug, { ruta: este.ruta, texto });
        } else if (texto.length > previo.texto.length) {
          previo.texto = texto;
        }
        if (actual === este) actual = null;
      });
    },
    text(chunk) {
      if (actual) actual.texto += chunk.text;
    },
  });

  await rw.transform(respuesta).arrayBuffer();

  const lista = [];
  for (const [slug, { ruta, texto }] of porSlug) {
    // "Leer más", "Ver artículo": texto de botón, no título.
    const titulo = texto.length >= 12 && texto.length <= 160 ? texto : tituloDesdeSlug(slug);
    lista.push({ ruta, titulo });
    if (lista.length >= MAX_ARTICULOS_UNICORN) break;
  }
  return lista;
}

async function articulosUnicorn(request, ctx) {
  const cache = caches.default;
  const clave = new Request(`https://${WWW}/__chtr/articulos-unicorn.json`);

  const guardada = await cache.match(clave);
  if (guardada) return guardada.json();

  let lista = [];
  try {
    const r = await fetch(`https://${WWW}/blog/`, {
      headers: {
        [CABECERA_INTERNA]: "unicorn",
        "User-Agent": request.headers.get("user-agent") || "chtr-blog-router",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_UNICORN_MS),
    });
    if (r.ok && esHtml(r)) lista = await extraerArticulosUnicorn(r);
  } catch (err) {
    console.error("índice de Unicorn sin respuesta:", err);
  }

  const ttl = lista.length ? TTL_LISTA_UNICORN : TTL_LISTA_VACIA;
  ctx.waitUntil(
    cache.put(
      clave,
      new Response(JSON.stringify(lista), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
      })
    )
  );
  return lista;
}

export function inyectarArticulosUnicorn(resp, lista) {
  if (!lista || !lista.length) return resp;
  const items = lista
    .map((a) => `<li><a href="${escaparHtml(a.ruta)}">${escaparHtml(a.titulo)}</a></li>`)
    .join("\n      ");
  return new HTMLRewriter()
    .on("section#mas-articulos", {
      element(el) {
        el.removeAttribute("hidden");
      },
    })
    .on("[data-chtr-unicorn]", {
      element(el) {
        el.setInnerContent(`\n      ${items}\n    `, { html: true });
      },
    })
    .transform(resp);
}
