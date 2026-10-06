-- Hook provenance the Judge forwards with each verdict (PRD 9: fee token, fee amount, source block timestamp, finality).
alter table judge_verdicts
  add column if not exists source_block bigint,
  add column if not exists source_block_timestamp timestamptz,
  add column if not exists finality_mode text check (finality_mode in ('blockDepth', 'finalized')),
  add column if not exists finality_block_depth integer,
  add column if not exists finality_safe boolean,
  add column if not exists fee_token text,
  add column if not exists fee_token_amount numeric(78, 0);
