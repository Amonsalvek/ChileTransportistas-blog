#!/usr/bin/env node
/**
 * chtr-cms-api — servicio de apoyo para el CMS del blog
 * ---------------------------------------------------------------------------
 * Complementa al servicio de publicación que ya corre en el droplet
 * (chtr-blog-api). No lo reemplaza ni lo modifica: escucha en su propio
 * puerto y expone /api/cms/*.
 *
 *   GET  /api/cms/health              estado, repo y capacidades
 *   GET  /api/cms/articles            lista de artículos con metadatos
 *   GET  /api/cms/articles/:slug      documento completo de un artículo
 *   GET  /api/cms/file?path=blog.html cualquier archivo del repo
 *   GET  /api/cms/includes            contenido de los includes SSI
 *   GET  /api/cms/prs                 pull requests abiertos creados por el CMS
 *   POST /api/cms/pr                  crea rama + commit + pull request
 *   POST /api/cms/publish             reenvía a /api/blog/publish con el API_SECRET
 *   POST /api/cms/deploy              git pull en BLOG_DIR (opcional)
 *
 * Sin dependencias de npm. Requiere Node 18 o superior (usa fetch nativo).
 *
 * El navegador solo conoce CMS_TOKEN. Ni API_SECRET ni GITHUB_TOKEN ni la
 * clave de OpenAI salen nunca del droplet.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

/* ========================================================================
   Configuración
   ======================================================================== */

