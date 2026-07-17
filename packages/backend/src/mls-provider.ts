/**
 * MLS crypto provider for wmp-inspector, backed by ts-mls.
 * Provides key package generation, group management, and encrypt/decrypt.
 */

import {
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  generateKeyPackage,
  createGroup,
  joinGroup,
  createCommit,
  createApplicationMessage,
  processMessage,
  encodeMlsMessage,
  decodeMlsMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  acceptAll,
  zeroOutUint8Array,
  type CiphersuiteImpl,
  type CiphersuiteName,
  type ClientState,
  type MLSContext,
  type KeyPackage,
  type PrivateKeyPackage,
  type Credential,
  type Proposal,
  type MLSMessage,
} from "ts-mls";

const CIPHER_SUITE_X25519 = 0x0001;

const CIPHER_SUITE_NAMES: Record<number, CiphersuiteName> = {
  [CIPHER_SUITE_X25519]: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
  [0x0002]: "MLS_128_DHKEMP256_AES128GCM_SHA256_P256",
};

function toBase64Url(data: Uint8Array): string {
  const str = btoa(String.fromCharCode(...data));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const final = pad ? padded + "=".repeat(4 - pad) : padded;
  const str = atob(final);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

interface GroupEntry {
  state: ClientState;
  impl: CiphersuiteImpl;
  groupIdStr: string;
}

export class InspectorMlsProvider {
  private identity: string;
  private implCache = new Map<number, CiphersuiteImpl>();
  private groups = new Map<string, GroupEntry>();
  private keyPackages = new Map<
    string,
    { pub: KeyPackage; priv: PrivateKeyPackage; cipherSuite: number }
  >();

  constructor(identity: string) {
    this.identity = identity;
  }

  private async getImpl(cs: number): Promise<CiphersuiteImpl> {
    let impl = this.implCache.get(cs);
    if (!impl) {
      const name = CIPHER_SUITE_NAMES[cs];
      if (!name) throw new Error(`Unsupported cipher suite: 0x${cs.toString(16)}`);
      impl = await getCiphersuiteImpl(getCiphersuiteFromName(name));
      this.implCache.set(cs, impl);
    }
    return impl;
  }

  private cred(): Credential {
    return { credentialType: "basic", identity: new TextEncoder().encode(this.identity) };
  }

  async generateKeyPackage(cipherSuite = CIPHER_SUITE_X25519) {
    const impl = await this.getImpl(cipherSuite);
    const kp = await generateKeyPackage(this.cred(), defaultCapabilities(), defaultLifetime, [], impl);
    const encoded = encodeMlsMessage({
      version: "mls10", wireformat: "mls_key_package", keyPackage: kp.publicPackage,
    } as MLSMessage);

    const id = `kp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.keyPackages.set(id, { pub: kp.publicPackage, priv: kp.privatePackage, cipherSuite });

    return { id, cipher_suite: cipherSuite, key_package: toBase64Url(encoded) };
  }

  async createMlsGroup(cipherSuite = CIPHER_SUITE_X25519) {
    const impl = await this.getImpl(cipherSuite);
    const kp = await generateKeyPackage(this.cred(), defaultCapabilities(), defaultLifetime, [], impl);
    const groupId = new TextEncoder().encode(`wmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const state = await createGroup(groupId, kp.publicPackage, kp.privatePackage, [], impl);
    const groupIdStr = toBase64Url(groupId);
    this.groups.set(groupIdStr, { state, impl, groupIdStr });
    return { groupId: groupIdStr, cipherSuite, epoch: 0 };
  }

  async addMember(groupId: string, keyPackageB64: string) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);

    const decoded = decodeMlsMessage(fromBase64Url(keyPackageB64), 0);
    if (!decoded) throw new Error("Invalid key package");
    const [msg] = decoded;

    const addProposal: Proposal = { proposalType: "add", add: { keyPackage: (msg as unknown as { keyPackage: KeyPackage }).keyPackage } };
    const ctx: MLSContext = { state: group.state, cipherSuite: group.impl, pskIndex: emptyPskIndex };
    const result = await createCommit(ctx, { extraProposals: [addProposal], ratchetTreeExtension: true });
    group.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);

    const commitBytes = encodeMlsMessage(result.commit);
    const welcomeBytes = result.welcome
      ? encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome: result.welcome } as MLSMessage)
      : new Uint8Array();

    return { commit: toBase64Url(commitBytes), welcome: toBase64Url(welcomeBytes) };
  }

  async processWelcome(welcomeB64: string) {
    const latest = [...this.keyPackages.values()].pop();
    if (!latest) throw new Error("No key package available");

    const impl = await this.getImpl(latest.cipherSuite);
    const decoded = decodeMlsMessage(fromBase64Url(welcomeB64), 0);
    if (!decoded) throw new Error("Invalid welcome");
    const [msg] = decoded;

    const state = await joinGroup((msg as unknown as { welcome: Parameters<typeof joinGroup>[0] }).welcome, latest.pub, latest.priv, emptyPskIndex, impl);
    const groupIdStr = toBase64Url(state.groupContext.groupId);
    this.groups.set(groupIdStr, { state, impl, groupIdStr });
    return { groupId: groupIdStr, epoch: Number(state.groupContext.epoch) };
  }

  async encrypt(groupId: string, plaintext: Uint8Array) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);

    const result = await createApplicationMessage(group.state, plaintext, group.impl);
    group.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);

    const encoded = encodeMlsMessage({
      version: "mls10", wireformat: "mls_private_message", privateMessage: result.privateMessage,
    } as MLSMessage);

    return { ciphertext: toBase64Url(encoded), epoch: Number(group.state.groupContext.epoch) };
  }

  async decrypt(groupId: string, ciphertextB64: string) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);

    const decoded = decodeMlsMessage(fromBase64Url(ciphertextB64), 0);
    if (!decoded) throw new Error("Invalid ciphertext");
    const [msg] = decoded;

    const result = await processMessage(
      msg as Parameters<typeof processMessage>[0],
      group.state, emptyPskIndex, acceptAll, group.impl,
    );
    group.state = result.newState;
    result.consumed.forEach(zeroOutUint8Array);

    if (result.kind !== "applicationMessage") throw new Error(`Expected application message, got ${result.kind}`);
    return { plaintext: result.message, epoch: Number(group.state.groupContext.epoch) };
  }

  get groupCount() { return this.groups.size; }
  get keyPackageCount() { return this.keyPackages.size; }
}
