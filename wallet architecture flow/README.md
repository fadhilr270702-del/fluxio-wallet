# Wallet Architecture Flow

                    FLUXIO WALLET
                         │
                    CREATE WALLET
                         │
                         ▼
                  Generate Mnemonic
                         │
                  12 / 24 words
                         │
                         ▼
                   Derive Accounts
                         │
              ┌──────────┴──────────┐
              │                     │
           Solana                 EVM
              │                     │
              │            ┌────────┼────────┐
              │            │        │        │
              │           ETH      BNB      BASE
              │
              ▼
        Solana Address
              │
              │
              └──────────────┐
                             ▼
                       Wallet Storage
                             │
                       Encrypted Vault
                             │
                             ▼
                      User Password