function loadEnvFile(file){
  const out = {};
  try{
    fs.readFileSync(file, 'utf8').split('\n').forEach(line => {
      const t = line.trim();
      if(!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if(i < 0) return;
      let v = t.slice(i + 1).trim();
      if((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[t.slice(0, i).trim()] = v;
    });
  }catch(e){ /* archivo ausente: se ignora */ }
  return out;
}

const SELF_ENV  = loadEnvFile(process.env.CMS_ENV_FILE  || '/opt/chtr-cms-api/.env');
/* El .env del servicio de publicación se lee solo para reutilizar API_SECRET. */
const BLOG_ENV  = loadEnvFile(process.env.BLOG_ENV_FILE || '/opt/chtr-blog-api/.env');

const cfg = (k, def) => (process.env[k] != null && process.env[k] !== '') ? process.env[k]
                      : (SELF_ENV[k] != null && SELF_ENV[k] !== '')      ? SELF_ENV[k]
                      : def;

const CONFIG = {
  port          : parseInt(cfg('PORT', '8788'), 10),
  host          : cfg('HOST', '127.0.0.1'),
  cmsToken      : cfg('CMS_TOKEN', ''),
  githubToken   : cfg('GITHUB_TOKEN', ''),
  repo          : cfg('GITHUB_REPO', 'Amonsalvek/ChileTransportistas-blog'),
  baseBranch    : cfg('GIT_BASE_BRANCH', ''),          /* vacío = rama por defecto del repo */
  branchPrefix  : cfg('GIT_BRANCH_PREFIX', 'cms/'),
  commitName    : cfg('GIT_COMMIT_NAME', 'CHTR Blog CMS'),
  commitEmail   : cfg('GIT_COMMIT_EMAIL', 'cms@chiletransportistas.com'),
  articlesDir   : cfg('ARTICLES_DIR', 'articulos'),
  indexFile     : cfg('INDEX_FILE', 'blog.html'),
  blogDir       : cfg('BLOG_DIR', '/var/www/blog'),
  source        : cfg('SOURCE', 'github'),             /* github | disk */
  publishUrl    : cfg('PUBLISH_URL', 'https://blog.chiletransportistas.com/api/blog/publish'),
  apiSecret     : cfg('API_SECRET', BLOG_ENV.API_SECRET || ''),
  allowOrigins  : cfg('ALLOW_ORIGINS', '*'),
  allowDeploy   : cfg('ALLOW_DEPLOY', 'false') === 'true',
  cacheTtl      : parseInt(cfg('CACHE_TTL', '90'), 10) * 1000,
  maxBody       : parseInt(cfg('MAX_BODY_MB', '8'), 10) * 1024 * 1024
};

const INCLUDE_FILES = cfg('INCLUDE_FILES',
  'navbar.html,footer.html,content-cta.html,right-banner-cta.html,sticky-mobile-cta.html,bottom-banner-blog.html'
).split(',').map(s => s.trim()).filter(Boolean);

function log(){ console.log('[' + new Date().toISOString() + ']', ...arguments); }
function fail(){ console.error('[' + new Date().toISOString() + ']', ...arguments); }

/* ========================================================================
   Utilidades HTTP
   ======================================================================== */

class HttpError extends Error{
  constructor(status, message, detail){ super(message); this.status = status; this.detail = detail; }
}

function corsHeaders(origin){
  const allow = CONFIG.allowOrigins === '*'
    ? '*'
    : (CONFIG.allowOrigins.split(',').map(s => s.trim()).indexOf(origin) >= 0 ? origin : '');
  const h = {
    'Access-Control-Allow-Methods' : 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers' : 'Authorization, Content-Type',
    'Access-Control-Max-Age'       : '86400',
    'Vary'                         : 'Origin'
  };
  /* Un CMS abierto con file:// manda Origin: null. Se acepta igual porque la
     autorización va por Bearer y no por cookies. */
  if(allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function send(res, status, body, extra){
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const origin = (res.req && res.req.headers && res.req.headers.origin) || '';
  res.writeHead(status, Object.assign({
    'Content-Type'  : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control' : 'no-store'
  }, corsHeaders(origin), extra || {}));
  res.end(payload);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if(size > CONFIG.maxBody){ reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if(!raw) return resolve({});
      try{ resolve(JSON.parse(raw)); }
      catch(e){ reject(new HttpError(400, 'JSON inválido en el cuerpo de la petición')); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req){
  if(!CONFIG.cmsToken) throw new HttpError(500, 'CMS_TOKEN no está configurado en el servidor');
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if(!m) throw new HttpError(401, 'Falta la cabecera Authorization: Bearer <CMS_TOKEN>');
  const a = Buffer.from(m[1]);
  const b = Buffer.from(CONFIG.cmsToken);
  if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Token del CMS incorrecto');
}

/* ========================================================================
   Cliente de GitHub
   ======================================================================== */

async function gh(method, endpoint, body){
  if(!CONFIG.githubToken) throw new HttpError(500, 'GITHUB_TOKEN no está configurado en el servidor');
  const url = 'https://api.github.com' + endpoint;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 30000);
  let res;
  try{
    res = await fetch(url, {
      method,
      headers: {
        'Authorization'       : 'Bearer ' + CONFIG.githubToken,
        'Accept'              : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent'          : 'chtr-cms-api',
        'Content-Type'        : 'application/json'
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
  }catch(e){
    clearTimeout(to);
    throw new HttpError(502, 'No se pudo hablar con GitHub: ' + (e.name === 'AbortError' ? 'timeout' : e.message));
  }
  clearTimeout(to);
  const txt = await res.text();
  let data = null;
  try{ data = txt ? JSON.parse(txt) : null; }catch(e){ data = txt; }
  if(!res.ok){
    const msg = (data && data.message) || ('HTTP ' + res.status);
    const err = new HttpError(res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 502 : 502,
      'GitHub: ' + msg, data);
    err.ghStatus = res.status;
    throw err;
  }
  return data;
}

const R = () => '/repos/' + CONFIG.repo;

let repoInfoCache = null;
async function repoInfo(){
  if(repoInfoCache && Date.now() - repoInfoCache.at < 300000) return repoInfoCache.data;
  const data = await gh('GET', R());
  repoInfoCache = { at: Date.now(), data };
  return data;
}
async function baseBranch(){
  if(CONFIG.baseBranch) return CONFIG.baseBranch;
  return (await repoInfo()).default_branch || 'main';
}

/* ========================================================================
   Lectura de contenidos (GitHub o disco)
   ======================================================================== */

const cache = new Map();
function cached(key, ttl, fn){
  const hit = cache.get(key);
  if(hit && Date.now() - hit.at < (ttl || CONFIG.cacheTtl)) return Promise.resolve(hit.v);
  return Promise.resolve(fn()).then(v => { cache.set(key, { at: Date.now(), v }); return v; });
}
function clearCache(){ cache.clear(); }

function safeRepoPath(p){
  const clean = String(p || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if(!clean || clean.indexOf('..') >= 0 || path.isAbsolute(clean)) throw new HttpError(400, 'Ruta no permitida: ' + p);
  if(!/^[\w\-./áéíóúñÁÉÍÓÚÑ ]+$/.test(clean)) throw new HttpError(400, 'Ruta con caracteres no permitidos: ' + p);
  return clean;
}

async function readFileFrom(repoPath, source){
  const p = safeRepoPath(repoPath);
  const src = source || CONFIG.source;
  if(src === 'disk'){
    const abs = path.join(CONFIG.blogDir, p);
    if(!abs.startsWith(path.resolve(CONFIG.blogDir))) throw new HttpError(400, 'Ruta fuera del blog');
    try{ return { content: await fs.promises.readFile(abs, 'utf8'), sha: null, source: 'disk' }; }
    catch(e){ throw new HttpError(404, 'No existe: ' + p); }
  }
  const branch = await baseBranch();
  const data = await gh('GET', R() + '/contents/' + encodeURI(p) + '?ref=' + encodeURIComponent(branch));
  if(Array.isArray(data)) throw new HttpError(400, p + ' es un directorio');
  return {
    content: Buffer.from(data.content || '', data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'),
    sha: data.sha, size: data.size, source: 'github'
  };
}

async function listArticleFiles(source){
  const src = source || CONFIG.source;
  if(src === 'disk'){
    const dir = path.join(CONFIG.blogDir, CONFIG.articlesDir);
    const names = await fs.promises.readdir(dir);
    return names.filter(n => /\.html$/i.test(n)).map(n => ({ name: n, path: CONFIG.articlesDir + '/' + n, sha: null }));
  }
  const branch = await baseBranch();
  const data = await gh('GET', R() + '/contents/' + encodeURI(CONFIG.articlesDir) + '?ref=' + encodeURIComponent(branch));
  if(!Array.isArray(data)) throw new HttpError(500, CONFIG.articlesDir + ' no es un directorio en el repositorio');
  return data.filter(f => f.type === 'file' && /\.html$/i.test(f.name))
             .map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size }));
}

/* ------------------------------------------------------------------
   Extracción de metadatos del HTML (misma lógica que el CMS)
   ------------------------------------------------------------------ */

const ATTRS = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*';
function metaOf(html, attr, key){
  const re = new RegExp('<meta' + ATTRS + attr + '\\s*=\\s*["\']' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '["\']' + ATTRS + '>', 'i');
  const m = html.match(re);
  if(!m) return '';
  const c = m[0].match(/content\s*=\s*"([^"]*)"/i) || m[0].match(/content\s*=\s*'([^']*)'/i);
  return c ? decodeEntities(c[1]) : '';
}
function decodeEntities(s){
  return String(s || '')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}
function extractMeta(html, slug){
  const t = html.match(/<title>([\s\S]*?)<\/title>/i);
  const can = html.match(new RegExp('<link' + ATTRS + 'rel\\s*=\\s*["\']canonical["\']' + ATTRS + '>', 'i'));
  const canHref = can ? (can[0].match(/href\s*=\s*"([^"]*)"/i) || [,''])[1] : '';
  let ld = null;
  const ldRe = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m = ldRe.exec(html)) !== null){
    try{ const o = JSON.parse(m[1]); if(o && o['@type'] === 'BlogPosting'){ ld = o; break; } }catch(e){}
  }
  const ssi = (html.match(/<!--#include\s+(?:file|virtual)\s*=\s*"([^"]+)"\s*-->/g) || [])
    .map(x => (x.match(/"([^"]+)"/) || [,''])[1]);
  return {
    slug,
    title       : t ? decodeEntities(t[1].trim()) : '',
    description : metaOf(html, 'name', 'description') || (ld && ld.description) || '',
    image       : metaOf(html, 'property', 'og:image') || (ld && ld.image) || '',
    canonical   : canHref || metaOf(html, 'property', 'og:url') || '',
    author      : (ld && ld.author && ld.author.name) || '',
    datePublished: (ld && ld.datePublished) || '',
    dateModified : (ld && ld.dateModified) || '',
    ssi,
    bytes       : Buffer.byteLength(html)
  };
}

async function listArticles(source){
  const src = source || CONFIG.source;
  return cached('articles:' + src, CONFIG.cacheTtl, async () => {
    const files = await listArticleFiles(src);
    const out = [];
    /* Droplet de 512 MB: se leen de a pocos, sin paralelizar de más. */
    for(let i = 0; i < files.length; i += 3){
      const lote = files.slice(i, i + 3);
      const partes = await Promise.all(lote.map(async f => {
        const slug = f.name.replace(/\.html$/i, '');
        try{
          const { content } = await readFileFrom(f.path, src);
          return Object.assign(extractMeta(content, slug), { path: f.path, sha: f.sha });
        }catch(e){
          return { slug, path: f.path, sha: f.sha, error: e.message };
        }
      }));
      out.push(...partes);
    }
    return out;
  });
}

/* ========================================================================
   Pull requests
   ======================================================================== */

/* El droplet es chico y GitHub no acepta dos escrituras a la misma rama a la
   vez: las operaciones de escritura se encolan. */
let queue = Promise.resolve();
function enqueue(fn){
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function slugifyBranch(s){
  return String(s || 'cambio').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0, 48) || 'cambio';
}
function stamp(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth()+1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes());
}

async function branchExists(name){
  try{ await gh('GET', R() + '/git/ref/' + encodeURI('heads/' + name)); return true; }
  catch(e){ if(e.ghStatus === 404) return false; throw e; }
}

async function createPullRequest(opts){
  const base = opts.base || await baseBranch();
  const accion = opts.action === 'delete' ? 'eliminar'
               : opts.action === 'create' ? 'nuevo'
               : 'editar';

  /* 1. punto de partida */
  const ref = await gh('GET', R() + '/git/ref/' + encodeURI('heads/' + base));
  const baseSha = ref.object.sha;
  const baseCommit = await gh('GET', R() + '/git/commits/' + baseSha);

  /* 2. rama nueva, con sufijo si el nombre ya existe */
  let branch = CONFIG.branchPrefix + accion + '-' + slugifyBranch(opts.slug) + '-' + stamp();
  let n = 2;
  while(await branchExists(branch)){ branch = CONFIG.branchPrefix + accion + '-' + slugifyBranch(opts.slug) + '-' + stamp() + '-' + (n++); }

  /* 3. un solo árbol con todos los archivos: el commit es atómico */
  const tree = opts.files.map(f => {
    const p = safeRepoPath(f.path);
    if(f.content == null) return { path: p, mode: '100644', type: 'blob', sha: null };
    return { path: p, mode: '100644', type: 'blob', content: String(f.content) };
  });
  const newTree = await gh('POST', R() + '/git/trees', { base_tree: baseCommit.tree.sha, tree });

  const mensaje = opts.commitMessage || (
    (opts.action === 'delete' ? 'Elimina' : opts.action === 'create' ? 'Agrega' : 'Actualiza') +
    ' artículo: ' + opts.slug + '\n\n' + opts.files.map(f => (f.content == null ? '- borra ' : '- ') + f.path).join('\n')
  );
  const commit = await gh('POST', R() + '/git/commits', {
    message: mensaje,
    tree   : newTree.sha,
    parents: [baseSha],
    author : { name: CONFIG.commitName, email: CONFIG.commitEmail, date: new Date().toISOString() }
  });

  /* 4. la rama solo se crea cuando el commit ya existe */
  await gh('POST', R() + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });

  /* 5. pull request */
  let pr;
  try{
    pr = await gh('POST', R() + '/pulls', {
      title: opts.title || mensaje.split('\n')[0],
      head : branch,
      base : base,
      body : opts.body || ''
    });
  }catch(e){
    /* si el PR falla, la rama huérfana solo estorba: se limpia */
    try{ await gh('DELETE', R() + '/git/refs/' + encodeURI('heads/' + branch)); }catch(e2){}
    throw e;
  }

  /* 6. etiquetas y revisores: no son críticos, no deben tumbar la operación */
  const avisos = [];
  if(opts.labels && opts.labels.length){
    try{ await gh('POST', R() + '/issues/' + pr.number + '/labels', { labels: opts.labels }); }
    catch(e){ avisos.push('No se pudieron aplicar las etiquetas: ' + e.message); }
  }
  if(opts.reviewers && opts.reviewers.length){
    try{ await gh('POST', R() + '/pulls/' + pr.number + '/requested_reviewers', { reviewers: opts.reviewers }); }
    catch(e){ avisos.push('No se pudieron asignar los revisores: ' + e.message); }
  }

  clearCache();
  return {
    ok: true, prUrl: pr.html_url, prNumber: pr.number, branch, base,
    commit: commit.sha.slice(0, 7),
    files: opts.files.map(f => ({ path: f.path, deleted: f.content == null })),
    warnings: avisos
  };
}

async function listCmsPulls(){
  const pulls = await gh('GET', R() + '/pulls?state=open&per_page=50');
  return (pulls || []).map(p => {
    const branch = (p.head && p.head.ref) || '';
    let slug = '';
    const m = new RegExp('^' + CONFIG.branchPrefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?:nuevo|editar|eliminar)-(.+)-\\d{8}-\\d{4}').exec(branch);
    if(m) slug = m[1];
    return { number: p.number, title: p.title, url: p.html_url, branch, slug,
             createdAt: p.created_at, draft: !!p.draft, user: p.user && p.user.login };
  }).filter(p => p.branch.indexOf(CONFIG.branchPrefix) === 0);
}

/* ========================================================================
   Proxy de publicación
   ------------------------------------------------------------------------
   El CMS nunca ve el API_SECRET: manda su CMS_TOKEN y este servicio
   reenvía la petición al endpoint de publicación con el secreto real.
   ======================================================================== */

async function proxyPublish(payload){
  if(!CONFIG.apiSecret){
    throw new HttpError(500, 'API_SECRET no disponible. Configúralo en el .env del CMS o deja que se lea de /opt/chtr-blog-api/.env');
  }
  if(!payload || !payload.slug || !payload.html) throw new HttpError(400, 'Faltan slug o html');

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 170000);   /* la portada puede tardar ~60s */
  let res;
  try{
    res = await fetch(CONFIG.publishUrl, {
      method : 'POST',
      headers: { 'Authorization': 'Bearer ' + CONFIG.apiSecret, 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload),
      signal : ctl.signal
    });
  }catch(e){
    clearTimeout(to);
    if(e.name === 'AbortError') throw new HttpError(504, 'El endpoint de publicación no respondió a tiempo. Verifica si el artículo igual quedó publicado antes de reintentar.');
    throw new HttpError(502, 'No se pudo llamar al endpoint de publicación: ' + e.message);
  }
  clearTimeout(to);
  const txt = await res.text();
  let data = null;
  try{ data = txt ? JSON.parse(txt) : null; }catch(e){ data = { raw: txt }; }
  if(!res.ok){
    const err = new HttpError(res.status, (data && (data.error || data.message)) || ('El endpoint respondió ' + res.status), data);
    throw err;
  }
  clearCache();
  return data;
}

/* ========================================================================
   Despliegue opcional (git pull en el directorio servido)
   ======================================================================== */

function run(cmd, args, opts){
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ timeout: 60000, maxBuffer: 1024 * 1024 }, opts || {}), (err, stdout, stderr) => {
      if(err) return reject(new HttpError(500, (stderr || err.message || '').trim().slice(0, 500)));
      resolve((stdout || '').trim());
    });
  });
}

