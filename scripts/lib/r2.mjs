// Cliente mínimo de Cloudflare R2 (API compatible con S3) con firma
// AWS Signature V4 hecha a mano: sin SDK, sin dependencias.
import { createHash, createHmac } from "node:crypto";

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC 3986, como lo exige SigV4 (encodeURIComponent deja pasar !'()*).
function codificar(segmento) {
  return encodeURIComponent(segmento).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function codificarRuta(ruta) {
  return ruta.split("/").map(codificar).join("/");
}

/**
 * Firma una petición S3 con SigV4. Devuelve el valor de Authorization.
 * headers: objeto con TODAS las cabeceras a firmar (host incluida), en
 * minúsculas o no: se normalizan aquí.
 */
export function firmarSigV4({ method, path, query = "", headers, payloadHash, accessKeyId, secretAccessKey, region, service, amzDate }) {
  const fecha = amzDate.slice(0, 8);
  const norm = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim().replace(/\s+/g, " ")])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = norm.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = norm.map(([k]) => k).join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${fecha}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac("AWS4" + secretAccessKey, fecha);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const firma = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${firma}`;
}

export class R2 {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
    if (!accessKeyId || !secretAccessKey || !bucket || !(accountId || endpoint)) {
      throw new Error("Faltan credenciales de R2 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
    }
    this.base = new URL(endpoint || `https://${accountId}.r2.cloudflarestorage.com`);
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
  }

  async _pedir(method, key, { body, headers = {} } = {}) {
    const path = "/" + codificarRuta(`${this.bucket}/${key}`);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payloadHash = body ? sha256Hex(body) : sha256Hex("");
    const firmadas = {
      host: this.base.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...headers,
    };
    const authorization = firmarSigV4({
      method, path, headers: firmadas, payloadHash, amzDate,
      accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey,
      region: "auto", service: "s3",
    });
    const { host, ...enviar } = firmadas;
    return fetch(new URL(path, this.base), {
      method,
      headers: { ...enviar, authorization },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  }

  /** true si el objeto existe. */
  async existe(key) {
    const r = await this._pedir("HEAD", key);
    if (r.status === 404) return false;
    if (r.ok) return true;
    throw new Error(`R2 HEAD ${key}: ${r.status} ${r.statusText}`);
  }

  async subir(key, body, { contentType, cacheControl }) {
    const headers = { "content-type": contentType };
    if (cacheControl) headers["cache-control"] = cacheControl;
    const r = await this._pedir("PUT", key, { body, headers });
    if (!r.ok) {
      const detalle = (await r.text()).slice(0, 500);
      throw new Error(`R2 PUT ${key}: ${r.status} ${r.statusText}\n${detalle}`);
    }
  }
}
