// Pruebas del Worker en workerd (miniflare), con el droplet y Unicorn
// simulados. Correr con: npm test  (desde worker/)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../src/index.js", import.meta.url));

const HOME_DROPLET = `<!DOCTYPE html><html><body>
<h1>Blog Chile Transportistas</h1>
<section class="feed" id="mas-articulos" aria-labelledby="feed-mas" hidden>
  <ul class="lista-articulos" data-chtr-unicorn></ul>
</section>
</body></html>`;

const INDICE_UNICORN = `<!DOCTYPE html><html><body>
<nav><a href="/">Inicio</a><a href="/blog/">Blog</a><a href="/blog/category/guias/">Guías</a></nav>
<div class="post"><a href="/blog/carga-sobredimensionada/"><img src="x.jpg"></a>
  <h2><a href="/blog/carga-sobredimensionada/">Carga sobredimensionada: permisos y costos en Chile</a></h2>
  <a href="/blog/carga-sobredimensionada/">Leer más</a></div>
<div class="post"><a href="https://www.chiletransportistas.com/blog/principales-empresas-transporte-chile">Las principales empresas de transporte en Chile &amp; cómo elegir</a></div>
<div class="post"><a href="/blog/estrategias-de-marketing-para-transportistas/">Leer más</a></div>
<a href="https://otrositio.cl/blog/nada/">externo</a>
<a href="/blog/page/2/">Siguiente</a>
</body></html>`;

let mf;
let salientes = [];
let modo = {};

function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...extra } });
}

async function salida(req) {
  const url = new URL(req.url);
  salientes.push({ url: req.url, headers: Object.fromEntries(req.headers), method: req.method });

  if (url.hostname === "blog.chiletransportistas.com") {
    if (modo.dropletCaido) return new Response("bad gateway", { status: 502 });
    if (req.headers.get("x-chtr-proxy") !== "worker" || modo.ignoraCabecera) {
      return new Response(null, { status: 301, headers: { Location: `https://www.chiletransportistas.com${url.pathname}` } });
    }
    const p = url.pathname;
    if (p === "/blog/") return html(HOME_DROPLET);
    if (p === "/transportistas") return new Response(null, { status: 301, headers: { Location: "/transportistas/" } });
    if (p === "/transportistas/") return html("<h1>Hub transportistas</h1>");
    if (p === "/transportistas/como-conseguir-carga/") return html("<h1>Artículo</h1>");
    if (p === "/sitemap-blog.xml") return new Response("<urlset/>", { headers: { "Content-Type": "text/xml" } });
    if (p === "/blog/assets/css/styles.css") return new Response("body{}", { headers: { "Content-Type": "text/css" } });
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/html" } });
  }

  if (url.hostname === "www.chiletransportistas.com") {
    if (url.pathname === "/blog/" && req.headers.get("x-chtr-interno")) {
      if (modo.unicornCaido) return new Response("error", { status: 500 });
      return html(INDICE_UNICORN);
    }
    return html(`UNICORN ${url.pathname}`, url.pathname.startsWith("/transportistas/no-existe") ? 404 : 200);
  }
  return new Response("host inesperado", { status: 599 });
}

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: SCRIPT,
    compatibilityDate: "2025-09-01",
    outboundService: salida,
    cache: false,
  });
  await mf.ready;
});

after(async () => {
  await mf.dispose();
});

async function pedir(path, init = {}, host = "www.chiletransportistas.com") {
  salientes = [];
  return mf.dispatchFetch(`https://${host}${path}`, { redirect: "manual", ...init });
}

