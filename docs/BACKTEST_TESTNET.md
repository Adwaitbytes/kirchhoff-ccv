# Backtest over kETH's real testnet history (PRD 2.M3, 3.S1, 6.LC3)

Testnet simulation. Spec: [docs/kETH.testnet.resolved.yaml](kETH.testnet.resolved.yaml), which is `engine/specs/kETH.yaml`
resolved with the hackathon-window deployment's addresses; its spec hash
`0xeb44896b07b91777fd04a9826122e927f5d87d1097be7cea81944fc4e39774da` equals the hash active onchain in KirchhoffRegistry.
Run on 2026-10-07 with `ai/src/backtest.ts` `backtestYaml` (full-history replay, epoch by epoch) from each ledger's
creation block, 154 s, 18 events replayed.

## Coverage

| Chain | From block | To block | Debits | Credits | Matched |
| --- | --- | --- | --- | --- | --- |
| ethereum-testnet-sepolia | 11855863 | 11861785 | 0 | 5 | 0 |
| ethereum-testnet-sepolia-arbitrum-1 | 316363113 | 316651895 | 0 | 0 | 0 |
| ethereum-testnet-sepolia-base-1 | 47760582 | 47796747 | 0 | 0 | 0 |

## Breaches flagged

| Reason | Block | Transaction | Amount |
| --- | --- | --- | --- |
| LOOP_DEFICIT | 11856279 | [`0xa7341d82...0062`](https://sepolia.etherscan.io/tx/0xa7341d82eee1a4485f0967b1eabe819537587b77f912f64b26cf883654170062) | 116,500 kETH |
| DEBIT_NOT_FOUND | 11856279 | [`0xa7341d82...0062`](https://sepolia.etherscan.io/tx/0xa7341d82eee1a4485f0967b1eabe819537587b77f912f64b26cf883654170062) | 116,500 kETH |
| LOOP_DEFICIT | 11860348 | [`0x3d14a928...fb18`](https://sepolia.etherscan.io/tx/0x3d14a928df7c160e33c6f4dcce5bf9af490be29a7d4c3fe7ead9193bd400fb18) | 116,500 kETH |
| DEBIT_NOT_FOUND | 11860348 | [`0x3d14a928...fb18`](https://sepolia.etherscan.io/tx/0x3d14a928df7c160e33c6f4dcce5bf9af490be29a7d4c3fe7ead9193bd400fb18) | 116,500 kETH |
| LOOP_DEFICIT | 11860603 | [`0x997606da...aed5`](https://sepolia.etherscan.io/tx/0x997606da073eb8465079721337656fde25c55baa00098efd05cf530567f1aed5) | 116,500 kETH |
| DEBIT_NOT_FOUND | 11860603 | [`0x997606da...aed5`](https://sepolia.etherscan.io/tx/0x997606da073eb8465079721337656fde25c55baa00098efd05cf530567f1aed5) | 116,500 kETH |
| LOOP_DEFICIT | 11861049 | [`0x6367b107...1d4a`](https://sepolia.etherscan.io/tx/0x6367b1078c2b7662378c56ed5a756f87a0f3f61697b7c1b35d5cf634befd1d4a) | 116,500 kETH |
| DEBIT_NOT_FOUND | 11861049 | [`0x6367b107...1d4a`](https://sepolia.etherscan.io/tx/0x6367b1078c2b7662378c56ed5a756f87a0f3f61697b7c1b35d5cf634befd1d4a) | 116,500 kETH |
| LOOP_DEFICIT | 11861371 | [`0xc603cd31...6717`](https://sepolia.etherscan.io/tx/0xc603cd3196cd4d805951f486eb0a445cacaea1768acf509c2c6e13aec3b66717) | 116,500 kETH |
| DEBIT_NOT_FOUND | 11861371 | [`0xc603cd31...6717`](https://sepolia.etherscan.io/tx/0xc603cd3196cd4d805951f486eb0a445cacaea1768acf509c2c6e13aec3b66717) | 116,500 kETH |

All five credits in this history are Kelp Replay forgeries: each is a HomeEscrowAdapter `Released` to the attacker
wallet `0xd04c90127279e40dba7477dc5e8b53ce0b675761` signed by the WeakBridge's single key with no burn. Each is
flagged by the Junction Rule (DEBIT_NOT_FOUND) and by the Loop Rule (LOOP_DEFICIT) at the block where it happened.
False BROKEN verdicts: **0**. The 5 drift events are transient: a credit replayed before its
claimed source chain's replay reaches the same time reads as not final yet (engine replay ordering, documented in
`engine/src/backtest.ts`).

Limit: this history has no legitimate bridge transfer yet, so zero false flags on valid traffic is established by the
engine's 10,000-sequence property test and the seven Anvil scenarios.
