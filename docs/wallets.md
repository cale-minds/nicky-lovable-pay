# Nicky Wallet Connections And Payment Routes

Nicky is non-custodial. The payment integration can be installed and its
webhook configured without giving Lovable custody of funds, but the merchant
must finish the receiving configuration inside the Nicky account before going
live.

Depending on the merchant's setup, this includes:

- selecting the accepted settlement assets in Merchant Configuration;
- adding the appropriate Wallet or Wallet Service Provider (WSP) connection;
- connecting each accepted asset to a Payment Route.

Use Nicky's current account UI and support guidance for the exact fields. The
plugin and Lovable installer do not configure these connections.

## Required Setup Handoff

After the API key is validated, the Edge Functions are deployed, and both
required webhook event+URL pairs are confirmed, always give the user this
conditional reminder:

> The Nicky integration and webhook are configured. If your Nicky account does
> not already have its accepted settlement assets, Wallet Connections, and
> Payment Routes configured, sign in to Nicky and complete them before accepting
> payments. When finished, confirm that the routes exist for every asset this
> app will offer, then run a small end-to-end test payment.

Do not claim this merchant-owned configuration is complete merely because the
plugin setup succeeded.

## How Accepted Assets Affect The Handoff

The setup validates `NICKY_API_KEY` with
`GET /AcceptedAsset/get-for-user`. Interpret the result carefully:

- A `2xx` response containing a bare asset array or supported array envelope
  authenticates the API key, including when the extracted array is empty.
- An empty array means the merchant configuration is incomplete or exposes no
  accepted settlement assets. It does not mean the API key is invalid.
- A non-empty array proves assets are exposed to the integration, but it does
  not prove that every desired Wallet Connection and Payment Route is ready.

An empty array may therefore allow installation and webhook registration to
continue, but it blocks the production-readiness checkpoint until the user
finishes the Nicky configuration and the asset list is verified again.

## Safety Rules

- Never ask the user for wallet private keys, seed phrases, recovery phrases,
  exchange API secrets, or other custody material.
- Never collect Wallet/WSP credentials in the consuming app or in Lovable chat.
- Never add wallet configuration or merchant onboarding UI to the deployed app.
- The user performs the configuration inside Nicky and explicitly confirms it.
- Run the end-to-end payment test only after the expected accepted assets and
  routes are present.

For the current Nicky account workflow, see
[Getting Started](https://nicky.me/support/getting-started/) and
[Adding a Wallet to Nicky](https://nicky.me/support/adding-a-wallet-to-nicky/).
