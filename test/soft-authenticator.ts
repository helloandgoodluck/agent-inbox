// A software passkey for tests: an ES256 key pair that produces the same
// registration and assertion JSON a browser would, so the real
// @simplewebauthn/server verifier runs against it.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified
const FLAG_AT = 0x40; // attested credential data included

export class SoftAuthenticator {
  readonly rawId = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;

  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly coseKey: Uint8Array,
  ) {}

  static async create(): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
    const coseKey = concat(
      bytes(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20),
      isoBase64URL.toBuffer(jwk.x!),
      bytes(0x22, 0x58, 0x20),
      isoBase64URL.toBuffer(jwk.y!),
    );
    return new SoftAuthenticator(keys, coseKey);
  }

  get id(): string {
    return isoBase64URL.fromBuffer(this.rawId);
  }

  async register(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin: string,
  ): Promise<RegistrationResponseJSON> {
    const clientData = clientDataJSON("webauthn.create", options.challenge, origin);
    const attested = concat(new Uint8Array(16), bytes(0, this.rawId.length), this.rawId, this.coseKey);
    const authData = await this.authData(options.rp.id!, FLAG_UP | FLAG_UV | FLAG_AT, attested);
    // CBOR {"fmt": "none", "attStmt": {}, "authData": <bytes>}
    const attestationObject = concat(
      bytes(0xa3, 0x63), utf8("fmt"), bytes(0x64), utf8("none"),
      bytes(0x67), utf8("attStmt"), bytes(0xa0),
      bytes(0x68), utf8("authData"), bytes(0x58, authData.length), authData,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  async login(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
  ): Promise<AuthenticationResponseJSON> {
    this.counter++;
    const clientData = clientDataJSON("webauthn.get", options.challenge, origin);
    const authData = await this.authData(options.rpId!, FLAG_UP | FLAG_UV);
    const signed = concat(authData, await sha256(clientData));
    const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(toDer(new Uint8Array(raw))),
      },
      clientExtensionResults: {},
    };
  }

  private async authData(rpID: string, flags: number, attested = new Uint8Array()) {
    const c = this.counter;
    return concat(await sha256(utf8(rpID)), bytes(flags, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255), attested);
  }
}

function clientDataJSON(type: string, challenge: string, origin: string) {
  return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

// WebCrypto signs ECDSA as raw r||s; WebAuthn sends it DER-encoded.
function toDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concat(bytes(0), b);
    return concat(bytes(0x02, b.length), b);
  };
  const seq = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(bytes(0x30, seq.length), seq);
}

async function sha256(data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function utf8(s: string) {
  return new Uint8Array(new TextEncoder().encode(s));
}

function bytes(...values: number[]) {
  return Uint8Array.from(values);
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
