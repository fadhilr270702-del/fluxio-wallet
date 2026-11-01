# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Fluxio Wallet, please report it privately by email to **fluxio.wallet@gmail.com**.

Please include enough detail to reproduce the issue: the version you tested, the steps you took, and what you observed. If the issue involves funds or key material, say so clearly in the subject line.

We will acknowledge your report within a reasonable time and keep you informed while we investigate and ship a fix.

## Please do not disclose publicly first

Please do not open a public GitHub issue, post, or social media thread about a vulnerability before a fix has shipped. Give us the chance to protect users first. Once a fix is released, you are welcome to publish your findings and we are happy to credit you if you want.

## Scope notes

Fluxio is a non custodial wallet: seeds and private keys are generated and stored only on the user's own device, encrypted with the user's password. There is no server that holds user keys. Reports about third party services the wallet talks to (public RPC endpoints, swap aggregators, price APIs) are still welcome if the wallet's use of them puts users at risk.

There is no bug bounty program at this time.