async function deploy(){
  if(!CONFIG.allowDeploy) throw new HttpError(403, 'El despliegue está deshabilitado (ALLOW_DEPLOY=false)');
  if(!fs.existsSync(path.join(CONFIG.blogDir, '.git'))) throw new HttpError(400, CONFIG.blogDir + ' no es un clon de git');
  const before = await run('git', ['-C', CONFIG.blogDir, 'rev-parse', '--short', 'HEAD']);
  await run('git', ['-C', CONFIG.blogDir, 'fetch', '--quiet', 'origin']);
  const out = await run('git', ['-C', CONFIG.blogDir, 'pull', '--ff-only']);
  const after = await run('git', ['-C', CONFIG.blogDir, 'rev-parse', '--short', 'HEAD']);
  clearCache();
  return { ok: true, before, after, changed: before !== after, output: out.slice(0, 800) };
}

/* ========================================================================
   Enrutado
   ======================================================================== */

async function handle(req, res, url){
  const p = url.pathname;

  /* --- salud: informa sin exigir token válido, pero sí distingue --- */
  if(p === '/api/cms/health' && req.method === 'GET'){
    checkAuth(req);
    let repo = null, branch = null, repoErr = null;
    try{ repo = (await repoInfo()).full_name; branch = await baseBranch(); }
    catch(e){ repoErr = e.message; }
    return send(res, 200, {
      ok: true,
      service : 'chtr-cms-api',
      version : '1.0.0',
      repo    : repo || CONFIG.repo,
      branch  : branch || CONFIG.baseBranch || 'main',
      source  : CONFIG.source,
      repoError: repoErr,
      articlesDir: CONFIG.articlesDir,
      indexFile  : CONFIG.indexFile,
      features: {
        pullRequests: !!CONFIG.githubToken,
        publish     : !!CONFIG.apiSecret,
        disco       : fs.existsSync(CONFIG.blogDir),
        deploy      : CONFIG.allowDeploy
      }
    });
  }

  checkAuth(req);

  /* --- listado de artículos --- */
  if(p === '/api/cms/articles' && req.method === 'GET'){
    const source = url.searchParams.get('source') || CONFIG.source;
    if(url.searchParams.get('fresh') === '1') clearCache();
    const articles = await listArticles(source);
    return send(res, 200, { ok: true, source, branch: await baseBranch().catch(() => null), count: articles.length, articles });
  }

  /* --- un artículo --- */
  let m = /^\/api\/cms\/articles\/([A-Za-z0-9._-]+)$/.exec(p);
  if(m && req.method === 'GET'){
    const slug = m[1].replace(/\.html$/i, '');
    const source = url.searchParams.get('source') || CONFIG.source;
    const f = await readFileFrom(CONFIG.articlesDir + '/' + slug + '.html', source);
    return send(res, 200, Object.assign({ ok: true, slug, path: CONFIG.articlesDir + '/' + slug + '.html', html: f.content, sha: f.sha }, extractMeta(f.content, slug)));
  }

  /* --- archivo cualquiera del repo --- */
  if(p === '/api/cms/file' && req.method === 'GET'){
    const rel = url.searchParams.get('path');
    if(!rel) throw new HttpError(400, 'Falta el parámetro path');
    const source = url.searchParams.get('source') || CONFIG.source;
    const f = await readFileFrom(rel, source);
    return send(res, 200, { ok: true, path: safeRepoPath(rel), content: f.content, sha: f.sha, source: f.source });
  }

  /* --- includes SSI, para que la vista previa del CMS sea real --- */
  if(p === '/api/cms/includes' && req.method === 'GET'){
    const source = url.searchParams.get('source') || CONFIG.source;
    const includes = await cached('includes:' + source, 300000, async () => {
      const out = {};
      for(const name of INCLUDE_FILES){
        try{ out['/' + name] = (await readFileFrom(name, source)).content; }
        catch(e){ /* un include ausente no es un error del CMS */ }
      }
      return out;
    });
    return send(res, 200, { ok: true, count: Object.keys(includes).length, includes });
  }

  /* --- pull requests abiertos --- */
  if(p === '/api/cms/prs' && req.method === 'GET'){
    const pulls = await listCmsPulls();
    return send(res, 200, { ok: true, count: pulls.length, pulls });
  }

  /* --- crear pull request --- */
  if(p === '/api/cms/pr' && req.method === 'POST'){
    const body = await readBody(req);
    if(!body.slug)  throw new HttpError(400, 'Falta slug');
    if(!Array.isArray(body.files) || !body.files.length) throw new HttpError(400, 'Falta la lista de archivos');
    if(body.files.length > 20) throw new HttpError(400, 'Demasiados archivos en un solo pull request');
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) throw new HttpError(400, 'Slug inválido: solo minúsculas, números y guiones');

    /* Salvaguarda del lado servidor: un artículo sin sus includes SSI rompe
       la maqueta del sitio, así que no se acepta aunque el CMS lo mande. */
    const requeridos = ['/navbar.html', '/footer.html'];
    for(const f of body.files){
      if(f.content == null) continue;
      if(!/\.html$/i.test(f.path)) throw new HttpError(400, 'Solo se aceptan archivos .html: ' + f.path);
      if(f.path.indexOf(CONFIG.articlesDir + '/') !== 0) continue;
      const faltan = requeridos.filter(r => f.content.indexOf('#include file="' + r + '"') < 0);
      if(faltan.length) throw new HttpError(422, 'El artículo ' + f.path + ' no incluye las directivas SSI obligatorias: ' + faltan.join(', '));
    }

    const result = await enqueue(() => createPullRequest({
      action   : body.action || 'update',
      slug     : body.slug,
      title    : body.title,
      body     : body.body,
      files    : body.files,
      base     : body.base,
      labels   : body.labels,
      reviewers: body.reviewers,
      commitMessage: body.commitMessage
    }));
    log('PR #' + result.prNumber, result.branch, result.files.map(f => f.path).join(' '));
    return send(res, 200, result);
  }

  /* --- publicar (reenvío) --- */
  if(p === '/api/cms/publish' && req.method === 'POST'){
    const body = await readBody(req);
    const out = await enqueue(() => proxyPublish(body));
    log('publicado', body.slug, out && out.imageStatus);
    return send(res, 200, out);
  }

  /* --- desplegar --- */
  if(p === '/api/cms/deploy' && req.method === 'POST'){
    const out = await enqueue(() => deploy());
    log('deploy', out.before, '->', out.after);
    return send(res, 200, out);
  }

  throw new HttpError(404, 'Ruta no encontrada: ' + req.method + ' ' + p);
}

