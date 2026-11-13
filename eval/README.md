# Eval corpus

`corpus/commitments.zh.jsonl` is a seed for the `capture` quality gate. It is
not the final 150-case gold set; grow it with real (anonymized) messages.

Fields: id, source, date, text, expect[].
Expected fields: action, debtor, creditor, due (YYYY-MM-DD or null), quote, modal.

Targets: quote verbatim 100% (code-enforced), firm recall >=85%, due accuracy
>=95%, 0 auto-confirmed, candidate precision >=75%.
