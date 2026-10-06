# Kelp Replay end-to-end log (Testnet simulation)

Every run is `pnpm --filter @kirchhoff/demo e2e --network <local|testnet>` in the default `--reports cre` mode: reports reach the ledgers only through `cre workflow simulate --broadcast`.

## Local Anvil, 2026-10-06 (three chains, CRE simulate with broadcast)

Result: **e2e PASSED**. Reset back to CONSERVED on all three chains in **28.2 s** (PRD 15 recording checklist: under 3 minutes).
Run from the same demo, workflows, engine and contracts code as this repository (source checkout `Adwaitbytes/kirchhoff` at
the commit that carries the testnet harness fixes); local chains use the CCIP selectors of the three testnets.

| Step | Status | What happened |
| --- | --- | --- |
| deploy-check | started | verify the deployment on all three chains |
| deploy-check | ok | deployment verified |
| baseline-epoch | started | W2 baseline epoch |
| baseline-epoch | ok | EPOCH written on home by CRE |
| baseline-epoch | ok | EPOCH written on arb by CRE |
| baseline-epoch | ok | EPOCH written on base by CRE |
| baseline-epoch | ok | W2 baseline epoch: CONSERVED |
| forge-credit | started | forge WeakBridge credit (no matching burn) |
| forge-credit | ok | released 116,500 kETH to attacker with no debit |
| breach | started | W1 Junction Watch: cre workflow simulate --broadcast |
| breach | ok | BREACH written on home by CRE |
| breach | ok | BREACH written on arb by CRE |
| breach | ok | BREACH written on base by CRE |
| breach | ok | W1 wrote BREACH (DEBIT_NOT_FOUND) to all 3 ledgers in one run |
| breach | ok | BreachRecorded on home |
| quarantine | started | W3 Responder: cre workflow simulate --broadcast |
| quarantine | ok | QUARANTINE_APPLIED written on home by CRE |
| quarantine | ok | QUARANTINE_APPLIED written on arb by CRE |
| quarantine | ok | QUARANTINE_APPLIED written on base by CRE |
| quarantine | ok | W3 applied QUARANTINE_APPLIED on all 3 ledgers |
| assert-breach | started | assert BREACH + incident on all three ledgers |
| assert-breach | ok | home: BREACH recorded, lanes frozen, attacker tainted |
| assert-breach | ok | arb: BREACH recorded, lanes frozen, attacker tainted |
| assert-breach | ok | base: BREACH recorded, lanes frozen, attacker tainted |
| refuse-ccip | started | attacker tries CCIP kETH -> Base |
| refuse-ccip | refused | CCIP lockOrBurn reverted inside KirchhoffTokenPool |
| refuse-guard | started | attacker tries kETH transfer on home |
| refuse-guard | refused | home transfer reverted (KirchhoffGuard) |
| refuse-borrow | started | attacker tries DemoLendingMarket.borrow() |
| refuse-borrow | refused | borrow reverted (CollateralBroken) |
| assert-refusals | ok | every onward move refused |
| loop-epoch | started | W2 Loop Ledger epoch after the attack |
| loop-epoch | ok | BREACH written on home by CRE |
| loop-epoch | ok | BREACH written on arb by CRE |
| loop-epoch | ok | BREACH written on base by CRE |
| loop-epoch | ok | W2 confirmed LOOP_DEFICIT |
| assert-delta | ok | Loop Rule delta = -116500 kETH |
| latency | ok | attack -> BROKEN onchain: Junction 4s, Loop 28s |
| judge-replay-payload | ok | policy-hook payload produced |
| reset | started | restore CONSERVED state (Testnet simulation) |
| resolve | ok | issuer Safe resolved incident on home |
| resolve | ok | issuer Safe resolved incident on arb |
| resolve | ok | issuer Safe resolved incident on base |
| untaint | ok | attacker untainted on home |
| untaint | ok | attacker untainted on arb |
| untaint | ok | attacker untainted on base |
| rebalance | ok | returned 116500000000000000000000 kETH to escrow; Δ back to 0 |
| timelock | started | Anvil: fast-forwarding all three clocks 3582s past the recovery timelock |
| timelock | ok | recovery timelock elapsed |
| recovery-check | ok | RECOVERY_CHECK written on home by CRE |
| recovery-check | ok | RECOVERY_CHECK written on arb by CRE |
| recovery-check | ok | RECOVERY_CHECK written on base by CRE |
| recovery-check | ok | W2 RECOVERY_CHECK via CRE on home, arb, base |
| reset | ok | all three chains CONSERVED |