test("artículo de una pista se sirve desde el droplet con la cabecera del Worker", async () => {
  modo = {};
  const r = await pedir("/transportistas/como-conseguir-carga/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Artículo/);
  assert.equal(r.headers.get("x-chtr-origen"), "droplet");
  const s = salientes[0];
  assert.equal(new URL(s.url).hostname, "blog.chiletransportistas.com");
  assert.equal(s.headers["x-chtr-proxy"], "worker");
  assert.equal(s.headers["x-forwarded-host"], "www.chiletransportistas.com");
});

test("los 301 del droplet salen con host www", async () => {
  modo = {};
  const r = await pedir("/transportistas");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://www.chiletransportistas.com/transportistas/");
});

test("404 del droplet en ruta HTML: responde Unicorn", async () => {
  modo = {};
  const r = await pedir("/transportistas/no-existe/");
  assert.equal(r.status, 404);
  assert.match(await r.text(), /UNICORN \/transportistas\/no-existe\//);
});

test("404 de un estático no cae a Unicorn", async () => {
  modo = {};
  const r = await pedir("/blog/assets/css/nada.css");
  assert.equal(r.status, 404);
  assert.doesNotMatch(await r.text(), /UNICORN/);
});

test("estáticos y sitemap vienen del droplet", async () => {
  modo = {};
  assert.equal(await (await pedir("/blog/assets/css/styles.css")).text(), "body{}");
  assert.equal(await (await pedir("/sitemap-blog.xml")).text(), "<urlset/>");
});

test("/blog redirige a /blog/", async () => {
  const r = await pedir("/blog?utm_source=x");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://www.chiletransportistas.com/blog/?utm_source=x");
});

test("artículos viejos de Unicorn pasan de largo", async () => {
  modo = {};
  const r = await pedir("/blog/carga-sobredimensionada/");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "UNICORN /blog/carga-sobredimensionada/");
  assert.equal(salientes.length, 1);
  assert.equal(new URL(salientes[0].url).hostname, "www.chiletransportistas.com");
});

test("rutas parecidas no se capturan", async () => {
  modo = {};
  const r = await pedir("/transportistas-del-norte/");
  assert.equal(await r.text(), "UNICORN /transportistas-del-norte/");
});

test("portada: HTML del droplet + lista de artículos de Unicorn", async () => {
  modo = {};
  const r = await pedir("/blog/");
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /Blog Chile Transportistas/);
  assert.doesNotMatch(body, /id="mas-articulos"[^>]*hidden/);
  assert.match(body, /<a href="\/blog\/carga-sobredimensionada\/">Carga sobredimensionada: permisos y costos en Chile<\/a>/);
  assert.match(body, /<a href="\/blog\/principales-empresas-transporte-chile">Las principales empresas de transporte en Chile &amp; cómo elegir<\/a>/);
  // Solo "Leer más": se usa el slug
  assert.match(body, /<a href="\/blog\/estrategias-de-marketing-para-transportistas\/">Estrategias de marketing para transportistas<\/a>/);
  assert.doesNotMatch(body, /category|page\/2|otrositio/);
});

test("portada con Unicorn caído: la sección queda oculta", async () => {
  modo = { unicornCaido: true };
  const r = await pedir("/blog/");
  const body = await r.text();
  assert.match(body, /id="mas-articulos"[^>]*hidden/);
  assert.match(body, /<ul class="lista-articulos" data-chtr-unicorn><\/ul>/);
});

test("portada con el droplet caído: responde Unicorn", async () => {
  modo = { dropletCaido: true };
  const r = await pedir("/blog/");
  assert.equal(await r.text(), "UNICORN /blog/");
});

test("si el origen ignora la cabecera no hay bucle: 502 explicativo", async () => {
  modo = { ignoraCabecera: true };
  const r = await pedir("/transportistas/como-conseguir-carga/");
  assert.equal(r.status, 502);
  assert.match(await r.text(), /X-Chtr-Proxy/);
});

test("sin www: 301 a www", async () => {
  const r = await pedir("/transportistas/x/", {}, "chiletransportistas.com");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://www.chiletransportistas.com/transportistas/x/");
});

test("POST a una ruta del blog: 405", async () => {
  modo = {};
  const r = await pedir("/transportistas/", { method: "POST", body: "x" });
  assert.equal(r.status, 405);
});
