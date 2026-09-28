// Vector oficial de AWS para SigV4 en S3 (GET Object con Range):
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
import { test } from "node:test";
import assert from "node:assert/strict";
import { firmarSigV4, codificarRuta } from "../lib/r2.mjs";

test("firma SigV4 igual a la del ejemplo de AWS", () => {
  const vacio = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const auth = firmarSigV4({
    method: "GET",
    path: "/test.txt",
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": vacio,
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: vacio,
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  });
  assert.equal(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
  );
});

test("la ruta se codifica segmento a segmento", () => {
  assert.equal(codificarRuta("imagenes-chiletransportistas/ChileTransportistas-assets/Blog/a b(1).webp"),
    "imagenes-chiletransportistas/ChileTransportistas-assets/Blog/a%20b%281%29.webp");
});