/* ========================================================================
   Servidor
   ======================================================================== */

const server = http.createServer(async (req, res) => {
  if(req.method === 'OPTIONS'){
    res.writeHead(204, corsHeaders(req.headers.origin || ''));
    return res.end();
  }

  let url;
  try{ url = new URL(req.url, 'http://localhost'); }
  catch(e){ return send(res, 400, { ok:false, error:'URL inválida' }); }

  const t0 = Date.now();
  try{
    await handle(req, res, url);
    if(url.pathname !== '/api/cms/health') log(req.method, url.pathname, res.statusCode, (Date.now()-t0) + 'ms');
  }catch(e){
    const status = e instanceof HttpError ? e.status : 500;
    if(status >= 500) fail(req.method, url.pathname, status, e.message, e.detail || '');
    else log(req.method, url.pathname, status, e.message);
    if(!res.headersSent) send(res, status, { ok:false, error: e.message, detail: e.detail || null });
  }
});

server.headersTimeout = 190000;
server.requestTimeout = 190000;

server.listen(CONFIG.port, CONFIG.host, () => {
  log('chtr-cms-api escuchando en http://' + CONFIG.host + ':' + CONFIG.port);
  log('repo:', CONFIG.repo, '| fuente:', CONFIG.source, '| blogDir:', CONFIG.blogDir);
  const faltan = [];
  if(!CONFIG.cmsToken)    faltan.push('CMS_TOKEN');
  if(!CONFIG.githubToken) faltan.push('GITHUB_TOKEN (sin él no se pueden crear pull requests)');
  if(!CONFIG.apiSecret)   faltan.push('API_SECRET (sin él no funciona /api/cms/publish)');
  if(faltan.length) fail('CONFIGURACIÓN INCOMPLETA:', faltan.join(', '));
});

process.on('unhandledRejection', e => fail('unhandledRejection:', e && e.message));
process.on('SIGTERM', () => { log('SIGTERM: cerrando'); server.close(() => process.exit(0)); });
