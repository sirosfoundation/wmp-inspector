# wmp-inspector

[![License](https://img.shields.io/badge/license-BSD--2--Clause-blue)](LICENSE)

Web-based debugging and interop tool for the [Wallet Messaging Protocol (WMP)](https://github.com/leifj/wmp).

**wmp-inspector** is a lightweight WMP endpoint with a browser UI that joins
any WMP session it is invited to and displays real-time protocol traffic —
messages, group metadata, member information, and decrypted payloads.

## Features

- **Passive observer** — accepts invitations and joins sessions/MLS groups
- **Live message log** — every JSON-RPC frame displayed in real time
- **MLS decryption** — decrypts ciphertexts when part of the MLS group
- **Member metadata** — identity assertions, trust hints, capabilities
- **Payload decoder** — decode JWT, CBOR, and base64url blobs inline
- **No authentication required** — ephemeral sessions, zero setup

## Architecture

```
Browser (React SPA)  ◄──── internal WS ────►  Node.js backend (Hono)
                                                    │
                                               WMP Peer (wmp-js)
                                                    │
                                              WebSocket to relay
```

## Development

```bash
npm install
npm run dev        # starts backend (serves frontend in dev mode)
```

## Deploy

Deployed to Fly.io:

```bash
fly launch          # first time
fly deploy          # subsequent deploys
```

## License

BSD-2-Clause — see [LICENSE](LICENSE).
